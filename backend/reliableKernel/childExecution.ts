import {
  ContentAddressedStore,
  type PreparedContentObject
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  EffectControlPlane,
  type EffectObservedOutcome,
  type RecordedEffectReceipt,
  type ToolOutcomeStatus,
  type ToolTerminalPlan
} from './effectControlPlane';
import { canonicalPlainJson } from './plainJson';
import {
  isTransactionAssertionFailure,
  optionalPhaseFId,
  requireIsoTimestamp,
  requirePhaseFId,
  requirePhaseFText,
  stablePhaseFId,
  sqliteUniqueFailureIncludes
} from './phaseFIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export type ChildCompletionPolicy = 'wait_for_answer' | 'background';
export type ChildSendMode = 'queue_next_turn' | 'interrupt_current_turn';

export interface ChildExecutionSpawnCommand {
  sourceToolCallId: string;
  childAgentId: string;
  prompt: unknown;
  completionPolicy: ChildCompletionPolicy;
  waitDeadlineAt?: string;
  childConversationId?: string;
  title?: string;
  leaseOwnerId: string;
  leaseExpiresAt: string;
}

export interface ChildExecutionSpawnResult {
  childExecutionId: string;
  childConversationId: string;
  childTurnId: string;
  answerBridgeId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  completionPolicy: ChildCompletionPolicy;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildExecutionSendCommand {
  sourceKey: string;
  childExecutionId: string;
  mode: ChildSendMode;
  content: string | Uint8Array;
  contentType?: string;
}

export interface ChildExecutionSendResult {
  childExecutionId: string;
  turnIntentId: string;
  intentLinkId: string;
  pendingTurnInputId: string;
  mode: ChildSendMode;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildContinuationAdmissionCommand {
  sourceKey: string;
  childExecutionId: string;
  turnIntentId: string;
  leaseOwnerId: string;
  leaseExpiresAt: string;
}

export interface ChildContinuationAdmissionResult {
  childExecutionId: string;
  turnIntentId: string;
  turnId: string;
  turnSeq: string;
  answerBridgeId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildExecutionCancelCommand {
  sourceKey: string;
  childExecutionId: string;
  reason: string;
}

export interface ChildExecutionCancelSubtreeResult {
  rootChildExecutionId: string;
  lineageIds: string[];
  activeTurnIds: string[];
  cancelledIntentIds: string[];
  terminationRequestsWritten: number;
  intentsCancelled: number;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildExecutionSnapshot {
  childExecution: DomainRow;
  parentLink: DomainRow;
  turnLinks: DomainRow[];
  activeTurnLink: DomainRow | null;
  activeTurn: DomainRow | null;
  answerBridge: DomainRow;
  currentSubmission: DomainRow | null;
}

export interface PreparedForegroundSettlement {
  toolCallId: string;
  childExecutionId: string;
  receiptId: string;
  waitDeadlineAt: string;
  plan: ToolTerminalPlan;
  steps: RepositoryTransactionStep[];
}

export interface ChildExecutionControlPlaneOptions {
  now?: () => string;
  /** Allows Turn admission to attach pending next_turn deliveries in the very same writer transaction. */
  prepareNextTurnDeliverySteps?: (
    conversationId: string,
    turnId: string,
    now: string
  ) => Promise<RepositoryTransactionStep[]>;
}

interface SpawnIds {
  childExecutionId: string;
  childConversationId: string;
  childRootId: string;
  childHeadLinkId: string;
  childAgentLinkId: string;
  childTurnId: string;
  childLeaseId: string;
  childExecutorLinkId: string;
  parentLinkId: string;
  turnLinkId: string;
  activeTurnLinkId: string;
  answerBridgeId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  commandReceiptId: string;
}

const ACTIVE_TURN = 'active';
const TERMINATED_TURN = 'terminated';
const SUBAGENT_SPAWN_CONTENT_TYPE = 'application/vnd.limcode.subagent-spawn+json';
const TERMINAL_CHILD_STATES = new Set(['terminated', 'needs_human']);
const CANCELLING_CHILD_STATES = new Set(['cancel_subtree_requested', 'cancelling']);
const TERMINAL_OPERATION_STATES = new Set([
  'succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown'
]);

/** Stable ChildExecution lineage and run_agent control plane for Phase F. */
export class ChildExecutionControlPlane {
  private readonly now: () => string;
  private readonly prepareNextTurnDeliverySteps?: ChildExecutionControlPlaneOptions['prepareNextTurnDeliverySteps'];

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    options: ChildExecutionControlPlaneOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.prepareNextTurnDeliverySteps = options.prepareNextTurnDeliverySteps;
  }

  /**
   * Child Conversation, stable lineage/links, first Turn, bridge and spawn Effect facts are one
   * transaction. The CAS request is published first and may remain as an unreferenced orphan if the
   * transaction fails.
   */
  public async spawn(commandInput: ChildExecutionSpawnCommand): Promise<ChildExecutionSpawnResult> {
    const command = normalizeSpawnCommand(commandInput);
    const ids = spawnIds(command);
    const replay = await this.findSpawnReplay(command, ids);
    if (replay) return replay;

    const parent = await this.readSpawnParent(command.sourceToolCallId);
    if (parent.turn.status !== ACTIVE_TURN || parent.termination !== null) {
      throw new Error('ChildExecution spawn is rejected because the parent Turn is terminal.');
    }
    if (!parent.lease) throw new Error('ChildExecution spawn requires the parent Turn ExecutionLease.');
    if (parent.parentChildExecution && (
      TERMINAL_CHILD_STATES.has(String(parent.parentChildExecution.status))
      || CANCELLING_CHILD_STATES.has(String(parent.parentChildExecution.status))
    )) {
      throw new Error('ChildExecution spawn is rejected because the parent lineage is terminating.');
    }
    if (parent.toolCall.status !== 'pending' || parent.toolExecution.status !== 'pending') {
      throw new Error(`Source ToolCall cannot spawn from ${String(parent.toolCall.status)}/${String(parent.toolExecution.status)}.`);
    }

    const requestContent = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson(spawnRequestPayload(command, ids)),
      SUBAGENT_SPAWN_CONTENT_TYPE
    );
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'internal',
        source_key: `subagent-spawn:${command.sourceToolCallId}`,
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(parent.turn.id as string, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(parent.lease.id as string, {
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id
      }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: parent.turn.id }),
      DOMAIN_REPOSITORIES.domain('ToolCall').assert(command.sourceToolCallId, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').assert(parent.toolExecution.id as string, { status: 'pending' }),
      ...(parent.parentChildExecution
        ? [DOMAIN_REPOSITORIES.domain('ChildExecution').assert(parent.parentChildExecution.id as string, {
            status: parent.parentChildExecution.status
          })]
        : []),
      ...preparedContentObjectSteps([requestContent], 'subagent_spawn_request'),
      DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: ids.childConversationId,
        title: command.title,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: ids.childRootId,
        conversation_id: ids.childConversationId,
        root_node_id: null,
        tail_node_id: null,
        tail_segment_count: '0',
        segment_count: '0',
        estimated_tokens: '0',
        created_at: now
      }, {
        column: 'root_seq',
        scope: { conversation_id: ids.childConversationId }
      }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
        id: ids.childHeadLinkId,
        conversation_id: ids.childConversationId,
        root_id: ids.childRootId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: ids.childAgentLinkId,
        conversation_id: ids.childConversationId,
        agent_id: command.childAgentId,
        role: 'default',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
        id: ids.childExecutionId,
        child_conversation_id: ids.childConversationId,
        status: 'starting',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
        id: ids.parentLinkId,
        child_execution_id: ids.childExecutionId,
        source_tool_call_id: command.sourceToolCallId,
        parent_child_execution_id: parent.parentChildExecution?.id ?? null,
        parent_turn_id: parent.turn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.childTurnId,
        conversation_id: ids.childConversationId,
        status: ACTIVE_TURN,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.childLeaseId,
        conversation_id: ids.childConversationId,
        turn_id: ids.childTurnId,
        owner_id: command.leaseOwnerId,
        host_boot_id: this.database.hostBootId,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.childExecutorLinkId,
        turn_id: ids.childTurnId,
        agent_id: command.childAgentId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insert({
        id: ids.turnLinkId,
        child_execution_id: ids.childExecutionId,
        turn_seq: '1',
        turn_id: ids.childTurnId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
        id: ids.activeTurnLinkId,
        child_execution_id: ids.childExecutionId,
        turn_id: ids.childTurnId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
        id: ids.answerBridgeId,
        child_execution_id: ids.childExecutionId,
        current_submission_id: null,
        status: 'open',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
        id: ids.operationId,
        owner_kind: 'child_execution',
        owner_id: ids.childExecutionId,
        tool_call_id: command.sourceToolCallId,
        status: 'pending',
        created_at: now,
        updated_at: now
      }, {
        column: 'operation_seq',
        scope: { owner_kind: 'child_execution', owner_id: ids.childExecutionId }
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: ids.attemptId,
        operation_id: ids.operationId,
        attempt_seq: '1',
        status: 'pending',
        created_at: now,
        updated_at: now,
        completed_at: null
      }),
      DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
        id: ids.effectIntentId,
        attempt_id: ids.attemptId,
        effect_kind: 'subagent_spawn',
        dispatch_state: 'pending',
        request_object_id: requestContent.metadata.id,
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolCall').update(command.sourceToolCallId, {
        status: 'executing',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').update(parent.toolExecution.id as string, {
        status: 'executing',
        wait_deadline_at: command.waitDeadlineAt ?? null,
        updated_at: now
      })
    ];

    try {
      const commit = await this.database.transaction(steps);
      return spawnResult(ids, command.completionPolicy, false, commit.commitSeq);
    } catch (error) {
      if (!isExpectedSpawnIdentityConflict(error)) throw error;
      const raced = await this.findSpawnReplay(command, ids, requestContent);
      if (!raced) throw error;
      return raced;
    }
  }

  public claimSpawnDispatch(effectIntentId: string): Promise<boolean> {
    return this.effects.claimEffectDispatch(requirePhaseFId(effectIntentId, 'effectIntentId'));
  }

  public recordSpawnReceipt(input: {
    sourceKey: string;
    attemptId: string;
    outcome: EffectObservedOutcome;
    detail?: unknown;
  }): Promise<RecordedEffectReceipt> {
    return this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: requirePhaseFText(input.sourceKey, 'sourceKey') },
      attemptId: requirePhaseFId(input.attemptId, 'attemptId'),
      effectKind: 'subagent_spawn',
      outcome: input.outcome,
      ...(input.detail === undefined ? {} : { detail: input.detail })
    });
  }

  /** Reconciles the persisted spawn receipt without dispatching the external spawn again. */
  public async reconcileSpawnReceipt(effectReceiptIdInput: string): Promise<{
    childExecutionId: string;
    toolCallId: string;
    status: string;
    terminalToolResult: boolean;
    deduplicated: boolean;
    commitSeq?: string;
  }> {
    const effectReceiptId = requirePhaseFId(effectReceiptIdInput, 'effectReceiptId');
    const facts = await this.readSpawnReceiptFacts(effectReceiptId);
    if (facts.intent.effect_kind !== 'subagent_spawn') throw new Error('EffectReceipt is not a subagent_spawn receipt.');
    const currentOperationStatus = String(facts.operation.status);
    if (currentOperationStatus === 'waiting_answer' || TERMINAL_OPERATION_STATES.has(currentOperationStatus)) {
      const terminal = await this.effects.readTerminalResult(facts.toolCall.id as string, true);
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: facts.toolCall.id as string,
        status: currentOperationStatus,
        terminalToolResult: terminal !== null,
        deduplicated: true
      };
    }

    const observed = requireSpawnObservedOutcome(facts.receipt.outcome);
    const completionPolicy = completionPolicyFromRequest(await this.effects.readEffectRequest(facts.intent.id as string));
    const now = this.timestamp();
    const successfulWait = observed === 'succeeded' && completionPolicy === 'wait_for_answer';
    const toolStatus = observedToToolOutcome(observed);
    const terminalPlan = successfulWait
      ? null
      : await this.effects.prepareTerminalPlan(
          facts.toolCall.id as string,
          toolStatus,
          observed === 'succeeded'
            ? childControlHandle(facts.childExecution, facts.bridge)
            : { childExecutionId: facts.childExecution.id, answerBridgeId: facts.bridge.id, spawnOutcome: observed },
          stablePhaseFId('command_receipt', 'spawn-reconcile', effectReceiptId)
        );
    const terminalChild = observed !== 'succeeded';
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('EffectReceipt').assert(effectReceiptId, {
        attempt_id: facts.attempt.id,
        outcome: observed
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(facts.attempt.id as string, { status: facts.attempt.status }),
      DOMAIN_REPOSITORIES.domain('Operation').assert(facts.operation.id as string, { status: facts.operation.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(facts.childExecution.id as string, {
        status: facts.childExecution.status
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').update(facts.attempt.id as string, {
        status: observed,
        updated_at: now,
        completed_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').update(facts.operation.id as string, {
        status: successfulWait ? 'waiting_answer' : toolStatus,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(facts.childExecution.id as string, {
        status: observed === 'succeeded' ? 'active' : observed === 'outcome_unknown' ? 'needs_human' : 'terminated',
        updated_at: now
      }),
      ...(successfulWait
        ? [DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.toolExecution.id as string, {
            status: 'waiting_answer',
            updated_at: now
          })]
        : []),
      ...(terminalChild ? terminalChildTurnSteps(facts, observed, now) : []),
      ...(terminalPlan ? terminalPlan.steps : [])
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: facts.toolCall.id as string,
        status: successfulWait ? 'waiting_answer' : toolStatus,
        terminalToolResult: terminalPlan !== null,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      const latestOperation = await this.requireExisting('Operation', facts.operation.id as string);
      if (latestOperation.status === facts.operation.status) throw error;
      const terminal = await this.effects.readTerminalResult(facts.toolCall.id as string, true);
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: facts.toolCall.id as string,
        status: String(latestOperation.status),
        terminalToolResult: terminal !== null,
        deduplicated: true
      };
    }
  }

  public async send(commandInput: ChildExecutionSendCommand): Promise<ChildExecutionSendResult> {
    const command = normalizeSendCommand(commandInput);
    const ids = sendIds(command);
    const replay = await this.findSendReplay(command, ids);
    if (replay) return replay;
    const snapshot = await this.readExecutionSnapshot(command.childExecutionId);
    if (TERMINAL_CHILD_STATES.has(String(snapshot.childExecution.status))
      || CANCELLING_CHILD_STATES.has(String(snapshot.childExecution.status))) {
      throw new Error('Cannot send to a terminal or cancelling ChildExecution.');
    }
    if (!snapshot.activeTurnLink || !snapshot.activeTurn || snapshot.activeTurn.status !== ACTIVE_TURN) {
      throw new Error('ChildExecution send requires a current active Turn.');
    }
    const content = await this.contentStore.prepare(
      this.database,
      command.content,
      command.contentType
    );
    const preset = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({ kind: 'child-continuation', mode: command.mode }),
      'application/vnd.limcode.turn-execution-preset+json'
    );
    const interrupt = command.mode === 'interrupt_current_turn'
      ? await this.contentStore.prepare(
          this.database,
          canonicalPlainJson({
            kind: 'interrupt-request',
            reason: 'run_agent interrupt_current_turn requested a normal continuation boundary.',
            continuationIntentId: ids.turnIntentId
          }),
          'application/vnd.limcode.turn-interrupt-request+json'
        )
      : content;
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'command',
        source_key: command.sourceKey,
        conversation_id: snapshot.childExecution.child_conversation_id,
        turn_id: snapshot.activeTurn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(command.childExecutionId, {
        status: snapshot.childExecution.status
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(snapshot.activeTurnLink.id as string, {
        child_execution_id: command.childExecutionId,
        turn_id: snapshot.activeTurn.id
      }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(snapshot.activeTurn.id as string, { status: ACTIVE_TURN }),
      ...preparedContentObjectSteps(uniquePrepared([content, preset, interrupt]), 'child_send_content'),
      DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
        id: ids.turnIntentId,
        conversation_id: snapshot.childExecution.child_conversation_id,
        turn_id: null,
        state: 'queued',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
        id: ids.turnIntentRevisionId,
        intent_id: ids.turnIntentId,
        revision_seq: '1',
        content_object_id: content.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
        id: ids.presetRevisionId,
        intent_id: ids.turnIntentId,
        revision_seq: '1',
        preset_object_id: preset.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').insertWithNextSequence({
        id: ids.intentLinkId,
        child_execution_id: command.childExecutionId,
        turn_intent_id: ids.turnIntentId,
        state: 'pending',
        created_at: now,
        updated_at: now
      }, {
        column: 'intent_seq',
        scope: { child_execution_id: command.childExecutionId }
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: ids.pendingTurnInputId,
        turn_id: snapshot.activeTurn.id,
        input_kind: command.mode,
        content_object_id: interrupt.metadata.id,
        state: 'pending',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(snapshot.childExecution.child_conversation_id as string, {
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return sendResult(command, ids, false, commit.commitSeq);
    } catch (error) {
      if (!isExpectedSendIdentityConflict(error)) throw error;
      const raced = await this.findSendReplay(command, ids, content);
      if (!raced) throw error;
      return raced;
    }
  }

  /** Admits a queued continuation without creating a new ChildExecution or AnswerBridge. */
  public async admitQueuedIntent(
    commandInput: ChildContinuationAdmissionCommand
  ): Promise<ChildContinuationAdmissionResult> {
    const command = normalizeAdmissionCommand(commandInput);
    const ids = admissionIds(command);
    const replay = await this.findAdmissionReplay(command, ids);
    if (replay) return replay;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(command.childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').list({
        where: { child_execution_id: command.childExecutionId, turn_intent_id: command.turnIntentId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(command.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({
        where: { intent_id: command.turnIntentId, revision_seq: '1' },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').list({
        where: { intent_id: command.turnIntentId, revision_seq: '1' },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').list({
        where: { role: 'default' },
        limit: 1000
      })
    ]);
    const child = requireRow(snapshot.snapshot[0], `ChildExecution ${command.childExecutionId}`);
    if (TERMINAL_CHILD_STATES.has(String(child.status)) || CANCELLING_CHILD_STATES.has(String(child.status))) {
      throw new Error('Cannot admit a continuation for a terminal or cancelling ChildExecution.');
    }
    const intentLinks = requireRows(snapshot.snapshot[1], 'ChildExecutionIntentLink admission lookup');
    if (intentLinks.length !== 1) throw new Error('Queued continuation must have exactly one ChildExecutionIntentLink.');
    const intentLink = intentLinks[0];
    const intent = requireRow(snapshot.snapshot[2], `TurnIntent ${command.turnIntentId}`);
    if (intent.state !== 'queued' || intentLink.state !== 'pending') {
      throw new Error('Child continuation intent is not pending admission.');
    }
    const revisions = requireRows(snapshot.snapshot[3], 'TurnIntentRevision admission lookup');
    const presets = requireRows(snapshot.snapshot[4], 'TurnExecutionPresetRevision admission lookup');
    if (revisions.length !== 1 || presets.length !== 1) {
      throw new Error('Child continuation intent must have one immutable input and preset revision.');
    }
    const activeLinks = requireRows(snapshot.snapshot[5], 'ChildExecutionActiveTurnLink admission lookup');
    if (activeLinks.length > 1) throw new Error('ChildExecution has multiple active Turn links.');
    const activeLink = activeLinks[0] ?? null;
    let previousTurn: DomainRow | null = null;
    if (activeLink) {
      previousTurn = await this.requireExisting('Turn', requirePhaseFId(activeLink.turn_id, 'ActiveTurnLink.turn_id'));
      if (previousTurn.status === ACTIVE_TURN) {
        throw new Error('Queued continuation cannot be admitted while the previous child Turn is active.');
      }
    }
    const bridges = requireRows(snapshot.snapshot[6], 'AnswerBridge admission lookup');
    if (bridges.length !== 1) throw new Error('ChildExecution must retain exactly one AnswerBridge.');
    const bridge = bridges[0];
    const agentLinks = requireRows(snapshot.snapshot[7], 'AgentConversationLink admission lookup')
      .filter((row) => row.conversation_id === child.child_conversation_id);
    if (agentLinks.length !== 1) throw new Error('Child Conversation must have one default Agent link.');
    const now = this.timestamp();
    const nextDeliverySteps = this.prepareNextTurnDeliverySteps
      ? await this.prepareNextTurnDeliverySteps(child.child_conversation_id as string, ids.turnId, now)
      : [];
    const activeMutation = activeLink
      ? DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').update(activeLink.id as string, {
          turn_id: ids.turnId,
          updated_at: now
        })
      : DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
          id: stablePhaseFId('child_execution_active_turn_link', command.childExecutionId),
          child_execution_id: command.childExecutionId,
          turn_id: ids.turnId,
          updated_at: now
        });
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'internal',
        source_key: command.sourceKey,
        conversation_id: child.child_conversation_id,
        turn_id: ids.turnId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(command.childExecutionId, { status: child.status }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').assert(command.turnIntentId, { state: 'queued', turn_id: null }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assert(intentLink.id as string, {
        child_execution_id: command.childExecutionId,
        turn_intent_id: command.turnIntentId,
        state: 'pending'
      }),
      ...(activeLink
        ? [
            DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(activeLink.id as string, {
              child_execution_id: command.childExecutionId,
              turn_id: activeLink.turn_id
            }),
            DOMAIN_REPOSITORIES.domain('Turn').assert(previousTurn!.id as string, { status: TERMINATED_TURN })
          ]
        : []),
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.turnId,
        conversation_id: child.child_conversation_id,
        status: ACTIVE_TURN,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.leaseId,
        conversation_id: child.child_conversation_id,
        turn_id: ids.turnId,
        owner_id: command.leaseOwnerId,
        host_boot_id: this.database.hostBootId,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.authoritySnapshotId,
        turn_id: ids.turnId,
        content_object_id: presets[0].preset_object_id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.executorLinkId,
        turn_id: ids.turnId,
        agent_id: agentLinks[0].agent_id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: ids.pendingTurnInputId,
        turn_id: ids.turnId,
        input_kind: 'continuation',
        content_object_id: revisions[0].content_object_id,
        state: 'pending',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').update(command.turnIntentId, {
        turn_id: ids.turnId,
        state: 'admitted',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').update(intentLink.id as string, {
        state: 'admitted',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insertWithNextSequence({
        id: ids.turnLinkId,
        child_execution_id: command.childExecutionId,
        turn_id: ids.turnId,
        created_at: now
      }, {
        column: 'turn_seq',
        scope: { child_execution_id: command.childExecutionId }
      }),
      activeMutation,
      ...nextDeliverySteps,
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(command.childExecutionId, {
        status: 'active',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(child.child_conversation_id as string, {
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      const turnSeq = allocatedValue(commit.allocatedSequences, 'ChildExecutionTurnLink', ids.turnLinkId, 'turn_seq');
      return {
        childExecutionId: command.childExecutionId,
        turnIntentId: command.turnIntentId,
        turnId: ids.turnId,
        turnSeq,
        answerBridgeId: bridge.id as string,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedAdmissionIdentityConflict(error)) throw error;
      const raced = await this.findAdmissionReplay(command, ids);
      if (!raced) throw error;
      return raced;
    }
  }

  /** A single cancellation request targets only the current ActiveTurnLink target. */
  public async cancel(commandInput: ChildExecutionCancelCommand): Promise<{
    childExecutionId: string;
    activeTurnId: string | null;
    pendingTurnInputId?: string;
    deduplicated: boolean;
    commitSeq?: string;
  }> {
    const command = normalizeCancelCommand(commandInput);
    const snapshot = await this.readExecutionSnapshot(command.childExecutionId);
    if (!snapshot.activeTurnLink || !snapshot.activeTurn || snapshot.activeTurn.status !== ACTIVE_TURN) {
      return { childExecutionId: command.childExecutionId, activeTurnId: null, deduplicated: true };
    }
    const pendingTurnInputId = stablePhaseFId(
      'pending_turn_input', 'child-cancel', command.sourceKey, command.childExecutionId, snapshot.activeTurn.id
    );
    const receiptId = stablePhaseFId('command_receipt', 'child-cancel', command.sourceKey);
    const existingReceipt = await this.findCommandReceipt('command', command.sourceKey);
    if (existingReceipt) {
      const existingInput = await this.maybeGet('PendingTurnInput', pendingTurnInputId);
      return {
        childExecutionId: command.childExecutionId,
        activeTurnId: snapshot.activeTurn.id as string,
        ...(existingInput ? { pendingTurnInputId } : {}),
        deduplicated: true
      };
    }
    const content = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({ kind: 'subagent-cancel', reason: command.reason }),
      'application/vnd.limcode.turn-interrupt-request+json'
    );
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: receiptId,
          source_kind: 'command',
          source_key: command.sourceKey,
          conversation_id: snapshot.childExecution.child_conversation_id,
          turn_id: snapshot.activeTurn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(snapshot.activeTurnLink.id as string, {
          child_execution_id: command.childExecutionId,
          turn_id: snapshot.activeTurn.id
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(snapshot.activeTurn.id as string, { status: ACTIVE_TURN }),
        ...preparedContentObjectSteps([content], 'child_cancel'),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
          id: pendingTurnInputId,
          turn_id: snapshot.activeTurn.id,
          input_kind: 'termination_request',
          content_object_id: content.metadata.id,
          state: 'pending',
          created_at: now,
          updated_at: now
        })
      ]);
      return {
        childExecutionId: command.childExecutionId,
        activeTurnId: snapshot.activeTurn.id as string,
        pendingTurnInputId,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedCancelIdentityConflict(error)) throw error;
      const receipt = await this.findCommandReceipt('command', command.sourceKey);
      const input = await this.maybeGet('PendingTurnInput', pendingTurnInputId);
      if (!receipt || !input) throw error;
      return {
        childExecutionId: command.childExecutionId,
        activeTurnId: snapshot.activeTurn.id as string,
        pendingTurnInputId,
        deduplicated: true
      };
    }
  }

  /**
   * Recurses over stable ParentLink edges and writes every active termination request plus every
   * pending IntentLink cancellation in one SQLite transaction. ActiveTurnLink is never used to infer
   * tree membership.
   */
  public async cancelSubtree(commandInput: ChildExecutionCancelCommand): Promise<ChildExecutionCancelSubtreeResult> {
    return this.cancelSubtreeAttempt(normalizeCancelCommand(commandInput), 0);
  }

  private async cancelSubtreeAttempt(
    command: ReturnType<typeof normalizeCancelCommand>,
    retryCount: number
  ): Promise<ChildExecutionCancelSubtreeResult> {
    const tree = await this.readStableTreeSnapshot(command.childExecutionId);
    const content = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({
        kind: 'subagent-cancel-subtree',
        rootChildExecutionId: command.childExecutionId,
        reason: command.reason
      }),
      'application/vnd.limcode.turn-interrupt-request+json'
    );
    const existingReceipt = await this.findCommandReceipt(
      command.sourceKey.startsWith('recovery:') ? 'recovery' : 'command',
      command.sourceKey
    );
    const sourceKind = command.sourceKey.startsWith('recovery:') ? 'recovery' : 'command';
    const now = this.timestamp();
    const newTerminationTurns = tree.activeTurns.filter((turn) =>
      turn.status === ACTIVE_TURN
      && !tree.pendingInputIds.has(stablePhaseFId(
        'pending_turn_input', 'cancel-subtree', command.childExecutionId, turn.id
      ))
    );
    const steps: RepositoryTransactionStep[] = [
      ...(existingReceipt ? [] : [DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: stablePhaseFId('command_receipt', 'cancel-subtree', sourceKind, command.sourceKey),
        source_kind: sourceKind,
        source_key: command.sourceKey,
        conversation_id: tree.root.child_conversation_id,
        turn_id: tree.activeTurns[0]?.id ?? null,
        created_at: now
      })]),
      ...tree.parentLinks.map((link) => DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(
        link.id as string,
        {
          child_execution_id: link.child_execution_id,
          parent_child_execution_id: link.parent_child_execution_id,
          parent_turn_id: link.parent_turn_id
        }
      )),
      ...tree.lineages.flatMap((lineage) => [
        DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assertExactIds(
          { parent_child_execution_id: lineage.id },
          tree.parentLinks
            .filter((link) => link.parent_child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionParentLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertExactIds(
          { child_execution_id: lineage.id },
          tree.activeLinks
            .filter((link) => link.child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionActiveTurnLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assertExactIds(
          { child_execution_id: lineage.id },
          tree.intentLinks
            .filter((link) => link.child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionIntentLink.id'))
        )
      ]),
      ...tree.activeLinks.map((link) => DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
        link.id as string,
        { child_execution_id: link.child_execution_id, turn_id: link.turn_id }
      )),
      ...tree.lineages.map((lineage) => DOMAIN_REPOSITORIES.domain('ChildExecution').assert(
        requirePhaseFId(lineage.id, 'ChildExecution.id'),
        { status: lineage.status }
      )),
      ...preparedContentObjectSteps([content], 'cancel_subtree'),
      ...tree.activeTurns.flatMap((turn) => {
        const inputId = stablePhaseFId(
          'pending_turn_input', 'cancel-subtree', command.childExecutionId, turn.id
        );
        if (tree.pendingInputIds.has(inputId) || turn.status !== ACTIVE_TURN) return [];
        return [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turn.id as string, { status: ACTIVE_TURN }),
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
            id: inputId,
            turn_id: turn.id,
            input_kind: 'termination_request',
            content_object_id: content.metadata.id,
            state: 'pending',
            created_at: now,
            updated_at: now
          })
        ];
      }),
      ...tree.pendingIntentLinks.flatMap((link) => [
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assert(link.id as string, { state: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').update(link.id as string, {
          state: 'cancelled',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntent').update(link.turn_intent_id as string, {
          state: 'cancelled',
          updated_at: now
        })
      ]),
      ...tree.lineages.map((child) => DOMAIN_REPOSITORIES.domain('ChildExecution').update(child.id as string, {
        status: child.id === command.childExecutionId ? 'cancel_subtree_requested' : 'cancelling',
        updated_at: now
      }))
    ];
    let commit: Awaited<ReturnType<RuntimeDatabase['transaction']>>;
    try {
      commit = await this.database.transaction(steps);
    } catch (error) {
      if (isExpectedCancelIdentityConflict(error) && retryCount < 8) {
        return this.cancelSubtreeAttempt(command, retryCount + 1);
      }
      throw error;
    }
    return {
      rootChildExecutionId: command.childExecutionId,
      lineageIds: tree.lineages.map((entry) => entry.id as string),
      activeTurnIds: tree.activeTurns.filter((turn) => turn.status === ACTIVE_TURN).map((turn) => turn.id as string),
      cancelledIntentIds: tree.pendingIntentLinks.map((link) => link.turn_intent_id as string),
      terminationRequestsWritten: newTerminationTurns.length,
      intentsCancelled: tree.pendingIntentLinks.length,
      deduplicated: existingReceipt !== null,
      commitSeq: commit.commitSeq
    };
  }

  /** Clears only the mutable active pointer after the Turn has durably terminated. */
  public async observeTurnTerminal(childExecutionIdInput: string, turnIdInput: string): Promise<boolean> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    if (!snapshot.activeTurnLink || snapshot.activeTurnLink.turn_id !== turnId) return false;
    if (!snapshot.activeTurn || snapshot.activeTurn.status !== TERMINATED_TURN) {
      throw new Error('ActiveTurnLink can only be cleared after its exact Turn is terminal.');
    }
    const now = this.timestamp();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TERMINATED_TURN }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(snapshot.activeTurnLink.id as string, {
        child_execution_id: childExecutionId,
        turn_id: turnId
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(snapshot.activeTurnLink.id as string),
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(childExecutionId, {
        status: CANCELLING_CHILD_STATES.has(String(snapshot.childExecution.status))
          ? snapshot.childExecution.status
          : 'idle',
        updated_at: now
      })
    ]);
    return true;
  }

  /** One short SQLite read transaction; no answer/delivery state is consumed. */
  public async readExecutionSnapshot(childExecutionIdInput: string): Promise<ChildExecutionSnapshot> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
        where: { child_execution_id: childExecutionId },
        orderBy: { column: 'turn_seq', direction: 'asc' },
        limit: 1000
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('Turn').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('AnswerSubmission').list({ limit: 1000 })
    ]);
    const childExecution = requireRow(barrier.snapshot[0], `ChildExecution ${childExecutionId}`);
    const parentLinks = requireRows(barrier.snapshot[1], 'ChildExecutionParentLink snapshot');
    const turnLinks = requireRows(barrier.snapshot[2], 'ChildExecutionTurnLink snapshot');
    const activeLinks = requireRows(barrier.snapshot[3], 'ChildExecutionActiveTurnLink snapshot');
    const bridges = requireRows(barrier.snapshot[4], 'AnswerBridge snapshot');
    if (parentLinks.length !== 1) throw new Error('ChildExecution must have exactly one stable ParentLink.');
    if (activeLinks.length > 1) throw new Error('ChildExecution has multiple ActiveTurnLinks.');
    if (bridges.length !== 1) throw new Error('ChildExecution must have exactly one AnswerBridge.');
    const activeTurnLink = activeLinks[0] ?? null;
    const turns = requireRows(barrier.snapshot[5], 'Turn snapshot');
    const activeTurn = activeTurnLink
      ? turns.find((turn) => turn.id === activeTurnLink.turn_id) ?? null
      : null;
    if (activeTurnLink && !activeTurn) throw new Error('ChildExecution ActiveTurnLink target is missing.');
    const bridge = bridges[0];
    const submissions = requireRows(barrier.snapshot[6], 'AnswerSubmission snapshot');
    const currentSubmission = bridge.current_submission_id === null
      ? null
      : submissions.find((submission) => submission.id === bridge.current_submission_id) ?? null;
    if (bridge.current_submission_id !== null && !currentSubmission) {
      throw new Error('AnswerBridge current submission target is missing.');
    }
    return {
      childExecution,
      parentLink: parentLinks[0],
      turnLinks,
      activeTurnLink,
      activeTurn,
      answerBridge: bridge,
      currentSubmission
    };
  }

  /** One short SQLite snapshot transaction over all list facts. */
  public async list(limit = 200): Promise<ChildExecutionSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      throw new RangeError('ChildExecution list limit must be from 1 to 200.');
    }
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').list({
        orderBy: { column: 'created_at', direction: 'desc' },
        limit
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('Turn').list({ limit: 1000 }),
      DOMAIN_REPOSITORIES.domain('AnswerSubmission').list({ limit: 1000 })
    ]);
    const children = requireRows(barrier.snapshot[0], 'ChildExecution list snapshot');
    const parents = requireRows(barrier.snapshot[1], 'ChildExecutionParentLink list snapshot');
    const memberships = requireRows(barrier.snapshot[2], 'ChildExecutionTurnLink list snapshot');
    const activeLinks = requireRows(barrier.snapshot[3], 'ChildExecutionActiveTurnLink list snapshot');
    const bridges = requireRows(barrier.snapshot[4], 'AnswerBridge list snapshot');
    const turns = requireRows(barrier.snapshot[5], 'Turn list snapshot');
    const submissions = requireRows(barrier.snapshot[6], 'AnswerSubmission list snapshot');
    return children.map((child) => {
      const childId = child.id as string;
      const parentRows = parents.filter((row) => row.child_execution_id === childId);
      const activeRows = activeLinks.filter((row) => row.child_execution_id === childId);
      const bridgeRows = bridges.filter((row) => row.child_execution_id === childId);
      if (parentRows.length !== 1 || activeRows.length > 1 || bridgeRows.length !== 1) {
        throw new Error(`ChildExecution ${childId} link cardinality is invalid.`);
      }
      const activeTurnLink = activeRows[0] ?? null;
      const answerBridge = bridgeRows[0];
      return {
        childExecution: child,
        parentLink: parentRows[0],
        turnLinks: memberships
          .filter((row) => row.child_execution_id === childId)
          .sort((left, right) => compareBigInt(left.turn_seq, right.turn_seq)),
        activeTurnLink,
        activeTurn: activeTurnLink ? turns.find((turn) => turn.id === activeTurnLink.turn_id) ?? null : null,
        answerBridge,
        currentSubmission: answerBridge.current_submission_id === null
          ? null
          : submissions.find((submission) => submission.id === answerBridge.current_submission_id) ?? null
      };
    });
  }

  /** Local timeout has no durable side effect; each observed state is from one SQLite snapshot. */
  public async wait(childExecutionId: string, timeoutMs = 0): Promise<ChildExecutionSnapshot> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new RangeError('ChildExecution wait timeout must be from 0 to 60000ms.');
    }
    const first = await this.readExecutionSnapshot(childExecutionId);
    if (timeoutMs === 0 || executionWaitComplete(first)) return first;
    return new Promise<ChildExecutionSnapshot>((resolve, reject) => {
      let settled = false;
      let reading = false;
      const finish = (value: ChildExecutionSnapshot) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.database.onCommit(() => {
        if (settled || reading) return;
        reading = true;
        void this.readExecutionSnapshot(childExecutionId).then((snapshot) => {
          reading = false;
          if (executionWaitComplete(snapshot)) finish(snapshot);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        });
      });
      const timer = setTimeout(() => finish(first), timeoutMs);
    });
  }

  /** Prepares first-wins foreground ToolCall settlement steps for an answer or deadline transaction. */
  public async prepareForegroundSettlement(input: {
    childExecutionId: string;
    status: ToolOutcomeStatus;
    detail: unknown;
    sourceIdentity: string;
  }): Promise<PreparedForegroundSettlement | null> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const sourceIdentity = requirePhaseFText(input.sourceIdentity, 'sourceIdentity');
    const parentLinks = await this.listRows('ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
    if (parentLinks.length !== 1) throw new Error('ChildExecution foreground settlement requires one ParentLink.');
    const toolCallId = requirePhaseFId(parentLinks[0].source_tool_call_id, 'ParentLink.source_tool_call_id');
    const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
    const operations = await this.listRows('Operation', {
      owner_kind: 'child_execution',
      owner_id: childExecutionId
    }, 2);
    if (executions.length !== 1 || operations.length !== 1) {
      throw new Error('ChildExecution foreground settlement facts are incomplete.');
    }
    if (executions[0].status !== 'waiting_answer' || operations[0].status !== 'waiting_answer') return null;
    const waitDeadlineAt = requireIsoTimestamp(executions[0].wait_deadline_at, 'ToolExecution.wait_deadline_at');
    const receiptId = stablePhaseFId('command_receipt', 'foreground-settlement', sourceIdentity, toolCallId);
    const plan = await this.effects.prepareTerminalPlan(toolCallId, input.status, input.detail, receiptId);
    const now = this.timestamp();
    return {
      toolCallId,
      childExecutionId,
      receiptId,
      waitDeadlineAt,
      plan,
      steps: [
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(executions[0].id as string, {
          status: 'waiting_answer',
          wait_deadline_at: executions[0].wait_deadline_at
        }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operations[0].id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operations[0].id as string, {
          status: input.status,
          updated_at: now
        }),
        ...plan.steps
      ]
    };
  }

  /** Expired foreground wait settles with a background control handle and never dispatches spawn. */
  public async settleForegroundTimeout(childExecutionIdInput: string, nowInput = this.timestamp()): Promise<boolean> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const now = requireIsoTimestamp(nowInput, 'now');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    const parentLinks = [snapshot.parentLink];
    const toolCallId = parentLinks[0].source_tool_call_id as string;
    const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1 || executions[0].status !== 'waiting_answer') return false;
    const deadline = executions[0].wait_deadline_at;
    if (typeof deadline !== 'string' || Date.parse(deadline) > Date.parse(now)) return false;
    const settlement = await this.prepareForegroundSettlement({
      childExecutionId,
      status: 'succeeded',
      detail: childControlHandle(snapshot.childExecution, snapshot.answerBridge),
      sourceIdentity: `foreground-timeout:${toolCallId}:${deadline}`
    });
    if (!settlement) return false;
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: settlement.receiptId,
          source_kind: 'recovery',
          source_key: `foreground-timeout:${toolCallId}:${deadline}`,
          conversation_id: (await this.requireExisting('Turn', (await this.requireExisting('ToolCall', toolCallId)).turn_id as string)).conversation_id,
          turn_id: (await this.requireExisting('ToolCall', toolCallId)).turn_id,
          created_at: now
        }),
        ...settlement.steps
      ]);
      return true;
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      return (await this.effects.readTerminalResult(toolCallId, true)) === null ? Promise.reject(error) : false;
    }
  }

  private async readSpawnParent(sourceToolCallId: string): Promise<{
    toolCall: DomainRow;
    toolExecution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
    lease: DomainRow | null;
    termination: DomainRow | null;
    parentChildExecution: DomainRow | null;
  }> {
    const first = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(sourceToolCallId),
      DOMAIN_REPOSITORIES.domain('ToolExecution').list({ where: { tool_call_id: sourceToolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({ limit: 1000 })
    ]);
    const toolCall = requireRow(first.snapshot[0], `ToolCall ${sourceToolCallId}`);
    const executions = requireRows(first.snapshot[1], 'ToolExecution spawn lookup');
    if (executions.length !== 1) throw new Error('Source ToolCall must have exactly one ToolExecution.');
    const turnId = requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id');
    const parentMembership = requireRows(first.snapshot[2], 'ChildExecutionTurnLink parent lookup')
      .find((link) => link.turn_id === turnId);
    const second = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').list({ where: { turn_id: turnId }, limit: 2 }),
      ...(parentMembership
        ? [DOMAIN_REPOSITORIES.domain('ChildExecution').get(parentMembership.child_execution_id as string)]
        : [])
    ]);
    const turn = requireRow(second.snapshot[0], `Turn ${turnId}`);
    const leases = requireRows(second.snapshot[1], 'ExecutionLease spawn lookup');
    const terminations = requireRows(second.snapshot[2], 'TurnTermination spawn lookup');
    const conversation = await this.requireExisting('Conversation', requirePhaseFId(turn.conversation_id, 'Turn.conversation_id'));
    return {
      toolCall,
      toolExecution: executions[0],
      turn,
      conversation,
      lease: leases[0] ?? null,
      termination: terminations[0] ?? null,
      parentChildExecution: parentMembership
        ? requireRow(second.snapshot[3], `ChildExecution ${String(parentMembership.child_execution_id)}`)
        : null
    };
  }

  private async findSpawnReplay(
    command: ReturnType<typeof normalizeSpawnCommand>,
    ids: SpawnIds,
    preparedRequest?: PreparedContentObject
  ): Promise<ChildExecutionSpawnResult | null> {
    const links = await this.listRows('ChildExecutionParentLink', {
      source_tool_call_id: command.sourceToolCallId
    }, 2);
    if (links.length === 0) return null;
    if (links.length !== 1 || links[0].child_execution_id !== ids.childExecutionId) {
      throw new Error('Source ToolCall already owns a different ChildExecution lineage.');
    }
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(ids.childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').get(ids.turnLinkId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').get(ids.activeTurnLinkId),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').get(ids.answerBridgeId),
      DOMAIN_REPOSITORIES.domain('Operation').get(ids.operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(ids.attemptId),
      DOMAIN_REPOSITORIES.domain('EffectIntent').get(ids.effectIntentId)
    ]);
    const child = requireRow(snapshot.snapshot[0], `ChildExecution ${ids.childExecutionId}`);
    const turnLink = requireRow(snapshot.snapshot[1], `ChildExecutionTurnLink ${ids.turnLinkId}`);
    const active = requireRow(snapshot.snapshot[2], `ChildExecutionActiveTurnLink ${ids.activeTurnLinkId}`);
    const bridge = requireRow(snapshot.snapshot[3], `AnswerBridge ${ids.answerBridgeId}`);
    const operation = requireRow(snapshot.snapshot[4], `Operation ${ids.operationId}`);
    const attempt = requireRow(snapshot.snapshot[5], `Attempt ${ids.attemptId}`);
    const intent = requireRow(snapshot.snapshot[6], `EffectIntent ${ids.effectIntentId}`);
    const expectedRequestObjectId = preparedRequest?.metadata.id ?? this.contentStore.identity(
      canonicalPlainJson(spawnRequestPayload(command, ids)),
      SUBAGENT_SPAWN_CONTENT_TYPE
    ).id;
    if (
      child.child_conversation_id !== ids.childConversationId
      || turnLink.turn_id !== ids.childTurnId
      || active.turn_id !== ids.childTurnId
      || bridge.child_execution_id !== ids.childExecutionId
      || operation.owner_kind !== 'child_execution'
      || operation.owner_id !== ids.childExecutionId
      || operation.tool_call_id !== command.sourceToolCallId
      || attempt.operation_id !== ids.operationId
      || intent.attempt_id !== ids.attemptId
      || intent.effect_kind !== 'subagent_spawn'
      || intent.request_object_id !== expectedRequestObjectId
    ) throw new Error('ChildExecution spawn source was replayed with different facts.');
    return spawnResult(ids, command.completionPolicy, true);
  }

  private async readSpawnReceiptFacts(effectReceiptId: string) {
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    const attempt = await this.requireExisting('Attempt', requirePhaseFId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requirePhaseFId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.owner_kind !== 'child_execution') throw new Error('Spawn Operation is not owned by ChildExecution.');
    const childExecution = await this.requireExisting('ChildExecution', requirePhaseFId(operation.owner_id, 'Operation.owner_id'));
    const intentRows = await this.listRows('EffectIntent', { attempt_id: attempt.id }, 2);
    const toolCall = await this.requireExisting('ToolCall', requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id'));
    const toolExecutions = await this.listRows('ToolExecution', { tool_call_id: toolCall.id }, 2);
    const bridges = await this.listRows('AnswerBridge', { child_execution_id: childExecution.id }, 2);
    const activeLinks = await this.listRows('ChildExecutionActiveTurnLink', { child_execution_id: childExecution.id }, 2);
    if (intentRows.length !== 1 || toolExecutions.length !== 1 || bridges.length !== 1 || activeLinks.length > 1) {
      throw new Error('Spawn receipt lineage facts are incomplete.');
    }
    const childTurn = activeLinks[0]
      ? await this.requireExisting('Turn', requirePhaseFId(activeLinks[0].turn_id, 'ActiveTurnLink.turn_id'))
      : null;
    const childLeaseRows = childTurn
      ? await this.listRows('ExecutionLease', { turn_id: childTurn.id }, 2)
      : [];
    return {
      receipt,
      attempt,
      operation,
      childExecution,
      intent: intentRows[0],
      toolCall,
      toolExecution: toolExecutions[0],
      bridge: bridges[0],
      activeLink: activeLinks[0] ?? null,
      childTurn,
      childLease: childLeaseRows[0] ?? null
    };
  }

  private async findSendReplay(
    command: ReturnType<typeof normalizeSendCommand>,
    ids: ReturnType<typeof sendIds>,
    preparedContent?: PreparedContentObject
  ): Promise<ChildExecutionSendResult | null> {
    const receipt = await this.findCommandReceipt('command', command.sourceKey);
    if (!receipt) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(ids.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(ids.turnIntentRevisionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').get(ids.intentLinkId),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').get(ids.pendingTurnInputId)
    ]);
    const intent = requireRow(snapshot.snapshot[0], `TurnIntent ${ids.turnIntentId}`);
    const revision = requireRow(snapshot.snapshot[1], `TurnIntentRevision ${ids.turnIntentRevisionId}`);
    const link = requireRow(snapshot.snapshot[2], `ChildExecutionIntentLink ${ids.intentLinkId}`);
    requireRow(snapshot.snapshot[3], `PendingTurnInput ${ids.pendingTurnInputId}`);
    const expectedContentObjectId = preparedContent?.metadata.id
      ?? this.contentStore.identity(command.content, command.contentType).id;
    if (
      intent.conversation_id !== receipt.conversation_id
      || link.child_execution_id !== command.childExecutionId
      || link.turn_intent_id !== ids.turnIntentId
      || revision.content_object_id !== expectedContentObjectId
    ) throw new Error('ChildExecution send source was replayed with different facts.');
    return sendResult(command, ids, true);
  }

  private async findAdmissionReplay(
    command: ReturnType<typeof normalizeAdmissionCommand>,
    ids: ReturnType<typeof admissionIds>
  ): Promise<ChildContinuationAdmissionResult | null> {
    const receipt = await this.findCommandReceipt('internal', command.sourceKey);
    if (!receipt) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(command.turnIntentId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').get(ids.turnLinkId),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      })
    ]);
    const intent = requireRow(snapshot.snapshot[0], `TurnIntent ${command.turnIntentId}`);
    const turnLink = requireRow(snapshot.snapshot[1], `ChildExecutionTurnLink ${ids.turnLinkId}`);
    const bridges = requireRows(snapshot.snapshot[2], 'AnswerBridge admission replay');
    if (
      intent.turn_id !== ids.turnId
      || intent.state !== 'admitted'
      || turnLink.child_execution_id !== command.childExecutionId
      || turnLink.turn_id !== ids.turnId
      || bridges.length !== 1
    ) throw new Error('Child continuation admission source was replayed with different facts.');
    return {
      childExecutionId: command.childExecutionId,
      turnIntentId: command.turnIntentId,
      turnId: ids.turnId,
      turnSeq: String(turnLink.turn_seq),
      answerBridgeId: bridges[0].id as string,
      deduplicated: true
    };
  }

  private async readStableTreeSnapshot(rootId: string): Promise<{
    root: DomainRow;
    lineages: DomainRow[];
    parentLinks: DomainRow[];
    activeLinks: DomainRow[];
    activeTurns: DomainRow[];
    intentLinks: DomainRow[];
    pendingIntentLinks: DomainRow[];
    pendingInputIds: Set<string>;
  }> {
    // The relation sets can exceed one repository page. Each fixed-domain scan is complete, and the
    // writer transaction below asserts the exact Parent/Active/Intent sets before changing anything.
    const links = await listAllDomainRows(this.database, 'ChildExecutionParentLink');
    const children = await listAllDomainRows(this.database, 'ChildExecution');
    const active = await listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink');
    const intents = await listAllDomainRows(this.database, 'ChildExecutionIntentLink');
    const turns = await listAllDomainRows(this.database, 'Turn');
    const pendingInputs = await listAllDomainRows(this.database, 'PendingTurnInput');
    const byId = new Map(children.map((child) => [child.id as string, child]));
    const root = byId.get(rootId);
    if (!root) throw new Error(`ChildExecution ${rootId} does not exist.`);
    const descendants = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const link of links) {
        const parentId = link.parent_child_execution_id;
        if (typeof parentId !== 'string' || !descendants.has(parentId)) continue;
        const childId = requirePhaseFId(link.child_execution_id, 'ChildExecutionParentLink.child_execution_id');
        if (!descendants.has(childId)) {
          descendants.add(childId);
          changed = true;
        }
      }
    }
    const lineages = [...descendants].map((id) => {
      const child = byId.get(id);
      if (!child) throw new Error(`ChildExecution tree references missing lineage ${id}.`);
      return child;
    });
    const parentLinks = links.filter((link) => descendants.has(link.child_execution_id as string));
    const activeLinks = active.filter((link) => descendants.has(link.child_execution_id as string));
    const intentLinks = intents.filter((link) => descendants.has(link.child_execution_id as string));
    const activeTurnIds = new Set(activeLinks.map((link) => link.turn_id as string));
    const activeTurns = turns.filter((turn) => activeTurnIds.has(turn.id as string));
    if (activeTurns.length !== activeTurnIds.size) throw new Error('ChildExecution tree contains a missing active Turn target.');
    return {
      root,
      lineages,
      parentLinks,
      activeLinks,
      activeTurns,
      intentLinks,
      pendingIntentLinks: intentLinks.filter((link) => link.state === 'pending'),
      pendingInputIds: new Set(pendingInputs.map((input) => input.id as string))
    };
  }

  private async findCommandReceipt(sourceKind: string, sourceKey: string): Promise<DomainRow | null> {
    const rows = await this.listRows('CommandReceipt', { source_kind: sourceKind, source_key: sourceKey }, 2);
    if (rows.length > 1) throw new Error('CommandReceipt source identity is not unique.');
    return rows[0] ?? null;
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(barrier.snapshot[0], `${domain} list`);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    return requireRow(await this.maybeGet(domain, id), `${domain} ${id}`);
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'ChildExecution clock');
  }
}

function normalizeSpawnCommand(command: ChildExecutionSpawnCommand) {
  const sourceToolCallId = requirePhaseFId(command.sourceToolCallId, 'sourceToolCallId');
  const childAgentId = requirePhaseFId(command.childAgentId, 'childAgentId');
  const completionPolicy = requireCompletionPolicy(command.completionPolicy);
  const waitDeadlineAt = command.waitDeadlineAt === undefined
    ? undefined
    : requireIsoTimestamp(command.waitDeadlineAt, 'waitDeadlineAt');
  if (completionPolicy === 'wait_for_answer' && !waitDeadlineAt) {
    throw new TypeError('wait_for_answer requires a persisted waitDeadlineAt.');
  }
  if (completionPolicy === 'background' && waitDeadlineAt) {
    throw new TypeError('background completion must not persist a foreground wait deadline.');
  }
  return {
    sourceToolCallId,
    childAgentId,
    prompt: command.prompt,
    completionPolicy,
    ...(waitDeadlineAt ? { waitDeadlineAt } : {}),
    ...(optionalPhaseFId(command.childConversationId, 'childConversationId')
      ? { childConversationId: optionalPhaseFId(command.childConversationId, 'childConversationId')! }
      : {}),
    title: typeof command.title === 'string' && command.title.trim()
      ? command.title.trim()
      : '子 Agent 对话',
    leaseOwnerId: requirePhaseFId(command.leaseOwnerId, 'leaseOwnerId'),
    leaseExpiresAt: requireIsoTimestamp(command.leaseExpiresAt, 'leaseExpiresAt')
  };
}

function normalizeSendCommand(command: ChildExecutionSendCommand) {
  if (typeof command.content !== 'string' && !(command.content instanceof Uint8Array)) {
    throw new TypeError('ChildExecution send content must be text or bytes.');
  }
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    mode: requireSendMode(command.mode),
    content: command.content,
    contentType: command.contentType === undefined
      ? 'text/plain'
      : requirePhaseFText(command.contentType, 'contentType')
  };
}

function normalizeAdmissionCommand(command: ChildContinuationAdmissionCommand) {
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    turnIntentId: requirePhaseFId(command.turnIntentId, 'turnIntentId'),
    leaseOwnerId: requirePhaseFId(command.leaseOwnerId, 'leaseOwnerId'),
    leaseExpiresAt: requireIsoTimestamp(command.leaseExpiresAt, 'leaseExpiresAt')
  };
}

function normalizeCancelCommand(command: ChildExecutionCancelCommand) {
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    reason: requirePhaseFText(command.reason, 'reason')
  };
}

function spawnIds(command: ReturnType<typeof normalizeSpawnCommand>): SpawnIds {
  const source = command.sourceToolCallId;
  const childExecutionId = stablePhaseFId('child_execution', source);
  const childConversationId = command.childConversationId ?? stablePhaseFId('conversation', 'child', source);
  return {
    childExecutionId,
    childConversationId,
    childRootId: stablePhaseFId('context_sequence_root', 'child', source),
    childHeadLinkId: stablePhaseFId('conversation_context_head_link', 'child', source),
    childAgentLinkId: stablePhaseFId('agent_conversation_link', 'child', source),
    childTurnId: stablePhaseFId('turn', 'child-first', source),
    childLeaseId: stablePhaseFId('execution_lease', 'child-first', source),
    childExecutorLinkId: stablePhaseFId('turn_executor_link', 'child-first', source),
    parentLinkId: stablePhaseFId('child_execution_parent_link', source),
    turnLinkId: stablePhaseFId('child_execution_turn_link', 'first', source),
    activeTurnLinkId: stablePhaseFId('child_execution_active_turn_link', source),
    answerBridgeId: stablePhaseFId('answer_bridge', source),
    operationId: stablePhaseFId('operation', 'subagent-spawn', source),
    attemptId: stablePhaseFId('attempt', 'subagent-spawn', source, 1),
    effectIntentId: stablePhaseFId('effect_intent', 'subagent-spawn', source, 1),
    commandReceiptId: stablePhaseFId('command_receipt', 'subagent-spawn', source)
  };
}

function spawnRequestPayload(
  command: ReturnType<typeof normalizeSpawnCommand>,
  ids: SpawnIds
): Record<string, unknown> {
  return {
    childExecutionId: ids.childExecutionId,
    childConversationId: ids.childConversationId,
    childTurnId: ids.childTurnId,
    answerBridgeId: ids.answerBridgeId,
    childAgentId: command.childAgentId,
    completionPolicy: command.completionPolicy,
    waitDeadlineAt: command.waitDeadlineAt ?? null,
    title: command.title,
    leaseOwnerId: command.leaseOwnerId,
    leaseExpiresAt: command.leaseExpiresAt,
    prompt: command.prompt
  };
}

function spawnResult(
  ids: SpawnIds,
  completionPolicy: ChildCompletionPolicy,
  deduplicated: boolean,
  commitSeq?: string
): ChildExecutionSpawnResult {
  return {
    childExecutionId: ids.childExecutionId,
    childConversationId: ids.childConversationId,
    childTurnId: ids.childTurnId,
    answerBridgeId: ids.answerBridgeId,
    operationId: ids.operationId,
    attemptId: ids.attemptId,
    effectIntentId: ids.effectIntentId,
    completionPolicy,
    deduplicated,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function sendIds(command: ReturnType<typeof normalizeSendCommand>) {
  const scope = [command.childExecutionId, command.sourceKey, command.mode];
  return {
    commandReceiptId: stablePhaseFId('command_receipt', 'child-send', ...scope),
    turnIntentId: stablePhaseFId('turn_intent', 'child-send', ...scope),
    turnIntentRevisionId: stablePhaseFId('turn_intent_revision', 'child-send', ...scope),
    presetRevisionId: stablePhaseFId('turn_execution_preset_revision', 'child-send', ...scope),
    intentLinkId: stablePhaseFId('child_execution_intent_link', 'child-send', ...scope),
    pendingTurnInputId: stablePhaseFId('pending_turn_input', 'child-send', ...scope)
  };
}

function sendResult(
  command: ReturnType<typeof normalizeSendCommand>,
  ids: ReturnType<typeof sendIds>,
  deduplicated: boolean,
  commitSeq?: string
): ChildExecutionSendResult {
  return {
    childExecutionId: command.childExecutionId,
    turnIntentId: ids.turnIntentId,
    intentLinkId: ids.intentLinkId,
    pendingTurnInputId: ids.pendingTurnInputId,
    mode: command.mode,
    deduplicated,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function admissionIds(command: ReturnType<typeof normalizeAdmissionCommand>) {
  const scope = [command.childExecutionId, command.turnIntentId];
  return {
    commandReceiptId: stablePhaseFId('command_receipt', 'child-admit', command.sourceKey, ...scope),
    turnId: stablePhaseFId('turn', 'child-continuation', ...scope),
    leaseId: stablePhaseFId('execution_lease', 'child-continuation', ...scope),
    authoritySnapshotId: stablePhaseFId('authority_snapshot', 'child-continuation', ...scope),
    executorLinkId: stablePhaseFId('turn_executor_link', 'child-continuation', ...scope),
    pendingTurnInputId: stablePhaseFId('pending_turn_input', 'child-continuation', ...scope),
    turnLinkId: stablePhaseFId('child_execution_turn_link', 'child-continuation', ...scope)
  };
}

function terminalChildTurnSteps(
  facts: Awaited<ReturnType<ChildExecutionControlPlane['reconcileSpawnReceipt']>> extends never ? never : any,
  observed: EffectObservedOutcome,
  now: string
): RepositoryTransactionStep[] {
  if (!facts.childTurn || facts.childTurn.status !== ACTIVE_TURN) return [];
  const status = observed === 'cancelled' ? 'cancelled' : observed === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
  return [
    DOMAIN_REPOSITORIES.domain('Turn').assert(facts.childTurn.id as string, { status: ACTIVE_TURN }),
    ...(facts.childLease
      ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').deleteByUnique({ turn_id: facts.childTurn.id })]
      : []),
    DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
      id: stablePhaseFId('turn_termination', 'spawn-failure', facts.childTurn.id),
      turn_id: facts.childTurn.id,
      terminal_status: status,
      reason: `subagent spawn settled as ${observed}`,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('Turn').update(facts.childTurn.id as string, {
      status: TERMINATED_TURN,
      updated_at: now,
      terminal_at: now
    }),
    ...(facts.activeLink
      ? [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(facts.activeLink.id as string)]
      : [])
  ];
}

function childControlHandle(child: DomainRow, bridge: DomainRow) {
  return {
    childExecutionId: child.id,
    childConversationId: child.child_conversation_id,
    answerBridgeId: bridge.id,
    state: child.status
  };
}

function completionPolicyFromRequest(value: unknown): ChildCompletionPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subagent_spawn request payload is invalid.');
  }
  return requireCompletionPolicy((value as Record<string, unknown>).completionPolicy);
}

function requireCompletionPolicy(value: unknown): ChildCompletionPolicy {
  if (value !== 'wait_for_answer' && value !== 'background') {
    throw new TypeError('completionPolicy must be wait_for_answer or background.');
  }
  return value;
}

function requireSendMode(value: unknown): ChildSendMode {
  if (value !== 'queue_next_turn' && value !== 'interrupt_current_turn') {
    throw new TypeError('ChildExecution send mode must be queue_next_turn or interrupt_current_turn.');
  }
  return value;
}

function requireSpawnObservedOutcome(value: unknown): EffectObservedOutcome {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Unsupported subagent spawn receipt outcome: ${String(value)}.`);
  }
  return value as EffectObservedOutcome;
}

function observedToToolOutcome(value: EffectObservedOutcome): ToolOutcomeStatus {
  return value;
}

function uniquePrepared(values: PreparedContentObject[]): PreparedContentObject[] {
  return [...new Map(values.map((value) => [value.metadata.id, value])).values()];
}

function allocatedValue(
  allocated: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>,
  domain: string,
  id: string,
  column: string
): string {
  const row = allocated.find((entry) => entry.domain === domain && entry.id === id && entry.column === column);
  if (!row) throw new Error(`Missing allocated ${domain}.${column} for ${id}.`);
  return row.value;
}

function isExpectedSpawnIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'child_execution_parent_link.source_tool_call_id',
    'child_execution.id',
    'conversation.id',
    'command_receipt.source_kind, command_receipt.source_key'
  ]);
}

function isExpectedSendIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'turn_intent.id',
    'child_execution_intent_link.turn_intent_id'
  ]);
}

function isExpectedAdmissionIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'turn.id',
    'child_execution_turn_link.turn_id'
  ]) || isTransactionAssertionFailure(error);
}

function isExpectedCancelIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'pending_turn_input.id'
  ]) || isTransactionAssertionFailure(error);
}

function isExpectedSettlementRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'tool_outcome.tool_call_id',
    'tool_model_result.tool_call_id',
    'tool_model_result.message_revision_id',
    'command_receipt.source_kind, command_receipt.source_key'
  ]);
}

function executionWaitComplete(snapshot: ChildExecutionSnapshot): boolean {
  return snapshot.currentSubmission !== null
    || TERMINAL_CHILD_STATES.has(String(snapshot.childExecution.status))
    || snapshot.activeTurn === null
    || snapshot.activeTurn.status === TERMINATED_TURN;
}

function compareBigInt(left: unknown, right: unknown): number {
  const a = typeof left === 'bigint' ? left : BigInt(String(left));
  const b = typeof right === 'bigint' ? right : BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

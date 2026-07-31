import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { canonicalPlainJson as canonicalJson } from './plainJson';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export type PhaseDSourceKind = 'command' | 'callback' | 'internal' | 'recovery';
export type PhaseDEffectKind =
  | 'file_mutation'
  | 'process_start'
  | 'process_exit'
  | 'process_stop_request'
  | 'subagent_spawn'
  | 'subagent_cancel'
  | 'mcp_tool_call';
export type EffectObservedOutcome = 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown';
export type ToolOutcomeStatus =
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'outcome_unknown';

export interface PhaseDCommandSource {
  kind: PhaseDSourceKind;
  key: string;
}

export interface CreatedToolCall {
  receiptId: string;
  toolCallId: string;
  toolExecutionId: string;
  callSeq: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface PreparedEffectIntent {
  receiptId: string;
  toolCallId: string;
  toolExecutionId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  effectKind: PhaseDEffectKind;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface RecordedEffectReceipt {
  receiptId: string;
  effectReceiptId: string;
  attemptId: string;
  deduplicated: boolean;
  lateAfterTerminal: boolean;
  commitSeq?: string;
}

export interface ToolTerminalResult {
  /** Present only when the caller has a real persisted CommandReceipt for this replay. */
  receiptId?: string;
  toolCallId: string;
  toolOutcomeId: string;
  toolModelResultId: string;
  messageId: string;
  messageRevisionId: string;
  status: ToolOutcomeStatus;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ToolSettlementResult {
  receiptId: string;
  toolCallId: string;
  status: ToolOutcomeStatus;
  deduplicated: boolean;
  commitSeq?: string;
  terminal?: ToolTerminalResult;
  toolOutcomeId?: string;
  toolModelResultId?: string;
  messageId?: string;
  messageRevisionId?: string;
}

export interface ToolTerminalPlan extends ToolTerminalResult {
  receiptId: string;
  steps: RepositoryTransactionStep[];
}

export interface OperationCompletion {
  source: PhaseDCommandSource;
  effectReceiptId: string;
  outcome: Exclude<ToolOutcomeStatus, 'rejected'>;
  additionalSteps?: RepositoryTransactionStep[];
}

export class ToolCallOrderBlockedError extends Error {
  public constructor(public readonly toolCallId: string, public readonly predecessorCallSeq: string) {
    super(`ToolCall ${toolCallId} must wait for earlier call_seq ${predecessorCallSeq}.`);
    this.name = 'ToolCallOrderBlockedError';
  }
}

export interface PhaseDDiagnostic {
  kind: 'effect-receipt-deduplicated';
  attemptId: string;
  existingOutcome: string;
  incomingOutcome: string;
  sourceKind: PhaseDSourceKind;
  sourceKey: string;
}

interface ToolFacts {
  toolCall: DomainRow;
  execution: DomainRow;
  turn: DomainRow;
  lease: DomainRow;
  conversation: DomainRow;
}

interface CommandCommit {
  receipt: DomainRow;
  deduplicated: boolean;
  commitSeq?: string;
  allocatedSequences: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>;
}

const ACTIVE_TURN = 'active';
const TERMINAL_TURN = 'terminated';
const EFFECT_KINDS: readonly PhaseDEffectKind[] = [
  'file_mutation',
  'process_start',
  'process_exit',
  'process_stop_request',
  'subagent_spawn',
  'subagent_cancel',
  'mcp_tool_call'
];
const TERMINAL_OPERATION_STATUSES: readonly ToolOutcomeStatus[] = [
  'succeeded',
  'failed',
  'partial',
  'rejected',
  'cancelled',
  'conflict',
  'outcome_unknown'
];

/**
 * Phase D Tool/Effect control plane. SQLite facts are the lifecycle authority; dispatchers only run
 * after claimEffectDispatch() commits and report observations through recordEffectReceipt().
 */
export class EffectControlPlane {
  private readonly now: () => string;
  private readonly onDiagnostic: (diagnostic: PhaseDDiagnostic) => void;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string; onDiagnostic?: (diagnostic: PhaseDDiagnostic) => void } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onDiagnostic = options.onDiagnostic ?? ((diagnostic) => {
      console.warn('[reliable-kernel]', JSON.stringify(diagnostic));
    });
  }

  public async createToolCall(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    turnId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<CreatedToolCall> {
    const source = normalizeSource(input.source, ['callback', 'internal'], 'tool-call-create');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const turnId = requireId(input.turnId, 'turnId');
    const toolName = requireText(input.toolName, 'toolName');
    const executionId = stablePhaseDId('tool_execution', toolCallId);
    const scope = JSON.stringify([toolCallId, turnId, toolName]);
    const receiptId = sourceReceiptId(source, 'tool-call-create', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayToolCall(duplicate, receiptId, toolCallId, executionId);

    const turnContext = await this.requireActiveTurnContext(turnId);
    const argumentsContent = await this.contentStore.prepare(
      this.database,
      canonicalJson(input.arguments),
      'application/vnd.limcode.tool-arguments+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: turnContext.conversation.id as string,
      turnId,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(turnContext.lease.id as string, {
          conversation_id: turnContext.conversation.id,
          turn_id: turnId
        }),
        ...preparedContentSteps([argumentsContent], 'tool_args'),
        DOMAIN_REPOSITORIES.domain('ToolCall').insertWithNextSequence({
          id: toolCallId,
          turn_id: turnId,
          tool_name: toolName,
          status: 'pending',
          arguments_object_id: argumentsContent.metadata.id,
          created_at: now,
          updated_at: now
        }, {
          column: 'call_seq',
          scope: { turn_id: turnId }
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').insert({
          id: executionId,
          tool_call_id: toolCallId,
          status: 'pending',
          wait_deadline_at: null,
          started_at: now,
          updated_at: now,
          completed_at: null
        })
      ]
    });
    if (committed.deduplicated) return this.replayToolCall(committed.receipt, receiptId, toolCallId, executionId);
    return {
      receiptId,
      toolCallId,
      toolExecutionId: executionId,
      callSeq: allocatedValue(committed, 'ToolCall', toolCallId, 'call_seq'),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /** Operation, Attempt and EffectIntent are inserted in this one SQLite transaction. */
  public async prepareEffectIntent(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    effectKind: PhaseDEffectKind;
    request: unknown;
    owner?: { kind: 'tool_execution' | 'file_change_set' | 'process'; id: string };
  }): Promise<PreparedEffectIntent> {
    const source = normalizeSource(input.source, ['internal'], 'effect-intent-create');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const effectKind = requireEffectKind(input.effectKind);
    const facts = await this.requireToolFacts(toolCallId, true);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot create an EffectIntent from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const owner = input.owner ?? { kind: 'tool_execution' as const, id: facts.execution.id as string };
    requireId(owner.id, 'effect owner id');
    const ids = effectIds(toolCallId, owner.kind, owner.id, effectKind);
    const scope = JSON.stringify([toolCallId, owner.kind, owner.id, effectKind]);
    const receiptId = sourceReceiptId(source, 'effect-intent-create', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayPreparedEffect(duplicate, receiptId, ids, toolCallId, effectKind);
    const requestContent = await this.contentStore.prepare(
      this.database,
      canonicalJson(input.request),
      `application/vnd.limcode.effect-${effectKind}+json`
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([requestContent], 'effect_request'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: ids.operationId,
          owner_kind: owner.kind,
          owner_id: owner.id,
          tool_call_id: toolCallId,
          status: 'pending',
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: owner.kind, owner_id: owner.id }
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
          effect_kind: effectKind,
          dispatch_state: 'pending',
          request_object_id: requestContent.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'executing', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'executing',
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      return this.replayPreparedEffect(committed.receipt, receiptId, ids, toolCallId, effectKind);
    }
    return {
      receiptId,
      toolCallId,
      toolExecutionId: facts.execution.id as string,
      ...ids,
      effectKind,
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /**
   * Claims the pending intent by committing dispatch_state=dispatched before any external capability
   * is invoked. false means this intent was already claimed/observed and must not be dispatched again.
   */
  public async claimEffectDispatch(effectIntentIdInput: string): Promise<boolean> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const state = requireText(intent.dispatch_state, 'EffectIntent.dispatch_state');
    if (state !== 'pending') return false;
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (attempt.status !== 'pending' || operation.status !== 'pending') {
      throw new Error(`EffectIntent ${effectIntentId} parent Attempt/Operation is no longer dispatchable.`);
    }
    const toolFacts = operation.tool_call_id === null
      ? null
      : await this.requireToolFacts(requireId(operation.tool_call_id, 'Operation.tool_call_id'), true);
    if (toolFacts && (toolFacts.toolCall.status !== 'executing' || toolFacts.execution.status !== 'executing')) {
      throw new Error(`EffectIntent ${effectIntentId} belongs to a ToolCall that is no longer executing.`);
    }
    const now = this.timestamp();
    const assertions: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('EffectIntent').assert(effectIntentId, { dispatch_state: 'pending' }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'pending' })
    ];
    if (toolFacts) {
      assertions.push(
        DOMAIN_REPOSITORIES.domain('Turn').assert(toolFacts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(toolFacts.lease.id as string, {
          conversation_id: toolFacts.conversation.id,
          turn_id: toolFacts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolFacts.toolCall.id as string, { status: 'executing' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(toolFacts.execution.id as string, { status: 'executing' })
      );
    }
    try {
      await this.database.transaction([
        ...assertions,
        DOMAIN_REPOSITORIES.domain('EffectIntent').update(effectIntentId, {
          dispatch_state: 'dispatched',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
          status: 'dispatched',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status: 'executing',
          updated_at: now
        })
      ]);
      return true;
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.requireExisting('EffectIntent', effectIntentId);
      if (latest.dispatch_state === 'pending') throw error;
      return false;
    }
  }

  public async readEffectRequest<T = unknown>(effectIntentIdInput: string): Promise<T> {
    const intent = await this.requireExisting('EffectIntent', requireId(effectIntentIdInput, 'effectIntentId'));
    const metadata = await this.requireContentObject(requireId(intent.request_object_id, 'EffectIntent.request_object_id'));
    return JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as T;
  }

  /** Receipt writes do not require or assert an ExecutionLease. */
  public async recordEffectReceipt(input: {
    source: PhaseDCommandSource;
    attemptId: string;
    effectKind: PhaseDEffectKind;
    outcome: EffectObservedOutcome;
    detail?: unknown;
  }): Promise<RecordedEffectReceipt> {
    const source = normalizeSource(input.source, ['callback', 'recovery'], 'effect-receipt-write');
    const attemptId = requireId(input.attemptId, 'attemptId');
    const effectKind = requireEffectKind(input.effectKind);
    const outcome = requireObservedOutcome(input.outcome);
    const intentRows = await this.list('EffectIntent', { attempt_id: attemptId }, 2);
    if (intentRows.length !== 1) throw new Error(`Attempt ${attemptId} must have exactly one EffectIntent.`);
    const intent = intentRows[0];
    if (intent.effect_kind !== effectKind) throw new Error('EffectReceipt kind does not match EffectIntent.');
    if (intent.dispatch_state === 'pending') throw new Error('EffectReceipt cannot be written before dispatch is committed.');
    const attempt = await this.requireExisting('Attempt', attemptId);
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = operation.tool_call_id === null ? null : requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = toolCallId ? await this.requireExisting('ToolCall', toolCallId) : null;
    const turn = toolCall ? await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id')) : null;
    const receiptId = stablePhaseDId('effect_receipt', attemptId);
    const sourceReceipt = sourceReceiptId(source, 'effect-receipt-write', JSON.stringify([attemptId, effectKind]));
    const duplicateSource = await this.findSourceReceipt(source);
    if (duplicateSource) {
      assertSourceReceipt(duplicateSource, sourceReceipt, 'effect-receipt-write');
      const existing = await this.requireExisting('EffectReceipt', receiptId);
      this.logDeduplicatedReceipt(existing, outcome, source);
      return this.effectReceiptResult(existing, duplicateSource, true, toolCall);
    }
    const existingRows = await this.list('EffectReceipt', { attempt_id: attemptId }, 2);
    if (existingRows.length > 0) {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        steps: []
      });
      this.logDeduplicatedReceipt(existingRows[0], outcome, source);
      return this.effectReceiptResult(existingRows[0], committed.receipt, true, toolCall);
    }
    const detail = input.detail === undefined
      ? undefined
      : await this.contentStore.prepare(
          this.database,
          canonicalJson(input.detail),
          `application/vnd.limcode.effect-${effectKind}-receipt+json`
        );
    const now = this.timestamp();
    try {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        steps: [
          ...(detail ? preparedContentSteps([detail], 'effect_receipt') : []),
          DOMAIN_REPOSITORIES.domain('EffectReceipt').insert({
            id: receiptId,
            attempt_id: attemptId,
            effect_kind: effectKind,
            outcome,
            response_object_id: detail?.metadata.id ?? null,
            conversation_id: turn?.conversation_id ?? null,
            tool_call_id: toolCallId,
            operation_id: operation.id,
            received_at: now
          }),
          DOMAIN_REPOSITORIES.domain('EffectIntent').update(intent.id as string, {
            dispatch_state: 'receipt_written',
            updated_at: now
          })
        ]
      });
      if (committed.deduplicated) {
        const existing = await this.requireExisting('EffectReceipt', receiptId);
        return this.effectReceiptResult(existing, committed.receipt, true, toolCall);
      }
      const written = await this.requireExisting('EffectReceipt', receiptId);
      return this.effectReceiptResult(written, committed.receipt, false, toolCall, committed.commitSeq);
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['effect_receipt', ['id']],
        ['effect_receipt', ['attempt_id']],
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']]
      ])) throw error;
      const raced = (await this.list('EffectReceipt', { attempt_id: attemptId }, 1))[0];
      if (!raced) throw error;
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        steps: []
      });
      this.logDeduplicatedReceipt(raced, outcome, source);
      return this.effectReceiptResult(raced, committed.receipt, true, toolCall, committed.commitSeq);
    }
  }

  /**
   * Converts an observed receipt into Attempt/Operation domain status. Tool finalization is then
   * assembled in stable call_seq order; EffectReceipt itself never decides the ToolOutcome.
   */
  public async completeOperation(input: OperationCompletion): Promise<ToolTerminalResult | null> {
    const source = normalizeSource(input.source, ['internal', 'recovery'], 'effect-reconcile');
    const effectReceipt = await this.requireExisting('EffectReceipt', requireId(input.effectReceiptId, 'effectReceiptId'));
    const attempt = await this.requireExisting('Attempt', requireId(effectReceipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const turn = await this.requireExisting('Turn', turnId);
    const sourceReceipt = sourceReceiptId(source, 'effect-reconcile', JSON.stringify([effectReceipt.id, input.outcome]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, sourceReceipt, 'effect-reconcile');
      const replay = await this.readTerminalResult(toolCallId, true, duplicate.id as string);
      if (replay) return replay;
      const finalized = await this.finalizeReadyInOrder(turnId);
      return finalized.find((entry) => entry.toolCallId === toolCallId)
        ?? await this.readTerminalResult(toolCallId, true, duplicate.id as string);
    }
    const existingOutcome = await this.findToolOutcome(toolCallId);
    if (existingOutcome || turn.status === TERMINAL_TURN) {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn.conversation_id as string,
        turnId,
        steps: []
      });
      return existingOutcome
        ? this.readTerminalResult(toolCallId, true, committed.receipt.id as string)
        : null;
    }
    requireOperationOutcome(input.outcome);
    const facts = await this.requireToolFacts(toolCallId, true);
    const now = this.timestamp();
    const operationAlreadyTerminal = isTerminalOperationStatus(operation.status);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
        conversation_id: facts.conversation.id,
        turn_id: turnId
      })
    ];
    if (!operationAlreadyTerminal) {
      steps.push(
        DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: attempt.status }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: operation.status }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
          status: input.outcome,
          updated_at: now,
          completed_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status: input.outcome,
          updated_at: now
        })
      );
    }
    if (input.additionalSteps) steps.push(...input.additionalSteps);
    try {
      await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: facts.conversation.id as string,
        turnId,
        steps
      });
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latestOperation = await this.requireExisting('Operation', operation.id as string);
      if (!isTerminalOperationStatus(latestOperation.status)) throw error;
      await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: facts.conversation.id as string,
        turnId,
        steps: []
      });
    }
    const finalized = await this.finalizeReadyInOrder(turnId);
    return finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.readTerminalResult(toolCallId, false, sourceReceipt);
  }

  /** Completes a Process-owned observation Operation that intentionally has no ToolCall result. */
  public async completeDetachedOperation(input: {
    source: PhaseDCommandSource;
    effectReceiptId: string;
    outcome: Exclude<ToolOutcomeStatus, 'rejected'>;
    additionalSteps: RepositoryTransactionStep[];
  }): Promise<{ receiptId: string; deduplicated: boolean; commitSeq?: string }> {
    const source = normalizeSource(input.source, ['internal', 'recovery'], 'detached-effect-reconcile');
    const effectReceipt = await this.requireExisting('EffectReceipt', requireId(input.effectReceiptId, 'effectReceiptId'));
    const attempt = await this.requireExisting('Attempt', requireId(effectReceipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.tool_call_id !== null) throw new Error('Detached Effect Operation must not reference a ToolCall.');
    requireOperationOutcome(input.outcome);
    const receiptId = sourceReceiptId(source, 'detached-effect-reconcile', JSON.stringify([effectReceipt.id, input.outcome]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'detached-effect-reconcile');
      return { receiptId: duplicate.id as string, deduplicated: true };
    }
    if (isTerminalOperationStatus(operation.status)) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        steps: []
      });
      return { receiptId: committed.receipt.id as string, deduplicated: committed.deduplicated, commitSeq: committed.commitSeq };
    }
    const now = this.timestamp();
    try {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        steps: [
          DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: attempt.status }),
          DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: operation.status }),
          DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
            status: input.outcome,
            updated_at: now,
            completed_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
            status: input.outcome,
            updated_at: now
          }),
          ...input.additionalSteps
        ]
      });
      return { receiptId: committed.receipt.id as string, deduplicated: committed.deduplicated, commitSeq: committed.commitSeq };
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.requireExisting('Operation', operation.id as string);
      if (!isTerminalOperationStatus(latest.status)) throw error;
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        steps: []
      });
      return { receiptId: committed.receipt.id as string, deduplicated: true, commitSeq: committed.commitSeq };
    }
  }

  /** Persists an internal no-external-effect completion before ordered model-result assembly. */
  public async settleWithoutEffect(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    status: ToolOutcomeStatus;
    detail: unknown;
  }): Promise<ToolSettlementResult> {
    const source = normalizeSource(input.source, ['internal'], 'tool-settle-without-effect');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const status = requireToolOutcome(input.status);
    const scope = JSON.stringify([toolCallId, status]);
    const receiptId = sourceReceiptId(source, 'tool-settle-without-effect', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'tool-settle-without-effect');
      const facts = await this.requireToolFacts(toolCallId, false);
      await this.finalizeReadyInOrder(facts.turn.id as string);
      return this.settlementResult(
        duplicate.id as string,
        toolCallId,
        status,
        true,
        await this.readTerminalResult(toolCallId, true, duplicate.id as string) ?? undefined
      );
    }

    const facts = await this.requireToolFacts(toolCallId, true);
    const existingTerminal = await this.readTerminalResult(toolCallId, true);
    if (existingTerminal) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        steps: []
      });
      return this.settlementResult(
        committed.receipt.id as string,
        toolCallId,
        existingTerminal.status,
        committed.deduplicated,
        { ...existingTerminal, receiptId: committed.receipt.id as string }
      );
    }

    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.some((operation) => !isTerminalOperationStatus(operation.status))) {
      throw new Error(`ToolCall ${toolCallId} has a non-terminal Operation and cannot use no-effect settlement.`);
    }
    const now = this.timestamp();
    let steps: RepositoryTransactionStep[] = [];
    if (operations.length === 0) {
      if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
        throw new Error(`ToolCall ${toolCallId} cannot persist a no-effect result from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
      }
      if ((await this.list('FileChangeSet', { tool_call_id: toolCallId }, 1)).length > 0) {
        throw new Error(`ToolCall ${toolCallId} has a FileChangeSet and cannot bypass its decision path.`);
      }
      const content = await this.contentStore.prepare(
        this.database,
        canonicalJson({ toolCallId, status, detail: input.detail }),
        'application/vnd.limcode.tool-result-artifact+json'
      );
      const operationId = stablePhaseDId('operation', `no-effect:${toolCallId}`);
      const artifactId = stablePhaseDId('tool_result_artifact', `no-effect:${toolCallId}`);
      steps = [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([content], 'tool_result_artifact'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: operationId,
          owner_kind: 'tool_execution',
          owner_id: facts.execution.id,
          tool_call_id: toolCallId,
          status,
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: facts.execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
          id: artifactId,
          tool_call_id: toolCallId,
          role: 'no_effect_result',
          content_object_id: content.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'executing', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'executing',
          updated_at: now
        })
      ];
    }

    let committed: CommandCommit;
    try {
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        steps
      });
    } catch (error) {
      const expectedUnique = matchesExpectedUnique(error, [
        ['operation', ['id']],
        ['operation', ['owner_kind', 'owner_id', 'operation_seq']],
        ['tool_result_artifact', ['id']],
        ['tool_result_artifact', ['tool_call_id', 'role']]
      ]);
      if (!expectedUnique && !isTransactionAssertionError(error)) throw error;
      const latestOperations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
      const latestArtifacts = await this.list('ToolResultArtifact', {
        tool_call_id: toolCallId,
        role: 'no_effect_result'
      }, 2);
      if (
        latestOperations.length !== 1
        || !isTerminalOperationStatus(latestOperations[0].status)
        || latestArtifacts.length !== 1
      ) throw error;
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        steps: []
      });
    }
    const finalized = await this.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.readTerminalResult(toolCallId, committed.deduplicated, committed.receipt.id as string);
    return this.settlementResult(
      committed.receipt.id as string,
      toolCallId,
      terminal?.status ?? status,
      committed.deduplicated,
      terminal ? { ...terminal, receiptId: committed.receipt.id as string } : undefined,
      committed.commitSeq
    );
  }

  /** Used by File decisions/recovery to commit decision + terminal result atomically. */
  public async prepareTerminalPlan(
    toolCallIdInput: string,
    statusInput: ToolOutcomeStatus,
    detail: unknown,
    receiptId = stablePhaseDId('command_receipt', `tool-finalize:${toolCallIdInput}`),
    plannedPredecessors: ReadonlySet<string> = new Set(),
    options: { requireLease?: boolean } = {}
  ): Promise<ToolTerminalPlan> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const status = requireToolOutcome(statusInput);
    const existing = await this.readTerminalResult(toolCallId, true, receiptId);
    if (existing) return { ...existing, receiptId, steps: [] };
    const requireLease = options.requireLease !== false;
    const facts = await this.requireToolFacts(toolCallId, requireLease);
    await this.assertCallIsNextForModelResult(facts.toolCall, plannedPredecessors);
    const now = this.timestamp();
    const content = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, status, detail }),
      'application/vnd.limcode.tool-model-result+json'
    );
    const ids = terminalIds(toolCallId);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
      ...(requireLease ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
        conversation_id: facts.conversation.id,
        turn_id: facts.turn.id
      })] : []),
      ...preparedContentSteps([content], 'tool_result'),
      DOMAIN_REPOSITORIES.domain('ToolOutcome').insert({
        id: ids.toolOutcomeId,
        tool_call_id: toolCallId,
        status,
        content_object_id: content.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Message').insert({
        id: ids.messageId,
        created_at: now,
        updated_at: now,
        deleted_at: null
      }),
      DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: ids.messageRevisionId,
        message_id: ids.messageId,
        revision_seq: '1',
        role: 'tool',
        content_object_id: content.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: ids.currentRevisionLinkId,
        message_id: ids.messageId,
        revision_id: ids.messageRevisionId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
        id: ids.messageConversationLinkId,
        conversation_id: facts.conversation.id,
        message_id: ids.messageId,
        created_at: now
      }, {
        column: 'message_seq',
        scope: { conversation_id: facts.conversation.id }
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
        id: ids.messageTurnLinkId,
        turn_id: facts.turn.id,
        message_id: ids.messageId,
        role: 'tool_result',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({
        id: ids.toolModelResultId,
        tool_call_id: toolCallId,
        message_revision_id: ids.messageRevisionId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'terminal', updated_at: now }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
        status: 'completed',
        updated_at: now,
        completed_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(facts.conversation.id as string, { updated_at: now })
    ];
    return {
      receiptId,
      toolCallId,
      ...ids,
      status,
      deduplicated: false,
      steps
    };
  }

  public async finalizeReadyInOrder(turnIdInput: string): Promise<ToolTerminalResult[]> {
    const turnId = requireId(turnIdInput, 'turnId');
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== ACTIVE_TURN) return [];
    const calls = (await listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId }))
      .sort((left, right) => compareBigInt(left.call_seq, right.call_seq));
    const finalized: ToolTerminalResult[] = [];
    for (const call of calls) {
      const toolCallId = call.id as string;
      const existing = await this.readTerminalResult(toolCallId, true);
      if (existing) continue;
      const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
      const ready = await this.readReadyToolOutcome(toolCallId, operations);
      if (!ready) break;
      const { status, detail } = ready;
      const source: PhaseDCommandSource = { kind: 'internal', key: `tool-finalize:${toolCallId}` };
      const receiptId = sourceReceiptId(source, 'tool-finalize', toolCallId);
      const plan = await this.prepareTerminalPlan(toolCallId, status, detail, receiptId);
      const facts = await this.requireToolFacts(toolCallId, true);
      try {
        const committed = await this.commitSource({
          source,
          receiptId,
          conversationId: facts.conversation.id as string,
          turnId,
          steps: plan.steps
        });
        if (committed.deduplicated) {
          const replay = await this.readTerminalResult(toolCallId, true, committed.receipt.id as string);
          if (replay) finalized.push(replay);
        } else {
          finalized.push({
            ...withoutSteps(plan),
            receiptId: committed.receipt.id as string,
            deduplicated: false,
            commitSeq: committed.commitSeq
          });
        }
      } catch (error) {
        if (!matchesExpectedUnique(error, [
          ['tool_outcome', ['id']],
          ['tool_outcome', ['tool_call_id']],
          ['tool_model_result', ['id']],
          ['tool_model_result', ['tool_call_id']],
          ['tool_model_result', ['message_revision_id']],
          ['command_receipt', ['id']],
          ['command_receipt', ['source_kind', 'source_key']]
        ])) throw error;
        const raced = await this.readTerminalResult(toolCallId, true);
        if (!raced) throw error;
        finalized.push(raced);
      }
    }
    return finalized;
  }

  public async readTerminalResult(
    toolCallIdInput: string,
    deduplicated: boolean,
    receiptId?: string
  ): Promise<ToolTerminalResult | null> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const outcome = await this.findToolOutcome(toolCallId);
    if (!outcome) return null;
    const modelRows = await this.list('ToolModelResult', { tool_call_id: toolCallId }, 2);
    if (modelRows.length !== 1) throw new Error(`Terminal ToolCall ${toolCallId} must have exactly one ToolModelResult.`);
    const model = modelRows[0];
    const revision = await this.requireExisting('MessageRevision', requireId(model.message_revision_id, 'ToolModelResult.message_revision_id'));
    const ids = terminalIds(toolCallId);
    if (
      outcome.id !== ids.toolOutcomeId
      || model.id !== ids.toolModelResultId
      || revision.id !== ids.messageRevisionId
      || revision.message_id !== ids.messageId
    ) throw new Error(`ToolCall ${toolCallId} terminal identity is inconsistent.`);
    return {
      ...(receiptId ? { receiptId: requireId(receiptId, 'CommandReceipt.id') } : {}),
      toolCallId,
      ...ids,
      status: requireToolOutcome(outcome.status),
      deduplicated
    };
  }

  private settlementResult(
    receiptId: string,
    toolCallId: string,
    status: ToolOutcomeStatus,
    deduplicated: boolean,
    terminal?: ToolTerminalResult,
    commitSeq?: string
  ): ToolSettlementResult {
    return {
      receiptId,
      toolCallId,
      status,
      deduplicated,
      ...(commitSeq ? { commitSeq } : {}),
      ...(terminal ? {
        terminal,
        toolOutcomeId: terminal.toolOutcomeId,
        toolModelResultId: terminal.toolModelResultId,
        messageId: terminal.messageId,
        messageRevisionId: terminal.messageRevisionId
      } : {})
    };
  }

  private async replayToolCall(
    receipt: DomainRow,
    expectedReceiptId: string,
    toolCallId: string,
    executionId: string
  ): Promise<CreatedToolCall> {
    assertSourceReceipt(receipt, expectedReceiptId, 'tool-call-create');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const execution = await this.requireExisting('ToolExecution', executionId);
    if (execution.tool_call_id !== toolCallId) throw new Error('Stable ToolExecution belongs to another ToolCall.');
    return {
      receiptId: receipt.id as string,
      toolCallId,
      toolExecutionId: executionId,
      callSeq: requireBigInt(toolCall.call_seq, 'ToolCall.call_seq').toString(),
      deduplicated: true
    };
  }

  private async replayPreparedEffect(
    receipt: DomainRow,
    expectedReceiptId: string,
    ids: ReturnType<typeof effectIds>,
    toolCallId: string,
    effectKind: PhaseDEffectKind
  ): Promise<PreparedEffectIntent> {
    assertSourceReceipt(receipt, expectedReceiptId, 'effect-intent-create');
    const intent = await this.requireExisting('EffectIntent', ids.effectIntentId);
    const attempt = await this.requireExisting('Attempt', ids.attemptId);
    const operation = await this.requireExisting('Operation', ids.operationId);
    if (
      intent.attempt_id !== ids.attemptId
      || intent.effect_kind !== effectKind
      || attempt.operation_id !== ids.operationId
      || operation.tool_call_id !== toolCallId
    ) throw new Error('Stable EffectIntent result facts do not match the source operation.');
    const executionRows = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executionRows.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one ToolExecution.`);
    return {
      receiptId: receipt.id as string,
      toolCallId,
      toolExecutionId: executionRows[0].id as string,
      ...ids,
      effectKind,
      deduplicated: true
    };
  }

  private logDeduplicatedReceipt(
    existing: DomainRow,
    incomingOutcome: EffectObservedOutcome,
    source: PhaseDCommandSource
  ): void {
    this.onDiagnostic({
      kind: 'effect-receipt-deduplicated',
      attemptId: requireId(existing.attempt_id, 'EffectReceipt.attempt_id'),
      existingOutcome: requireText(existing.outcome, 'EffectReceipt.outcome'),
      incomingOutcome,
      sourceKind: source.kind,
      sourceKey: source.key
    });
  }

  private effectReceiptResult(
    effectReceipt: DomainRow,
    sourceReceipt: DomainRow,
    deduplicated: boolean,
    toolCall: DomainRow | null,
    commitSeq?: string
  ): RecordedEffectReceipt {
    return {
      receiptId: sourceReceipt.id as string,
      effectReceiptId: effectReceipt.id as string,
      attemptId: effectReceipt.attempt_id as string,
      deduplicated,
      lateAfterTerminal: toolCall?.status === 'terminal',
      ...(commitSeq ? { commitSeq } : {})
    };
  }

  private async requireToolFacts(toolCallId: string, requireLease: boolean): Promise<ToolFacts> {
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1) throw new Error(`ToolCall ${toolCallId} must have exactly one ToolExecution.`);
    const turn = await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    const conversation = await this.requireExisting('Conversation', requireId(turn.conversation_id, 'Turn.conversation_id'));
    const leases = await this.list('ExecutionLease', { turn_id: turn.id }, 2);
    if (requireLease && (turn.status !== ACTIVE_TURN || leases.length !== 1)) {
      throw new Error(`ToolCall ${toolCallId} cannot write terminal facts without its active Turn ExecutionLease.`);
    }
    return {
      toolCall,
      execution: executions[0],
      turn,
      lease: leases[0] ?? {},
      conversation
    };
  }

  private async requireActiveTurnContext(turnId: string): Promise<{ turn: DomainRow; lease: DomainRow; conversation: DomainRow }> {
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== ACTIVE_TURN) throw new Error(`Turn ${turnId} is not active.`);
    const leases = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leases.length !== 1) throw new Error(`Turn ${turnId} must have exactly one ExecutionLease.`);
    const conversation = await this.requireExisting('Conversation', requireId(turn.conversation_id, 'Turn.conversation_id'));
    return { turn, lease: leases[0], conversation };
  }

  private async assertCallIsNextForModelResult(
    toolCall: DomainRow,
    plannedPredecessors: ReadonlySet<string>
  ): Promise<void> {
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    const calls = (await listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId }))
      .sort((left, right) => compareBigInt(left.call_seq, right.call_seq));
    for (const candidate of calls) {
      const candidateSeq = requireBigInt(candidate.call_seq, 'ToolCall.call_seq');
      if (candidateSeq >= callSeq) break;
      const candidateId = requireId(candidate.id, 'ToolCall.id');
      if (!plannedPredecessors.has(candidateId) && !await this.findToolOutcome(candidateId)) {
        throw new ToolCallOrderBlockedError(toolCall.id as string, candidateSeq.toString());
      }
    }
  }

  private async findToolOutcome(toolCallId: string): Promise<DomainRow | undefined> {
    return (await this.list('ToolOutcome', { tool_call_id: toolCallId }, 2))[0];
  }

  private async readReadyToolOutcome(
    toolCallId: string,
    operations: DomainRow[]
  ): Promise<{ status: ToolOutcomeStatus; detail: unknown } | null> {
    if (operations.length > 0) {
      if (operations.some((operation) => !isTerminalOperationStatus(operation.status))) return null;
      const artifacts = await this.list('ToolResultArtifact', {
        tool_call_id: toolCallId,
        role: 'no_effect_result'
      }, 2);
      if (artifacts.length > 0) {
        if (artifacts.length !== 1 || operations.length !== 1) {
          throw new Error(`ToolCall ${toolCallId} no-effect result facts are not one-to-one.`);
        }
        const metadata = await this.requireContentObject(
          requireId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
        );
        const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
        const status = requireToolOutcome(body.status);
        if (body.toolCallId !== toolCallId || status !== operations[0].status) {
          throw new Error(`ToolCall ${toolCallId} no-effect result artifact is inconsistent.`);
        }
        return { status, detail: body.detail };
      }
      return {
        status: aggregateOperationOutcomes(operations.map((operation) => operation.status as ToolOutcomeStatus)),
        detail: {
          operations: await Promise.all(operations
            .sort((left, right) => compareBigInt(left.operation_seq, right.operation_seq))
            .map(async (operation) => ({
              operationId: operation.id,
              operationSeq: requireBigInt(operation.operation_seq, 'Operation.operation_seq').toString(),
              status: operation.status,
              ...(await this.readOperationObservation(operation))
            })))
        }
      };
    }
    const changeSets = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
    if (changeSets.length !== 1) return null;
    const decisions = await this.list('FileChangeDecision', { change_set_id: changeSets[0].id }, 2);
    if (decisions.length !== 1) return null;
    const decision = String(decisions[0].decision);
    if (decision !== 'rejected' && decision !== 'expired') return null;
    return {
      status: decision === 'rejected' ? 'rejected' : 'cancelled',
      detail: { changeSetId: changeSets[0].id, decision }
    };
  }

  private async readOperationObservation(operation: DomainRow): Promise<{
    effectReceiptId?: string;
    detail?: unknown;
  }> {
    const attempts = (await listAllDomainRows(this.database, 'Attempt', {
      operation_id: operation.id
    })).sort((left, right) => compareBigInt(left.attempt_seq, right.attempt_seq));
    const attempt = attempts[attempts.length - 1];
    if (attempt) {
      const receipts = await this.list('EffectReceipt', { attempt_id: attempt.id }, 2);
      const receipt = receipts[0];
      if (receipt) {
        if (receipt.response_object_id === null) return { effectReceiptId: receipt.id as string };
        const metadata = await this.requireContentObject(
          requireId(receipt.response_object_id, 'EffectReceipt.response_object_id')
        );
        return {
          effectReceiptId: receipt.id as string,
          detail: JSON.parse((await this.contentStore.read(metadata)).toString('utf8'))
        };
      }
    }
    const pauses = await this.list('OutcomePause', { operation_id: operation.id }, 2);
    if (pauses.length !== 1) return {};
    const resolutions = await this.list('OperationResolution', { pause_id: pauses[0].id }, 2);
    if (resolutions.length !== 1 || resolutions[0].content_object_id === null) return {};
    const metadata = await this.requireContentObject(
      requireId(resolutions[0].content_object_id, 'OperationResolution.content_object_id')
    );
    return { detail: JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) };
  }

  private async commitSource(options: {
    source: PhaseDCommandSource;
    receiptId: string;
    conversationId: string | null;
    turnId: string | null;
    steps: RepositoryTransactionStep[];
  }): Promise<CommandCommit> {
    const existing = await this.findSourceReceipt(options.source);
    if (existing) {
      assertSourceReceipt(existing, options.receiptId, 'Phase D command');
      return { receipt: existing, deduplicated: true, allocatedSequences: [] };
    }
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: options.conversationId === null
        ? null
        : requireId(options.conversationId, 'CommandReceipt.conversation_id'),
      turn_id: options.turnId === null ? null : requireId(options.turnId, 'CommandReceipt.turn_id'),
      created_at: this.timestamp()
    };
    try {
      const result = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return {
        receipt,
        deduplicated: false,
        commitSeq: requireDecimalString(result.commitSeq, 'commitSeq'),
        allocatedSequences: result.allocatedSequences.map((entry) => ({
          ...entry,
          value: requireDecimalString(entry.value, `${entry.domain}.${entry.column}`)
        }))
      };
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']]
      ])) throw error;
      const raced = await this.findSourceReceipt(options.source);
      if (!raced) throw error;
      assertSourceReceipt(raced, options.receiptId, 'Phase D command');
      return { receipt: raced, deduplicated: true, allocatedSequences: [] };
    }
  }

  private async findSourceReceipt(source: PhaseDCommandSource): Promise<DomainRow | undefined> {
    return (await this.list('CommandReceipt', {
      source_kind: source.kind,
      source_key: source.key
    }, 2))[0];
  }

  private async requireContentObject(id: string): Promise<ContentObjectMetadata> {
    return await this.requireExisting('ContentObject', id) as ContentObjectMetadata;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = result.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const result = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const value = result.snapshot[0];
    if (!Array.isArray(value)) throw new TypeError(`${domain} list did not return rows.`);
    return value;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

export function stablePhaseDId(kind: string, scope: string): string {
  const normalizedKind = requireText(kind, 'stable id kind').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const digest = createHash('sha256')
    .update('limcode-phase-d-entity\0')
    .update(normalizedKind)
    .update('\0')
    .update(requireText(scope, 'stable id scope'))
    .digest('hex');
  return `${normalizedKind}_${digest}`;
}

export function preparedContentSteps(
  prepared: readonly PreparedContentObject[],
  prefix: string
): RepositoryTransactionStep[] {
  const unique = new Map(prepared.map((entry) => [entry.metadata.id, entry]));
  const steps: RepositoryTransactionStep[] = [];
  let index = 0;
  for (const content of unique.values()) {
    if (content.insert) {
      steps.push(savepoint(`${safeSavepointPrefix(prefix)}_${index++}`, [content.insert], {
        kind: 'rollback-and-continue-on-unique',
        constraints: [
          { domain: 'ContentObject', columns: ['id'] },
          { domain: 'ContentObject', columns: ['content_type', 'sha256', 'byte_length'] }
        ]
      }));
    }
    steps.push(DOMAIN_REPOSITORIES.domain('ContentObject').assert(content.metadata.id, {
      content_type: content.metadata.content_type,
      sha256: content.metadata.sha256,
      byte_length: content.metadata.byte_length,
      storage_key: content.metadata.storage_key
    }));
  }
  return steps;
}

export function effectIds(
  toolCallId: string,
  ownerKind: string,
  ownerId: string,
  effectKind: PhaseDEffectKind
): { operationId: string; attemptId: string; effectIntentId: string } {
  const scope = JSON.stringify([toolCallId, ownerKind, ownerId, effectKind]);
  const operationId = stablePhaseDId('operation', scope);
  const attemptId = stablePhaseDId('attempt', `${operationId}:1`);
  return {
    operationId,
    attemptId,
    effectIntentId: stablePhaseDId('effect_intent', attemptId)
  };
}

function terminalIds(toolCallId: string): {
  toolOutcomeId: string;
  toolModelResultId: string;
  messageId: string;
  messageRevisionId: string;
  currentRevisionLinkId: string;
  messageConversationLinkId: string;
  messageTurnLinkId: string;
} {
  return {
    toolOutcomeId: stablePhaseDId('tool_outcome', toolCallId),
    toolModelResultId: stablePhaseDId('tool_model_result', toolCallId),
    messageId: stablePhaseDId('message', `tool-result:${toolCallId}`),
    messageRevisionId: stablePhaseDId('message_revision', `tool-result:${toolCallId}`),
    currentRevisionLinkId: stablePhaseDId('message_current_revision_link', `tool-result:${toolCallId}`),
    messageConversationLinkId: stablePhaseDId('message_conversation_link', `tool-result:${toolCallId}`),
    messageTurnLinkId: stablePhaseDId('message_turn_link', `tool-result:${toolCallId}`)
  };
}

function aggregateOperationOutcomes(statuses: ToolOutcomeStatus[]): ToolOutcomeStatus {
  if (statuses.includes('conflict')) return 'conflict';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('outcome_unknown')) return 'outcome_unknown';
  if (statuses.includes('partial')) return 'partial';
  if (statuses.includes('cancelled')) return 'cancelled';
  return 'succeeded';
}

function normalizeSource(
  source: PhaseDCommandSource,
  allowed: readonly PhaseDSourceKind[],
  operation: string
): PhaseDCommandSource {
  if (!source || !allowed.includes(source.kind)) {
    throw new TypeError(`${operation} source kind must be one of: ${allowed.join(', ')}.`);
  }
  return { kind: source.kind, key: requireText(source.key, `${operation} source key`) };
}

function sourceReceiptId(source: PhaseDCommandSource, operation: string, scope: string): string {
  return stablePhaseDId('command_receipt', JSON.stringify([source.kind, source.key, operation, scope]));
}

function assertSourceReceipt(receipt: DomainRow, expectedId: string, operation: string): void {
  if (receipt.id !== expectedId) {
    throw new Error(`CommandReceipt (${String(receipt.source_kind)},${String(receipt.source_key)}) does not contain ${operation} result facts.`);
  }
}

function withoutSteps(plan: ToolTerminalPlan): ToolTerminalResult {
  const { steps: _steps, ...result } = plan;
  return result;
}

function allocatedValue(
  commit: CommandCommit,
  domain: string,
  id: string,
  column: string
): string {
  const entry = commit.allocatedSequences.find((candidate) =>
    candidate.domain === domain && candidate.id === id && candidate.column === column
  );
  if (!entry) throw new Error(`${domain} ${id} did not allocate ${column}.`);
  return requireDecimalString(entry.value, `${domain}.${column}`);
}

function requireEffectKind(value: PhaseDEffectKind): PhaseDEffectKind {
  if (!EFFECT_KINDS.includes(value)) throw new TypeError(`Unsupported Effect kind: ${String(value)}`);
  return value;
}

function requireObservedOutcome(value: EffectObservedOutcome): EffectObservedOutcome {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(value)) {
    throw new TypeError(`Unsupported EffectReceipt outcome: ${String(value)}`);
  }
  return value;
}

function requireOperationOutcome(value: ToolOutcomeStatus): ToolOutcomeStatus {
  if (!TERMINAL_OPERATION_STATUSES.includes(value) || value === 'rejected') {
    throw new TypeError(`Unsupported Operation outcome: ${String(value)}`);
  }
  return value;
}

function requireToolOutcome(value: unknown): ToolOutcomeStatus {
  if (typeof value !== 'string' || !TERMINAL_OPERATION_STATUSES.includes(value as ToolOutcomeStatus)) {
    throw new TypeError(`Unsupported ToolOutcome status: ${String(value)}`);
  }
  return value as ToolOutcomeStatus;
}

function isTerminalOperationStatus(value: unknown): value is ToolOutcomeStatus {
  return typeof value === 'string' && TERMINAL_OPERATION_STATUSES.includes(value as ToolOutcomeStatus);
}

export function matchesExpectedUnique(
  error: unknown,
  expected: ReadonlyArray<readonly [table: string, columns: readonly string[]]>
): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message
    .slice(index + marker.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return expected.some(([table, columns]) => {
    const wanted = columns.map((column) => `${table}.${column}`).sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function safeSavepointPrefix(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40);
  return normalized || 'content';
}

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = requireBigInt(left, 'sequence');
  const rightValue = requireBigInt(right, 'sequence');
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string on the wire.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

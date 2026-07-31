import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  judgeTurnRecovery,
  type TurnRecoveryFacts,
  type TurnRecoveryJudgment
} from './turnRecovery';

export const DEFAULT_AGENT_CONVERSATION_ROLE = 'default';

const TURN_STATUS_ACTIVE = 'active';
const TURN_STATUS_TERMINATED = 'terminated';
const TURN_INTENT_STATE_QUEUED = 'queued';
const TURN_INTENT_STATE_ADMITTED = 'admitted';
const CONTENT_TYPE_INTENT = 'application/vnd.limcode.turn-intent+json';
const CONTENT_TYPE_PRESET = 'application/vnd.limcode.turn-execution-preset+json';
const CONTENT_TYPE_AUTHORITY = 'application/vnd.limcode.turn-authority-snapshot+json';
const CONTENT_TYPE_INTERRUPT = 'application/vnd.limcode.turn-interrupt-request+json';

export type TurnCommandSourceKind = 'command' | 'callback' | 'internal' | 'recovery';
export type TurnCommandOperation = 'input' | 'edit' | 'delete' | 'retry' | 'interrupt' | 'continuation' | 'terminal';
export type TurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'outcome_unknown';
export type TurnCommandContent = string | Uint8Array;

export interface TurnCommandSource {
  kind: TurnCommandSourceKind;
  key: string;
}

export interface TurnInitiatingSource extends TurnCommandSource {
  kind: 'command' | 'internal';
}

export interface TurnTerminalSource extends TurnCommandSource {
  kind: 'callback' | 'internal' | 'recovery';
}

export interface TurnAuthorityCompilationRequest {
  conversationId: string;
  turnId: string;
  executorAgentId: string;
  intentKind: 'input' | 'retry' | 'continuation';
  sourceTurnId?: string;
}

export interface CompiledTurnAuthorityContent {
  content: TurnCommandContent;
  contentType?: string;
}

/** Produced by the configuration-authority side, not by a user command payload. */
export interface CompiledTurnAuthority {
  turnId: string;
  executorAgentId: string;
  executionPreset: CompiledTurnAuthorityContent;
  authoritySnapshot: CompiledTurnAuthorityContent;
}

export interface TurnAuthorityCompiler {
  compile(request: TurnAuthorityCompilationRequest): Promise<CompiledTurnAuthority>;
}

export interface TurnExecutionCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  leaseOwnerId: string;
  hostBootId: string;
  leaseExpiresAt: string;
}

export interface TurnInputCommand extends TurnExecutionCommand {
  content: TurnCommandContent;
  contentType?: string;
}

export interface TurnRetryCommand extends TurnExecutionCommand {
  sourceTurnId: string;
}

export interface TurnContinuationCommand extends TurnExecutionCommand {
  sourceTurnId: string;
  content: TurnCommandContent;
  contentType?: string;
}

export interface TurnEditCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  messageId: string;
  content: TurnCommandContent;
  contentType?: string;
}

export interface TurnDeleteCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  messageId: string;
}

export interface TurnInterruptCommand {
  source: TurnInitiatingSource;
  turnId: string;
  reason: string;
}

export interface TurnTerminalCommand {
  source: TurnTerminalSource;
  turnId: string;
  terminalStatus: TurnTerminalStatus;
  reason: string;
}

export interface ConversationForkSource {
  sourceConversationId: string;
  sourceTurnId: string;
  sourceMessageId: string;
  sourceMessageRevisionId: string;
  sourceContextRootId: string;
}

export interface ValidatedConversationForkSource extends ConversationForkSource {
  messageRevisionSeq: string;
  contextRootSeq: string;
}

export interface TurnCommandResult {
  receiptId: string;
  deduplicated: boolean;
  commitSeq?: string;
  conversationId?: string;
  intentId?: string;
  turnId?: string;
  admitted?: boolean;
  messageId?: string;
  messageRevisionId?: string;
  messageRevisionSeq?: string;
  pendingTurnInputId?: string;
  pendingTurnInputPosition?: string;
  terminalRecorded?: boolean;
  ignoredBecauseTerminal?: boolean;
}

export interface TurnUnresolvedFileClosure {
  prepareUnresolvedTurnClosure(
    turnId: string,
    options?: { requireLease?: boolean }
  ): Promise<RepositoryTransactionStep[]>;
}

export interface TurnControlPlaneOptions {
  authorityCompiler: TurnAuthorityCompiler;
  unresolvedFileClosure?: TurnUnresolvedFileClosure;
  now?: () => string;
}

interface StartIntentPlan {
  command: TurnExecutionCommand;
  operation: 'input' | 'retry' | 'continuation';
  sourceTurnId?: string;
  messageContent?: TurnCommandContent;
  messageContentType?: string;
}

interface StartCommandIds {
  receipt: string;
  intent: string;
  intentRevision: string;
  presetRevision: string;
  turn: string;
  lease: string;
  authoritySnapshot: string;
  executorLink: string;
  message?: string;
  messageRevision?: string;
  currentRevisionLink?: string;
  membership?: string;
  messageTurnLink?: string;
}

interface CommandCommit {
  receipt: DomainRow;
  deduplicated: boolean;
  commitSeq?: string;
  changes: ReadonlyArray<{ domain: string; kind: 'upsert' | 'remove'; id: string }>;
  allocatedSequences: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>;
}

/** Phase C command facade. SQLite transactions are the only lifecycle serialization authority. */
export class TurnControlPlane {
  private readonly now: () => string;
  private readonly authorityCompiler: TurnAuthorityCompiler;
  private readonly unresolvedFileClosure?: TurnUnresolvedFileClosure;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: TurnControlPlaneOptions
  ) {
    if (!options?.authorityCompiler || typeof options.authorityCompiler.compile !== 'function') {
      throw new TypeError('TurnControlPlane requires a server-side TurnAuthorityCompiler.');
    }
    this.authorityCompiler = options.authorityCompiler;
    this.unresolvedFileClosure = options.unresolvedFileClosure;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public input(command: TurnInputCommand): Promise<TurnCommandResult> {
    return this.startIntent({
      command,
      operation: 'input',
      messageContent: command.content,
      messageContentType: command.contentType ?? 'text/plain'
    });
  }

  public retry(command: TurnRetryCommand): Promise<TurnCommandResult> {
    return this.startIntent({
      command,
      operation: 'retry',
      sourceTurnId: command.sourceTurnId
    });
  }

  public continuation(command: TurnContinuationCommand): Promise<TurnCommandResult> {
    return this.startIntent({
      command,
      operation: 'continuation',
      sourceTurnId: command.sourceTurnId,
      messageContent: command.content,
      messageContentType: command.contentType ?? 'text/plain'
    });
  }

  public edit(command: TurnEditCommand): Promise<TurnCommandResult> {
    return this.editMessage(command);
  }

  public delete(command: TurnDeleteCommand): Promise<TurnCommandResult> {
    return this.softDeleteMessage(command);
  }

  public interrupt(command: TurnInterruptCommand): Promise<TurnCommandResult> {
    return this.requestInterrupt(command);
  }

  public terminal(command: TurnTerminalCommand): Promise<TurnCommandResult> {
    return this.recordTerminal(command);
  }

  /** Finalize-only recovery for the identity.json active/no-lease orphan combination. */
  public async finalizeRecovery(command: TurnTerminalCommand): Promise<TurnCommandResult> {
    const source = normalizeTerminalSource(command.source);
    if (source.kind !== 'recovery') throw new TypeError('Turn recovery finalization requires recovery source kind.');
    const turnId = requireId(command.turnId, 'turnId');
    const reason = requireText(command.reason, 'reason');
    requireTerminalStatus(command.terminalStatus);
    const facts = await this.recoveryFacts(turnId);
    if (facts.judgment !== 'finalize') {
      throw new Error(`Turn ${turnId} recovery judgment is ${facts.judgment}, not finalize.`);
    }
    const turn = await this.getTurn(turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const terminationId = commandEntityId(source, 'terminal', 'turn_termination', turnId);
    const receiptId = commandEntityId(source, 'terminal', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayTerminalResult(duplicate, receiptId, turnId, terminationId);
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return {
        receiptId: committed.receipt.id as string,
        deduplicated: committed.deduplicated,
        commitSeq: committed.commitSeq,
        conversationId,
        turnId,
        terminalRecorded: false,
        ignoredBecauseTerminal: true
      };
    }
    const unresolvedFileSteps = this.unresolvedFileClosure
      ? await this.unresolvedFileClosure.prepareUnresolvedTurnClosure(turnId, { requireLease: false })
      : [];
    const now = this.timestamp();
    const committed = await this.commitWithReceipt({
      source,
      receiptId,
      conversationId,
      turnId,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
        ...unresolvedFileSteps,
        DOMAIN_REPOSITORIES.domain('ToolCall').assertAll({ turn_id: turnId }, { status: 'terminal' }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
          id: terminationId,
          turn_id: turnId,
          terminal_status: command.terminalStatus,
          reason,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').update(turnId, {
          status: TURN_STATUS_TERMINATED,
          updated_at: now,
          terminal_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    return {
      receiptId: committed.receipt.id as string,
      deduplicated: committed.deduplicated,
      commitSeq: committed.commitSeq,
      conversationId,
      turnId,
      terminalRecorded: true
    };
  }

  public async recoveryFacts(turnId: string): Promise<TurnRecoveryFacts & { judgment: TurnRecoveryJudgment }> {
    const id = requireId(turnId, 'turnId');
    const turns = DOMAIN_REPOSITORIES.domain('Turn');
    const leases = DOMAIN_REPOSITORIES.domain('ExecutionLease');
    const inputs = DOMAIN_REPOSITORIES.domain('PendingTurnInput');
    const terminations = DOMAIN_REPOSITORIES.domain('TurnTermination');
    const snapshot = await this.database.snapshot([
      turns.get(id),
      leases.list({ where: { turn_id: id }, limit: 1 }),
      inputs.list({ where: { turn_id: id }, limit: 1 }),
      terminations.list({ where: { turn_id: id }, limit: 1 })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${id}`);
    const status = requireText(turn.status, `Turn ${id}.status`);
    if (status !== TURN_STATUS_ACTIVE && status !== TURN_STATUS_TERMINATED) {
      throw new Error(`Turn ${id} has unsupported recovery status ${status}.`);
    }
    const facts: TurnRecoveryFacts = {
      turnStatus: status,
      executionLeaseExists: rows(snapshot.snapshot[1]).length > 0,
      pendingTurnInputExists: rows(snapshot.snapshot[2]).length > 0,
      turnTerminationExists: rows(snapshot.snapshot[3]).length > 0
    };
    return { ...facts, judgment: judgeTurnRecovery(facts) };
  }

  /** Phase C validates stable source facts only; target fork writes belong to Phase E/F. */
  public async validateForkSource(sourceInput: ConversationForkSource): Promise<ValidatedConversationForkSource> {
    const source = normalizeForkSource(sourceInput);
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(source.sourceTurnId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(source.sourceMessageRevisionId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(source.sourceContextRootId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: source.sourceConversationId, message_id: source.sourceMessageId },
        limit: 1
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({
        where: { turn_id: source.sourceTurnId, message_id: source.sourceMessageId },
        limit: 10
      })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${source.sourceTurnId}`);
    const revision = requireRow(snapshot.snapshot[1], `MessageRevision ${source.sourceMessageRevisionId}`);
    const contextRoot = requireRow(snapshot.snapshot[2], `ContextSequenceRoot ${source.sourceContextRootId}`);
    if (turn.conversation_id !== source.sourceConversationId) {
      throw new Error('Fork source Turn does not belong to the source Conversation.');
    }
    if (revision.message_id !== source.sourceMessageId) {
      throw new Error('Fork source MessageRevision does not belong to the source Message.');
    }
    if (contextRoot.conversation_id !== source.sourceConversationId) {
      throw new Error('Fork source Context root does not belong to the source Conversation.');
    }
    if (rows(snapshot.snapshot[3]).length !== 1) {
      throw new Error('Fork source Message is not a member of the source Conversation.');
    }
    if (rows(snapshot.snapshot[4]).length === 0) {
      throw new Error('Fork source Message is not linked to the source Turn.');
    }
    return {
      ...source,
      messageRevisionSeq: requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq').toString(),
      contextRootSeq: requireBigInt(contextRoot.root_seq, 'ContextSequenceRoot.root_seq').toString()
    };
  }

  private async startIntent(plan: StartIntentPlan): Promise<TurnCommandResult> {
    const command = normalizeExecutionCommand(plan.command, plan.operation);
    const source = normalizeInitiatingSource(command.source, plan.operation);
    const commandScope = JSON.stringify([command.conversationId, plan.sourceTurnId ?? null]);
    const ids = startCommandIds(source, plan.operation, plan.messageContent !== undefined, commandScope);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayStartResult(duplicate, ids, plan.operation, command.conversationId);

    const conversation = await this.getConversation(command.conversationId);
    if (plan.sourceTurnId) {
      const sourceTurnId = requireId(plan.sourceTurnId, 'sourceTurnId');
      const sourceTurn = await this.getTurn(sourceTurnId);
      if (sourceTurn.conversation_id !== conversation.id) {
        throw new Error(`Source Turn ${sourceTurnId} does not belong to Conversation ${conversation.id}.`);
      }
    }
    const defaultAgent = await this.getDefaultAgent(conversation.id as string);
    const compiled = normalizeCompiledAuthority(await this.authorityCompiler.compile({
      conversationId: conversation.id as string,
      turnId: ids.turn,
      executorAgentId: defaultAgent.agent_id as string,
      intentKind: plan.operation,
      ...(plan.sourceTurnId ? { sourceTurnId: requireId(plan.sourceTurnId, 'sourceTurnId') } : {})
    }), ids.turn, defaultAgent.agent_id as string);
    const now = this.timestamp();

    const messageContent = plan.messageContent === undefined
      ? undefined
      : await this.contentStore.prepare(
        this.database,
        plan.messageContent,
        requireContentType(plan.messageContentType ?? 'text/plain')
      );
    const intentContent = plan.operation === 'input'
      ? requirePrepared(messageContent, 'input message content')
      : await this.contentStore.prepare(
        this.database,
        JSON.stringify({
          kind: plan.operation,
          sourceTurnId: requireId(plan.sourceTurnId, 'sourceTurnId'),
          ...(messageContent ? { messageContentObjectId: messageContent.metadata.id } : {})
        }),
        CONTENT_TYPE_INTENT
      );
    const presetContent = await this.contentStore.prepare(
      this.database,
      compiled.executionPreset.content,
      compiled.executionPreset.contentType
    );
    const authorityContent = await this.contentStore.prepare(
      this.database,
      compiled.authoritySnapshot.content,
      compiled.authoritySnapshot.contentType
    );

    const admission: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.turn,
        conversation_id: conversation.id,
        status: TURN_STATUS_ACTIVE,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.lease,
        conversation_id: conversation.id,
        turn_id: ids.turn,
        owner_id: command.leaseOwnerId,
        host_boot_id: command.hostBootId,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      ...preparedContentSteps([authorityContent], 'authority'),
      DOMAIN_REPOSITORIES.domain('TurnIntent').update(ids.intent, {
        turn_id: ids.turn,
        state: TURN_INTENT_STATE_ADMITTED,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.authoritySnapshot,
        turn_id: ids.turn,
        content_object_id: authorityContent.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.executorLink,
        turn_id: ids.turn,
        agent_id: defaultAgent.agent_id,
        created_at: now
      })
    ];
    if (messageContent) admission.push(...messageAdmissionSteps(ids, messageContent, conversation.id as string, now));

    const commit = await this.commitWithReceipt({
      source,
      receiptId: ids.receipt,
      conversationId: conversation.id as string,
      turnId: null,
      steps: [
        ...preparedContentSteps([
          intentContent,
          presetContent,
          ...(messageContent ? [messageContent] : [])
        ], 'intent_content'),
        DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
          id: ids.intent,
          conversation_id: conversation.id,
          turn_id: null,
          state: TURN_INTENT_STATE_QUEUED,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
          id: ids.intentRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          content_object_id: intentContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
          id: ids.presetRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          preset_object_id: presetContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversation.id as string, { updated_at: now }),
        savepoint('admit_turn_intent', admission, {
          kind: 'rollback-and-continue-on-unique',
          constraints: [{ domain: 'ExecutionLease', columns: ['conversation_id'] }]
        })
      ]
    });
    if (commit.deduplicated) return this.replayStartResult(commit.receipt, ids, plan.operation, command.conversationId);
    return this.readStartResult(commit, ids, command.conversationId);
  }

  private async editMessage(commandInput: TurnEditCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'edit');
    const conversationId = requireId(commandInput.conversationId, 'conversationId');
    const messageId = requireId(commandInput.messageId, 'messageId');
    const commandScope = JSON.stringify([conversationId, messageId]);
    const revisionId = commandEntityId(source, 'edit', 'message_revision', commandScope);
    const receiptId = commandEntityId(source, 'edit', 'command_receipt', commandScope);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayEditResult(duplicate, receiptId, conversationId, messageId, revisionId);
    const relation = await this.getMessageRelation(conversationId, messageId);
    if (relation.message.deleted_at !== null) throw new Error(`Message ${messageId} is soft-deleted.`);
    const now = this.timestamp();
    const content = await this.contentStore.prepare(
      this.database,
      commandInput.content,
      requireContentType(commandInput.contentType ?? 'text/plain')
    );
    const commit = await this.commitWithReceipt({
      source,
      receiptId,
      conversationId,
      turnId: null,
      steps: [
        DOMAIN_REPOSITORIES.domain('Message').assert(messageId, { deleted_at: null }),
        ...preparedContentSteps([content], 'edit_content'),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: revisionId,
          message_id: messageId,
          role: relation.currentRevision.role,
          content_object_id: content.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: messageId }
        }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(relation.currentLink.id as string, {
          revision_id: revisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Message').update(messageId, { updated_at: now }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    if (commit.deduplicated) return this.replayEditResult(commit.receipt, receiptId, conversationId, messageId, revisionId);
    const sequence = allocatedValue(commit, 'MessageRevision', revisionId, 'revision_seq');
    return {
      receiptId: commit.receipt.id as string,
      deduplicated: false,
      commitSeq: commit.commitSeq,
      conversationId,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: sequence
    };
  }

  private async softDeleteMessage(commandInput: TurnDeleteCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'delete');
    const conversationId = requireId(commandInput.conversationId, 'conversationId');
    const messageId = requireId(commandInput.messageId, 'messageId');
    const receiptId = commandEntityId(source, 'delete', 'command_receipt', JSON.stringify([conversationId, messageId]));
    const duplicate = await this.findReceipt(source);
    if (duplicate) {
      assertReceiptIdentity(duplicate, receiptId, 'delete');
      return basicDuplicateResult(duplicate, receiptId, 'delete', { conversationId, messageId });
    }
    const relation = await this.getMessageRelation(conversationId, messageId);
    const now = this.timestamp();
    if (relation.message.deleted_at !== null) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId: null, steps: [] });
      return committed.deduplicated
        ? basicDuplicateResult(committed.receipt, receiptId, 'delete', { conversationId, messageId })
        : basicCommittedResult(committed, { conversationId, messageId });
    }
    try {
      const committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          DOMAIN_REPOSITORIES.domain('Message').assert(messageId, { deleted_at: null }),
          DOMAIN_REPOSITORIES.domain('Message').update(messageId, { deleted_at: now, updated_at: now }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      return committed.deduplicated
        ? basicDuplicateResult(committed.receipt, receiptId, 'delete', { conversationId, messageId })
        : basicCommittedResult(committed, { conversationId, messageId });
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.getMessage(messageId);
      if (latest.deleted_at === null) throw error;
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId: null, steps: [] });
      return committed.deduplicated
        ? basicDuplicateResult(committed.receipt, receiptId, 'delete', { conversationId, messageId })
        : basicCommittedResult(committed, { conversationId, messageId });
    }
  }

  private async requestInterrupt(commandInput: TurnInterruptCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'interrupt');
    const turnId = requireId(commandInput.turnId, 'turnId');
    const reason = requireText(commandInput.reason, 'reason');
    const pendingTurnInputId = commandEntityId(source, 'interrupt', 'pending_turn_input', turnId);
    const receiptId = commandEntityId(source, 'interrupt', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayInterruptResult(duplicate, receiptId, turnId, pendingTurnInputId);
    const turn = await this.getTurn(turnId);
    const conversationId = turn.conversation_id as string;
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          ignoredBecauseTerminal: true
        };
    }
    requireActiveTurn(turn, turnId);
    const now = this.timestamp();
    const content = await this.contentStore.prepare(
      this.database,
      JSON.stringify({ kind: 'interrupt-request', reason }),
      CONTENT_TYPE_INTERRUPT
    );
    try {
      const committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId,
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
          ...preparedContentSteps([content], 'interrupt_content'),
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
            id: pendingTurnInputId,
            turn_id: turnId,
            input_kind: 'interrupt_request',
            content_object_id: content.metadata.id,
            state: 'pending',
            created_at: now,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (committed.deduplicated) {
        return this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId);
      }
      return {
        receiptId: committed.receipt.id as string,
        deduplicated: false,
        commitSeq: committed.commitSeq,
        conversationId,
        turnId,
        pendingTurnInputId,
        pendingTurnInputPosition: allocatedValue(
          committed,
          'PendingTurnInput',
          pendingTurnInputId,
          'position'
        )
      };
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.getTurn(turnId);
      if (latest.status !== TURN_STATUS_TERMINATED) throw error;
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          ignoredBecauseTerminal: true
        };
    }
  }

  private async recordTerminal(commandInput: TurnTerminalCommand): Promise<TurnCommandResult> {
    const source = normalizeTerminalSource(commandInput.source);
    const turnId = requireId(commandInput.turnId, 'turnId');
    const reason = requireText(commandInput.reason, 'reason');
    requireTerminalStatus(commandInput.terminalStatus);
    const terminationId = commandEntityId(source, 'terminal', 'turn_termination', turnId);
    const receiptId = commandEntityId(source, 'terminal', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayTerminalResult(duplicate, receiptId, turnId, terminationId);
    const turn = await this.getTurn(turnId);
    const conversationId = turn.conversation_id as string;
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: false,
          ignoredBecauseTerminal: true
        };
    }
    requireActiveTurn(turn, turnId);
    const now = this.timestamp();
    const unresolvedFileSteps = this.unresolvedFileClosure
      ? await this.unresolvedFileClosure.prepareUnresolvedTurnClosure(turnId)
      : [];
    try {
      const committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId,
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
          ...unresolvedFileSteps,
          // A terminal Turn may not strand a pending or in-flight ToolCall. This assertion runs
          // after the pending-file closure steps in the same writer transaction.
          DOMAIN_REPOSITORIES.domain('ToolCall').assertAll({ turn_id: turnId }, { status: 'terminal' }),
          DOMAIN_REPOSITORIES.domain('ExecutionLease').deleteByUnique({ conversation_id: conversationId, turn_id: turnId }),
          DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
            id: terminationId,
            turn_id: turnId,
            terminal_status: commandInput.terminalStatus,
            reason,
            created_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Turn').update(turnId, {
            status: TURN_STATUS_TERMINATED,
            updated_at: now,
            terminal_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: true
        };
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.getTurn(turnId);
      if (latest.status !== TURN_STATUS_TERMINATED) throw error;
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: false,
          ignoredBecauseTerminal: true
        };
    }
  }

  private async commitWithReceipt(options: {
    source: TurnCommandSource;
    receiptId: string;
    conversationId: string;
    turnId: string | null;
    steps: RepositoryTransactionStep[];
  }): Promise<CommandCommit> {
    const existing = await this.findReceipt(options.source);
    if (existing) return deduplicatedCommit(existing);
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: requireId(options.conversationId, 'receipt conversationId'),
      turn_id: options.turnId === null ? null : requireId(options.turnId, 'receipt turnId'),
      created_at: this.timestamp()
    };
    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return {
        receipt,
        deduplicated: false,
        commitSeq: requireDecimalIntegerString(committed.commitSeq, 'commitSeq'),
        changes: committed.changes,
        allocatedSequences: committed.allocatedSequences.map((entry) => ({
          ...entry,
          value: requireDecimalIntegerString(entry.value, `${entry.domain}.${entry.column}`)
        }))
      };
    } catch (error) {
      const racedReceipt = await this.findReceipt(options.source);
      if (racedReceipt) return deduplicatedCommit(racedReceipt);
      throw error;
    }
  }

  private async replayStartResult(
    receipt: DomainRow,
    ids: StartCommandIds,
    operation: StartIntentPlan['operation'],
    conversationId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, ids.receipt, operation);
    if (receipt.conversation_id !== conversationId) throw sourceOperationMismatch(receipt, operation);
    const intent = await this.maybeGet('TurnIntent', ids.intent);
    if (!intent) throw sourceOperationMismatch(receipt, operation);
    const admitted = intent.state === TURN_INTENT_STATE_ADMITTED && typeof intent.turn_id === 'string';
    if (admitted && intent.turn_id !== ids.turn) {
      throw new Error(`TurnIntent ${ids.intent} is linked to an unexpected Turn.`);
    }
    if (admitted) {
      await this.requireExisting('Turn', ids.turn);
      if (ids.message) await this.requireExisting('Message', ids.message);
    }
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId,
      intentId: ids.intent,
      admitted,
      ...(admitted ? {
        turnId: ids.turn,
        ...(ids.message ? { messageId: ids.message, messageRevisionId: ids.messageRevision } : {})
      } : {})
    };
  }

  private async readStartResult(
    commit: CommandCommit,
    ids: StartCommandIds,
    conversationId: string
  ): Promise<TurnCommandResult> {
    const admitted = commit.changes.some((change) =>
      change.domain === 'Turn' && change.id === ids.turn && change.kind === 'upsert'
    );
    return {
      receiptId: commit.receipt.id as string,
      deduplicated: false,
      commitSeq: commit.commitSeq,
      conversationId,
      intentId: ids.intent,
      admitted,
      ...(admitted ? {
        turnId: ids.turn,
        ...(ids.message ? { messageId: ids.message, messageRevisionId: ids.messageRevision } : {})
      } : {})
    };
  }

  private async replayEditResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    conversationId: string,
    messageId: string,
    revisionId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'edit');
    if (receipt.conversation_id !== conversationId) throw sourceOperationMismatch(receipt, 'edit');
    const revision = await this.maybeGet('MessageRevision', revisionId);
    if (!revision || revision.message_id !== messageId) throw sourceOperationMismatch(receipt, 'edit');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq').toString()
    };
  }

  private async replayInterruptResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    turnId: string,
    pendingTurnInputId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'interrupt');
    if (receipt.turn_id !== turnId) throw sourceOperationMismatch(receipt, 'interrupt');
    const turn = await this.getTurn(turnId);
    const pending = await this.maybeGet('PendingTurnInput', pendingTurnInputId);
    if (pending) {
      return {
        receiptId: receipt.id as string,
        deduplicated: true,
        conversationId: turn.conversation_id as string,
        turnId,
        pendingTurnInputId,
        pendingTurnInputPosition: requireBigInt(pending.position, 'PendingTurnInput.position').toString()
      };
    }
    if (turn.status !== TURN_STATUS_TERMINATED) throw sourceOperationMismatch(receipt, 'interrupt');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId: turn.conversation_id as string,
      turnId,
      ignoredBecauseTerminal: true
    };
  }

  private async replayTerminalResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    turnId: string,
    terminationId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'terminal');
    if (receipt.turn_id !== turnId) throw sourceOperationMismatch(receipt, 'terminal');
    const turn = await this.getTurn(turnId);
    const termination = await this.maybeGet('TurnTermination', terminationId);
    if (turn.status !== TURN_STATUS_TERMINATED) throw sourceOperationMismatch(receipt, 'terminal');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId: turn.conversation_id as string,
      turnId,
      terminalRecorded: termination !== null,
      ...(termination ? {} : { ignoredBecauseTerminal: true })
    };
  }

  private async findReceipt(source: TurnCommandSource): Promise<DomainRow | undefined> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('CommandReceipt').list({
        where: { source_kind: source.kind, source_key: source.key },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0];
  }

  private async getConversation(conversationId: string): Promise<DomainRow> {
    return this.requireExisting('Conversation', requireId(conversationId, 'conversationId'));
  }

  private async getTurn(turnId: string): Promise<DomainRow> {
    return this.requireExisting('Turn', requireId(turnId, 'turnId'));
  }

  private async getMessage(messageId: string): Promise<DomainRow> {
    return this.requireExisting('Message', requireId(messageId, 'messageId'));
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async getDefaultAgent(conversationId: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').list({
        where: {
          conversation_id: requireId(conversationId, 'conversationId'),
          role: DEFAULT_AGENT_CONVERSATION_ROLE
        },
        limit: 2
      })
    ]);
    const links = rows(snapshot.snapshot[0]);
    if (links.length !== 1) {
      throw new Error(`Conversation ${conversationId} must have exactly one current default Agent link.`);
    }
    requireId(links[0].agent_id, 'AgentConversationLink.agent_id');
    return links[0];
  }

  private async getMessageRelation(conversationId: string, messageId: string): Promise<{
    message: DomainRow;
    membership: DomainRow;
    currentLink: DomainRow;
    currentRevision: DomainRow;
  }> {
    const first = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Message').get(messageId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({ where: { message_id: messageId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({ where: { message_id: messageId }, limit: 1 })
    ]);
    const message = requireRow(first.snapshot[0], `Message ${messageId}`);
    const membership = rows(first.snapshot[1])[0];
    if (!membership || membership.conversation_id !== conversationId) {
      throw new Error(`Message ${messageId} does not belong to Conversation ${conversationId}.`);
    }
    const currentLink = rows(first.snapshot[2])[0];
    if (!currentLink) throw new Error(`Message ${messageId} has no current revision link.`);
    const revisionId = requireId(currentLink.revision_id, 'MessageCurrentRevisionLink.revision_id');
    const currentRevision = await this.requireExisting('MessageRevision', revisionId);
    if (currentRevision.message_id !== messageId) {
      throw new Error(`Message ${messageId} current revision belongs to another Message.`);
    }
    return { message, membership, currentLink, currentRevision };
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function startCommandIds(
  source: TurnInitiatingSource,
  operation: StartIntentPlan['operation'],
  hasMessage: boolean,
  commandScope: string
): StartCommandIds {
  const id = (kind: string) => commandEntityId(source, operation, kind, commandScope);
  return {
    receipt: id('command_receipt'),
    intent: id('turn_intent'),
    intentRevision: id('turn_intent_revision'),
    presetRevision: id('turn_preset_revision'),
    turn: id('turn'),
    lease: id('execution_lease'),
    authoritySnapshot: id('authority_snapshot'),
    executorLink: id('turn_executor_link'),
    ...(hasMessage ? {
      message: id('message'),
      messageRevision: id('message_revision'),
      currentRevisionLink: id('message_current_revision_link'),
      membership: id('message_conversation_link'),
      messageTurnLink: id('message_turn_link')
    } : {})
  };
}

function messageAdmissionSteps(
  ids: StartCommandIds,
  messageContent: PreparedContentObject,
  conversationId: string,
  now: string
): RepositoryTransactionStep[] {
  const message = requireId(ids.message, 'message id');
  const revision = requireId(ids.messageRevision, 'message revision id');
  return [
    DOMAIN_REPOSITORIES.domain('Message').insert({ id: message, created_at: now, updated_at: now, deleted_at: null }),
    DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
      id: revision,
      message_id: message,
      revision_seq: '1',
      role: 'user',
      content_object_id: messageContent.metadata.id,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      id: requireId(ids.currentRevisionLink, 'current revision link id'),
      message_id: message,
      revision_id: revision,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
      id: requireId(ids.membership, 'message membership id'),
      conversation_id: conversationId,
      message_id: message,
      created_at: now
    }, {
      column: 'message_seq',
      scope: { conversation_id: conversationId }
    }),
    DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      id: requireId(ids.messageTurnLink, 'message Turn link id'),
      turn_id: ids.turn,
      message_id: message,
      role: 'input',
      created_at: now
    })
  ];
}

function preparedContentSteps(
  prepared: readonly PreparedContentObject[],
  savepointPrefix: string
): RepositoryTransactionStep[] {
  const unique = new Map(prepared.map((content) => [content.metadata.id, content]));
  const steps: RepositoryTransactionStep[] = [];
  let index = 0;
  for (const content of unique.values()) {
    if (content.insert) {
      steps.push(savepoint(`${savepointPrefix}_${index++}`, [content.insert], {
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

function normalizeExecutionCommand(
  command: TurnExecutionCommand,
  operation: StartIntentPlan['operation']
): TurnExecutionCommand {
  return {
    ...command,
    source: normalizeInitiatingSource(command.source, operation),
    conversationId: requireId(command.conversationId, 'conversationId'),
    leaseOwnerId: requireId(command.leaseOwnerId, 'leaseOwnerId'),
    hostBootId: requireId(command.hostBootId, 'hostBootId'),
    leaseExpiresAt: requireText(command.leaseExpiresAt, 'leaseExpiresAt')
  };
}

function normalizeCompiledAuthority(
  compiled: CompiledTurnAuthority,
  expectedTurnId: string,
  expectedExecutorAgentId: string
): Required<Pick<CompiledTurnAuthority, 'turnId' | 'executorAgentId'>> & {
  executionPreset: Required<CompiledTurnAuthorityContent>;
  authoritySnapshot: Required<CompiledTurnAuthorityContent>;
} {
  if (!compiled || typeof compiled !== 'object') throw new TypeError('TurnAuthorityCompiler returned no authority.');
  if (compiled.turnId !== expectedTurnId) throw new Error('Compiled authority is bound to another Turn.');
  if (compiled.executorAgentId !== expectedExecutorAgentId) throw new Error('Compiled authority is bound to another executor Agent.');
  return {
    turnId: compiled.turnId,
    executorAgentId: compiled.executorAgentId,
    executionPreset: normalizeCompiledContent(compiled.executionPreset, CONTENT_TYPE_PRESET, 'execution preset'),
    authoritySnapshot: normalizeCompiledContent(compiled.authoritySnapshot, CONTENT_TYPE_AUTHORITY, 'authority snapshot')
  };
}

function normalizeCompiledContent(
  content: CompiledTurnAuthorityContent,
  defaultContentType: string,
  label: string
): Required<CompiledTurnAuthorityContent> {
  if (!content || (typeof content.content !== 'string' && !(content.content instanceof Uint8Array))) {
    throw new TypeError(`Compiled ${label} content is invalid.`);
  }
  if (typeof content.content === 'string' && content.content.length === 0) {
    throw new TypeError(`Compiled ${label} content cannot be empty.`);
  }
  if (content.content instanceof Uint8Array && content.content.byteLength === 0) {
    throw new TypeError(`Compiled ${label} content cannot be empty.`);
  }
  return {
    content: content.content,
    contentType: requireContentType(content.contentType ?? defaultContentType)
  };
}

function normalizeInitiatingSource(source: TurnCommandSource, operation: Exclude<TurnCommandOperation, 'terminal'>): TurnInitiatingSource {
  if (!source || !['command', 'internal'].includes(source.kind)) {
    throw new TypeError(`${operation} source kind must be command or internal.`);
  }
  return { kind: source.kind as TurnInitiatingSource['kind'], key: requireText(source.key, 'source key') };
}

function normalizeTerminalSource(source: TurnCommandSource): TurnTerminalSource {
  if (!source || !['callback', 'internal', 'recovery'].includes(source.kind)) {
    throw new TypeError('terminal source kind must be callback, internal or recovery.');
  }
  return { kind: source.kind as TurnTerminalSource['kind'], key: requireText(source.key, 'source key') };
}

function normalizeForkSource(source: ConversationForkSource): ConversationForkSource {
  return {
    sourceConversationId: requireId(source.sourceConversationId, 'sourceConversationId'),
    sourceTurnId: requireId(source.sourceTurnId, 'sourceTurnId'),
    sourceMessageId: requireId(source.sourceMessageId, 'sourceMessageId'),
    sourceMessageRevisionId: requireId(source.sourceMessageRevisionId, 'sourceMessageRevisionId'),
    sourceContextRootId: requireId(source.sourceContextRootId, 'sourceContextRootId')
  };
}

function commandEntityId(
  source: TurnCommandSource,
  operation: TurnCommandOperation,
  entityKind: string,
  commandScope: string
): string {
  const digest = createHash('sha256')
    .update('limcode-turn-command-entity\0')
    .update(JSON.stringify([source.kind, source.key, operation, commandScope, entityKind]))
    .digest('hex');
  return `${entityKind}_${digest}`;
}

function allocatedValue(
  commit: CommandCommit,
  domain: string,
  id: string,
  column: string
): string {
  const allocated = commit.allocatedSequences.find((entry) =>
    entry.domain === domain && entry.id === id && entry.column === column
  );
  if (!allocated) throw new Error(`${domain} ${id} did not return writer-allocated ${column}.`);
  return requireDecimalIntegerString(allocated.value, `${domain}.${column}`);
}

function deduplicatedCommit(receipt: DomainRow): CommandCommit {
  return { receipt, deduplicated: true, changes: [], allocatedSequences: [] };
}

function basicDuplicateResult(
  receipt: DomainRow,
  expectedReceiptId: string,
  operation: TurnCommandOperation,
  fields: Pick<TurnCommandResult, 'conversationId' | 'messageId'>
): TurnCommandResult {
  assertReceiptIdentity(receipt, expectedReceiptId, operation);
  if (receipt.conversation_id !== fields.conversationId) throw sourceOperationMismatch(receipt, operation);
  return { receiptId: receipt.id as string, deduplicated: true, ...fields };
}

function basicCommittedResult(
  commit: CommandCommit,
  fields: Pick<TurnCommandResult, 'conversationId' | 'messageId'>
): TurnCommandResult {
  return {
    receiptId: commit.receipt.id as string,
    deduplicated: false,
    commitSeq: commit.commitSeq,
    ...fields
  };
}

function assertReceiptIdentity(
  receipt: DomainRow,
  expectedReceiptId: string,
  operation: TurnCommandOperation
): void {
  if (receipt.id !== expectedReceiptId) throw sourceOperationMismatch(receipt, operation);
}

function sourceOperationMismatch(receipt: DomainRow, operation: TurnCommandOperation): Error {
  return new Error(
    `CommandReceipt (${String(receipt.source_kind)},${String(receipt.source_key)}) does not contain ${operation} result facts.`
  );
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list read did not return rows.');
  return value;
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value;
}

function requirePrepared(prepared: PreparedContentObject | undefined, label: string): PreparedContentObject {
  if (!prepared) throw new Error(`${label} was not prepared.`);
  return prepared;
}

function requireActiveTurn(turn: DomainRow, turnId: string): void {
  const status = requireText(turn.status, `Turn ${turnId}.status`);
  if (status !== TURN_STATUS_ACTIVE) throw new Error(`Turn ${turnId} is not active.`);
}

function requireTerminalStatus(value: string): asserts value is TurnTerminalStatus {
  if (!['completed', 'failed', 'interrupted', 'cancelled', 'outcome_unknown'].includes(value)) {
    throw new TypeError(`Unsupported Turn terminal status: ${value}`);
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function requireContentType(value: unknown): string {
  return requireText(value, 'content type');
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint inside JavaScript.`);
  return value;
}

function requireDecimalIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string on the wire.`);
  }
  return value;
}

function isTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

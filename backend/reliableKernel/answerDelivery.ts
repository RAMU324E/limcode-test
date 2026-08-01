import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { ChildExecutionControlPlane, type PreparedForegroundSettlement } from './childExecution';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  isTransactionAssertionFailure,
  optionalPhaseFId,
  requireIsoTimestamp,
  requirePhaseFId,
  requirePhaseFText,
  requirePositiveInteger,
  stablePhaseFId,
  sqliteUniqueFailureIncludes
} from './phaseFIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export type RuntimeDeliveryPhase = 'current_turn' | 'next_turn' | 'notify_only';
export type RuntimeDeliveryState = 'pending' | 'consumed' | 'failed';
export type ParentHandlingState = 'unhandled' | 'handled' | 'not_applicable';

export interface AnswerSubmitCommand {
  answerBridgeId: string;
  submissionId: string;
  sourceTurnId?: string;
  title?: string;
  content: string | Uint8Array;
  contentType?: string;
  interrupted?: boolean;
}

export interface AnswerSubmitResult {
  answerBridgeId: string;
  submissionId: string;
  answerPayloadId: string;
  inboxItemId: string;
  foregroundSettled: boolean;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface RuntimeDeliveryCreateCommand {
  inboxItemId: string;
  targetConversationId: string;
  targetTurnId?: string | null;
  phase: RuntimeDeliveryPhase;
}

export interface RuntimeDeliveryResult {
  delivery: DomainRow;
  inputLink: DomainRow | null;
  parentHandlingState: ParentHandlingState;
}

export interface RuntimeDeliveryAdvanceResult extends RuntimeDeliveryResult {
  changed: boolean;
  commitSeq?: string;
}

const DELIVERY_PHASES = new Set<RuntimeDeliveryPhase>(['current_turn', 'next_turn', 'notify_only']);
const DELIVERY_STATES = new Set<RuntimeDeliveryState>(['pending', 'consumed', 'failed']);
const ACTIVE_TURN = 'active';
const TERMINATED_TURN = 'terminated';

/** AnswerSubmission + AnswerBridge flip + RuntimeInboxItem atomic writer. */
export class AnswerControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly children: ChildExecutionControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async submit(commandInput: AnswerSubmitCommand): Promise<AnswerSubmitResult> {
    const command = normalizeAnswerCommand(commandInput);
    const ids = answerIds(command.answerBridgeId, command.submissionId);
    const replay = await this.findReplay(command, ids);
    if (replay) return replay;
    const bridge = await this.requireExisting('AnswerBridge', command.answerBridgeId);
    const childExecutionId = requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id');
    const payloadContent = await this.contentStore.prepare(
      this.database,
      command.content,
      command.contentType
    );
    const now = this.timestamp();
    const foreground = await this.children.prepareForegroundSettlement({
      childExecutionId,
      status: 'succeeded',
      detail: {
        answerBridgeId: command.answerBridgeId,
        answerSubmissionId: command.submissionId,
        answerContentObjectId: payloadContent.metadata.id,
        interrupted: command.interrupted
      },
      sourceIdentity: `answer:${command.answerBridgeId}:${command.submissionId}`
    });
    const eligibleForeground = foreground && Date.parse(now) <= Date.parse(foreground.waitDeadlineAt)
      ? foreground
      : null;

    try {
      const commit = await this.database.transaction([
        ...answerFactSteps(command, ids, bridge, payloadContent, now),
        ...(eligibleForeground ? eligibleForeground.steps : [])
      ]);
      return answerResult(command, ids, eligibleForeground !== null, false, commit.commitSeq);
    } catch (error) {
      if (
        eligibleForeground
        && isExpectedForegroundRace(error)
        && await this.foregroundRaceHasDurableWinner(eligibleForeground)
      ) {
        // The deadline/another answer durably won the ToolCall. Only this exact persisted winner
        // permits retrying the answer-only transaction; unrelated assertion failures propagate.
        const commit = await this.commitAnswerOnlyAfterForegroundRace(command, ids, bridge, payloadContent, now);
        return answerResult(command, ids, false, commit.deduplicated, commit.commitSeq);
      }
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent);
      if (!raced) throw error;
      return raced;
    }
  }

  /** Recovery-only invariant repair. It never flips the bridge or settles a ToolCall. */
  public async ensureInboxForSubmission(answerSubmissionIdInput: string): Promise<{
    inboxItemId: string;
    created: boolean;
    commitSeq?: string;
  }> {
    const submissionId = requirePhaseFId(answerSubmissionIdInput, 'answerSubmissionId');
    const submission = await this.requireExisting('AnswerSubmission', submissionId);
    const bridgeId = requirePhaseFId(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id');
    const ids = answerIds(bridgeId, submissionId);
    const rows = await this.listRows('RuntimeInboxItem', {
      dedupe_key: answerDedupeKey(bridgeId, submissionId)
    }, 2);
    if (rows.length === 1) {
      if (rows[0].source_kind !== 'answer_submission' || rows[0].source_id !== submissionId) {
        throw new Error('Answer RuntimeInboxItem dedupe key points to a different source identity.');
      }
      return { inboxItemId: rows[0].id as string, created: false };
    }
    if (rows.length > 1) throw new Error('Answer RuntimeInboxItem dedupe identity is not unique.');
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('AnswerSubmission').assert(submissionId, {
          answer_bridge_id: bridgeId,
          submission_seq: submission.submission_seq
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
          id: ids.inboxItemId,
          dedupe_key: answerDedupeKey(bridgeId, submissionId),
          source_kind: 'answer_submission',
          source_id: submissionId,
          state: 'available',
          created_at: now,
          updated_at: now
        })
      ]);
      return { inboxItemId: ids.inboxItemId, created: true, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!sqliteUniqueFailureIncludes(error, [
        'runtime_inbox_item.dedupe_key',
        'runtime_inbox_item.id'
      ])) throw error;
      const raced = await this.listRows('RuntimeInboxItem', {
        dedupe_key: answerDedupeKey(bridgeId, submissionId)
      }, 2);
      if (raced.length !== 1) throw error;
      return { inboxItemId: raced[0].id as string, created: false };
    }
  }

  private async foregroundRaceHasDurableWinner(
    settlement: PreparedForegroundSettlement
  ): Promise<boolean> {
    const results = await this.listRows('ToolModelResult', {
      tool_call_id: settlement.toolCallId
    }, 2);
    if (results.length > 1) throw new Error('Foreground ToolCall has multiple ToolModelResults.');
    return results.length === 1;
  }

  private async commitAnswerOnlyAfterForegroundRace(
    command: ReturnType<typeof normalizeAnswerCommand>,
    ids: ReturnType<typeof answerIds>,
    bridge: DomainRow,
    payloadContent: PreparedContentObject,
    now: string
  ): Promise<{ deduplicated: boolean; commitSeq?: string }> {
    const replay = await this.findReplay(command, ids, payloadContent);
    if (replay) return { deduplicated: true };
    try {
      const commit = await this.database.transaction(answerFactSteps(command, ids, bridge, payloadContent, now));
      return { deduplicated: false, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedAnswerIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids, payloadContent);
      if (!raced) throw error;
      return { deduplicated: true };
    }
  }

  private async findReplay(
    command: ReturnType<typeof normalizeAnswerCommand>,
    ids: ReturnType<typeof answerIds>,
    prepared?: PreparedContentObject
  ): Promise<AnswerSubmitResult | null> {
    const submission = await this.maybeGet('AnswerSubmission', command.submissionId);
    if (!submission) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AnswerPayload').list({
        where: { submission_id: command.submissionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').list({
        where: { dedupe_key: answerDedupeKey(command.answerBridgeId, command.submissionId) },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').get(command.answerBridgeId)
    ]);
    const payloads = requireRows(snapshot.snapshot[0], 'AnswerPayload replay lookup');
    const inboxRows = requireRows(snapshot.snapshot[1], 'RuntimeInboxItem replay lookup');
    const bridge = requireRow(snapshot.snapshot[2], `AnswerBridge ${command.answerBridgeId}`);
    if (payloads.length !== 1 || inboxRows.length !== 1) {
      throw new Error('Committed AnswerSubmission is missing its atomic payload/inbox facts.');
    }
    const payload = payloads[0];
    const inbox = inboxRows[0];
    const expectedContentObjectId = prepared?.metadata.id
      ?? this.contentStore.identity(command.content, command.contentType).id;
    if (
      submission.answer_bridge_id !== command.answerBridgeId
      || submission.turn_id !== (command.sourceTurnId ?? null)
      || submission.interrupted !== BigInt(command.interrupted ? 1 : 0)
      || payload.id !== ids.answerPayloadId
      || payload.title !== (command.title ?? null)
      || payload.content_object_id !== expectedContentObjectId
      || inbox.id !== ids.inboxItemId
      || inbox.source_kind !== 'answer_submission'
      || inbox.source_id !== command.submissionId
      || bridge.child_execution_id === null
    ) throw new Error('Answer callback identity was replayed with different facts.');
    return answerResult(command, ids, false, true);
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
    return requireIsoTimestamp(this.now(), 'Answer clock');
  }
}

/** RuntimeInbox destination/attempt state machine and parentHandling repository projection. */
export class RuntimeDeliveryControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async create(commandInput: RuntimeDeliveryCreateCommand): Promise<RuntimeDeliveryResult & {
    deduplicated: boolean;
    commitSeq?: string;
  }> {
    const command = normalizeDeliveryCommand(commandInput);
    const attemptSeq = 1n;
    const deliveryId = deliveryIdFor(command, attemptSeq);
    const existing = await this.maybeGet('RuntimeDelivery', deliveryId);
    if (existing) return { ...(await this.summaryFromRow(existing)), deduplicated: true };
    await this.requireExisting('RuntimeInboxItem', command.inboxItemId);
    const conversation = await this.maybeGet('Conversation', command.targetConversationId);
    const targetTurn = command.targetTurnId
      ? await this.maybeGet('Turn', command.targetTurnId)
      : null;
    const targetGone = !conversation || (command.targetTurnId !== null && !targetTurn);
    if (targetTurn && targetTurn.conversation_id !== command.targetConversationId) {
      throw new Error('RuntimeDelivery target Turn does not belong to target Conversation.');
    }
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(command.inboxItemId, {
          source_kind: (await this.requireExisting('RuntimeInboxItem', command.inboxItemId)).source_kind
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
          id: deliveryId,
          inbox_item_id: command.inboxItemId,
          target_conversation_id: command.targetConversationId,
          target_turn_id: command.targetTurnId,
          phase: command.phase,
          attempt_seq: attemptSeq,
          retry_of_delivery_id: null,
          state: targetGone ? 'failed' : 'pending',
          failure_reason: targetGone ? 'target-gone' : null,
          created_at: now,
          updated_at: now
        })
      ]);
      const row = await this.requireExisting('RuntimeDelivery', deliveryId);
      return { ...(await this.summaryFromRow(row)), deduplicated: false, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedDeliveryIdentityConflict(error)) throw error;
      const raced = await this.findDeliveryByIdentity(command, attemptSeq);
      if (!raced) throw error;
      return { ...(await this.summaryFromRow(raced)), deduplicated: true };
    }
  }

  public async redeliver(failedDeliveryIdInput: string): Promise<RuntimeDeliveryResult & {
    retryOfDeliveryId: string;
    commitSeq: string;
  }> {
    const failedDeliveryId = requirePhaseFId(failedDeliveryIdInput, 'failedDeliveryId');
    const failed = await this.requireExisting('RuntimeDelivery', failedDeliveryId);
    if (failed.state !== 'failed') throw new Error('Only a failed RuntimeDelivery can be redelivered.');
    const phase = requireDeliveryPhase(failed.phase);
    const peers = await this.listRows('RuntimeDelivery', {
      inbox_item_id: failed.inbox_item_id,
      target_conversation_id: failed.target_conversation_id,
      phase
    }, 1000);
    const matching = peers.filter((row) => row.target_turn_id === failed.target_turn_id);
    const nextAttempt = matching.reduce((maximum, row) => {
      const attempt = requirePositiveInteger(row.attempt_seq, 'RuntimeDelivery.attempt_seq');
      return attempt > maximum ? attempt : maximum;
    }, 0n) + 1n;
    const command = normalizeDeliveryCommand({
      inboxItemId: failed.inbox_item_id as string,
      targetConversationId: failed.target_conversation_id as string,
      targetTurnId: failed.target_turn_id as string | null,
      phase
    });
    const newId = deliveryIdFor(command, nextAttempt);
    const now = this.timestamp();
    const conversation = await this.maybeGet('Conversation', command.targetConversationId);
    const targetTurn = command.targetTurnId ? await this.maybeGet('Turn', command.targetTurnId) : null;
    const targetGone = !conversation || (command.targetTurnId !== null && !targetTurn);
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(failedDeliveryId, {
        state: 'failed',
        attempt_seq: failed.attempt_seq
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
        id: newId,
        inbox_item_id: command.inboxItemId,
        target_conversation_id: command.targetConversationId,
        target_turn_id: command.targetTurnId,
        phase,
        attempt_seq: nextAttempt,
        retry_of_delivery_id: failedDeliveryId,
        state: targetGone ? 'failed' : 'pending',
        failure_reason: targetGone ? 'target-gone' : null,
        created_at: now,
        updated_at: now
      })
    ]);
    const row = await this.requireExisting('RuntimeDelivery', newId);
    return { ...(await this.summaryFromRow(row)), retryOfDeliveryId: failedDeliveryId, commitSeq: commit.commitSeq };
  }

  public async advance(deliveryIdInput: string): Promise<RuntimeDeliveryAdvanceResult> {
    const deliveryId = requirePhaseFId(deliveryIdInput, 'deliveryId');
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    requireDeliveryState(delivery.state);
    if (delivery.state !== 'pending') return { ...(await this.summaryFromRow(delivery)), changed: false };
    const phase = requireDeliveryPhase(delivery.phase);
    const conversation = await this.maybeGet(
      'Conversation',
      requirePhaseFId(delivery.target_conversation_id, 'RuntimeDelivery.target_conversation_id')
    );
    if (!conversation) return this.failTargetGone(delivery);
    const targetTurn = delivery.target_turn_id === null
      ? null
      : await this.maybeGet('Turn', requirePhaseFId(delivery.target_turn_id, 'RuntimeDelivery.target_turn_id'));
    if (delivery.target_turn_id !== null && !targetTurn) return this.failTargetGone(delivery);

    if (phase === 'notify_only') {
      return { ...(await this.summaryFromRow(delivery)), changed: false };
    }
    if (phase === 'next_turn' && targetTurn === null) {
      return { ...(await this.summaryFromRow(delivery)), changed: false };
    }
    if (!targetTurn) throw new Error('current_turn delivery requires a target Turn.');
    if (targetTurn.conversation_id !== conversation.id) return this.failTargetGone(delivery);
    if (targetTurn.status === ACTIVE_TURN) return this.inject(delivery, targetTurn);
    if (targetTurn.status !== TERMINATED_TURN) {
      throw new Error(`RuntimeDelivery target Turn has unsupported status ${String(targetTurn.status)}.`);
    }
    return this.retargetAfterTerminal(delivery, conversation);
  }

  /** Called before a new Turn transaction; returned steps write back target + inject atomically. */
  public async prepareNextTurnDeliverySteps(
    conversationIdInput: string,
    turnIdInput: string,
    nowInput: string
  ): Promise<RepositoryTransactionStep[]> {
    const conversationId = requirePhaseFId(conversationIdInput, 'conversationId');
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const now = requireIsoTimestamp(nowInput, 'now');
    const deliveries = await this.listRows('RuntimeDelivery', {
      target_conversation_id: conversationId,
      target_turn_id: null,
      phase: 'next_turn',
      state: 'pending'
    }, 200);
    const steps: RepositoryTransactionStep[] = [];
    for (const delivery of deliveries) {
      const contentObjectId = await this.contentObjectIdForInbox(delivery.inbox_item_id as string);
      if (!contentObjectId) {
        steps.push(
          DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
            state: 'pending', phase: 'next_turn', target_turn_id: null
          }),
          DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
            phase: 'notify_only',
            updated_at: now
          })
        );
        continue;
      }
      steps.push(...injectionSteps(delivery, turnId, contentObjectId, now, true));
    }
    return steps;
  }

  public async acknowledgeNotification(deliveryIdInput: string): Promise<RuntimeDeliveryAdvanceResult> {
    const delivery = await this.requireExisting(
      'RuntimeDelivery',
      requirePhaseFId(deliveryIdInput, 'deliveryId')
    );
    if (delivery.phase !== 'notify_only') throw new Error('Only notify_only delivery can be acknowledged without input injection.');
    if (delivery.state !== 'pending') return { ...(await this.summaryFromRow(delivery)), changed: false };
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
        state: 'pending', phase: 'notify_only'
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
        state: 'consumed',
        failure_reason: null,
        updated_at: now
      })
    ]);
    const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
    return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
  }

  /** Executor ACK for the exact injected PendingTurnInput; unrelated inputs cannot affect handling. */
  public async markInputHandled(pendingTurnInputIdInput: string): Promise<RuntimeDeliveryResult & {
    changed: boolean;
    commitSeq?: string;
  }> {
    const pendingTurnInputId = requirePhaseFId(pendingTurnInputIdInput, 'pendingTurnInputId');
    const links = await this.listRows('RuntimeDeliveryInputLink', {
      pending_turn_input_id: pendingTurnInputId
    }, 2);
    if (links.length !== 1) throw new Error('PendingTurnInput must have exactly one RuntimeDeliveryInputLink.');
    const link = links[0];
    const delivery = await this.requireExisting('RuntimeDelivery', link.delivery_id as string);
    if (delivery.state !== 'consumed') throw new Error('RuntimeDeliveryInputLink can only be handled after delivery consumption.');
    if (link.handled_at !== null) return { ...(await this.summaryFromRow(delivery, link)), changed: false };
    const input = await this.requireExisting('PendingTurnInput', pendingTurnInputId);
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, { state: 'consumed' }),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').assert(link.id as string, {
        delivery_id: delivery.id,
        pending_turn_input_id: pendingTurnInputId,
        handled_at: null
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(pendingTurnInputId, {
        turn_id: input.turn_id,
        state: input.state
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(pendingTurnInputId, {
        state: 'consumed',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').update(link.id as string, {
        handled_at: now,
        updated_at: now
      })
    ]);
    const latestLink = await this.requireExisting('RuntimeDeliveryInputLink', link.id as string);
    return { ...(await this.summaryFromRow(delivery, latestLink)), changed: true, commitSeq: commit.commitSeq };
  }

  /** One SQLite snapshot transaction and repository-owned parentHandling derivation. */
  public async summary(deliveryIdInput: string): Promise<RuntimeDeliveryResult> {
    const deliveryId = requirePhaseFId(deliveryIdInput, 'deliveryId');
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').get(deliveryId),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').list({
        where: { delivery_id: deliveryId },
        limit: 2
      })
    ]);
    const delivery = requireRow(barrier.snapshot[0], `RuntimeDelivery ${deliveryId}`);
    const links = requireRows(barrier.snapshot[1], 'RuntimeDeliveryInputLink summary');
    if (links.length > 1) throw new Error('RuntimeDelivery has multiple input links.');
    return this.summaryFromRow(delivery, links[0] ?? null);
  }

  private async inject(delivery: DomainRow, targetTurn: DomainRow): Promise<RuntimeDeliveryAdvanceResult> {
    const contentObjectId = await this.contentObjectIdForInbox(delivery.inbox_item_id as string);
    if (!contentObjectId) return this.retargetAfterTerminal(delivery, await this.requireExisting(
      'Conversation', delivery.target_conversation_id as string
    ));
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction(injectionSteps(
        delivery,
        targetTurn.id as string,
        contentObjectId,
        now,
        false
      ));
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
    } catch (error) {
      if (!isExpectedDeliveryInjectionRace(error)) throw error;
      const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
      if (latest.state === 'consumed') return { ...(await this.summaryFromRow(latest)), changed: false };
      if (latest.state === 'pending') return this.advance(latest.id as string);
      return { ...(await this.summaryFromRow(latest)), changed: false };
    }
  }

  private async retargetAfterTerminal(
    delivery: DomainRow,
    conversation: DomainRow
  ): Promise<RuntimeDeliveryAdvanceResult> {
    const nextPhase: RuntimeDeliveryPhase = conversation.status === 'active' ? 'next_turn' : 'notify_only';
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, {
        state: 'pending',
        phase: delivery.phase,
        target_turn_id: delivery.target_turn_id
      }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
        phase: nextPhase,
        target_turn_id: null,
        updated_at: now
      })
    ]);
    const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
    return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
  }

  private async failTargetGone(delivery: DomainRow): Promise<RuntimeDeliveryAdvanceResult> {
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(delivery.id as string, { state: 'pending' }),
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(delivery.id as string, {
        state: 'failed',
        failure_reason: 'target-gone',
        updated_at: now
      })
    ]);
    const latest = await this.requireExisting('RuntimeDelivery', delivery.id as string);
    return { ...(await this.summaryFromRow(latest)), changed: true, commitSeq: commit.commitSeq };
  }

  private async contentObjectIdForInbox(inboxItemId: string): Promise<string | null> {
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    if (inbox.source_kind !== 'answer_submission') return null;
    const payloads = await this.listRows('AnswerPayload', { submission_id: inbox.source_id }, 2);
    if (payloads.length !== 1) throw new Error('Answer RuntimeInboxItem must resolve exactly one AnswerPayload.');
    return requirePhaseFId(payloads[0].content_object_id, 'AnswerPayload.content_object_id');
  }

  private async findDeliveryByIdentity(
    command: ReturnType<typeof normalizeDeliveryCommand>,
    attemptSeq: bigint
  ): Promise<DomainRow | null> {
    const where: DomainRow = {
      inbox_item_id: command.inboxItemId,
      target_conversation_id: command.targetConversationId,
      target_turn_id: command.targetTurnId,
      phase: command.phase,
      attempt_seq: attemptSeq
    };
    const rows = await this.listRows('RuntimeDelivery', where, 2);
    if (rows.length > 1) throw new Error('RuntimeDelivery partial UNIQUE identity is violated.');
    return rows[0] ?? null;
  }

  private async summaryFromRow(delivery: DomainRow, suppliedLink?: DomainRow | null): Promise<RuntimeDeliveryResult> {
    requireDeliveryState(delivery.state);
    const phase = requireDeliveryPhase(delivery.phase);
    let link = suppliedLink;
    if (link === undefined) {
      const links = await this.listRows('RuntimeDeliveryInputLink', { delivery_id: delivery.id }, 2);
      if (links.length > 1) throw new Error('RuntimeDelivery has multiple RuntimeDeliveryInputLinks.');
      link = links[0] ?? null;
    }
    return {
      delivery,
      inputLink: link,
      parentHandlingState: deriveParentHandlingState({
        state: delivery.state as RuntimeDeliveryState,
        phase,
        inputLink: link ?? null
      })
    };
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
    return requireIsoTimestamp(this.now(), 'RuntimeDelivery clock');
  }
}

export function deriveParentHandlingState(input: {
  state: RuntimeDeliveryState;
  phase: RuntimeDeliveryPhase;
  inputLink: DomainRow | null;
}): ParentHandlingState {
  if (input.state === 'pending' || input.state === 'failed') return 'unhandled';
  if (input.phase === 'notify_only' && input.inputLink === null) return 'not_applicable';
  if ((input.phase === 'current_turn' || input.phase === 'next_turn') && input.inputLink) {
    return input.inputLink.handled_at === null ? 'unhandled' : 'handled';
  }
  throw new Error('Consumed RuntimeDelivery has an invalid phase/InputLink combination.');
}

function normalizeAnswerCommand(command: AnswerSubmitCommand) {
  if (typeof command.content !== 'string' && !(command.content instanceof Uint8Array)) {
    throw new TypeError('Answer content must be text or bytes.');
  }
  return {
    answerBridgeId: requirePhaseFId(command.answerBridgeId, 'answerBridgeId'),
    submissionId: requirePhaseFId(command.submissionId, 'submissionId'),
    ...(optionalPhaseFId(command.sourceTurnId, 'sourceTurnId')
      ? { sourceTurnId: optionalPhaseFId(command.sourceTurnId, 'sourceTurnId')! }
      : {}),
    ...(typeof command.title === 'string' && command.title.trim() ? { title: command.title.trim() } : {}),
    content: command.content,
    contentType: command.contentType === undefined
      ? 'text/plain'
      : requirePhaseFText(command.contentType, 'contentType'),
    interrupted: command.interrupted === true
  };
}

function answerIds(answerBridgeId: string, submissionId: string) {
  return {
    answerPayloadId: stablePhaseFId('answer_payload', answerBridgeId, submissionId),
    inboxItemId: stablePhaseFId('runtime_inbox_item', 'answer', answerBridgeId, submissionId)
  };
}

function answerDedupeKey(answerBridgeId: string, submissionId: string): string {
  return `answer:${answerBridgeId}:${submissionId}`;
}

function answerFactSteps(
  command: ReturnType<typeof normalizeAnswerCommand>,
  ids: ReturnType<typeof answerIds>,
  bridge: DomainRow,
  payloadContent: PreparedContentObject,
  now: string
): RepositoryTransactionStep[] {
  return [
    DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(command.answerBridgeId, {
      child_execution_id: bridge.child_execution_id,
      status: bridge.status
    }),
    ...preparedContentObjectSteps([payloadContent], 'answer_payload'),
    DOMAIN_REPOSITORIES.domain('AnswerSubmission').insertWithNextSequence({
      id: command.submissionId,
      answer_bridge_id: command.answerBridgeId,
      turn_id: command.sourceTurnId ?? null,
      interrupted: command.interrupted ? '1' : '0',
      created_at: now
    }, {
      column: 'submission_seq',
      scope: { answer_bridge_id: command.answerBridgeId }
    }),
    DOMAIN_REPOSITORIES.domain('AnswerPayload').insert({
      id: ids.answerPayloadId,
      submission_id: command.submissionId,
      title: command.title ?? null,
      content_object_id: payloadContent.metadata.id,
      byte_length: payloadContent.metadata.byte_length,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('AnswerBridge').update(command.answerBridgeId, {
      current_submission_id: command.submissionId,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
      id: ids.inboxItemId,
      dedupe_key: answerDedupeKey(command.answerBridgeId, command.submissionId),
      source_kind: 'answer_submission',
      source_id: command.submissionId,
      state: 'available',
      created_at: now,
      updated_at: now
    })
  ];
}

function answerResult(
  command: ReturnType<typeof normalizeAnswerCommand>,
  ids: ReturnType<typeof answerIds>,
  foregroundSettled: boolean,
  deduplicated: boolean,
  commitSeq?: string
): AnswerSubmitResult {
  return {
    answerBridgeId: command.answerBridgeId,
    submissionId: command.submissionId,
    answerPayloadId: ids.answerPayloadId,
    inboxItemId: ids.inboxItemId,
    foregroundSettled,
    deduplicated,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function normalizeDeliveryCommand(command: RuntimeDeliveryCreateCommand) {
  const phase = requireDeliveryPhase(command.phase);
  const targetTurnId = command.targetTurnId === undefined || command.targetTurnId === null
    ? null
    : requirePhaseFId(command.targetTurnId, 'targetTurnId');
  if (phase === 'current_turn' && targetTurnId === null) {
    throw new TypeError('current_turn RuntimeDelivery requires targetTurnId.');
  }
  return {
    inboxItemId: requirePhaseFId(command.inboxItemId, 'inboxItemId'),
    targetConversationId: requirePhaseFId(command.targetConversationId, 'targetConversationId'),
    targetTurnId,
    phase
  };
}

function deliveryIdFor(command: ReturnType<typeof normalizeDeliveryCommand>, attemptSeq: bigint): string {
  return stablePhaseFId(
    'runtime_delivery',
    command.inboxItemId,
    command.targetConversationId,
    command.targetTurnId,
    command.phase,
    attemptSeq.toString()
  );
}

function injectionSteps(
  delivery: DomainRow,
  targetTurnId: string,
  contentObjectId: string,
  now: string,
  writebackTarget: boolean
): RepositoryTransactionStep[] {
  const deliveryId = requirePhaseFId(delivery.id, 'RuntimeDelivery.id');
  const inputId = stablePhaseFId('pending_turn_input', 'runtime-delivery', deliveryId);
  const linkId = stablePhaseFId('runtime_delivery_input_link', deliveryId);
  return [
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
      state: 'pending',
      phase: delivery.phase,
      target_turn_id: writebackTarget ? null : delivery.target_turn_id,
      attempt_seq: delivery.attempt_seq
    }),
    DOMAIN_REPOSITORIES.domain('Turn').assert(targetTurnId, { status: ACTIVE_TURN }),
    DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
      id: inputId,
      turn_id: targetTurnId,
      input_kind: 'runtime_delivery',
      content_object_id: contentObjectId,
      state: 'pending',
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').insert({
      id: linkId,
      delivery_id: deliveryId,
      pending_turn_input_id: inputId,
      handled_at: null,
      created_at: now,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
      ...(writebackTarget ? { target_turn_id: targetTurnId } : {}),
      state: 'consumed',
      failure_reason: null,
      updated_at: now
    })
  ];
}

function requireDeliveryPhase(value: unknown): RuntimeDeliveryPhase {
  if (!DELIVERY_PHASES.has(value as RuntimeDeliveryPhase)) {
    throw new TypeError(`Unsupported RuntimeDelivery phase: ${String(value)}.`);
  }
  return value as RuntimeDeliveryPhase;
}

function requireDeliveryState(value: unknown): RuntimeDeliveryState {
  if (!DELIVERY_STATES.has(value as RuntimeDeliveryState)) {
    throw new TypeError(`Unsupported RuntimeDelivery state: ${String(value)}.`);
  }
  return value as RuntimeDeliveryState;
}

function isExpectedAnswerIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'answer_submission.id',
    'answer_submission.answer_bridge_id, answer_submission.submission_seq',
    'answer_payload.submission_id',
    'runtime_inbox_item.dedupe_key'
  ]);
}

function isExpectedForegroundRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'tool_outcome.tool_call_id',
    'tool_model_result.tool_call_id',
    'tool_model_result.message_revision_id'
  ]);
}

function isExpectedDeliveryIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'runtime_delivery.id',
    'runtime_delivery.inbox_item_id, runtime_delivery.target_conversation_id, runtime_delivery.phase, runtime_delivery.attempt_seq',
    'runtime_delivery.inbox_item_id, runtime_delivery.target_conversation_id, runtime_delivery.target_turn_id, runtime_delivery.phase, runtime_delivery.attempt_seq'
  ]);
}

function isExpectedDeliveryInjectionRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'runtime_delivery_input_link.delivery_id',
    'runtime_delivery_input_link.pending_turn_input_id',
    'pending_turn_input.id'
  ]);
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

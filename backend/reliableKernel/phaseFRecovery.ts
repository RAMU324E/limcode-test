import { AnswerControlPlane, RuntimeDeliveryControlPlane } from './answerDelivery';
import {
  CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
  childContinuationTurnId,
  ChildExecutionControlPlane,
  LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND
} from './childExecution';
import { isTransactionAssertionFailure, requireIsoTimestamp } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export const PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT = 'recovery.answer-inbox-invariant';
export const PHASE_F_RECOVERY_DELIVERY_PENDING = 'recovery.delivery-pending';
export const PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED = 'recovery.foreground-answer-wait-expired';
export const PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE = 'recovery.interrupted-subtree-incomplete';

export type PhaseFRecoveryId =
  | typeof PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT
  | typeof PHASE_F_RECOVERY_DELIVERY_PENDING
  | typeof PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED
  | typeof PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE;

export interface PhaseFRecoveryResult {
  id: PhaseFRecoveryId;
  scanned: number;
  reconciled: number;
  unchanged: number;
  affectedIds: string[];
}

interface ContinuationWaitOwner {
  childExecutionId: string;
  answerBridge: DomainRow;
}

/** Registers exactly the four Phase F-owned startup scans on top of the Phase D scanner pattern. */
export class PhaseFRecoveryScanner {
  private readonly handlers: ReadonlyMap<PhaseFRecoveryId, (signal?: AbortSignal) => Promise<PhaseFRecoveryResult>>;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly answers: AnswerControlPlane,
    private readonly deliveries: RuntimeDeliveryControlPlane,
    private readonly children: ChildExecutionControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.handlers = new Map<PhaseFRecoveryId, (signal?: AbortSignal) => Promise<PhaseFRecoveryResult>>([
      [PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT, (signal) => this.scanAnswerInboxInvariant(signal)],
      [PHASE_F_RECOVERY_DELIVERY_PENDING, (signal) => this.scanPendingDeliveries(signal)],
      [PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED, (signal) => this.scanExpiredForegroundWaits(signal)],
      [PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE, (signal) => this.scanIncompleteInterruptedSubtrees(signal)]
    ]);
  }

  public ids(): PhaseFRecoveryId[] {
    return [...this.handlers.keys()];
  }

  public async run(id: PhaseFRecoveryId, signal?: AbortSignal): Promise<PhaseFRecoveryResult> {
    signal?.throwIfAborted();
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(`Phase F does not own recovery scan ${String(id)}.`);
    return handler(signal);
  }

  public async runAll(signal?: AbortSignal): Promise<PhaseFRecoveryResult[]> {
    signal?.throwIfAborted();
    await this.reconcileChildConversationOrigins(signal);
    // A Host may die after the child Turn commits terminal but before the process-local
    // coordinator clears ChildExecutionActiveTurnLink. Reconcile that durable half-transition
    // before the registered scans so history/runtime state cannot remain falsely active forever.
    await this.reconcileTerminalChildActiveTurns(signal);
    const results = [
      await this.scanAnswerInboxInvariant(signal, false),
      await this.run(PHASE_F_RECOVERY_DELIVERY_PENDING, signal),
      await this.run(PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED, signal),
      await this.run(PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE, signal)
    ];
    await this.reconcileTerminalChildActiveTurns(signal);
    return results;
  }

  /** Deterministic lineage migration for pre-atomic child records; it adds no fifth scan ID. */
  private async reconcileChildConversationOrigins(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const candidates = await this.database.childConversationOriginCandidates();
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      await this.children.ensureConversationOrigin(candidate.childExecutionId);
    }
  }

  /** Deterministic DB-only closure; it adds no fifth registered recovery policy. */
  private async reconcileTerminalChildActiveTurns(signal?: AbortSignal): Promise<void> {
    const links = await listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink');
    const turns = links.length === 0
      ? []
      : (await this.database.snapshot(links.map((link) =>
          DOMAIN_REPOSITORIES.domain('Turn').get(String(link.turn_id))
        ))).snapshot;
    for (const [index, link] of links.entries()) {
      signal?.throwIfAborted();
      const turnId = String(link.turn_id);
      const turn = requireRow(turns[index], `Turn ${turnId}`);
      if (turn.status !== 'terminated') continue;
      const terminations = await listAllDomainRows(this.database, 'TurnTermination', { turn_id: turnId });
      if (terminations.length !== 1) {
        throw new Error(`Terminal child Turn ${turnId} must have exactly one TurnTermination.`);
      }
      if (terminations[0].terminal_status === 'failed') {
        const reason = typeof terminations[0].reason === 'string' && terminations[0].reason.trim()
          ? terminations[0].reason.trim()
          : `Child Turn ${turnId} failed.`;
        const failed = await this.answers.reconcileFailedTurn({
          childExecutionId: String(link.child_execution_id),
          turnId,
          reason
        });
        if (failed?.disposition.kind === 'delivery_required') {
          await this.deliveries.createAutomatic({
            inboxItemId: failed.disposition.command.inboxItemId,
            targetConversationId: failed.disposition.command.targetConversationId,
            sourceTurnId: failed.disposition.automaticSourceTurnId
          });
        }
      }
      await this.children.observeTurnTerminal(String(link.child_execution_id), turnId);
    }
  }

  private async scanAnswerInboxInvariant(
    signal?: AbortSignal,
    includeMissingInboxAudit = true
  ): Promise<PhaseFRecoveryResult> {
    const availableInbox = (await listAllDomainRows(this.database, 'RuntimeInboxItem', {
      state: 'available'
    })).filter((row) => row.source_kind === 'answer_submission');
    const auditSubmissionIds = includeMissingInboxAudit
      ? [
          ...await listAllDomainRows(this.database, 'AnswerBridge', { status: 'submitted' }),
          ...await listAllDomainRows(this.database, 'AnswerBridge', { status: 'interrupted' })
        ].flatMap((bridge) => bridge.current_submission_id === null
          ? []
          : [String(bridge.current_submission_id)])
      : [];
    const submissionIds = [...new Set([
      ...availableInbox.map((row) => String(row.source_id)),
      ...auditSubmissionIds
    ])];
    const submissionSnapshot = submissionIds.length === 0
      ? []
      : (await this.database.snapshot(submissionIds.map((submissionId) =>
          DOMAIN_REPOSITORIES.domain('AnswerSubmission').get(submissionId)
        ))).snapshot;
    const submissions = submissionIds
      .map((submissionId, index) => requireRow(
        submissionSnapshot[index],
        `AnswerSubmission ${submissionId}`
      ))
      .sort((left, right) => String(left.answer_bridge_id).localeCompare(String(right.answer_bridge_id))
        || compareCounter(left.submission_seq, right.submission_seq));
    const bridgeIds = [...new Set(submissions.map((submission) => String(submission.answer_bridge_id)))];
    const bridgeSnapshot = bridgeIds.length === 0
      ? []
      : (await this.database.snapshot(bridgeIds.map((bridgeId) =>
          DOMAIN_REPOSITORIES.domain('AnswerBridge').get(bridgeId)
        ))).snapshot;
    const bridgeById = new Map(bridgeIds.map((bridgeId, index) => [
      bridgeId,
      requireRow(bridgeSnapshot[index], `AnswerBridge ${bridgeId}`)
    ]));
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const submission of submissions) {
      signal?.throwIfAborted();
      const submissionId = String(submission.id);
      let changed = false;
      const bridge = bridgeById.get(String(submission.answer_bridge_id))!;
      if (bridge.current_submission_id !== submissionId) {
        if (await this.markInboxStateForSubmission(submissionId, 'settled')) {
          affectedIds.push(submissionId);
        } else {
          unchanged += 1;
        }
        continue;
      }
      const inbox = await this.answers.ensureInboxForSubmission(submissionId);
      if (inbox.deferredLiveOwner) {
        unchanged += 1;
        continue;
      }
      if (inbox.created) changed = true;
      let disposition = await this.answers.classifyDeliveryRecovery(submissionId);
      if (disposition.kind === 'settled_by_answer') {
        // The answer may have atomically settled the Operation but crashed before ordered
        // ToolOutcome materialization. Every ToolCall is checked independently during replay.
        const waits = await this.answers.reconcileCommittedWaits(submissionId);
        if (waits.newlySettledToolCallIds.length > 0) changed = true;
        if (await this.markInboxState(inbox.inboxItemId, 'settled')) changed = true;
      } else if (disposition.kind === 'delivery_required') {
        // The immutable answer may have committed immediately before the coordinator/tool callback
        // failed. Recreate the parent wait edge before choosing a RuntimeDelivery; otherwise a
        // waiting run_agent and a newly injected runtime_delivery can deadlock each other.
        const waits = await this.answers.reconcileCommittedWaits(submissionId);
        if (waits.newlySettledToolCallIds.length > 0) changed = true;
        disposition = await this.answers.classifyDeliveryRecovery(submissionId);
      }
      if (disposition.kind === 'delivery_required') {
        const delivery = await this.deliveries.createAutomatic({
          inboxItemId: disposition.command.inboxItemId,
          targetConversationId: disposition.command.targetConversationId,
          sourceTurnId: disposition.automaticSourceTurnId
        });
        if (!delivery.deduplicated) changed = true;
      } else if (disposition.kind === 'existing') {
        if (await this.markInboxState(inbox.inboxItemId, 'routed')) changed = true;
      }
      if (changed) affectedIds.push(submissionId);
      else unchanged += 1;
    }
    return {
      id: PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT,
      scanned: submissions.length,
      reconciled: affectedIds.length,
      unchanged,
      affectedIds
    };
  }

  private async markInboxStateForSubmission(
    submissionId: string,
    state: 'routed' | 'settled'
  ): Promise<boolean> {
    const rows = await listAllDomainRows(this.database, 'RuntimeInboxItem', {
      source_kind: 'answer_submission',
      source_id: submissionId
    });
    if (rows.length === 0) return false;
    if (rows.length !== 1) throw new Error(`AnswerSubmission ${submissionId} has multiple RuntimeInboxItems.`);
    return this.markInboxState(String(rows[0].id), state);
  }

  private async markInboxState(
    inboxItemId: string,
    state: 'routed' | 'settled'
  ): Promise<boolean> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').get(inboxItemId)
    ]);
    const inbox = requireRow(snapshot.snapshot[0], `RuntimeInboxItem ${inboxItemId}`);
    if (inbox.state === state || inbox.state === 'settled') return false;
    if (inbox.state !== 'available' && inbox.state !== 'routed') {
      throw new Error(`RuntimeInboxItem ${inboxItemId} has unsupported state ${String(inbox.state)}.`);
    }
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxItemId, { state: inbox.state }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').update(inboxItemId, {
          state,
          updated_at: now
        })
      ]);
      return true;
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const raced = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').get(inboxItemId)
      ]);
      const current = requireRow(raced.snapshot[0], `RuntimeInboxItem ${inboxItemId}`);
      if (current.state === state || current.state === 'settled') return false;
      throw error;
    }
  }

  private async scanPendingDeliveries(signal?: AbortSignal): Promise<PhaseFRecoveryResult> {
    const pending = await listAllDomainRows(this.database, 'RuntimeDelivery', { state: 'pending' });
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const delivery of pending) {
      signal?.throwIfAborted();
      const deliveryId = String(delivery.id);
      const result = await this.deliveries.advance(deliveryId);
      const changed = result.changed;
      if (changed) affectedIds.push(deliveryId);
      else unchanged += 1;
    }
    return {
      id: PHASE_F_RECOVERY_DELIVERY_PENDING,
      scanned: pending.length,
      reconciled: affectedIds.length,
      unchanged,
      affectedIds
    };
  }

  private async scanExpiredForegroundWaits(signal?: AbortSignal): Promise<PhaseFRecoveryResult> {
    const now = this.timestamp();
    const executions = await listAllDomainRows(this.database, 'ToolExecution', {
      status: 'waiting_answer'
    });
    const links = (await Promise.all(executions.map((execution) =>
      listAllDomainRows(this.database, 'ChildExecutionParentLink', {
        source_tool_call_id: execution.tool_call_id
      })
    ))).flat();
    const childByToolCall = new Map(links.map((link) => [
      String(link.source_tool_call_id),
      String(link.child_execution_id)
    ]));
    const continuationOperations = [
      ...await listAllDomainRows(this.database, 'Operation', {
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        status: 'waiting_answer'
      }),
      ...await listAllDomainRows(this.database, 'Operation', {
        owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
        status: 'waiting_answer'
      })
    ];
    const continuationByToolCall = new Map<string, DomainRow[]>();
    for (const operation of continuationOperations) {
      signal?.throwIfAborted();
      const toolCallId = String(operation.tool_call_id);
      const grouped = continuationByToolCall.get(toolCallId) ?? [];
      grouped.push(operation);
      continuationByToolCall.set(toolCallId, grouped);
    }
    const continuationOwners = await this.resolveContinuationWaitOwners(continuationOperations);
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const execution of executions) {
      signal?.throwIfAborted();
      const deadline = execution.wait_deadline_at;
      if (typeof deadline !== 'string' || Date.parse(deadline) > Date.parse(now)) {
        unchanged += 1;
        continue;
      }
      const toolCallId = String(execution.tool_call_id);
      const childExecutionId = childByToolCall.get(toolCallId);
      if (childExecutionId) {
        if (await this.children.settleForegroundTimeout(childExecutionId, now)) {
          affectedIds.push(String(execution.id));
        } else {
          unchanged += 1;
        }
        continue;
      }
      const continuationRows = continuationByToolCall.get(toolCallId) ?? [];
      if (continuationRows.length > 0) {
        if (continuationRows.length !== 1) {
          throw new Error(`Continuation ToolCall ${toolCallId} has multiple waiting Operations.`);
        }
        const continuation = continuationRows[0];
        const owner = continuationOwners.get(String(continuation.id));
        if (!owner) throw new Error(`Continuation wait ${String(continuation.id)} has no exact owner.`);
        const settled = await this.children.settleContinuationWaits({
          answerBridgeId: String(owner.answerBridge.id),
          toolCallId,
          detail: { timeout: true, recovered: true },
          sourceIdentity: `recovery-foreground-timeout:${toolCallId}:${String(deadline)}`,
          observedAt: now
        });
        if (settled.length > 0) affectedIds.push(String(execution.id));
        else unchanged += 1;
        continue;
      }
      // ask_user and other independent waiting operations are owned by their own recovery scanners.
      unchanged += 1;
    }
    return {
      id: PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED,
      scanned: executions.length,
      reconciled: affectedIds.length,
      unchanged,
      affectedIds
    };
  }

  private async scanIncompleteInterruptedSubtrees(signal?: AbortSignal): Promise<PhaseFRecoveryResult> {
    const roots = await listAllDomainRows(this.database, 'ChildExecution', {
      status: 'interrupting'
    });
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const root of roots) {
      signal?.throwIfAborted();
      const result = await this.children.interruptSubtree({
        sourceKey: `recovery:interrupt-subtree:${String(root.id)}`,
        childExecutionId: String(root.id),
        reason: 'Extension Host restart resumed an incomplete subtree interruption.'
      });
      if (
        result.terminationRequestsWritten > 0
        || result.intentsCancelled > 0
        || result.waitsSettled > 0
        || result.terminalizedLineageIds.length > 0
      ) {
        affectedIds.push(String(root.id));
      } else {
        unchanged += 1;
      }
    }
    // interruptSubtree's lineage transaction and parent wait settlements cannot share one SQLite
    // transaction. A Host may therefore leave either a waiting Operation, or a terminal
    // Operation/Artifact whose ordered ToolModelResult has not yet been materialized.
    const [
      foregroundOperations,
      generationOperations,
      legacyOperations,
      interruptedBridges
    ] = await Promise.all([
      listAllDomainRows(this.database, 'Operation', {
        owner_kind: 'child_execution',
        status: 'waiting_answer'
      }),
      listAllDomainRows(this.database, 'Operation', {
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        status: 'waiting_answer'
      }),
      listAllDomainRows(this.database, 'Operation', {
        owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
        status: 'waiting_answer'
      }),
      listAllDomainRows(this.database, 'AnswerBridge', {
        status: 'interrupted',
        current_submission_id: null
      })
    ]);
    const continuationOwners = await this.resolveContinuationWaitOwners([
      ...generationOperations,
      ...legacyOperations
    ]);
    const candidateIds = new Set<string>([
      ...roots.map((root) => String(root.id)),
      ...interruptedBridges.map((bridge) => String(bridge.child_execution_id))
    ]);
    for (const operation of foregroundOperations) candidateIds.add(String(operation.owner_id));
    for (const operation of [...generationOperations, ...legacyOperations]) {
      const owner = continuationOwners.get(String(operation.id));
      if (owner) candidateIds.add(owner.childExecutionId);
    }
    const childById = new Map(roots.map((child) => [String(child.id), child]));
    const missingChildIds = [...candidateIds].filter((childExecutionId) => !childById.has(childExecutionId));
    const childSnapshot = missingChildIds.length === 0
      ? []
      : (await this.database.snapshot(missingChildIds.map((childExecutionId) =>
          DOMAIN_REPOSITORIES.domain('ChildExecution').get(childExecutionId)
        ))).snapshot;
    for (const [index, childExecutionId] of missingChildIds.entries()) {
      childById.set(childExecutionId, requireRow(
        childSnapshot[index],
        `ChildExecution ${childExecutionId}`
      ));
    }
    const children = [...childById.values()].filter((child) =>
      child.status === 'interrupting' || child.status === 'interrupted'
    );
    const bridgeByChild = new Map(interruptedBridges.map((bridge) => [
      String(bridge.child_execution_id),
      bridge
    ]));
    const childrenMissingBridge = children.filter((child) => !bridgeByChild.has(String(child.id)));
    const bridgeSnapshot = childrenMissingBridge.length === 0
      ? []
      : (await this.database.snapshot(childrenMissingBridge.map((child) =>
          DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
            where: { child_execution_id: String(child.id) },
            limit: 2
          })
        ))).snapshot;
    for (const [index, child] of childrenMissingBridge.entries()) {
      const childExecutionId = String(child.id);
      const rows = requireRows(bridgeSnapshot[index], `AnswerBridge ${childExecutionId} lookup`);
      if (rows.length !== 1) {
        throw new Error(`ChildExecution ${childExecutionId} must retain exactly one AnswerBridge.`);
      }
      bridgeByChild.set(childExecutionId, rows[0]);
    }
    for (const child of childById.values()) {
      const childExecutionId = String(child.id);
      const bridge = bridgeByChild.get(childExecutionId);
      if (
        child.status === 'closed'
        && bridge?.status === 'interrupted'
        && bridge.current_submission_id === null
        && await this.closeEmptyInterruptedBridge(bridge)
      ) affectedIds.push(childExecutionId);
    }
    let terminalWaitCandidates = 0;
    for (const childExecutionId of candidateIds) {
      const child = childById.get(childExecutionId);
      const bridge = bridgeByChild.get(childExecutionId);
      if (!child || !bridge) continue;
      const cancellationCommitted = child.status === 'interrupting' || child.status === 'interrupted';
      if (!cancellationCommitted) continue;
      terminalWaitCandidates += 1;
      const settled = await this.children.settleCancelledExecutionWaits({
        childExecutionId,
        reason: 'Extension Host restart closed a cancelled child wait after lineage commit.',
        sourceIdentity: `recovery:cancelled-child-waits:${childExecutionId}`
      });
      if (settled.foregroundSettled || settled.continuationSettlements > 0) {
        affectedIds.push(childExecutionId);
      } else {
        unchanged += 1;
      }
    }
    // The final cancellation transaction also moves every empty AnswerBridge to interrupted. A
    // crash before the coordinator materializes its deterministic partial answer would otherwise
    // leave no active pointer for the child scheduler to revisit.
    const partialChildren = children.filter((child) => {
      const bridge = bridgeByChild.get(String(child.id));
      return bridge?.status === 'interrupted' && bridge.current_submission_id === null;
    });
    const turnMembershipGroups = await Promise.all(partialChildren.map((child) => listAllDomainRows(
      this.database,
      'ChildExecutionTurnLink',
      { child_execution_id: String(child.id) }
    )));
    const turnMemberships = turnMembershipGroups.flat();
    const turnIds = [...new Set(turnMemberships.map((membership) => String(membership.turn_id)))];
    const turnFacts = turnIds.length === 0
      ? []
      : (await this.database.snapshot(turnIds.flatMap((turnId) => [
          DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
          DOMAIN_REPOSITORIES.domain('TurnTermination').list({
            where: { turn_id: turnId },
            limit: 2
          }),
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').list({
            where: { turn_id: turnId, input_kind: 'termination_request' },
            limit: 1
          })
        ]))).snapshot;
    const terminalTurnIds = new Set<string>();
    const terminationByTurn = new Map<string, DomainRow>();
    const cancellationTurnIds = new Set<string>();
    for (const [index, turnId] of turnIds.entries()) {
      const turn = requireRow(turnFacts[index * 3], `Turn ${turnId}`);
      if (turn.status === 'terminated') terminalTurnIds.add(turnId);
      const terminations = requireRows(
        turnFacts[index * 3 + 1],
        `TurnTermination ${turnId} lookup`
      );
      if (terminations.length > 1) throw new Error(`Turn ${turnId} has multiple terminations.`);
      if (terminations[0]) terminationByTurn.set(turnId, terminations[0]);
      const terminationRequests = requireRows(
        turnFacts[index * 3 + 2],
        `PendingTurnInput termination request ${turnId} lookup`
      );
      if (terminationRequests.length > 0) {
        cancellationTurnIds.add(turnId);
      }
    }
    let partialCandidates = 0;
    for (const child of partialChildren) {
      const childExecutionId = String(child.id);
      const bridge = bridgeByChild.get(childExecutionId);
      if (!bridge) continue;
      const cancellationTurn = turnMemberships
        .filter((link) => link.child_execution_id === childExecutionId)
        .filter((link) => terminalTurnIds.has(String(link.turn_id)))
        .filter((link) => cancellationTurnIds.has(String(link.turn_id)))
        .filter((link) => {
          const termination = terminationByTurn.get(String(link.turn_id));
          return termination && ['interrupted', 'cancelled'].includes(String(termination.terminal_status));
        })
        .sort((left, right) => compareCounter(right.turn_seq, left.turn_seq))[0];
      if (!cancellationTurn) {
        if (child.status === 'interrupted' && await this.closeEmptyInterruptedBridge(bridge)) {
          affectedIds.push(childExecutionId);
        }
        continue;
      }
      partialCandidates += 1;
      const turnId = String(cancellationTurn.turn_id);
      const termination = terminationByTurn.get(turnId)!;
      const reason = typeof termination.reason === 'string' && termination.reason.trim()
        ? termination.reason.trim()
        : 'Extension Host restart recovered an interrupted child partial answer.';
      const partial = await this.answers.ensureInterruptedPartial({ childExecutionId, turnId, reason });
      if (!partial) {
        unchanged += 1;
        continue;
      }
      await this.answers.reconcileCommittedWaits(partial.submissionId);
      const disposition = await this.answers.classifyDeliveryRecovery(partial.submissionId);
      if (disposition.kind === 'delivery_required') await this.deliveries.createAutomatic({
        inboxItemId: disposition.command.inboxItemId,
        targetConversationId: disposition.command.targetConversationId,
        sourceTurnId: disposition.automaticSourceTurnId
      });
      affectedIds.push(childExecutionId);
    }
    return {
      id: PHASE_F_RECOVERY_INTERRUPTED_SUBTREE_INCOMPLETE,
      scanned: roots.length + terminalWaitCandidates + partialCandidates,
      reconciled: new Set(affectedIds).size,
      unchanged,
      affectedIds: [...new Set(affectedIds)]
    };
  }

  private async closeEmptyInterruptedBridge(bridge: DomainRow): Promise<boolean> {
    const bridgeId = String(bridge.id);
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(bridgeId, {
          status: 'interrupted',
          current_submission_id: null
        }),
        DOMAIN_REPOSITORIES.domain('AnswerBridge').update(bridgeId, {
          status: 'closed',
          updated_at: now
        })
      ]);
      return true;
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const snapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('AnswerBridge').get(bridgeId)
      ]);
      const current = requireRow(snapshot.snapshot[0], `AnswerBridge ${bridgeId}`);
      if (current.status === 'closed' || current.current_submission_id !== null) return false;
      throw error;
    }
  }

  /** Bulk-resolves legacy bridge owners and deterministic future-Turn owners without row caps. */
  private async resolveContinuationWaitOwners(
    operations: DomainRow[]
  ): Promise<Map<string, ContinuationWaitOwner>> {
    const result = new Map<string, ContinuationWaitOwner>();
    if (operations.length === 0) return result;
    const generationOperations = operations.filter((operation) =>
      operation.owner_kind === CHILD_TURN_ANSWER_WAIT_OWNER_KIND
    );
    const legacyOperations = operations.filter((operation) =>
      operation.owner_kind === LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND
    );
    if (generationOperations.length + legacyOperations.length !== operations.length) {
      throw new Error('Continuation owner resolution received an unsupported Operation owner_kind.');
    }

    const generationOwnerIds = new Set(generationOperations.map((operation) =>
      String(operation.owner_id)
    ));
    const childByGeneration = new Map<string, string>();
    if (generationOwnerIds.size > 0) {
      const intentLinks = await listAllDomainRows(this.database, 'ChildExecutionIntentLink');
      for (const link of intentLinks) {
        const childExecutionId = String(link.child_execution_id);
        const targetTurnId = childContinuationTurnId(
          childExecutionId,
          String(link.turn_intent_id)
        );
        if (!generationOwnerIds.has(targetTurnId)) continue;
        const existing = childByGeneration.get(targetTurnId);
        if (existing && existing !== childExecutionId) {
          throw new Error(`Continuation generation ${targetTurnId} maps to multiple ChildExecutions.`);
        }
        childByGeneration.set(targetTurnId, childExecutionId);
      }
      for (const ownerId of generationOwnerIds) {
        if (!childByGeneration.has(ownerId)) {
          throw new Error(`Continuation generation ${ownerId} has no exact ChildExecutionIntentLink.`);
        }
      }
    }

    const generationChildIds = [...new Set(childByGeneration.values())];
    const legacyBridgeIds = [...new Set(legacyOperations.map((operation) =>
      String(operation.owner_id)
    ))];
    const ownerSnapshot = await this.database.snapshot([
      ...legacyBridgeIds.map((bridgeId) => DOMAIN_REPOSITORIES.domain('AnswerBridge').get(bridgeId)),
      ...generationChildIds.map((childExecutionId) =>
        DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
          where: { child_execution_id: childExecutionId },
          limit: 2
        })
      )
    ]);
    const legacyBridgeById = new Map(legacyBridgeIds.map((bridgeId, index) => [
      bridgeId,
      requireRow(ownerSnapshot.snapshot[index], `AnswerBridge ${bridgeId}`)
    ]));
    const bridgeByChild = new Map<string, DomainRow>();
    for (const [index, childExecutionId] of generationChildIds.entries()) {
      const rows = requireRows(
        ownerSnapshot.snapshot[legacyBridgeIds.length + index],
        `AnswerBridge ${childExecutionId} lookup`
      );
      if (rows.length !== 1) {
        throw new Error(`ChildExecution ${childExecutionId} must retain exactly one AnswerBridge.`);
      }
      bridgeByChild.set(childExecutionId, rows[0]);
    }

    for (const operation of generationOperations) {
      const childExecutionId = childByGeneration.get(String(operation.owner_id))!;
      result.set(String(operation.id), {
        childExecutionId,
        answerBridge: bridgeByChild.get(childExecutionId)!
      });
    }
    for (const operation of legacyOperations) {
      const bridge = legacyBridgeById.get(String(operation.owner_id))!;
      result.set(String(operation.id), {
        childExecutionId: String(bridge.child_execution_id),
        answerBridge: bridge
      });
    }
    return result;
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'Phase F recovery clock');
  }
}

function compareCounter(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right));
  return leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new Error(`${label} did not return rows.`);
  return value as DomainRow[];
}

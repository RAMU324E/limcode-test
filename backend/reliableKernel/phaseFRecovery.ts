import { AnswerControlPlane, RuntimeDeliveryControlPlane } from './answerDelivery';
import { ChildExecutionControlPlane } from './childExecution';
import { requireIsoTimestamp } from './phaseFIdentity';
import { type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export const PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT = 'recovery.answer-inbox-invariant';
export const PHASE_F_RECOVERY_DELIVERY_PENDING = 'recovery.delivery-pending';
export const PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED = 'recovery.foreground-answer-wait-expired';
export const PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE = 'recovery.cancelled-subtree-incomplete';

export type PhaseFRecoveryId =
  | typeof PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT
  | typeof PHASE_F_RECOVERY_DELIVERY_PENDING
  | typeof PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED
  | typeof PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE;

export interface PhaseFRecoveryResult {
  id: PhaseFRecoveryId;
  scanned: number;
  reconciled: number;
  unchanged: number;
  affectedIds: string[];
}

/** Registers exactly the four Phase F-owned startup scans on top of the Phase D scanner pattern. */
export class PhaseFRecoveryScanner {
  private readonly handlers: ReadonlyMap<PhaseFRecoveryId, () => Promise<PhaseFRecoveryResult>>;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly answers: AnswerControlPlane,
    private readonly deliveries: RuntimeDeliveryControlPlane,
    private readonly children: ChildExecutionControlPlane,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.handlers = new Map<PhaseFRecoveryId, () => Promise<PhaseFRecoveryResult>>([
      [PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT, () => this.scanAnswerInboxInvariant()],
      [PHASE_F_RECOVERY_DELIVERY_PENDING, () => this.scanPendingDeliveries()],
      [PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED, () => this.scanExpiredForegroundWaits()],
      [PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE, () => this.scanIncompleteCancelledSubtrees()]
    ]);
  }

  public ids(): PhaseFRecoveryId[] {
    return [...this.handlers.keys()];
  }

  public async run(id: PhaseFRecoveryId): Promise<PhaseFRecoveryResult> {
    const handler = this.handlers.get(id);
    if (!handler) throw new Error(`Phase F does not own recovery scan ${String(id)}.`);
    return handler();
  }

  public async runAll(): Promise<PhaseFRecoveryResult[]> {
    return [
      await this.run(PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT),
      await this.run(PHASE_F_RECOVERY_DELIVERY_PENDING),
      await this.run(PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED),
      await this.run(PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE)
    ];
  }

  private async scanAnswerInboxInvariant(): Promise<PhaseFRecoveryResult> {
    const submissions = await listAllDomainRows(this.database, 'AnswerSubmission');
    const inboxItems = await listAllDomainRows(this.database, 'RuntimeInboxItem', {
      source_kind: 'answer_submission'
    });
    const inboxIdentities = new Set(inboxItems.map((item) =>
      `${String(item.dedupe_key)}\0${String(item.source_id)}`
    ));
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const submission of submissions) {
      const submissionId = String(submission.id);
      const expectedDedupeKey = `answer:${String(submission.answer_bridge_id)}:${submissionId}`;
      if (inboxIdentities.has(`${expectedDedupeKey}\0${submissionId}`)) {
        unchanged += 1;
        continue;
      }
      const result = await this.answers.ensureInboxForSubmission(submissionId);
      if (result.created) affectedIds.push(submissionId);
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

  private async scanPendingDeliveries(): Promise<PhaseFRecoveryResult> {
    const pending = await listAllDomainRows(this.database, 'RuntimeDelivery', { state: 'pending' });
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const delivery of pending) {
      const result = await this.deliveries.advance(String(delivery.id));
      if (result.changed) affectedIds.push(String(delivery.id));
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

  private async scanExpiredForegroundWaits(): Promise<PhaseFRecoveryResult> {
    const now = this.timestamp();
    const executions = await listAllDomainRows(this.database, 'ToolExecution', {
      status: 'waiting_answer'
    });
    const links = await listAllDomainRows(this.database, 'ChildExecutionParentLink');
    const childByToolCall = new Map(links.map((link) => [
      String(link.source_tool_call_id),
      String(link.child_execution_id)
    ]));
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const execution of executions) {
      const deadline = execution.wait_deadline_at;
      if (typeof deadline !== 'string' || Date.parse(deadline) > Date.parse(now)) {
        unchanged += 1;
        continue;
      }
      const childExecutionId = childByToolCall.get(String(execution.tool_call_id));
      if (!childExecutionId) {
        throw new Error(`Expired subagent ToolExecution ${String(execution.id)} has no ChildExecution ParentLink.`);
      }
      if (await this.children.settleForegroundTimeout(childExecutionId, now)) {
        affectedIds.push(String(execution.id));
      } else {
        unchanged += 1;
      }
    }
    return {
      id: PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED,
      scanned: executions.length,
      reconciled: affectedIds.length,
      unchanged,
      affectedIds
    };
  }

  private async scanIncompleteCancelledSubtrees(): Promise<PhaseFRecoveryResult> {
    const roots = await listAllDomainRows(this.database, 'ChildExecution', {
      status: 'cancel_subtree_requested'
    });
    const affectedIds: string[] = [];
    let unchanged = 0;
    for (const root of roots) {
      const result = await this.children.cancelSubtree({
        sourceKey: `recovery:cancel-subtree:${String(root.id)}`,
        childExecutionId: String(root.id),
        reason: 'Extension Host restart resumed an incomplete cancel_subtree request.'
      });
      if (result.terminationRequestsWritten > 0 || result.intentsCancelled > 0) {
        affectedIds.push(String(root.id));
      } else {
        unchanged += 1;
      }
    }
    return {
      id: PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE,
      scanned: roots.length,
      reconciled: affectedIds.length,
      unchanged,
      affectedIds
    };
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'Phase F recovery clock');
  }
}

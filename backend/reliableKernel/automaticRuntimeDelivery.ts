import type { RuntimeDeliveryPhase } from './answerDelivery';
import {
  isChildExecutionInterrupting,
  isChildExecutionPermanentlyTerminal,
  requireChildExecutionStatus
} from './childExecutionState';
import {
  isTransactionAssertionFailure,
  sqliteUniqueFailureIncludes,
  stablePhaseFId
} from './phaseFIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export type AutomaticRuntimeDeliveryReason =
  | 'source_turn_active'
  | 'source_turn_final_output_fenced'
  | 'source_turn_completed'
  | 'source_turn_not_successful'
  | 'source_turn_missing'
  | 'source_turn_conversation_mismatch'
  | 'conversation_not_active'
  | 'terminal_evidence_incomplete'
  | 'child_generation_stale_or_terminal';

export interface AutomaticRuntimeDeliveryDecision {
  phase: RuntimeDeliveryPhase;
  targetTurnId: string | null;
  sourceTurnId: string;
  targetConversationId: string;
  reason: AutomaticRuntimeDeliveryReason;
  childExecutionId: string | null;
  /** CAS assertions that preserve the authority snapshot until delivery injection/retarget. */
  authoritySteps: RepositoryTransactionStep[];
}

interface ChildGenerationAuthority {
  childExecutionId: string;
  currentAllowed: boolean;
  continuationAllowed: boolean;
  steps: RepositoryTransactionStep[];
}

const TERMINAL_FAILURES = new Set(['interrupted', 'cancelled', 'failed', 'outcome_unknown']);
/**
 * One fail-closed policy for automatic Process/Child answer delivery.
 *
 * It deliberately routes from the immutable source Turn, never from whichever Turn happens to be
 * active when a delayed callback arrives. Callers must include `authoritySteps` in the transaction
 * that injects/retargets the delivery; a read-only decision is only a scheduling hint.
 */
export class AutomaticRuntimeDeliveryRouter {
  public constructor(private readonly database: RuntimeDatabase) {}

  /**
   * Fences a no-tool-call Provider result before it becomes visible. A delivery that won first
   * makes this return false so the Agent loop absorbs it and asks the model for a new final answer.
   */
  public async establishFinalOutputFence(input: {
    turnId: string;
    modelRequestId: string;
  }): Promise<{ established: boolean; fenceId: string }> {
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const fenceId = stablePhaseFId('turn_final_output_fence', turnId, modelRequestId);
    const existing = await this.list('TurnFinalOutputFence', { turn_id: turnId }, 2);
    if (existing.length > 1) throw new Error(`Turn ${turnId} has multiple final-output fences.`);
    if (existing.length === 1) {
      assertFinalFenceReplay(existing[0], fenceId, turnId, modelRequestId);
      return { established: true, fenceId };
    }
    const [turn, request] = await Promise.all([
      this.requireExisting('Turn', turnId),
      this.requireExisting('ModelRequest', modelRequestId)
    ]);
    if (turn.status !== 'active' || request.turn_id !== turnId || request.status !== 'terminal') {
      return { established: false, fenceId };
    }
    const now = new Date().toISOString();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
          turn_id: turnId,
          status: 'terminal'
        }),
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assertNone({ model_request_id: modelRequestId }),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertNone({
          target_turn_id: turnId,
          phase: 'current_turn',
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').assertNone({
          turn_id: turnId,
          input_kind: 'runtime_delivery',
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').insert({
          id: fenceId,
          turn_id: turnId,
          model_request_id: modelRequestId,
          created_at: now
        })
      ]);
      return { established: true, fenceId };
    } catch (error) {
      const raced = await this.list('TurnFinalOutputFence', { turn_id: turnId }, 2);
      if (raced.length === 1) {
        assertFinalFenceReplay(raced[0], fenceId, turnId, modelRequestId);
        return { established: true, fenceId };
      }
      if (isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
        'turn_final_output_fence.id',
        'turn_final_output_fence.turn_id',
        'turn_final_output_fence.model_request_id'
      ])) return { established: false, fenceId };
      throw error;
    }
  }

  public async resolve(input: {
    targetConversationId: string;
    sourceTurnId: string;
  }): Promise<AutomaticRuntimeDeliveryDecision> {
    const targetConversationId = requireId(input.targetConversationId, 'targetConversationId');
    const sourceTurnId = requireId(input.sourceTurnId, 'sourceTurnId');
    const [conversation, sourceTurn] = await Promise.all([
      this.maybeGet('Conversation', targetConversationId),
      this.maybeGet('Turn', sourceTurnId)
    ]);
    if (!sourceTurn) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_missing'
      });
    }
    if (sourceTurn.conversation_id !== targetConversationId) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_conversation_mismatch'
      });
    }
    if (!conversation || conversation.status !== 'active') {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'conversation_not_active'
      });
    }

    const [terminations, fences, childAuthority] = await Promise.all([
      this.list('TurnTermination', { turn_id: sourceTurnId }, 2),
      this.list('TurnFinalOutputFence', { turn_id: sourceTurnId }, 2),
      this.childGenerationAuthority(sourceTurnId)
    ]);
    if (terminations.length > 1) throw new Error(`Turn ${sourceTurnId} has multiple TurnTerminations.`);
    if (fences.length > 1) throw new Error(`Turn ${sourceTurnId} has multiple final-output fences.`);
    const common: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Conversation').assert(targetConversationId, { status: 'active' }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, {
        conversation_id: targetConversationId,
        status: sourceTurn.status
      }),
      ...childAuthority.steps
    ];

    if (sourceTurn.status === 'active') {
      if (terminations.length !== 0) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'terminal_evidence_incomplete',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: common
        });
      }
      if (fences.length === 1) {
        if (!childAuthority.continuationAllowed) {
          return decision({
            targetConversationId,
            sourceTurnId,
            reason: 'child_generation_stale_or_terminal',
            childExecutionId: childAuthority.childExecutionId,
            authoritySteps: common
          });
        }
        const fence = fences[0];
        return decision({
          phase: 'next_turn',
          targetConversationId,
          sourceTurnId,
          reason: 'source_turn_final_output_fenced',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: [
            ...common,
            DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: sourceTurnId }),
            DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assert(requireId(fence.id, 'TurnFinalOutputFence.id'), {
              turn_id: sourceTurnId,
              model_request_id: fence.model_request_id
            })
          ]
        });
      }
      if (!childAuthority.currentAllowed) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'child_generation_stale_or_terminal',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: common
        });
      }
      return decision({
        phase: 'current_turn',
        targetTurnId: sourceTurnId,
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_active',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: [
          ...common,
          DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: sourceTurnId }),
          DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: sourceTurnId })
        ]
      });
    }

    if (sourceTurn.status !== 'terminated' || terminations.length !== 1) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'terminal_evidence_incomplete',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: common
      });
    }
    const termination = terminations[0];
    const terminalStatus = String(termination.terminal_status);
    const terminalSteps = [
      ...common,
      DOMAIN_REPOSITORIES.domain('TurnTermination').assert(requireId(termination.id, 'TurnTermination.id'), {
        turn_id: sourceTurnId,
        terminal_status: terminalStatus
      })
    ];
    if (terminalStatus === 'completed') {
      if (!childAuthority.continuationAllowed) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'child_generation_stale_or_terminal',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: terminalSteps
        });
      }
      return decision({
        phase: 'next_turn',
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_completed',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: terminalSteps
      });
    }
    if (!TERMINAL_FAILURES.has(terminalStatus)) {
      throw new Error(`Turn ${sourceTurnId} has unsupported terminal status ${terminalStatus}.`);
    }
    return decision({
      targetConversationId,
      sourceTurnId,
      reason: 'source_turn_not_successful',
      childExecutionId: childAuthority.childExecutionId,
      authoritySteps: terminalSteps
    });
  }

  /** Revalidates and, if necessary, retargets one still-pending delivery in the same CAS. */
  public async reconcilePendingDelivery(input: {
    deliveryId: string;
    targetConversationId: string;
    sourceTurnId: string;
  }): Promise<{ delivery: DomainRow; decision: AutomaticRuntimeDeliveryDecision; changed: boolean }> {
    const deliveryId = requireId(input.deliveryId, 'deliveryId');
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    const decision = await this.resolve(input);
    if (delivery.state !== 'pending') return { delivery, decision, changed: false };
    if (delivery.target_conversation_id !== decision.targetConversationId) {
      throw new Error('RuntimeDelivery target Conversation conflicts with automatic delivery authority.');
    }
    const changed = delivery.phase !== decision.phase || delivery.target_turn_id !== decision.targetTurnId;
    const now = new Date().toISOString();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
        state: 'pending',
        phase: delivery.phase,
        target_turn_id: delivery.target_turn_id,
        target_conversation_id: decision.targetConversationId,
        attempt_seq: delivery.attempt_seq
      }),
      ...decision.authoritySteps,
      ...(changed ? [DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
        phase: decision.phase,
        target_turn_id: decision.targetTurnId,
        updated_at: now
      })] : [])
    ]);
    return {
      delivery: await this.requireExisting('RuntimeDelivery', deliveryId),
      decision,
      changed
    };
  }

  private async childGenerationAuthority(sourceTurnId: string): Promise<ChildGenerationAuthority> {
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: sourceTurnId }, 2);
    if (memberships.length > 1) throw new Error(`Turn ${sourceTurnId} belongs to multiple ChildExecutions.`);
    if (memberships.length === 0) {
      return { childExecutionId: '', currentAllowed: true, continuationAllowed: true, steps: [] };
    }
    const membership = memberships[0];
    const childExecutionId = requireId(membership.child_execution_id, 'ChildExecutionTurnLink.child_execution_id');
    const [child, lineage, activeLinks] = await Promise.all([
      this.requireExisting('ChildExecution', childExecutionId),
      listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
        child_execution_id: childExecutionId
      }),
      this.list('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId }, 2)
    ]);
    if (activeLinks.length > 1) throw new Error(`ChildExecution ${childExecutionId} has multiple active Turn links.`);
    const latest = [...lineage].sort((left, right) => compareInteger(right.turn_seq, left.turn_seq))[0];
    if (!latest) throw new Error(`ChildExecution ${childExecutionId} has no Turn lineage.`);
    const active = activeLinks[0] ?? null;
    const status = requireChildExecutionStatus(child.status);
    const isLatest = latest.turn_id === sourceTurnId;
    const blocked = isChildExecutionInterrupting(status)
      || status === 'interrupted'
      || isChildExecutionPermanentlyTerminal(status);
    const currentAllowed = isLatest
      && !blocked
      && status === 'active'
      && active?.turn_id === sourceTurnId;
    const continuationAllowed = isLatest
      && !blocked
      && (status === 'active' || status === 'idle')
      && (active === null || active.turn_id === sourceTurnId);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, { status: child.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(requireId(membership.id, 'ChildExecutionTurnLink.id'), {
        child_execution_id: childExecutionId,
        turn_id: sourceTurnId,
        turn_seq: membership.turn_seq
      }),
      ...(active ? [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
        requireId(active.id, 'ChildExecutionActiveTurnLink.id'),
        { child_execution_id: childExecutionId, turn_id: active.turn_id }
      )] : [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
        child_execution_id: childExecutionId
      })])
    ];
    return { childExecutionId, currentAllowed, continuationAllowed, steps };
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

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0] as DomainRow[];
  }
}

function decision(input: {
  phase?: RuntimeDeliveryPhase;
  targetTurnId?: string | null;
  targetConversationId: string;
  sourceTurnId: string;
  reason: AutomaticRuntimeDeliveryReason;
  childExecutionId?: string;
  authoritySteps?: RepositoryTransactionStep[];
}): AutomaticRuntimeDeliveryDecision {
  return {
    phase: input.phase ?? 'notify_only',
    targetTurnId: input.targetTurnId ?? null,
    targetConversationId: input.targetConversationId,
    sourceTurnId: input.sourceTurnId,
    reason: input.reason,
    childExecutionId: input.childExecutionId || null,
    authoritySteps: input.authoritySteps ?? []
  };
}

function compareInteger(left: unknown, right: unknown): number {
  const a = requireBigInt(left, 'integer');
  const b = requireBigInt(right, 'integer');
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertFinalFenceReplay(
  fence: DomainRow,
  fenceId: string,
  turnId: string,
  modelRequestId: string
): void {
  if (fence.id !== fenceId || fence.turn_id !== turnId || fence.model_request_id !== modelRequestId) {
    throw new Error('Turn final-output fence identity was replayed with different facts.');
  }
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

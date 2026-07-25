import type {
  AttemptRecord,
  ChildTurnLinkRecord,
  DurableInteractionRequestRecord,
  ExecutionLeaseRecord,
  InteractionOwnerLinkRecord,
  OperationRecord,
  RunProgressSnapshot,
  TurnRecord
} from '../../shared/conversationReliability';
import {
  RUN_PHASE_METADATA,
  isTerminalRunLifecycle,
  phaseAcceptsLifecycle,
  type RunProgressSourceKind
} from '../../shared/runLifecycle';
import type { RunId } from '../../shared/stableIds';
import { isConversationOperationOwner } from './domain/operationOwner';

export interface RunInvariantFacts {
  turns: readonly TurnRecord[];
  leases: readonly ExecutionLeaseRecord[];
  operations: readonly OperationRecord[];
  attempts: readonly AttemptRecord[];
  interactions: readonly DurableInteractionRequestRecord[];
  interactionOwners: readonly InteractionOwnerLinkRecord[];
  childTurnLinks: readonly ChildTurnLinkRecord[];
  pauses: readonly { runId: RunId }[];
  additionalProgress?: ReadonlyMap<RunId, Partial<Record<RunProgressSourceKind, number>>>;
}

export class RunInvariantViolation extends Error {
  public constructor(public readonly violations: readonly string[]) {
    super(`Run invariant validation failed:\n${violations.map((item) => `- ${item}`).join('\n')}`);
    this.name = 'RunInvariantViolation';
  }
}

export function validateRunInvariants(facts: RunInvariantFacts): void {
  const violations: string[] = [];
  const runsById = uniqueById(facts.turns, 'Run', violations);
  uniqueById(facts.operations, 'Operation', violations);
  uniqueById(facts.attempts, 'Attempt', violations);

  const leasesByConversation = new Map<string, ExecutionLeaseRecord[]>();
  const leasesByTurn = new Map<string, ExecutionLeaseRecord[]>();
  for (const lease of facts.leases) {
    push(leasesByConversation, lease.conversationId, lease);
    if (lease.state !== 'released') push(leasesByTurn, lease.turnId, lease);
  }
  for (const [conversationId, leases] of leasesByConversation) {
    if (leases.length > 1) violations.push(`Conversation ${conversationId} has ${leases.length} execution-lease records.`);
    if (leases.filter((lease) => lease.state !== 'released').length > 1) {
      violations.push(`Conversation ${conversationId} has multiple effective execution leases.`);
    }
  }

  const operationsByRun = groupBy(
    facts.operations.filter((operation) => !isConversationOperationOwner(operation)),
    (operation) => operation.ownerRunId
  );
  const attemptsByOperation = groupBy(facts.attempts, (attempt) => attempt.operationId);

  for (const run of runsById.values()) {
    const slots = leasesByTurn.get(run.id) ?? [];
    const activeOperations = (operationsByRun.get(run.id) ?? [])
      .filter((operation) => operation.state === 'pending' || operation.state === 'running');
    const activeAttempts = activeOperations.flatMap((operation) => (attemptsByOperation.get(operation.id) ?? [])
      .filter((attempt) => attempt.generation === operation.currentGeneration
        && (attempt.state === 'pending' || attempt.state === 'dispatched')));

    if (!phaseAcceptsLifecycle(run.phase, run.lifecycle)) {
      violations.push(`Run ${run.id} phase ${run.phase} is incompatible with lifecycle ${run.lifecycle}.`);
    }
    const metadata = RUN_PHASE_METADATA[run.phase];
    if (metadata.requiresSlot && slots.length !== 1) violations.push(`Run ${run.id} phase ${run.phase} requires exactly one slot.`);
    if (!metadata.requiresSlot && slots.length !== 0) violations.push(`Run ${run.id} phase ${run.phase} must not hold a slot.`);
    if (run.lifecycle === 'active' && slots.length !== 1) violations.push(`Active Run ${run.id} does not uniquely hold its conversation slot.`);
    if (run.lifecycle !== 'active' && slots.length > 0) violations.push(`Non-active Run ${run.id} still holds a slot.`);

    if (isTerminalRunLifecycle(run.lifecycle)) {
      if (run.phase !== 'terminal') violations.push(`Terminal Run ${run.id} is not in terminal phase.`);
      if (run.completedAt === undefined) violations.push(`Terminal Run ${run.id} has no completedAt.`);
      if (activeOperations.length > 0 || activeAttempts.length > 0) {
        violations.push(`Terminal Run ${run.id} retains active Operation/Attempt.`);
      }
    }

    for (const operation of activeOperations) {
      if (!Number.isFinite(operation.currentGeneration) || operation.currentGeneration < 1) {
        violations.push(`Active Operation ${operation.id} has invalid generation ${operation.currentGeneration}.`);
      }
      const currentAttempts = (attemptsByOperation.get(operation.id) ?? [])
        .filter((attempt) => attempt.generation === operation.currentGeneration
          && (attempt.state === 'pending' || attempt.state === 'dispatched'));
      if (currentAttempts.length !== 1) {
        violations.push(`Active Operation ${operation.id} has ${currentAttempts.length} active Attempts for generation ${operation.currentGeneration}.`);
      }
      for (const attempt of currentAttempts) {
        if (!Number.isFinite(attempt.deadlineAt) || attempt.deadlineAt <= 0) {
          violations.push(`Active Attempt ${attempt.id} has no valid deadline.`);
        }
      }
    }

    const progress = progressSnapshot(
      run,
      activeOperations,
      activeAttempts,
      slots.length === 1,
      mergeProgress(canonicalBlockerProgress(facts, run.id), facts.additionalProgress?.get(run.id))
    );
    for (const [kind, bounds] of Object.entries(metadata.progress) as Array<[RunProgressSourceKind, { min: number; max: number }]>) {
      const count = progress.counts[kind] ?? 0;
      if (count < bounds.min || count > bounds.max) {
        violations.push(`Run ${run.id} phase ${run.phase} requires ${formatBounds(bounds)} ${kind} source(s), found ${count}.`);
      }
    }
    if (run.phase === 'waiting_tools') {
      const activeToolProgress = (progress.counts.tool_operation ?? 0)
        + (progress.counts.tool_wait ?? 0)
        + (progress.counts.child_delivery_wait ?? 0)
        + (progress.counts.user_wait ?? 0)
        + (progress.counts.plan_review_wait ?? 0);
      if (activeToolProgress < 1) violations.push(`Run ${run.id} phase waiting_tools has no durable tool progress source.`);
    }
    const allowed = new Set(Object.keys(metadata.progress));
    for (const [kind, count] of Object.entries(progress.counts) as Array<[RunProgressSourceKind, number]>) {
      if (count > 0 && !allowed.has(kind)) {
        violations.push(`Run ${run.id} phase ${run.phase} has disallowed progress source ${kind}.`);
      }
    }

    if (run.phase === 'waiting_child_run') {
      const children = facts.childTurnLinks.filter((link) => link.parentTurnId === run.id && link.mode === 'foreground');
      if (children.length === 0) violations.push(`Run ${run.id} has no foreground ChildTurnLink.`);
    }
  }

  for (const operation of facts.operations.filter((candidate) =>
    isConversationOperationOwner(candidate) && (candidate.state === 'pending' || candidate.state === 'running'))) {
    if (!Number.isFinite(operation.currentGeneration) || operation.currentGeneration < 1) {
      violations.push(`Active conversation Operation ${operation.id} has invalid generation ${operation.currentGeneration}.`);
    }
    const currentAttempts = (attemptsByOperation.get(operation.id) ?? []).filter((attempt) =>
      attempt.generation === operation.currentGeneration
      && (attempt.state === 'pending' || attempt.state === 'dispatched'));
    if (currentAttempts.length !== 1) {
      violations.push(`Active conversation Operation ${operation.id} has ${currentAttempts.length} active Attempts for generation ${operation.currentGeneration}.`);
    }
    for (const attempt of currentAttempts) {
      if (!Number.isFinite(attempt.deadlineAt) || attempt.deadlineAt <= 0) {
        violations.push(`Active conversation Attempt ${attempt.id} has no valid deadline.`);
      }
    }
  }

  for (const lease of facts.leases) {
    if (!runsById.has(lease.turnId)) violations.push(`Execution lease ${lease.id} references missing Turn ${lease.turnId}.`);
    if (!Number.isInteger(lease.epoch) || lease.epoch < 1) violations.push(`Execution lease ${lease.id} has invalid epoch ${lease.epoch}.`);
    if (lease.state === 'released' && lease.releasedAt === undefined) {
      violations.push(`Released execution lease ${lease.id} has no releasedAt.`);
    }
  }

  if (violations.length > 0) throw new RunInvariantViolation(violations);
}

export function collectRunProgressSnapshots(facts: RunInvariantFacts): RunProgressSnapshot[] {
  const operationsByRun = groupBy(
    facts.operations.filter((operation) => !isConversationOperationOwner(operation)),
    (operation) => operation.ownerRunId
  );
  const attemptsByOperation = groupBy(facts.attempts, (attempt) => attempt.operationId);
  const leasesByTurn = groupBy(facts.leases.filter((lease) => lease.state !== 'released'), (lease) => lease.turnId);
  return facts.turns.map((run) => {
    const activeOperations = (operationsByRun.get(run.id) ?? [])
      .filter((operation) => operation.state === 'pending' || operation.state === 'running');
    const activeAttempts = activeOperations.flatMap((operation) => (attemptsByOperation.get(operation.id) ?? [])
      .filter((attempt) => attempt.generation === operation.currentGeneration
        && (attempt.state === 'pending' || attempt.state === 'dispatched')));
    return progressSnapshot(
      run,
      activeOperations,
      activeAttempts,
      (leasesByTurn.get(run.id) ?? []).length === 1,
      mergeProgress(canonicalBlockerProgress(facts, run.id), facts.additionalProgress?.get(run.id))
    );
  }).sort((left, right) => left.runId.localeCompare(right.runId));
}

function progressSnapshot(
  run: TurnRecord,
  operations: readonly OperationRecord[],
  attempts: readonly AttemptRecord[],
  hasSlot: boolean,
  additional: Partial<Record<RunProgressSourceKind, number>> | undefined
): RunProgressSnapshot {
  const counts: Partial<Record<RunProgressSourceKind, number>> = { ...(additional ?? {}) };
  const activeAttemptOperationIds = new Set(attempts.map((attempt) => attempt.operationId));
  for (const operation of operations) {
    if (!activeAttemptOperationIds.has(operation.id)) continue;
    const kind = progressKindForOperation(operation.kind);
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return {
    runId: run.id,
    lifecycle: run.lifecycle,
    phase: run.phase,
    hasSlot,
    counts,
    completedAt: run.completedAt
  };
}

function canonicalBlockerProgress(
  facts: RunInvariantFacts,
  runId: RunId
): Partial<Record<RunProgressSourceKind, number>> {
  const counts: Partial<Record<RunProgressSourceKind, number>> = {};
  const pending = new Map(facts.interactions
    .filter((interaction) => interaction.state === 'pending')
    .map((interaction) => [interaction.id, interaction]));
  for (const owner of facts.interactionOwners.filter((candidate) => candidate.turnId === runId)) {
    const interaction = pending.get(owner.interactionRequestId);
    if (!interaction) continue;
    const kind: RunProgressSourceKind = interaction.kind === 'ask_user'
      ? 'user_wait'
      : interaction.kind === 'plan_review'
        ? 'plan_review_wait'
        : 'tool_wait';
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const foregroundChildren = facts.childTurnLinks.filter((link) => link.parentTurnId === runId && link.mode === 'foreground').length;
  if (foregroundChildren > 0) counts.child_delivery_wait = foregroundChildren;
  const pauses = facts.pauses.filter((pause) => pause.runId === runId).length;
  if (pauses > 0) counts.pause_record = pauses;
  return counts;
}

function mergeProgress(
  left: Partial<Record<RunProgressSourceKind, number>>,
  right: Partial<Record<RunProgressSourceKind, number>> | undefined
): Partial<Record<RunProgressSourceKind, number>> {
  const result = { ...left };
  for (const [kind, count] of Object.entries(right ?? {}) as Array<[RunProgressSourceKind, number]>) {
    result[kind] = (result[kind] ?? 0) + count;
  }
  return result;
}

function progressKindForOperation(kind: string): RunProgressSourceKind | undefined {
  if (kind.startsWith('context.')) return 'context_operation';
  if (kind.startsWith('compression.')) return 'compression_operation';
  if (kind === 'invocation.resolve') return 'invocation_operation';
  if (kind.startsWith('checkpoint.')) return 'checkpoint_operation';
  if (kind === 'llm.request') return 'request_operation';
  if (kind.startsWith('tool.')) return 'tool_operation';
  return undefined;
}

function uniqueById<T extends { id: string }>(records: readonly T[], label: string, violations: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    if (result.has(record.id)) violations.push(`${label} Stable ID is duplicated: ${record.id}.`);
    else result.set(record.id, record);
  }
  return result;
}

function groupBy<T>(records: readonly T[], key: (record: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const record of records) push(result, key(record), record);
  return result;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const records = map.get(key) ?? [];
  records.push(value);
  map.set(key, records);
}

function formatBounds(bounds: { min: number; max: number }): string {
  if (bounds.min === bounds.max) return String(bounds.min);
  if (bounds.max === Number.POSITIVE_INFINITY) return `at least ${bounds.min}`;
  return `${bounds.min}..${bounds.max}`;
}

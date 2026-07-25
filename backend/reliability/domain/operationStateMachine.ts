import type {
  AttemptRecord,
  CleanupHint,
  EffectRecoveryPolicy,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor,
  RecordMutation,
  TimeoutPolicy
} from '../../../shared/conversationReliability';
import type { AttemptId, ConversationId, OperationId, RunId } from '../../../shared/stableIds';
import type { DurableConversationFacts, DurablePauseRecord } from './types';
import { isConversationOperationOwner, requireRunOperationOwner, sameOperationOwner } from './operationOwner';
import { terminalRunRecords } from './runTermination';
import { releaseExecutionLease } from './executionLease';

export interface PrimaryEffectKindDefinition {
  kind: string;
  recoveryPolicy: EffectRecoveryPolicy;
  idempotent: boolean;
  supportsAbort: boolean;
  defaultDeadlineMs: number;
  timeoutPolicy: TimeoutPolicy;
}

export class PrimaryEffectKindRegistry {
  private readonly definitions = new Map<string, PrimaryEffectKindDefinition>();

  public register(definition: PrimaryEffectKindDefinition): this {
    if (this.definitions.has(definition.kind)) throw new Error(`Primary effect kind already registered: ${definition.kind}`);
    if (!Number.isFinite(definition.defaultDeadlineMs) || definition.defaultDeadlineMs <= 0) throw new Error(`Primary effect kind ${definition.kind} has no valid deadline.`);
    if (!definition.idempotent && definition.recoveryPolicy === 'resume_pending_if_safe') {
      throw new Error(`Non-idempotent effect ${definition.kind} cannot use resume_pending_if_safe.`);
    }
    this.definitions.set(definition.kind, { ...definition });
    return this;
  }

  public require(kind: string): PrimaryEffectKindDefinition {
    const exact = this.definitions.get(kind);
    if (exact) return exact;
    const dynamic = [...this.definitions.values()]
      .filter((definition) => definition.kind.endsWith('.*') && kind.startsWith(definition.kind.slice(0, -1)))
      .sort((left, right) => right.kind.length - left.kind.length)[0];
    if (!dynamic) throw new Error(`Primary effect kind has no recovery policy: ${kind}`);
    return { ...dynamic, kind };
  }

  public list(): PrimaryEffectKindDefinition[] {
    return [...this.definitions.values()].sort((left, right) => left.kind.localeCompare(right.kind));
  }
}

export const primaryEffectKinds = new PrimaryEffectKindRegistry()
  .register({ kind: 'context.load', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: false, defaultDeadlineMs: 120_000, timeoutPolicy: 'retry_if_safe' })
  .register({ kind: 'context.build_llm_request', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: false, defaultDeadlineMs: 120_000, timeoutPolicy: 'retry_if_safe' })
  .register({ kind: 'invocation.resolve', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: false, defaultDeadlineMs: 60_000, timeoutPolicy: 'interrupt_run' })
  .register({ kind: 'llm.request', recoveryPolicy: 'interrupt_on_restart', idempotent: false, supportsAbort: true, defaultDeadlineMs: 10 * 60_000, timeoutPolicy: 'interrupt_run' })
  .register({ kind: 'compression.*', recoveryPolicy: 'interrupt_on_restart', idempotent: false, supportsAbort: true, defaultDeadlineMs: 5 * 60_000, timeoutPolicy: 'release_optional_barrier' })
  .register({ kind: 'checkpoint.*', recoveryPolicy: 'interrupt_on_restart', idempotent: false, supportsAbort: false, defaultDeadlineMs: 5 * 60_000, timeoutPolicy: 'release_optional_barrier' })
  .register({ kind: 'tool.read.*', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: true, defaultDeadlineMs: 5 * 60_000, timeoutPolicy: 'retry_if_safe' })
  .register({ kind: 'tool.write.*', recoveryPolicy: 'require_resolution', idempotent: false, supportsAbort: true, defaultDeadlineMs: 10 * 60_000, timeoutPolicy: 'require_resolution' })
  .register({ kind: 'tool.agent.*', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: true, defaultDeadlineMs: 30 * 60_000, timeoutPolicy: 'retry_if_safe' })
  .register({ kind: 'runtime.cleanup', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: false, defaultDeadlineMs: 60_000, timeoutPolicy: 'retry_if_safe' })
  .register({ kind: 'delivery.notification', recoveryPolicy: 'resume_pending_if_safe', idempotent: true, supportsAbort: false, defaultDeadlineMs: 60_000, timeoutPolicy: 'retry_if_safe' });

export type AttemptCasResult =
  | { status: 'matched'; operation: OperationRecord; attempt: AttemptRecord; effect?: PrimaryEffectDescriptor }
  | { status: 'stale'; reason: 'operation_missing' | 'attempt_missing' | 'generation_mismatch' | 'owner_terminal' | 'attempt_terminal' | 'operation_terminal' };

export function matchCurrentAttempt(
  facts: DurableConversationFacts,
  input: { operationId: OperationId; attemptId: AttemptId; generation: number }
): AttemptCasResult {
  const operation = unique(facts.operations, input.operationId);
  if (!operation) return { status: 'stale', reason: 'operation_missing' };
  const attempt = unique(facts.attempts, input.attemptId);
  if (!attempt || attempt.operationId !== operation.id) return { status: 'stale', reason: 'attempt_missing' };
  if (operation.currentGeneration !== input.generation || attempt.generation !== input.generation) return { status: 'stale', reason: 'generation_mismatch' };
  if (!isConversationOperationOwner(operation)) {
    const owner = unique(facts.turns, operation.ownerRunId);
    if (!owner || owner.phase === 'terminal') return { status: 'stale', reason: 'owner_terminal' };
  }
  if (attempt.state !== 'pending' && attempt.state !== 'dispatched') return { status: 'stale', reason: 'attempt_terminal' };
  if (operation.state !== 'pending' && operation.state !== 'running') return { status: 'stale', reason: 'operation_terminal' };
  const effect = facts.primaryEffects.find((candidate) => candidate.operationId === operation.id && candidate.attemptId === attempt.id && candidate.generation === input.generation);
  return { status: 'matched', operation, attempt, effect };
}

export interface AttemptTransition {
  mutations: RecordMutation[];
  result: JsonValue;
}

export function markAttemptDispatched(
  facts: DurableConversationFacts,
  input: { operationId: OperationId; attemptId: AttemptId; generation: number; now: number }
): AttemptTransition {
  const matched = matchCurrentAttempt(facts, input);
  if (matched.status === 'stale') return { mutations: [], result: { status: 'stale', reason: matched.reason } };
  if (matched.attempt.state === 'dispatched') return { mutations: [], result: { status: 'already_dispatched' } };
  if (!matched.effect) throw new Error(`Attempt ${input.attemptId} has no PrimaryEffectDescriptor.`);
  primaryEffectKinds.require(matched.effect.kind);
  return {
    mutations: [upsert('attempts', { ...matched.attempt, state: 'dispatched', dispatchedAt: input.now, rowVersion: matched.attempt.rowVersion + 1 })],
    result: { status: 'dispatched', attemptId: matched.attempt.id, generation: matched.attempt.generation }
  };
}

export function completeAttempt(
  facts: DurableConversationFacts,
  input: { operationId: OperationId; attemptId: AttemptId; generation: number; now: number; outcome: 'succeeded' | 'failed'; error?: string }
): AttemptTransition {
  const matched = matchCurrentAttempt(facts, input);
  if (matched.status === 'stale') return { mutations: [], result: { status: 'stale', reason: matched.reason } };
  const attemptState = input.outcome === 'succeeded' ? 'succeeded' : 'failed';
  const operationState = input.outcome === 'succeeded' ? 'succeeded' : 'failed';
  return {
    mutations: [
      upsert('attempts', { ...matched.attempt, state: attemptState, completedAt: input.now, rowVersion: matched.attempt.rowVersion + 1 }),
      upsert('operations', { ...matched.operation, state: operationState, completedAt: input.now, updatedAt: input.now, rowVersion: matched.operation.rowVersion + 1, ...(input.error ? { error: input.error } : {}) })
    ],
    result: { status: operationState, operationId: matched.operation.id, attemptId: matched.attempt.id }
  };
}

export interface RestartReconciliationResult {
  mutations: RecordMutation[];
  cleanupHints: CleanupHint[];
  diagnostics: Array<{ kind: 'interrupted' | 'outcome_unknown' | 'integrity_violation'; runId?: RunId; operationId?: OperationId; reason: string }>;
}

function hasPendingInteractionForTurn(facts: DurableConversationFacts, runId: RunId): boolean {
  const pendingIds = new Set(facts.interactionRequests
    .filter((request) => request.state === 'pending')
    .map((request) => request.id));
  return facts.interactionOwnerLinks.some((owner) => owner.turnId === runId
    && pendingIds.has(owner.interactionRequestId));
}

export function reconcileAfterRestart(facts: DurableConversationFacts, now: number): RestartReconciliationResult {
  const mutations: RecordMutation[] = [];
  const cleanupHints: CleanupHint[] = [];
  const diagnostics: RestartReconciliationResult['diagnostics'] = [];

  for (const run of facts.turns.filter((candidate) => candidate.lifecycle === 'active')) {
    if (run.phase === 'waiting_user' || run.phase === 'waiting_plan_review' || run.phase === 'waiting_child_run' || run.phase === 'paused') {
      const hasBlocker = run.phase === 'paused'
        ? facts.pauses.some((pause) => pause.runId === run.id)
        : run.phase === 'waiting_child_run'
          ? facts.childTurnLinks.some((link) => link.parentTurnId === run.id && link.mode === 'foreground')
          : hasPendingInteractionForTurn(facts, run.id);
      if (!hasBlocker) diagnostics.push({ kind: 'integrity_violation', runId: run.id, reason: `${run.phase}_without_canonical_blocker` });
      continue;
    }

    const operations = facts.operations.filter((operation) => operation.ownerRunId === run.id && (operation.state === 'pending' || operation.state === 'running'));
    if (run.phase === 'waiting_tools' && operations.length === 0) {
      const hasCanonicalBlocker = hasPendingInteractionForTurn(facts, run.id)
        || facts.childTurnLinks.some((link) => link.parentTurnId === run.id && link.mode === 'foreground');
      if (!hasCanonicalBlocker) diagnostics.push({ kind: 'integrity_violation', runId: run.id, reason: 'waiting_tools_without_operation_or_canonical_blocker' });
      continue;
    }
    const evidence = operations.map((operation) => {
      const attempts = facts.attempts.filter((attempt) => attempt.operationId === operation.id && attempt.generation === operation.currentGeneration && (attempt.state === 'pending' || attempt.state === 'dispatched'));
      const attempt = attempts.length === 1 ? attempts[0] : undefined;
      const effects = attempt
        ? facts.primaryEffects.filter((candidate) => candidate.operationId === operation.id && candidate.attemptId === attempt.id && candidate.generation === attempt.generation)
        : [];
      const effect = effects.length === 1 ? effects[0] : undefined;
      return { operation, attempt, effect };
    });
    if (operations.length === 0 || evidence.some((item) => !item.attempt || !item.effect)) {
      diagnostics.push({ kind: 'integrity_violation', runId: run.id, reason: 'active_machine_phase_without_complete_operation_attempt_descriptor' });
      continue;
    }

    const unknown = evidence.filter((item) => item.attempt!.state === 'dispatched' && primaryEffectKinds.require(item.effect!.kind).recoveryPolicy === 'require_resolution');
    const interrupted = evidence.filter((item) => {
      const recoveryPolicy = primaryEffectKinds.require(item.effect!.kind).recoveryPolicy;
      return (item.attempt!.state === 'dispatched' && recoveryPolicy !== 'require_resolution')
        || (item.attempt!.state === 'pending' && recoveryPolicy === 'interrupt_on_restart');
    });

    if (unknown.length > 0) {
      for (const item of evidence) {
        const { operation, attempt, effect } = item as { operation: OperationRecord; attempt: AttemptRecord; effect: PrimaryEffectDescriptor };
        const requiresResolution = attempt.state === 'dispatched' && primaryEffectKinds.require(effect.kind).recoveryPolicy === 'require_resolution';
        mutations.push(
          upsert('attempts', { ...attempt, state: requiresResolution ? 'outcome_unknown' : 'interrupted', completedAt: now, rowVersion: attempt.rowVersion + 1 }),
          upsert('operations', { ...operation, state: requiresResolution ? 'outcome_unknown' : 'interrupted', completedAt: now, updatedAt: now, rowVersion: operation.rowVersion + 1 })
        );
        if (requiresResolution) {
          mutations.push(upsert('pauses', pauseRecord(operation, now)));
          diagnostics.push({ kind: 'outcome_unknown', runId: run.id, operationId: operation.id, reason: 'dispatched_non_idempotent_effect' });
        } else {
          diagnostics.push({ kind: 'interrupted', runId: run.id, operationId: operation.id, reason: 'parallel_operation_stopped_for_unknown_outcome' });
        }
      }
      mutations.push(upsert('turns', { ...run, phase: 'paused', updatedAt: now, rowVersion: run.rowVersion + 1 }));
      continue;
    }

    if (interrupted.length > 0) {
      for (const item of evidence) {
        const { operation, attempt, effect } = item as { operation: OperationRecord; attempt: AttemptRecord; effect: PrimaryEffectDescriptor };
        mutations.push(
          upsert('attempts', { ...attempt, state: 'interrupted', completedAt: now, rowVersion: attempt.rowVersion + 1 }),
          upsert('operations', { ...operation, state: 'interrupted', completedAt: now, updatedAt: now, rowVersion: operation.rowVersion + 1 })
        );
        diagnostics.push({ kind: 'interrupted', runId: run.id, operationId: operation.id, reason: `${attempt.state}:${primaryEffectKinds.require(effect.kind).recoveryPolicy}` });
      }
      const terminal = terminalRunRecords(run, {
        kind: 'interrupted',
        actor: 'system',
        reasonCode: 'extension_host_restarted'
      }, now);
      mutations.push(upsert('turns', terminal.run), upsert('runTerminations', terminal.termination));
      const lease = facts.executionLeases.find((candidate) => candidate.turnId === run.id && candidate.state !== 'released');
      if (lease) mutations.push(upsert('executionLeases', releaseExecutionLease(lease, { turnId: run.id, now })));
    }
    // Every remaining Attempt is pending and explicitly resumable before the dispatch barrier.
    // `interrupt_on_restart` pending work was terminalized above; other policies have proof that no
    // external boundary was crossed and may be picked up by the level-triggered dispatcher.
  }

  for (const operation of facts.operations.filter((candidate) =>
    isConversationOperationOwner(candidate) && (candidate.state === 'pending' || candidate.state === 'running'))) {
    const attempts = facts.attempts.filter((attempt) => attempt.operationId === operation.id
      && attempt.generation === operation.currentGeneration
      && (attempt.state === 'pending' || attempt.state === 'dispatched'));
    const attempt = attempts.length === 1 ? attempts[0] : undefined;
    const effects = attempt
      ? facts.primaryEffects.filter((candidate) => candidate.operationId === operation.id
        && candidate.attemptId === attempt.id
        && candidate.generation === attempt.generation)
      : [];
    const effect = effects.length === 1 ? effects[0] : undefined;
    if (!attempt || !effect) {
      diagnostics.push({ kind: 'integrity_violation', operationId: operation.id, reason: 'conversation_operation_without_complete_attempt_descriptor' });
      continue;
    }
    const recoveryPolicy = primaryEffectKinds.require(effect.kind).recoveryPolicy;
    if (recoveryPolicy === 'require_resolution') {
      diagnostics.push({ kind: 'integrity_violation', operationId: operation.id, reason: 'conversation_operation_cannot_require_run_resolution' });
      continue;
    }
    if (attempt.state === 'pending' && recoveryPolicy === 'resume_pending_if_safe') continue;
    if (attempt.state === 'dispatched' && effect.kind === 'runtime.cleanup') {
      // runtime.cleanup is an idempotent abort outbox: replaying the same generation after a host
      // restart is safer than losing a committed cancellation between transaction commit and abort.
      const { dispatchedAt: _dispatchedAt, ...pendingAttempt } = attempt;
      mutations.push(upsert('attempts', {
        ...pendingAttempt,
        state: 'pending',
        rowVersion: attempt.rowVersion + 1
      }));
      continue;
    }
    mutations.push(
      upsert('attempts', { ...attempt, state: 'interrupted', completedAt: now, rowVersion: attempt.rowVersion + 1 }),
      upsert('operations', { ...operation, state: 'interrupted', completedAt: now, updatedAt: now, rowVersion: operation.rowVersion + 1 })
    );
    diagnostics.push({ kind: 'interrupted', operationId: operation.id, reason: `${attempt.state}:${recoveryPolicy}` });
  }
  return { mutations: dedupeMutations(mutations), cleanupHints, diagnostics };
}

export function watchdogTimeoutTransition(
  facts: DurableConversationFacts,
  input: { operationId: OperationId; attemptId: AttemptId; generation: number; now: number }
): AttemptTransition {
  const matched = matchCurrentAttempt(facts, input);
  if (matched.status === 'stale') return { mutations: [], result: { status: 'stale', reason: matched.reason } };
  if (input.now < matched.attempt.deadlineAt) return { mutations: [], result: { status: 'not_due' } };

  const mutations: RecordMutation[] = [upsert('attempts', {
    ...matched.attempt,
    state: 'timed_out',
    completedAt: input.now,
    rowVersion: matched.attempt.rowVersion + 1
  })];
  switch (matched.operation.timeoutPolicy) {
    case 'retry_if_safe': {
      const definition = matched.effect ? primaryEffectKinds.require(matched.effect.kind) : undefined;
      if (!definition?.idempotent) throw new Error(`Operation ${matched.operation.id} requests safe retry but its effect is not idempotent.`);
      mutations.push(upsert('operations', {
        ...matched.operation,
        currentGeneration: matched.operation.currentGeneration + 1,
        rowVersion: matched.operation.rowVersion + 1,
        updatedAt: input.now
      }));
      return { mutations, result: { status: 'retry_required', nextGeneration: matched.operation.currentGeneration + 1 } };
    }
    case 'release_optional_barrier':
      mutations.push(upsert('operations', { ...matched.operation, state: 'failed', completedAt: input.now, updatedAt: input.now, rowVersion: matched.operation.rowVersion + 1 }));
      return { mutations, result: { status: 'optional_barrier_released' } };
    case 'require_resolution':
      mutations.push(
        upsert('operations', { ...matched.operation, state: 'outcome_unknown', completedAt: input.now, updatedAt: input.now, rowVersion: matched.operation.rowVersion + 1 }),
        upsert('turns', pauseOwnerRun(facts, requireRunOperationOwner(matched.operation), input.now)),
        upsert('pauses', pauseRecord(matched.operation, input.now))
      );
      appendInterruptedSiblingOperations(mutations, facts, matched.operation, input.now);
      return { mutations, result: { status: 'outcome_unknown' } };
    case 'fail_run':
    case 'interrupt_run': {
      const run = requireRun(facts, requireRunOperationOwner(matched.operation));
      const operationState = matched.operation.timeoutPolicy === 'fail_run' ? 'failed' : 'interrupted';
      const terminal = terminalRunRecords(run, {
        kind: operationState,
        actor: 'system',
        reasonCode: 'operation_timed_out'
      }, input.now);
      mutations.push(
        upsert('operations', { ...matched.operation, state: operationState, completedAt: input.now, updatedAt: input.now, rowVersion: matched.operation.rowVersion + 1 }),
        upsert('turns', terminal.run),
        upsert('runTerminations', terminal.termination)
      );
      appendInterruptedSiblingOperations(mutations, facts, matched.operation, input.now);
      const lease = facts.executionLeases.find((candidate) => candidate.turnId === run.id && candidate.state !== 'released');
      if (lease) mutations.push(upsert('executionLeases', releaseExecutionLease(lease, { turnId: run.id, now: input.now })));
      return { mutations, result: { status: matched.operation.timeoutPolicy === 'fail_run' ? 'run_failed' : 'run_interrupted' } };
    }
  }
}

function appendInterruptedSiblingOperations(
  mutations: RecordMutation[],
  facts: DurableConversationFacts,
  selectedOperation: OperationRecord,
  now: number
): void {
  const siblings = facts.operations.filter((operation) => sameOperationOwner(operation, selectedOperation)
    && operation.id !== selectedOperation.id
    && (operation.state === 'pending' || operation.state === 'running'));
  for (const operation of siblings) {
    mutations.push(upsert('operations', { ...operation, state: 'interrupted', completedAt: now, updatedAt: now, rowVersion: operation.rowVersion + 1 }));
    for (const attempt of facts.attempts.filter((candidate) => candidate.operationId === operation.id
      && candidate.generation === operation.currentGeneration
      && (candidate.state === 'pending' || candidate.state === 'dispatched'))) {
      mutations.push(upsert('attempts', { ...attempt, state: 'interrupted', completedAt: now, rowVersion: attempt.rowVersion + 1 }));
    }
  }
}

function pauseOwnerRun(facts: DurableConversationFacts, runId: RunId, now: number) {
  const run = requireRun(facts, runId);
  return { ...run, phase: 'paused' as const, updatedAt: now, rowVersion: run.rowVersion + 1 };
}

function pauseRecord(operation: OperationRecord, now: number): DurablePauseRecord {
  const runId = requireRunOperationOwner(operation);
  return {
    id: `pause:${runId}:${operation.id}`,
    conversationId: operation.conversationId,
    runId,
    operationId: operation.id,
    reason: 'outcome_unknown',
    allowedResolutions: ['restart_proved_not_executed', 'submit_verified_result', 'abandon'],
    createdAt: now
  };
}

function requireRun(facts: DurableConversationFacts, runId: RunId) {
  const run = unique(facts.turns, runId);
  if (!run) throw new Error(`Operation owner Run is missing: ${runId}`);
  return run;
}

function unique<T extends { id: string }>(records: readonly T[], id: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`Stable ID conflict: ${id}`);
  return matches[0];
}

function upsert(family: string, record: unknown): RecordMutation {
  const id = (record as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) throw new Error(`Mutation record in ${family} has no id.`);
  return { kind: 'upsert', family, id, record: record as JsonValue };
}

function remove(family: string, id: string): RecordMutation { return { kind: 'remove', family, id }; }

function dedupeMutations(mutations: readonly RecordMutation[]): RecordMutation[] {
  const byKey = new Map<string, RecordMutation>();
  for (const mutation of mutations) {
    const id = mutation.kind === 'remove_many' ? mutation.ids.join(',') : mutation.id;
    byKey.set(`${mutation.family}:${id}`, mutation);
  }
  return [...byKey.values()];
}

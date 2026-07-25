import type {
  AttemptRecord,
  CommandEnvelope,
  CommandPlanningContext,
  CommandRejection,
  ConversationCommandHandler,
  DurableAggregateView,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { MessageContent, MessageRecord, MessageRevisionRecord } from '../../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  RunId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { asJson } from './transitionBuilder';
import { createBuilder, fullConversationView } from './handlers';
import { appendToolResponsesAndNextInvocation, type ToolContinuationPayload } from './internalHandlers';
import type { DurableConversationFacts, ResolveUnknownOutcomePayload } from './types';
import { copyOperationOwner, requireRunOperationOwner } from './operationOwner';
import { appendTerminalRun } from './runTermination';
import { releaseExecutionLease } from './executionLease';
import { appendBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';

interface ResolutionIds extends Record<string, string> {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  invocationId: InvocationId;
  requestId: RequestId;
}

export class ResolveUnknownOutcomeCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, JsonValue, ResolutionIds> {
  public requiredView(command: CommandEnvelope<JsonValue>) {
    const payload = command.payload as unknown as ResolveUnknownOutcomePayload;
    return fullConversationView('operation.resolve_unknown', payload.conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: CommandEnvelope<JsonValue>,
    context: CommandPlanningContext<ResolutionIds>
  ): TransitionPlan<JsonValue> | CommandRejection {
    const payload = command.payload as unknown as ResolveUnknownOutcomePayload;
    if (view.facts.conversation.id !== payload.conversationId) return reject('not_found', `Conversation not found: ${payload.conversationId}`);
    const operation = unique(view.facts.operations, payload.operationId, 'Operation');
    if (!operation) return reject('not_found', `Operation not found: ${payload.operationId}`);
    if (operation.state !== 'outcome_unknown') return reject('invalid_state', 'Operation is not waiting for unknown-outcome resolution.');
    const ownerRunId = requireRunOperationOwner(operation);
    const run = unique(view.facts.turns, ownerRunId, 'Run');
    const pause = view.facts.pauses.find((candidate) => candidate.operationId === operation.id && candidate.runId === ownerRunId);
    if (!run || run.lifecycle !== 'active' || run.phase !== 'paused' || !pause) return reject('invalid_state', 'Operation owner is not durably paused.');
    if (!pause.allowedResolutions.includes(payload.resolution)) return reject('invalid_state', 'Requested outcome resolution is not allowed by the frozen policy.');
    if (payload.resolution !== 'abandon' && !payload.evidenceRef?.trim()) return reject('invalid_state', 'Verified evidence is required for this resolution.');
    if (view.facts.operationResolutions.some((candidate) => candidate.operationId === operation.id)) return reject('invalid_state', 'Operation already has a resolution.');

    const builder = createBuilder(view, command, context.transitionId);
    const resolutionId = `operation-resolution:${operation.id}`;
    const resolutionKind = payload.resolution === 'restart_proved_not_executed'
      ? 'proved_not_executed' as const
      : payload.resolution === 'submit_verified_result'
        ? 'verified_completed' as const
        : 'abandoned' as const;
    builder
      .upsert('operationResolutions', {
        id: resolutionId,
        operationId: operation.id,
        kind: resolutionKind,
        ...(payload.evidenceRef ? { evidenceRef: payload.evidenceRef } : {}),
        createdAt: context.now
      })
      .remove('pauses', pause.id);

    const remainingPauses = view.facts.pauses.filter((candidate) => candidate.runId === run.id && candidate.id !== pause.id);
    switch (payload.resolution) {
      case 'restart_proved_not_executed':
        this.restartProvedNotExecuted(builder, view.facts, operation, run, resolutionId, remainingPauses.length > 0, context);
        break;
      case 'submit_verified_result': {
        if (payload.verifiedResult === undefined) return reject('invalid_state', 'A verified result payload is required.');
        this.applyVerifiedToolResult(builder, view.facts, operation, run, resolutionId, json(payload.verifiedResult), remainingPauses.length > 0, context);
        break;
      }
      case 'abandon':
        this.abandonUnknownOutcomes(builder, view.facts, operation, run, resolutionId, context);
        break;
    }

    builder.patch(payload.conversationId, { kind: 'operation.resolved', operationId: operation.id, resolution: payload.resolution });
    return builder.build(asJson({ operationId: operation.id, resolution: payload.resolution }));
  }

  private restartProvedNotExecuted(
    builder: ReturnType<typeof createBuilder>,
    facts: DurableConversationFacts,
    oldOperation: OperationRecord,
    run: DurableConversationFacts['turns'][number],
    resolutionId: string,
    keepPaused: boolean,
    context: CommandPlanningContext<ResolutionIds>
  ): void {
    const oldDescriptor = descriptorFor(facts, oldOperation);
    const oldPayload = facts.effectPayloads.find((candidate) => candidate.id === oldDescriptor.payloadRef.id && candidate.payloadHash === oldDescriptor.payloadRef.hash);
    if (!oldPayload) throw new Error(`Unknown-outcome Operation ${oldOperation.id} has no verifiable effect payload.`);
    const deadlineMs = Math.max(1, oldDescriptor.deadlineAt - oldOperation.createdAt);
    const operation: OperationRecord = {
      ...copyOperationOwner(oldOperation),
      id: context.ids.operationId,
      conversationId: oldOperation.conversationId,
      kind: oldOperation.kind,
      state: 'running',
      currentGeneration: 1,
      rowVersion: 1,
      timeoutPolicy: oldOperation.timeoutPolicy,
      createdAt: context.now,
      updatedAt: context.now
    };
    const attempt: AttemptRecord = {
      ...copyOperationOwner(operation),
      id: context.ids.attemptId,
      operationId: operation.id,
      conversationId: operation.conversationId,
      generation: 1,
      state: 'pending',
      deadlineAt: context.now + deadlineMs,
      rowVersion: 1
    };
    const payloadId = `effect-payload:${operation.id}:1`;
    const payloadHash = canonicalSha256(oldPayload.payload);
    const effect: PrimaryEffectDescriptor = {
      ...oldDescriptor,
      effectIntentId: context.ids.effectIntentId,
      operationId: operation.id,
      attemptId: attempt.id,
      generation: 1,
      deadlineAt: attempt.deadlineAt,
      idempotencyKey: `${operation.id}:1`,
      payloadRef: { kind: 'record', id: payloadId, hash: payloadHash }
    };
    builder
      .generatedId(operation.id, attempt.id, effect.effectIntentId)
      .upsert('operations', { ...oldOperation, state: 'failed', resolutionId, completedAt: context.now, updatedAt: context.now, rowVersion: oldOperation.rowVersion + 1 })
      .upsert('operations', operation)
      .upsert('attempts', attempt)
      .upsert('primaryEffects', { id: effect.effectIntentId, ...effect })
      .upsert('effectPayloads', { ...oldPayload, id: payloadId, operationId: operation.id, createdAt: context.now, payloadHash })
      .primaryEffect(effect)
      .upsert('turns', { ...run, phase: keepPaused ? 'paused' : phaseForOperation(operation.kind), updatedAt: context.now, rowVersion: run.rowVersion + 1 });
    const execution = facts.toolExecutions.find((candidate) => candidate.operationId === oldOperation.id);
    if (execution) {
      builder.upsert('toolExecutions', { ...execution, operationId: operation.id, state: 'pending', rowVersion: execution.rowVersion + 1 });
      const tool = unique(facts.toolCalls, execution.id, 'ToolCall');
      if (tool) builder.upsert('toolCalls', { ...tool, status: 'queued', updatedAt: context.now });
    }
  }

  private applyVerifiedToolResult(
    builder: ReturnType<typeof createBuilder>,
    facts: DurableConversationFacts,
    operation: OperationRecord,
    run: DurableConversationFacts['turns'][number],
    resolutionId: string,
    result: JsonValue,
    keepPaused: boolean,
    context: CommandPlanningContext<ResolutionIds>
  ): void {
    const execution = facts.toolExecutions.find((candidate) => candidate.operationId === operation.id);
    const tool = execution ? unique(facts.toolCalls, execution.id, 'ToolCall') : undefined;
    if (!execution || !tool) throw new Error('Verified completion currently requires a Tool Operation owner.');
    const materialized = appendBoundedInlineToolResult(builder, {
      conversationId: operation.conversationId,
      tool,
      status: 'success',
      result,
      now: context.now
    });
    builder
      .upsert('operations', { ...operation, state: 'succeeded', resolutionId, completedAt: context.now, updatedAt: context.now, rowVersion: operation.rowVersion + 1 })
      .upsert('toolExecutions', { ...execution, state: 'complete', rowVersion: execution.rowVersion + 1 })
      .upsert('toolCalls', { ...withoutEmbeddedToolResult(tool), status: 'success', updatedAt: context.now });

    if (keepPaused) return;
    const pendingReplacements = facts.operations.filter((candidate) => candidate.ownerRunId === run.id && (candidate.state === 'pending' || candidate.state === 'running'));
    if (pendingReplacements.length > 0) {
      builder.upsert('turns', { ...run, phase: 'waiting_tools', updatedAt: context.now, rowVersion: run.rowVersion + 1 });
      return;
    }
    const completion: ToolContinuationPayload = {
      conversationId: operation.conversationId,
      toolCallId: execution.id as ToolContinuationPayload['toolCallId'],
      outcome: 'succeeded',
      modelResponse: materialized.modelResponse,
      completedAt: context.now,
      responseMessageId: context.ids.responseMessageId,
      responseRevisionId: context.ids.responseRevisionId,
      nextInvocationId: context.ids.invocationId,
      nextRequestId: context.ids.requestId,
      nextOperationId: context.ids.operationId,
      nextAttemptId: context.ids.attemptId,
      nextEffectIntentId: context.ids.effectIntentId
    };
    appendToolResponsesAndNextInvocation(builder, facts, run, completion, context.now);
  }

  private abandonUnknownOutcomes(
    builder: ReturnType<typeof createBuilder>,
    facts: DurableConversationFacts,
    operation: OperationRecord,
    run: DurableConversationFacts['turns'][number],
    resolutionId: string,
    context: CommandPlanningContext<ResolutionIds>
  ): void {
    builder
      .upsert('operations', { ...operation, resolutionId, rowVersion: operation.rowVersion + 1, updatedAt: context.now })
      .removeMany('pauses', facts.pauses.filter((pause) => pause.runId === run.id).map((pause) => pause.id));
    for (const active of facts.operations.filter((candidate) => candidate.ownerRunId === run.id && (candidate.state === 'pending' || candidate.state === 'running'))) {
      builder.upsert('operations', { ...active, state: 'cancelled', currentGeneration: active.currentGeneration + 1, completedAt: context.now, updatedAt: context.now, rowVersion: active.rowVersion + 1 });
      for (const attempt of facts.attempts.filter((candidate) => candidate.operationId === active.id && candidate.generation === active.currentGeneration && (candidate.state === 'pending' || candidate.state === 'dispatched'))) {
        builder.upsert('attempts', { ...attempt, state: 'cancelled', completedAt: context.now, rowVersion: attempt.rowVersion + 1 });
      }
    }
    appendTerminalRun(builder, run, {
      kind: 'interrupted',
      actor: 'user',
      reasonCode: 'unknown_outcome_abandoned'
    }, context.now);
    removeSlot(builder, facts, run.id, context.now);
  }
}

function descriptorFor(facts: DurableConversationFacts, operation: OperationRecord): PrimaryEffectDescriptor {
  const candidates = facts.primaryEffects.filter((candidate) => candidate.operationId === operation.id && candidate.generation === operation.currentGeneration);
  if (candidates.length !== 1) throw new Error(`Operation ${operation.id} does not have exactly one current descriptor.`);
  return candidates[0];
}

function phaseForOperation(kind: string): DurableConversationFacts['turns'][number]['phase'] {
  if (kind.startsWith('tool.')) return 'waiting_tools';
  if (kind === 'llm.request') return 'llm_request_pending';
  if (kind === 'invocation.resolve') return 'resolving_invocation';
  if (kind.startsWith('context.')) return 'loading_context';
  return 'paused';
}

function removeSlot(builder: ReturnType<typeof createBuilder>, facts: DurableConversationFacts, runId: RunId, now: number): void {
  const lease = facts.executionLeases.find((candidate) => candidate.turnId === runId && candidate.state !== 'released');
  if (lease) builder.upsert('executionLeases', releaseExecutionLease(lease, { turnId: runId, now }));
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function reject(code: CommandRejection['code'], message: string): CommandRejection { return { status: 'rejected', code, message }; }
function relationId(kind: string, ...parts: string[]): string { return `${kind}:${parts.join(':')}`; }
function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue; }

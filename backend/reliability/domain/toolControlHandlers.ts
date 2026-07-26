import type {
  AttemptRecord,
  CleanupHint,
  CommandPlanningContext,
  DurableAggregateView,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { ToolCallEventRecord, ToolCallRecord, ToolCallStatus } from '../../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InteractionRequestId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  RunId,
  ToolCallEventId,
  ToolCallId
} from '../../../shared/stableIds';
import { primaryEffectKinds } from './operationStateMachine';
import {
  appendPrimaryProgress,
  appendToolResponsesAndNextInvocation,
  builderFor,
  createPrimaryProgress,
  fullView,
  policyNumber
} from './internalHandlers';
import { asJson } from './transitionBuilder';
import { hasRemainingToolWork } from './toolSchedule';
import { resolveForegroundChildToolOwnership } from './childRunOwnership';
import { interactionRequestForTool } from './interactionState';
import { appendCancelOwnedChildWork, appendSettleOwnedSourceToolCancellation } from './cancellationPlanner';
import type { DurableConversationFacts } from './types';
import { appendRuntimeCleanupOutbox } from './runtimeCleanup';
import { replaceWithBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';

interface ContinuationIds {
  toolCallEventId: ToolCallEventId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

export interface ApproveToolExecutionPayload {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface ApplyToolChangePayload extends ContinuationIds {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  interactionRequestId: InteractionRequestId;
  interactionRevision: number;
  decision: 'accept' | 'reject';
  actor: 'user' | 'policy';
  actorId?: string;
  commandId: string;
  reason?: string;
  completedAt: number;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
  /** Server-hydrated immutable proposal; never supplied by Webview clients. */
  proposalArtifactId?: string;
  proposalContentHash?: string;
  proposal?: JsonValue;
}

export interface SettleWaitingToolPayload extends ContinuationIds {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  waitKind: 'tool_approval' | 'tool_change_apply' | 'tool_result_review';
  decision: 'reject' | 'accept_result';
  reason?: string;
  completedAt: number;
}

export interface CancelToolOperationPayload extends ContinuationIds {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  reason: string;
  completedAt: number;
  ownedChild?: {
    bridgeId: string;
    ownerGeneration: number;
    childRunId: RunId;
    targetConversationId: ConversationId;
    closureRunIds: RunId[];
  };
}

interface FrozenApprovalPlan {
  kind: string;
  recoveryPolicy: PrimaryEffectDescriptor['recoveryPolicy'];
  timeoutPolicy: OperationRecord['timeoutPolicy'];
  deadlineMs: number;
  effectPayload: JsonValue;
}

export class ApproveToolExecutionHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('tool.execution_approve', approvalPayload(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = approvalPayload(command);
    const owner = toolOwner(view.facts, payload.toolCallId);
    if (!owner) return stale('tool_not_found');
    const { tool, run } = owner;
    const existing = view.facts.toolExecutions.find((candidate) => candidate.id === tool.id);
    if (existing) return { status: 'already_satisfied', result: asJson({ status: 'already_approved', operationId: existing.operationId }) };
    const interaction = interactionRequestForTool(view.facts, tool.id as ToolCallId, 'exec_approval');
    if (!interaction || interaction.owner.turnId !== run.id || tool.status !== 'awaiting_approval'
      || run.lifecycle !== 'active' || run.phase !== 'waiting_tools') return stale('approval_interaction_not_current');
    const frozen = parseApprovalPlan(field(object(interaction.request.payload), 'approval') as JsonValue | undefined);
    const definition = primaryEffectKinds.require(frozen.kind);
    if (definition.recoveryPolicy !== frozen.recoveryPolicy || definition.timeoutPolicy !== frozen.timeoutPolicy) {
      throw new Error(`Frozen Tool approval policy drifted for ${tool.id}.`);
    }
    const progress = createPrimaryProgress({
      ids: { operationId: payload.operationId, attemptId: payload.attemptId, effectIntentId: payload.effectIntentId },
      conversationId: payload.conversationId,
      runId: run.id,
      kind: frozen.kind,
      now: context.now,
      deadlineMs: frozen.deadlineMs,
      timeoutPolicy: frozen.timeoutPolicy,
      recoveryPolicy: frozen.recoveryPolicy,
      payload: frozen.effectPayload
    });
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .generatedId(payload.operationId, payload.attemptId, payload.effectIntentId)
      .upsert('toolCalls', { ...tool, status: 'queued', progress: { executionApproved: true }, updatedAt: context.now })
      .upsert('toolExecutions', { id: tool.id, conversationId: payload.conversationId, runId: run.id, operationId: payload.operationId, state: 'pending', rowVersion: 1 });
    appendPrimaryProgress(builder, progress);
    builder.patch(payload.conversationId, { kind: 'tool.execution_approved', toolCallId: tool.id, operationId: payload.operationId });
    return builder.build(asJson({ status: 'approved', operationId: payload.operationId }));
  }
}

export class ApplyToolChangeHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('interaction.file_change.resolve', applyPayload(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = applyPayload(command);
    const owner = toolOwner(view.facts, payload.toolCallId);
    if (!owner) return stale('tool_not_found');
    const { tool, run } = owner;
    const execution = unique(view.facts.toolExecutions, tool.id, 'ToolExecution');
    const interaction = interactionRequestForTool(view.facts, tool.id as ToolCallId, 'patch_approval');
    if (!execution || !interaction || interaction.request.id !== payload.interactionRequestId
      || interaction.request.revision !== payload.interactionRevision || interaction.owner.turnId !== run.id
      || tool.status !== 'awaiting_change_apply' || run.lifecycle !== 'active' || run.phase !== 'waiting_tools') {
      return stale('patch_approval_wait_not_current');
    }
    const builder = builderFor(view, context, payload.conversationId);

    if (payload.decision === 'reject') {
      const reason = payload.reason?.trim() || defaultRejection('tool_change_apply');
      const result = asJson({ ok: false, denied: true, reason });
      const materialized = replaceWithBoundedInlineToolResult(builder, view.facts.toolCallResultLinks, {
        conversationId: payload.conversationId,
        tool,
        status: 'error',
        result,
        now: payload.completedAt,
        error: reason
      });
      const completedTool: ToolCallRecord = {
        ...withoutEmbeddedToolResult(tool),
        status: 'error',
        error: reason,
        updatedAt: payload.completedAt
      };
      builder
        .generatedId(payload.toolCallEventId)
        .upsert('toolCalls', completedTool)
        .upsert('toolCallEvents', toolEvent(view.facts, completedTool, payload.toolCallEventId, payload.completedAt, 'failed', reason));
      continueIfToolBatchSettled(builder, view.facts, run, {
        ...payload,
        outcome: 'failed',
        modelResponse: materialized.modelResponse,
        error: reason
      }, context.now);
      builder.patch(payload.conversationId, { kind: 'interaction.outcome_applied', interactionRequestId: payload.interactionRequestId, decision: 'reject' });
      return builder.build(asJson({ status: 'resolved', decision: 'reject', interactionRequestId: payload.interactionRequestId, interactionRevision: payload.interactionRevision }));
    }

    const proposalArtifact = payload.proposalArtifactId
      ? unique(view.facts.toolResultArtifacts, payload.proposalArtifactId, 'File-change ToolResultArtifact')
      : undefined;
    if (!proposalArtifact || payload.proposalContentHash !== proposalArtifact.contentHash) {
      throw new Error(`InteractionRequest ${payload.interactionRequestId} has an invalid proposal Artifact closure.`);
    }
    const proposal = pendingFileChangeProposal(payload.proposal);
    if (!proposal) return stale('file_change_proposal_missing');
    const priorContext = object(field(object(interaction.request.payload), 'executionContext'))
      ?? effectContextForOperation(view.facts, execution.operationId);
    const effectPayload = asJson({
      toolCallId: tool.id,
      name: tool.name,
      proposal,
      ...(field(priorContext, 'workEnvironment') !== undefined ? { workEnvironment: field(priorContext, 'workEnvironment') } : {}),
      ...(field(priorContext, 'accessibleWorkEnvironments') !== undefined ? { accessibleWorkEnvironments: field(priorContext, 'accessibleWorkEnvironments') } : {}),
      allowOutsideProjectPaths: field(priorContext, 'allowOutsideProjectPaths') === true,
      autoSubmitResult: field(priorContext, 'autoSubmitResult') !== false
    });
    const definition = primaryEffectKinds.require('tool.write.apply_change');
    const progress = createPrimaryProgress({
      ids: { operationId: payload.operationId, attemptId: payload.attemptId, effectIntentId: payload.effectIntentId },
      conversationId: payload.conversationId,
      runId: run.id,
      kind: definition.kind,
      now: context.now,
      deadlineMs: policyNumber(view.facts, run.id, 'toolDeadlineMs'),
      timeoutPolicy: definition.timeoutPolicy,
      recoveryPolicy: definition.recoveryPolicy,
      payload: effectPayload
    });
    builder
      .generatedId(payload.operationId, payload.attemptId, payload.effectIntentId)
      .upsert('toolCalls', { ...tool, status: 'applying_change', updatedAt: payload.completedAt })
      .upsert('toolExecutions', { ...execution, operationId: payload.operationId, state: 'pending', rowVersion: execution.rowVersion + 1 });
    appendPrimaryProgress(builder, progress);
    builder.patch(payload.conversationId, { kind: 'interaction.outcome_applied', interactionRequestId: payload.interactionRequestId, decision: 'accept', effectIntentId: payload.effectIntentId });
    return builder.build(asJson({
      status: 'resolved',
      decision: 'accept',
      interactionRequestId: payload.interactionRequestId,
      interactionRevision: payload.interactionRevision,
      operationId: payload.operationId,
      effectIntentId: payload.effectIntentId
    }));
  }
}

export class SettleWaitingToolHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('tool.wait_settle', settlePayload(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = settlePayload(command);
    const owner = toolOwner(view.facts, payload.toolCallId);
    if (!owner) return stale('tool_not_found');
    const { tool, run } = owner;
    const interactionKind = payload.waitKind === 'tool_approval'
      ? 'exec_approval' as const
      : payload.waitKind === 'tool_change_apply'
        ? 'patch_approval' as const
        : 'result_review' as const;
    const interaction = interactionRequestForTool(view.facts, tool.id as ToolCallId, interactionKind);
    if (!interaction || interaction.owner.turnId !== run.id || run.lifecycle !== 'active' || run.phase !== 'waiting_tools') {
      return terminalTool(tool) ? { status: 'already_satisfied', result: asJson({ status: 'already_settled' }) } : stale('tool_wait_not_current');
    }
    const accepted = payload.decision === 'accept_result';
    const reason = payload.reason?.trim() || defaultRejection(payload.waitKind);
    const pendingStatus = accepted ? pendingResultStatus(tool) : undefined;
    if (accepted && tool.status !== 'awaiting_result_submit') return stale('result_review_not_current');
    const status: ToolCallStatus = accepted ? pendingStatus ?? 'success' : 'error';
    const result = accepted ? undefined : asJson({ ok: false, denied: true, reason });
    const acceptedLink = accepted
      ? uniqueBy(view.facts.toolCallResultLinks, (link) => link.toolCallId === tool.id && link.role === 'final', 'ToolCall final result link')
      : undefined;
    const acceptedArtifact = acceptedLink
      ? unique(view.facts.toolResultArtifacts, acceptedLink.artifactId, 'ToolResultArtifact')
      : undefined;
    if (accepted && !acceptedArtifact) throw new Error(`ToolCall ${tool.id} result review has no final Artifact.`);
    const builder = builderFor(view, context, payload.conversationId);
    const rejectedResult = result !== undefined
      ? replaceWithBoundedInlineToolResult(builder, view.facts.toolCallResultLinks, {
          conversationId: payload.conversationId,
          tool,
          status,
          result,
          now: payload.completedAt,
          error: reason
        })
      : undefined;
    const completedTool: ToolCallRecord = {
      ...withoutEmbeddedToolResult(tool),
      status,
      ...(accepted ? {} : { error: reason }),
      updatedAt: payload.completedAt
    };
    builder
      .generatedId(payload.toolCallEventId)
      .upsert('toolCalls', completedTool)
      .upsert('toolCallEvents', toolEvent(view.facts, completedTool, payload.toolCallEventId, payload.completedAt, accepted ? 'completed' : 'failed', accepted ? undefined : reason));
    const modelResponse = acceptedArtifact?.modelResponse ?? rejectedResult?.modelResponse;
    if (modelResponse === undefined) throw new Error(`ToolCall ${tool.id} settlement produced no final Artifact response.`);
    continueIfToolBatchSettled(builder, view.facts, run, {
      ...payload,
      outcome: accepted && status !== 'error' ? 'succeeded' : 'failed',
      modelResponse: clone(modelResponse) as JsonValue,
      ...(!accepted ? { error: reason } : {})
    }, context.now);
    builder.patch(payload.conversationId, { kind: 'tool.wait_settled', toolCallId: tool.id, decision: payload.decision });
    return builder.build(asJson({ status: accepted ? 'accepted' : 'rejected', toolCallId: tool.id }));
  }
}

export class CancelToolOperationHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('tool.cancel', cancelPayload(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = cancelPayload(command);
    const owner = toolOwner(view.facts, payload.toolCallId);
    if (!owner) return stale('tool_not_found');
    const { tool, run } = owner;
    const execution = unique(view.facts.toolExecutions, tool.id, 'ToolExecution');
    const operation = execution ? unique(view.facts.operations, execution.operationId, 'Operation') : undefined;
    if (terminalTool(tool)) return { status: 'already_satisfied', result: asJson({ status: 'already_settled' }) };
    if (!execution || !operation) return stale('active_tool_operation_missing');
    const reason = payload.reason.trim() || '用户终止工具执行。';

    if (operation.state === 'pending' || operation.state === 'running') {
      const result = asJson({ ok: false, interrupted: true, reason });
      const builder = builderFor(view, context, payload.conversationId);
      const materialized = replaceWithBoundedInlineToolResult(builder, view.facts.toolCallResultLinks, {
        conversationId: payload.conversationId,
        tool,
        status: 'error',
        result,
        now: payload.completedAt,
        error: reason
      });
      builder
        .generatedId(payload.toolCallEventId)
        .upsert('operations', { ...operation, state: 'cancelled', currentGeneration: operation.currentGeneration + 1, completedAt: payload.completedAt, updatedAt: payload.completedAt, rowVersion: operation.rowVersion + 1 })
        .upsert('toolExecutions', { ...execution, state: 'cancelled', rowVersion: execution.rowVersion + 1 })
        .upsert('toolCalls', { ...withoutEmbeddedToolResult(tool), status: 'error', error: reason, updatedAt: payload.completedAt })
        .upsert('toolCallEvents', toolEvent(view.facts, { ...tool, status: 'error', updatedAt: payload.completedAt }, payload.toolCallEventId, payload.completedAt, 'failed', reason));
      const activeAttempts = view.facts.attempts.filter((candidate) => candidate.operationId === operation.id
        && candidate.generation === operation.currentGeneration
        && (candidate.state === 'pending' || candidate.state === 'dispatched'));
      for (const attempt of activeAttempts) {
        builder.upsert('attempts', { ...attempt, state: 'cancelled', completedAt: payload.completedAt, rowVersion: attempt.rowVersion + 1 });
        if (attempt.state === 'dispatched') builder.cleanupHint(cleanupHint(operation, attempt.id));
      }
      appendRuntimeCleanupOutbox(builder, view.facts, activeAttempts.map((attempt) => attempt.id), payload.completedAt);
      continueIfToolBatchSettled(builder, view.facts, run, { ...payload, outcome: 'failed', modelResponse: materialized.modelResponse, error: reason }, context.now);
      builder.patch(payload.conversationId, { kind: 'tool.cancelled', toolCallId: tool.id, operationId: operation.id });
      return builder.build(asJson({ status: 'cancelled', toolCallId: tool.id }));
    }

    if (!payload.ownedChild) return stale('active_tool_operation_missing');
    const child = resolveForegroundChildToolOwnership(view.facts, payload.conversationId, payload.toolCallId, { requireTargetFacts: true });
    if (child.status === 'already_stopped') return { status: 'already_satisfied', result: asJson({ status: 'already_completed', reason: child.reason }) };
    if (child.status === 'target_moved') return stale(child.reason);
    if (child.status === 'missing') return stale(child.reason);
    if (child.ownership.bridge.id !== payload.ownedChild.bridgeId
      || child.ownership.bridge.ownerGeneration !== payload.ownedChild.ownerGeneration
      || child.ownership.childRunId !== payload.ownedChild.childRunId
      || child.ownership.targetConversationId !== payload.ownedChild.targetConversationId) {
      return stale('target_moved');
    }
    if (run.lifecycle !== 'active' || (run.phase !== 'waiting_tools' && run.phase !== 'waiting_child_run')) {
      return stale('parent_no_longer_waiting');
    }

    const builder = builderFor(view, context, payload.conversationId);
    const termination = appendCancelOwnedChildWork(builder, view.facts, {
      ownership: child.ownership,
      policy: 'foreground_child_tool',
      closureRunIds: payload.ownedChild.closureRunIds,
      termination: {
        kind: 'interrupted',
        actor: 'user',
        reasonCode: 'agent_interrupt_requested',
        triggerRunId: run.id
      },
      now: payload.completedAt
    });
    appendSettleOwnedSourceToolCancellation(builder, view.facts, {
      ownership: child.ownership,
      continuation: payload,
      reason,
      affectedRunIds: termination.affectedRunIds,
      now: payload.completedAt
    });
    builder.patch(payload.conversationId, {
      kind: 'tool.child_cancelled',
      toolCallId: tool.id,
      bridgeId: child.ownership.bridge.id,
      affectedRunIds: termination.affectedRunIds
    });
    return builder.build(asJson({
      status: 'cancelled_child',
      toolCallId: tool.id,
      bridgeId: child.ownership.bridge.id,
      affectedRunIds: termination.affectedRunIds
    }));
  }
}

function continueIfToolBatchSettled(
  builder: ReturnType<typeof builderFor>,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  payload: ContinuationIds & { conversationId: ConversationId; toolCallId: ToolCallId; completedAt: number; outcome: 'succeeded' | 'failed'; modelResponse: JsonValue; error?: string },
  now: number
): void {
  const operationId = facts.toolExecutions.find((execution) => execution.id === payload.toolCallId)?.operationId;
  if (hasRemainingToolWork(facts, {
    runId: run.id,
    toolCallIds: [payload.toolCallId],
    ...(operationId ? { operationIds: [operationId] } : {})
  })) return;
  appendToolResponsesAndNextInvocation(builder, facts, run, {
    conversationId: payload.conversationId,
    toolCallId: payload.toolCallId,
    outcome: payload.outcome,
    modelResponse: payload.modelResponse,
    error: payload.error,
    completedAt: payload.completedAt,
    responseMessageId: payload.responseMessageId,
    responseRevisionId: payload.responseRevisionId,
    nextInvocationId: payload.nextInvocationId,
    nextRequestId: payload.nextRequestId,
    nextOperationId: payload.nextOperationId,
    nextAttemptId: payload.nextAttemptId,
    nextEffectIntentId: payload.nextEffectIntentId
  }, now);
}

function toolOwner(facts: DurableConversationFacts, toolCallId: ToolCallId): { tool: ToolCallRecord; run: DurableConversationFacts['turns'][number] } | undefined {
  const tool = unique(facts.toolCalls, toolCallId, 'ToolCall');
  const link = uniqueBy(facts.toolRunLinks, (candidate) => candidate.toolCallId === toolCallId, 'ToolCall Run link');
  const run = link ? unique(facts.turns, link.runId, 'Run') : undefined;
  return tool && run ? { tool, run } : undefined;
}

function parseApprovalPlan(value: JsonValue | undefined): FrozenApprovalPlan {
  const record = object(value);
  const kind = text(record?.kind);
  const recoveryPolicy = text(record?.recoveryPolicy);
  const timeoutPolicy = text(record?.timeoutPolicy);
  const deadlineMs = record?.deadlineMs;
  if (!kind || (recoveryPolicy !== 'resume_pending_if_safe' && recoveryPolicy !== 'interrupt_on_restart' && recoveryPolicy !== 'require_resolution')
    || (timeoutPolicy !== 'retry_if_safe' && timeoutPolicy !== 'fail_run' && timeoutPolicy !== 'interrupt_run' && timeoutPolicy !== 'release_optional_barrier' && timeoutPolicy !== 'require_resolution')
    || typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || record?.effectPayload === undefined) {
    throw new Error('Durable Tool approval wait has an invalid frozen dispatch plan.');
  }
  return { kind, recoveryPolicy, timeoutPolicy, deadlineMs, effectPayload: clone(record.effectPayload) as JsonValue };
}

function pendingFileChangeProposal(value: unknown): JsonValue | undefined {
  const proposal = object(object(value)?.proposal);
  if (proposal?.kind !== 'file_change.proposal' || (proposal.operation !== 'write' && proposal.operation !== 'edit')) return undefined;
  if (typeof proposal.path !== 'string' || typeof proposal.baseContent !== 'string' || typeof proposal.targetContent !== 'string'
    || typeof proposal.baseExisted !== 'boolean' || !Array.isArray(proposal.applyHunks)) return undefined;
  return clone(proposal) as JsonValue;
}

function effectContextForOperation(facts: DurableConversationFacts, operationId: string): Record<string, unknown> | undefined {
  const descriptor = facts.primaryEffects
    .filter((candidate) => candidate.operationId === operationId)
    .sort((left, right) => right.generation - left.generation)[0];
  const payload = descriptor ? facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id && candidate.payloadHash === descriptor.payloadRef.hash) : undefined;
  return object(payload?.payload);
}

function toolEvent(facts: DurableConversationFacts, tool: ToolCallRecord, id: ToolCallEventId, at: number, kind: 'completed' | 'failed', error?: string): ToolCallEventRecord {
  const durationMs = Math.max(0, at - tool.createdAt);
  return {
    id,
    toolCallId: tool.id,
    seq: facts.toolCallEvents.filter((event) => event.toolCallId === tool.id).reduce((max, event) => Math.max(max, event.seq), 0) + 1,
    kind,
    at,
    status: tool.status,
    elapsedMs: durationMs,
    durationMs,
    ...(error ? { error } : {})
  };
}

function pendingResultStatus(tool: ToolCallRecord): Extract<ToolCallStatus, 'success' | 'warning' | 'error'> | undefined {
  const status = text(object(tool.progress)?.pendingResultSubmitStatus);
  return status === 'success' || status === 'warning' || status === 'error' ? status : undefined;
}

function cleanupHint(operation: OperationRecord, attemptId: AttemptId): CleanupHint {
  return {
    kind: operation.kind === 'llm.request' ? 'llm_abort' : 'tool_abort',
    conversationId: operation.conversationId,
    ownerId: attemptId
  };
}

function defaultRejection(kind: SettleWaitingToolPayload['waitKind']): string {
  if (kind === 'tool_approval') return '用户拒绝执行工具。';
  if (kind === 'tool_change_apply') return '用户拒绝应用文件变更。';
  return '用户拒绝使用工具结果。';
}

function terminalTool(tool: ToolCallRecord): boolean {
  return tool.status === 'success' || tool.status === 'warning' || tool.status === 'error';
}

function approvalPayload(command: InternalCommandEnvelope<JsonValue>): ApproveToolExecutionPayload { return command.payload as unknown as ApproveToolExecutionPayload; }
function applyPayload(command: InternalCommandEnvelope<JsonValue>): ApplyToolChangePayload { return command.payload as unknown as ApplyToolChangePayload; }
function settlePayload(command: InternalCommandEnvelope<JsonValue>): SettleWaitingToolPayload { return command.payload as unknown as SettleWaitingToolPayload; }
function cancelPayload(command: InternalCommandEnvelope<JsonValue>): CancelToolOperationPayload { return command.payload as unknown as CancelToolOperationPayload; }
function stale(reason: string): InternalCommandNoop<JsonValue> { return { status: 'stale', result: asJson({ status: 'stale', reason }) }; }

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  return uniqueBy(records, (record) => record.id === id, label);
}
function uniqueBy<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label} ownership is ambiguous.`);
  return matches[0];
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function field(record: Record<string, unknown> | undefined, key: string): unknown { return record?.[key]; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

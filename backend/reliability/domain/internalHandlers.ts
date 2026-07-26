import {
  ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
  TOOL_RESULT_BLOBS_RESOURCE_KEY
} from '../../../shared/conversationReliability';
import type {
  AttemptRecord,
  CommandPlanningContext,
  DurableAggregateView,
  DurableEffectPayloadRecord,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor,
  RecordMutation,
  RequestExecutionRecord,
  TerminalStreamFence,
  TransitionPlan
} from '../../../shared/conversationReliability';
import { isTextPart, TERMINAL_TOOL_CALL_STATUSES } from '../../../shared/protocol';
import type {
  CheckpointRecord,
  InlineDataPart,
  LlmInvocationSettingsSnapshotRecord,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRecord,
  MessageRevisionRecord,
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord,
  RequestModelContextProjectionLinkRecord,
  ToolCallRecord,
  ToolCallResultLinkRecord
} from '../../../shared/protocol';
import type { LlmStartRequest } from '../../world/modules/llm/contracts';
import type {
  ReliableBarrierContinuation,
  ReliableBarrierEffectPayload,
  ReliableCheckpointBarrierPlan,
  ReliableCompressionBarrierPlan,
  ReliableCompressionResult,
  ReliableLlmPreflightStep,
  ReliablePlannedToolCall,
  ReliablePostLlmContinuation,
  ReliableProgressIds
} from './preflightTypes';
import { isReliableBarrierEffectPayload } from './preflightTypes';
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
  ToolCallId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import type { DurableToolResultArtifactRecord } from '../toolResultTypes';
import { stableIdFromSeed } from '../stableIdFactory';
import { applyCompressionResultAddenda } from '../../modelContext/compressionResult';
import { canonicalToolResponsePart } from '../../modelContext/toolTurnNormalizer';
import { completeAttempt, markAttemptDispatched, matchCurrentAttempt, reconcileAfterRestart, watchdogTimeoutTransition } from './operationStateMachine';
import { copyOperationOwner, isConversationOperationOwner, requireRunOperationOwner } from './operationOwner';
import { asJson, ConversationTransitionBuilder } from './transitionBuilder';
import { appendTerminateRunGraphMutations, cleanupHintsForAttempts, planTerminateRunGraph } from './terminateRunGraph';
import { appendCompressionModelContextProjection, appendRequestModelContextProjection } from './modelContextProjection';
import { normalizeBackgroundProcessCompletionPayload } from './backgroundProcessPayload';
import { compressionProjectionIdentity, validateCompressionContextProjection } from './compressionValidity';
import { appendTerminalRun, completedRunRecord } from './runTermination';
import { appendAdmittedTurn } from './turnAdmission';
import { effectiveConversationExecutionLease, releaseExecutionLease } from './executionLease';
import {
  assertRuntimeInboxIdentity,
  createRuntimeInboxRecords,
  pendingRuntimeDeliveries,
  runtimeDeliveryBatchDigest,
  runtimeDeliveryMessageContent
} from './runtimeInbox';
import {
  requireTurnExecutionPolicyNumber,
  type TurnExecutionPolicyDeadlineKey
} from './turnExecutionPolicy';
import { appendRuntimeCleanupOutbox } from './runtimeCleanup';
import { runGraphCascadeForPolicy } from './cancellationIntent';
import { hasRemainingToolWork, scheduledToolOrdinal } from './toolSchedule';
import {
  appendBoundedInlineToolResult,
  replacedFinalToolResultLinks,
  replaceFinalToolResultLink,
  withoutEmbeddedToolResult
} from './toolResultArtifacts';
import { DURABLE_CONVERSATION_RECORD_FAMILIES } from './familyRegistry';
import {
  interactionOwnerLink,
  interactionRequestIdForTool,
  manualInteractionRequest
} from './interactionState';
import type {
  BackgroundProcessCompletionPayload,
  DurableConversationFacts,
  DurableInvocationRecord
} from './types';

interface AttemptTokenPayload {
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
}

export interface AdmitTurnIntentPayload {
  conversationId: ConversationId;
  intentId: string;
  intentRowVersion: number;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface BackgroundProcessExitNotificationPayload {
  conversationId: ConversationId;
  sourceRunId: RunId;
  sourceToolCallId: ToolCallId;
  processId: string;
  terminalRevision: number;
  completion: BackgroundProcessCompletionPayload;
}

interface MarkDispatchedResult { status: 'dispatched' | 'already_dispatched' }

export interface DispatchAttemptBatchPayload {
  conversationId: ConversationId;
  attempts: AttemptTokenPayload[];
}

export interface RejectDispatchedAttemptPayload extends AttemptTokenPayload {
  callbackType: string;
  reason: string;
}

export class MarkAttemptDispatchedHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('attempt.dispatch', token(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = token(command);
    const transition = markAttemptDispatched(view.facts, { ...payload, now: context.now });
    const status = stringField(transition.result, 'status');
    if (status === 'stale') return { status: 'stale', result: transition.result };
    if (status === 'already_dispatched') return { status: 'already_satisfied', result: transition.result };
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, transition.mutations);
    const operation = unique(view.facts.operations, payload.operationId, 'Operation');
    if (operation?.kind.startsWith('tool.')) {
      const execution = view.facts.toolExecutions.find((candidate) => candidate.operationId === operation.id);
      const tool = execution ? unique(view.facts.toolCalls, execution.id, 'ToolCall') : undefined;
      if (execution) builder.upsert('toolExecutions', { ...execution, state: 'executing', rowVersion: execution.rowVersion + 1 });
      if (tool) builder.upsert('toolCalls', { ...tool, status: 'executing', updatedAt: context.now });
    }
    builder.patch(payload.conversationId, { kind: 'attempt.dispatched', operationId: payload.operationId, attemptId: payload.attemptId, generation: payload.generation });
    return builder.build(transition.result);
  }
}

/** Level-triggered queue admission. The durable queue fact, not an ECS scheduler tag, owns activation. */
export class MarkAttemptBatchDispatchedHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('attempt.dispatch_batch', payloadOf<DispatchAttemptBatchPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<DispatchAttemptBatchPayload>(command);
    if (payload.attempts.length === 0 || payload.attempts.some((attempt) => attempt.conversationId !== payload.conversationId)) {
      return stale('dispatch_batch_scope_mismatch');
    }
    const uniqueAttempts = new Set(payload.attempts.map((attempt) => `${attempt.attemptId}:${attempt.generation}`));
    if (uniqueAttempts.size !== payload.attempts.length) return stale('dispatch_batch_duplicate_attempt');

    const transitions = payload.attempts.map((attempt) => ({
      attempt,
      transition: markAttemptDispatched(view.facts, { ...attempt, now: context.now })
    }));
    const staleTransition = transitions.find(({ transition }) => stringField(transition.result, 'status') === 'stale');
    if (staleTransition) return { status: 'stale', result: staleTransition.transition.result };
    const dispatched = transitions.filter(({ transition }) => stringField(transition.result, 'status') === 'dispatched');
    if (dispatched.length === 0) {
      return { status: 'already_satisfied', result: asJson({ status: 'already_dispatched', attempts: payload.attempts }) };
    }

    const builder = builderFor(view, context, payload.conversationId);
    for (const { attempt, transition } of dispatched) {
      appendMutations(builder, transition.mutations);
      const operation = unique(view.facts.operations, attempt.operationId, 'Operation');
      if (operation?.kind.startsWith('tool.')) {
        const execution = view.facts.toolExecutions.find((candidate) => candidate.operationId === operation.id);
        const tool = execution ? unique(view.facts.toolCalls, execution.id, 'ToolCall') : undefined;
        if (execution) builder.upsert('toolExecutions', { ...execution, state: 'executing', rowVersion: execution.rowVersion + 1 });
        if (tool) builder.upsert('toolCalls', { ...tool, status: 'executing', updatedAt: context.now });
      }
      builder.patch(payload.conversationId, {
        kind: 'attempt.dispatched',
        operationId: attempt.operationId,
        attemptId: attempt.attemptId,
        generation: attempt.generation
      });
    }
    return builder.build(asJson({ status: 'dispatched', attempts: dispatched.map(({ attempt }) => attempt) }));
  }
}

/**
 * Converts an invariant-rejected callback into one explicit terminal transition. A current
 * dispatched Attempt may never be left waiting for its watchdog merely because its callback
 * handler returned a business-level stale result.
 */
export class RejectDispatchedAttemptHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('attempt.callback_rejected', payloadOf<RejectDispatchedAttemptPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<RejectDispatchedAttemptPayload>(command);
    const matched = matchCurrentAttempt(view.facts, payload);
    if (matched.status === 'stale') return stale(matched.reason);
    if (matched.attempt.state !== 'dispatched') return stale('attempt_not_dispatched');
    const reason = `Callback ${payload.callbackType} was rejected: ${payload.reason}`;
    const builder = builderFor(view, context, payload.conversationId);

    if (isConversationOperationOwner(matched.operation)) {
      appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'failed', error: reason }).mutations);
      const effectPayload = matched.effect
        ? view.facts.effectPayloads.find((candidate) => candidate.id === matched.effect!.payloadRef.id && candidate.operationId === matched.operation.id)
        : undefined;
      if (effectPayload && isReliableBarrierEffectPayload(effectPayload.payload) && effectPayload.payload.barrier === 'compression.standalone') {
        const block = unique(view.facts.compressionBlocks, effectPayload.payload.plan.block.id, 'Standalone CompressionBlock');
        if (block && (block.status === 'pending' || block.status === 'running')) {
          builder.upsert('compressionBlocks', { ...block, status: 'error', error: reason, updatedAt: context.now, completedAt: context.now });
        }
      }
    } else {
      const runId = requireRunOperationOwner(matched.operation);
      const termination = planTerminateRunGraph(view.facts, {
        rootRunIds: [runId],
        termination: { kind: 'failed', actor: 'system', reasonCode: 'callback_rejected' },
        ...runGraphCascadeForPolicy('conversation_stop')
      });
      appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
      // Preserve the causal failure on the selected Operation/Attempt after graph cleanup marks the
      // remaining active work cancelled.
      appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'failed', error: reason }).mutations);
    }

    builder.patch(payload.conversationId, {
      kind: 'attempt.callback_rejected',
      operationId: payload.operationId,
      attemptId: payload.attemptId,
      callbackType: payload.callbackType,
      reason
    });
    return builder.build(asJson({ status: 'failed', operationId: payload.operationId, attemptId: payload.attemptId, reason }));
  }
}

/** Level-triggered TurnIntent admission. No Message or Turn exists before this transition. */
export class AdmitTurnIntentHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('turnIntent.admit', payloadOf<AdmitTurnIntentPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<AdmitTurnIntentPayload>(command);
    const facts = view.facts;
    if (facts.conversation.id !== payload.conversationId || facts.conversation.visibility === 'hidden') return stale('conversation_unavailable');
    if (effectiveConversationExecutionLease(facts, payload.conversationId)) return stale('execution_lease_occupied');

    const intent = unique(facts.turnIntents, payload.intentId, 'TurnIntent');
    if (!intent || intent.conversationId !== payload.conversationId || intent.rowVersion !== payload.intentRowVersion) return stale('turn_intent_stale');
    if (intent.state !== 'queued' || intent.hold !== 'none') return stale('turn_intent_not_eligible');
    const next = facts.turnIntents
      .filter((candidate) => candidate.conversationId === payload.conversationId && candidate.state === 'queued' && candidate.hold === 'none')
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))[0];
    if (next?.id !== intent.id) return stale('turn_intent_order_changed');

    const revision = unique(facts.turnIntentRevisions, intent.currentRevisionId, 'TurnIntent revision');
    const preset = unique(facts.turnExecutionPresetRevisions, intent.executionPresetRevisionId, 'TurnIntent execution preset');
    if (!revision || revision.turnIntentId !== intent.id || canonicalSha256(revision.content) !== revision.contentHash) {
      throw new Error(`TurnIntent ${intent.id} has an invalid current revision.`);
    }
    if (!preset || preset.turnIntentId !== intent.id || !preset.agentId.trim()) {
      throw new Error(`TurnIntent ${intent.id} has an invalid execution preset.`);
    }
    const content = clone(revision.content) as unknown as MessageContent;
    if (content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length === 0) {
      throw new Error(`TurnIntent ${intent.id} content is not a valid user input.`);
    }
    const seed = `turn-intent-admission:${intent.id}`;
    const turnId = stableIdFromSeed('run', `${seed}:turn`);
    const messageId = stableIdFromSeed('message', `${seed}:message`);
    const revisionId = stableIdFromSeed('messageRevision', `${seed}:message-revision`);
    const authoritySnapshotId = stableIdFromSeed('authoritySnapshot', `${seed}:authority`);
    const builder = builderFor(view, context, payload.conversationId);
    const admitted = appendAdmittedTurn(builder, facts, {
      conversationId: payload.conversationId,
      agentId: preset.agentId,
      content,
      now: context.now,
      ids: {
        turnId,
        messageId,
        revisionId,
        authoritySnapshotId,
        operationId: payload.operationId,
        attemptId: payload.attemptId,
        effectIntentId: payload.effectIntentId
      },
      authority: clone(preset.requestedAuthority),
      source: { kind: 'turn_intent', sourceId: intent.id }
    });
    builder
      .upsert('turnIntents', {
        ...intent,
        state: 'admitted',
        admittedTurnId: admitted.turn.id,
        admittedAt: context.now,
        rowVersion: intent.rowVersion + 1,
        updatedAt: context.now
      })
      .patch(payload.conversationId, {
        kind: 'turnIntent.admitted',
        intentId: intent.id,
        turnId: admitted.turn.id,
        messageId: admitted.message.id
      });
    return builder.build(asJson({ status: 'admitted', intentId: intent.id, turnId: admitted.turn.id, messageId: admitted.message.id }));
  }
}

/**
 * Records one immutable completion subject plus its independent source-Run inbox relation. Outbox
 * delivery stops here: no Message, Run, queue fact, or model request is created by this handler.
 */
export class BackgroundProcessExitNotificationHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('background_process.exit', payloadOf<BackgroundProcessExitNotificationPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<BackgroundProcessExitNotificationPayload>(command);
    const facts = view.facts;
    if (facts.conversation.id !== payload.conversationId || facts.conversation.visibility === 'hidden') return stale('conversation_unavailable');
    if (!Number.isInteger(payload.terminalRevision) || payload.terminalRevision <= 0 || payload.processId.trim().length === 0) {
      return stale('completion_identity_invalid');
    }
    const sourceRun = unique(facts.turns, payload.sourceRunId, 'source Run');
    const sourceTool = unique(facts.toolCalls, payload.sourceToolCallId, 'source ToolCall');
    if (!sourceRun || !sourceTool || !facts.toolRunLinks.some((link) => link.runId === sourceRun.id && link.toolCallId === sourceTool.id)) {
      return stale('completion_source_stale');
    }
    const targets = facts.runTargets.filter((target) => target.runId === sourceRun.id && target.conversationId === payload.conversationId && target.role === 'executor');
    if (targets.length !== 1) return stale('completion_target_unavailable');

    const normalizedPayload = normalizeBackgroundProcessCompletionPayload(payload.completion);
    const records = createRuntimeInboxRecords({
      kind: 'background_process_exited',
      sourceKind: 'background_process',
      sourceId: payload.processId,
      dedupeKey: `terminal:${payload.processId}:${payload.terminalRevision}`,
      payload: asJson({
        type: 'background_process_exit',
        sourceTurnId: sourceRun.id,
        sourceToolCallId: sourceTool.id,
        terminalRevision: payload.terminalRevision,
        completion: normalizedPayload
      }),
      occurredAt: command.occurredAt,
      createdAt: context.now,
      destinationConversationId: payload.conversationId,
      ownerTurnId: sourceRun.id,
      policy: 'inject_current_or_continue'
    });
    if (assertRuntimeInboxIdentity(facts, records) === 'existing') {
      return { status: 'already_satisfied', result: asJson({ status: 'runtime_inbox_already_recorded', inboxItemId: records.item.id, deliveryId: records.delivery.id }) };
    }
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .generatedId(records.delivery.id, records.item.id)
      // Relation-first ordering proves canonical item ownership without coupling the item to Conversation.
      .upsert('runtimeDeliveryLinks', records.delivery)
      .upsert('runtimeInboxItems', records.item)
      .patch(payload.conversationId, {
        kind: 'runtimeInbox.recorded',
        inboxItemId: records.item.id,
        deliveryId: records.delivery.id,
        eventKind: records.item.kind
      });
    return builder.build(asJson({
      status: 'runtime_inbox_recorded',
      inboxItemId: records.item.id,
      deliveryId: records.delivery.id,
      sourceRunState: sourceRun.phase === 'terminal' ? 'terminal' : 'active'
    }));
  }
}


export interface ContextLoadedPayload extends AttemptTokenPayload {
  invocationId: InvocationId;
  requestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

export class CompleteContextLoadHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('context.loaded', payloadOf<ContextLoadedPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ContextLoadedPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'context.load');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'succeeded' }).mutations);

    const invocation: DurableInvocationRecord = {
      id: payload.invocationId,
      conversationId: payload.conversationId,
      runId: run.id,
      requestId: payload.requestId,
      operationId: payload.nextOperationId,
      status: 'resolving',
      rowVersion: 1,
      createdAt: context.now
    };
    const request: RequestExecutionRecord = {
      id: payload.requestId,
      conversationId: payload.conversationId,
      runId: run.id,
      invocationId: invocation.id,
      operationId: payload.nextOperationId,
      state: 'pending',
      createdAt: context.now,
      rowVersion: 1
    };
    const progress = createPrimaryProgress({
      ids: {
        operationId: payload.nextOperationId,
        attemptId: payload.nextAttemptId,
        effectIntentId: payload.nextEffectIntentId
      },
      conversationId: payload.conversationId,
      runId: run.id,
      kind: 'invocation.resolve',
      now: context.now,
      deadlineMs: policyNumber(view.facts, run.id, 'resolveInvocationDeadlineMs'),
      timeoutPolicy: 'interrupt_run',
      recoveryPolicy: 'resume_pending_if_safe',
      payload: { invocationId: payload.invocationId, requestId: payload.requestId, conversationId: payload.conversationId }
    });
    builder
      .generatedId(payload.invocationId, payload.requestId, payload.nextOperationId, payload.nextAttemptId, payload.nextEffectIntentId)
      .upsert('invocations', invocation)
      .upsert('requests', request)
      .upsert('turns', { ...run, phase: 'resolving_invocation', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    appendPrimaryProgress(builder, progress);
    builder.patch(payload.conversationId, { kind: 'run.phase', runId: run.id, phase: 'resolving_invocation' });
    return builder.build(asJson({
      status: 'context_loaded',
      invocationId: payload.invocationId,
      requestId: payload.requestId
    }));
  }
}

export interface InvocationResolvedPayload extends AttemptTokenPayload {
  invocationId: InvocationId;
  requestId: RequestId;
  settings: LlmInvocationSettingsSnapshotRecord;
  resolvedAt: number;
  modelMessageId: MessageId;
  modelRevisionId: MessageRevisionId;
  contextOperationId: OperationId;
  contextAttemptId: AttemptId;
  contextEffectIntentId: EffectIntentId;
}

export class CompleteInvocationResolveHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('invocation.resolved', payloadOf<InvocationResolvedPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<InvocationResolvedPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'invocation.resolve');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const invocation = unique(view.facts.invocations, payload.invocationId, 'Invocation');
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!invocation || invocation.operationId !== payload.operationId || invocation.requestId !== payload.requestId
      || !request || request.invocationId !== invocation.id || request.runId !== run.id || request.conversationId !== payload.conversationId) {
      return stale('invocation_identity_mismatch');
    }
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'succeeded' }).mutations);

    const modelMessage: MessageRecord = {
      id: payload.modelMessageId,
      conversationId: payload.conversationId,
      role: 'model',
      model: payload.settings.displayModelName ?? payload.settings.modelName ?? payload.settings.modelId,
      presentation: 'visible',
      content: { role: 'model', parts: [] },
      status: 'streaming',
      seq: nextMessageSeq(view.facts),
      createdAt: payload.resolvedAt
    };
    const revision: MessageRevisionRecord = {
      id: payload.modelRevisionId,
      messageId: modelMessage.id,
      conversationId: payload.conversationId,
      content: modelMessage.content,
      createdAt: payload.resolvedAt,
      reason: 'created'
    };
    const resolvedInvocation: DurableInvocationRecord = {
      ...invocation,
      status: 'ready',
      settings: clone(payload.settings),
      resolvedAt: payload.resolvedAt,
      rowVersion: invocation.rowVersion + 1
    };
    const progress = createPrimaryProgress({
      ids: { operationId: payload.contextOperationId, attemptId: payload.contextAttemptId, effectIntentId: payload.contextEffectIntentId },
      conversationId: payload.conversationId,
      runId: run.id,
      kind: 'context.build_llm_request',
      now: context.now,
      deadlineMs: policyNumber(view.facts, run.id, 'contextDeadlineMs'),
      timeoutPolicy: 'retry_if_safe',
      recoveryPolicy: 'resume_pending_if_safe',
      payload: { runId: run.id, invocationId: invocation.id, requestId: payload.requestId, modelMessageId: modelMessage.id }
    });
    builder
      .generatedId(payload.modelMessageId, payload.modelRevisionId, payload.contextOperationId, payload.contextAttemptId, payload.contextEffectIntentId)
      .upsert('invocations', resolvedInvocation)
      .upsert('messages', modelMessage)
      .upsert('messageRevisions', revision)
      .upsert('messageCurrentRevisionLinks', { id: relationId('message-current-revision', modelMessage.id), messageId: modelMessage.id, revisionId: revision.id })
      .upsert('messageTurnLinks', { id: relationId('message-turn', modelMessage.id, run.id, 'model'), messageId: modelMessage.id, turnId: run.id, role: 'model' })
      .upsert('requests', {
        ...request,
        operationId: payload.contextOperationId,
        modelMessageId: modelMessage.id,
        state: 'pending',
        rowVersion: request.rowVersion + 1
      })
      .upsert('turns', { ...run, phase: 'loading_context', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    appendPrimaryProgress(builder, progress);
    builder
      .patch(payload.conversationId, { kind: 'message.upsert', message: modelMessage })
      .patch(payload.conversationId, { kind: 'run.phase', runId: run.id, phase: 'loading_context' });
    return builder.build(asJson({ status: 'invocation_resolved', invocationId: invocation.id, requestId: payload.requestId, modelMessageId: modelMessage.id }));
  }
}

export interface InvocationResolveFailedPayload extends AttemptTokenPayload {
  invocationId: InvocationId;
  requestId: RequestId;
  message: string;
  resolvedAt: number;
  errorMessageId: MessageId;
  errorRevisionId: MessageRevisionId;
}

export class FailInvocationResolveHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('invocation.resolve_failed', payloadOf<InvocationResolveFailedPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<InvocationResolveFailedPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'invocation.resolve');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const invocation = unique(view.facts.invocations, payload.invocationId, 'Invocation');
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!invocation || invocation.requestId !== payload.requestId || !request || request.invocationId !== invocation.id) {
      return stale('invocation_missing');
    }
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'failed', error: payload.message }).mutations);
    const message: MessageRecord = {
      id: payload.errorMessageId,
      conversationId: payload.conversationId,
      role: 'model',
      presentation: 'visible',
      content: { role: 'model', parts: [{ text: `\n[error] ${payload.message}` }] },
      status: 'partial',
      seq: nextMessageSeq(view.facts),
      createdAt: payload.resolvedAt
    };
    const revision: MessageRevisionRecord = { id: payload.errorRevisionId, messageId: message.id, conversationId: payload.conversationId, content: message.content, createdAt: payload.resolvedAt, reason: 'created' };
    builder
      .generatedId(payload.errorMessageId, payload.errorRevisionId)
      .upsert('invocations', { ...invocation, status: 'error', error: payload.message, resolvedAt: payload.resolvedAt, completedAt: payload.resolvedAt, rowVersion: invocation.rowVersion + 1 })
      .upsert('requests', { ...request, state: 'error', error: payload.message, completedAt: payload.resolvedAt, rowVersion: request.rowVersion + 1 })
      .upsert('messages', message)
      .upsert('messageRevisions', revision)
      .upsert('messageCurrentRevisionLinks', { id: relationId('message-current-revision', message.id), messageId: message.id, revisionId: revision.id })
      .upsert('messageTurnLinks', { id: relationId('message-turn', message.id, run.id, 'model'), messageId: message.id, turnId: run.id, role: 'model' });
    appendTerminalRun(builder, run, { kind: 'failed', actor: 'provider', reasonCode: 'invocation_failed' }, context.now);
    removeSlot(builder, view.facts, run.id, context.now);
    builder.patch(payload.conversationId, { kind: 'run.terminal', runId: run.id, reason: payload.message });
    return builder.build(asJson({ status: 'failed', runId: run.id, messageId: message.id }));
  }
}

export interface ContextProjectionCommitPayload {
  projection: Omit<ModelContextProjectionRecord, 'createdAt'>;
  sources: ModelContextProjectionSourceLinkRecord[];
  requestLink: Omit<RequestModelContextProjectionLinkRecord, 'createdAt'>;
}

export interface ContextRequestBuiltPayload extends AttemptTokenPayload {
  requestId: RequestId;
  request: LlmStartRequest;
  contextProjection: ContextProjectionCommitPayload;
  step: ReliableLlmPreflightStep;
}

export class CompleteContextBuildHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('context.request_built', payloadOf<ContextRequestBuiltPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ContextRequestBuiltPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'context.build_llm_request');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!request || request.operationId !== payload.operationId) return stale('request_identity_mismatch');
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: 'succeeded' }).mutations);
    if (payload.request.id !== payload.requestId) return stale('built_request_identity_mismatch');
    if (payload.contextProjection.requestLink.requestId !== payload.requestId
      || payload.contextProjection.projection.conversationId !== payload.conversationId
      || payload.contextProjection.projection.runId !== run.id
      || payload.contextProjection.projection.modelMessageId !== request.modelMessageId
      || canonicalSha256(payload.contextProjection.projection.contents) !== canonicalSha256(payload.request.contents)) {
      return stale('context_projection_identity_mismatch');
    }
    if (payload.step.kind !== 'compression') appendRequestModelContextProjection(builder, payload.contextProjection, context.now);
    appendPreflightStep(builder, view.facts, run, request, payload.step, context.now);
    builder.patch(payload.conversationId, { kind: 'run.phase', runId: run.id, phase: phaseForPreflightStep(payload.step) });
    return builder.build(asJson({ status: 'request_preflight_planned', requestId: payload.requestId, step: payload.step.kind }));
  }
}

export interface CompressionBarrierCallbackPayload extends AttemptTokenPayload, ReliableCompressionResult {
  plan: ReliableCompressionBarrierPlan;
  continuation: Extract<ReliableBarrierContinuation, { kind: 'context_rebuild' }>;
}

export class CompleteCompressionBarrierHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('compression.pre_llm.completed', payloadOf<CompressionBarrierCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CompressionBarrierCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'compression.pre_llm');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const block = unique(view.facts.compressionBlocks, payload.plan.block.id, 'CompressionBlock');
    const projectionIdentity = block ? compressionProjectionIdentity(view.facts, block.id) : undefined;
    if (!block || block.status !== 'running'
      || payload.plan.compactRequest.blockId !== block.id
      || payload.plan.compactRequest.sourceHash !== block.sourceHash
      || !projectionIdentity
      || payload.plan.contextProjection.compressionLink.blockId !== block.id
      || payload.plan.contextProjection.compressionLink.projectionId !== projectionIdentity.projection.id
      || payload.plan.contextProjection.projection.id !== projectionIdentity.projection.id
      || payload.plan.contextProjection.projection.fingerprint !== projectionIdentity.projection.fingerprint
      || canonicalSha256(payload.plan.compactRequest.contents as unknown as JsonValue)
        !== canonicalSha256(projectionIdentity.projection.contents as unknown as JsonValue)) {
      return stale('compression_barrier_identity_mismatch');
    }
    if (payload.outcome === 'succeeded' && !payload.result) return stale('compression_result_missing');

    const sourceValidity = payload.outcome === 'succeeded'
      ? validateCompressionContextProjection(view.facts, block.id)
      : { valid: true as const };
    const effectiveOutcome = sourceValidity.valid ? payload.outcome : 'failed';
    const effectiveError = sourceValidity.valid
      ? payload.error
      : `compression_source_invalid:${sourceValidity.reason ?? 'unknown'}`;
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, {
      ...payload,
      now: context.now,
      outcome: effectiveOutcome,
      error: effectiveError
    }).mutations);
    if (payload.outcome === 'succeeded' && sourceValidity.valid) {
      const result = payload.result!;
      const contents = applyCompressionResultAddenda(result.contents, projectionIdentity.projection.resultAddenda);
      const methodKind = result.methodConfig?.kind ?? block.methodKind;
      builder
        .generatedId(payload.plan.variantId)
        .upsert('compressionBlocks', {
          ...block,
          status: 'complete',
          methodKind,
          ...(result.methodConfig?.id ? { methodConfigId: result.methodConfig.id } : {}),
          summaryPreview: compressionPreview(result.contents),
          ...(result.settingsSnapshot ? { providerSettingsSnapshot: clone(result.settingsSnapshot) } : {}),
          ...(result.methodConfig ? { compressionConfigSnapshot: clone(result.methodConfig) } : {}),
          updatedAt: payload.completedAt,
          completedAt: payload.completedAt
        })
        .upsert('compressionContextVariants', {
          id: payload.plan.variantId,
          blockId: block.id,
          kind: methodKind === 'openai_responses_compact' ? 'provider_native' : 'provider_neutral_summary',
          contents,
          ...(methodKind === 'openai_responses_compact' ? { compatibility: { provider: 'openai-responses', format: 'openai-responses', endpoint: 'responses.compact' } } : {}),
          ...(result.usageMetadata ? { usageMetadata: clone(result.usageMetadata) } : {}),
          ...(result.rawResponse !== undefined ? { rawResponse: clone(result.rawResponse) } : {}),
          createdAt: payload.completedAt,
          updatedAt: payload.completedAt
        })
        .upsert('runCompressionBlockLinks', {
          id: `run-compression:${run.id}:${block.id}:${payload.plan.variantId}`,
          runId: run.id,
          blockId: block.id,
          variantId: payload.plan.variantId,
          role: 'context',
          mode: methodKind === 'openai_responses_compact' ? 'provider_native' : 'summary_fallback',
          createdAt: payload.completedAt,
          updatedAt: payload.completedAt
        });
    } else if (!sourceValidity.valid) {
      builder.upsert('compressionBlocks', {
        ...block,
        status: 'stale',
        staleReason: effectiveError,
        updatedAt: payload.completedAt,
        completedAt: payload.completedAt
      });
    } else {
      builder.upsert('compressionBlocks', {
        ...block,
        status: 'error',
        error: payload.error ?? 'compression_failed',
        updatedAt: payload.completedAt,
        completedAt: payload.completedAt
      });
    }
    appendBarrierContinuation(builder, view.facts, run, payload.continuation, context.now);
    builder.patch(payload.conversationId, {
      kind: 'compression.completed',
      blockId: block.id,
      outcome: effectiveOutcome,
      releasedOptionalBarrier: effectiveOutcome === 'failed'
    });
    return builder.build(asJson({ status: effectiveOutcome, blockId: block.id, continued: true }));
  }
}

export interface CheckpointBarrierCallbackPayload extends AttemptTokenPayload {
  plan: ReliableCheckpointBarrierPlan;
  continuation: Extract<ReliableBarrierContinuation, { kind: 'llm_request' }>;
  record: CheckpointRecord;
  completedAt: number;
}

export class CompleteCheckpointBarrierHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('checkpoint.before_llm.completed', payloadOf<CheckpointBarrierCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<CheckpointBarrierCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'checkpoint.before_llm');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const checkpoint = unique(view.facts.checkpoints, payload.plan.checkpoint.id, 'Checkpoint');
    if (!checkpoint || checkpoint.status !== 'pending' || payload.record.id !== checkpoint.id || payload.record.conversationId !== payload.conversationId) {
      return stale('checkpoint_barrier_identity_mismatch');
    }
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, {
      ...payload,
      now: context.now,
      outcome: payload.record.status === 'failed' ? 'failed' : 'succeeded',
      ...(payload.record.message ? { error: payload.record.message } : {})
    }).mutations);
    builder.upsert('checkpoints', clone(payload.record));
    appendBarrierContinuation(builder, view.facts, run, payload.continuation, context.now);
    builder.patch(payload.conversationId, {
      kind: 'checkpoint.completed',
      checkpointId: checkpoint.id,
      status: payload.record.status,
      releasedOptionalBarrier: payload.record.status !== 'created'
    });
    return builder.build(asJson({ status: payload.record.status, checkpointId: checkpoint.id, continued: true }));
  }
}

export interface PostLlmCheckpointCallbackPayload extends AttemptTokenPayload {
  plan: ReliableCheckpointBarrierPlan;
  continuation: ReliablePostLlmContinuation;
  record: CheckpointRecord;
  completedAt: number;
}

export class CompletePostLlmCheckpointHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('checkpoint.after_llm.completed', payloadOf<PostLlmCheckpointCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<PostLlmCheckpointCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'checkpoint.after_llm');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const checkpoint = unique(view.facts.checkpoints, payload.plan.checkpoint.id, 'Checkpoint');
    const modelMessage = unique(view.facts.messages, payload.continuation.modelMessageId, 'Model Message');
    if (run.phase !== 'waiting_checkpoint_after_llm' || !checkpoint || checkpoint.status !== 'pending'
      || payload.record.id !== checkpoint.id || payload.record.conversationId !== payload.conversationId || !modelMessage) {
      return stale('post_llm_checkpoint_identity_mismatch');
    }
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, {
      ...payload,
      now: context.now,
      outcome: payload.record.status === 'failed' ? 'failed' : 'succeeded',
      ...(payload.record.message ? { error: payload.record.message } : {})
    }).mutations);
    builder.upsert('checkpoints', clone(payload.record));
    appendLlmSuccessContinuation(builder, view.facts, run, modelMessage.id as MessageId, payload.continuation.toolCalls, context.now);
    builder.patch(payload.conversationId, {
      kind: 'checkpoint.completed',
      checkpointId: checkpoint.id,
      status: payload.record.status,
      releasedOptionalBarrier: payload.record.status !== 'created'
    });
    return builder.build(asJson({ status: payload.record.status, checkpointId: checkpoint.id, continued: true }));
  }
}

export interface LlmStartedCallbackPayload extends AttemptTokenPayload {
  requestId: RequestId;
  invocationId?: InvocationId;
  model?: string;
  startedAt: number;
}

export class MarkLlmStartedHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('llm.started', payloadOf<LlmStartedCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<LlmStartedCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'llm.request');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!request || request.operationId !== payload.operationId) return stale('request_identity_mismatch');
    const invocation = unique(view.facts.invocations, request.invocationId, 'Invocation');
    if (!invocation) return stale('invocation_missing');
    if (request.state === 'streaming' && run.phase === 'llm_streaming') return { status: 'already_satisfied', result: asJson({ status: 'already_streaming' }) };
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .upsert('requests', { ...request, state: 'streaming', startedAt: payload.startedAt, streamSeq: request.streamSeq ?? 0, rowVersion: request.rowVersion + 1 })
      .upsert('invocations', { ...invocation, status: 'streaming', startedAt: payload.startedAt, rowVersion: invocation.rowVersion + 1 })
      .upsert('turns', { ...run, phase: 'llm_streaming', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    builder.patch(payload.conversationId, { kind: 'run.phase', runId: run.id, phase: 'llm_streaming' });
    return builder.build(asJson({ status: 'streaming', requestId: request.id }));
  }
}

export type PlannedToolCall = ReliablePlannedToolCall;

export interface LlmFinalCallbackPayload extends AttemptTokenPayload {
  requestId: RequestId;
  outcome: 'succeeded' | 'failed';
  content: MessageContent;
  completedAt: number;
  error?: string;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  finalStreamSeq: number;
  toolCalls: PlannedToolCall[];
  postLlmCheckpoint?: {
    ids: ReliableProgressIds;
    plan: ReliableCheckpointBarrierPlan;
  };
}

export class CompleteLlmRequestHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('llm.final', payloadOf<LlmFinalCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<LlmFinalCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'llm.request');
    if (matched.status === 'stale') return matched.noop;
    const run = requireRun(view.facts, matched.runId);
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!request || request.operationId !== payload.operationId || !request.modelMessageId) return stale('request_identity_mismatch');
    const invocation = unique(view.facts.invocations, request.invocationId, 'Invocation');
    const message = unique(view.facts.messages, request.modelMessageId, 'Model Message');
    if (!invocation || !message) return stale('request_projection_incomplete');
    const currentLinks = view.facts.messageCurrentRevisionLinks.filter((link) => link.messageId === message.id);
    if (currentLinks.length !== 1) throw new Error(`Model Message ${message.id} has ${currentLinks.length} current revision links.`);
    const revision = unique(view.facts.messageRevisions, currentLinks[0].revisionId, 'Model MessageRevision');
    if (!revision || revision.messageId !== message.id) throw new Error(`Model Message ${message.id} has no current revision.`);
    const emptyModelResult = payload.outcome === 'succeeded'
      && payload.toolCalls.length === 0
      && !payload.content.parts.some((part) => isTextPart(part) && part.thought !== true && part.text.trim().length > 0);
    const effectiveOutcome = emptyModelResult ? 'failed' as const : payload.outcome;
    const effectiveError = emptyModelResult ? 'empty_model_result' : payload.error;
    const builder = builderFor(view, context, payload.conversationId);
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: effectiveOutcome, error: effectiveError }).mutations);

    const finalMessage: MessageRecord = {
      ...message,
      content: clone(payload.content),
      status: effectiveOutcome === 'succeeded' ? 'final' : 'partial',
      ...(payload.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: payload.streamOutputDurationMs } : {}),
      ...(payload.usageMetadata ? { usageMetadata: clone(payload.usageMetadata) } : {})
    };
    builder
      .upsert('messages', finalMessage)
      .upsert('messageRevisions', { ...revision, content: clone(payload.content) })
      .upsert('requests', {
        ...request,
        state: effectiveOutcome === 'succeeded' ? 'complete' : 'error',
        streamSeq: payload.finalStreamSeq,
        completedAt: payload.completedAt,
        ...(effectiveError ? { error: effectiveError } : {}),
        rowVersion: request.rowVersion + 1
      })
      .upsert('invocations', {
        ...invocation,
        status: effectiveOutcome === 'succeeded' ? 'complete' : 'error',
        completedAt: payload.completedAt,
        ...(payload.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: payload.streamOutputDurationMs } : {}),
        ...(payload.usageMetadata ? { usageMetadata: clone(payload.usageMetadata) } : {}),
        ...(effectiveError ? { error: effectiveError } : {}),
        rowVersion: invocation.rowVersion + 1
      });
    const fence: TerminalStreamFence = {
      id: streamFenceId(request.id, payload.attemptId, payload.generation),
      requestId: request.id,
      attemptId: payload.attemptId,
      generation: payload.generation,
      finalStreamSeq: payload.finalStreamSeq
    };
    builder.upsert('terminalStreamFences', fence);
    for (const head of view.facts.streamCheckpointHeads.filter((candidate) => candidate.requestId === request.id
      && candidate.attemptId === payload.attemptId
      && candidate.generation === payload.generation)) {
      builder.remove('streamCheckpointHeads', head.id);
    }

    let continues = false;
    if (effectiveOutcome === 'failed') {
      appendTerminalRun(builder, run, {
        kind: 'failed',
        actor: emptyModelResult ? 'system' : 'provider',
        reasonCode: emptyModelResult ? 'empty_model_result' : 'llm_request_failed'
      }, context.now);
      removeSlot(builder, view.facts, run.id, context.now);
    } else if (payload.postLlmCheckpoint) {
      appendPostLlmCheckpointBarrier(builder, view.facts, run, payload.postLlmCheckpoint, {
        kind: 'llm_success',
        modelMessageId: message.id as MessageId,
        toolCalls: payload.toolCalls
      }, context.now);
      continues = true;
    } else {
      continues = appendLlmSuccessContinuation(builder, view.facts, run, message.id as MessageId, payload.toolCalls, context.now);
    }
    builder
      .patch(payload.conversationId, { kind: 'message.upsert', message: finalMessage })
      .patch(payload.conversationId, { kind: continues ? 'run.phase' : 'run.terminal', runId: run.id });
    return builder.build(asJson({
      status: effectiveOutcome,
      runId: run.id,
      requestId: request.id,
      toolCallIds: payload.toolCalls.map((tool) => tool.toolCallId),
      checkpointPending: effectiveOutcome === 'succeeded' && payload.postLlmCheckpoint !== undefined,
      completionFollowupPending: effectiveOutcome === 'succeeded' && continues && payload.postLlmCheckpoint === undefined && payload.toolCalls.length === 0,
      ...(emptyModelResult ? { error: 'empty_model_result' } : {})
    }));
  }
}

export interface ToolCompletedCallbackPayload extends AttemptTokenPayload {
  toolCallId: ToolCallId;
  outcome: 'succeeded' | 'failed' | 'awaiting_change_apply' | 'awaiting_result_submit';
  finalStatus?: 'success' | 'warning' | 'error';
  /** Immutable canonical result owner prepared before this transaction; large bytes are already blob-durable. */
  resultArtifact: DurableToolResultArtifactRecord;
  resultLink: ToolCallResultLinkRecord;
  /** Bounded deterministic response used to materialize the model-visible tool response Message. */
  modelResponse: JsonValue;
  responseParts?: InlineDataPart[];
  error?: string;
  durationMs?: number;
  completedAt: number;
  interactionRequestId?: InteractionRequestId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

export interface ToolCompletedBatchCallbackPayload {
  conversationId: ConversationId;
  completions: ToolCompletedCallbackPayload[];
}

export class CompleteToolOperationHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return toolResultMutationView('tool.final', payloadOf<ToolCompletedCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ToolCompletedCallbackPayload>(command);
    const matched = requireDispatched(view.facts, payload, undefined);
    if (matched.status === 'stale') return matched.noop;

    if (!matched.kind.startsWith('tool.')) return stale('operation_kind_mismatch');
    const run = requireRun(view.facts, matched.runId);
    const tool = unique(view.facts.toolCalls, payload.toolCallId, 'ToolCall');
    const execution = unique(view.facts.toolExecutions, payload.toolCallId, 'ToolExecution');
    if (!tool || !execution || execution.operationId !== payload.operationId) return stale('tool_identity_mismatch');
    assertCompletionResultIdentity(payload, tool);
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .generatedId(payload.resultArtifact.id, payload.resultLink.id)
      .upsert('toolResultArtifacts', clone(payload.resultArtifact));
    replaceFinalToolResultLink(
      builder,
      view.facts.toolCallResultLinks,
      clone(payload.resultLink),
      payload.completedAt
    );
    const changeResumePayload = payload.outcome === 'awaiting_change_apply'
      ? effectPayloadForOperation(view.facts, payload.operationId)
      : undefined;
    const terminalOutcome = payload.outcome === 'failed' ? 'failed' : 'succeeded';
    appendMutations(builder, completeAttempt(view.facts, { ...payload, now: context.now, outcome: terminalOutcome, error: payload.error }).mutations);
    builder
      .upsert('toolCalls', {
        ...tool,
        status: payload.outcome === 'awaiting_change_apply'
          ? 'awaiting_change_apply'
          : payload.outcome === 'awaiting_result_submit'
            ? 'awaiting_result_submit'
            : payload.finalStatus ?? (payload.outcome === 'succeeded' ? 'success' : 'error'),
        ...(payload.responseParts !== undefined ? { responseParts: clone(payload.responseParts) } : {}),
        ...(payload.error ? { error: payload.error } : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        updatedAt: payload.completedAt
      })
      .upsert('toolExecutions', { ...execution, state: payload.outcome === 'failed' ? 'error' : 'complete', rowVersion: execution.rowVersion + 1 });

    const hasRemaining = hasRemainingToolWork(view.facts, {
      runId: run.id,
      toolCallIds: [payload.toolCallId],
      operationIds: [payload.operationId]
    });
    if (payload.outcome === 'awaiting_change_apply' || payload.outcome === 'awaiting_result_submit') {
      builder
        .upsert('toolCalls', {
          ...tool,
          status: payload.outcome === 'awaiting_change_apply' ? 'awaiting_change_apply' : 'awaiting_result_submit',
          ...(payload.responseParts !== undefined ? { responseParts: clone(payload.responseParts) } : {}),
          ...(payload.outcome === 'awaiting_result_submit'
            ? { progress: { pendingResultSubmitStatus: payload.finalStatus ?? (payload.error ? 'error' : 'success') } }
            : tool.progress !== undefined ? { progress: clone(tool.progress) } : {}),
          ...(payload.error ? { error: payload.error } : {}),
          ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
          updatedAt: payload.completedAt
        })
        .upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
      if (payload.outcome === 'awaiting_change_apply') {
        appendFileChangeInteraction(builder, run, tool, payload, changeResumePayload, context.now);
      } else {
        appendResultReviewInteraction(builder, run, tool, payload, context.now);
      }
    } else if (!hasRemaining) {
      appendToolResponsesAndNextInvocation(builder, view.facts, run, payload, context.now);
    }
    builder.patch(payload.conversationId, { kind: 'tool.upsert', toolCallId: payload.toolCallId });
    return builder.build(asJson({
      status: payload.outcome,
      toolCallId: payload.toolCallId,
      continued: payload.outcome !== 'awaiting_change_apply' && payload.outcome !== 'awaiting_result_submit' && !hasRemaining
    }));
  }
}

/** Coalesces concurrently completed tools into one durable callback transaction. */
export class CompleteToolOperationBatchHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return toolResultMutationView('tool.final_batch', payloadOf<ToolCompletedBatchCallbackPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ToolCompletedBatchCallbackPayload>(command);
    if (payload.completions.length === 0 || payload.completions.some((completion) => completion.conversationId !== payload.conversationId)) {
      throw new Error('Tool completion batch escaped its conversation scope.');
    }
    const keys = new Set(payload.completions.map((completion) => `${completion.attemptId}:${completion.generation}`));
    if (keys.size !== payload.completions.length) throw new Error('Tool completion batch contains a duplicate Attempt generation.');

    const current: Array<{
      payload: ToolCompletedCallbackPayload;
      run: DurableConversationFacts['turns'][number];
      tool: ToolCallRecord;
      execution: DurableConversationFacts['toolExecutions'][number];
    }> = [];
    for (const completion of payload.completions) {
      const matched = requireDispatched(view.facts, completion, undefined);
      if (matched.status === 'stale') continue;
      if (!matched.kind.startsWith('tool.')) throw new Error(`Tool completion batch contains non-tool Operation kind ${matched.kind}.`);
      const run = requireRun(view.facts, matched.runId);
      const tool = unique(view.facts.toolCalls, completion.toolCallId, 'ToolCall');
      const execution = unique(view.facts.toolExecutions, completion.toolCallId, 'ToolExecution');
      if (!tool || !execution || execution.operationId !== completion.operationId) throw new Error(`Tool completion identity mismatch: ${completion.toolCallId}.`);
      current.push({ payload: completion, run, tool, execution });
    }
    if (current.length === 0) return { status: 'already_satisfied', result: asJson({ status: 'already_completed' }) };
    const runIds = new Set(current.map((item) => item.run.id));
    if (runIds.size !== 1) throw new Error('One conversation completion batch spans multiple active Runs.');

    const builder = builderFor(view, context, payload.conversationId);
    const projectedTools = new Map<string, ToolCallRecord>();
    const terminalToolIds: string[] = [];
    const completedOperationIds: string[] = [];
    let createsWait = false;
    for (const item of current) {
      const completion = item.payload;
      const terminalOutcome = completion.outcome === 'failed' ? 'failed' : 'succeeded';
      appendMutations(builder, completeAttempt(view.facts, { ...completion, now: context.now, outcome: terminalOutcome, error: completion.error }).mutations);
      assertCompletionResultIdentity(completion, item.tool);
      const status = completion.outcome === 'awaiting_change_apply'
        ? 'awaiting_change_apply' as const
        : completion.outcome === 'awaiting_result_submit'
          ? 'awaiting_result_submit' as const
          : completion.finalStatus ?? (completion.outcome === 'succeeded' ? 'success' as const : 'error' as const);
      const projected: ToolCallRecord = {
        ...item.tool,
        status,
        ...(completion.responseParts !== undefined ? { responseParts: clone(completion.responseParts) } : {}),
        ...(completion.error ? { error: completion.error } : {}),
        ...(completion.durationMs !== undefined ? { durationMs: completion.durationMs } : {}),
        ...(completion.outcome === 'awaiting_result_submit'
          ? { progress: { pendingResultSubmitStatus: completion.finalStatus ?? (completion.error ? 'error' : 'success') } }
          : {}),
        updatedAt: completion.completedAt
      };
      projectedTools.set(projected.id, projected);
      completedOperationIds.push(completion.operationId);
      builder
        .generatedId(completion.resultArtifact.id, completion.resultLink.id)
        .upsert('toolResultArtifacts', clone(completion.resultArtifact));
      replaceFinalToolResultLink(
        builder,
        view.facts.toolCallResultLinks,
        clone(completion.resultLink),
        completion.completedAt
      );
      builder
        .upsert('toolCalls', projected)
        .upsert('toolExecutions', { ...item.execution, state: completion.outcome === 'failed' ? 'error' : 'complete', rowVersion: item.execution.rowVersion + 1 });
      if (completion.outcome === 'awaiting_change_apply' || completion.outcome === 'awaiting_result_submit') {
        createsWait = true;
        if (completion.outcome === 'awaiting_change_apply') {
          appendFileChangeInteraction(
            builder,
            item.run,
            projected,
            completion,
            effectPayloadForOperation(view.facts, completion.operationId),
            context.now
          );
        } else {
          appendResultReviewInteraction(builder, item.run, projected, completion, context.now);
        }
      } else {
        terminalToolIds.push(completion.toolCallId);
      }
      builder.patch(payload.conversationId, { kind: 'tool.upsert', toolCallId: completion.toolCallId });
    }

    const run = current[0]!.run;
    const continued = !createsWait && !hasRemainingToolWork(view.facts, {
      runId: run.id,
      toolCallIds: terminalToolIds,
      operationIds: completedOperationIds
    });
    if (continued) {
      const projectedLinks = current.reduce<ToolCallResultLinkRecord[]>(
        (links, item) => replacedFinalToolResultLinks(
          links,
          clone(item.payload.resultLink),
          item.payload.completedAt
        ),
        view.facts.toolCallResultLinks.map((link) => clone(link))
      );
      const projectedFacts: DurableConversationFacts = {
        ...view.facts,
        toolCalls: view.facts.toolCalls.map((tool) => projectedTools.get(tool.id) ?? tool),
        toolResultArtifacts: [
          ...view.facts.toolResultArtifacts,
          ...current.map((item) => clone(item.payload.resultArtifact))
        ],
        toolCallResultLinks: projectedLinks
      };
      const continuation = [...current].sort((left, right) =>
        (left.tool.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.tool.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER)
        || left.tool.id.localeCompare(right.tool.id)).at(-1)!;
      appendToolResponsesAndNextInvocation(builder, projectedFacts, run, continuation.payload, context.now);
    } else if (createsWait && run.phase !== 'waiting_tools') {
      builder.upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    }
    return builder.build(asJson({
      status: 'completed',
      toolCallIds: current.map((item) => item.tool.id),
      continued
    }));
  }
}

function appendPostLlmCheckpointBarrier(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  checkpoint: { ids: ReliableProgressIds; plan: ReliableCheckpointBarrierPlan },
  continuation: ReliablePostLlmContinuation,
  now: number
): void {
  if (checkpoint.plan.checkpoint.conversationId !== run.conversationId || checkpoint.plan.createRequest.trigger !== 'llm_response_after') {
    throw new Error(`Post-LLM Checkpoint escaped Run ${run.id} or has the wrong trigger.`);
  }
  appendCheckpointPlanRecords(builder, facts, checkpoint.plan, now);
  const effectPayload: ReliableBarrierEffectPayload = {
    barrier: 'checkpoint.after_llm',
    plan: clone(checkpoint.plan),
    continuation: clone(continuation)
  };
  const progress = createPrimaryProgress({
    ids: checkpoint.ids,
    conversationId: run.conversationId,
    runId: run.id,
    kind: 'checkpoint.after_llm',
    now,
    deadlineMs: policyNumber(facts, run.id, 'checkpointDeadlineMs'),
    timeoutPolicy: 'release_optional_barrier',
    recoveryPolicy: 'interrupt_on_restart',
    payload: clone(effectPayload) as unknown as JsonValue
  });
  builder
    .generatedId(checkpoint.ids.operationId, checkpoint.ids.attemptId, checkpoint.ids.effectIntentId)
    .upsert('turns', { ...run, phase: 'waiting_checkpoint_after_llm', rowVersion: run.rowVersion + 1, updatedAt: now });
  appendPrimaryProgress(builder, progress);
}

function appendLlmSuccessContinuation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  modelMessageId: MessageId,
  toolCalls: readonly PlannedToolCall[],
  now: number
): boolean {
  if (toolCalls.length === 0) {
    const steered = appendPendingTurnInputsAndNextInvocation(builder, facts, run, nextMessageSeq(facts), now);
    if (steered > 0) return true;
    const delivered = appendPendingRuntimeDeliveriesAndNextInvocation(builder, facts, run, nextMessageSeq(facts), now);
    if (delivered > 0) return true;
    builder.upsert('turns', completedRunRecord(run, now));
    removeSlot(builder, facts, run.id, now);
    return false;
  }
  for (const tool of toolCalls) appendToolCall(builder, run.id, modelMessageId, run.conversationId, tool, now);
  const waitingKind = soleWaitingKind(toolCalls);
  if (waitingKind) {
    builder.upsert('turns', { ...run, phase: waitingKind, rowVersion: run.rowVersion + 1, updatedAt: now });
    return true;
  }
  builder.upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: now });
  return true;
}

export interface StreamCheckpointPayload extends AttemptTokenPayload {
  requestId: RequestId;
  streamSeq: number;
  content: MessageContent;
  toolCalls: Array<{
    functionCallId?: string;
    name: string;
    argsJson: string;
    thoughtSignature?: string;
  }>;
  payloadHash: string;
  file: string;
}

export class CommitStreamCheckpointHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('stream.checkpoint', payloadOf<StreamCheckpointPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<StreamCheckpointPayload>(command);
    const matched = requireDispatched(view.facts, payload, 'llm.request');
    if (matched.status === 'stale') return matched.noop;
    const request = unique(view.facts.requests, payload.requestId, 'Request');
    if (!request || request.operationId !== payload.operationId || request.state !== 'streaming') return stale('request_not_streaming');
    const current = view.facts.streamCheckpointHeads.find((head) => head.requestId === payload.requestId && head.attemptId === payload.attemptId && head.generation === payload.generation);
    if (current && current.streamSeq >= payload.streamSeq) return { status: 'already_satisfied', result: asJson({ status: 'checkpoint_already_advanced', streamSeq: current.streamSeq }) };
    if (payload.content.role !== 'model' || canonicalSha256({
      requestId: payload.requestId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      streamSeq: payload.streamSeq,
      content: payload.content,
      toolCalls: payload.toolCalls
    }) !== payload.payloadHash) {
      throw new Error(`Stream checkpoint payload is corrupt: ${payload.requestId}:${payload.streamSeq}`);
    }
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .upsert('streamCheckpointHeads', {
        id: streamHeadId(payload.requestId, payload.attemptId, payload.generation),
        requestId: payload.requestId,
        attemptId: payload.attemptId,
        generation: payload.generation,
        streamSeq: payload.streamSeq,
        payloadHash: payload.payloadHash,
        file: payload.file,
        resolvedContent: clone(payload.content)
      })
      .upsert('requests', { ...request, streamSeq: payload.streamSeq, rowVersion: request.rowVersion + 1 });
    builder.patch(payload.conversationId, { kind: 'stream.checkpoint', requestId: payload.requestId, streamSeq: payload.streamSeq });
    return builder.build(asJson({ status: 'checkpoint_committed', streamSeq: payload.streamSeq }));
  }
}

export interface WatchdogPayload extends AttemptTokenPayload {
  replacementAttemptId: AttemptId;
  replacementEffectIntentId: EffectIntentId;
}

export class WatchdogTimeoutHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('operation.watchdog', payloadOf<WatchdogPayload>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<WatchdogPayload>(command);
    const transition = watchdogTimeoutTransition(view.facts, { ...payload, now: context.now });
    const status = stringField(transition.result, 'status');
    if (status === 'stale' || status === 'not_due') return { status: status === 'stale' ? 'stale' : 'already_satisfied', result: transition.result };
    const builder = builderFor(view, context, payload.conversationId);
    if (status === 'run_failed' || status === 'run_interrupted') {
      const operation = unique(view.facts.operations, payload.operationId, 'Operation');
      if (!operation) throw new Error(`Watchdog terminal transition lacks Operation: ${payload.operationId}`);
      const termination = planTerminateRunGraph(view.facts, {
        rootRunIds: [requireRunOperationOwner(operation)],
        termination: {
          kind: status === 'run_failed' ? 'failed' : 'interrupted',
          actor: 'system',
          reasonCode: 'operation_timed_out'
        },
        ...runGraphCascadeForPolicy('conversation_stop')
      });
      appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
    }
    // Timeout-specific states (timed_out/interrupted/failed) intentionally override the generic
    // graph cleanup's cancelled markers for the selected Attempt and its sibling Operations.
    appendMutations(builder, transition.mutations);
    if (status === 'retry_required') {
      appendRuntimeCleanupOutbox(builder, view.facts, [payload.attemptId], context.now);
      for (const hint of cleanupHintsForAttempts(view.facts, [payload.attemptId])) builder.cleanupHint(hint);
      const operation = unique(view.facts.operations, payload.operationId, 'Operation');
      const descriptor = view.facts.primaryEffects.find((effect) => effect.operationId === payload.operationId && effect.attemptId === payload.attemptId && effect.generation === payload.generation);
      if (!operation || !descriptor) throw new Error(`Watchdog retry lacks Operation/descriptor: ${payload.operationId}`);
      const nextGeneration = operation.currentGeneration + 1;
      const retryWindowMs = descriptor.deadlineAt - operation.updatedAt;
      if (!Number.isFinite(retryWindowMs) || retryWindowMs <= 0) {
        throw new Error(`Watchdog retry has an invalid frozen deadline window: ${payload.operationId}`);
      }
      const attempt: AttemptRecord = {
        ...copyOperationOwner(operation),
        id: payload.replacementAttemptId,
        operationId: operation.id,
        conversationId: operation.conversationId,
        generation: nextGeneration,
        state: 'pending',
        deadlineAt: context.now + retryWindowMs,
        rowVersion: 1
      };
      builder
        .generatedId(payload.replacementAttemptId, payload.replacementEffectIntentId)
        .upsert('attempts', attempt)
        .upsert('primaryEffects', { ...descriptor, id: payload.replacementEffectIntentId, effectIntentId: payload.replacementEffectIntentId, attemptId: attempt.id, generation: nextGeneration, deadlineAt: attempt.deadlineAt, idempotencyKey: `${operation.id}:${nextGeneration}` });
    } else if (status === 'optional_barrier_released') {
      appendRuntimeCleanupOutbox(builder, view.facts, [payload.attemptId], context.now);
      for (const hint of cleanupHintsForAttempts(view.facts, [payload.attemptId])) builder.cleanupHint(hint);
      const operation = unique(view.facts.operations, payload.operationId, 'Operation');
      const descriptor = view.facts.primaryEffects.find((effect) => effect.operationId === payload.operationId && effect.attemptId === payload.attemptId && effect.generation === payload.generation);
      const effectPayload = descriptor
        ? view.facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id && candidate.operationId === operation?.id)
        : undefined;
      if (!operation || !effectPayload || !isReliableBarrierEffectPayload(effectPayload.payload)) {
        throw new Error(`Optional barrier ${payload.operationId} has no durable continuation.`);
      }
      if (effectPayload.payload.barrier === 'compression.standalone') {
        const block = unique(view.facts.compressionBlocks, effectPayload.payload.plan.block.id, 'CompressionBlock');
        if (!block) throw new Error(`Timed-out standalone CompressionBlock is missing: ${effectPayload.payload.plan.block.id}`);
        builder.upsert('compressionBlocks', { ...block, status: 'error', error: 'compression_deadline_exceeded', updatedAt: context.now, completedAt: context.now });
      } else {
        const run = requireRun(view.facts, requireRunOperationOwner(operation));
        if (effectPayload.payload.barrier === 'compression.pre_llm') {
          const block = unique(view.facts.compressionBlocks, effectPayload.payload.plan.block.id, 'CompressionBlock');
          if (!block) throw new Error(`Timed-out CompressionBlock is missing: ${effectPayload.payload.plan.block.id}`);
          builder.upsert('compressionBlocks', { ...block, status: 'error', error: 'compression_deadline_exceeded', updatedAt: context.now, completedAt: context.now });
        } else {
          const checkpoint = unique(view.facts.checkpoints, effectPayload.payload.plan.checkpoint.id, 'Checkpoint');
          if (!checkpoint) throw new Error(`Timed-out Checkpoint is missing: ${effectPayload.payload.plan.checkpoint.id}`);
          builder.upsert('checkpoints', { ...checkpoint, status: 'failed', skipReason: 'io_error', message: 'checkpoint_deadline_exceeded', updatedAt: context.now });
        }
        if (effectPayload.payload.barrier === 'checkpoint.after_llm') {
          const message = unique(view.facts.messages, effectPayload.payload.continuation.modelMessageId, 'Model Message');
          if (!message) throw new Error(`Post-LLM checkpoint continuation Message is missing: ${effectPayload.payload.continuation.modelMessageId}`);
          appendLlmSuccessContinuation(builder, view.facts, run, message.id as MessageId, effectPayload.payload.continuation.toolCalls, context.now);
        } else {
          appendBarrierContinuation(builder, view.facts, run, effectPayload.payload.continuation, context.now);
        }
      }
    }
    builder.patch(payload.conversationId, { kind: 'operation.timeout', operationId: payload.operationId, status });
    return builder.build(transition.result);
  }
}


export class RestartReconciliationHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('restart.reconcile', payloadOf<{ conversationId: ConversationId }>(command).conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const conversationId = payloadOf<{ conversationId: ConversationId }>(command).conversationId;
    const reconciliation = reconcileAfterRestart(view.facts, context.now);
    if (reconciliation.diagnostics.some((diagnostic) => diagnostic.kind === 'integrity_violation')) {
      throw new Error(`Restart reconciliation found an integrity violation in ${conversationId}: ${JSON.stringify(reconciliation.diagnostics)}`);
    }
    if (reconciliation.mutations.length === 0) {
      return { status: 'already_satisfied', result: asJson({ status: 'clean' }) };
    }
    const builder = builderFor(view, context, conversationId);
    const unknownRunIds = new Set(reconciliation.diagnostics
      .filter((item): item is typeof item & { runId: RunId } => item.kind === 'outcome_unknown' && item.runId !== undefined)
      .map((item) => item.runId));
    const terminalInterruptedRunIds = [...new Set(reconciliation.diagnostics
      .filter((item): item is typeof item & { runId: RunId } => item.kind === 'interrupted' && item.runId !== undefined && !unknownRunIds.has(item.runId))
      .map((item) => item.runId))];
    if (terminalInterruptedRunIds.length > 0) {
      const termination = planTerminateRunGraph(view.facts, {
        rootRunIds: terminalInterruptedRunIds,
        termination: { kind: 'interrupted', actor: 'system', reasonCode: 'extension_host_restarted' },
        ...runGraphCascadeForPolicy('conversation_stop')
      });
      appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
    }
    const unknownChildren = view.facts.childTurnLinks
      .filter((child) => unknownRunIds.has(child.parentTurnId) && child.mode === 'foreground')
      .map((child) => child.childTurnId);
    for (const childRunId of [...new Set(unknownChildren)]) {
      const parentLinks = view.facts.childTurnLinks.filter((child) => child.childTurnId === childRunId && unknownRunIds.has(child.parentTurnId));
      if (parentLinks.length !== 1) throw new Error(`Unknown-outcome child Run ${childRunId} has ${parentLinks.length} causal parents.`);
      const termination = planTerminateRunGraph(view.facts, {
        rootRunIds: [childRunId],
        termination: {
          kind: 'interrupted',
          actor: 'parent_run',
          reasonCode: 'parent_outcome_unknown',
          triggerRunId: parentLinks[0].parentTurnId
        },
        ...runGraphCascadeForPolicy('conversation_stop')
      });
      appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
    }
    appendMutations(builder, reconciliation.mutations);
    for (const diagnostic of reconciliation.diagnostics.filter((item) => item.kind === 'interrupted' && item.runId === undefined && item.operationId)) {
      const operation = unique(view.facts.operations, diagnostic.operationId!, 'Conversation Operation');
      const descriptor = operation
        ? view.facts.primaryEffects.find((candidate) => candidate.operationId === operation.id && candidate.generation === operation.currentGeneration)
        : undefined;
      const effectPayload = descriptor
        ? view.facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id && candidate.operationId === operation?.id)
        : undefined;
      if (!effectPayload || !isReliableBarrierEffectPayload(effectPayload.payload) || effectPayload.payload.barrier !== 'compression.standalone') continue;
      const block = unique(view.facts.compressionBlocks, effectPayload.payload.plan.block.id, 'Standalone CompressionBlock');
      if (block?.status === 'running' || block?.status === 'pending') {
        builder.upsert('compressionBlocks', {
          ...block,
          status: 'error',
          error: 'compression_interrupted_by_restart',
          updatedAt: context.now,
          completedAt: context.now
        });
      }
    }
    for (const hint of reconciliation.cleanupHints) builder.cleanupHint(hint);
    builder.patch(conversationId, {
      kind: 'restart.reconciled',
      diagnostics: reconciliation.diagnostics
    });
    return builder.build(asJson({
      status: 'reconciled',
      diagnostics: reconciliation.diagnostics
    }));
  }
}

function appendToolCall(
  builder: ConversationTransitionBuilder,
  runId: RunId,
  messageId: MessageId,
  conversationId: ConversationId,
  tool: PlannedToolCall,
  now: number
): void {
  const planProposalId = tool.execution === 'waiting_plan_review' ? `plan-proposal:${tool.toolCallId}` : undefined;
  const record: ToolCallRecord = {
    id: tool.toolCallId,
    messageId,
    name: tool.name,
    ...(tool.functionCallId ? { functionCallId: tool.functionCallId } : {}),
    args: tool.argsJson,
    schedulingOrdinal: tool.schedulingOrdinal,
    schedulingMode: tool.schedulingMode,
    ...(tool.schedulingReason ? { schedulingReason: tool.schedulingReason } : {}),
    status: tool.execution === 'waiting_user' || tool.execution === 'waiting_plan_review'
      ? 'awaiting_user_input'
      : tool.execution === 'waiting_approval'
        ? 'awaiting_approval'
        : 'queued',
    ...(planProposalId ? { progress: { planProposalId, waitingFor: 'plan_review' } } : {}),
    createdAt: now,
    updatedAt: now
  };
  builder
    .generatedId(tool.toolCallId, tool.toolCallEventId)
    .upsert('toolCalls', record)
    .upsert('toolCallEvents', { id: tool.toolCallEventId, toolCallId: tool.toolCallId, seq: 1, kind: 'created', at: now, status: record.status })
    .upsert('toolRunLinks', { id: relationId('tool-run', tool.toolCallId, runId), toolCallId: tool.toolCallId, runId, role: 'produced_by' });
  if (tool.execution === 'waiting_user' || tool.execution === 'waiting_plan_review') {
    const interactionKind = tool.execution === 'waiting_user' ? 'ask_user' as const : 'plan_review' as const;
    const interactionRequestId = interactionRequestIdForTool(interactionKind, tool.toolCallId);
    builder
      .generatedId(interactionRequestId)
      .upsert('interactionRequests', manualInteractionRequest({
        id: interactionRequestId,
        kind: interactionKind,
        subject: asJson({
          toolCallId: tool.toolCallId,
          name: tool.name,
          argsJson: tool.argsJson,
          ...(planProposalId ? { planProposalId } : {})
        }),
        now
      }))
      .upsert('interactionOwnerLinks', interactionOwnerLink({
        interactionRequestId,
        turnId: runId,
        conversationId,
        sourceToolCallId: tool.toolCallId,
        now
      }));
    return;
  }
  if (tool.execution === 'waiting_approval') {
    if (!tool.approval) throw new Error(`Tool ${tool.name} has no frozen approval dispatch plan.`);
    const interactionRequestId = interactionRequestIdForTool('exec_approval', tool.toolCallId);
    builder
      .generatedId(interactionRequestId)
      .upsert('interactionRequests', manualInteractionRequest({
        id: interactionRequestId,
        kind: 'exec_approval',
        subject: asJson({
          toolCallId: tool.toolCallId,
          name: tool.name,
          argsJson: tool.argsJson,
          approval: tool.approval
        }),
        now
      }))
      .upsert('interactionOwnerLinks', interactionOwnerLink({
        interactionRequestId,
        turnId: runId,
        conversationId,
        sourceToolCallId: tool.toolCallId,
        now
      }));
    return;
  }
  if (!tool.operationId || !tool.attemptId || !tool.effectIntentId || !tool.recoveryPolicy || !tool.timeoutPolicy || !tool.deadlineMs || tool.effectPayload === undefined) {
    throw new Error(`Tool ${tool.name} has no complete Operation/Attempt descriptor.`);
  }
  const progress = createPrimaryProgress({
    ids: { operationId: tool.operationId, attemptId: tool.attemptId, effectIntentId: tool.effectIntentId },
    conversationId,
    runId,
    kind: tool.execution === 'agentRun' ? `tool.agent.${tool.name}` : tool.recoveryPolicy === 'require_resolution' ? `tool.write.${tool.name}` : `tool.read.${tool.name}`,
    now,
    deadlineMs: tool.deadlineMs,
    timeoutPolicy: tool.timeoutPolicy,
    recoveryPolicy: tool.recoveryPolicy,
    payload: tool.effectPayload
  });
  builder
    .generatedId(tool.operationId, tool.attemptId, tool.effectIntentId)
    .upsert('toolExecutions', { id: tool.toolCallId, conversationId, runId, operationId: tool.operationId, state: 'pending', rowVersion: 1 });
  appendPrimaryProgress(builder, progress);
}

export interface ToolContinuationPayload {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  outcome: 'succeeded' | 'failed' | 'awaiting_change_apply' | 'awaiting_result_submit';
  finalStatus?: 'success' | 'warning' | 'error';
  /** Every completion carries the bounded response frozen in its final Artifact. */
  modelResponse: JsonValue;
  responseParts?: InlineDataPart[];
  error?: string;
  completedAt: number;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

function appendResultReviewInteraction(
  builder: ConversationTransitionBuilder,
  run: DurableConversationFacts['turns'][number],
  tool: ToolCallRecord,
  payload: ToolCompletedCallbackPayload,
  now: number
): void {
  const interactionRequestId = interactionRequestIdForTool('result_review', payload.toolCallId);
  builder
    .generatedId(interactionRequestId)
    .upsert('interactionRequests', manualInteractionRequest({
      id: interactionRequestId,
      kind: 'result_review',
      subject: asJson({
        toolCallId: payload.toolCallId,
        artifactId: payload.resultArtifact.id,
        contentHash: payload.resultArtifact.contentHash,
        pendingStatus: payload.finalStatus ?? (payload.error ? 'error' : 'success')
      }),
      subjectRef: payload.resultArtifact.id,
      subjectDigest: payload.resultArtifact.contentHash,
      now
    }))
    .upsert('interactionOwnerLinks', interactionOwnerLink({
      interactionRequestId,
      turnId: run.id,
      conversationId: payload.conversationId,
      sourceToolCallId: tool.id as ToolCallId,
      now
    }));
}

function appendFileChangeInteraction(
  builder: ConversationTransitionBuilder,
  run: DurableConversationFacts['turns'][number],
  tool: ToolCallRecord,
  payload: ToolCompletedCallbackPayload,
  resumePayload: JsonValue | undefined,
  now: number
): void {
  const interactionRequestId = payload.interactionRequestId;
  if (!interactionRequestId) throw new Error(`Tool change completion ${tool.id} has no InteractionRequest identity.`);
  const policy = jsonObject(resumePayload);
  if (!policy) throw new Error(`Tool change completion ${tool.id} has no frozen policy payload.`);
  const autoApply = policy.autoApplyChange === true;
  const rawDelay = policy.autoApplyChangeDelaySeconds;
  if (autoApply && (typeof rawDelay !== 'number' || !Number.isFinite(rawDelay))) {
    throw new Error(`Tool change completion ${tool.id} has no frozen auto-apply delay.`);
  }
  const delaySeconds = autoApply ? Math.min(600, Math.max(0, Math.floor(rawDelay as number))) : undefined;
  const mode = !autoApply ? 'manual' as const : delaySeconds === 0 ? 'auto_immediate' as const : 'auto_at' as const;
  const notBeforeAt = autoApply ? now + delaySeconds! * 1_000 : undefined;
  const workEnvironment = jsonObject(policy.workEnvironment);
  const environmentId = typeof workEnvironment?.id === 'string' && workEnvironment.id ? workEnvironment.id : undefined;
  const interactionPayload = asJson({
    toolCallId: tool.id,
    proposalArtifactId: payload.resultArtifact.id,
    proposalContentHash: payload.resultArtifact.contentHash,
    executionContext: clone(policy) as JsonValue
  });
  const policyVersion = canonicalSha256(asJson({
    autoApplyChange: autoApply,
    ...(delaySeconds !== undefined ? { autoApplyChangeDelaySeconds: delaySeconds } : {}),
    autoSubmitResult: policy.autoSubmitResult !== false,
    ...(environmentId ? { environmentId } : {})
  }));
  builder
    .generatedId(interactionRequestId)
    .upsert('interactionRequests', {
      id: interactionRequestId,
      revision: 1,
      kind: 'patch_approval',
      state: 'pending',
      choices: ['accept', 'reject'],
      payload: interactionPayload,
      payloadDigest: canonicalSha256(interactionPayload),
      subjectRef: payload.resultArtifact.id,
      subjectDigest: payload.resultArtifact.contentHash,
      policySnapshot: {
        mode,
        ...(autoApply ? { autoDecision: 'accept' as const, notBeforeAt } : {}),
        policyVersion,
        ...(environmentId ? { environmentId } : {})
      },
      createdAt: now,
      updatedAt: now
    })
    .upsert('interactionOwnerLinks', interactionOwnerLink({
      interactionRequestId,
      turnId: run.id,
      conversationId: payload.conversationId,
      sourceToolCallId: tool.id as ToolCallId,
      now
    }));
}

function assertCompletionResultIdentity(payload: ToolCompletedCallbackPayload, tool: ToolCallRecord): void {
  if (payload.resultArtifact.conversationId !== payload.conversationId
    || payload.resultLink.conversationId !== payload.conversationId
    || payload.resultLink.toolCallId !== tool.id
    || payload.resultLink.artifactId !== payload.resultArtifact.id
    || payload.resultLink.role !== 'final'
    || payload.resultArtifact.createdAt !== payload.completedAt
    || payload.resultLink.createdAt !== payload.completedAt
    || payload.resultLink.updatedAt !== payload.completedAt
    || canonicalSha256(payload.resultArtifact.modelResponse) !== canonicalSha256(payload.modelResponse)) {
    throw new Error(`Tool completion ${tool.id} has an invalid Artifact/Link identity closure.`);
  }
}

function conversationIdForToolCall(facts: DurableConversationFacts, toolCallId: string): string {
  const link = facts.toolRunLinks.find((candidate) => candidate.toolCallId === toolCallId);
  const run = link ? facts.turns.find((candidate) => candidate.id === link.runId) : undefined;
  if (!run) throw new Error(`ToolCall ${toolCallId} has no Run conversation owner.`);
  return run.conversationId;
}

function modelResponseForTool(
  facts: DurableConversationFacts,
  toolCallId: string,
  current: ToolContinuationPayload
): JsonValue {
  if (toolCallId === current.toolCallId) return clone(current.modelResponse);
  const links = facts.toolCallResultLinks.filter((link) => link.toolCallId === toolCallId && link.role === 'final');
  if (links.length !== 1) throw new Error(`Terminal ToolCall ${toolCallId} has ${links.length} final result links.`);
  const artifact = unique(facts.toolResultArtifacts, links[0]!.artifactId, 'ToolResultArtifact');
  if (!artifact) throw new Error(`Terminal ToolCall ${toolCallId} has no final ToolResultArtifact.`);
  return clone(artifact.modelResponse);
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function effectPayloadForOperation(facts: DurableConversationFacts, operationId: OperationId): JsonValue | undefined {
  const operation = facts.operations.find((candidate) => candidate.id === operationId);
  if (!operation) return undefined;
  const descriptor = facts.primaryEffects.find((candidate) => candidate.operationId === operation.id
    && candidate.generation === operation.currentGeneration);
  const payload = descriptor && descriptor.payloadRef.kind !== 'released'
    ? facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id
      && candidate.operationId === operation.id
      && candidate.payloadHash === descriptor.payloadRef.hash)
    : undefined;
  return payload ? clone(payload.payload) : undefined;
}

export function appendToolResponsesAndNextInvocation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  payload: ToolContinuationPayload,
  now: number
): void {
  const completedTool = unique(facts.toolCalls, payload.toolCallId, 'ToolCall');
  if (!completedTool) throw new Error(`Completed ToolCall is missing: ${payload.toolCallId}`);
  if (!unique(facts.messages, completedTool.messageId, 'ToolCall model Message')) {
    throw new Error(`ToolCall model Message is missing: ${completedTool.messageId}`);
  }
  const runTools = facts.toolRunLinks
    .filter((link) => link.runId === run.id)
    .map((link) => unique(facts.toolCalls, link.toolCallId, 'ToolCall'))
    .filter((tool): tool is ToolCallRecord => !!tool && tool.messageId === completedTool.messageId)
    .sort((left, right) => scheduledToolOrdinal(left) - scheduledToolOrdinal(right) || left.id.localeCompare(right.id));
  const currentTools = runTools.map((tool) => tool.id === payload.toolCallId
    ? {
        ...tool,
        status: payload.finalStatus ?? (payload.outcome === 'succeeded' ? 'success' as const : 'error' as const),
        ...(payload.responseParts !== undefined ? { responseParts: clone(payload.responseParts) } : {}),
        error: payload.error
      }
    : tool);
  const unresolved = currentTools.filter((tool) => !TERMINAL_TOOL_CALL_STATUSES.has(tool.status));
  if (unresolved.length > 0) {
    throw new Error(`Run ${run.id} cannot continue while ToolCalls remain unfinished: ${unresolved.map((tool) => tool.id).join(', ')}`);
  }
  const responseContent: MessageContent = {
    role: 'user',
    // 原始结果只由 Artifact/Blob 持有；Message 只保存 Artifact 中冻结的 bounded modelResponse。
    parts: currentTools.map((tool) => canonicalToolResponsePart(tool, modelResponseForTool(facts, tool.id, payload)))
  };
  const response: MessageRecord = {
    id: payload.responseMessageId,
    conversationId: payload.conversationId,
    role: 'user',
    presentation: 'visible',
    content: responseContent,
    status: 'final',
    seq: nextMessageSeq(facts),
    createdAt: payload.completedAt
  };
  const revision: MessageRevisionRecord = { id: payload.responseRevisionId, messageId: response.id, conversationId: payload.conversationId, content: responseContent, createdAt: payload.completedAt, reason: 'created' };
  builder
    .generatedId(payload.responseMessageId, payload.responseRevisionId)
    .upsert('messages', response)
    .upsert('messageRevisions', revision)
    .upsert('messageCurrentRevisionLinks', { id: relationId('message-current-revision', response.id), messageId: response.id, revisionId: revision.id })
    .upsert('messageTurnLinks', { id: relationId('message-turn', response.id, run.id, 'tool_response'), messageId: response.id, turnId: run.id, role: 'tool_response' });

  const steered = appendPendingTurnInputsAndNextInvocation(builder, facts, run, response.seq + 1, now);
  if (steered > 0) return;
  const delivered = appendPendingRuntimeDeliveriesAndNextInvocation(builder, facts, run, response.seq + 1, now);
  if (delivered > 0) return;
  appendNextInvocation(builder, facts, run, {
    invocationId: payload.nextInvocationId,
    requestId: payload.nextRequestId,
    operationId: payload.nextOperationId,
    attemptId: payload.nextAttemptId,
    effectIntentId: payload.nextEffectIntentId
  }, now);
}

interface NextInvocationIds {
  invocationId: InvocationId;
  requestId: RequestId;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

/** Commits every accepted steer input only at a proven model/tool continuation boundary. */
function appendPendingTurnInputsAndNextInvocation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  firstMessageSeq: number,
  now: number
): number {
  const lease = facts.executionLeases.find((candidate) => candidate.conversationId === run.conversationId
    && candidate.turnId === run.id && candidate.state !== 'released');
  if (!lease) return 0;
  const pending = facts.pendingTurnInputs
    .filter((input) => input.state === 'pending'
      && input.conversationId === run.conversationId
      && input.targetTurnId === run.id
      && input.targetLeaseEpoch === lease.epoch)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  if (pending.length === 0) return 0;

  for (const [index, input] of pending.entries()) {
    const content = clone(input.content) as unknown as MessageContent;
    if (content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length === 0
      || canonicalSha256(content) !== input.contentHash) {
      throw new Error(`PendingTurnInput ${input.id} has invalid committed content.`);
    }
    const messageId = stableIdFromSeed('message', `pending-turn-input:${input.id}:message`);
    const revisionId = stableIdFromSeed('messageRevision', `pending-turn-input:${input.id}:revision`);
    const message: MessageRecord = {
      id: messageId,
      conversationId: run.conversationId,
      role: 'user',
      presentation: 'visible',
      content,
      status: 'final',
      seq: firstMessageSeq + index,
      createdAt: now
    };
    const revision: MessageRevisionRecord = {
      id: revisionId,
      messageId,
      conversationId: run.conversationId,
      content: clone(content),
      createdAt: now,
      reason: 'created'
    };
    builder
      .generatedId(messageId, revisionId)
      .upsert('messages', message)
      .upsert('messageRevisions', revision)
      .upsert('messageCurrentRevisionLinks', {
        id: relationId('message-current-revision', message.id),
        messageId: message.id,
        revisionId: revision.id
      })
      .upsert('messageTurnLinks', {
        id: relationId('message-turn', message.id, run.id, 'input'),
        messageId: message.id,
        turnId: run.id,
        role: 'input'
      })
      .upsert('pendingTurnInputs', {
        ...input,
        state: 'admitted',
        admittedMessageId: message.id,
        admittedAt: now,
        rowVersion: input.rowVersion + 1,
        updatedAt: now
      })
      .patch(run.conversationId, {
        kind: 'turnInput.admitted',
        pendingInputId: input.id,
        turnId: run.id,
        messageId: message.id
      });
  }
  const seed = canonicalSha256(pending.map((input) => input.id));
  appendNextInvocation(builder, facts, run, {
    invocationId: stableIdFromSeed('invocation', `pending-turn-input:${run.id}:${seed}:invocation`),
    requestId: stableIdFromSeed('request', `pending-turn-input:${run.id}:${seed}:request`),
    operationId: stableIdFromSeed('operation', `pending-turn-input:${run.id}:${seed}:operation`),
    attemptId: stableIdFromSeed('attempt', `pending-turn-input:${run.id}:${seed}:attempt`),
    effectIntentId: stableIdFromSeed('effectIntent', `pending-turn-input:${run.id}:${seed}:effect`)
  }, now);
  return pending.length;
}

/** Materializes generic asynchronous inputs at a proven same-Turn continuation boundary. */
export function appendPendingRuntimeDeliveriesAndNextInvocation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  messageSeq: number,
  now: number
): number {
  const lease = effectiveConversationExecutionLease(facts, run.conversationId);
  if (lease?.turnId !== run.id) return 0;
  const batch = pendingRuntimeDeliveries(facts, ['inject_current_or_continue']);
  if (batch.length === 0) return 0;
  const digest = runtimeDeliveryBatchDigest(batch);
  const messageId = stableIdFromSeed('message', `runtime-delivery:${run.id}:${digest}:message`);
  const revisionId = stableIdFromSeed('messageRevision', `runtime-delivery:${run.id}:${digest}:revision`);
  const content = runtimeDeliveryMessageContent(batch);
  const message: MessageRecord = {
    id: messageId,
    conversationId: run.conversationId,
    role: 'user',
    presentation: 'internal',
    content,
    status: 'final',
    seq: messageSeq,
    createdAt: now
  };
  const revision: MessageRevisionRecord = {
    id: revisionId,
    messageId,
    conversationId: run.conversationId,
    content: clone(content),
    createdAt: now,
    reason: 'created'
  };
  builder
    .generatedId(message.id, revision.id)
    .upsert('messages', message)
    .upsert('messageRevisions', revision)
    .upsert('messageCurrentRevisionLinks', { id: relationId('message-current-revision', message.id), messageId: message.id, revisionId: revision.id })
    .upsert('messageTurnLinks', { id: relationId('message-turn', message.id, run.id, 'notification'), messageId: message.id, turnId: run.id, role: 'notification' });
  for (const { delivery } of batch) {
    builder.upsert('runtimeDeliveryLinks', {
      ...delivery,
      targetTurnId: run.id,
      state: 'consumed',
      consumedAt: now,
      rowVersion: delivery.rowVersion + 1,
      updatedAt: now
    });
  }
  appendNextInvocation(builder, facts, run, {
    invocationId: stableIdFromSeed('invocation', `runtime-delivery:${run.id}:${digest}:invocation`),
    requestId: stableIdFromSeed('request', `runtime-delivery:${run.id}:${digest}:request`),
    operationId: stableIdFromSeed('operation', `runtime-delivery:${run.id}:${digest}:operation`),
    attemptId: stableIdFromSeed('attempt', `runtime-delivery:${run.id}:${digest}:attempt`),
    effectIntentId: stableIdFromSeed('effectIntent', `runtime-delivery:${run.id}:${digest}:effect`)
  }, now);
  return batch.length;
}


function appendNextInvocation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  ids: NextInvocationIds,
  now: number
): void {
  const invocation: DurableInvocationRecord = {
    id: ids.invocationId,
    conversationId: run.conversationId,
    runId: run.id,
    requestId: ids.requestId,
    operationId: ids.operationId,
    status: 'resolving',
    rowVersion: 1,
    createdAt: now
  };
  const request: RequestExecutionRecord = {
    id: ids.requestId,
    conversationId: run.conversationId,
    runId: run.id,
    invocationId: invocation.id,
    operationId: ids.operationId,
    state: 'pending',
    createdAt: now,
    rowVersion: 1
  };
  const progress = createPrimaryProgress({
    ids: { operationId: ids.operationId, attemptId: ids.attemptId, effectIntentId: ids.effectIntentId },
    conversationId: run.conversationId,
    runId: run.id,
    kind: 'invocation.resolve',
    now,
    deadlineMs: policyNumber(facts, run.id, 'resolveInvocationDeadlineMs'),
    timeoutPolicy: 'interrupt_run',
    recoveryPolicy: 'resume_pending_if_safe',
    payload: { invocationId: ids.invocationId, requestId: ids.requestId, conversationId: run.conversationId }
  });
  builder
    .generatedId(ids.invocationId, ids.requestId, ids.operationId, ids.attemptId, ids.effectIntentId)
    .upsert('invocations', invocation)
    .upsert('requests', request)
    .upsert('turns', { ...run, phase: 'resolving_invocation', rowVersion: run.rowVersion + 1, updatedAt: now });
  appendPrimaryProgress(builder, progress);
}

export interface PrimaryProgressInput {
  ids: { operationId: OperationId; attemptId: AttemptId; effectIntentId: EffectIntentId };
  conversationId: ConversationId;
  runId: RunId;
  kind: string;
  now: number;
  deadlineMs: number;
  timeoutPolicy: OperationRecord['timeoutPolicy'];
  recoveryPolicy: PrimaryEffectDescriptor['recoveryPolicy'];
  payload: JsonValue;
}

export function createPrimaryProgress(input: PrimaryProgressInput): { operation: OperationRecord; attempt: AttemptRecord; effect: PrimaryEffectDescriptor; payload: DurableEffectPayloadRecord } {
  const deadlineAt = input.now + input.deadlineMs;
  const operation: OperationRecord = {
    id: input.ids.operationId,
    conversationId: input.conversationId,
    ownerRunId: input.runId,
    kind: input.kind,
    state: 'running',
    currentGeneration: 1,
    rowVersion: 1,
    timeoutPolicy: input.timeoutPolicy,
    createdAt: input.now,
    updatedAt: input.now
  };
  const attempt: AttemptRecord = {
    id: input.ids.attemptId,
    operationId: operation.id,
    conversationId: input.conversationId,
    ownerRunId: input.runId,
    generation: 1,
    state: 'pending',
    deadlineAt,
    rowVersion: 1
  };
  const payloadHash = canonicalSha256(input.payload);
  const payloadId = effectPayloadId(operation.id, 1);
  const effect: PrimaryEffectDescriptor = {
    effectIntentId: input.ids.effectIntentId,
    conversationId: input.conversationId,
    ownerRunId: input.runId,
    operationId: operation.id,
    attemptId: attempt.id,
    generation: 1,
    kind: input.kind,
    idempotencyKey: `${operation.id}:1`,
    recoveryPolicy: input.recoveryPolicy,
    deadlineAt,
    payloadRef: { kind: 'record', id: payloadId, hash: payloadHash }
  };
  const payload: DurableEffectPayloadRecord = {
    id: payloadId,
    conversationId: input.conversationId,
    ownerRunId: input.runId,
    operationId: operation.id,
    kind: input.kind,
    payload: clone(input.payload),
    payloadHash,
    createdAt: input.now
  };
  return { operation, attempt, effect, payload };
}

export function appendPrimaryProgress(builder: ConversationTransitionBuilder, progress: ReturnType<typeof createPrimaryProgress>): void {
  builder
    .upsert('operations', progress.operation)
    .upsert('attempts', progress.attempt)
    .upsert('primaryEffects', { id: progress.effect.effectIntentId, ...progress.effect })
    .upsert('effectPayloads', progress.payload)
    .primaryEffect(progress.effect);
}

function appendCheckpointPlanRecords(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  plan: ReliableCheckpointBarrierPlan,
  now: number
): void {
  for (const current of facts.conversationCheckpointRepositoryLinks.filter((link) => link.role === 'active' && link.id !== plan.repositoryLink.id)) {
    builder.upsert('conversationCheckpointRepositoryLinks', { ...current, role: 'history', updatedAt: now });
  }
  if (!facts.shadowRepositories.some((repository) => repository.id === plan.repository.id)) builder.generatedId(plan.repository.id);
  if (!facts.conversationCheckpointRepositoryLinks.some((link) => link.id === plan.repositoryLink.id)) builder.generatedId(plan.repositoryLink.id);
  builder
    .generatedId(plan.checkpoint.id)
    .upsert('shadowRepositories', { ...clone(plan.repository), updatedAt: now })
    .upsert('conversationCheckpointRepositoryLinks', { ...clone(plan.repositoryLink), updatedAt: now })
    .upsert('checkpoints', { ...clone(plan.checkpoint), createdAt: now, updatedAt: now });
  if (plan.anchor) {
    builder.generatedId(plan.anchor.id).upsert('checkpointTimelineAnchors', { ...clone(plan.anchor), order: now, createdAt: now, updatedAt: now });
  }
}

function appendPreflightStep(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  requestRecord: DurableConversationFacts['requests'][number],
  step: ReliableLlmPreflightStep,
  now: number
): void {
  switch (step.kind) {
    case 'compression': {
      if (step.plan.compactRequest.conversationId !== run.conversationId || step.plan.block.conversationId !== run.conversationId) {
        throw new Error('Compression preflight plan escaped its Run conversation.');
      }
      const block = { ...clone(step.plan.block), createdAt: now, updatedAt: now };
      builder.generatedId(block.id, step.plan.variantId, step.plan.compactRequest.id, ...(step.plan.compactRequest.invocationId ? [step.plan.compactRequest.invocationId] : []));
      builder.upsert('compressionBlocks', block);
      for (const link of step.plan.sourceLinks) {
        builder.generatedId(link.id).upsert('compressionBlockSourceLinks', { ...clone(link), createdAt: now, updatedAt: now });
      }
      appendCompressionModelContextProjection(builder, step.plan.contextProjection, now);
      const effectPayload: ReliableBarrierEffectPayload = {
        barrier: 'compression.pre_llm',
        plan: { ...clone(step.plan), block, sourceLinks: step.plan.sourceLinks.map((link) => ({ ...clone(link), createdAt: now, updatedAt: now })) },
        continuation: clone(step.continuation)
      };
      const progress = createPrimaryProgress({
        ids: step.ids,
        conversationId: run.conversationId,
        runId: run.id,
        kind: 'compression.pre_llm',
        now,
        deadlineMs: policyNumber(facts, run.id, 'compressionDeadlineMs'),
        timeoutPolicy: 'release_optional_barrier',
        recoveryPolicy: 'interrupt_on_restart',
        payload: clone(effectPayload) as unknown as JsonValue
      });
      builder
        .generatedId(step.ids.operationId, step.ids.attemptId, step.ids.effectIntentId)
        .upsert('requests', { ...requestRecord, operationId: step.ids.operationId, rowVersion: requestRecord.rowVersion + 1 })
        .upsert('turns', { ...run, phase: 'waiting_compression', rowVersion: run.rowVersion + 1, updatedAt: now });
      appendPrimaryProgress(builder, progress);
      return;
    }
    case 'checkpoint': {
      if (step.plan.checkpoint.conversationId !== run.conversationId || step.plan.createRequest.conversationId !== run.conversationId) {
        throw new Error('Checkpoint preflight plan escaped its Run conversation.');
      }
      appendCheckpointPlanRecords(builder, facts, step.plan, now);
      const effectPayload: ReliableBarrierEffectPayload = {
        barrier: 'checkpoint.before_llm',
        plan: clone(step.plan),
        continuation: clone(step.continuation)
      };
      const progress = createPrimaryProgress({
        ids: step.ids,
        conversationId: run.conversationId,
        runId: run.id,
        kind: 'checkpoint.before_llm',
        now,
        deadlineMs: policyNumber(facts, run.id, 'checkpointDeadlineMs'),
        timeoutPolicy: 'release_optional_barrier',
        recoveryPolicy: 'interrupt_on_restart',
        payload: clone(effectPayload) as unknown as JsonValue
      });
      builder
        .generatedId(step.ids.operationId, step.ids.attemptId, step.ids.effectIntentId)
        .upsert('requests', { ...requestRecord, operationId: step.ids.operationId, rowVersion: requestRecord.rowVersion + 1 })
        .upsert('turns', { ...run, phase: 'waiting_checkpoint_before_llm', rowVersion: run.rowVersion + 1, updatedAt: now });
      appendPrimaryProgress(builder, progress);
      return;
    }
    case 'llm_request':
      appendBarrierContinuation(builder, facts, run, { kind: 'llm_request', ids: step.ids, request: step.request }, now);
  }
}

function appendBarrierContinuation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  run: DurableConversationFacts['turns'][number],
  continuation: ReliableBarrierContinuation,
  now: number
): void {
  const request = unique(facts.requests, continuation.kind === 'context_rebuild' ? continuation.input.requestId : continuation.request.id as RequestId, 'Request');
  if (!request || request.runId !== run.id) throw new Error(`Barrier continuation Request is missing for Run ${run.id}.`);
  if (continuation.kind === 'context_rebuild') {
    const progress = createPrimaryProgress({
      ids: continuation.ids,
      conversationId: run.conversationId,
      runId: run.id,
      kind: 'context.build_llm_request',
      now,
      deadlineMs: policyNumber(facts, run.id, 'contextDeadlineMs'),
      timeoutPolicy: 'retry_if_safe',
      recoveryPolicy: 'resume_pending_if_safe',
      payload: clone(continuation.input) as unknown as JsonValue
    });
    builder
      .generatedId(continuation.ids.operationId, continuation.ids.attemptId, continuation.ids.effectIntentId)
      .upsert('requests', { ...request, operationId: continuation.ids.operationId, rowVersion: request.rowVersion + 1 })
      .upsert('turns', { ...run, phase: 'loading_context', rowVersion: run.rowVersion + 1, updatedAt: now });
    appendPrimaryProgress(builder, progress);
    return;
  }
  if (continuation.request.id !== request.id) throw new Error(`Barrier continuation changed Request identity: ${request.id}.`);
  const progress = createPrimaryProgress({
    ids: continuation.ids,
    conversationId: run.conversationId,
    runId: run.id,
    kind: 'llm.request',
    now,
    deadlineMs: policyNumber(facts, run.id, 'requestDeadlineMs'),
    timeoutPolicy: 'interrupt_run',
    recoveryPolicy: 'interrupt_on_restart',
    payload: clone(continuation.request) as unknown as JsonValue
  });
  builder
    .generatedId(continuation.ids.operationId, continuation.ids.attemptId, continuation.ids.effectIntentId)
    .upsert('requests', { ...request, operationId: continuation.ids.operationId, rowVersion: request.rowVersion + 1 })
    .upsert('turns', { ...run, phase: 'llm_request_pending', rowVersion: run.rowVersion + 1, updatedAt: now });
  appendPrimaryProgress(builder, progress);
}

function phaseForPreflightStep(step: ReliableLlmPreflightStep): 'waiting_compression' | 'waiting_checkpoint_before_llm' | 'llm_request_pending' {
  if (step.kind === 'compression') return 'waiting_compression';
  if (step.kind === 'checkpoint') return 'waiting_checkpoint_before_llm';
  return 'llm_request_pending';
}

function compressionPreview(contents: readonly MessageContent[]): string {
  return contents
    .flatMap((content) => content.parts)
    .filter(isTextContentPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 320);
}

function isTextContentPart(part: MessageContent['parts'][number]): part is Extract<MessageContent['parts'][number], { text: string }> {
  return 'text' in part && typeof part.text === 'string';
}

function requireDispatched(
  facts: DurableConversationFacts,
  payload: AttemptTokenPayload,
  expectedKind: string | undefined
): { status: 'matched'; runId: RunId; kind: string } | { status: 'stale'; noop: InternalCommandNoop<JsonValue> } {
  const matched = matchCurrentAttempt(facts, payload);
  if (matched.status === 'stale') return { status: 'stale', noop: stale(matched.reason) };
  if (matched.attempt.state !== 'dispatched') return { status: 'stale', noop: stale('attempt_not_dispatched') };
  if (expectedKind && matched.operation.kind !== expectedKind) return { status: 'stale', noop: stale('operation_kind_mismatch') };
  return { status: 'matched', runId: requireRunOperationOwner(matched.operation), kind: matched.operation.kind };
}

export function builderFor(view: DurableAggregateView<DurableConversationFacts>, context: CommandPlanningContext, conversationId: ConversationId): ConversationTransitionBuilder {
  if (!view.scopes.includes(conversationId)) throw new Error(`Transition scope does not contain conversation ${conversationId}.`);
  return new ConversationTransitionBuilder({
    transitionId: context.transitionId,
    scopes: view.scopes,
    baseVersions: view.baseVersions,
    streamHeads: new Map([...view.storageHeads.values()]
      .filter((head): head is typeof head & { conversationId: ConversationId } => head.headKind === 'conversation-control' && !!head.conversationId)
      .map((head) => [head.conversationId, {
        streamId: `conversation:${head.conversationId}:state`,
        nextSeq: head.streamNextSeq
      }]))
  });
}

export function committedReadView(kind: string, conversationId: ConversationId): DurableViewSpec<DurableConversationFacts> {
  return fullView(kind, conversationId);
}

function toolResultMutationView(kind: string, conversationId: ConversationId): DurableViewSpec<DurableConversationFacts> {
  const view = fullView(kind, conversationId);
  return {
    ...view,
    storageResourceKeys: [...view.storageResourceKeys, TOOL_RESULT_BLOBS_RESOURCE_KEY]
  };
}

export function fullView(kind: string, conversationId: ConversationId): DurableViewSpec<DurableConversationFacts> {
  return {
    kind,
    conversations: [conversationId],
    timeline: [{ conversationId, throughTail: true }],
    closedRunGraphRoots: [],
    relationFamilies: [...DURABLE_CONVERSATION_RECORD_FAMILIES],
    storageResourceKeys: [
      ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
      CONVERSATION_ATTACHMENTS_RESOURCE_KEY
    ]
  };
}

function appendMutations(builder: ConversationTransitionBuilder, mutations: readonly RecordMutation[]): void {
  for (const mutation of mutations) {
    if (mutation.kind === 'upsert') builder.upsert(mutation.family as never, mutation.record as unknown as { id: string });
    else if (mutation.kind === 'remove') builder.remove(mutation.family as never, mutation.id);
    else builder.removeMany(mutation.family as never, mutation.ids);
  }
}

function removeSlot(builder: ConversationTransitionBuilder, facts: DurableConversationFacts, runId: RunId, now: number): void {
  const lease = facts.executionLeases.find((candidate) => candidate.turnId === runId && candidate.state !== 'released');
  if (lease) builder.upsert('executionLeases', releaseExecutionLease(lease, { turnId: runId, now }));
}

function token(command: InternalCommandEnvelope<JsonValue>): AttemptTokenPayload {
  return payloadOf<AttemptTokenPayload>(command);
}

function payloadOf<T>(command: InternalCommandEnvelope<JsonValue>): T {
  return command.payload as unknown as T;
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

function requireRun(facts: DurableConversationFacts, runId: RunId) {
  const run = unique(facts.turns, runId, 'Run');
  if (!run) throw new Error(`Operation owner Run is missing: ${runId}`);
  return run;
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function uniqueBy<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label} ownership is ambiguous.`);
  return matches[0];
}

export function policyNumber(facts: DurableConversationFacts, runId: RunId, key: TurnExecutionPolicyDeadlineKey): number {
  return requireTurnExecutionPolicyNumber(facts, runId, key);
}

function nextMessageSeq(facts: DurableConversationFacts): number {
  return facts.messages.reduce((max, message) => Math.max(max, message.seq), 0) + 1;
}

function soleWaitingKind(tools: readonly PlannedToolCall[]): 'waiting_user' | 'waiting_plan_review' | undefined {
  if (tools.length !== 1) return undefined;
  return tools[0].execution === 'waiting_user' || tools[0].execution === 'waiting_plan_review' ? tools[0].execution : undefined;
}

function stringField(value: JsonValue, key: string): string | undefined {
  return value && !Array.isArray(value) && typeof value === 'object' && typeof value[key] === 'string' ? value[key] : undefined;
}

function relationId(kind: string, ...parts: string[]): string { return `${kind}:${parts.join(':')}`; }
function effectPayloadId(operationId: OperationId, generation: number): string { return `effect-payload:${operationId}:${generation}`; }
function streamFenceId(requestId: RequestId, attemptId: AttemptId, generation: number): string { return `stream-fence:${requestId}:${attemptId}:${generation}`; }
function streamHeadId(requestId: RequestId, attemptId: AttemptId, generation: number): string { return `stream-head:${requestId}:${attemptId}:${generation}`; }

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

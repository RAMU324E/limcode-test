import type {
  CommandPlanningContext,
  DurableAggregateView,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { ToolCallEventRecord, ToolCallRecord } from '../../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  ToolCallEventId,
  ToolCallId
} from '../../../shared/stableIds';
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
import { appendBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';
import { interactionRequestForTool } from './interactionState';
import type { DurableConversationFacts } from './types';

export interface CompleteHumanToolPayload {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  waitKind: 'user' | 'plan_review';
  outcome: 'succeeded' | 'failed';
  result: JsonValue;
  error?: string;
  completedAt: number;
  toolCallEventId: ToolCallEventId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

/** Commits an explicit user/Plan answer and the next model-cycle admission atomically. */
export interface DelegatePlanToolPayload {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  planProposalId: string;
  agentType: string;
  userMessage: string;
  delegatedPrompt: string;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

/** Converts an approved delegated Plan wait into a durable child-launch Operation. */
export class DelegatePlanToolHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('tool.plan_delegate', delegatePayload(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = delegatePayload(command);
    const tool = unique(view.facts.toolCalls, payload.toolCallId, 'ToolCall');
    const link = uniqueBy(view.facts.toolRunLinks, (candidate) => candidate.toolCallId === payload.toolCallId, 'ToolCall Run link');
    if (!tool || !link) return stale('tool_not_found');
    const run = unique(view.facts.turns, link.runId, 'Run');
    const interaction = interactionRequestForTool(view.facts, tool.id as ToolCallId, 'plan_review');
    if (!run || !interaction || interaction.owner.turnId !== link.runId) {
      const existing = view.facts.toolExecutions.find((candidate) => candidate.id === payload.toolCallId);
      return existing
        ? { status: 'already_satisfied', result: asJson({ status: 'delegation_already_started', operationId: existing.operationId }) }
        : stale('plan_wait_not_current');
    }
    if (run.lifecycle !== 'active' || (run.phase !== 'waiting_plan_review' && run.phase !== 'waiting_tools') || tool.status !== 'awaiting_user_input') {
      return stale('plan_wait_owner_state_changed');
    }
    if (payload.planProposalId !== `plan-proposal:${tool.id}` || !payload.agentType.trim() || !payload.delegatedPrompt.trim()) {
      return stale('invalid_delegation_identity');
    }

    const progress = createPrimaryProgress({
      ids: {
        operationId: payload.operationId,
        attemptId: payload.attemptId,
        effectIntentId: payload.effectIntentId
      },
      conversationId: payload.conversationId,
      runId: run.id,
      kind: 'tool.agent.submit_plan',
      now: context.now,
      deadlineMs: policyNumber(view.facts, run.id, 'toolDeadlineMs'),
      timeoutPolicy: 'retry_if_safe',
      recoveryPolicy: 'resume_pending_if_safe',
      payload: asJson({
        toolCallId: tool.id,
        name: tool.name,
        argsJson: JSON.stringify({
          prompt: payload.delegatedPrompt,
          foregroundWaitMs: 0,
          agent: { type: payload.agentType }
        }),
        runId: run.id,
        conversationId: payload.conversationId,
        planDelegation: {
          proposalId: payload.planProposalId,
          userMessage: payload.userMessage,
          agentType: payload.agentType
        }
      })
    });
    const builder = builderFor(view, context, payload.conversationId);
    builder
      .generatedId(payload.operationId, payload.attemptId, payload.effectIntentId)
      .upsert('toolCalls', {
        ...tool,
        status: 'queued',
        progress: {
          planProposalId: payload.planProposalId,
          waitingFor: 'agent_delegation',
          executionTarget: 'new_conversation',
          agentType: payload.agentType
        },
        updatedAt: context.now
      })
      .upsert('toolExecutions', {
        id: tool.id,
        conversationId: payload.conversationId,
        runId: run.id,
        operationId: payload.operationId,
        state: 'pending',
        rowVersion: 1
      })
      .upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    appendPrimaryProgress(builder, progress);
    builder.patch(payload.conversationId, {
      kind: 'plan.delegation_started',
      runId: run.id,
      toolCallId: tool.id,
      operationId: payload.operationId
    });
    return builder.build(asJson({ status: 'delegation_started', operationId: payload.operationId }));
  }
}

export class CompleteHumanToolHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('tool.human_response', payloadOf(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf(command);
    const tool = unique(view.facts.toolCalls, payload.toolCallId, 'ToolCall');
    const link = uniqueBy(view.facts.toolRunLinks, (candidate) => candidate.toolCallId === payload.toolCallId, 'ToolCall Run link');
    if (!tool || !link) return stale('tool_not_found');
    const run = unique(view.facts.turns, link.runId, 'Run');
    if (!run || run.lifecycle !== 'active' || run.phase === 'terminal') return stale('run_not_active');
    const interactionKind = payload.waitKind === 'user' ? 'ask_user' as const : 'plan_review' as const;
    const interaction = interactionRequestForTool(view.facts, payload.toolCallId, interactionKind);
    if (!interaction || interaction.owner.turnId !== run.id) {
      if (tool.status === 'success' || tool.status === 'error' || tool.status === 'warning') {
        return { status: 'already_satisfied', result: asJson({ status: 'already_completed', toolCallId: tool.id }) };
      }
      return stale('wait_not_current');
    }
    const expectedPhase = payload.waitKind === 'user' ? 'waiting_user' : 'waiting_plan_review';
    if ((run.phase !== expectedPhase && run.phase !== 'waiting_tools') || tool.status !== 'awaiting_user_input') return stale('wait_owner_state_changed');

    const builder = builderFor(view, context, payload.conversationId);
    const completedStatus = payload.outcome === 'succeeded' ? 'success' as const : 'error' as const;
    const result = appendBoundedInlineToolResult(builder, {
      conversationId: payload.conversationId,
      tool,
      status: completedStatus,
      result: payload.result,
      now: payload.completedAt,
      ...(payload.error ? { error: payload.error } : {})
    });
    const completedTool: ToolCallRecord = {
      ...withoutEmbeddedToolResult(tool),
      status: completedStatus,
      ...(payload.error ? { error: payload.error } : {}),
      durationMs: Math.max(0, payload.completedAt - tool.createdAt),
      updatedAt: payload.completedAt
    };
    const event: ToolCallEventRecord = {
      id: payload.toolCallEventId,
      toolCallId: tool.id,
      seq: nextToolEventSeq(view.facts, tool.id),
      kind: payload.outcome === 'succeeded' ? 'completed' : 'failed',
      at: payload.completedAt,
      status: completedTool.status,
      elapsedMs: completedTool.durationMs,
      durationMs: completedTool.durationMs,
      ...(payload.error ? { error: payload.error } : {})
    };
    builder
      .generatedId(payload.toolCallEventId)
      .upsert('toolCalls', completedTool)
      .upsert('toolCallEvents', event);
    const continued = !hasRemainingToolWork(view.facts, {
      runId: run.id,
      toolCallIds: [payload.toolCallId]
    });
    if (continued) {
      appendToolResponsesAndNextInvocation(builder, view.facts, run, {
        conversationId: payload.conversationId,
        toolCallId: payload.toolCallId,
        outcome: payload.outcome,
        modelResponse: result.modelResponse,
        ...(payload.error ? { error: payload.error } : {}),
        completedAt: payload.completedAt,
        responseMessageId: payload.responseMessageId,
        responseRevisionId: payload.responseRevisionId,
        nextInvocationId: payload.nextInvocationId,
        nextRequestId: payload.nextRequestId,
        nextOperationId: payload.nextOperationId,
        nextAttemptId: payload.nextAttemptId,
        nextEffectIntentId: payload.nextEffectIntentId
      }, context.now);
    } else if (run.phase !== 'waiting_tools') {
      builder.upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    }
    builder.patch(payload.conversationId, {
      kind: 'tool.human_response',
      runId: run.id,
      toolCallId: tool.id,
      outcome: payload.outcome
    });
    return builder.build(asJson({ status: 'completed', runId: run.id, toolCallId: tool.id, continued }));
  }
}

function payloadOf(command: InternalCommandEnvelope<JsonValue>): CompleteHumanToolPayload {
  return command.payload as unknown as CompleteHumanToolPayload;
}

function delegatePayload(command: InternalCommandEnvelope<JsonValue>): DelegatePlanToolPayload {
  return command.payload as unknown as DelegatePlanToolPayload;
}

function nextToolEventSeq(facts: DurableConversationFacts, toolCallId: string): number {
  return facts.toolCallEvents
    .filter((event) => event.toolCallId === toolCallId)
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  return uniqueBy(records, (record) => record.id === id, label);
}

function uniqueBy<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label} ownership is ambiguous.`);
  return matches[0];
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

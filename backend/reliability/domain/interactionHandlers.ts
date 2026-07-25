import type {
  CommandPlanningContext,
  DurableAggregateView,
  DurableInteractionActor,
  DurableInteractionDecision,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalCommandNoop,
  JsonValue,
  TransitionPlan
} from '../../../shared/conversationReliability';
import { normalizeAskUserToolRequest, resolveAskUserAnswer } from '../../../shared/askUser';
import {
  createDelegatedPlanPrompt,
  createSubmitPlanToolOutput,
  normalizeSubmitPlanToolRequest
} from '../../../shared/planReview';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InteractionRequestId,
  InteractionResponseId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  RunId,
  ToolCallEventId,
  ToolCallId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import {
  CompleteHumanToolHandler,
  DelegatePlanToolHandler,
  type CompleteHumanToolPayload,
  type DelegatePlanToolPayload
} from './humanInteractionHandlers';
import { uniqueInteractionOwner } from './interactionState';
import {
  ApplyToolChangeHandler,
  ApproveToolExecutionHandler,
  SettleWaitingToolHandler,
  type ApplyToolChangePayload,
  type ApproveToolExecutionPayload,
  type SettleWaitingToolPayload
} from './toolControlHandlers';
import { asJson } from './transitionBuilder';
import { fullView } from './internalHandlers';
import type { DurableConversationFacts } from './types';

interface InteractionContinuationIds {
  toolCallEventId: ToolCallEventId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

interface InteractionExecutionIds {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface ResolveInteractionCommandPayload extends InteractionContinuationIds, InteractionExecutionIds {
  conversationId: ConversationId;
  interactionRequestId: InteractionRequestId;
  interactionRevision: number;
  ownerTurnId: RunId;
  responseId: InteractionResponseId;
  decision: DurableInteractionDecision;
  actor: DurableInteractionActor;
  actorId?: string;
  commandId: string;
  response: JsonValue;
  completedAt: number;
  /** Server-hydrated immutable patch proposal attestation; never accepted directly from Webview. */
  patch?: {
    proposalArtifactId: string;
    proposalContentHash: string;
    proposal: JsonValue;
  };
}

/**
 * One identity-fenced command owns every human/policy interaction response. Kind-specific planners
 * only apply the resulting Tool/Operation outcome; this wrapper atomically records the immutable
 * response and closes the request in the same TransitionPlan.
 */
export class ResolveInteractionCommandHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  private readonly completeHumanTool = new CompleteHumanToolHandler();
  private readonly delegatePlanTool = new DelegatePlanToolHandler();
  private readonly approveToolExecution = new ApproveToolExecutionHandler();
  private readonly applyToolChange = new ApplyToolChangeHandler();
  private readonly settleWaitingTool = new SettleWaitingToolHandler();

  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('interaction.resolve', payloadOf(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf(command);
    const request = unique(view.facts.interactionRequests, payload.interactionRequestId, 'InteractionRequest');
    if (!request) return stale('interaction_not_found');
    const owner = uniqueInteractionOwner(view.facts, request.id);
    if (!owner) throw new Error(`InteractionRequest ${request.id} has no owner link.`);
    if (owner.conversationId !== payload.conversationId || owner.turnId !== payload.ownerTurnId) {
      return stale('interaction_target_replaced');
    }

    const existingResponses = view.facts.interactionResponses.filter((candidate) =>
      candidate.interactionRequestId === request.id && candidate.interactionRevision === request.revision);
    if (existingResponses.length > 1) throw new Error(`InteractionRequest ${request.id} has multiple responses.`);
    if (request.state !== 'pending') {
      const existing = existingResponses[0];
      if (!existing) throw new Error(`Terminal InteractionRequest ${request.id} has no response fact.`);
      return {
        status: 'already_satisfied',
        result: asJson({
          status: 'already_resolved',
          interactionRequestId: request.id,
          interactionRevision: request.revision,
          decision: existing.decision,
          responseId: existing.id
        })
      };
    }
    if (existingResponses.length !== 0) throw new Error(`Pending InteractionRequest ${request.id} already has a response fact.`);
    if (request.revision !== payload.interactionRevision) return stale('interaction_superseded');
    if (!request.choices.includes(payload.decision)) return stale('interaction_decision_not_allowed');

    const run = unique(view.facts.turns, owner.turnId, 'Interaction owner Turn');
    if (!run || run.lifecycle !== 'active' || run.phase === 'terminal') return stale('interaction_owner_terminal');
    if (canonicalSha256(request.payload) !== request.payloadDigest) {
      throw new Error(`InteractionRequest ${request.id} has an invalid immutable payload digest.`);
    }

    const toolCallId = owner.sourceToolCallId;
    if (!toolCallId && request.kind !== 'permission_request') {
      throw new Error(`InteractionRequest ${request.id} has no source ToolCall link.`);
    }
    const tool = toolCallId ? unique(view.facts.toolCalls, toolCallId, 'Interaction ToolCall') : undefined;
    if (toolCallId && !tool) throw new Error(`InteractionRequest ${request.id} references a missing ToolCall.`);
    const subjectArtifact = request.subjectRef
      ? unique(view.facts.toolResultArtifacts, request.subjectRef, 'Interaction subject Artifact')
      : undefined;
    if (request.subjectRef && (!subjectArtifact || !request.subjectDigest
      || subjectArtifact.contentHash !== request.subjectDigest)) {
      throw new Error(`InteractionRequest ${request.id} has an invalid immutable subject closure.`);
    }
    if (request.kind === 'patch_approval' && payload.decision === 'accept'
      && (!payload.patch || payload.patch.proposalArtifactId !== request.subjectRef
        || payload.patch.proposalContentHash !== request.subjectDigest)) {
      return stale('patch_attestation_mismatch');
    }

    const outcome = this.planOutcome(view, command, context, payload, request.kind, toolCallId, tool?.args);
    if ('status' in outcome) return outcome;
    return appendInteractionResolution(outcome, request, owner.turnId, payload, context.now);
  }

  private planOutcome(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext,
    payload: ResolveInteractionCommandPayload,
    kind: DurableConversationFacts['interactionRequests'][number]['kind'],
    toolCallId: ToolCallId | undefined,
    toolArgs: string | undefined
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    if (kind === 'ask_user') {
      if (!toolCallId || toolArgs === undefined) throw new Error('AskUser Interaction has no ToolCall subject.');
      const response = object(payload.response);
      const cancelled = payload.decision === 'cancel';
      const reason = text(response?.reason) ?? '用户取消了问题回答。';
      const result = cancelled
        ? asJson({ ok: false, cancelled: true, reason })
        : asJson(resolveAskUserAnswer(normalizeAskUserToolRequest(toolArgs), response?.answer));
      return this.completeHumanTool.plan(view, nested(command, 'tool.human_response', {
        conversationId: payload.conversationId,
        toolCallId,
        waitKind: 'user',
        outcome: cancelled ? 'failed' : 'succeeded',
        result,
        ...(cancelled ? { error: reason } : {}),
        completedAt: payload.completedAt,
        ...continuationIds(payload)
      } satisfies CompleteHumanToolPayload), context);
    }

    if (kind === 'plan_review') {
      if (!toolCallId || toolArgs === undefined) throw new Error('Plan Interaction has no ToolCall subject.');
      const response = object(payload.response);
      const proposalId = `plan-proposal:${toolCallId}`;
      const suppliedProposalId = text(response?.planProposalId);
      if (suppliedProposalId && suppliedProposalId !== proposalId) return stale('plan_proposal_mismatch');
      const status = payload.decision === 'accept'
        ? 'approved' as const
        : payload.decision === 'submit'
          ? 'change_requested' as const
          : 'rejected' as const;
      const userMessage = text(response?.message) ?? (status === 'approved'
        ? 'User approved the plan. Continue with the approved plan.'
        : status === 'change_requested'
          ? 'User requested changes to the plan. Revise the plan and submit it again.'
          : 'User rejected the plan.');
      const executionTarget = response?.executionTarget === 'new_conversation'
        ? 'new_conversation' as const
        : 'current_conversation' as const;
      if (status === 'approved' && executionTarget === 'new_conversation') {
        const agentType = text(response?.agentType);
        if (!agentType) return stale('plan_delegation_agent_missing');
        const request = normalizeSubmitPlanToolRequest(toolArgs);
        return this.delegatePlanTool.plan(view, nested(command, 'tool.plan_delegate', {
          conversationId: payload.conversationId,
          toolCallId,
          planProposalId: proposalId,
          agentType,
          userMessage,
          delegatedPrompt: createDelegatedPlanPrompt(request),
          operationId: payload.operationId,
          attemptId: payload.attemptId,
          effectIntentId: payload.effectIntentId
        } satisfies DelegatePlanToolPayload), context);
      }
      normalizeSubmitPlanToolRequest(toolArgs);
      const result = createSubmitPlanToolOutput({
        proposalId,
        status,
        userMessage,
        ...(status === 'approved' ? { executionTarget } : {})
      });
      return this.completeHumanTool.plan(view, nested(command, 'tool.human_response', {
        conversationId: payload.conversationId,
        toolCallId,
        waitKind: 'plan_review',
        outcome: status === 'rejected' ? 'failed' : 'succeeded',
        result: asJson(result),
        ...(status === 'rejected' ? { error: userMessage } : {}),
        completedAt: payload.completedAt,
        ...continuationIds(payload)
      } satisfies CompleteHumanToolPayload), context);
    }

    if (kind === 'exec_approval') {
      if (!toolCallId) throw new Error('Execution approval has no ToolCall subject.');
      if (payload.decision === 'accept') {
        return this.approveToolExecution.plan(view, nested(command, 'tool.execution_approve', {
          conversationId: payload.conversationId,
          toolCallId,
          operationId: payload.operationId,
          attemptId: payload.attemptId,
          effectIntentId: payload.effectIntentId
        } satisfies ApproveToolExecutionPayload), context);
      }
      return this.settleWaitingTool.plan(view, nested(command, 'tool.wait_settle', {
        conversationId: payload.conversationId,
        toolCallId,
        waitKind: 'tool_approval',
        decision: 'reject',
        ...(text(object(payload.response)?.reason) ? { reason: text(object(payload.response)?.reason) } : {}),
        completedAt: payload.completedAt,
        ...continuationIds(payload)
      } satisfies SettleWaitingToolPayload), context);
    }

    if (kind === 'patch_approval') {
      if (!toolCallId) throw new Error('Patch approval has no ToolCall subject.');
      if (payload.decision === 'accept' && !payload.patch) return stale('patch_attestation_missing');
      return this.applyToolChange.plan(view, nested(command, 'interaction.patch.apply', {
        conversationId: payload.conversationId,
        toolCallId,
        interactionRequestId: payload.interactionRequestId,
        interactionRevision: payload.interactionRevision,
        decision: payload.decision === 'accept' ? 'accept' : 'reject',
        actor: payload.actor === 'policy' ? 'policy' : 'user',
        ...(payload.actorId ? { actorId: payload.actorId } : {}),
        commandId: payload.commandId,
        ...(text(object(payload.response)?.reason) ? { reason: text(object(payload.response)?.reason) } : {}),
        completedAt: payload.completedAt,
        operationId: payload.operationId,
        attemptId: payload.attemptId,
        effectIntentId: payload.effectIntentId,
        ...continuationIds(payload),
        ...(payload.patch ? {
          proposalArtifactId: payload.patch.proposalArtifactId,
          proposalContentHash: payload.patch.proposalContentHash,
          proposal: payload.patch.proposal
        } : {})
      } satisfies ApplyToolChangePayload), context);
    }

    if (kind === 'result_review') {
      if (!toolCallId) throw new Error('Result review has no ToolCall subject.');
      return this.settleWaitingTool.plan(view, nested(command, 'tool.wait_settle', {
        conversationId: payload.conversationId,
        toolCallId,
        waitKind: 'tool_result_review',
        decision: payload.decision === 'accept' ? 'accept_result' : 'reject',
        ...(text(object(payload.response)?.reason) ? { reason: text(object(payload.response)?.reason) } : {}),
        completedAt: payload.completedAt,
        ...continuationIds(payload)
      } satisfies SettleWaitingToolPayload), context);
    }

    return stale('permission_interaction_not_supported');
  }
}

function appendInteractionResolution(
  outcome: TransitionPlan<JsonValue>,
  request: DurableConversationFacts['interactionRequests'][number],
  ownerTurnId: RunId,
  payload: ResolveInteractionCommandPayload,
  now: number
): TransitionPlan<JsonValue> {
  const response = {
    id: payload.responseId,
    interactionRequestId: request.id,
    interactionRevision: request.revision,
    ownerTurnId,
    decision: payload.decision,
    actor: payload.actor,
    ...(payload.actorId ? { actorId: payload.actorId } : {}),
    payload: clone(payload.response),
    payloadHash: canonicalSha256(payload.response),
    commandId: payload.commandId,
    createdAt: now
  };
  return {
    ...outcome,
    recordMutations: [
      ...outcome.recordMutations,
      {
        kind: 'upsert',
        family: 'interactionRequests',
        id: request.id,
        record: asJson({
          ...request,
          state: payload.decision === 'cancel' ? 'cancelled' : 'resolved',
          updatedAt: now
        })
      },
      {
        kind: 'upsert',
        family: 'interactionResponses',
        id: response.id,
        record: asJson(response)
      }
    ],
    generatedIds: [...outcome.generatedIds, response.id],
    patches: outcome.patches.map((patch) => patch.conversationId === payload.conversationId
      ? {
          ...patch,
          operations: [
            ...patch.operations,
            asJson({
              kind: 'interaction.resolved',
              interactionRequestId: request.id,
              interactionRevision: request.revision,
              responseId: response.id,
              decision: payload.decision
            })
          ]
        }
      : patch),
    result: asJson({
      status: 'resolved',
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      responseId: response.id,
      decision: payload.decision,
      outcome: outcome.result
    })
  };
}

export function interactionResolutionIds(interactionRequestId: InteractionRequestId, interactionRevision: number) {
  if (!Number.isInteger(interactionRevision) || interactionRevision < 1) {
    throw new Error(`Invalid InteractionRequest revision: ${interactionRevision}`);
  }
  const seed = `interaction:${interactionRequestId}:${interactionRevision}`;
  const continuation: InteractionContinuationIds = {
    toolCallEventId: stableIdFromSeed('toolCallEvent', `${seed}:tool-event`),
    responseMessageId: stableIdFromSeed('message', `${seed}:response-message`),
    responseRevisionId: stableIdFromSeed('messageRevision', `${seed}:response-revision`),
    nextInvocationId: stableIdFromSeed('invocation', `${seed}:next-invocation`),
    nextRequestId: stableIdFromSeed('request', `${seed}:next-request`),
    nextOperationId: stableIdFromSeed('operation', `${seed}:next-operation`),
    nextAttemptId: stableIdFromSeed('attempt', `${seed}:next-attempt`),
    nextEffectIntentId: stableIdFromSeed('effectIntent', `${seed}:next-effect`)
  };
  return {
    responseId: stableIdFromSeed('interactionResponse', `${seed}:response`),
    execution: {
      operationId: stableIdFromSeed('operation', `${seed}:operation`),
      attemptId: stableIdFromSeed('attempt', `${seed}:attempt`),
      effectIntentId: stableIdFromSeed('effectIntent', `${seed}:effect`)
    },
    continuation
  };
}

function continuationIds(payload: ResolveInteractionCommandPayload): InteractionContinuationIds {
  return {
    toolCallEventId: payload.toolCallEventId,
    responseMessageId: payload.responseMessageId,
    responseRevisionId: payload.responseRevisionId,
    nextInvocationId: payload.nextInvocationId,
    nextRequestId: payload.nextRequestId,
    nextOperationId: payload.nextOperationId,
    nextAttemptId: payload.nextAttemptId,
    nextEffectIntentId: payload.nextEffectIntentId
  };
}

function nested(
  command: InternalCommandEnvelope<JsonValue>,
  type: string,
  payload: unknown
): InternalCommandEnvelope<JsonValue> {
  return { ...command, type, payload: payload as JsonValue };
}

function payloadOf(command: InternalCommandEnvelope<JsonValue>): ResolveInteractionCommandPayload {
  return command.payload as unknown as ResolveInteractionCommandPayload;
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  return uniqueBy(records, (record) => record.id === id, label);
}

function uniqueBy<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label} ownership is ambiguous.`);
  return matches[0];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

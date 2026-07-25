import {
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
  ANSWER_BRIDGE_LINKS_RESOURCE_KEY
} from '../../../shared/conversationReliability';
import type {
  AnswerBridgeRecord,
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
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { MessageContent, MessageRecord, MessageRevisionRecord, RunContextPolicyRecord, ToolCallRecord } from '../../../shared/protocol';
import type {
  AnswerBridgeId,
  AnswerSubmissionId,
  AttemptId,
  AuthoritySnapshotId,
  ConversationId,
  EffectIntentId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  RunId,
  ToolCallId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { deriveChildAuthority, type ChildTurnAuthorityProfile } from '../authorityCompiler';
import { completeAttempt, matchCurrentAttempt } from './operationStateMachine';
import { requireRunOperationOwner } from './operationOwner';
import {
  appendInitialProgress,
  inputRevision,
  nextMessageSeq,
  relationId,
  type InitialProgressIds
} from './handlers';
import {
  appendPrimaryProgress,
  appendToolResponsesAndNextInvocation,
  createPrimaryProgress,
  policyNumber,
  type ToolContinuationPayload
} from './internalHandlers';
import { appendRunContextPolicy } from './runContextPolicy';
import { acquireExecutionLease, replaceExecutionLease } from './executionLease';
import { assertRuntimeInboxIdentity, createRuntimeInboxRecords } from './runtimeInbox';
import { hasRemainingToolWork } from './toolSchedule';
import { appendTerminateRunGraphMutations, planTerminateRunGraph } from './terminateRunGraph';
import { resolveAnswerBridgeChildOwnership } from './childRunOwnership';
import { runGraphCascadeForPolicy } from './cancellationIntent';
import {
  appendCancelOwnedChildWork,
  appendSettleOwnedSourceToolCancellation,
  type OwnedSourceToolContinuationIds
} from './cancellationPlanner';
import { asJson, ConversationTransitionBuilder } from './transitionBuilder';
import { appendBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';
import { DURABLE_CONVERSATION_RECORD_FAMILIES } from './familyRegistry';
import type { DurableConversationFacts, MultiConversationDurableFacts } from './types';

interface AttemptTokenPayload {
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
}

interface ContinueIds {
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

export interface OpenAnswerBridgePayload extends AttemptTokenPayload, ContinueIds {
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  targetConversationTitle?: string;
  targetAgentId: string;
  parentRunId: RunId;
  parentToolCallId: ToolCallId;
  bridgeId: AnswerBridgeId;
  childRunId: RunId;
  childMessageId: MessageId;
  childRevisionId: MessageRevisionId;
  childProgressIds: InitialProgressIds;
  childContent: MessageContent;
  childAuthorityProfile: ChildTurnAuthorityProfile;
  childAuthoritySnapshotId: AuthoritySnapshotId;
  authorityDerivationLinkId: string;
  childContextPolicy: Omit<RunContextPolicyRecord, 'id'>;
  mode: 'foreground' | 'background';
  foregroundDeadlineAt?: number;
  backgroundResult: JsonValue;
}

/**
 * Commits the canonical AnswerBridge and child Run after the agent-launch boundary. The parent
 * launch Attempt is completed in the same multi-conversation transition, so no committed state can
 * expose a child without fixed bridge ownership.
 */
export class OpenAnswerBridgeHandler implements InternalCommandHandler<JsonValue, MultiConversationDurableFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<MultiConversationDurableFacts> {
    const payload = payloadOf<OpenAnswerBridgePayload>(command);
    return multiView('answer_bridge.open', payload.sourceConversationId, payload.targetConversationId, [payload.targetConversationId]);
  }

  public plan(
    view: DurableAggregateView<MultiConversationDurableFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<OpenAnswerBridgePayload>(command);
    if (payload.conversationId !== payload.sourceConversationId || payload.sourceConversationId === payload.targetConversationId) {
      return stale('bridge_scope_mismatch');
    }
    const source = conversationFacts(view, payload.sourceConversationId);
    const target = conversationFacts(view, payload.targetConversationId);
    const matched = matchCurrentAttempt(source, payload);
    if (matched.status === 'stale') return stale(matched.reason);
    if (matched.attempt.state !== 'dispatched' || !matched.operation.kind.startsWith('tool.agent.')) return stale('launch_attempt_not_dispatched');
    if (matched.operation.ownerRunId !== payload.parentRunId) return stale('parent_run_mismatch');

    const parentRun = unique(source.turns, payload.parentRunId, 'parent Run');
    const parentTool = unique(source.toolCalls, payload.parentToolCallId, 'parent ToolCall');
    const parentExecution = unique(source.toolExecutions, payload.parentToolCallId, 'parent ToolExecution');
    if (!parentRun || parentRun.lifecycle !== 'active' || parentRun.phase !== 'waiting_tools') return stale('parent_not_waiting_tools');
    if (!parentTool || !parentExecution || parentExecution.operationId !== payload.operationId || terminalTool(parentTool)) return stale('parent_tool_mismatch');
    const existingBridge = unique(source.answerBridges, payload.bridgeId, 'AnswerBridge');
    if (existingBridge && (existingBridge.sourceConversationId !== payload.sourceConversationId
      || existingBridge.targetConversationId !== payload.targetConversationId)) return stale('bridge_scope_mismatch');
    if (target.turns.some((run) => run.id === payload.childRunId)) return stale('child_run_already_exists');
    if (!payload.targetAgentId.trim() || payload.childContent.role !== 'user' || payload.childContent.parts.length === 0) return stale('child_input_invalid');
    const parentAuthorities = source.authoritySnapshots.filter((candidate) => candidate.turnId === parentRun.id);
    if (parentAuthorities.length > 1) throw new Error(`Parent Turn ${parentRun.id} has ambiguous AuthoritySnapshots.`);
    const parentAuthority = parentAuthorities[0];
    if (!parentAuthority || parentAuthority.authorityHash !== canonicalSha256(parentAuthority.authority)) {
      throw new Error(`Parent Turn ${parentRun.id} has no complete hash-bound AuthoritySnapshot.`);
    }
    const derivedAuthority = deriveChildAuthority(
      parentAuthority.authority,
      payload.childAuthorityProfile,
      payload.targetAgentId
    );
    const childAuthority = {
      id: payload.childAuthoritySnapshotId,
      conversationId: payload.targetConversationId,
      turnId: payload.childRunId,
      authority: derivedAuthority.authority,
      authorityHash: canonicalSha256(derivedAuthority.authority),
      derivation: 'child' as const,
      createdAt: context.now
    };
    const authorityDerivationLink = {
      id: payload.authorityDerivationLinkId,
      parentSnapshotId: parentAuthority.id,
      childSnapshotId: childAuthority.id,
      parentTurnId: parentRun.id,
      parentConversationId: payload.sourceConversationId,
      childTurnId: payload.childRunId,
      childConversationId: payload.targetConversationId,
      overrideDigest: derivedAuthority.overrideDigest,
      relation: derivedAuthority.relation,
      createdAt: context.now
    };
    const childExecutionPolicy = clone(derivedAuthority.authority.executionPolicy);

    const builder = multiBuilder(view, context);
    if (existingBridge) {
      for (const child of source.childTurnLinks.filter((candidate) => candidate.answerBridgeId === existingBridge.id
        && candidate.mode !== 'detached')) {
        const { foregroundDeadlineAt: _foregroundDeadlineAt, ...historical } = child;
        builder.upsert('childTurnLinks', {
          ...historical,
          mode: 'detached',
          completionPolicy: 'notify_only',
          detachedAt: context.now,
          detachedReason: 'answer_bridge_continued',
          rowVersion: child.rowVersion + 1
        });
      }
    }
    const targetSlot = uniqueSlot(target, payload.targetConversationId);
    if (targetSlot && targetSlot.state !== 'released') {
      const termination = planTerminateRunGraph(target, {
        rootRunIds: [targetSlot.turnId],
        termination: { kind: 'cancelled', actor: 'system', reasonCode: 'answer_bridge_continued' },
        ...runGraphCascadeForPolicy('run_replacement')
      });
      appendTerminateRunGraphMutations(builder, target, termination, context.now);
    }
    const childLease = targetSlot && targetSlot.state !== 'released'
      ? replaceExecutionLease(targetSlot, {
          conversationId: payload.targetConversationId,
          expectedTurnId: targetSlot.turnId,
          nextTurnId: payload.childRunId,
          now: context.now
        })
      : acquireExecutionLease(target, {
          conversationId: payload.targetConversationId,
          turnId: payload.childRunId,
          now: context.now
        });

    appendMutations(builder, completeAttempt(source, {
      operationId: payload.operationId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      now: context.now,
      outcome: 'succeeded'
    }).mutations);

    const bridge: AnswerBridgeRecord = existingBridge
      ? {
          ...existingBridge,
          ownerRunId: payload.parentRunId,
          ownerGeneration: payload.generation,
          lifecycle: 'open',
          rowVersion: existingBridge.rowVersion + 1
        }
      : {
          id: payload.bridgeId,
          sourceConversationId: payload.sourceConversationId,
          targetConversationId: payload.targetConversationId,
          ownerRunId: payload.parentRunId,
          ownerGeneration: payload.generation,
          lifecycle: 'open',
          rowVersion: 1
        };
    const childMessage: MessageRecord = {
      id: payload.childMessageId,
      conversationId: payload.targetConversationId,
      role: 'user',
      presentation: 'visible',
      content: clone(payload.childContent),
      status: 'final',
      seq: nextMessageSeq(target),
      createdAt: context.now
    };
    const childRevision: MessageRevisionRecord = {
      id: payload.childRevisionId,
      messageId: childMessage.id,
      conversationId: payload.targetConversationId,
      content: clone(payload.childContent),
      createdAt: context.now,
      reason: 'created'
    };
    const childRun = {
      id: payload.childRunId,
      conversationId: payload.targetConversationId,
      lifecycle: 'active' as const,
      phase: 'loading_context' as const,
      rowVersion: 1,
      createdAt: context.now,
      updatedAt: context.now
    };
    const frozenInput = inputRevision(
      childRun.id,
      payload.targetConversationId,
      childMessage.id as MessageId,
      childRevision.id as MessageRevisionId,
      childMessage.content
    );

    if (!existingBridge) builder.generatedId(payload.bridgeId);
    if (!targetSlot) builder.generatedId(childLease.id);
    builder
      .generatedId(
        payload.childRunId,
        payload.childMessageId,
        payload.childRevisionId,
        payload.childAuthoritySnapshotId,
        payload.authorityDerivationLinkId
      )
      .upsert('conversation', {
        ...target.conversation,
        ...(payload.targetConversationTitle?.trim() ? { title: payload.targetConversationTitle.trim() } : {})
      })
      .upsert('answerBridges', bridge)
      .upsert('childTurnLinks', {
        id: relationId('child-turn', payload.parentRunId, payload.childRunId),
        parentTurnId: payload.parentRunId,
        parentConversationId: payload.sourceConversationId,
        childTurnId: payload.childRunId,
        childConversationId: payload.targetConversationId,
        answerBridgeId: payload.bridgeId,
        mode: payload.mode,
        completionPolicy: payload.mode === 'foreground' ? 'resume_owner' : 'start_continuation_when_idle',
        sourceToolCallId: payload.parentToolCallId,
        ...(payload.mode === 'foreground' ? { foregroundDeadlineAt: payload.foregroundDeadlineAt } : {}),
        createdAt: context.now,
        rowVersion: 1
      })
      .upsert('messages', childMessage)
      .upsert('messageRevisions', childRevision)
      .upsert('messageCurrentRevisionLinks', {
        id: relationId('message-current-revision', childMessage.id),
        messageId: childMessage.id,
        revisionId: childRevision.id
      })
      .upsert('turns', childRun)
      .upsert('runSources', {
        id: relationId('run-source', childRun.id),
        runId: childRun.id,
        sourceKind: 'toolCall',
        sourceConversationId: payload.sourceConversationId,
        sourceToolCallId: payload.parentToolCallId,
        sourceRunId: payload.parentRunId,
        answerBridgeId: payload.bridgeId
      })
      .upsert('runTargets', {
        id: relationId('run-target', childRun.id, payload.targetAgentId, payload.targetConversationId),
        runId: childRun.id,
        agentId: payload.targetAgentId,
        conversationId: payload.targetConversationId,
        role: 'executor'
      })
      .upsert('messageTurnLinks', {
        id: relationId('message-turn', childMessage.id, childRun.id, 'input'),
        messageId: childMessage.id,
        turnId: childRun.id,
        role: 'input'
      })
      .upsert('inputRevisions', frozenInput)
      .upsert('authoritySnapshots', childAuthority)
      .upsert('authorityDerivationLinks', authorityDerivationLink)
      .upsert('executionLeases', childLease)
      // Operation/Attempt describe the launch boundary; the non-terminal parent ToolCall and
      // ChildTurnLink own foreground completion without a second Wait state machine.
      .upsert('toolExecutions', {
        ...parentExecution,
        state: 'complete',
        rowVersion: parentExecution.rowVersion + 1
      });
    appendRunContextPolicy(builder, childRun.id, payload.targetConversationId, payload.childContextPolicy);

    appendInitialProgress(
      builder,
      payload.childProgressIds,
      childRun.id,
      payload.targetConversationId,
      childRevision.id as MessageRevisionId,
      frozenInput.contentHash,
      context.now,
      childExecutionPolicy
    );

    if (payload.mode === 'foreground') {
      if (!payload.foregroundDeadlineAt || payload.foregroundDeadlineAt <= context.now) return stale('foreground_deadline_invalid');
      builder.upsert('toolCalls', { ...parentTool, status: 'executing', updatedAt: context.now });
    } else {
      const result = appendBoundedInlineToolResult(builder, {
        conversationId: payload.sourceConversationId,
        tool: parentTool,
        status: 'success',
        result: clone(payload.backgroundResult),
        now: context.now
      });
      const completedTool: ToolContinuationPayload = {
        ...payload,
        toolCallId: payload.parentToolCallId,
        outcome: 'succeeded',
        modelResponse: result.modelResponse,
        completedAt: context.now,
        responseMessageId: payload.responseMessageId,
        responseRevisionId: payload.responseRevisionId,
        nextInvocationId: payload.nextInvocationId,
        nextRequestId: payload.nextRequestId,
        nextOperationId: payload.nextOperationId,
        nextAttemptId: payload.nextAttemptId,
        nextEffectIntentId: payload.nextEffectIntentId
      };
      builder.upsert('toolCalls', { ...withoutEmbeddedToolResult(parentTool), status: 'success', updatedAt: context.now });
      if (!hasRemainingToolWork(source, {
        runId: parentRun.id,
        toolCallIds: [payload.parentToolCallId],
        operationIds: [payload.operationId]
      })) appendToolResponsesAndNextInvocation(builder, source, parentRun, completedTool, context.now);
    }

    builder
      .patch(payload.sourceConversationId, { kind: 'answer_bridge.opened', bridgeId: payload.bridgeId, childRunId: payload.childRunId, mode: payload.mode })
      .patch(payload.targetConversationId, { kind: 'run.upsert', run: childRun });
    return builder.build(asJson({
      status: 'opened',
      bridgeId: payload.bridgeId,
      childRunId: payload.childRunId,
      targetConversationId: payload.targetConversationId,
      mode: payload.mode
    }));
  }
}

export interface SubmitAnswerPayload extends AttemptTokenPayload, ContinueIds {
  bridgeId: AnswerBridgeId;
  submitterToolCallId: ToolCallId;
  submissionId: AnswerSubmissionId;
  title: string;
  content: string;
}

/** Creates one immutable submission and a generation-owned foreground/background delivery. */
export class SubmitAnswerHandler implements InternalCommandHandler<JsonValue, MultiConversationDurableFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<MultiConversationDurableFacts> {
    const payload = payloadOf<SubmitAnswerPayload>(command);
    const scope = command.scope.kind === 'multi_conversation' ? command.scope.ids : [command.scope.id];
    if (scope.length !== 2) throw new Error('Answer submission requires canonical source and target scopes.');
    return multiView('answer.submit', scope[0], scope[1]);
  }

  public plan(view: DurableAggregateView<MultiConversationDurableFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<SubmitAnswerPayload>(command);
    const bridgeWithOwner = findBridge(view.facts, payload.bridgeId);
    if (!bridgeWithOwner) return stale('bridge_missing');
    const { bridge, facts: source } = bridgeWithOwner;
    const target = conversationFacts(view, bridge.targetConversationId);
    if (payload.conversationId !== bridge.targetConversationId || bridge.lifecycle !== 'open') return stale('bridge_not_open_for_submitter');
    if (!payload.title.trim() || !payload.content.trim()) return stale('answer_payload_empty');

    const matched = matchCurrentAttempt(target, payload);
    if (matched.status === 'stale') return stale(matched.reason);
    if (matched.attempt.state !== 'dispatched' || !matched.operation.kind.endsWith('.submit_agent_answer')) return stale('submit_attempt_not_dispatched');
    const submitterRun = unique(target.turns, requireRunOperationOwner(matched.operation), 'submitter Run');
    const submitterTool = unique(target.toolCalls, payload.submitterToolCallId, 'submitter ToolCall');
    const submitterExecution = unique(target.toolExecutions, payload.submitterToolCallId, 'submitter ToolExecution');
    if (!submitterRun || !submitterTool || !submitterExecution || submitterExecution.operationId !== payload.operationId || terminalTool(submitterTool)) {
      return stale('submitter_tool_mismatch');
    }
    if (source.answerSubmissions.some((submission) => submission.id === payload.submissionId)) return stale('submission_id_reused');

    const parentRun = unique(source.turns, bridge.ownerRunId, 'bridge owner Run');
    const canonicalChildLink = source.childTurnLinks.find((link) => link.answerBridgeId === bridge.id && link.parentTurnId === bridge.ownerRunId);
    const parentToolCallId = canonicalChildLink?.sourceToolCallId;
    const parentTool = parentToolCallId ? unique(source.toolCalls, parentToolCallId, 'bridge owner ToolCall') : undefined;
    const foreground = !!parentRun
      && parentRun.lifecycle === 'active'
      && !!parentTool
      && !terminalTool(parentTool)
      && canonicalChildLink?.mode === 'foreground'
      && (parentRun.phase === 'waiting_tools' || parentRun.phase === 'waiting_child_run' || parentRun.phase === 'delivering');
    const deliveryMode = foreground ? 'foreground' as const : 'background_notification' as const;

    const builder = multiBuilder(view, context);
    appendMutations(builder, completeAttempt(target, {
      operationId: payload.operationId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      now: context.now,
      outcome: 'succeeded'
    }).mutations);
    const submitResult = asJson({
      ok: true,
      answerBridgeId: bridge.id,
      submissionId: payload.submissionId,
      updated: bridge.currentSubmissionId !== undefined,
      mode: deliveryMode
    });
    const submitArtifact = appendBoundedInlineToolResult(builder, {
      conversationId: bridge.targetConversationId,
      tool: submitterTool,
      status: 'success',
      result: submitResult,
      now: context.now
    });
    builder
      .upsert('toolCalls', { ...withoutEmbeddedToolResult(submitterTool), status: 'success', updatedAt: context.now })
      .upsert('toolExecutions', { ...submitterExecution, state: 'complete', rowVersion: submitterExecution.rowVersion + 1 });
    const submitContinuation: ToolContinuationPayload = {
      ...payload,
      toolCallId: payload.submitterToolCallId,
      outcome: 'succeeded',
      modelResponse: submitArtifact.modelResponse,
      completedAt: context.now,
      responseMessageId: payload.responseMessageId,
      responseRevisionId: payload.responseRevisionId,
      nextInvocationId: payload.nextInvocationId,
      nextRequestId: payload.nextRequestId,
      nextOperationId: payload.nextOperationId,
      nextAttemptId: payload.nextAttemptId,
      nextEffectIntentId: payload.nextEffectIntentId
    };
    if (!hasRemainingToolWork(target, {
      runId: submitterRun.id,
      toolCallIds: [payload.submitterToolCallId],
      operationIds: [payload.operationId]
    })) appendToolResponsesAndNextInvocation(builder, target, submitterRun, submitContinuation, context.now);

    const revisionNo = source.answerSubmissions
      .filter((submission) => submission.bridgeId === bridge.id)
      .reduce((max, submission) => Math.max(max, submission.revisionNo), 0) + 1;
    const payloadRecordId = answerPayloadId(payload.submissionId);
    const answerBody = { title: payload.title.trim(), content: payload.content };
    const payloadHash = canonicalSha256(answerBody);
    const inbox = createRuntimeInboxRecords({
      kind: 'child_answer_submitted',
      sourceKind: 'child_turn',
      sourceId: submitterRun.id,
      dedupeKey: `answer:${bridge.id}:${payload.submissionId}`,
      payload: asJson({
        type: 'child_answer',
        bridgeId: bridge.id,
        submissionId: payload.submissionId,
        title: answerBody.title,
        content: answerBody.content,
        ...(parentToolCallId ? { parentToolCallId } : {})
      }),
      occurredAt: command.occurredAt,
      createdAt: context.now,
      destinationConversationId: bridge.sourceConversationId,
      ownerTurnId: bridge.ownerRunId,
      policy: foreground ? 'resume_owner' : 'inject_current_or_continue'
    });
    if (assertRuntimeInboxIdentity(source, inbox) !== 'new') return stale('runtime_inbox_identity_reused');
    builder
      .generatedId(payload.submissionId, inbox.delivery.id, inbox.item.id)
      .upsert('answerPayloads', {
        id: payloadRecordId,
        bridgeId: bridge.id,
        submissionId: payload.submissionId,
        title: answerBody.title,
        content: answerBody.content,
        payloadHash,
        createdAt: context.now
      })
      .upsert('answerSubmissions', {
        id: payload.submissionId,
        bridgeId: bridge.id,
        revisionNo,
        payloadRef: payloadRecordId,
        createdAt: context.now
      })
      .upsert('answerBridges', { ...bridge, currentSubmissionId: payload.submissionId, rowVersion: bridge.rowVersion + 1 })
      // Relation-first ordering proves canonical ownership of the decoupled RuntimeInboxItem.
      .upsert('runtimeDeliveryLinks', inbox.delivery)
      .upsert('runtimeInboxItems', inbox.item)
      .patch(bridge.targetConversationId, { kind: 'answer.submitted', bridgeId: bridge.id, submissionId: payload.submissionId, revisionNo })
      .patch(bridge.sourceConversationId, {
        kind: 'runtimeInbox.recorded',
        bridgeId: bridge.id,
        inboxItemId: inbox.item.id,
        deliveryId: inbox.delivery.id,
        mode: deliveryMode
      });
    return builder.build(asJson({
      status: 'submitted',
      bridgeId: bridge.id,
      submissionId: payload.submissionId,
      inboxItemId: inbox.item.id,
      deliveryId: inbox.delivery.id,
      mode: deliveryMode,
      deliveryState: 'pending'
    }));
  }
}

export interface InterruptChildRunsPayload extends AttemptTokenPayload, ContinueIds {
  bridgeId: AnswerBridgeId;
  callerToolCallId: ToolCallId;
  result: JsonValue;
  expectedOwnerGeneration: number;
  ownedChild?: {
    childRunId: RunId;
    targetConversationId: ConversationId;
    closureRunIds: RunId[];
    sourceContinuation: OwnedSourceToolContinuationIds;
  };
}

/** Atomically interrupts one exact Bridge-owned ChildRun closure and completes the caller's interrupt tool. */
export class InterruptChildRunsHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = payloadOf<InterruptChildRunsPayload>(command);
    const scope = command.scope.kind === 'multi_conversation' ? command.scope.ids : [command.scope.id];
    if (scope.length < 2) throw new Error('run_agent interrupt requires caller and bridge target scopes.');
    return scopedMergedView('answer_bridge.interrupt', scope, payload.conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<InterruptChildRunsPayload>(command);
    const facts = view.facts;
    const matched = matchCurrentAttempt(facts, payload);
    if (matched.status === 'stale') return stale(matched.reason);
    if (matched.attempt.state !== 'dispatched' || !matched.operation.kind.startsWith('tool.agent.')) return stale('interrupt_attempt_not_dispatched');
    const callerRun = unique(facts.turns, requireRunOperationOwner(matched.operation), 'caller Run');
    const callerTool = unique(facts.toolCalls, payload.callerToolCallId, 'caller ToolCall');
    const callerExecution = unique(facts.toolExecutions, payload.callerToolCallId, 'caller ToolExecution');
    if (!callerRun || callerRun.conversationId !== payload.conversationId || callerRun.lifecycle !== 'active' || callerRun.phase !== 'waiting_tools'
      || !callerTool || terminalTool(callerTool) || !callerExecution || callerExecution.operationId !== payload.operationId) {
      return stale('caller_tool_mismatch');
    }

    const ownership = resolveAnswerBridgeChildOwnership(facts, payload.bridgeId, {
      expectedOwnerGeneration: payload.expectedOwnerGeneration,
      requireTargetFacts: payload.ownedChild !== undefined
    });
    if (ownership.status === 'target_moved') return stale(ownership.reason);
    if (ownership.status === 'missing') return stale(ownership.reason);
    if (ownership.status === 'matched' && (!payload.ownedChild
      || ownership.ownership.childRunId !== payload.ownedChild.childRunId
      || ownership.ownership.targetConversationId !== payload.ownedChild.targetConversationId)) {
      return stale('target_moved');
    }
    if (payload.ownedChild?.closureRunIds.includes(callerRun.id)) return stale('cannot_interrupt_caller_run');

    const builder = mergedBuilder(view, context);
    let affectedRunIds: RunId[] = [];
    if (ownership.status === 'matched' && payload.ownedChild) {
      const termination = appendCancelOwnedChildWork(builder, facts, {
        ownership: ownership.ownership,
        policy: 'explicit_child_interrupt',
        closureRunIds: payload.ownedChild.closureRunIds,
        termination: {
          kind: 'interrupted',
          actor: 'parent_run',
          reasonCode: 'agent_interrupt_requested',
          triggerRunId: callerRun.id
        },
        now: context.now
      });
      affectedRunIds = termination.affectedRunIds;
      appendSettleOwnedSourceToolCancellation(builder, facts, {
        ownership: ownership.ownership,
        continuation: payload.ownedChild.sourceContinuation,
        reason: '子 Agent 已被显式中断。',
        affectedRunIds,
        now: context.now
      });
    }

    const result = interruptToolResult(payload.result, ownership.status === 'already_stopped' ? 'already_stopped' : 'interrupt_committed', affectedRunIds);
    const callerArtifact = appendBoundedInlineToolResult(builder, {
      conversationId: payload.conversationId,
      tool: callerTool,
      status: 'success',
      result,
      now: context.now
    });
    appendMutations(builder, completeAttempt(facts, {
      operationId: payload.operationId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      now: context.now,
      outcome: 'succeeded'
    }).mutations);
    builder
      .upsert('toolCalls', { ...withoutEmbeddedToolResult(callerTool), status: 'success', updatedAt: context.now })
      .upsert('toolExecutions', { ...callerExecution, state: 'complete', rowVersion: callerExecution.rowVersion + 1 });
    if (!hasRemainingToolWork(facts, {
      runId: callerRun.id,
      toolCallIds: [payload.callerToolCallId],
      operationIds: [payload.operationId]
    })) {
      appendToolResponsesAndNextInvocation(builder, facts, callerRun, {
        ...payload,
        toolCallId: payload.callerToolCallId,
        outcome: 'succeeded',
        modelResponse: callerArtifact.modelResponse,
        completedAt: context.now,
        responseMessageId: payload.responseMessageId,
        responseRevisionId: payload.responseRevisionId,
        nextInvocationId: payload.nextInvocationId,
        nextRequestId: payload.nextRequestId,
        nextOperationId: payload.nextOperationId,
        nextAttemptId: payload.nextAttemptId,
        nextEffectIntentId: payload.nextEffectIntentId
      }, context.now);
    }
    builder.patch(payload.conversationId, {
      kind: 'answer_bridge.interrupt_committed',
      bridgeId: payload.bridgeId,
      status: ownership.status === 'already_stopped' ? 'already_stopped' : 'interrupt_committed',
      affectedRunIds
    });
    if (ownership.status === 'matched') {
      builder.patch(ownership.ownership.targetConversationId, { kind: 'run_graph.terminal', affectedRunIds, reason: 'run_agent_interrupt' });
    }
    return builder.build(asJson({
      status: ownership.status === 'already_stopped' ? 'already_stopped' : 'interrupt_committed',
      bridgeId: payload.bridgeId,
      affectedRunIds
    }));
  }
}

export interface ForegroundChildWaitElapsedPayload extends ContinueIds {
  conversationId: ConversationId;
  bridgeId: AnswerBridgeId;
  parentRunId: RunId;
  parentToolCallId: ToolCallId;
  backgroundResult: JsonValue;
  deadlineAt: number;
}

export class ForegroundChildWaitElapsedHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = payloadOf<ForegroundChildWaitElapsedPayload>(command);
    return singleView('answer_bridge.foreground_wait_elapsed', payload.conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: InternalCommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf<ForegroundChildWaitElapsedPayload>(command);
    const facts = view.facts;
    const bridge = unique(facts.answerBridges, payload.bridgeId, 'AnswerBridge');
    const run = unique(facts.turns, payload.parentRunId, 'parent Run');
    const tool = unique(facts.toolCalls, payload.parentToolCallId, 'parent ToolCall');
    const execution = unique(facts.toolExecutions, payload.parentToolCallId, 'parent ToolExecution');
    const child = facts.childTurnLinks.find((candidate) => candidate.answerBridgeId === payload.bridgeId
      && candidate.parentTurnId === payload.parentRunId && candidate.mode === 'foreground');
    if (!bridge || !run || !tool || !execution || !child) return stale('foreground_child_link_missing');
    if (context.now < payload.deadlineAt || child.foregroundDeadlineAt !== payload.deadlineAt) {
      return { status: 'already_satisfied', result: asJson({ status: 'not_due' }) };
    }
    if (run.lifecycle !== 'active' || (run.phase !== 'waiting_tools' && run.phase !== 'waiting_child_run') || terminalTool(tool)) return stale('parent_no_longer_waiting');

    const builder = singleBuilder(view, context);
    const result = clone(payload.backgroundResult);
    const backgroundArtifact = appendBoundedInlineToolResult(builder, {
      conversationId: payload.conversationId,
      tool,
      status: 'success',
      result,
      now: context.now
    });
    const { foregroundDeadlineAt: _foregroundDeadlineAt, ...backgroundChild } = child;
    builder
      .upsert('childTurnLinks', {
        ...backgroundChild,
        mode: 'background',
        completionPolicy: 'inject_current_or_continue',
        rowVersion: child.rowVersion + 1
      })
      .upsert('toolCalls', { ...withoutEmbeddedToolResult(tool), status: 'success', updatedAt: context.now })
      .upsert('toolExecutions', { ...execution, state: 'complete', rowVersion: execution.rowVersion + 1 });
    const continued = !hasRemainingToolWork(facts, {
      runId: run.id,
      toolCallIds: [payload.parentToolCallId]
    });
    if (continued) {
      appendToolResponsesAndNextInvocation(builder, facts, run, {
        conversationId: payload.conversationId,
        toolCallId: payload.parentToolCallId,
        outcome: 'succeeded',
        modelResponse: backgroundArtifact.modelResponse,
        completedAt: context.now,
        responseMessageId: payload.responseMessageId,
        responseRevisionId: payload.responseRevisionId,
        nextInvocationId: payload.nextInvocationId,
        nextRequestId: payload.nextRequestId,
        nextOperationId: payload.nextOperationId,
        nextAttemptId: payload.nextAttemptId,
        nextEffectIntentId: payload.nextEffectIntentId
      }, context.now);
    } else if (run.phase === 'waiting_child_run') {
      builder.upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    }
    builder.patch(payload.conversationId, { kind: 'answer_bridge.backgrounded', bridgeId: bridge.id, childRunId: child.childTurnId });
    return builder.build(asJson({ status: 'backgrounded', bridgeId: bridge.id, childRunId: child.childTurnId, continued }));
  }
}

function multiView(
  kind: string,
  first: ConversationId,
  second: ConversationId,
  createMissingConversations: readonly ConversationId[] = []
): DurableViewSpec<MultiConversationDurableFacts> {
  const conversations = [...new Set([first, second])].sort() as ConversationId[];
  if (conversations.length !== 2) throw new Error(`${kind} requires two distinct conversation scopes.`);
  return scopedMultiView(kind, conversations, createMissingConversations);
}

function scopedMergedView(
  kind: string,
  requestedConversations: readonly ConversationId[],
  aggregateRootConversationId: ConversationId
): DurableViewSpec<DurableConversationFacts> {
  const conversations = [...new Set(requestedConversations)].sort() as ConversationId[];
  if (conversations.length < 2) throw new Error(`${kind} requires at least two distinct conversation scopes.`);
  return {
    kind,
    conversations,
    timeline: conversations.map((conversationId) => ({ conversationId, throughTail: true })),
    closedRunGraphRoots: [],
    relationFamilies: [...DURABLE_CONVERSATION_RECORD_FAMILIES],
    storageResourceKeys: [
      ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
      CONVERSATION_ATTACHMENTS_RESOURCE_KEY
    ],
    mergeConversationFacts: true,
    aggregateRootConversationId
  };
}

function scopedMultiView(
  kind: string,
  requestedConversations: readonly ConversationId[],
  createMissingConversations: readonly ConversationId[] = []
): DurableViewSpec<MultiConversationDurableFacts> {
  const conversations = [...new Set(requestedConversations)].sort() as ConversationId[];
  if (conversations.length < 2) throw new Error(`${kind} requires at least two distinct conversation scopes.`);
  return {
    kind,
    conversations,
    createMissingConversations,
    timeline: conversations.map((conversationId) => ({ conversationId, throughTail: true })),
    closedRunGraphRoots: [],
    relationFamilies: [...DURABLE_CONVERSATION_RECORD_FAMILIES],
    storageResourceKeys: [
      ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
      CONVERSATION_ATTACHMENTS_RESOURCE_KEY
    ]
  };
}

function singleView(kind: string, conversationId: ConversationId): DurableViewSpec<DurableConversationFacts> {
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

function mergedBuilder(view: DurableAggregateView<DurableConversationFacts>, context: CommandPlanningContext): ConversationTransitionBuilder {
  return new ConversationTransitionBuilder({
    transitionId: context.transitionId,
    scopes: view.scopes,
    baseVersions: view.baseVersions,
    streamHeads: streamHeads(view)
  });
}

function multiBuilder(view: DurableAggregateView<MultiConversationDurableFacts>, context: CommandPlanningContext): ConversationTransitionBuilder {
  return new ConversationTransitionBuilder({
    transitionId: context.transitionId,
    scopes: view.scopes,
    baseVersions: view.baseVersions,
    streamHeads: streamHeads(view)
  });
}

function singleBuilder(view: DurableAggregateView<DurableConversationFacts>, context: CommandPlanningContext): ConversationTransitionBuilder {
  return new ConversationTransitionBuilder({
    transitionId: context.transitionId,
    scopes: view.scopes,
    baseVersions: view.baseVersions,
    streamHeads: streamHeads(view)
  });
}

function streamHeads(view: DurableAggregateView<unknown>): ReadonlyMap<ConversationId, { streamId: string; nextSeq: number }> {
  return new Map([...view.storageHeads.values()]
    .filter((head): head is typeof head & { conversationId: ConversationId } => head.headKind === 'conversation-control' && !!head.conversationId)
    .map((head) => [head.conversationId, { streamId: `conversation:${head.conversationId}:state`, nextSeq: head.streamNextSeq }]));
}

function conversationFacts(view: DurableAggregateView<MultiConversationDurableFacts>, conversationId: ConversationId): DurableConversationFacts;
function conversationFacts(view: MultiConversationDurableFacts, conversationId: ConversationId): DurableConversationFacts;
function conversationFacts(view: DurableAggregateView<MultiConversationDurableFacts> | MultiConversationDurableFacts, conversationId: ConversationId): DurableConversationFacts {
  const facts = 'facts' in view ? view.facts.byConversation[conversationId] : view.byConversation[conversationId];
  if (!facts) throw new Error(`Multi-conversation durable view is missing ${conversationId}.`);
  return facts;
}

function findBridge(view: MultiConversationDurableFacts, bridgeId: AnswerBridgeId): { bridge: AnswerBridgeRecord; facts: DurableConversationFacts } | undefined {
  const matches = Object.values(view.byConversation).flatMap((facts) => facts.answerBridges.filter((bridge) => bridge.id === bridgeId).map((bridge) => ({ bridge, facts })));
  if (matches.length > 1) throw new Error(`AnswerBridge Stable ID conflict: ${bridgeId}`);
  return matches[0];
}

function uniqueSlot(facts: DurableConversationFacts, conversationId: ConversationId) {
  const matches = facts.executionLeases.filter((slot) => slot.conversationId === conversationId);
  if (matches.length > 1) throw new Error(`Conversation ${conversationId} has multiple execution slots.`);
  return matches[0];
}

function interruptToolResult(base: JsonValue, status: 'interrupt_committed' | 'already_stopped', affectedRunIds: readonly RunId[]): JsonValue {
  const record = base !== null && typeof base === 'object' && !Array.isArray(base)
    ? clone(base) as Record<string, JsonValue>
    : {};
  return asJson({ ...record, status, interruptRequested: status === 'interrupt_committed', affectedRunIds: [...affectedRunIds] });
}

function terminalTool(tool: ToolCallRecord): boolean {
  return tool.status === 'success' || tool.status === 'warning' || tool.status === 'error';
}

function appendMutations(builder: ConversationTransitionBuilder, mutations: readonly RecordMutation[]): void {
  for (const mutation of mutations) {
    if (mutation.kind === 'upsert') builder.upsert(mutation.family as never, mutation.record as unknown as { id: string });
    else if (mutation.kind === 'remove') builder.remove(mutation.family as never, mutation.id);
    else builder.removeMany(mutation.family as never, mutation.ids);
  }
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

function payloadOf<T>(command: InternalCommandEnvelope<JsonValue>): T {
  return command.payload as unknown as T;
}

function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function answerPayloadId(submissionId: AnswerSubmissionId): string {
  return relationId('answer-payload', submissionId);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

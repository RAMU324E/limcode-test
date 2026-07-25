import {
  ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY
} from '../../../shared/conversationReliability';
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
import type { ConversationId, RunId, ToolCallId } from '../../../shared/stableIds';
import { stableIdFromSeed } from '../stableIdFactory';
import { canonicalSha256 } from '../canonicalJson';
import { appendAdmittedTurn } from './turnAdmission';
import { effectiveConversationExecutionLease } from './executionLease';
import {
  appendToolResponsesAndNextInvocation,
  builderFor,
  fullView,
  type ToolContinuationPayload
} from './internalHandlers';
import { appendRunContextPolicy, contextPolicyForRun } from './runContextPolicy';
import {
  childAnswerPayload,
  runtimeDeliveryBatchDigest,
  runtimeDeliveryMessageContent,
  childTerminalPayload,
  createRuntimeInboxRecords,
  assertRuntimeInboxIdentity,
  type PendingRuntimeDelivery
} from './runtimeInbox';
import { hasRemainingToolWork } from './toolSchedule';
import { appendBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';
import { asJson, ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts, MultiConversationDurableFacts } from './types';
import { DURABLE_CONVERSATION_RECORD_FAMILIES } from './familyRegistry';

export interface ReconcileRuntimeDeliveryPayload {
  conversationId: ConversationId;
  deliveries: Array<{ id: string; rowVersion: number }>;
}

export interface RecordChildTerminalPayload {
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  parentTurnId: RunId;
  childTurnId: RunId;
  answerBridgeId: string;
}

/** Records a child terminal fact into its direct parent's Inbox; nested delivery never skips a level. */
export class RecordChildTerminalInboxHandler implements InternalCommandHandler<JsonValue, MultiConversationDurableFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<MultiConversationDurableFacts> {
    const payload = childTerminalCommandPayload(command);
    const conversations = [...new Set([payload.sourceConversationId, payload.targetConversationId])].sort() as ConversationId[];
    if (conversations.length !== 2) throw new Error('Child terminal emission requires distinct parent and child conversations.');
    return {
      kind: 'runtime_inbox.child_terminal',
      conversations,
      timeline: conversations.map((conversationId) => ({ conversationId, throughTail: true })),
      closedRunGraphRoots: [],
      relationFamilies: [...DURABLE_CONVERSATION_RECORD_FAMILIES],
      storageResourceKeys: [ANSWER_BRIDGE_LINKS_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY]
    };
  }

  public plan(
    view: DurableAggregateView<MultiConversationDurableFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = childTerminalCommandPayload(command);
    const source = conversationFacts(view.facts, payload.sourceConversationId);
    const target = conversationFacts(view.facts, payload.targetConversationId);
    const child = target.turns.find((candidate) => candidate.id === payload.childTurnId);
    const childSource = target.runSources.find((candidate) => candidate.runId === payload.childTurnId
      && candidate.answerBridgeId === payload.answerBridgeId
      && candidate.sourceConversationId === payload.sourceConversationId
      && candidate.sourceRunId === payload.parentTurnId);
    const link = source.childTurnLinks.find((candidate) => candidate.childTurnId === payload.childTurnId
      && candidate.parentTurnId === payload.parentTurnId
      && candidate.answerBridgeId === payload.answerBridgeId
      && candidate.childConversationId === payload.targetConversationId);
    const bridge = source.answerBridges.find((candidate) => candidate.id === payload.answerBridgeId
      && candidate.ownerRunId === payload.parentTurnId
      && candidate.targetConversationId === payload.targetConversationId);
    if (!child || child.phase !== 'terminal' || !childSource || !link || !bridge) return stale('child_terminal_identity_stale');

    const parent = source.turns.find((candidate) => candidate.id === payload.parentTurnId);
    const parentTool = link.sourceToolCallId
      ? source.toolCalls.find((candidate) => candidate.id === link.sourceToolCallId)
      : undefined;
    const hasSubmittedAnswer = bridge.currentSubmissionId !== undefined;
    const canResumeOwner = !hasSubmittedAnswer
      && link.mode === 'foreground'
      && parent?.lifecycle === 'active'
      && !!parentTool
      && parentTool.status !== 'success'
      && parentTool.status !== 'warning'
      && parentTool.status !== 'error';
    const termination = target.runTerminations.find((candidate) => candidate.runId === child.id);
    const records = createRuntimeInboxRecords({
      kind: 'child_terminal',
      sourceKind: 'child_turn',
      sourceId: child.id,
      dedupeKey: `terminal:${child.id}:${child.lifecycle}:${child.completedAt ?? child.updatedAt}`,
      payload: asJson({
        type: 'child_terminal',
        bridgeId: bridge.id,
        childTurnId: child.id,
        outcome: child.lifecycle,
        ...(termination ? { reason: termination.reasonCode } : {}),
        ...(link.sourceToolCallId ? { parentToolCallId: link.sourceToolCallId } : {})
      }),
      occurredAt: child.completedAt ?? child.updatedAt,
      createdAt: context.now,
      destinationConversationId: payload.sourceConversationId,
      ownerTurnId: payload.parentTurnId,
      policy: hasSubmittedAnswer ? 'notify_only' : canResumeOwner ? 'resume_owner' : 'inject_current_or_continue'
    });
    if (assertRuntimeInboxIdentity(source, records) === 'existing') {
      return { status: 'already_satisfied', result: asJson({ status: 'child_terminal_already_recorded', inboxItemId: records.item.id, deliveryId: records.delivery.id }) };
    }
    const builder = multiBuilder(view, context);
    builder
      .generatedId(records.delivery.id, records.item.id)
      .upsert('runtimeDeliveryLinks', records.delivery)
      .upsert('runtimeInboxItems', records.item)
      .patch(payload.sourceConversationId, {
        kind: 'runtimeInbox.recorded',
        inboxItemId: records.item.id,
        deliveryId: records.delivery.id,
        eventKind: records.item.kind
      });
    return builder.build(asJson({
      status: 'child_terminal_recorded',
      inboxItemId: records.item.id,
      deliveryId: records.delivery.id,
      policy: records.delivery.policy
    }));
  }
}

/**
 * Consumes committed asynchronous input from durable facts only. It either resumes the exact
 * foreground owner Tool, injects internal input at a proven same-Turn boundary (handled by the
 * normal continuation helpers), or starts one inherited-authority continuation while idle.
 */
export class ReconcileRuntimeDeliveryHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    return fullView('runtime_delivery.reconcile', payloadOf(command).conversationId);
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = payloadOf(command);
    const facts = view.facts;
    if (facts.conversation.id !== payload.conversationId || facts.conversation.visibility === 'hidden') return stale('conversation_unavailable');
    if (payload.deliveries.length === 0 || payload.deliveries.length !== new Set(payload.deliveries.map((item) => item.id)).size) {
      return stale('delivery_batch_invalid');
    }
    const selected = payload.deliveries.map((expected) => {
      const delivery = facts.runtimeDeliveryLinks.find((candidate) => candidate.id === expected.id);
      if (!delivery || delivery.state !== 'pending' || delivery.rowVersion !== expected.rowVersion) return undefined;
      const item = facts.runtimeInboxItems.find((candidate) => candidate.id === delivery.inboxItemId);
      return item ? { item, delivery } : undefined;
    });
    if (selected.some((item) => !item)) return stale('delivery_batch_changed');
    const batch = selected as PendingRuntimeDelivery[];
    const sorted = [...batch].sort((left, right) => left.item.occurredAt - right.item.occurredAt
      || left.item.id.localeCompare(right.item.id)
      || left.delivery.id.localeCompare(right.delivery.id));
    if (sorted.some((item, index) => item.delivery.id !== batch[index]!.delivery.id)) return stale('delivery_batch_not_canonical');

    if (batch.length === 1 && batch[0]!.delivery.policy === 'resume_owner') {
      const resumed = this.resumeForegroundOwner(view, batch[0]!, context);
      if (resumed) return resumed;
    }

    const lease = effectiveConversationExecutionLease(facts, payload.conversationId);
    if (lease) {
      const builder = builderFor(view, context, payload.conversationId);
      let changed = false;
      for (const { delivery } of batch) {
        if (delivery.policy !== 'resume_owner') continue;
        changed = true;
        builder.upsert('runtimeDeliveryLinks', {
          ...delivery,
          policy: 'inject_current_or_continue',
          rowVersion: delivery.rowVersion + 1,
          updatedAt: context.now
        });
      }
      return changed
        ? builder.build(asJson({ status: 'delivery_retargeted_to_current_turn', deliveryIds: batch.map((item) => item.delivery.id), targetTurnId: lease.turnId }))
        : { status: 'already_satisfied', result: asJson({ status: 'waiting_for_safe_boundary', targetTurnId: lease.turnId }) };
    }

    const notifyOnly = batch.filter(({ delivery }) => delivery.policy === 'notify_only');
    const continuations = batch.filter(({ delivery }) => delivery.policy !== 'notify_only'
      && delivery.policy !== 'defer_until_next_user_turn');
    if (continuations.length === 0) {
      if (notifyOnly.length === 0) return { status: 'already_satisfied', result: asJson({ status: 'delivery_deferred' }) };
      const builder = builderFor(view, context, payload.conversationId);
      for (const { delivery } of notifyOnly) consumeDelivery(builder, delivery, context.now);
      return builder.build(asJson({ status: 'notifications_consumed', deliveryIds: notifyOnly.map((item) => item.delivery.id) }));
    }

    const ownerTurnId = continuations[0]!.delivery.ownerTurnId;
    if (!ownerTurnId || continuations.some(({ delivery }) => delivery.ownerTurnId !== ownerTurnId)) return stale('delivery_authority_owner_ambiguous');
    return this.startIdleContinuation(view, continuations, notifyOnly, ownerTurnId, context);
  }

  private resumeForegroundOwner(
    view: DurableAggregateView<DurableConversationFacts>,
    selected: PendingRuntimeDelivery,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | undefined {
    const facts = view.facts;
    const { item, delivery } = selected;
    const answer = item.kind === 'child_answer_submitted' ? childAnswerPayload(item.payload) : undefined;
    const terminal = item.kind === 'child_terminal' ? childTerminalPayload(item.payload) : undefined;
    const event = answer ?? terminal;
    const ownerTurnId = delivery.ownerTurnId;
    if (!event || !ownerTurnId) return undefined;
    const run = facts.turns.find((candidate) => candidate.id === ownerTurnId);
    const lease = effectiveConversationExecutionLease(facts, facts.conversation.id);
    const canonicalChild = facts.childTurnLinks.find((candidate) => candidate.answerBridgeId === event.bridgeId
      && candidate.parentTurnId === ownerTurnId);
    const parentToolCallId = (event.parentToolCallId ?? canonicalChild?.sourceToolCallId) as ToolCallId | undefined;
    const tool = parentToolCallId ? facts.toolCalls.find((candidate) => candidate.id === parentToolCallId) : undefined;
    const execution = parentToolCallId ? facts.toolExecutions.find((candidate) => candidate.id === parentToolCallId) : undefined;
    const deliverable = !!run
      && run.lifecycle === 'active'
      && lease?.turnId === run.id
      && (run.phase === 'waiting_tools' || run.phase === 'waiting_child_run' || run.phase === 'delivering')
      && !!tool
      && tool.status !== 'success'
      && tool.status !== 'warning'
      && tool.status !== 'error'
      && !!execution;
    if (!deliverable || !run || !tool || !execution || !parentToolCallId) return undefined;

    const builder = builderFor(view, context, facts.conversation.id);
    const result = answer
      ? asJson({
          ok: true,
          answerBridgeId: answer.bridgeId,
          submissionId: answer.submissionId,
          title: answer.title,
          content: answer.content
        })
      : asJson({
          ok: true,
          answerBridgeId: terminal!.bridgeId,
          childTurnId: terminal!.childTurnId,
          status: terminal!.outcome,
          ...(terminal!.reason ? { reason: terminal!.reason } : {}),
          message: 'Subagent reached a terminal state without submitting an answer.'
        });
    const artifact = appendBoundedInlineToolResult(builder, {
      conversationId: facts.conversation.id,
      tool,
      status: 'success',
      result,
      now: context.now
    });
    builder
      .upsert('toolCalls', { ...withoutEmbeddedToolResult(tool), status: 'success', updatedAt: context.now })
      .upsert('toolExecutions', { ...execution, state: 'complete', rowVersion: execution.rowVersion + 1 });
    if (canonicalChild?.mode === 'foreground') {
      const { foregroundDeadlineAt: _foregroundDeadlineAt, ...backgroundChild } = canonicalChild;
      builder.upsert('childTurnLinks', {
        ...backgroundChild,
        mode: 'background',
        completionPolicy: 'inject_current_or_continue',
        rowVersion: canonicalChild.rowVersion + 1
      });
    }
    consumeDelivery(builder, delivery, context.now, run.id);

    const continued = !hasRemainingToolWork(facts, {
      runId: run.id,
      toolCallIds: [parentToolCallId],
      operationIds: [execution.operationId]
    });
    if (continued) {
      const ids = continuationIds(delivery.id);
      const continuation: ToolContinuationPayload = {
        conversationId: facts.conversation.id,
        toolCallId: parentToolCallId,
        outcome: 'succeeded',
        modelResponse: artifact.modelResponse,
        completedAt: context.now,
        ...ids
      };
      appendToolResponsesAndNextInvocation(builder, facts, run, continuation, context.now);
    } else if (run.phase === 'delivering' || run.phase === 'waiting_child_run') {
      builder.upsert('turns', { ...run, phase: 'waiting_tools', rowVersion: run.rowVersion + 1, updatedAt: context.now });
    }
    builder.patch(facts.conversation.id, {
      kind: 'runtimeDelivery.consumed',
      deliveryId: delivery.id,
      inboxItemId: item.id,
      targetTurnId: run.id
    });
    return builder.build(asJson({ status: 'owner_resumed', deliveryId: delivery.id, targetTurnId: run.id, continued }));
  }

  private startIdleContinuation(
    view: DurableAggregateView<DurableConversationFacts>,
    batch: PendingRuntimeDelivery[],
    notifyOnly: PendingRuntimeDelivery[],
    ownerTurnId: RunId,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const facts = view.facts;
    const owner = facts.turns.find((candidate) => candidate.id === ownerTurnId);
    const target = facts.runTargets.find((candidate) => candidate.runId === ownerTurnId && candidate.role === 'executor');
    const authorities = facts.authoritySnapshots.filter((candidate) => candidate.turnId === ownerTurnId);
    if (!owner || !target || authorities.length !== 1) {
      const builder = builderFor(view, context, facts.conversation.id);
      for (const { delivery } of [...batch, ...notifyOnly]) {
        builder.upsert('runtimeDeliveryLinks', {
          ...delivery,
          state: 'dead_letter',
          error: !owner ? 'authority_owner_missing' : !target ? 'authority_target_missing' : 'authority_snapshot_missing_or_ambiguous',
          deadLetterAt: context.now,
          rowVersion: delivery.rowVersion + 1,
          updatedAt: context.now
        });
      }
      return builder.build(asJson({ status: 'dead_lettered', deliveryIds: batch.map((item) => item.delivery.id) }));
    }

    const digest = runtimeDeliveryBatchDigest(batch);
    const seed = `runtime-delivery-continuation:${facts.conversation.id}:${ownerTurnId}:${digest}`;
    const ids = {
      turnId: stableIdFromSeed('run', `${seed}:turn`),
      messageId: stableIdFromSeed('message', `${seed}:message`),
      revisionId: stableIdFromSeed('messageRevision', `${seed}:revision`),
      authoritySnapshotId: stableIdFromSeed('authoritySnapshot', `${seed}:authority`),
      operationId: stableIdFromSeed('operation', `${seed}:operation`),
      attemptId: stableIdFromSeed('attempt', `${seed}:attempt`),
      effectIntentId: stableIdFromSeed('effectIntent', `${seed}:effect`)
    };
    const derivationLinkId = stableIdFromSeed('relation', `${seed}:authority-derivation`);
    if (facts.turns.some((candidate) => candidate.id === ids.turnId)) {
      throw new Error(`RuntimeDelivery continuation identity exists while delivery remains pending: ${ids.turnId}`);
    }
    const builder = builderFor(view, context, facts.conversation.id);
    const admitted = appendAdmittedTurn(builder, facts, {
      conversationId: facts.conversation.id,
      agentId: target.agentId,
      content: runtimeDeliveryMessageContent(batch),
      now: context.now,
      ids,
      authority: clone(authorities[0]!.authority),
      source: { kind: 'continuation', sourceId: batch[0]!.delivery.id }
    });
    builder
      .upsert('authoritySnapshots', { ...admitted.authority, derivation: 'continuation' })
      .upsert('authorityDerivationLinks', {
        id: derivationLinkId,
        parentSnapshotId: authorities[0]!.id,
        childSnapshotId: admitted.authority.id,
        parentTurnId: owner.id,
        parentConversationId: facts.conversation.id,
        childTurnId: admitted.turn.id,
        childConversationId: facts.conversation.id,
        overrideDigest: canonicalSha256(batch.map((item) => item.delivery.id)),
        relation: 'equal',
        createdAt: context.now
      });
    appendRunContextPolicy(
      builder,
      admitted.turn.id,
      facts.conversation.id,
      contextPolicyForRun(facts, owner.id) ?? { historyMode: 'full' }
    );
    for (const { delivery } of [...batch, ...notifyOnly]) consumeDelivery(builder, delivery, context.now, admitted.turn.id);
    builder.patch(facts.conversation.id, {
      kind: 'runtimeDelivery.continuationStarted',
      deliveryIds: batch.map((item) => item.delivery.id),
      turnId: admitted.turn.id,
      messageId: admitted.message.id
    });
    return builder.build(asJson({
      status: 'continuation_started',
      deliveryIds: batch.map((item) => item.delivery.id),
      turnId: admitted.turn.id,
      messageId: admitted.message.id
    }));
  }
}

function consumeDelivery(
  builder: ConversationTransitionBuilder,
  delivery: DurableConversationFacts['runtimeDeliveryLinks'][number],
  now: number,
  targetTurnId?: RunId
): void {
  builder.upsert('runtimeDeliveryLinks', {
    ...delivery,
    ...(targetTurnId ? { targetTurnId } : {}),
    state: 'consumed',
    consumedAt: now,
    rowVersion: delivery.rowVersion + 1,
    updatedAt: now
  });
}

function continuationIds(seed: string): Pick<ToolContinuationPayload,
  'responseMessageId' | 'responseRevisionId' | 'nextInvocationId' | 'nextRequestId' | 'nextOperationId' | 'nextAttemptId' | 'nextEffectIntentId'> {
  return {
    responseMessageId: stableIdFromSeed('message', `${seed}:tool-response-message`),
    responseRevisionId: stableIdFromSeed('messageRevision', `${seed}:tool-response-revision`),
    nextInvocationId: stableIdFromSeed('invocation', `${seed}:next-invocation`),
    nextRequestId: stableIdFromSeed('request', `${seed}:next-request`),
    nextOperationId: stableIdFromSeed('operation', `${seed}:next-operation`),
    nextAttemptId: stableIdFromSeed('attempt', `${seed}:next-attempt`),
    nextEffectIntentId: stableIdFromSeed('effectIntent', `${seed}:next-effect`)
  };
}

function multiBuilder(
  view: DurableAggregateView<MultiConversationDurableFacts>,
  context: CommandPlanningContext
): ConversationTransitionBuilder {
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

function conversationFacts(facts: MultiConversationDurableFacts, conversationId: ConversationId): DurableConversationFacts {
  const selected = facts.byConversation[conversationId];
  if (!selected) throw new Error(`Multi-conversation RuntimeInbox view is missing ${conversationId}.`);
  return selected;
}

function childTerminalCommandPayload(command: InternalCommandEnvelope<JsonValue>): RecordChildTerminalPayload {
  return command.payload as unknown as RecordChildTerminalPayload;
}

function payloadOf(command: InternalCommandEnvelope<JsonValue>): ReconcileRuntimeDeliveryPayload {
  return command.payload as unknown as ReconcileRuntimeDeliveryPayload;
}

function stale(reason: string): InternalCommandNoop<JsonValue> {
  return { status: 'stale', result: asJson({ status: 'stale', reason }) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

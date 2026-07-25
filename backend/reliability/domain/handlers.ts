import { ANSWER_BRIDGE_LINKS_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY } from '../../../shared/conversationReliability';
import type {
  CommandEnvelope,
  CommandPlanningContext,
  CommandRejection,
  ConversationCommandHandler,
  DurableAggregateView,
  DurableViewSpec,
  EffectiveTurnAuthority,
  JsonValue,
  OperationRecord,
  AttemptRecord,
  PrimaryEffectDescriptor,
  TransitionPlan
} from '../../../shared/conversationReliability';
import type { MessageContent, MessageRecord, MessageRevisionRecord } from '../../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RunId,
  ToolCallId,
  TransitionId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import { managedAttachmentIdsFromContents } from '../managedAttachmentReferences';
import { validateRunInvariants } from '../runInvariantValidator';
import { appendTerminateRunGraphMutations, planTerminateRunGraph } from './terminateRunGraph';
import { runGraphCascadeForPolicy } from './cancellationIntent';
import { appendRunContextPolicy } from './runContextPolicy';
import { conversationExecutionLease, replaceExecutionLease } from './executionLease';
import {
  collectCompressionBlockDependencyClosure,
  projectionIdsDependingOnSources
} from './modelContextProjection';
import { asJson, ConversationTransitionBuilder } from './transitionBuilder';
import { DURABLE_CONVERSATION_RECORD_FAMILIES } from './familyRegistry';
import type {
  DeleteCommandPayload,
  DeleteConversationAggregatePayload,
  DurableConversationFacts,
  EditCommandPayload,
  RenameConversationPayload,
  RetryCommandPayload,
  RunInputRevisionFactRecord
} from './types';

export interface InitialProgressIds extends Record<string, string> {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

interface RetryIds extends InitialProgressIds { runId: RunId; }
interface EditIds extends InitialProgressIds { revisionId: MessageRevisionId; runId: RunId; }

export type DeleteResult = { removedMessageIds: MessageId[]; affectedRunIds: RunId[] };
export type RenameConversationResult = { conversationId: ConversationId; title: string };
export type DeleteConversationAggregateResult = { conversationId: ConversationId; removedMessageIds: MessageId[]; affectedRunIds: RunId[] };
export type EditResult = { messageId: MessageId; revisionId: MessageRevisionId; restartedRunId?: RunId; removedMessageIds: MessageId[] };
export type RetryResult = { previousRunId: RunId; newRunId: RunId; removedMessageIds: MessageId[] };


export class RenameConversationCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, RenameConversationResult, Record<string, string>> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as RenameConversationPayload;
    return fullConversationView('rename', payload.conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: CommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<RenameConversationResult> | CommandRejection {
    const payload = command.payload as unknown as RenameConversationPayload;
    const invalid = validateConversationPayload(view, payload.conversationId);
    if (invalid) return invalid;
    const title = payload.title.trim();
    if (!title) return rejection('invalid_state', 'Conversation title cannot be empty.');
    if (view.facts.conversation.visibility === 'hidden') return rejection('invalid_state', 'Deleted conversation cannot be renamed.');
    const builder = createBuilder(view, command, context.transitionId);
    builder
      .upsert('conversation', { ...view.facts.conversation, title })
      .patch(payload.conversationId, { kind: 'conversation.renamed', conversationId: payload.conversationId, title });
    return builder.build(asJson({ conversationId: payload.conversationId, title }) as RenameConversationResult);
  }
}



export class DeleteConversationAggregateCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, DeleteConversationAggregateResult, Record<string, string>> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as DeleteConversationAggregatePayload;
    return fullConversationView('delete_aggregate', payload.conversationId);
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: CommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<DeleteConversationAggregateResult> | CommandRejection {
    const payload = command.payload as unknown as DeleteConversationAggregatePayload;
    const invalid = validateConversationPayload(view, payload.conversationId);
    if (invalid) return invalid;
    if (view.facts.conversation.visibility === 'hidden') return rejection('invalid_state', 'Conversation is already deleted.');
    const facts = view.facts;
    const builder = createBuilder(view, command, context.transitionId);
    const rootRunIds = facts.turns
      .filter((run) => run.conversationId === payload.conversationId && run.phase !== 'terminal')
      .map((run) => run.id);
    const messages = facts.messages
      .filter((message) => message.conversationId === payload.conversationId)
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    let deletion: DeleteResult = { removedMessageIds: [], affectedRunIds: [] };
    if (messages.length > 0) {
      deletion = appendDeleteSuffix(builder, facts, messages[0].seq, false, context.now, payload.conversationId, rootRunIds, 'full_tree_stop');
    } else if (rootRunIds.length > 0) {
      const termination = planTerminateRunGraph(facts, {
        rootRunIds,
        termination: { kind: 'cancelled', actor: 'user', reasonCode: 'conversation_deleted' },
        ...runGraphCascadeForPolicy('full_tree_stop')
      });
      appendTerminateRunGraphMutations(builder, facts, termination, context.now);
      deletion = { removedMessageIds: [], affectedRunIds: termination.affectedRunIds };
    }
    builder
      .upsert('conversation', { ...facts.conversation, visibility: 'hidden' })
      .patch(payload.conversationId, { kind: 'conversation.deleted', conversationId: payload.conversationId });
    return builder.build(asJson({ conversationId: payload.conversationId, ...deletion }) as DeleteConversationAggregateResult);
  }
}

export class DeleteConversationCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, DeleteResult, Record<string, string>> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as DeleteCommandPayload;
    return { ...fullConversationView('delete', payload.conversationId), timeline: [{ conversationId: payload.conversationId, fromMessageId: payload.messageId, throughTail: true }] };
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: CommandEnvelope<JsonValue>, context: CommandPlanningContext): TransitionPlan<DeleteResult> | CommandRejection {
    const payload = command.payload as unknown as DeleteCommandPayload;
    const invalid = validateConversationPayload(view, payload.conversationId);
    if (invalid) return invalid;
    const boundary = normalizedDeleteBoundary(view.facts, payload.messageId);
    if (!boundary) return rejection('not_found', `Message not found: ${payload.messageId}`);
    const builder = createBuilder(view, command, context.transitionId);
    const deletion = appendDeleteSuffix(builder, view.facts, boundary.seq, false, context.now, payload.conversationId);
    if (deletion.removedMessageIds.length === 0) return rejection('invalid_state', 'Delete suffix is empty.');
    for (const messageId of deletion.removedMessageIds) builder.patch(payload.conversationId, { kind: 'message.remove', id: messageId });
    return builder.build(asJson(deletion) as DeleteResult);
  }
}

export class EditConversationCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, EditResult, EditIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as EditCommandPayload;
    return { ...fullConversationView('edit', payload.conversationId), timeline: [{ conversationId: payload.conversationId, fromMessageId: payload.messageId, throughTail: payload.deleteFollowing }] };
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: CommandEnvelope<JsonValue>, context: CommandPlanningContext<EditIds>): TransitionPlan<EditResult> | CommandRejection {
    const payload = command.payload as unknown as EditCommandPayload;
    const invalid = validateConversationPayload(view, payload.conversationId) ?? validateMessageContent(payload.content);
    if (invalid) return invalid;
    const message = uniqueRecord(view.facts.messages, payload.messageId, 'Message');
    if (!message) return rejection('not_found', `Message not found: ${payload.messageId}`);
    const currentLink = uniqueMatchingRecord(view.facts.messageCurrentRevisionLinks, (link) => link.messageId === message.id, 'current MessageRevision link');
    const oldRevisionId = currentLink?.revisionId;
    const revision: MessageRevisionRecord = {
      id: context.ids.revisionId,
      messageId: message.id,
      conversationId: payload.conversationId,
      content: cloneContent(payload.content),
      createdAt: context.now,
      reason: 'edited'
    };
    const builder = createBuilder(view, command, context.transitionId);
    builder
      .generatedId(context.ids.revisionId)
      .upsert('messageRevisions', revision)
      .upsert('messageCurrentRevisionLinks', { id: currentLink?.id ?? relationId('message-current-revision', message.id), messageId: message.id, revisionId: revision.id })
      .upsert('messages', { ...message, content: revision.content, status: 'final' });

    let removedMessageIds: MessageId[] = [];
    if (payload.deleteFollowing) {
      const deletion = appendDeleteSuffix(builder, view.facts, message.seq, true, context.now, payload.conversationId);
      removedMessageIds = deletion.removedMessageIds;
    } else if (oldRevisionId) {
      const affectedProjectionIds = projectionIdsDependingOnSources(view.facts, (source) =>
        source.sourceKind === 'messageRevision'
        && (source.sourceId === oldRevisionId || source.messageId === message.id));
      const compressionSeeds = new Set(view.facts.compressionBlockSourceLinks
        .filter((link) => link.sourceKind === 'message' && (link.sourceId === message.id || link.revisionId === oldRevisionId))
        .map((link) => link.blockId));
      for (const link of view.facts.compressionModelContextProjectionLinks) {
        if (affectedProjectionIds.has(link.projectionId)) compressionSeeds.add(link.blockId);
      }
      const staleBlocks = collectCompressionBlockDependencyClosure(view.facts, compressionSeeds);
      for (const block of view.facts.compressionBlocks.filter((candidate) => staleBlocks.has(candidate.id) && candidate.status === 'complete')) {
        builder.upsert('compressionBlocks', {
          ...block,
          status: 'stale',
          staleReason: 'source_revision_edited',
          updatedAt: context.now
        });
      }
      const dependentRuns = view.facts.inputRevisions.filter((input) => input.revisionId === oldRevisionId).map((input) => input.runId);
      const active = dependentRuns.filter((runId) => view.facts.turns.some((run) => run.id === runId && run.phase !== 'terminal'));
      if (active.length > 0) {
        const termination = planTerminateRunGraph(view.facts, {
          rootRunIds: active,
          termination: { kind: 'stale', actor: 'user', reasonCode: 'source_revision_edited' },
          ...runGraphCascadeForPolicy('run_replacement')
        });
        appendTerminateRunGraphMutations(builder, view.facts, termination, context.now);
      }
    }

    let restartedRunId: RunId | undefined;
    if (payload.restartRun) {
      const target = targetForSourceMessage(view.facts, message.id as MessageId);
      if (!target) return rejection('invalid_state', 'Cannot restart edited message because its prior Run/target is unknown.');
      restartedRunId = context.ids.runId;
      builder.generatedId(context.ids.runId);
      appendRestartedRun(builder, view.facts, {
        runId: context.ids.runId,
        conversationId: payload.conversationId,
        agentId: target.agentId,
        messageId: message.id as MessageId,
        revisionId: revision.id as MessageRevisionId,
        content: revision.content,
        now: context.now,
        progressIds: context.ids,
        sourceTurnId: target.runId
      });
    }
    builder.patch(payload.conversationId, { kind: 'message.upsert', message: { ...message, content: revision.content } });
    for (const id of removedMessageIds) builder.patch(payload.conversationId, { kind: 'message.remove', id });
    return builder.build(asJson({ messageId: message.id, revisionId: revision.id, ...(restartedRunId ? { restartedRunId } : {}), removedMessageIds }) as EditResult);
  }
}

export class RetryConversationCommandHandler implements ConversationCommandHandler<JsonValue, DurableConversationFacts, RetryResult, RetryIds> {
  public requiredView(command: CommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as RetryCommandPayload;
    // Retry is a Run-level rewind. The clicked model Message only resolves the Run; planning needs
    // the complete timeline so the stable cutoff can be derived from that Run's frozen input.
    return { ...fullConversationView('retry', payload.conversationId), timeline: [{ conversationId: payload.conversationId, throughTail: true }] };
  }

  public plan(view: DurableAggregateView<DurableConversationFacts>, command: CommandEnvelope<JsonValue>, context: CommandPlanningContext<RetryIds>): TransitionPlan<RetryResult> | CommandRejection {
    const payload = command.payload as unknown as RetryCommandPayload;
    const invalid = validateConversationPayload(view, payload.conversationId);
    if (invalid) return invalid;
    const targetMessage = uniqueRecord(view.facts.messages, payload.messageId, 'Message');
    if (!targetMessage) return rejection('not_found', `Message not found: ${payload.messageId}`);
    if (targetMessage.role !== 'model') return rejection('invalid_state', 'Retry target must be a model message.');
    const modelLink = uniqueMatchingRecord(
      view.facts.messageTurnLinks,
      (link) => link.messageId === targetMessage.id && link.role === 'model',
      `model MessageTurnLink ${targetMessage.id}`
    );
    const previousRun = modelLink ? uniqueRecord(view.facts.turns, modelLink.turnId, 'Run') : undefined;
    if (!previousRun) return rejection('invalid_state', 'Retry target has no uniquely owned Run.');
    const sourceInput = latestInputForRun(view.facts, previousRun.id);
    const target = view.facts.runTargets.find((item) => item.runId === previousRun.id && item.role === 'executor');
    if (!sourceInput || !target) return rejection('invalid_state', 'Retry source input/policy/target is incomplete.');
    const inputMessage = uniqueRecord(view.facts.messages, sourceInput.messageId, 'input Message');
    const revision = uniqueRecord(view.facts.messageRevisions, sourceInput.revisionId, 'input Revision');
    if (!inputMessage || !revision) return rejection('invalid_state', 'Retry frozen input revision is unavailable.');
    if (inputMessage.conversationId !== payload.conversationId || targetMessage.seq <= inputMessage.seq) {
      return rejection('invalid_state', 'Retry target is not an output after the Run frozen input.');
    }

    const builder = createBuilder(view, command, context.transitionId);
    // Every model/tool round produced by the old Run is one retry unit. Keeping an earlier tool
    // round would create an impossible context where the new Run starts after its own side effects.
    const deletion = appendDeleteSuffix(builder, view.facts, inputMessage.seq, true, context.now, payload.conversationId);
    builder.generatedId(context.ids.runId);
    appendRestartedRun(builder, view.facts, {
      runId: context.ids.runId,
      retryOfRunId: previousRun.id,
      conversationId: payload.conversationId,
      agentId: target.agentId,
      messageId: inputMessage.id as MessageId,
      revisionId: revision.id as MessageRevisionId,
      content: revision.content,
      now: context.now,
      progressIds: context.ids,
      sourceTurnId: previousRun.id
    });
    for (const id of deletion.removedMessageIds) builder.patch(payload.conversationId, { kind: 'message.remove', id });
    builder.patch(payload.conversationId, { kind: 'run.upsert', runId: context.ids.runId, retryOfRunId: previousRun.id });
    return builder.build(asJson({ previousRunId: previousRun.id, newRunId: context.ids.runId, removedMessageIds: deletion.removedMessageIds }) as RetryResult);
  }
}


export function validatePlannedConversationState(facts: DurableConversationFacts): void {
  validateRunInvariants({
    turns: facts.turns,
    leases: facts.executionLeases,
    operations: facts.operations,
    attempts: facts.attempts,
    interactions: facts.interactionRequests,
    interactionOwners: facts.interactionOwnerLinks,
    childTurnLinks: facts.childTurnLinks,
    pauses: facts.pauses,
    additionalProgress: new Map(facts.turns.map((run) => [run.id, {
      ...(run.phase === 'llm_streaming' ? { stream_state: 1 } : {})
    }]))
  });
}

function appendDeleteSuffix(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  anchorSeq: number,
  keepAnchor: boolean,
  now: number,
  conversationId: ConversationId,
  additionalRootRunIds: readonly RunId[] = [],
  terminationPolicy: 'run_replacement' | 'full_tree_stop' = 'run_replacement'
): DeleteResult {
  const removedMessages = facts.messages.filter((message) => message.conversationId === conversationId && (keepAnchor ? message.seq > anchorSeq : message.seq >= anchorSeq));
  const removedMessageIds = new Set(removedMessages.map((message) => message.id as MessageId));
  const removedRevisions = facts.messageRevisions.filter((revision) => removedMessageIds.has(revision.messageId as MessageId));
  const revisionIds = new Set(removedRevisions.map((revision) => revision.id));
  const toolIds = new Set(facts.toolCalls.filter((tool) => removedMessageIds.has(tool.messageId as MessageId)).map((tool) => tool.id));
  const removedToolResultLinkIds = new Set(facts.toolCallResultLinks
    .filter((link) => toolIds.has(link.toolCallId))
    .map((link) => link.id));
  const removedToolResultArtifactIds = new Set(facts.toolResultArtifacts
    .filter((artifact) => facts.toolCallResultLinks.some((link) => link.artifactId === artifact.id && removedToolResultLinkIds.has(link.id))
      && !facts.toolCallResultLinks.some((link) => link.artifactId === artifact.id && !removedToolResultLinkIds.has(link.id)))
    .map((artifact) => artifact.id));
  const affectedRunIds = new Set<RunId>();
  const independentlyAffectedRunIds = new Set<RunId>();
  for (const link of facts.messageTurnLinks) {
    if (!removedMessageIds.has(link.messageId)) continue;
    affectedRunIds.add(link.turnId);
    independentlyAffectedRunIds.add(link.turnId);
  }
  for (const link of facts.toolRunLinks) {
    if (!toolIds.has(link.toolCallId)) continue;
    affectedRunIds.add(link.runId);
    independentlyAffectedRunIds.add(link.runId);
  }
  for (const request of facts.requests) {
    if (!request.modelMessageId || !removedMessageIds.has(request.modelMessageId)) continue;
    affectedRunIds.add(request.runId);
    independentlyAffectedRunIds.add(request.runId);
  }
  for (const source of facts.runSources) {
    if (source.sourceMessageId && removedMessageIds.has(source.sourceMessageId)) affectedRunIds.add(source.runId);
    if (source.sourceToolCallId && toolIds.has(source.sourceToolCallId)) affectedRunIds.add(source.runId);
  }
  const detachableBackgroundRuns = new Set((terminationPolicy === 'full_tree_stop' ? [] : facts.childTurnLinks)
    .filter((child) => child.mode === 'background'
      && affectedRunIds.has(child.parentTurnId)
      && affectedRunIds.has(child.childTurnId)
      && !independentlyAffectedRunIds.has(child.childTurnId))
    .map((child) => child.childTurnId));
  const destructiveRunIds = new Set([...affectedRunIds].filter((runId) => !detachableBackgroundRuns.has(runId)));
  for (const runId of additionalRootRunIds) {
    if (!facts.turns.some((run) => run.id === runId && run.conversationId === conversationId)) continue;
    affectedRunIds.add(runId);
    destructiveRunIds.add(runId);
  }
  const activeRoots = [...destructiveRunIds]
    .filter((runId) => facts.turns.some((run) => run.id === runId && run.phase !== 'terminal'));
  const detachedRunIds = new Set<RunId>(detachableBackgroundRuns);
  const newlyTerminatedStreamEpochs: Array<{
    requestId: string;
    invocationId: string;
    operationId: string;
    attemptId: string;
  }> = [];
  if (activeRoots.length > 0) {
    const termination = planTerminateRunGraph(facts, {
      rootRunIds: activeRoots,
      termination: { kind: 'cancelled', actor: 'user', reasonCode: 'message_deleted' },
      ...runGraphCascadeForPolicy(terminationPolicy)
    });
    const cancelledOperationIds = new Set(termination.cancelledOperationIds);
    const invalidatedAttemptIds = new Set(termination.invalidatedAttemptIds);
    for (const request of facts.requests.filter((candidate) => cancelledOperationIds.has(candidate.operationId))) {
      const attempt = facts.attempts.find((candidate) => candidate.operationId === request.operationId
        && invalidatedAttemptIds.has(candidate.id));
      if (!attempt) continue;
      newlyTerminatedStreamEpochs.push({
        requestId: request.id,
        invocationId: request.invocationId,
        operationId: request.operationId,
        attemptId: attempt.id
      });
    }
    appendTerminateRunGraphMutations(builder, facts, termination, now, {
      detachModelMessageRequestIds: facts.requests
        .filter((request) => request.modelMessageId !== undefined
          && removedMessageIds.has(request.modelMessageId)
          && cancelledOperationIds.has(request.operationId))
        .map((request) => request.id)
    });
    for (const runId of termination.affectedRunIds) {
      affectedRunIds.add(runId);
      destructiveRunIds.add(runId);
    }
    for (const runId of termination.detachedBackgroundChildRunIds) detachedRunIds.add(runId);
  }

  // First invalidate context sources, then close over every dependent compression block. A removed
  // compression variant may itself invalidate another projection, so this is a small mark phase.
  const directlyAffectedProjectionIds = projectionIdsDependingOnSources(facts, (source) =>
    (source.sourceKind === 'messageRevision' && (removedMessageIds.has(source.messageId as MessageId) || revisionIds.has(source.sourceId)))
    || (source.sourceKind === 'toolCall' && toolIds.has(source.sourceId)));
  const compressionSeeds = new Set(facts.compressionBlockSourceLinks
    .filter((link) => removedMessageIds.has(link.sourceId as MessageId) || revisionIds.has(link.revisionId ?? ''))
    .map((link) => link.blockId));
  for (const link of facts.compressionModelContextProjectionLinks) {
    if (directlyAffectedProjectionIds.has(link.projectionId)) compressionSeeds.add(link.blockId);
  }
  for (const block of facts.compressionBlocks) {
    if (block.anchorMessageId && removedMessageIds.has(block.anchorMessageId as MessageId)) compressionSeeds.add(block.id);
  }
  let compressionBlockIds = collectCompressionBlockDependencyClosure(facts, compressionSeeds);
  let compressionClosureChanged = true;
  while (compressionClosureChanged) {
    compressionClosureChanged = false;
    const removedVariantIds = new Set(facts.compressionContextVariants
      .filter((variant) => compressionBlockIds.has(variant.blockId))
      .map((variant) => variant.id));
    for (const source of facts.modelContextProjectionSourceLinks) {
      if (source.sourceKind !== 'compressionVariant' || !removedVariantIds.has(source.sourceId)) continue;
      if (!directlyAffectedProjectionIds.has(source.projectionId)) {
        directlyAffectedProjectionIds.add(source.projectionId);
        compressionClosureChanged = true;
      }
    }
    for (const link of facts.compressionModelContextProjectionLinks) {
      if (directlyAffectedProjectionIds.has(link.projectionId) && !compressionBlockIds.has(link.blockId)) {
        compressionSeeds.add(link.blockId);
        compressionClosureChanged = true;
      }
    }
    const expanded = collectCompressionBlockDependencyClosure(facts, new Set([...compressionSeeds, ...compressionBlockIds]));
    if ([...expanded].some((blockId) => !compressionBlockIds.has(blockId))) compressionClosureChanged = true;
    compressionBlockIds = expanded;
  }

  // Requests/Invocations are one reciprocal ownership unit. Removing only modelMessageId leaves a
  // completed Request whose input projection is later swept, which is the original retry failure.
  const removedRequestIds = new Set<string>(facts.requests
    .filter((request) => (request.modelMessageId && removedMessageIds.has(request.modelMessageId))
      || (!request.modelMessageId && destructiveRunIds.has(request.runId)))
    .map((request) => request.id));
  for (const link of facts.requestModelContextProjectionLinks) {
    if (directlyAffectedProjectionIds.has(link.projectionId)) removedRequestIds.add(link.requestId);
  }
  const removedInvocationIds = new Set<string>(facts.invocations
    .filter((invocation) => removedRequestIds.has(invocation.requestId))
    .map((invocation) => invocation.id));
  for (const link of facts.compressionBlockLlmInvocationLinks) {
    if (compressionBlockIds.has(link.blockId) && facts.invocations.some((invocation) => invocation.id === link.invocationId)) {
      removedInvocationIds.add(link.invocationId);
    }
  }
  let requestClosureChanged = true;
  while (requestClosureChanged) {
    requestClosureChanged = false;
    for (const request of facts.requests) {
      if (removedInvocationIds.has(request.invocationId) && !removedRequestIds.has(request.id)) {
        removedRequestIds.add(request.id);
        requestClosureChanged = true;
      }
    }
    for (const invocation of facts.invocations) {
      if (removedRequestIds.has(invocation.requestId) && !removedInvocationIds.has(invocation.id)) {
        removedInvocationIds.add(invocation.id);
        requestClosureChanged = true;
      }
    }
  }

  // A fence created above is part of this transaction's post-state and therefore is absent from
  // facts. Keep the smallest terminal ownership closure for every newly fenced epoch that the suffix
  // sweep would otherwise delete. Historical terminal epochs still follow the complete-delete path.
  const retainedTerminalRequestIds = new Set(newlyTerminatedStreamEpochs
    .filter((epoch) => removedRequestIds.has(epoch.requestId))
    .map((epoch) => epoch.requestId));
  const retainedTerminalInvocationIds = new Set(newlyTerminatedStreamEpochs
    .filter((epoch) => retainedTerminalRequestIds.has(epoch.requestId))
    .map((epoch) => epoch.invocationId));
  const retainedTerminalOperationIds = new Set(newlyTerminatedStreamEpochs
    .filter((epoch) => retainedTerminalRequestIds.has(epoch.requestId))
    .map((epoch) => epoch.operationId));
  const retainedTerminalAttemptIds = new Set(newlyTerminatedStreamEpochs
    .filter((epoch) => retainedTerminalRequestIds.has(epoch.requestId))
    .map((epoch) => epoch.attemptId));
  for (const requestId of retainedTerminalRequestIds) removedRequestIds.delete(requestId);
  for (const invocationId of retainedTerminalInvocationIds) removedInvocationIds.delete(invocationId);

  const removedToolExecutionIds = new Set(facts.toolExecutions
    .filter((execution) => toolIds.has(execution.id))
    .map((execution) => execution.id));
  const candidateOperationIds = new Set<string>();
  for (const request of facts.requests) if (removedRequestIds.has(request.id)) candidateOperationIds.add(request.operationId);
  for (const invocation of facts.invocations) if (removedInvocationIds.has(invocation.id)) candidateOperationIds.add(invocation.operationId);
  for (const execution of facts.toolExecutions) if (removedToolExecutionIds.has(execution.id)) candidateOperationIds.add(execution.operationId);
  const protectedOperationIds = new Set<string>();
  for (const request of facts.requests) if (!removedRequestIds.has(request.id)) protectedOperationIds.add(request.operationId);
  for (const invocation of facts.invocations) if (!removedInvocationIds.has(invocation.id)) protectedOperationIds.add(invocation.operationId);
  for (const execution of facts.toolExecutions) if (!removedToolExecutionIds.has(execution.id)) protectedOperationIds.add(execution.operationId);
  for (const pause of facts.pauses) protectedOperationIds.add(pause.operationId);
  const removedOperationIds = new Set([...candidateOperationIds].filter((operationId) => !protectedOperationIds.has(operationId)));
  const removedAttemptIds = new Set(facts.attempts
    .filter((attempt) => removedOperationIds.has(attempt.operationId))
    .map((attempt) => attempt.id));

  // Sweep only projections that lost an owner or have invalid provenance. Shared immutable
  // projections remain when at least one surviving Request/CompressionBlock still owns them.
  const projectionCandidates = new Set(directlyAffectedProjectionIds);
  for (const link of facts.requestModelContextProjectionLinks) {
    if (removedRequestIds.has(link.requestId) || retainedTerminalRequestIds.has(link.requestId)) {
      projectionCandidates.add(link.projectionId);
    }
  }
  for (const link of facts.compressionModelContextProjectionLinks) {
    if (compressionBlockIds.has(link.blockId)) projectionCandidates.add(link.projectionId);
  }
  const removedProjectionIds = new Set<string>();
  for (const projectionId of projectionCandidates) {
    const hasSurvivingRequestOwner = facts.requestModelContextProjectionLinks.some((link) =>
      link.projectionId === projectionId
      && !removedRequestIds.has(link.requestId)
      && !retainedTerminalRequestIds.has(link.requestId));
    const hasSurvivingCompressionOwner = facts.compressionModelContextProjectionLinks.some((link) =>
      link.projectionId === projectionId && !compressionBlockIds.has(link.blockId));
    if (directlyAffectedProjectionIds.has(projectionId) || (!hasSurvivingRequestOwner && !hasSurvivingCompressionOwner)) {
      removedProjectionIds.add(projectionId);
    }
  }

  builder.removeMany('messages', removedMessageIds);
  const removedAttachmentIds = managedAttachmentIdsFromContents([
    ...removedMessages.map((message) => message.content),
    ...removedRevisions.map((revision) => revision.content)
  ]);
  if (removedAttachmentIds.length > 0) builder.cleanupHint({ kind: 'blob_gc', conversationId, ownerId: conversationId });
  builder.removeMany('messageRevisions', revisionIds);
  builder.removeMany('messageCurrentRevisionLinks', facts.messageCurrentRevisionLinks.filter((link) => removedMessageIds.has(link.messageId as MessageId) || revisionIds.has(link.revisionId)).map((link) => link.id));
  builder.removeMany('messageTurnLinks', facts.messageTurnLinks.filter((link) => removedMessageIds.has(link.messageId)).map((link) => link.id));
  builder.removeMany('toolCalls', toolIds);
  builder.removeMany('toolCallEvents', facts.toolCallEvents.filter((event) => toolIds.has(event.toolCallId)).map((event) => event.id));
  builder.removeMany('toolCallResultLinks', removedToolResultLinkIds);
  builder.removeMany('toolResultArtifacts', removedToolResultArtifactIds);
  if (facts.toolResultArtifacts.some((artifact) => removedToolResultArtifactIds.has(artifact.id) && artifact.storageKind === 'blob')) {
    builder.cleanupHint({ kind: 'blob_gc', conversationId, ownerId: conversationId });
  }
  builder.removeMany('toolRunLinks', facts.toolRunLinks.filter((link) => toolIds.has(link.toolCallId)).map((link) => link.id));
  builder.removeMany('toolExecutions', removedToolExecutionIds);
  const removedInteractionOwnerIds = new Set(facts.interactionOwnerLinks
    .filter((owner) => owner.sourceToolCallId && toolIds.has(owner.sourceToolCallId))
    .map((owner) => owner.id));
  const removedInteractionRequestIds = new Set(facts.interactionOwnerLinks
    .filter((owner) => removedInteractionOwnerIds.has(owner.id))
    .map((owner) => owner.interactionRequestId));
  builder.removeMany('interactionResponses', facts.interactionResponses
    .filter((response) => removedInteractionRequestIds.has(response.interactionRequestId))
    .map((response) => response.id));
  builder.removeMany('interactionOwnerLinks', removedInteractionOwnerIds);
  builder.removeMany('interactionRequests', removedInteractionRequestIds);
  builder.removeMany('inputRevisions', facts.inputRevisions.filter((input) => removedMessageIds.has(input.messageId) || revisionIds.has(input.revisionId)).map((input) => input.id));
  builder.removeMany('contextSnapshots', facts.contextSnapshots.filter((snapshot) => revisionIds.has(snapshot.inputRevisionId)).map((snapshot) => snapshot.id));

  for (const source of facts.runSources.filter((candidate) =>
    (candidate.sourceMessageId && removedMessageIds.has(candidate.sourceMessageId))
    || (candidate.sourceToolCallId && toolIds.has(candidate.sourceToolCallId)))) {
    if (detachedRunIds.has(source.runId) && source.sourceRunId) {
      const { sourceMessageId: _sourceMessageId, sourceToolCallId: _sourceToolCallId, ...detachedSource } = source;
      builder.upsert('runSources', { ...detachedSource, sourceKind: 'agentRun' });
    } else {
      builder.remove('runSources', source.id);
    }
  }
  for (const child of facts.childTurnLinks.filter((candidate) => candidate.sourceToolCallId && toolIds.has(candidate.sourceToolCallId))) {
    const { sourceToolCallId: _sourceToolCallId, foregroundDeadlineAt: _foregroundDeadlineAt, ...detachedChild } = child;
    builder.upsert('childTurnLinks', detachedRunIds.has(child.childTurnId)
      ? {
          ...detachedChild,
          mode: 'detached',
          completionPolicy: 'notify_only',
          detachedAt: now,
          detachedReason: 'message_suffix_deleted',
          rowVersion: child.rowVersion + 1
        }
      : { ...detachedChild, rowVersion: child.rowVersion + 1 });
  }

  builder.removeMany('requests', removedRequestIds);
  builder.removeMany('invocations', removedInvocationIds);
  builder.removeMany('requestModelContextProjectionLinks', facts.requestModelContextProjectionLinks
    .filter((link) => removedRequestIds.has(link.requestId)
      || retainedTerminalRequestIds.has(link.requestId)
      || removedProjectionIds.has(link.projectionId))
    .map((link) => link.id));
  builder.removeMany('compressionModelContextProjectionLinks', facts.compressionModelContextProjectionLinks
    .filter((link) => compressionBlockIds.has(link.blockId) || removedProjectionIds.has(link.projectionId))
    .map((link) => link.id));
  builder.removeMany('modelContextProjectionSourceLinks', facts.modelContextProjectionSourceLinks
    .filter((source) => removedProjectionIds.has(source.projectionId))
    .map((source) => source.id));
  builder.removeMany('modelContextProjections', removedProjectionIds);

  builder.removeMany('compressionBlocks', compressionBlockIds);
  builder.removeMany('compressionBlockSourceLinks', facts.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId)).map((link) => link.id));
  builder.removeMany('compressionContextVariants', facts.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId)).map((variant) => variant.id));
  builder.removeMany('compressionBlockLlmInvocationLinks', facts.compressionBlockLlmInvocationLinks
    .filter((link) => compressionBlockIds.has(link.blockId) || removedInvocationIds.has(link.invocationId as typeof facts.invocations[number]['id']))
    .map((link) => link.id));
  builder.removeMany('runCompressionBlockLinks', facts.runCompressionBlockLinks.filter((link) => compressionBlockIds.has(link.blockId)).map((link) => link.id));

  const releasedRuntimeOperationIds = new Set([...removedOperationIds, ...retainedTerminalOperationIds]);
  builder.removeMany('primaryEffects', facts.primaryEffects
    .filter((effect) => releasedRuntimeOperationIds.has(effect.operationId)
      || removedAttemptIds.has(effect.attemptId)
      || retainedTerminalAttemptIds.has(effect.attemptId))
    .map((effect) => effect.effectIntentId));
  builder.removeMany('effectPayloads', facts.effectPayloads
    .filter((payload) => releasedRuntimeOperationIds.has(payload.operationId))
    .map((payload) => payload.id));
  builder.removeMany('attempts', removedAttemptIds);
  builder.removeMany('operationResolutions', facts.operationResolutions
    .filter((resolution) => releasedRuntimeOperationIds.has(resolution.operationId))
    .map((resolution) => resolution.id));
  builder.removeMany('operations', removedOperationIds);

  const checkpointAnchorIds = new Set(facts.checkpointTimelineAnchors
    .filter((anchor) => removedMessageIds.has(anchor.floorMessageId as MessageId)
      || (!!anchor.sourceToolCallId && toolIds.has(anchor.sourceToolCallId)))
    .map((anchor) => anchor.id));
  const checkpointCandidates = new Set(facts.checkpointTimelineAnchors.filter((anchor) => checkpointAnchorIds.has(anchor.id)).map((anchor) => anchor.checkpointId));
  const checkpointIds = new Set([...checkpointCandidates].filter((checkpointId) =>
    !facts.checkpointTimelineAnchors.some((anchor) => anchor.checkpointId === checkpointId && !checkpointAnchorIds.has(anchor.id))));
  builder.removeMany('checkpointTimelineAnchors', checkpointAnchorIds);
  builder.removeMany('checkpoints', facts.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id) && checkpoint.trigger !== 'conversation_initial').map((checkpoint) => checkpoint.id));
  builder.removeMany('streamCheckpointHeads', facts.streamCheckpointHeads
    .filter((head) => removedRequestIds.has(head.requestId) || removedAttemptIds.has(head.attemptId))
    .map((head) => head.id));
  builder.removeMany('terminalStreamFences', facts.terminalStreamFences
    .filter((fence) => removedRequestIds.has(fence.requestId) || removedAttemptIds.has(fence.attemptId))
    .map((fence) => fence.id));
  const invalidRuntimeInboxIds = new Set(facts.runtimeInboxItems
    .filter((item) => {
      if (item.kind !== 'background_process_exited') return false;
      const sourceToolCallId = runtimeInboxSourceToolCallId(item.payload);
      return sourceToolCallId !== undefined && toolIds.has(sourceToolCallId);
    })
    .map((item) => item.id));
  for (const delivery of facts.runtimeDeliveryLinks.filter((candidate) =>
    invalidRuntimeInboxIds.has(candidate.inboxItemId)
    && (candidate.state === 'pending' || candidate.state === 'delivering'))) {
    builder.upsert('runtimeDeliveryLinks', {
      ...delivery,
      state: 'dead_letter',
      error: 'completion_provenance_deleted',
      deadLetterAt: now,
      rowVersion: delivery.rowVersion + 1,
      updatedAt: now
    });
  }
  return { removedMessageIds: [...removedMessageIds], affectedRunIds: [...affectedRunIds] };
}

function appendRestartedRun(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  input: {
    runId: RunId;
    retryOfRunId?: RunId;
    conversationId: ConversationId;
    agentId: string;
    messageId: MessageId;
    revisionId: MessageRevisionId;
    content: MessageContent;
    now: number;
    progressIds: InitialProgressIds;
    sourceTurnId: RunId;
  }
): void {
  const run = {
    id: input.runId,
    conversationId: input.conversationId,
    lifecycle: 'active' as const,
    phase: 'loading_context' as const,
    rowVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {})
  };
  const frozen = inputRevision(input.runId, input.conversationId, input.messageId, input.revisionId, input.content);
  const sourceAuthority = requireTurnAuthoritySnapshot(facts, input.sourceTurnId);
  const authority = cloneAuthority(sourceAuthority.authority);
  if ((authority.agent as { id?: unknown }).id !== input.agentId) {
    throw new Error(`Restart authority Agent differs from target ${input.agentId}.`);
  }
  const authoritySnapshotId = stableIdFromSeed('authoritySnapshot', `turn-restart:${input.runId}:${sourceAuthority.id}`);
  const authorityDerivationLinkId = stableIdFromSeed('relation', `authority-restart:${sourceAuthority.id}:${authoritySnapshotId}`);
  const currentLease = conversationExecutionLease(facts, input.conversationId);
  const lease = replaceExecutionLease(currentLease, {
    conversationId: input.conversationId,
    expectedTurnId: input.sourceTurnId,
    nextTurnId: run.id,
    now: input.now
  });
  builder
    .upsert('turns', run)
    .upsert('runSources', { id: relationId('run-source', run.id), runId: run.id, sourceKind: 'user', sourceConversationId: input.conversationId, sourceMessageId: input.messageId, sourceRunId: input.sourceTurnId })
    .upsert('runTargets', { id: relationId('run-target', run.id, input.agentId, input.conversationId), runId: run.id, agentId: input.agentId, conversationId: input.conversationId, role: 'executor' })
    .upsert('messageTurnLinks', { id: relationId('message-turn', input.messageId, run.id, 'input'), messageId: input.messageId, turnId: run.id, role: 'input' })
    .upsert('inputRevisions', frozen)
    .upsert('authoritySnapshots', {
      id: authoritySnapshotId,
      conversationId: input.conversationId,
      turnId: run.id,
      authority,
      authorityHash: canonicalSha256(authority),
      derivation: 'continuation',
      createdAt: input.now
    })
    .upsert('authorityDerivationLinks', {
      id: authorityDerivationLinkId,
      parentSnapshotId: sourceAuthority.id,
      childSnapshotId: authoritySnapshotId,
      parentTurnId: input.sourceTurnId,
      parentConversationId: input.conversationId,
      childTurnId: run.id,
      childConversationId: input.conversationId,
      overrideDigest: canonicalSha256({ kind: 'turn_restart', sourceTurnId: input.sourceTurnId, childTurnId: run.id }),
      relation: 'equal',
      createdAt: input.now
    })
    .upsert('executionLeases', lease);
  appendRunContextPolicy(builder, run.id, input.conversationId);
  appendInitialProgress(builder, input.progressIds, run.id, input.conversationId, input.revisionId, frozen.contentHash, input.now, authority.executionPolicy);
}

export function appendInitialProgress(
  builder: ConversationTransitionBuilder,
  ids: InitialProgressIds,
  runId: RunId,
  conversationId: ConversationId,
  revisionId: MessageRevisionId,
  contentHash: string,
  now: number,
  policy: JsonValue
): void {
  const timeout = operationPolicy(policy);
  const operation: OperationRecord = {
    id: ids.operationId,
    conversationId,
    ownerRunId: runId,
    kind: 'context.load',
    state: 'running',
    currentGeneration: 1,
    rowVersion: 1,
    timeoutPolicy: timeout.timeoutPolicy,
    createdAt: now,
    updatedAt: now
  };
  const attempt: AttemptRecord = {
    id: ids.attemptId,
    operationId: operation.id,
    conversationId,
    ownerRunId: runId,
    generation: 1,
    state: 'pending',
    deadlineAt: now + timeout.deadlineMs,
    rowVersion: 1
  };
  const effectPayload = { conversationId, runId, revisionId, inputContentHash: contentHash };
  const effectPayloadHash = canonicalSha256(effectPayload);
  const effectPayloadId = `effect-payload:${operation.id}:1`;
  const effect: PrimaryEffectDescriptor = {
    effectIntentId: ids.effectIntentId,
    conversationId,
    ownerRunId: runId,
    operationId: operation.id,
    attemptId: attempt.id,
    generation: attempt.generation,
    kind: operation.kind,
    idempotencyKey: `${operation.id}:1`,
    recoveryPolicy: 'resume_pending_if_safe',
    deadlineAt: attempt.deadlineAt,
    payloadRef: { kind: 'record', id: effectPayloadId, hash: effectPayloadHash }
  };
  builder
    .generatedId(ids.operationId, ids.attemptId, ids.effectIntentId)
    .upsert('operations', operation)
    .upsert('attempts', attempt)
    .upsert('primaryEffects', { id: effect.effectIntentId, ...effect })
    .upsert('effectPayloads', { id: effectPayloadId, conversationId, ownerRunId: runId, operationId: operation.id, kind: operation.kind, payload: effectPayload, payloadHash: effectPayloadHash, createdAt: now })
    .primaryEffect(effect);
}

function operationPolicy(policy: JsonValue): { deadlineMs: number; timeoutPolicy: OperationRecord['timeoutPolicy'] } {
  if (!policy || Array.isArray(policy) || typeof policy !== 'object') throw new Error('Planning policy snapshot is incomplete.');
  const deadlineMs = policy.contextDeadlineMs;
  const timeoutPolicy = policy.contextTimeoutPolicy;
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new Error('Planning policy has no valid contextDeadlineMs.');
  if (timeoutPolicy !== 'retry_if_safe' && timeoutPolicy !== 'fail_run' && timeoutPolicy !== 'interrupt_run') {
    throw new Error('Planning policy has no valid contextTimeoutPolicy.');
  }
  return { deadlineMs, timeoutPolicy };
}

export function createBuilder(
  view: DurableAggregateView<DurableConversationFacts>,
  command: CommandEnvelope<JsonValue>,
  transitionId: TransitionId
): ConversationTransitionBuilder {
  return new ConversationTransitionBuilder({
    transitionId,
    commandId: command.commandId,
    scopes: view.scopes,
    baseVersions: view.baseVersions,
    streamHeads: new Map([...view.storageHeads.values()]
      .filter((head): head is typeof head & { conversationId: ConversationId } => head.headKind === 'conversation-control' && !!head.conversationId)
      .map((head) => [head.conversationId, { streamId: `conversation:${head.conversationId}:state`, nextSeq: head.streamNextSeq }]))
  });
}

export function fullConversationView(kind: string, conversationId: ConversationId): DurableViewSpec<DurableConversationFacts> {
  return {
    kind,
    conversations: [conversationId],
    timeline: [{ conversationId, throughTail: true }],
    relationFamilies: [...DURABLE_CONVERSATION_RECORD_FAMILIES],
    storageResourceKeys: [
      ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
      CONVERSATION_ATTACHMENTS_RESOURCE_KEY
    ]
  };
}

function validateConversationPayload(view: DurableAggregateView<DurableConversationFacts>, conversationId: ConversationId): CommandRejection | undefined {
  if (view.facts.conversation.id !== conversationId || !view.scopes.includes(conversationId)) return rejection('not_found', `Conversation not found: ${conversationId}`);
  if (view.facts.conversation.visibility === 'hidden') return rejection('invalid_state', 'Conversation has been deleted.');
  return undefined;
}

function validateMessageContent(content: MessageContent | undefined): CommandRejection | undefined {
  if (!content || content.role !== 'user' || !Array.isArray(content.parts) || content.parts.length === 0) return rejection('invalid_state', 'User message content cannot be empty.');
  return undefined;
}

function rejection(code: CommandRejection['code'], message: string): CommandRejection { return { status: 'rejected', code, message }; }

function cloneContent(content: MessageContent): MessageContent {
  return JSON.parse(JSON.stringify(content)) as MessageContent;
}

function createdRevision(id: MessageRevisionId, message: MessageRecord, now: number): MessageRevisionRecord {
  return { id, messageId: message.id, conversationId: message.conversationId, content: cloneContent(message.content), createdAt: now, reason: 'created' };
}

export function inputRevision(runId: RunId, conversationId: ConversationId, messageId: MessageId, revisionId: MessageRevisionId, content: MessageContent): RunInputRevisionFactRecord {
  return { id: relationId('run-input', runId, revisionId), runId, conversationId, messageId, revisionId, contentHash: canonicalSha256(content) };
}

export function nextMessageSeq(facts: DurableConversationFacts): number {
  return facts.messages.reduce((max, message) => Math.max(max, message.seq), 0) + 1;
}

export function nextQueueOrder(facts: DurableConversationFacts): number {
  return facts.turnIntents.reduce((max, intent) => Math.max(max, intent.order), 0) + 1_000;
}

function requireTurnAuthoritySnapshot(facts: DurableConversationFacts, turnId: RunId) {
  const snapshots = facts.authoritySnapshots.filter((snapshot) => snapshot.turnId === turnId);
  if (snapshots.length !== 1) throw new Error(`Turn ${turnId} has ${snapshots.length} AuthoritySnapshots; expected exactly one.`);
  const snapshot = snapshots[0];
  if (canonicalSha256(snapshot.authority) !== snapshot.authorityHash) {
    throw new Error(`Turn ${turnId} AuthoritySnapshot hash is invalid.`);
  }
  return snapshot;
}

function cloneAuthority(authority: EffectiveTurnAuthority): EffectiveTurnAuthority {
  return JSON.parse(JSON.stringify(authority)) as EffectiveTurnAuthority;
}

function uniqueRecord<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  return uniqueMatchingRecord(records, (record) => record.id === id, `${label} ${id}`);
}

function uniqueMatchingRecord<T>(records: readonly T[], matches: (record: T) => boolean, label: string): T | undefined {
  const found = records.filter(matches);
  if (found.length > 1) throw new Error(`${label} is not unique.`);
  return found[0];
}

export function relationId(kind: string, ...parts: string[]): string { return `${kind}:${parts.join(':')}`; }

function runtimeInboxSourceToolCallId(payload: JsonValue): ToolCallId | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const sourceToolCallId = (payload as Record<string, JsonValue>).sourceToolCallId;
  return typeof sourceToolCallId === 'string' ? sourceToolCallId as ToolCallId : undefined;
}

function normalizedDeleteBoundary(facts: DurableConversationFacts, messageId: MessageId): MessageRecord | undefined {
  const message = uniqueRecord(facts.messages, messageId, 'Message');
  if (!message) return undefined;
  const response = message.content.parts.find((part) => 'functionResponse' in part);
  if (!response || !('functionResponse' in response)) return message;
  const responseId = response.id?.trim();
  const responseName = response.functionResponse.name;
  return [...facts.messages]
    .filter((candidate) => candidate.seq < message.seq)
    .sort((left, right) => right.seq - left.seq)
    .find((candidate) => candidate.content.parts.some((part) => 'functionCall' in part && (responseId ? part.id === responseId : part.functionCall.name === responseName))) ?? message;
}

function latestInputForRun(facts: DurableConversationFacts, runId: RunId): RunInputRevisionFactRecord | undefined {
  const inputs = facts.inputRevisions.filter((input) => input.runId === runId);
  if (inputs.length === 0) return undefined;
  return inputs[inputs.length - 1];
}

function targetForSourceMessage(facts: DurableConversationFacts, messageId: MessageId) {
  const runIds = facts.messageTurnLinks.filter((link) => link.messageId === messageId && link.role === 'input').map((link) => link.turnId);
  return facts.runTargets.find((target) => runIds.includes(target.runId));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size && right.length === new Set(right).size && left.length === right.length && left.every((item) => right.includes(item));
}

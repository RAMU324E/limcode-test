import {
  ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
  type CommandPlanningContext,
  type DurableAggregateView,
  type DurableViewSpec,
  type InternalCommandEnvelope,
  type InternalCommandHandler,
  type InternalCommandNoop,
  type JsonValue,
  type TransitionPlan
} from '../../../shared/conversationReliability';
import { isFunctionResponsePart, TERMINAL_TOOL_CALL_STATUSES } from '../../../shared/protocol';
import type { ConversationId } from '../../../shared/stableIds';
import { stableIdFromSeed } from '../stableIdFactory';
import { conversationControlHeadKey } from '../storagePathAuthority';
import { ConversationTransitionBuilder, asJson } from './transitionBuilder';
import { appendBoundedInlineToolResult } from './toolResultArtifacts';
import type { DurableConversationFacts, MultiConversationDurableFacts } from './types';

export interface CreateConversationPayload {
  conversationId: ConversationId;
  title?: string;
}

export class CreateConversationHandler implements InternalCommandHandler<JsonValue, DurableConversationFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<DurableConversationFacts> {
    const payload = command.payload as unknown as CreateConversationPayload;
    return {
      kind: 'conversation.create',
      conversations: [payload.conversationId],
      createMissingConversations: [payload.conversationId],
      timeline: [{ conversationId: payload.conversationId, throughTail: true }],
      relationFamilies: ['conversation'],
      storageResourceKeys: [ANSWER_BRIDGE_LINKS_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY]
    };
  }

  public plan(
    view: DurableAggregateView<DurableConversationFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = command.payload as unknown as CreateConversationPayload;
    if (view.scopes.length !== 1 || view.scopes[0] !== payload.conversationId || view.facts.conversation.id !== payload.conversationId) {
      throw new Error(`Conversation creation scope is invalid: ${payload.conversationId}`);
    }
    if (view.baseVersions.get(payload.conversationId) !== 0) {
      throw new Error(`Conversation already has committed authority: ${payload.conversationId}`);
    }
    const controlHead = [...view.storageHeads.values()].find((head) =>
      head.headKind === 'conversation-control' && head.conversationId === payload.conversationId);
    if (!controlHead || controlHead.generation !== 0) {
      throw new Error(`Conversation creation requires a genesis control HEAD: ${payload.conversationId}`);
    }
    const builder = new ConversationTransitionBuilder({
      transitionId: context.transitionId,
      scopes: view.scopes,
      baseVersions: view.baseVersions,
      streamHeads: new Map([[payload.conversationId, {
        streamId: `conversation:${payload.conversationId}:state`,
        nextSeq: controlHead.streamNextSeq
      }]])
    });
    builder.upsert('conversation', {
      id: payload.conversationId,
      ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
      visibility: 'visible',
      createdAt: context.now,
      lastActivityAt: context.now
    });
    builder.patch(payload.conversationId, {
      kind: 'conversation.created',
      conversationId: payload.conversationId
    });
    return builder.build(asJson({ conversationId: payload.conversationId }));
  }
}

export interface ForkConversationPayload {
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  throughMessageId: string;
}

/** Creates the target aggregate from a closed source timeline view; no live ECS state is compiled. */
export class ForkConversationHandler implements InternalCommandHandler<JsonValue, MultiConversationDurableFacts, JsonValue> {
  public requiredView(command: InternalCommandEnvelope<JsonValue>): DurableViewSpec<MultiConversationDurableFacts> {
    const payload = command.payload as unknown as ForkConversationPayload;
    return {
      kind: 'conversation.fork',
      conversations: [payload.sourceConversationId, payload.targetConversationId],
      createMissingConversations: [payload.targetConversationId],
      timeline: [
        { conversationId: payload.sourceConversationId, throughTail: true },
        { conversationId: payload.targetConversationId, throughTail: true }
      ],
      relationFamilies: ['conversation', 'message', 'tool'],
      storageResourceKeys: [ANSWER_BRIDGE_LINKS_RESOURCE_KEY, CONVERSATION_ATTACHMENTS_RESOURCE_KEY]
    };
  }

  public plan(
    view: DurableAggregateView<MultiConversationDurableFacts>,
    command: InternalCommandEnvelope<JsonValue>,
    context: CommandPlanningContext
  ): TransitionPlan<JsonValue> | InternalCommandNoop<JsonValue> {
    const payload = command.payload as unknown as ForkConversationPayload;
    if (payload.sourceConversationId === payload.targetConversationId) {
      throw new Error('Fork target must be a new Conversation.');
    }
    const source = view.facts.byConversation[payload.sourceConversationId];
    const target = view.facts.byConversation[payload.targetConversationId];
    if (!source || source.conversation.id !== payload.sourceConversationId) {
      throw new Error(`Fork source is outside the leased durable view: ${payload.sourceConversationId}`);
    }
    if (!target || target.conversation.id !== payload.targetConversationId) {
      throw new Error(`Fork target is outside the leased durable view: ${payload.targetConversationId}`);
    }
    const targetControlHead = view.storageHeads.get(conversationControlHeadKey(payload.targetConversationId));
    if (view.baseVersions.get(payload.targetConversationId) !== 0
      || targetControlHead?.headKind !== 'conversation-control'
      || targetControlHead.generation !== 0
      || durableRecordCount(target) !== 0) {
      throw new Error(`Fork target already has committed durable facts: ${payload.targetConversationId}`);
    }

    const orderedMessages = [...source.messages].sort((left, right) =>
      left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const boundaryIndex = orderedMessages.findIndex((message) => message.id === payload.throughMessageId);
    if (boundaryIndex < 0) throw new Error(`Fork boundary Message is missing: ${payload.throughMessageId}`);
    const boundary = orderedMessages[boundaryIndex];
    if (boundary.status === 'streaming' || boundary.status === 'partial') {
      throw new Error('Fork boundary must be a completed Message.');
    }
    let endExclusive = boundaryIndex + 1;
    while (endExclusive < orderedMessages.length
      && orderedMessages[endExclusive].content.parts.some(isFunctionResponsePart)) {
      endExclusive += 1;
    }
    const messages = orderedMessages.slice(0, endExclusive);
    if (messages.length === 0) throw new Error('Fork source has no Messages through its boundary.');

    const builder = new ConversationTransitionBuilder({
      transitionId: context.transitionId,
      scopes: view.scopes,
      baseVersions: view.baseVersions,
      streamHeads: new Map(view.scopes.map((conversationId) => {
        const head = view.storageHeads.get(conversationControlHeadKey(conversationId));
        if (!head || head.headKind !== 'conversation-control') {
          throw new Error(`Fork requires a conversation control HEAD: ${conversationId}`);
        }
        return [conversationId, {
          streamId: `conversation:${conversationId}:state`,
          nextSeq: head.streamNextSeq
        }];
      }))
    });
    builder.upsert('conversation', {
      id: payload.targetConversationId,
      ...(source.conversation.title ? { title: source.conversation.title } : {}),
      visibility: 'visible',
      createdAt: context.now,
      lastActivityAt: context.now
    });

    const messageIds = new Map<string, string>();
    for (const sourceMessage of messages) {
      const id = stableIdFromSeed('message', `${context.transitionId}:fork-message:${sourceMessage.id}`);
      messageIds.set(sourceMessage.id, id);
      builder.generatedId(id);
      builder.upsert('messages', {
        ...cloneRecord(sourceMessage),
        id,
        conversationId: payload.targetConversationId
      });
    }

    const selectedMessageIds = new Set(messageIds.keys());
    const revisionIds = new Map<string, string>();
    for (const sourceRevision of source.messageRevisions
      .filter((revision) => selectedMessageIds.has(revision.messageId))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const id = stableIdFromSeed('messageRevision', `${context.transitionId}:fork-revision:${sourceRevision.id}`);
      const messageId = messageIds.get(sourceRevision.messageId)!;
      revisionIds.set(sourceRevision.id, id);
      builder.generatedId(id);
      builder.upsert('messageRevisions', {
        ...cloneRecord(sourceRevision),
        id,
        messageId,
        conversationId: payload.targetConversationId
      });
    }

    for (const sourceLink of source.messageCurrentRevisionLinks
      .filter((link) => selectedMessageIds.has(link.messageId))
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const messageId = messageIds.get(sourceLink.messageId);
      const revisionId = revisionIds.get(sourceLink.revisionId);
      if (!messageId || !revisionId) throw new Error(`Fork Message current revision is incomplete: ${sourceLink.messageId}`);
      const id = stableIdFromSeed('relation', `${context.transitionId}:fork-current-revision:${sourceLink.id}`);
      builder.generatedId(id);
      builder.upsert('messageCurrentRevisionLinks', { id, messageId, revisionId });
    }

    const toolCallIds = new Map<string, string>();
    const forkedTools = new Map<string, DurableConversationFacts['toolCalls'][number]>();
    const nonterminalSourceToolIds = new Set<string>();
    for (const sourceTool of source.toolCalls
      .filter((tool) => selectedMessageIds.has(tool.messageId))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const id = stableIdFromSeed('toolCall', `${context.transitionId}:fork-tool:${sourceTool.id}`);
      const messageId = messageIds.get(sourceTool.messageId)!;
      const terminal = TERMINAL_TOOL_CALL_STATUSES.has(sourceTool.status);
      const forkError = sourceTool.error ?? 'Fork stopped a non-terminal historical ToolCall.';
      const forkedTool: DurableConversationFacts['toolCalls'][number] = {
        ...cloneRecord(sourceTool),
        id,
        messageId,
        ...(!terminal ? {
          status: 'error',
          updatedAt: context.now,
          error: forkError
        } : {})
      };
      toolCallIds.set(sourceTool.id, id);
      forkedTools.set(sourceTool.id, forkedTool);
      if (!terminal) nonterminalSourceToolIds.add(sourceTool.id);
      builder.generatedId(id);
      builder.upsert('toolCalls', forkedTool);
    }

    const artifactIds = new Map<string, string>();
    for (const sourceLink of source.toolCallResultLinks
      .filter((link) => toolCallIds.has(link.toolCallId) && !(nonterminalSourceToolIds.has(link.toolCallId) && link.role === 'final'))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))) {
      const sourceArtifact = source.toolResultArtifacts.find((artifact) => artifact.id === sourceLink.artifactId);
      if (!sourceArtifact) throw new Error(`Fork ToolResultLink has no Artifact: ${sourceLink.id}`);
      let artifactId = artifactIds.get(sourceArtifact.id);
      if (!artifactId) {
        artifactId = stableIdFromSeed('toolResultArtifact', `${context.transitionId}:fork-tool-result-artifact:${sourceArtifact.id}`);
        artifactIds.set(sourceArtifact.id, artifactId);
        builder.generatedId(artifactId);
        builder.upsert('toolResultArtifacts', {
          ...cloneRecord(sourceArtifact),
          id: artifactId,
          conversationId: payload.targetConversationId
        });
      }
      const id = stableIdFromSeed('relation', `${context.transitionId}:fork-tool-result-link:${sourceLink.id}`);
      builder.generatedId(id);
      builder.upsert('toolCallResultLinks', {
        ...cloneRecord(sourceLink),
        id,
        conversationId: payload.targetConversationId,
        toolCallId: toolCallIds.get(sourceLink.toolCallId)!,
        artifactId
      });
    }

    for (const sourceToolId of nonterminalSourceToolIds) {
      const forkedTool = forkedTools.get(sourceToolId)!;
      const error = forkedTool.error ?? 'Fork stopped a non-terminal historical ToolCall.';
      appendBoundedInlineToolResult(builder, {
        conversationId: payload.targetConversationId,
        tool: forkedTool,
        status: 'error',
        result: asJson({ interrupted: true, error, reason: 'conversation_fork' }),
        now: context.now,
        error
      });
    }

    for (const sourceTool of source.toolCalls.filter((tool) => toolCallIds.has(tool.id) && TERMINAL_TOOL_CALL_STATUSES.has(tool.status))) {
      const finalLinks = source.toolCallResultLinks.filter((link) => link.toolCallId === sourceTool.id && link.role === 'final');
      if (finalLinks.length !== 1) throw new Error(`Fork terminal ToolCall ${sourceTool.id} has ${finalLinks.length} final result links.`);
    }

    for (const sourceEvent of source.toolCallEvents
      .filter((event) => toolCallIds.has(event.toolCallId))
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))) {
      const id = stableIdFromSeed('toolCallEvent', `${context.transitionId}:fork-tool-event:${sourceEvent.id}`);
      builder.generatedId(id);
      builder.upsert('toolCallEvents', {
        ...cloneRecord(sourceEvent),
        id,
        toolCallId: toolCallIds.get(sourceEvent.toolCallId)!
      });
    }

    builder.patch(payload.sourceConversationId, {
      kind: 'conversation.fork_source_committed',
      sourceConversationId: payload.sourceConversationId,
      targetConversationId: payload.targetConversationId,
      throughMessageId: payload.throughMessageId
    });
    builder.patch(payload.targetConversationId, {
      kind: 'conversation.fork_created',
      sourceConversationId: payload.sourceConversationId,
      targetConversationId: payload.targetConversationId,
      throughMessageId: payload.throughMessageId
    });
    return builder.build(asJson({
      conversationId: payload.targetConversationId,
      copiedMessageCount: messages.length
    }));
  }
}

function durableRecordCount(facts: DurableConversationFacts): number {
  return Object.entries(facts).reduce((count, [family, records]) =>
    family === 'conversation' || !Array.isArray(records) ? count : count + records.length, 0);
}

function cloneRecord<TRecord>(record: TRecord): TRecord {
  return JSON.parse(JSON.stringify(record)) as TRecord;
}

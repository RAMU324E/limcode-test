import { computed, watch, type ComputedRef } from 'vue';
import type { MessageContent } from '@shared/protocol';
import {
  reliableActiveConversationId,
  type ReliableClientRecordBuckets,
  type ReliableConversationProjection
} from '@webview/domain/reliableConversationProjection';
import { ReliableConversationProjector } from '@webview/domain/reliableConversationProjector';
import {
  useReliableKernelClientFeedStore,
  type ReliableKernelDetailPriority
} from '@webview/stores/useReliableKernelClientFeedStore';
import { steeringReceiptsByConversationState } from '@webview/composables/steeringReceipts';

export interface ReliableDetailDemand {
  /** Timeline rows currently mounted (or about to enter the viewport). */
  messageIds?: readonly string[];
  /** Tool cards explicitly expanded/opened outside the timeline. */
  toolCallIds?: readonly string[];
  priority?: ReliableKernelDetailPriority;
  /** Pending mandatory interactions are always critical unless explicitly disabled. */
  includePendingInteractions?: boolean;
}

interface SharedReliableConversation {
  feed: ReturnType<typeof useReliableKernelClientFeedStore>;
  conversationId: ComputedRef<string>;
  projection: ComputedRef<ReliableConversationProjection>;
  ensureDetails(demand?: ReliableDetailDemand): void;
  completeMessageContent(messageId: string): Promise<MessageContent>;
}

const sharedByFeed = new WeakMap<object, SharedReliableConversation>();
let nextCopyOwner = 0;

function messageContentSourceId(projection: ReliableConversationProjection, messageId: string): string {
  return projection.splitSourceMessageIdByMessageId[messageId] ?? messageId;
}

/**
 * One shared projection per Pinia feed instance. Previously every card/composer/panel created its
 * own full computed scan, turning N mounted cards into N whole-conversation projections.
 */
export function useReliableConversation(): SharedReliableConversation {
  const feed = useReliableKernelClientFeedStore();
  const cached = sharedByFeed.get(feed);
  if (cached) return cached;

  const conversationId = computed(() => reliableActiveConversationId(feed.projections));
  const projector = new ReliableConversationProjector();
  // Observe the demanded cache entries and window membership. Missing historical keys must not
  // become thousands of Vue dependencies merely because a streamed tail can read this projection.
  const projectionDetails = computed(() => ({ ...feed.details }));
  const projectionWindows = computed(() => ({ ...feed.messageContentWindows }));
  const committed = computed(() => projector.projectCommitted({
    conversationId: conversationId.value,
    records: feed.committedRecords as unknown as ReliableClientRecordBuckets,
    details: projectionDetails.value,
    messageContentWindows: projectionWindows.value,
    steeringReceipts: Object.values(steeringReceiptsByConversationState().value[conversationId.value] ?? {})
  }));
  const projection = computed(() => {
    committed.value;
    return projector.projectTransient({
    transientModelRequests: feed.transientModelRequests,
    lastCommitSeq: feed.lastCommitSeq,
    lastSnapshotCommitSeq: feed.lastSnapshotCommitSeq
    });
  });

  function ensureDetails(demand: ReliableDetailDemand = {}): void {
    const current = projection.value;
    const priority = demand.priority ?? 'visible';
    const missingPrompts = new Set(current.missingInteractionPromptIds);
    const missingArguments = new Set(current.missingToolArgumentIds);
    const missingResults = new Set(current.missingToolResultIds);
    const missingEvents = new Set(current.missingToolEventIds);
    const missingDiffs = new Set(current.missingFileDiffMemberIds);
    const messageIds = new Set(demand.messageIds ?? []);
    const explicitlyDemandedCallIds = new Set(demand.toolCallIds ?? []);
    const toolCallIds = new Set(explicitlyDemandedCallIds);
    for (const messageId of messageIds) {
      for (const call of current.toolCallsByMessageId[messageId] ?? []) toolCallIds.add(call.id);
      const sourceId = messageContentSourceId(current, messageId);
      if (current.messageRevisionIdByMessageId[sourceId]) feed.ensureMessageContent(sourceId, priority);
    }

    const criticalCallIds = new Set<string>();
    if (demand.includePendingInteractions !== false) {
      for (const [toolCallId, interaction] of Object.entries(current.interactionByToolCallId)) {
        if (interaction.status !== 'pending') continue;
        criticalCallIds.add(toolCallId);
        toolCallIds.add(toolCallId);
      }
    }

    for (const toolCallId of toolCallIds) {
      const callPriority: ReliableKernelDetailPriority = criticalCallIds.has(toolCallId) ? 'critical' : priority;
      const hydrateBody = criticalCallIds.has(toolCallId) || explicitlyDemandedCallIds.has(toolCallId);
      const promptId = current.interactionPromptIdByToolCallId[toolCallId];
      if (promptId && missingPrompts.has(promptId)) {
        feed.requestDetail('interaction-prompt', promptId, { priority: callPriority });
      }
      if (hydrateBody) {
        if (missingArguments.has(toolCallId)) {
          feed.requestDetail('tool-arguments-content', toolCallId, { priority: callPriority });
        }
        if (missingResults.has(toolCallId)) {
          feed.requestDetail('tool-result-content', toolCallId, { priority: callPriority });
        }
      }
      for (const eventId of current.toolEventIdsByCallId[toolCallId] ?? []) {
        if (missingEvents.has(eventId)) {
          feed.requestDetail('tool-event-content', eventId, { priority: callPriority });
        }
      }
      for (const memberId of hydrateBody ? current.fileDiffMemberIdsByToolCallId[toolCallId] ?? [] : []) {
        if (missingDiffs.has(memberId)) {
          feed.requestDetail('file-change-diff', memberId, { priority: callPriority });
        }
      }
    }
  }

  async function completeMessageContent(messageId: string): Promise<MessageContent> {
    const current = projection.value;
    const sourceId = messageContentSourceId(current, messageId);
    const revisionId = current.messageRevisionIdByMessageId[sourceId];
    const source = current.index.messageById.get(messageId);
    if (!revisionId) {
      if (source) return source.content;
      throw new Error('消息已离开当前阅读窗口。');
    }
    const key = `message-content:${revisionId}`;
    const owner = `message-copy:${++nextCopyOwner}`;
    const sessionId = feed.sessionId;
    const readProjection = projector.prepareCompleteMessageContent(messageId, sourceId);
    feed.setDetailOwnerKeys(owner, [key]);
    try {
      if (!feed.requestDetail('message-content', revisionId, { priority: 'expanded' })) throw new Error('读取完整消息的连接不可用。');
      if (feed.details[key]?.status === 'error') throw new Error(feed.details[key]?.error ?? '读取完整消息失败。');
      if (feed.details[key]?.status !== 'ready') await new Promise<void>((resolve, reject) => {
        const stop = watch(() => [feed.details[key]?.status, feed.sessionId], () => {
          const detail = feed.details[key];
          if (feed.sessionId !== sessionId || detail?.status === 'error') {
            stop(); reject(new Error(detail?.error ?? '读取完整消息时连接已改变。'));
          } else if (detail?.status === 'ready') { stop(); resolve(); }
        });
      });
      const content = readProjection(feed.details);
      if (!content) throw new Error('完整消息暂不可用，请重试。');
      return content;
    } finally {
      feed.setDetailOwnerKeys(owner, []);
      if (current.contentWindowByMessageId[sourceId]) feed.releaseDetails([key]);
    }
  }

  const shared = { feed, conversationId, projection, ensureDetails, completeMessageContent };
  sharedByFeed.set(feed, shared);
  return shared;
}

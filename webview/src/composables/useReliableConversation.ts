import { computed } from 'vue';
import {
  projectReliableConversation,
  reliableActiveConversationId,
  type ReliableClientRecordBuckets
} from '@webview/domain/reliableConversationProjection';
import { useReliableKernelClientFeedStore } from '@webview/stores/useReliableKernelClientFeedStore';

/** View-only composition of independent reliable Runtime records. */
export function useReliableConversation() {
  const feed = useReliableKernelClientFeedStore();
  const conversationId = computed(() => reliableActiveConversationId(feed.projections));
  const projection = computed(() => projectReliableConversation({
    conversationId: conversationId.value,
    records: feed.records as unknown as ReliableClientRecordBuckets,
    details: feed.details,
    transientModelRequests: feed.transientModelRequests
  }));

  function ensureDetails(): void {
    for (const revisionId of projection.value.loadingMessageRevisionIds) {
      feed.requestDetail('message-content', revisionId);
    }
    for (const toolCallId of projection.value.missingToolArgumentIds) {
      feed.requestDetail('tool-arguments-content', toolCallId);
    }
    for (const toolCallId of projection.value.missingToolResultIds) {
      feed.requestDetail('tool-result-content', toolCallId);
    }
    for (const memberId of projection.value.missingFileDiffMemberIds) {
      feed.requestDetail('file-change-diff', memberId);
    }
  }

  return { feed, conversationId, projection, ensureDetails };
}

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MessageRecord } from '@shared/protocol';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import MessageItem from './MessageItem.vue';
import TimelineActivityRow from './TimelineActivityRow.vue';
import {
  TIMELINE_MOUNT_LIMIT,
  TIMELINE_SEGMENT_STEP,
  clampTimelineSegmentStart,
  latestTimelineSegmentStart
} from './segmentedTimeline';

const props = withDefaults(defineProps<{ emptyHint?: string; scroller?: HTMLElement | null }>(), {
  emptyHint: '还没有消息，发一条试试。',
  scroller: null
});
const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord, deleteCount: number): void;
}>();
const { feed, conversationId, projection, ensureDetails } = useReliableConversation();
const { retryMessageFrom, deleteMessagesFrom, forkConversationFrom } = useChat();
const messages = computed(() => projection.value.messages);
const segmentStart = ref(0);
const visibleTimelineRows = computed(() => messages.value.slice(
  segmentStart.value,
  segmentStart.value + TIMELINE_MOUNT_LIMIT
));
const hasEarlierSegment = computed(() => segmentStart.value > 0);
const hasLaterSegment = computed(() => segmentStart.value + TIMELINE_MOUNT_LIMIT < messages.value.length);

watch(
  () => messages.value.length,
  (total, previous = 0) => {
    const wasAtLatest = segmentStart.value >= latestTimelineSegmentStart(previous);
    segmentStart.value = wasAtLatest
      ? latestTimelineSegmentStart(total)
      : clampTimelineSegmentStart(total, segmentStart.value);
  },
  { immediate: true }
);

const activityLabel = computed(() => {
  if (!conversationId.value) return undefined;
  const activeTurn = Object.values(feed.records.Turn ?? {}).find((turn) =>
    turn.conversation_id === conversationId.value && turn.status === 'active'
  );
  if (!activeTurn || typeof activeTurn.id !== 'string') return undefined;
  if (messages.value.some((message) => message.id.startsWith('transient:'))) return undefined;
  const activeTool = Object.values(feed.records.ToolCall ?? {}).find((call) =>
    call.turn_id === activeTurn.id && call.status !== 'terminal'
  );
  if (activeTool) return undefined;
  const requests = Object.values(feed.records.ModelRequest ?? {})
    .filter((request) => request.turn_id === activeTurn.id)
    .sort((left, right) => reliableInteger(right.request_seq) - reliableInteger(left.request_seq));
  const latest = requests[0];
  if (!latest) return '正在准备上下文';
  if (latest.status === 'pending') return '正在启动模型请求';
  if (latest.status === 'streaming') return '正在等待模型输出';
  return '正在衔接下一步';
});

watch(
  () => [
    ...projection.value.loadingMessageRevisionIds,
    ...projection.value.missingToolArgumentIds,
    ...projection.value.missingToolResultIds,
    ...projection.value.missingFileDiffMemberIds
  ].join('|'),
  ensureDetails,
  { immediate: true }
);

function deleteCount(message: MessageRecord): number {
  const index = messages.value.findIndex((candidate) => candidate.id === message.id);
  return index < 0 ? 1 : messages.value.length - index;
}

function showEarlierSegment(): void {
  segmentStart.value = clampTimelineSegmentStart(
    messages.value.length,
    segmentStart.value - TIMELINE_SEGMENT_STEP
  );
  props.scroller?.scrollTo({ top: 0 });
}

function showLaterSegment(): void {
  segmentStart.value = clampTimelineSegmentStart(
    messages.value.length,
    segmentStart.value + TIMELINE_SEGMENT_STEP
  );
}

function retryFrom(message: MessageRecord): void {
  retryMessageFrom(message.conversationId, message.id);
}

function deleteFrom(message: MessageRecord): void {
  deleteMessagesFrom(message.conversationId, message.id);
}

function forkFrom(message: MessageRecord): void {
  forkConversationFrom(message.conversationId, message.id);
}

function reliableInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}
</script>

<template>
  <div class="reliable-message-list">
    <button
      v-if="hasEarlierSegment"
      type="button"
      class="reliable-segment-control"
      @click="showEarlierSegment"
    >
      显示更早内容
    </button>
    <div
      v-for="(message, index) in visibleTimelineRows"
      :key="message.id"
      class="reliable-message-row"
      :data-timeline-row-key="message.id"
    >
      <MessageItem
        :message="message"
        :run-id="projection.turnIdByMessageId[message.id]"
        :delete-count="deleteCount(message)"
        :floor-number="segmentStart + index + 1"
        @edit-message="emit('edit-message', message, deleteCount(message))"
        @retry-from="retryFrom"
        @delete-from="deleteFrom"
        @fork-from="forkFrom"
      />
    </div>
    <button
      v-if="hasLaterSegment"
      type="button"
      class="reliable-segment-control"
      @click="showLaterSegment"
    >
      显示较新内容
    </button>
    <TimelineActivityRow
      v-if="activityLabel && !hasLaterSegment"
      activity-kind="preparing"
      :label="activityLabel"
    />
    <div v-if="messages.length === 0 && !activityLabel" class="reliable-message-empty-container">
      <p class="reliable-message-empty">{{ emptyHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.reliable-message-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-anchor: none;
}

.reliable-message-row {
  display: block;
}

.reliable-segment-control {
  align-self: center;
  margin: var(--space-2) 0;
  min-height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.reliable-segment-control:hover,
.reliable-segment-control:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.reliable-message-empty-container {
  padding: var(--space-6) var(--conversation-content-padding-right, var(--space-4))
    var(--space-6) var(--conversation-content-padding-left, var(--space-4));
}

.reliable-message-empty {
  margin: var(--space-6) 0 0;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}
</style>

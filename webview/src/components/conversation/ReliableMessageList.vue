<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MessageRecord, RunTerminationRecord } from '@shared/protocol';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useReliableTimelinePresentationStore } from '@webview/stores/useReliableTimelinePresentationStore';
import { projectReliableCompressionTimeline } from '@webview/domain/reliableCompressionProjection';
import MessageItem from './MessageItem.vue';
import ReliableTurnTerminationRow from './ReliableTurnTerminationRow.vue';
import ReliableCompressionCard from './ReliableCompressionCard.vue';
import TimelineActivityRow from './TimelineActivityRow.vue';
import {
  TIMELINE_MOUNT_LIMIT,
  TIMELINE_SEGMENT_STEP,
  absoluteTimelineFloor,
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
const {
  retryMessageFrom,
  deleteMessagesFrom,
  forkConversationFrom,
  compressContext,
  conversationAction,
  conversationActionPending,
  conversationActionLabel,
  conversationActionNotice,
  forkPendingTargetIds,
  currentAuthoritySelection
} = useChat();
const globalSettings = useGlobalSettingsStore();
const modelProfiles = useModelProfileStore();
const timelinePresentation = useReliableTimelinePresentationStore();
const messages = computed(() => projection.value.messages);
const compressionBlocks = computed(() => Object.values(feed.records.CompressionBlock ?? {})
  .filter((block) => block.conversation_id === conversationId.value && block.status !== 'soft_deleted')
  .filter((block) => !timelinePresentation.isSuppressed(
    conversationId.value,
    'compression-block',
    reliableText(block.id)
  ))
  .sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))));
const segmentStart = ref(0);
const followLatestSegment = ref(true);
const visibleTimelineRows = computed(() => messages.value.slice(
  segmentStart.value,
  segmentStart.value + TIMELINE_MOUNT_LIMIT
));
const hasEarlierSegment = computed(() => segmentStart.value > 0);
const hasLaterSegment = computed(() => segmentStart.value + TIMELINE_MOUNT_LIMIT < messages.value.length);
const compressionTimeline = computed(() => projectReliableCompressionTimeline(
  compressionBlocks.value,
  messages.value.map((message) => message.id)
));
const compressionBlocksByAnchor = computed(() => compressionTimeline.value.byAnchor);
const terminationRowsByAnchor = computed(() => {
  const result: Record<string, RunTerminationRecord[]> = {};
  for (const [messageId, termination] of Object.entries(projection.value.terminationByMessageId)) {
    const anchor = messages.value.find((message) => message.id === messageId);
    if (anchor?.role !== 'user' || isTerminationSuppressed(termination)) continue;
    (result[messageId] ??= []).push(termination);
  }
  return result;
});

watch(
  () => `${messages.value.length}:${messages.value[messages.value.length - 1]?.id ?? ''}`,
  () => {
    const total = messages.value.length;
    segmentStart.value = followLatestSegment.value
      ? latestTimelineSegmentStart(total)
      : clampTimelineSegmentStart(total, segmentStart.value);
  },
  { immediate: true }
);

watch(conversationId, () => {
  followLatestSegment.value = true;
  segmentStart.value = latestTimelineSegmentStart(messages.value.length);
});

const activeTurn = computed(() => {
  if (!conversationId.value) return undefined;
  return Object.values(feed.records.Turn ?? {}).find((turn) =>
    turn.conversation_id === conversationId.value && turn.status === 'active'
  );
});
const activeTurnRequests = computed(() => {
  if (!activeTurn.value || typeof activeTurn.value.id !== 'string') return [];
  return Object.values(feed.records.ModelRequest ?? {})
    .filter((request) => request.turn_id === activeTurn.value?.id)
    .sort((left, right) => reliableInteger(right.request_seq) - reliableInteger(left.request_seq));
});
const activityModelLabel = computed(() => {
  const request = activeTurnRequests.value[0];
  const frozenModel = reliableText(request?.model_id);
  if (frozenModel) return frozenModel;
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index];
    if (message?.role === 'model' && message.model?.trim()) return message.model.trim();
  }
  const requestProviderId = reliableText(request?.provider_id);
  const profile = conversationId.value
    ? modelProfiles.localProfileFor('conversation', conversationId.value).profile
    : undefined;
  const configuredProviderId = profile?.providerConfigId?.trim() ?? '';
  const provider = globalSettings.llmProviderConfigs.configs.find((config) => config.id === requestProviderId)
    ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === configuredProviderId)
    ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
    ?? globalSettings.llmProviderConfigs.configs[0];
  const profileProviderConfigId = profile?.providerConfigId?.trim();
  const override = profile && provider && profileProviderConfigId && profileProviderConfigId === provider.id
    ? profile.model.trim()
    : '';
  return override || provider?.model?.trim() || 'AI';
});
const activityLabel = computed(() => {
  const turn = activeTurn.value;
  if (!turn || typeof turn.id !== 'string') return undefined;
  if (messages.value.some((message) => message.id.startsWith('transient:'))) return undefined;
  const activeTool = Object.values(feed.records.ToolCall ?? {}).find((call) =>
    call.turn_id === turn.id && call.status !== 'terminal'
  );
  if (activeTool) return undefined;
  const latest = activeTurnRequests.value[0];
  if (!latest) return '正在准备上下文';
  if (latest.status === 'pending') return '正在启动模型请求';
  if (latest.status === 'streaming') return '正在等待模型输出';
  return '正在衔接下一步';
});

watch(
  () => [
    ...visibleTimelineRows.value.map((message) => message.id),
    ...Object.entries(projection.value.interactionByToolCallId)
      .filter(([, interaction]) => interaction.status === 'pending')
      .map(([toolCallId]) => toolCallId)
  ].join('|'),
  () => ensureDetails({
    messageIds: visibleTimelineRows.value.map((message) => message.id),
    priority: 'visible'
  }),
  { immediate: true }
);

function deleteCount(message: MessageRecord): number {
  const index = messages.value.findIndex((candidate) => candidate.id === message.id);
  return index < 0 ? 1 : messages.value.length - index;
}

function runHadCompletedTools(message: MessageRecord): boolean {
  const turnId = projection.value.turnIdByMessageId[message.id];
  if (!turnId) return false;
  return projection.value.toolCalls.some((call) =>
    (call.status === 'success' || call.status === 'warning' || call.status === 'error')
    && (call.messageId === message.id || projection.value.turnIdByMessageId[call.messageId] === turnId)
  );
}

function showEarlierSegment(): void {
  followLatestSegment.value = false;
  segmentStart.value = clampTimelineSegmentStart(
    messages.value.length,
    segmentStart.value - TIMELINE_SEGMENT_STEP
  );
  props.scroller?.scrollTo({ top: 0 });
}

function showLaterSegment(): void {
  const next = clampTimelineSegmentStart(
    messages.value.length,
    segmentStart.value + TIMELINE_SEGMENT_STEP
  );
  segmentStart.value = next;
  followLatestSegment.value = next >= latestTimelineSegmentStart(messages.value.length);
}

function retryFrom(message: MessageRecord): void {
  if (!message.retryTarget) return;
  retryMessageFrom(
    message.conversationId,
    message.retryTarget,
    currentAuthoritySelection(),
    projection.value.messageRevisionIdByMessageId[message.id]
  );
}

function retryBlocked(message: MessageRecord): boolean {
  if ((conversationActionPending.value && isConversationActionTarget(message)) || !message.retryTarget) return true;
  return message.retryTarget.kind === 'message'
    && !projection.value.messageRevisionIdByMessageId[message.id];
}

function deleteFrom(message: MessageRecord): void {
  deleteMessagesFrom(message.conversationId, message.id);
}

function forkFrom(message: MessageRecord): void {
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (revisionId) forkConversationFrom(message.conversationId, message.id, revisionId);
}

function compactTo(message: MessageRecord): void {
  compressContext(message.conversationId, { kind: 'through_message', messageId: message.id });
}

function isConversationActionTarget(message: MessageRecord): boolean {
  const action = conversationAction.value;
  if (!action) return false;
  if (action.action !== 'retry') return action.targetId === message.id;
  const target = message.retryTarget;
  return target?.kind === 'message'
    ? target.messageId === action.targetId
    : target?.modelRequestId === action.targetId;
}

function messageTermination(message: MessageRecord): RunTerminationRecord | undefined {
  if (message.role !== 'model') return undefined;
  return projection.value.terminationByMessageId[message.id];
}

function isMessageTerminationSuppressed(message: MessageRecord): boolean {
  const termination = messageTermination(message);
  return termination ? isTerminationSuppressed(termination) : false;
}

function isTerminationSuppressed(termination: RunTerminationRecord): boolean {
  return timelinePresentation.isSuppressed(conversationId.value, 'turn-termination', termination.id);
}

function dismissTermination(termination: RunTerminationRecord): void {
  timelinePresentation.suppress(conversationId.value, 'turn-termination', termination.id);
}

function dismissCompression(block: Record<string, unknown>): void {
  timelinePresentation.suppress(conversationId.value, 'compression-block', reliableText(block.id));
}

function reliableInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function reliableText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
        :termination="messageTermination(message)"
        :termination-notice-suppressed="isMessageTerminationSuppressed(message)"
        :run-had-completed-tools="runHadCompletedTools(message)"
        :delete-count="deleteCount(message)"
        :compact-count="Math.max(1, absoluteTimelineFloor(message.seq, segmentStart + index + 1))"
        :mutation-pending="conversationActionPending && isConversationActionTarget(message)"
        :mutation-blocked="(conversationActionPending && isConversationActionTarget(message)) || !projection.messageRevisionIdByMessageId[message.id]"
        :retry-blocked="retryBlocked(message)"
        :compact-blocked="(conversationActionPending && isConversationActionTarget(message)) || !projection.messageRevisionIdByMessageId[message.id]"
        :fork-blocked="forkPendingTargetIds.has(message.id) || !projection.messageRevisionIdByMessageId[message.id]"
        :pending-label="conversationActionLabel ?? '正在提交操作'"
        :floor-number="absoluteTimelineFloor(message.seq, segmentStart + index + 1)"
        @edit-message="emit('edit-message', message, deleteCount(message))"
        @retry-from="retryFrom"
        @delete-from="deleteFrom"
        @fork-from="forkFrom"
        @compact-to="compactTo"
        @dismiss-termination="dismissTermination"
      />
      <ReliableTurnTerminationRow
        v-for="termination in terminationRowsByAnchor[message.id] ?? []"
        :key="termination.id"
        :termination="termination"
        @dismiss="dismissTermination(termination)"
      />
      <ReliableCompressionCard
        v-for="block in compressionBlocksByAnchor[message.id] ?? []"
        :key="`compression:${String(block.id)}`"
        :block="block"
        :data-timeline-row-key="`compression:${String(block.id)}`"
        @dismiss="dismissCompression(block)"
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
      :model-label="activityModelLabel"
    />
    <p v-if="conversationActionNotice" class="reliable-action-notice" role="status">
      {{ conversationActionNotice }}
    </p>
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

.reliable-action-notice {
  align-self: center;
  margin: var(--space-2) var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  text-align: center;
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

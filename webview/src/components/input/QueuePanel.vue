<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconBolt, IconClock, IconGripVertical, IconPencil, IconPlayerPause, IconPlayerPlay, IconTrash } from '@tabler/icons-vue';
import type { TurnIntentHold } from '@shared/conversationReliability';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationCommandStore } from '@webview/stores/useConversationCommandStore';
import CollapsibleContentBlock from '@webview/components/content/CollapsibleContentBlock.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

export interface QueueItem {
  intentId: string;
  revisionId: string;
  rowVersion: number;
  text: string;
  order: number;
  createdAt: number;
  hold: TurnIntentHold;
  optimistic: boolean;
}

const emit = defineEmits<{
  (event: 'edit', item: QueueItem): void;
  (event: 'delete', item: QueueItem): void;
  (event: 'force-send', item: QueueItem): void;
  (event: 'reorder', items: QueueItem[]): void;
  (event: 'pause', item: QueueItem): void;
  (event: 'resume', item: QueueItem): void;
  (event: 'resume-all'): void;
}>();

const clientState = useClientStateStore();
const commands = useConversationCommandStore();
const scroller = ref<HTMLElement | null>(null);
const draggingIntentId = ref<string | undefined>();
const dragOverIntentId = ref<string | undefined>();
const dragInsertAfter = ref(false);
const localOrderIntentIds = ref<string[]>([]);
const expanded = ref(true);

const committedQueueItems = computed<QueueItem[]>(() => clientState.currentQueuedTurnIntents.flatMap((intent) => {
  const revision = clientState.turnIntentRevisions.find((candidate) =>
    candidate.id === intent.currentRevisionId && candidate.turnIntentId === intent.id);
  if (!revision) return [];
  return [{
    intentId: intent.id,
    revisionId: revision.id,
    rowVersion: intent.rowVersion,
    text: visibleText(revision.content),
    order: intent.order,
    createdAt: intent.createdAt,
    hold: intent.hold,
    optimistic: false
  }];
}));

const queueItems = computed<QueueItem[]>(() => {
  const conversationId = clientState.currentConversationId;
  const committed = committedQueueItems.value;
  const nextOrder = Math.max(0, ...committed.map((item) => item.order)) + 1_000;
  const optimistic = commands.pendingCommands
    .filter((command) => command.kind === 'enqueue'
      && command.conversationId === conversationId
      && command.projectionObservedAt === undefined)
    .map((command, index): QueueItem => {
      const payload = command.payload as { text?: string; content?: unknown };
      return {
        intentId: `pending-enqueue:${command.commandId}`,
        revisionId: '',
        rowVersion: 0,
        text: visibleText(payload.content) || payload.text?.trim() || '',
        order: nextOrder + index * 1_000,
        createdAt: command.startedAt,
        hold: 'none',
        optimistic: true
      };
    });
  return [...committed, ...optimistic];
});

const displayQueueItems = computed<QueueItem[]>(() => {
  const items = queueItems.value;
  if (localOrderIntentIds.value.length === 0) return items;
  const itemByIntentId = new Map(items.map((item) => [item.intentId, item]));
  return [
    ...localOrderIntentIds.value.flatMap((intentId) => {
      const item = itemByIntentId.get(intentId);
      return item ? [item] : [];
    }),
    ...items.filter((item) => !localOrderIntentIds.value.includes(item.intentId))
  ];
});

const heldQueueItems = computed(() => queueItems.value.filter((item) => item.hold !== 'none'));
const hasRestoredHold = computed(() => heldQueueItems.value.some((item) => item.hold === 'restored'));
const queueSummaryText = computed(() => {
  const total = queueItems.value.length;
  const held = heldQueueItems.value.length;
  if (held > 0) return `${total} 条 · ${hasRestoredHold.value ? '已恢复待继续' : `已暂停 ${held} 条`}`;
  return `${total} 条`;
});

function itemPending(intentId: string): boolean {
  return intentId.startsWith('pending-enqueue:')
    || commands.isTargetPending(clientState.currentConversationId, intentId);
}

function conversationQueuePending(): boolean {
  const conversationId = clientState.currentConversationId;
  return commands.isTargetPending(conversationId, conversationId, 'intent_control')
    || commands.pendingCommands.some((command) => command.conversationId === conversationId && command.kind === 'enqueue');
}

function queueHoldLabel(item: QueueItem): string {
  if (item.optimistic) return '正在入队';
  const hold = item.hold;
  if (hold === 'restored') return '已恢复，待继续';
  if (hold === 'manual') return '已暂停';
  return '排队中';
}

function onDragStart(event: DragEvent, item: QueueItem): void {
  if (displayQueueItems.value.length <= 1 || itemPending(item.intentId) || conversationQueuePending()) return;
  draggingIntentId.value = item.intentId;
  localOrderIntentIds.value = displayQueueItems.value.map((candidate) => candidate.intentId);
  event.dataTransfer?.setData('text/plain', item.intentId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}

function onDragOver(event: DragEvent, item: QueueItem): void {
  if (!draggingIntentId.value || draggingIntentId.value === item.intentId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const element = event.currentTarget as HTMLElement | null;
  const rect = element?.getBoundingClientRect();
  const insertAfter = rect ? event.clientY > rect.top + rect.height / 2 : false;
  moveDraggingItem(item.intentId, insertAfter);
}

function onDrop(event: DragEvent): void {
  if (!draggingIntentId.value) return;
  event.preventDefault();
  const nextOrderIds = localOrderIntentIds.value.length > 0
    ? [...localOrderIntentIds.value]
    : displayQueueItems.value.map((item) => item.intentId);
  const itemByIntentId = new Map(queueItems.value.map((item) => [item.intentId, item]));
  const nextItems = nextOrderIds.flatMap((intentId) => {
    const item = itemByIntentId.get(intentId);
    return item ? [item] : [];
  });
  clearDragState();
  if (nextItems.length === queueItems.value.length) emit('reorder', nextItems);
}

function onDragEnd(): void {
  clearDragState();
}

function moveDraggingItem(targetIntentId: string, insertAfter: boolean): void {
  const dragging = draggingIntentId.value;
  if (!dragging) return;
  const current = localOrderIntentIds.value.length > 0
    ? [...localOrderIntentIds.value]
    : displayQueueItems.value.map((item) => item.intentId);
  const withoutDragging = current.filter((intentId) => intentId !== dragging);
  const targetIndex = withoutDragging.indexOf(targetIntentId);
  if (targetIndex < 0) return;
  withoutDragging.splice(targetIndex + (insertAfter ? 1 : 0), 0, dragging);
  if (withoutDragging.join('\n') !== current.join('\n')) localOrderIntentIds.value = withoutDragging;
  dragOverIntentId.value = targetIntentId;
  dragInsertAfter.value = insertAfter;
}

function clearDragState(): void {
  draggingIntentId.value = undefined;
  dragOverIntentId.value = undefined;
  dragInsertAfter.value = false;
  localOrderIntentIds.value = [];
}

function visibleText(content: unknown): string {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return '';
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return '';
  return parts.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === 'string' ? [text] : [];
  }).join('').trim();
}
</script>

<template>
  <div v-if="queueItems.length > 0" class="queue-panel">
    <CollapsibleContentBlock
      v-model:expanded="expanded"
      class="queue-panel-collapsible"
      aria-label="展开或收起消息队列"
      kind="input"
      :icon-active="heldQueueItems.length > 0"
    >
      <template #icon>
        <IconClock stroke="2" aria-hidden="true" />
      </template>
      <template #summary>
        <span class="queue-panel-title">消息队列</span>
        <span class="queue-panel-summary">{{ queueSummaryText }}</span>
      </template>
      <template v-if="heldQueueItems.length > 0" #actions>
        <button type="button" class="queue-hold-banner-action" aria-label="全部继续排队" :disabled="conversationQueuePending()" @click="emit('resume-all')">全部继续</button>
      </template>

      <div ref="scroller" class="queue-panel-scroll">
      <div
        v-for="(item, index) in displayQueueItems"
        :key="item.intentId"
        class="queue-item"
        :class="{
          'is-held': item.hold !== 'none',
          'is-pending': itemPending(item.intentId),
          'is-dragging': draggingIntentId === item.intentId,
          'is-drag-over-before': dragOverIntentId === item.intentId && !dragInsertAfter,
          'is-drag-over-after': dragOverIntentId === item.intentId && dragInsertAfter
        }"
        :draggable="displayQueueItems.length > 1 && !itemPending(item.intentId) && !conversationQueuePending()"
        @dragstart="onDragStart($event, item)"
        @dragover="onDragOver($event, item)"
        @drop="onDrop"
        @dragend="onDragEnd"
      >
        <span class="queue-drag-handle" aria-label="拖拽调整排队顺序">
          <IconGripVertical :size="14" stroke="2" />
        </span>
        <span class="queue-item-icon" aria-hidden="true">
          <IconClock :size="14" stroke="2" />
        </span>
        <span class="queue-item-index">{{ index + 1 }}</span>
        <span class="queue-item-status" :class="{ 'is-held': item.hold !== 'none' }">{{ queueHoldLabel(item) }}</span>
        <span class="queue-item-text">{{ item.text || '(空消息)' }}</span>
        <div class="queue-item-actions">
          <button type="button" class="queue-item-action" aria-label="编辑排队消息" :disabled="itemPending(item.intentId)" draggable="false" @click="emit('edit', item)">
            <IconPencil :size="14" stroke="2" />
          </button>
          <button type="button" class="queue-item-action" aria-label="删除排队消息" :disabled="itemPending(item.intentId)" draggable="false" @click="emit('delete', item)">
            <IconTrash :size="14" stroke="2" />
          </button>
          <button
            v-if="item.hold !== 'none'"
            type="button"
            class="queue-item-action"
            aria-label="继续这条排队消息"
            :disabled="itemPending(item.intentId)"
            draggable="false"
            @click="emit('resume', item)"
          >
            <IconPlayerPlay :size="14" stroke="2" />
          </button>
          <button
            v-else
            type="button"
            class="queue-item-action"
            aria-label="暂停这条排队消息"
            :disabled="itemPending(item.intentId)"
            draggable="false"
            @click="emit('pause', item)"
          >
            <IconPlayerPause :size="14" stroke="2" />
          </button>
          <button type="button" class="queue-item-action queue-item-action--promote" aria-label="立即执行这条排队消息" title="当前有执行时会按身份围栏替换；空闲时直接执行" :disabled="itemPending(item.intentId)" draggable="false" @click="emit('force-send', item)">
            <IconBolt :size="14" stroke="2" />
          </button>
        </div>
      </div>
      </div>
      <AdvancedScrollbar :scroller="scroller" variant="minimal" />
    </CollapsibleContentBlock>
  </div>
</template>

<style scoped>
.queue-panel {
  position: relative;
  width: 100%;
  min-width: 0;
}

.queue-panel-collapsible {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  --lc-collapse-offset-y: 3px;
}

.queue-panel-collapsible :deep(.lc-collapsible-summary) {
  min-height: 26px;
  padding: 2px var(--space-1);
  border-radius: 4px;
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.queue-panel-collapsible :deep(.lc-collapsible-summary:hover),
.queue-panel-collapsible :deep(.lc-collapsible-summary:focus-visible) {
  background: var(--vscode-list-hoverBackground, transparent);
}

.queue-panel-collapsible :deep(.lc-collapsible-content-frame) {
  position: relative;
}

.queue-panel-collapsible :deep(.lc-collapse-chevron) {
  transform: rotate(90deg);
}

.queue-panel-collapsible :deep(.lc-collapse-chevron.is-expanded) {
  transform: rotate(-90deg);
}

.queue-panel-title {
  flex: 0 0 auto;
  color: var(--vscode-foreground);
  font-weight: 500;
}

.queue-panel-summary {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: var(--space-2);
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel-scroll {
  max-height: 112px;
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.queue-panel-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.queue-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 26px;
  padding: 0 var(--space-1);
  border: 1px solid transparent;
  border-radius: 4px;
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
  font-size: var(--font-size-sm);
  color: var(--vscode-descriptionForeground);
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
}

.queue-item:hover {
  background: var(--vscode-list-hoverBackground, transparent);
}

.queue-item.is-pending {
  opacity: 0.62;
}

.queue-item.is-held {
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.queue-item.is-dragging {
  opacity: 0.45;
}

.queue-item.is-drag-over-before {
  border-top-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
}

.queue-item.is-drag-over-after {
  border-bottom-color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
}

.queue-drag-handle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 22px;
  color: var(--vscode-descriptionForeground);
  opacity: 0.6;
  cursor: grab;
}

.queue-item:active .queue-drag-handle {
  cursor: grabbing;
}

.queue-item-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  opacity: 0.7;
}

.queue-item-index {
  flex: 0 0 auto;
  min-width: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  opacity: 0.6;
}

.queue-item-status {
  flex: 0 0 auto;
  max-width: 90px;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-item-status.is-held {
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
}

.queue-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.4;
}

.queue-item-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.queue-item:hover .queue-item-actions,
.queue-item:focus-within .queue-item-actions {
  opacity: 1;
}

.queue-item-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  min-width: 22px;
  min-height: 22px;
  padding: 0;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border: none;
  border-radius: 3px;
  cursor: pointer;
  transition: color 0.12s ease, background 0.12s ease;
}

.queue-item-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.12));
}

.queue-item-action:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.45;
  cursor: not-allowed;
}

.queue-item-action--promote:hover:not(:disabled) {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.queue-hold-banner-action {
  flex: 0 0 auto;
  min-height: 22px;
  padding: 0 var(--space-2);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  border-color: transparent;
}

.queue-hold-banner-action:hover:not(:disabled) {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  border-color: var(--vscode-panel-border, transparent);
}

.queue-panel :deep(.advanced-scrollbar) {
  top: 2px;
  right: 0;
  bottom: 2px;
}
</style>

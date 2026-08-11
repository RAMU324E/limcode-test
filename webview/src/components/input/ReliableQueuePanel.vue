<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import {
  IconAlertCircle,
  IconBolt,
  IconCheck,
  IconGripVertical,
  IconPencil,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconTrash,
  IconX
} from '@tabler/icons-vue';
import { BridgeMessageType } from '@shared/protocol';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';

interface TurnIntentPreview {
  version: number;
  text: string;
  editorText: string;
  hasAttachments: boolean;
  truncated: boolean;
  revisionSeq: string;
  position: string;
  hold: 'none' | 'paused';
}

interface QueueItem {
  id: string;
  text: string;
  state: 'submitting' | 'unconfirmed' | 'accepted' | 'acknowledged' | 'queued' | 'failed';
  createdAt: number;
  commandId?: string;
  retryable?: boolean;
  error?: string;
  committed?: boolean;
  preview?: TurnIntentPreview;
}

const reliableConversation = useReliableConversation();
const {
  currentPendingTurnInputs,
  currentTurnInputFailure,
  retryTurnInputSubmission,
  editGuidance,
  cancelGuidance,
  setGuidancePaused,
  reorderGuidance,
  currentPendingGuidanceControls,
  currentGuidanceControlFailure,
  dismissGuidanceControlFailure
} = useChat();

const requestedIntentVersions = new Map<string, string>();
const editingIntentId = ref<string>();
const editingText = ref('');
const editError = ref('');
const draggingIntentId = ref<string>();

const committedQueueRecords = computed(() => Object.values(
  reliableConversation.feed.records.TurnIntent ?? {}
).filter((intent) =>
  intent.conversation_id === reliableConversation.conversationId.value
  && intent.state === 'queued'
  && intent.turn_id == null
));

watchEffect(() => {
  const activeIds = new Set<string>();
  for (const intent of committedQueueRecords.value) {
    const id = typeof intent.id === 'string' ? intent.id : '';
    if (!id) continue;
    activeIds.add(id);
    const version = typeof intent.current_revision_seq === 'string'
      ? intent.current_revision_seq
      : String(intent.updated_at ?? '');
    const previous = requestedIntentVersions.get(id);
    if (previous === undefined) {
      reliableConversation.feed.requestDetail('turn-intent-preview', id, { priority: 'critical' });
    } else if (previous !== version) {
      reliableConversation.feed.reloadDetail('turn-intent-preview', id, { priority: 'critical' });
    }
    requestedIntentVersions.set(id, version);
  }
  for (const id of requestedIntentVersions.keys()) {
    if (!activeIds.has(id)) requestedIntentVersions.delete(id);
  }
});

const committedItems = computed<QueueItem[]>(() => committedQueueRecords.value.map((intent) => {
  const id = typeof intent.id === 'string' ? intent.id : '';
  const projectedRevisionSeq = typeof intent.current_revision_seq === 'string'
    ? intent.current_revision_seq
    : undefined;
  const loadedPreview = id ? turnIntentPreview(id) : undefined;
  const preview = loadedPreview
    && (!projectedRevisionSeq || loadedPreview.revisionSeq === projectedRevisionSeq)
    ? loadedPreview
    : undefined;
  return {
    id,
    text: previewText(preview),
    state: 'queued' as const,
    createdAt: timestamp(intent.created_at),
    committed: true,
    ...(preview ? { preview } : {})
  };
}).filter((item) => item.id).sort((left, right) => {
  const leftPosition = left.preview?.position;
  const rightPosition = right.preview?.position;
  if (leftPosition && rightPosition) {
    const order = compareIntegerStrings(leftPosition, rightPosition);
    if (order !== 0) return order;
  } else if (leftPosition) {
    return -1;
  } else if (rightPosition) {
    return 1;
  }
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}));

const optimisticItems = computed<QueueItem[]>(() => {
  const committedIds = new Set(committedItems.value.map((item) => item.id));
  return currentPendingTurnInputs.value.flatMap((submission): QueueItem[] => {
    const result = submission.result;
    const belongsInQueue = (
      submission.requestType === BridgeMessageType.TurnEnqueue
      || result?.admitted === false
    ) && result?.admitted !== true;
    const observed = result?.admitted === true
      ? Boolean(result.turnId && reliableConversation.feed.records.Turn?.[result.turnId])
      : Boolean(result?.intentId && committedIds.has(result.intentId));
    if (observed) return [];
    const retryable = !result && (submission.automaticRetryCount ?? 0) >= 1;
    return [{
      id: `pending:${submission.commandId}`,
      text: submissionText(submission.text, submission.content),
      state: result?.admitted === true
        ? 'accepted'
        : result && belongsInQueue
          ? 'acknowledged'
          : retryable
            ? 'unconfirmed'
            : 'submitting',
      createdAt: submission.submittedAt,
      commandId: submission.commandId,
      retryable
    }];
  });
});

const queueItems = computed<QueueItem[]>(() => {
  const failure = currentTurnInputFailure.value;
  const failed: QueueItem[] = failure
    ? [{
        id: `failed:${failure.commandId}`,
        text: submissionText(failure.text, failure.content),
        state: 'failed',
        createdAt: failure.failedAt,
        error: failure.message
      }]
    : [];
  return [
    ...committedItems.value,
    ...optimisticItems.value.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    ...failed
  ];
});

const pendingIntentIds = computed(() => new Set(currentPendingGuidanceControls.value.flatMap((control) =>
  control.intentIds
)));
const reorderPending = computed(() => currentPendingGuidanceControls.value.some((control) =>
  control.action === 'reorder'
));
const canReorder = computed(() =>
  optimisticItems.value.length === 0
  && committedItems.value.length > 1
  && committedItems.value.every((item) => Boolean(item.preview?.revisionSeq))
  && currentPendingGuidanceControls.value.length === 0
);
const hasQueuedItems = computed(() => queueItems.value.some((item) =>
  item.state === 'queued' || item.state === 'acknowledged'
));
const waitReason = computed(() => {
  if (queueItems.value.every((item) => item.state === 'failed')) return '提交失败，草稿已保留';
  if (queueItems.value.some((item) => item.state === 'accepted')) return '消息已保存，正在显示';
  if (queueItems.value.some((item) => item.state === 'unconfirmed')) return '消息尚未确认，可手动重试';
  if (!hasQueuedItems.value) return '等待系统确认';
  if (committedItems.value.length > 0 && committedItems.value.every((item) => item.preview?.hold === 'paused')) {
    return '所有引导消息均已暂停';
  }
  const pendingInteraction = Object.values(
    reliableConversation.feed.records.InteractionRequest ?? {}
  ).some((request) => request.status === 'pending');
  return pendingInteraction ? '等待当前操作完成' : '等待当前回复和工具完成';
});

function turnIntentPreview(intentId: string): TurnIntentPreview | undefined {
  const detail = reliableConversation.feed.details[
    reliableKernelDetailKey('turn-intent-preview', intentId)
  ];
  if (!detail || detail.status !== 'ready') return undefined;
  try {
    const value = JSON.parse(detail.text) as Record<string, unknown>;
    if (
      typeof value.text !== 'string'
      || typeof value.editorText !== 'string'
      || typeof value.revisionSeq !== 'string'
      || typeof value.position !== 'string'
      || (value.hold !== 'none' && value.hold !== 'paused')
    ) return undefined;
    return {
      version: typeof value.version === 'number' ? value.version : 2,
      text: value.text,
      editorText: value.editorText,
      hasAttachments: value.hasAttachments === true,
      truncated: value.truncated === true,
      revisionSeq: value.revisionSeq,
      position: value.position,
      hold: value.hold
    };
  } catch {
    return undefined;
  }
}

function previewText(preview?: TurnIntentPreview): string {
  if (!preview) return '正在读取排队消息…';
  const text = preview.text.trim();
  if (text) return `${text}${preview.truncated ? '…' : ''}`;
  if (preview.hasAttachments) return '附件消息';
  return '(空消息)';
}

function submissionText(text: string, content?: { parts?: readonly unknown[] }): string {
  const visible = text.trim() || (content?.parts ?? []).flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const value = (part as { text?: unknown }).text;
    return typeof value === 'string' ? [value] : [];
  }).join('').trim();
  if (visible) return visible;
  const attachments = (content?.parts ?? []).filter((part) =>
    Boolean(part && typeof part === 'object' && !Array.isArray(part) && 'inlineData' in part)
  ).length;
  return attachments > 0 ? `附件消息（${attachments} 个附件）` : '(空消息)';
}

function stateLabel(item: QueueItem): string {
  if (item.state === 'submitting') return '正在提交';
  if (item.state === 'unconfirmed') return '尚未确认';
  if (item.state === 'accepted') return '已保存';
  if (item.state === 'acknowledged') return '已进入引导队列';
  if (item.state === 'failed') return '发送失败';
  if (item.preview?.hold === 'paused') return '已暂停';
  return '等待引导';
}

function itemBusy(item: QueueItem): boolean {
  return reorderPending.value || pendingIntentIds.value.has(item.id);
}

function beginEdit(item: QueueItem): void {
  if (!item.preview || itemBusy(item)) return;
  editingIntentId.value = item.id;
  editingText.value = item.preview.editorText;
  editError.value = '';
}

function closeEdit(): void {
  editingIntentId.value = undefined;
  editingText.value = '';
  editError.value = '';
}

function saveEdit(item: QueueItem): void {
  if (!item.preview) return;
  const text = editingText.value.trim();
  if (!text && !item.preview.hasAttachments) {
    editError.value = '没有附件的引导消息不能为空。';
    return;
  }
  if (editGuidance(item.id, item.preview.revisionSeq, text)) closeEdit();
}

function removeItem(item: QueueItem): void {
  if (!item.preview || itemBusy(item)) return;
  if (!window.confirm('确定删除这条等待中的引导消息吗？')) return;
  cancelGuidance(item.id, item.preview.revisionSeq);
  if (editingIntentId.value === item.id) closeEdit();
}

function togglePause(item: QueueItem): void {
  if (!item.preview || itemBusy(item)) return;
  setGuidancePaused(
    item.id,
    item.preview.revisionSeq,
    item.preview.hold !== 'paused'
  );
}

function startDrag(event: DragEvent, item: QueueItem): void {
  if (!canReorder.value || !item.preview) {
    event.preventDefault();
    return;
  }
  draggingIntentId.value = item.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', item.id);
  }
}

function dropOn(event: DragEvent, target: QueueItem): void {
  event.preventDefault();
  const sourceId = draggingIntentId.value || event.dataTransfer?.getData('text/plain');
  draggingIntentId.value = undefined;
  if (!sourceId || sourceId === target.id || !canReorder.value) return;
  const ordered = [...committedItems.value];
  const sourceIndex = ordered.findIndex((item) => item.id === sourceId);
  const targetIndex = ordered.findIndex((item) => item.id === target.id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const [moved] = ordered.splice(sourceIndex, 1);
  ordered.splice(targetIndex, 0, moved);
  reorderGuidance(ordered.map((item) => ({
    intentId: item.id,
    expectedRevisionSeq: item.preview!.revisionSeq
  })));
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareIntegerStrings(left: string, right: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(left) || !/^(?:0|[1-9]\d*)$/.test(right)) {
    return left.localeCompare(right);
  }
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
</script>

<template>
  <section v-if="queueItems.length > 0" class="reliable-queue" aria-label="引导消息状态">
    <div class="reliable-queue-header">
      <span class="reliable-queue-title">
        <IconBolt class="reliable-queue-guide-icon" :size="14" stroke="2" aria-hidden="true" />
        引导消息 · {{ queueItems.length }}
      </span>
      <span class="reliable-queue-reason">{{ waitReason }}</span>
    </div>

    <div v-if="currentGuidanceControlFailure" class="reliable-queue-control-error" role="alert">
      <IconAlertCircle :size="14" stroke="2" aria-hidden="true" />
      <span>{{ currentGuidanceControlFailure.message }}</span>
      <button type="button" title="关闭提示" @click="dismissGuidanceControlFailure">
        <IconX :size="13" stroke="2" aria-hidden="true" />
      </button>
    </div>

    <ol class="reliable-queue-list">
      <li
        v-for="(item, index) in queueItems"
        :key="item.id"
        class="reliable-queue-item"
        :class="[
          `is-${item.state}`,
          { 'is-paused': item.preview?.hold === 'paused', 'is-dragging': draggingIntentId === item.id }
        ]"
        :draggable="Boolean(item.committed && canReorder && !itemBusy(item))"
        @dragstart="startDrag($event, item)"
        @dragend="draggingIntentId = undefined"
        @dragover.prevent
        @drop="dropOn($event, item)"
      >
        <template v-if="editingIntentId === item.id && item.preview">
          <textarea
            v-model="editingText"
            class="reliable-queue-editor"
            rows="3"
            aria-label="编辑引导消息"
            @keydown.escape.prevent="closeEdit"
          />
          <div class="reliable-queue-editor-actions">
            <span v-if="editError" class="reliable-queue-edit-error">{{ editError }}</span>
            <button type="button" title="保存编辑" :disabled="itemBusy(item)" @click="saveEdit(item)">
              <IconCheck :size="14" stroke="2" aria-hidden="true" />
            </button>
            <button type="button" title="取消编辑" @click="closeEdit">
              <IconX :size="14" stroke="2" aria-hidden="true" />
            </button>
          </div>
        </template>

        <template v-else>
          <IconAlertCircle v-if="item.state === 'failed'" :size="14" stroke="2" aria-hidden="true" />
          <IconGripVertical
            v-else-if="item.committed"
            class="reliable-queue-grip"
            :class="{ 'is-disabled': !canReorder }"
            :size="14"
            stroke="2"
            aria-hidden="true"
          />
          <span v-else class="reliable-queue-index">{{ index + 1 }}</span>
          <span class="reliable-queue-state">{{ stateLabel(item) }}</span>
          <span class="reliable-queue-text" :title="item.text">{{ item.text }}</span>

          <div v-if="item.committed" class="reliable-queue-actions">
            <button
              type="button"
              title="编辑引导消息"
              :disabled="!item.preview || itemBusy(item)"
              @click="beginEdit(item)"
            >
              <IconPencil :size="13" stroke="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              :title="item.preview?.hold === 'paused' ? '恢复这条引导消息' : '暂停这条引导消息'"
              :disabled="!item.preview || itemBusy(item)"
              @click="togglePause(item)"
            >
              <IconPlayerPlay v-if="item.preview?.hold === 'paused'" :size="13" stroke="2" aria-hidden="true" />
              <IconPlayerPause v-else :size="13" stroke="2" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="is-danger"
              title="删除引导消息"
              :disabled="!item.preview || itemBusy(item)"
              @click="removeItem(item)"
            >
              <IconTrash :size="13" stroke="2" aria-hidden="true" />
            </button>
          </div>

          <button
            v-if="item.retryable && item.commandId"
            type="button"
            class="reliable-queue-retry"
            title="重新发送此消息"
            @click="retryTurnInputSubmission(item.commandId)"
          >
            <IconRefresh :size="13" stroke="2" aria-hidden="true" />
            重试
          </button>
          <span v-if="item.error" class="reliable-queue-error" :title="item.error">草稿已保留，可直接重试</span>
        </template>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.reliable-queue {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 5px 6px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: 5px;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-sm);
}

.reliable-queue-header,
.reliable-queue-item,
.reliable-queue-title,
.reliable-queue-control-error {
  display: flex;
  align-items: center;
}

.reliable-queue-header {
  min-width: 0;
  justify-content: space-between;
  gap: var(--space-2);
}

.reliable-queue-title {
  flex: 0 0 auto;
  gap: 5px;
  color: var(--vscode-foreground);
  font-weight: 600;
}

.reliable-queue-guide-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.reliable-queue-reason {
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reliable-queue-control-error {
  gap: 5px;
  padding: 3px 5px;
  border-radius: 4px;
  color: var(--vscode-errorForeground, #f14c4c);
  background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 10%, transparent);
}

.reliable-queue-control-error span {
  flex: 1;
  min-width: 0;
}

.reliable-queue-list {
  max-height: 180px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.reliable-queue-item {
  min-width: 0;
  min-height: 26px;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.reliable-queue-item[draggable='true'] {
  cursor: grab;
}

.reliable-queue-item.is-dragging {
  opacity: 0.45;
}

.reliable-queue-item.is-paused {
  opacity: 0.66;
}

.reliable-queue-item.is-submitting,
.reliable-queue-item.is-unconfirmed,
.reliable-queue-item.is-accepted,
.reliable-queue-item.is-acknowledged {
  opacity: 0.72;
}

.reliable-queue-item.is-failed,
.reliable-queue-edit-error {
  color: var(--vscode-errorForeground, #f14c4c);
}

.reliable-queue-index,
.reliable-queue-grip {
  width: 14px;
  flex: 0 0 auto;
}

.reliable-queue-index {
  text-align: center;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.reliable-queue-grip {
  color: var(--vscode-descriptionForeground);
}

.reliable-queue-grip.is-disabled {
  opacity: 0.35;
}

.reliable-queue-state {
  flex: 0 0 auto;
  font-size: 11px;
}

.reliable-queue-text {
  flex: 1;
  min-width: 0;
  color: var(--vscode-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reliable-queue-actions,
.reliable-queue-editor-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}

.reliable-queue button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  min-height: 22px;
  padding: 1px 4px;
  border: 1px solid transparent;
  border-radius: 3px;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  background: transparent;
  cursor: pointer;
}

.reliable-queue button:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.16));
}

.reliable-queue button:disabled {
  cursor: default;
  opacity: 0.4;
}

.reliable-queue button.is-danger:hover:not(:disabled) {
  color: var(--vscode-errorForeground, #f14c4c);
}

.reliable-queue-editor {
  width: 100%;
  min-height: 52px;
  resize: vertical;
  padding: 5px 6px;
  border: 1px solid var(--vscode-input-border, var(--vscode-focusBorder));
  border-radius: 3px;
  outline: none;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}

.reliable-queue-editor:focus {
  border-color: var(--vscode-focusBorder);
}

.reliable-queue-editor-actions {
  align-self: stretch;
  flex-direction: column;
  justify-content: flex-start;
}

.reliable-queue-edit-error {
  max-width: 150px;
  font-size: 11px;
}

.reliable-queue-retry {
  gap: 3px;
  color: var(--vscode-button-foreground) !important;
  background: var(--vscode-button-background) !important;
}

.reliable-queue-retry:hover {
  background: var(--vscode-button-hoverBackground) !important;
}

.reliable-queue-error {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

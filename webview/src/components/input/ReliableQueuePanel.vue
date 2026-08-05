<script setup lang="ts">
import { computed, watchEffect } from 'vue';
import { IconAlertCircle, IconClock } from '@tabler/icons-vue';
import { BridgeMessageType } from '@shared/protocol';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';

interface QueueItem {
  id: string;
  text: string;
  state: 'submitting' | 'accepted' | 'acknowledged' | 'queued' | 'failed';
  createdAt: number;
  error?: string;
}

const reliableConversation = useReliableConversation();
const { currentPendingTurnInputs, currentTurnInputFailure } = useChat();

const committedQueue = computed(() => Object.values(
  reliableConversation.feed.records.TurnIntent ?? {}
).filter((intent) =>
  intent.conversation_id === reliableConversation.conversationId.value
  && intent.state === 'queued'
  && intent.turn_id == null
).sort((left, right) =>
  String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))
  || String(left.id ?? '').localeCompare(String(right.id ?? ''))
));

watchEffect(() => {
  for (const intent of committedQueue.value) {
    const id = typeof intent.id === 'string' ? intent.id : '';
    if (id) reliableConversation.feed.requestDetail('turn-intent-preview', id, { priority: 'critical' });
  }
});

const queueItems = computed<QueueItem[]>(() => {
  const committedIds = new Set(committedQueue.value.flatMap((intent) =>
    typeof intent.id === 'string' ? [intent.id] : []
  ));
  const committed = committedQueue.value.flatMap((intent): QueueItem[] => {
    const id = typeof intent.id === 'string' ? intent.id : '';
    if (!id) return [];
    return [{
      id,
      text: turnIntentText(id),
      state: 'queued',
      createdAt: timestamp(intent.created_at)
    }];
  });
  const optimistic = currentPendingTurnInputs.value.flatMap((submission): QueueItem[] => {
    const result = submission.result;
    const belongsInQueue = (
      submission.requestType === BridgeMessageType.TurnEnqueue
      || result?.admitted === false
    ) && result?.admitted !== true;
    const observed = result?.admitted === true
      ? Boolean(result.turnId && reliableConversation.feed.records.Turn?.[result.turnId])
      : Boolean(result?.intentId && committedIds.has(result.intentId));
    if (observed) return [];
    return [{
      id: `pending:${submission.commandId}`,
      text: submissionText(submission.text, submission.content),
      state: result?.admitted === true
        ? 'accepted'
        : result && belongsInQueue
          ? 'acknowledged'
          : 'submitting',
      createdAt: submission.submittedAt
    }];
  });
  const failure = currentTurnInputFailure.value;
  const failed = failure
    ? [{
        id: `failed:${failure.commandId}`,
        text: submissionText(failure.text, failure.content),
        state: 'failed' as const,
        createdAt: failure.failedAt,
        error: failure.message
      }]
    : [];
  return [...committed, ...optimistic, ...failed]
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
});

const hasQueuedItems = computed(() => queueItems.value.some((item) =>
  item.state === 'queued' || item.state === 'acknowledged'
));

const waitReason = computed(() => {
  if (queueItems.value.every((item) => item.state === 'failed')) return '提交失败，草稿已保留';
  if (queueItems.value.some((item) => item.state === 'accepted')) return '持久化已确认，等待时间线同步';
  if (!hasQueuedItems.value) return '等待可靠 Runtime 确认';
  const pendingInteraction = Object.values(
    reliableConversation.feed.records.InteractionRequest ?? {}
  ).some((request) => request.status === 'pending');
  return pendingInteraction ? '等待当前审批或交互完成' : '等待当前回复完成';
});

function turnIntentText(intentId: string): string {
  const detail = reliableConversation.feed.details[
    reliableKernelDetailKey('turn-intent-preview', intentId)
  ];
  if (!detail || detail.status === 'loading') return '正在读取排队消息…';
  if (detail.status === 'error') return '排队消息内容暂不可用';
  try {
    const preview = JSON.parse(detail.text) as {
      version?: unknown;
      text?: unknown;
      hasAttachments?: unknown;
      truncated?: unknown;
    };
    const text = typeof preview.text === 'string' ? preview.text.trim() : '';
    const suffix = preview.truncated === true ? '…' : '';
    if (text) return `${text}${suffix}`;
    if (preview.hasAttachments === true) return '附件消息';
    return '(空消息)';
  } catch {
    return '排队消息内容暂不可用';
  }
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

function stateLabel(state: QueueItem['state']): string {
  if (state === 'submitting') return '正在提交';
  if (state === 'accepted') return '已持久化';
  if (state === 'acknowledged') return '已确认入队';
  if (state === 'failed') return '发送失败';
  return '排队中';
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
</script>

<template>
  <section v-if="queueItems.length > 0" class="reliable-queue" aria-label="消息提交与队列状态">
    <div class="reliable-queue-header">
      <span class="reliable-queue-title">
        <IconClock :size="14" stroke="2" aria-hidden="true" />
        消息提交 / 队列 · {{ queueItems.length }}
      </span>
      <span class="reliable-queue-reason">{{ waitReason }}</span>
    </div>
    <ol class="reliable-queue-list">
      <li
        v-for="(item, index) in queueItems"
        :key="item.id"
        class="reliable-queue-item"
        :class="`is-${item.state}`"
      >
        <IconAlertCircle v-if="item.state === 'failed'" :size="14" stroke="2" aria-hidden="true" />
        <span v-else class="reliable-queue-index">{{ index + 1 }}</span>
        <span class="reliable-queue-state">{{ stateLabel(item.state) }}</span>
        <span class="reliable-queue-text" :title="item.text">{{ item.text }}</span>
        <span v-if="item.error" class="reliable-queue-error" :title="item.error">草稿已保留，可直接重试</span>
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
  gap: 3px;
  padding: 5px 6px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: 5px;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  font-size: var(--font-size-sm);
}

.reliable-queue-header,
.reliable-queue-item,
.reliable-queue-title {
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

.reliable-queue-reason {
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.reliable-queue-list {
  max-height: 104px;
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
  min-height: 24px;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-list-inactiveSelectionBackground, transparent);
}

.reliable-queue-item.is-submitting,
.reliable-queue-item.is-accepted,
.reliable-queue-item.is-acknowledged {
  opacity: 0.72;
}

.reliable-queue-item.is-failed {
  color: var(--vscode-errorForeground, #f14c4c);
}

.reliable-queue-index {
  width: 14px;
  flex: 0 0 auto;
  text-align: center;
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
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

.reliable-queue-error {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconAlertCircle, IconX } from '@tabler/icons-vue';
import type { NativeSteeringReceipt, OpenAIResponsesSteeringState } from '@shared/openAIResponsesNative';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const {
  currentSteeringReceipts,
  currentSteeringFailure,
  dismissSteeringFailure,
  ensureSteeringReceipts
} = useChat();
const reliableConversation = useReliableConversation();
const listScroller = ref<HTMLElement | null>(null);

watch(
  () => reliableConversation.conversationId.value,
  (conversationId) => {
    if (conversationId) ensureSteeringReceipts(conversationId);
  },
  { immediate: true }
);

const receipts = computed(() => currentSteeringReceipts.value.slice(0, 8));
const failure = computed(() => currentSteeringFailure.value);

const STATE_LABELS: Record<OpenAIResponsesSteeringState, string> = {
  queued: '已排队',
  sent: '已发送 · 未确认生效',
  accepted: '已接受 · 等待后继响应',
  waiting_for_input: '等待必需输入',
  continuing: '正在继续',
  completed: '已完成',
  failed: '失败',
  delivery_unknown: '投递状态未知'
};

function stateLabel(state: string): string {
  return STATE_LABELS[state as OpenAIResponsesSteeringState] ?? state;
}

function receiptDetail(receipt: NativeSteeringReceipt): string {
  return receipt.message?.trim() ?? '';
}

function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '';
}
</script>

<template>
  <section v-if="receipts.length > 0 || failure" class="steering-status" aria-label="转向回执状态">
    <div class="steering-status-header">
      <span class="steering-status-title">转向回执</span>
      <span class="steering-status-hint">「已发送 / 已接受」不代表内容已生效</span>
    </div>

    <div v-if="failure" class="steering-status-error" role="alert">
      <IconAlertCircle :size="14" stroke="2" aria-hidden="true" />
      <span>{{ failure.message }}</span>
      <button type="button" title="关闭提示" @click="dismissSteeringFailure">
        <IconX :size="13" stroke="2" aria-hidden="true" />
      </button>
    </div>

    <div v-if="receipts.length > 0" class="steering-status-list-shell">
      <ol ref="listScroller" class="steering-status-list">
        <li
          v-for="receipt in receipts"
          :key="receipt.submissionId"
          class="steering-status-item"
          :class="`is-${receipt.state}`"
        >
          <span class="steering-state-chip">{{ stateLabel(receipt.state) }}</span>
          <span v-if="receiptDetail(receipt)" class="steering-state-detail">{{ receiptDetail(receipt) }}</span>
          <span class="steering-state-time">{{ formatTime(receipt.updatedAt) }}</span>
        </li>
      </ol>
      <AdvancedScrollbar :scroller="listScroller" :refresh-key="receipts.length" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.steering-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  background: var(--vscode-sideBar-background, transparent);
}

.steering-status-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.steering-status-title {
  font-size: var(--font-size-xs);
  color: var(--vscode-foreground);
}

.steering-status-hint {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.steering-status-error {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-xs);
}

.steering-status-error button {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: inherit;
  padding: 0;
  cursor: pointer;
}

.steering-status-list-shell {
  position: relative;
  max-height: 132px;
  overflow: hidden;
}

.steering-status-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-height: 132px;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  scrollbar-width: none;
}

.steering-status-list::-webkit-scrollbar {
  display: none;
}

.steering-status-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
}

.steering-state-chip {
  flex: 0 0 auto;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--space-1);
  color: var(--vscode-foreground);
  line-height: 1.6;
}

.steering-status-item.is-failed .steering-state-chip,
.steering-status-item.is-delivery_unknown .steering-state-chip {
  color: var(--vscode-errorForeground);
}

.steering-state-detail {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steering-state-time {
  flex: 0 0 auto;
}
</style>

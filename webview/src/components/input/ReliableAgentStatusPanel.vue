<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watchEffect } from 'vue';
import { IconChevronDown, IconChevronRight, IconPlayerStop, IconRobot } from '@tabler/icons-vue';
import { BridgeMessageType } from '@shared/protocol';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import { bridge } from '@webview/transport';
import {
  projectReliableAgentStatus,
  type ReliableChildAgentGroup,
  type ReliableChildAgentStatus
} from '@webview/domain/reliableAgentStatusProjection';

const reliableConversation = useReliableConversation();
const agentStore = useAgentStore();
const { interruptPhase } = useChat();
const expanded = ref(false);
const interruptFeedback = ref<Record<string, {
  requestId: string;
  phase: 'submitting' | 'committed' | 'failed';
  message: string;
}>>({});
const interruptProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const projection = computed(() => projectReliableAgentStatus({
  conversationId: reliableConversation.conversationId.value,
  records: reliableConversation.feed.records,
  agentNames: new Map(agentStore.agents.map((agent) => [agent.id, agent.name]))
}));
const activeTurn = computed(() => Object.values(reliableConversation.feed.records.Turn ?? {}).find((turn) =>
  turn.conversation_id === reliableConversation.conversationId.value && turn.status === 'active'
));
const activeLease = computed(() => activeTurn.value && Object.values(reliableConversation.feed.records.ExecutionLease ?? {})
  .some((lease) => lease.turn_id === activeTurn.value?.id));
const currentStatus = computed(() => interruptPhase.value
  ? interruptPhase.value === 'stopping' ? '正在停止' : '正在请求停止'
  : activeTurn.value && activeLease.value ? '执行中' : '空闲');
const groups: Array<{ id: ReliableChildAgentGroup; label: string }> = [
  { id: 'executing', label: '执行中' },
  { id: 'resumable', label: '可继续' },
  { id: 'attention', label: '需处理' },
  { id: 'finished', label: '已结束' }
];

watchEffect(() => {
  if (!expanded.value) return;
  for (const child of projection.value.children) {
    reliableConversation.feed.requestDetail('tool-arguments-content', child.sourceToolCallId, { priority: 'expanded' });
  }
});

watchEffect(() => {
  const childById = new Map(projection.value.children.map((child) => [child.id, child]));
  for (const childId of Object.keys(interruptFeedback.value)) {
    const child = childById.get(childId);
    if (child && !['interrupting', 'interrupted', 'closed'].includes(child.lifecycle)) continue;
    clearInterruptProjectionTimer(childId);
    const next = { ...interruptFeedback.value };
    delete next[childId];
    interruptFeedback.value = next;
  }
});

const disposeInterruptResult = bridge.on(BridgeMessageType.InteractionResult, (message) => {
  if (message.payload?.requestType !== BridgeMessageType.ToolExecutionCancel) return;
  const pending = Object.entries(interruptFeedback.value)
    .find(([, feedback]) => feedback.requestId === message.correlationId);
  if (!pending) return;
  const [childId, feedback] = pending;
  switch (message.payload.status) {
    case 'committed':
    case 'already_applied':
      setInterruptFeedback(childId, { ...feedback, phase: 'committed', message: '终止已提交，等待状态同步' });
      scheduleInterruptProjectionDeadline(childId);
      return;
    case 'already_satisfied':
    case 'already_resolved':
      setInterruptFeedback(childId, { ...feedback, phase: 'committed', message: '目标已经结束' });
      scheduleInterruptProjectionDeadline(childId);
      return;
    default:
      setInterruptFeedback(childId, {
        ...feedback,
        phase: 'failed',
        message: message.payload.reason?.trim() || '终止未能完成，请重试'
      });
  }
});

const disposeInterruptError = bridge.on(BridgeMessageType.Error, (message) => {
  if (message.payload?.requestType !== BridgeMessageType.ToolExecutionCancel) return;
  const pending = Object.entries(interruptFeedback.value)
    .find(([, feedback]) => feedback.requestId === message.correlationId);
  if (!pending) return;
  const [childId, feedback] = pending;
  clearInterruptProjectionTimer(childId);
  setInterruptFeedback(childId, {
    ...feedback,
    phase: 'failed',
    message: message.payload.message?.trim() || '终止未能提交，请重试'
  });
});

onBeforeUnmount(() => {
  disposeInterruptResult();
  disposeInterruptError();
  for (const timer of interruptProjectionTimers.values()) clearTimeout(timer);
  interruptProjectionTimers.clear();
});

function childrenIn(group: ReliableChildAgentGroup): ReliableChildAgentStatus[] {
  return projection.value.children.filter((child) => child.group === group);
}

function taskTitle(child: ReliableChildAgentStatus): string | undefined {
  const detail = reliableConversation.feed.details[
    reliableKernelDetailKey('tool-arguments-content', child.sourceToolCallId)
  ];
  if (detail?.status !== 'ready') return undefined;
  try {
    const value = JSON.parse(detail.text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prompt = (value as Record<string, unknown>).prompt;
    return typeof prompt === 'string' && prompt.trim() ? truncate(prompt.replace(/\s+/g, ' ').trim(), 96) : undefined;
  } catch {
    return undefined;
  }
}

function deliveryLabel(child: ReliableChildAgentStatus): string | undefined {
  return child.deliveryBadge === 'awaiting_parent'
    ? '等待主 Agent 处理'
    : child.deliveryBadge === 'delivery_failed' ? '回答发送失败' : undefined;
}

function interruptChild(child: ReliableChildAgentStatus): void {
  const current = interruptFeedback.value[child.id];
  if (!child.interruptible || current?.phase === 'submitting' || current?.phase === 'committed') return;
  clearInterruptProjectionTimer(child.id);
  const requestId = bridge.request(BridgeMessageType.ToolExecutionCancel, {
    toolCallId: child.sourceToolCallId,
    conversationId: reliableConversation.conversationId.value,
    reason: '用户从 Agent 运行情况面板请求终止该子 Agent 及其启动的所有子 Agent。'
  });
  setInterruptFeedback(child.id, { requestId, phase: 'submitting', message: '正在提交终止请求' });
}

function interruptButtonLabel(child: ReliableChildAgentStatus): string {
  const feedback = interruptFeedback.value[child.id];
  if (child.lifecycle === 'interrupting' || feedback?.phase === 'committed') return '正在终止';
  if (feedback?.phase === 'submitting') return '正在提交';
  return feedback?.phase === 'failed' ? '重试终止' : '全部终止';
}

function interruptButtonDisabled(child: ReliableChildAgentStatus): boolean {
  const phase = interruptFeedback.value[child.id]?.phase;
  return !child.interruptible || phase === 'submitting' || phase === 'committed';
}

function interruptError(child: ReliableChildAgentStatus): string | undefined {
  const feedback = interruptFeedback.value[child.id];
  return feedback?.phase === 'failed' ? feedback.message : undefined;
}

function setInterruptFeedback(
  childId: string,
  feedback: { requestId: string; phase: 'submitting' | 'committed' | 'failed'; message: string }
): void {
  interruptFeedback.value = { ...interruptFeedback.value, [childId]: feedback };
}

function scheduleInterruptProjectionDeadline(childId: string): void {
  clearInterruptProjectionTimer(childId);
  interruptProjectionTimers.set(childId, setTimeout(() => {
    interruptProjectionTimers.delete(childId);
    const feedback = interruptFeedback.value[childId];
    if (!feedback || feedback.phase !== 'committed') return;
    setInterruptFeedback(childId, {
      ...feedback,
      phase: 'failed',
      message: '终止已提交，但状态尚未同步；可重试或重载窗口'
    });
  }, 30_000));
}

function clearInterruptProjectionTimer(childId: string): void {
  const timer = interruptProjectionTimers.get(childId);
  if (timer) clearTimeout(timer);
  interruptProjectionTimers.delete(childId);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
</script>

<template>
  <section class="agent-status-panel" data-testid="reliable-agent-status-panel">
    <button
      type="button"
      class="agent-status-summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <IconChevronDown v-if="expanded" class="agent-status-caret" aria-hidden="true" />
      <IconChevronRight v-else class="agent-status-caret" aria-hidden="true" />
      <IconRobot class="agent-status-icon" aria-hidden="true" />
      <span class="agent-status-name">{{ projection.currentAgentName }}</span>
      <span class="agent-status-main-state">{{ currentStatus }}</span>
      <span v-if="projection.children.length" class="agent-status-count">{{ projection.children.length }} 个子 Agent</span>
    </button>
    <div v-if="expanded" class="agent-status-groups">
      <template v-for="group in groups" :key="group.id">
        <section v-if="childrenIn(group.id).length" class="agent-status-group">
          <h4>{{ group.label }} · {{ childrenIn(group.id).length }}</h4>
          <div v-for="child in childrenIn(group.id)" :key="child.id" class="agent-status-child">
            <div class="agent-status-child-head">
              <span class="agent-status-child-name">{{ child.agentName }}</span>
              <span class="agent-status-lifecycle">{{ child.lifecycleLabel }}</span>
              <span v-if="deliveryLabel(child)" class="agent-status-delivery" :class="`is-${child.deliveryBadge}`">{{ deliveryLabel(child) }}</span>
              <button
                v-if="child.interruptible || child.lifecycle === 'interrupting' || interruptFeedback[child.id]"
                type="button"
                class="agent-status-stop"
                :disabled="interruptButtonDisabled(child)"
                :title="`${interruptButtonLabel(child)}：终止该 Agent 及其启动的所有子 Agent`"
                :aria-label="`${interruptButtonLabel(child)} ${child.agentName}`"
                @click="interruptChild(child)"
              >
                <IconPlayerStop aria-hidden="true" />
                <span>{{ interruptButtonLabel(child) }}</span>
              </button>
            </div>
            <p v-if="child.activitySummary" class="agent-status-activity">
              <span>当前</span>{{ child.activitySummary }}
            </p>
            <p v-if="taskTitle(child)" class="agent-status-task"><span>任务</span>{{ taskTitle(child) }}</p>
            <p v-if="interruptError(child)" class="agent-status-error" role="status">{{ interruptError(child) }}</p>
          </div>
        </section>
      </template>
      <p v-if="projection.children.length === 0" class="agent-status-empty">暂无子 Agent。</p>
    </div>
  </section>
</template>

<style scoped>
.agent-status-panel {
  width: 100%;
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.agent-status-summary {
  width: 100%;
  min-height: 26px;
  padding: 3px var(--space-2);
  display: flex;
  align-items: center;
  gap: var(--space-1);
  border: 0;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.agent-status-summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
.agent-status-caret, .agent-status-icon { width: 14px; height: 14px; flex: 0 0 auto; }
.agent-status-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.agent-status-main-state { color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.agent-status-count { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.agent-status-groups { padding: 0 var(--space-2) var(--space-2); display: grid; gap: var(--space-2); }
.agent-status-group h4 { margin: 0 0 3px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); font-weight: 600; }
.agent-status-child { min-width: 0; padding: 3px 0; font-size: var(--font-size-sm); }
.agent-status-child + .agent-status-child { border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border, transparent) 55%, transparent); }
.agent-status-child-head { display: flex; align-items: center; gap: var(--space-1); min-height: 22px; }
.agent-status-child-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-status-lifecycle { color: var(--vscode-descriptionForeground); }
.agent-status-delivery { padding: 0 4px; border-radius: 999px; color: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, currentColor 12%, transparent); }
.agent-status-delivery.is-delivery_failed { color: var(--vscode-errorForeground, #f48771); }
.agent-status-stop { margin-left: auto; min-height: 20px; padding: 1px 5px; display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--vscode-panel-border, transparent); border-radius: var(--radius-sm); color: var(--vscode-descriptionForeground); background: transparent; font: inherit; }
.agent-status-stop svg { width: 12px; height: 12px; }
.agent-status-stop:not(:disabled):hover, .agent-status-stop:not(:disabled):focus-visible { color: var(--vscode-errorForeground, #f48771); border-color: currentColor; background: color-mix(in srgb, currentColor 9%, transparent); }
.agent-status-stop:disabled { opacity: .62; cursor: default; }
.agent-status-activity, .agent-status-task, .agent-status-error { min-width: 0; margin: 2px 0 0; display: flex; gap: var(--space-1); line-height: 1.35; }
.agent-status-activity { color: var(--vscode-foreground); }
.agent-status-task { color: var(--vscode-descriptionForeground); }
.agent-status-activity span, .agent-status-task span { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
.agent-status-error { color: var(--vscode-errorForeground, #f48771); }
.agent-status-empty { margin: 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
</style>

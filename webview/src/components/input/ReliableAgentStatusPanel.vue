<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { IconChevronDown, IconChevronRight, IconRobot } from '@tabler/icons-vue';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import {
  projectReliableAgentStatus,
  type ReliableChildAgentGroup,
  type ReliableChildAgentStatus
} from '@webview/domain/reliableAgentStatusProjection';

const reliableConversation = useReliableConversation();
const agentStore = useAgentStore();
const { interruptPhase } = useChat();
const expanded = ref(false);
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
    ? '等待主 Agent'
    : child.deliveryBadge === 'delivery_failed' ? '交付失败' : undefined;
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
      <span v-if="projection.children.length" class="agent-status-count">{{ projection.children.length }} child</span>
    </button>
    <div v-if="expanded" class="agent-status-groups">
      <section v-for="group in groups" v-show="childrenIn(group.id).length" :key="group.id" class="agent-status-group">
        <h4>{{ group.label }} · {{ childrenIn(group.id).length }}</h4>
        <div v-for="child in childrenIn(group.id)" :key="child.id" class="agent-status-child">
          <span class="agent-status-child-name">{{ child.agentName }}</span>
          <span class="agent-status-lifecycle">{{ child.lifecycleLabel }}</span>
          <span v-if="deliveryLabel(child)" class="agent-status-delivery" :class="`is-${child.deliveryBadge}`">{{ deliveryLabel(child) }}</span>
          <span v-if="taskTitle(child)" class="agent-status-task">{{ taskTitle(child) }}</span>
        </div>
      </section>
      <p v-if="projection.children.length === 0" class="agent-status-empty">暂无直接 child Agent。</p>
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
.agent-status-child { display: grid; grid-template-columns: minmax(72px, auto) auto auto minmax(0, 1fr); align-items: center; gap: var(--space-1); min-height: 22px; font-size: var(--font-size-sm); }
.agent-status-child-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-status-lifecycle { color: var(--vscode-descriptionForeground); }
.agent-status-delivery { padding: 0 4px; border-radius: 999px; color: var(--vscode-editorWarning-foreground, #cca700); background: color-mix(in srgb, currentColor 12%, transparent); }
.agent-status-delivery.is-delivery_failed { color: var(--vscode-errorForeground, #f48771); }
.agent-status-task { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.agent-status-empty { margin: 0; color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
</style>

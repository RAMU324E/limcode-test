<script setup lang="ts">
import { computed, reactive } from 'vue';
import { IconAlertTriangle, IconLoader2, IconRefresh } from '@tabler/icons-vue';
import type { OutcomeUnknownOperationRecord } from '@shared/protocol';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useConversationCommandStore, type PendingConversationCommandRecord } from '@webview/stores/useConversationCommandStore';

interface ResolutionDraft {
  evidenceRef: string;
  verifiedResult: string;
  error?: string;
}

const clientState = useClientStateStore();
const timeline = useConversationTimelineStore();
const commands = useConversationCommandStore();
const drafts = reactive<Record<string, ResolutionDraft>>({});

const conversationId = computed(() => clientState.currentConversationId.trim());
const conversationCommands = computed(() => commands.pendingCommands.filter((command) => command.conversationId === conversationId.value));
const activeCommands = computed(() => conversationCommands.value.filter((command) => command.kind !== 'start'
  && command.phase !== 'blocked'
  && command.phase !== 'outcome_unknown'
  && command.phase !== 'partial_success'
  && command.phase !== 'projection_recovery'));
const blockedCommands = computed(() => conversationCommands.value.filter((command) => command.phase === 'blocked'
  || command.phase === 'outcome_unknown'
  || command.phase === 'partial_success'
  || command.phase === 'projection_recovery'));
const interactionNotices = computed(() => Object.values(commands.interactionNotices)
  .filter((notice) => notice.conversationId === conversationId.value)
  .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)));
const interruptNotices = computed(() => Object.values(commands.interruptNotices)
  .filter((notice) => notice.conversationId === conversationId.value)
  .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)));
const unknownOperations = computed(() => {
  const stateRuns = [...clientState.agentRuns, ...timeline.currentTimeline.state.agentRuns];
  const targets = [...clientState.agentRunTargetLinks, ...timeline.currentTimeline.state.agentRunTargetLinks];
  const runIds = new Set(targets.filter((target) => target.conversationId === conversationId.value).map((target) => target.runId));
  const byOperation = new Map<string, OutcomeUnknownOperationRecord>();
  for (const run of stateRuns) {
    if (!runIds.has(run.id)) continue;
    for (const operation of run.outcomeUnknownOperations ?? []) byOperation.set(operation.operationId, operation);
  }
  return [...byOperation.values()].sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId));
});
const visible = computed(() => activeCommands.value.length > 0
  || blockedCommands.value.length > 0
  || unknownOperations.value.length > 0
  || interruptNotices.value.length > 0
  || interactionNotices.value.length > 0);

function draftFor(operationId: string): ResolutionDraft {
  return drafts[operationId] ?? (drafts[operationId] = { evidenceRef: '', verifiedResult: '' });
}

function resolveRestart(operation: OutcomeUnknownOperationRecord): void {
  const draft = draftFor(operation.operationId);
  const evidenceRef = draft.evidenceRef.trim();
  if (!evidenceRef) {
    draft.error = '请填写能够证明副作用未执行的证据引用。';
    return;
  }
  draft.error = undefined;
  commands.resolveUnknownOutcome(conversationId.value, operation.operationId, 'restart_proved_not_executed', { evidenceRef });
}

function resolveVerified(operation: OutcomeUnknownOperationRecord): void {
  const draft = draftFor(operation.operationId);
  const evidenceRef = draft.evidenceRef.trim();
  const raw = draft.verifiedResult.trim();
  if (!evidenceRef || !raw) {
    draft.error = '请填写验证证据和已确认的工具结果。';
    return;
  }
  let verifiedResult: unknown;
  try { verifiedResult = JSON.parse(raw); }
  catch { verifiedResult = raw; }
  draft.error = undefined;
  commands.resolveUnknownOutcome(conversationId.value, operation.operationId, 'submit_verified_result', { evidenceRef, verifiedResult });
}

function resolveAbandon(operation: OutcomeUnknownOperationRecord): void {
  draftFor(operation.operationId).error = undefined;
  commands.resolveUnknownOutcome(conversationId.value, operation.operationId, 'abandon');
}

function isResolving(operationId: string): boolean {
  return commands.isTargetPending(conversationId.value, operationId, 'resolution');
}

function isKnownDurableFailure(command: PendingConversationCommandRecord): boolean {
  return command.phase === 'blocked' && command.error?.durable === true;
}

function commandLabel(command: PendingConversationCommandRecord): string {
  const labels: Record<PendingConversationCommandRecord['kind'], string> = {
    start: '开始新回合',
    enqueue: '加入消息队列',
    steer: '引导当前回合',
    interrupt: '中断当前回合',
    intent_control: '更新消息队列',
    promote: '立即执行排队消息',
    delete: '删除消息',
    retry: '重试消息',
    edit: '编辑消息',
    resolution: '提交恢复决策'
  };
  return labels[command.kind];
}

function phaseLabel(command: PendingConversationCommandRecord): string {
  switch (command.phase) {
    case 'submitting': return '正在提交';
    case 'awaiting_result': return '等待持久化结果';
    case 'committed_waiting_patch': return '已提交，等待状态同步';
    case 'querying_status': return '正在查询持久结果';
    case 'blocked': {
      switch (command.error?.code) {
        case 'runtime_unavailable': return '运行时不可用';
        case 'integrity_violation': return '数据完整性错误';
        case 'migration_required': return '开发数据需要重置';
        default: return '存储暂不可用';
      }
    }
    case 'outcome_unknown': return '命令结果待确认';
    case 'partial_success': return '工作区恢复成功，对话未变更';
    case 'projection_recovery': return '已提交，页面状态需要恢复';
  }
}
</script>

<template>
  <section v-if="visible" class="reliability-panel" aria-live="polite">
    <div v-if="activeCommands.length" class="reliability-active-row">
      <IconLoader2 class="reliability-spin" aria-hidden="true" />
      <span>{{ activeCommands.length === 1 ? commandLabel(activeCommands[0]) : `${activeCommands.length} 个操作` }}</span>
      <span class="reliability-muted">{{ activeCommands.length === 1 ? phaseLabel(activeCommands[0]) : '正在持久化并同步' }}</span>
    </div>

    <article v-for="notice in interactionNotices" :key="notice.id" class="reliability-card reliability-card-warning">
      <div class="reliability-card-heading">
        <IconAlertTriangle aria-hidden="true" />
        <strong>{{ notice.status === 'stale' ? '操作目标状态已变化' : notice.status === 'outcome_unknown' ? '操作结果待恢复' : '操作未完成' }}</strong>
      </div>
      <p>{{ notice.message }}</p>
      <button type="button" class="reliability-button" @click="commands.dismissInteractionNotice(notice.id)">已知晓</button>
    </article>

    <article v-for="notice in interruptNotices" :key="notice.id" class="reliability-card reliability-card-warning">
      <div class="reliability-card-heading">
        <IconAlertTriangle aria-hidden="true" />
        <strong>{{ notice.status === 'target_replaced' ? 'Stop 目标已变化' : '前台回合已中断，后台子 Agent 仍在继续' }}</strong>
      </div>
      <p>{{ notice.message }}</p>
      <button type="button" class="reliability-button" @click="commands.dismissInterruptNotice(notice.id)">已知晓</button>
    </article>

    <article v-for="command in blockedCommands" :key="command.commandId" class="reliability-card reliability-card-warning">
      <div class="reliability-card-heading">
        <IconAlertTriangle aria-hidden="true" />
        <strong>{{ commandLabel(command) }} · {{ phaseLabel(command) }}</strong>
      </div>
      <p>{{ command.finalMessage ?? command.error?.message ?? '尚未取得可证明的最终结果，本地操作状态已保留。' }}</p>
      <button v-if="command.phase !== 'partial_success' && !isKnownDurableFailure(command)" type="button" class="reliability-button" @click="commands.queryStatus(command.commandId)">
        <IconRefresh aria-hidden="true" />{{ command.phase === 'projection_recovery' ? '重新同步当前会话' : '重新查询持久结果' }}
      </button>
      <button v-else type="button" class="reliability-button" @click="commands.dismiss(command.commandId)">
        {{ isKnownDurableFailure(command) ? '已知晓并解除本地记录' : '已知晓' }}
      </button>
    </article>

    <article v-for="operation in unknownOperations" :key="operation.operationId" class="reliability-card reliability-card-danger">
      <div class="reliability-card-heading">
        <IconAlertTriangle aria-hidden="true" />
        <strong>外部副作用结果未知</strong>
      </div>
      <p>操作 {{ operation.operationId }} 不会自动重试。请选择有证据支持的恢复方式。</p>
      <label v-if="operation.allowedResolutions.some((item) => item !== 'abandon')" class="reliability-field">
        <span>证据引用</span>
        <input v-model="draftFor(operation.operationId).evidenceRef" type="text" placeholder="日志、远端任务 ID 或人工核验记录" :disabled="isResolving(operation.operationId)" />
      </label>
      <label v-if="operation.allowedResolutions.includes('submit_verified_result')" class="reliability-field">
        <span>已确认结果（JSON 或文本）</span>
        <textarea v-model="draftFor(operation.operationId).verifiedResult" rows="2" :disabled="isResolving(operation.operationId)" />
      </label>
      <p v-if="draftFor(operation.operationId).error" class="reliability-error">{{ draftFor(operation.operationId).error }}</p>
      <div class="reliability-actions">
        <button v-if="operation.allowedResolutions.includes('restart_proved_not_executed')" type="button" class="reliability-button" :disabled="isResolving(operation.operationId)" @click="resolveRestart(operation)">确认未执行并重启</button>
        <button v-if="operation.allowedResolutions.includes('submit_verified_result')" type="button" class="reliability-button" :disabled="isResolving(operation.operationId)" @click="resolveVerified(operation)">提交已验证结果</button>
        <button v-if="operation.allowedResolutions.includes('abandon')" type="button" class="reliability-button reliability-button-danger" :disabled="isResolving(operation.operationId)" @click="resolveAbandon(operation)">放弃并终止 Run</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.reliability-panel {
  display: grid;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--vscode-foreground);
  font-size: 12px;
}
.reliability-active-row,
.reliability-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 7px;
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-focusBorder) 12%);
}
.reliability-active-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 9px;
}
.reliability-muted { color: var(--vscode-descriptionForeground); }
.reliability-spin { width: 14px; animation: reliability-spin 1s linear infinite; }
.reliability-card { padding: 9px; }
.reliability-card-warning { border-color: var(--vscode-editorWarning-foreground); }
.reliability-card-danger { border-color: var(--vscode-editorError-foreground); }
.reliability-card-heading { display: flex; align-items: center; gap: 6px; }
.reliability-card-heading svg { width: 15px; }
.reliability-card p { margin: 7px 0; color: var(--vscode-descriptionForeground); }
.reliability-field { display: grid; gap: 4px; margin-top: 7px; }
.reliability-field input,
.reliability-field textarea {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
  padding: 6px 7px;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  resize: vertical;
}
.reliability-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.reliability-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 4px;
  padding: 5px 8px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  cursor: pointer;
}
.reliability-button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.reliability-button:disabled { opacity: .55; cursor: default; }
.reliability-button svg { width: 13px; }
.reliability-button-danger { background: var(--vscode-inputValidation-errorBackground, var(--vscode-button-background)); }
.reliability-error { color: var(--vscode-editorError-foreground) !important; }
@keyframes reliability-spin { to { transform: rotate(360deg); } }
</style>

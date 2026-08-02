<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconTerminal2, IconX } from '@tabler/icons-vue';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import {
  parseShellCallArgs,
  type ShellArgs
} from '@webview/components/content/toolDisplay/shellToolModel';

interface CommandEntry {
  processId: string;
  toolCallId: string;
  shell: string;
  command: string;
  commandState: 'loading' | 'ready' | 'empty' | 'error';
  cwd?: string;
  foregroundWaitMs?: number;
  mode: string;
  accessLabel: string;
  status: string;
  statusLabel: string;
  statusTone: 'running' | 'done' | 'warning' | 'error';
  stdout: string;
  stderr: string;
  progress: string;
  droppedChars?: number;
  exitCode?: number;
  killed?: boolean;
  running: boolean;
  outputAvailable: boolean;
  callCount: number;
  startedAt: number;
  updatedAt: number;
}

type ReliableRecord = Record<string, unknown>;

const reliableConversation = useReliableConversation();
const open = ref(false);
const selectedProcessId = ref<string>();
const rootRef = ref<HTMLElement | null>(null);
const listScroller = ref<HTMLElement | null>(null);
const detailScroller = ref<HTMLElement | null>(null);
let outputRefreshTimer: ReturnType<typeof setInterval> | undefined;

const entries = computed<CommandEntry[]>(buildCommandEntries);
const runningCount = computed(() => entries.value.filter((entry) => entry.statusTone === 'running').length);
const selectedEntry = computed(() => entries.value.find((entry) => entry.processId === selectedProcessId.value) ?? entries.value[0]);
const panelSummary = computed(() => {
  if (entries.value.length === 0) return '暂无后台命令';
  return runningCount.value > 0
    ? `${runningCount.value} 个运行中 / ${entries.value.length} 个后台命令`
    : `${entries.value.length} 个后台命令`;
});
const detailRefreshKey = computed(() => `${selectedEntry.value?.processId ?? 'none'}:${selectedEntry.value?.updatedAt ?? 0}:${selectedEntry.value?.stdout.length ?? 0}:${selectedEntry.value?.stderr.length ?? 0}`);

watch(entries, (nextEntries) => {
  if (nextEntries.length === 0) {
    selectedProcessId.value = undefined;
    return;
  }
  if (!selectedProcessId.value || !nextEntries.some((entry) => entry.processId === selectedProcessId.value)) {
    selectedProcessId.value = nextEntries[0]?.processId;
  }
}, { immediate: true });

watch(open, (isOpen) => {
  if (!isOpen) return;
  void nextTick(() => {
    listScroller.value?.scrollTo({ top: 0 });
    detailScroller.value?.scrollTo({ top: 0 });
  });
});

watch(
  () => open.value && selectedEntry.value?.running === true,
  (shouldRefresh) => {
    if (outputRefreshTimer !== undefined) clearInterval(outputRefreshTimer);
    outputRefreshTimer = undefined;
    if (!shouldRefresh) return;
    outputRefreshTimer = setInterval(ensureOutputDetails, 1_000);
  },
  { immediate: true }
);

watch(
  () => {
    const process = reliableConversation.feed.records.Process?.[selectedProcessId.value ?? ''];
    return `${open.value ? 'open' : 'closed'}:${selectedProcessId.value ?? ''}:${decimal(process?.retained_chunks) ?? '0'}:${text(process?.updated_at) ?? ''}`;
  },
  ensureOutputDetails,
  { immediate: true }
);

watch(
  () => `${open.value ? 'open' : 'closed'}:${selectedEntry.value?.toolCallId ?? ''}`,
  ensureCommandDetail,
  { immediate: true }
);

onMounted(() => document.addEventListener('pointerdown', onDocumentPointerDown, true));
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  if (outputRefreshTimer !== undefined) clearInterval(outputRefreshTimer);
});

function toggleOpen(): void {
  open.value = !open.value;
}

function closePanel(): void {
  open.value = false;
}

function selectEntry(entry: CommandEntry): void {
  selectedProcessId.value = entry.processId;
  void nextTick(() => detailScroller.value?.scrollTo({ top: 0 }));
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (target instanceof Node && rootRef.value?.contains(target)) return;
  open.value = false;
}

function ensureOutputDetails(): void {
  if (!open.value || !selectedProcessId.value) return;
  for (const kind of ['process-stdout', 'process-stderr'] as const) {
    const key = reliableKernelDetailKey(kind, selectedProcessId.value);
    if (reliableConversation.feed.details[key]?.status === 'ready') {
      reliableConversation.feed.refreshDetail(kind, selectedProcessId.value, { priority: 'expanded' });
    } else {
      reliableConversation.feed.requestDetail(kind, selectedProcessId.value, { priority: 'expanded' });
    }
  }
}

function ensureCommandDetail(): void {
  if (!open.value) return;
  const toolCallId = selectedEntry.value?.toolCallId;
  if (toolCallId) reliableConversation.feed.requestDetail('tool-arguments-content', toolCallId, { priority: 'expanded' });
}

function buildCommandEntries(): CommandEntry[] {
  const records = reliableConversation.feed.records;
  const origins = new Map(Object.values(records.ProcessOriginLink ?? {})
    .map((link) => [text(link.process_id), text(link.tool_call_id)] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])));
  const calls = new Map(reliableConversation.projection.value.toolCalls.map((call) => [call.id, call]));
  const receipts = new Map<string, ReliableRecord>();
  for (const receipt of Object.values(records.ProcessReceipt ?? {})) {
    const processId = text(receipt.process_id);
    if (processId) receipts.set(processId, receipt);
  }
  return Object.values(records.Process ?? {})
    .flatMap((process): CommandEntry[] => {
      const processId = text(process.id);
      const status = text(process.status);
      const backgroundKind = text(process.background_kind);
      const toolCallId = origins.get(processId ?? '');
      if (!processId || !status || !toolCallId || (backgroundKind !== 'requested' && backgroundKind !== 'detached')) return [];
      const call = calls.get(toolCallId);
      const argumentDetail = reliableConversation.feed.details[
        reliableKernelDetailKey('tool-arguments-content', toolCallId)
      ];
      const args = argumentDetail?.status === 'ready'
        ? parseShellCallArgs(argumentDetail.text)
        : {} as ShellArgs;
      const command = args.command?.trim();
      const commandState: CommandEntry['commandState'] = argumentDetail?.status === 'error'
        || process.command_arguments_state === 'error'
        ? 'error'
        : argumentDetail?.status !== 'ready'
          ? 'loading'
          : command ? 'ready' : 'empty';
      const output = processId === selectedProcessId.value
        ? materializeOutput(processId)
        : { stdout: '', stderr: '', loading: false };
      const receipt = receipts.get(processId);
      const exitCode = signedInteger(receipt?.exit_code);
      const running = status === 'running';
      const killed = status === 'cancelled' || receipt?.outcome === 'cancelled';
      return [{
        processId,
        toolCallId,
        shell: call?.name ?? 'shell',
        command: commandState === 'error'
          ? '(命令正文读取失败)'
          : commandState === 'loading'
            ? '(命令正文加载中…)'
            : command || '(未记录命令正文)',
        commandState,
        ...(args.cwd ? { cwd: args.cwd } : {}),
        ...(args.foregroundWaitMs !== undefined ? { foregroundWaitMs: args.foregroundWaitMs } : {}),
        mode: args.mode ?? 'execute',
        accessLabel: readonlyLabel(args),
        status,
        statusLabel: statusLabel(status, exitCode, killed),
        statusTone: statusTone(status, exitCode),
        stdout: output.stdout,
        stderr: output.stderr,
        progress: output.loading ? '输出分片加载中…' : '',
        ...(nonNegativeInteger(process.dropped_bytes) !== undefined
          ? { droppedChars: nonNegativeInteger(process.dropped_bytes) }
          : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(killed ? { killed: true } : {}),
        running,
        outputAvailable: (nonNegativeInteger(process.retained_bytes) ?? 0) > 0 || running,
        callCount: 1,
        startedAt: timestamp(process.started_at),
        updatedAt: timestamp(process.updated_at)
      }];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt || right.startedAt - left.startedAt || left.processId.localeCompare(right.processId));
}

function materializeOutput(processId: string): { stdout: string; stderr: string; loading: boolean } {
  const stdout = reliableConversation.feed.details[reliableKernelDetailKey('process-stdout', processId)];
  const stderr = reliableConversation.feed.details[reliableKernelDetailKey('process-stderr', processId)];
  return {
    stdout: stdout?.status === 'ready' || stdout?.status === 'loading' ? stdout.text : '',
    stderr: stderr?.status === 'ready' || stderr?.status === 'loading' ? stderr.text : '',
    loading: stdout?.status === 'loading' || stderr?.status === 'loading'
  };
}

function readonlyLabel(args: ShellArgs): string {
  return args.readonly?.trim().toLowerCase() === 'true' ? '只读' : '读写';
}

function statusLabel(status: string, exitCode: number | undefined, killed: boolean): string {
  if (status === 'running') return '运行中';
  if (killed) return '已终止';
  if (status === 'outcome_unknown') return '结果未知';
  if (exitCode !== undefined && exitCode !== 0) return '异常终止';
  if (status === 'exited') return '已退出';
  return status || '未知';
}

function statusTone(status: string, exitCode: number | undefined): CommandEntry['statusTone'] {
  if (status === 'running') return 'running';
  if (status === 'outcome_unknown' || status === 'cancelled') return 'warning';
  if (exitCode !== undefined && exitCode !== 0) return 'error';
  return 'done';
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function commandPreview(entry: CommandEntry): string {
  return middleEllipsis(entry.command || '(无命令文本)', 92);
}

function middleEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(8, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function decimal(value: unknown): string | undefined {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : undefined;
}

function signedInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^-?(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = signedInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

</script>



<template>
  <div ref="rootRef" class="background-command-root">
    <button
      type="button"
      class="background-command-trigger"
      :class="{ 'is-active': open, 'has-running': runningCount > 0 }"
      aria-label="后台命令管理"
      :aria-expanded="open"
      @click.stop="toggleOpen"
    >
      <IconTerminal2 class="background-command-trigger-icon" stroke="2" aria-hidden="true" />
      <span v-if="entries.length" class="background-command-count">{{ entries.length }}</span>
    </button>

    <section v-if="open" class="background-command-panel" role="dialog" aria-label="后台命令管理面板">
      <header class="background-command-header">
        <div class="background-command-title">
          <span>后台命令</span>
          <span>{{ panelSummary }}</span>
        </div>
        <button type="button" class="background-command-close" aria-label="关闭后台命令面板" @click="closePanel">
          <IconX stroke="2" aria-hidden="true" />
        </button>
      </header>

      <div v-if="entries.length" class="background-command-body">
        <div class="background-command-list-shell">
          <div ref="listScroller" class="background-command-list">
            <button
              v-for="entry in entries"
              :key="entry.processId"
              type="button"
              class="background-command-item"
              :class="{ 'is-selected': selectedEntry?.processId === entry.processId }"
              @click="selectEntry(entry)"
            >
              <span class="background-command-item-top">
                <span class="command-status" :class="`is-${entry.statusTone}`">{{ entry.statusLabel }}</span>
                <span class="command-shell">{{ entry.shell }}</span>
              </span>
              <span class="command-preview">{{ commandPreview(entry) }}</span>
              <span class="command-subline">{{ entry.accessLabel }} · {{ formatTime(entry.startedAt) }} · {{ entry.processId }}</span>
            </button>
          </div>
          <AdvancedScrollbar :scroller="listScroller" :refresh-key="entries.length" variant="minimal" />
        </div>

        <article v-if="selectedEntry" class="background-command-detail">
          <header class="command-detail-header">
            <span class="command-status" :class="`is-${selectedEntry.statusTone}`">{{ selectedEntry.statusLabel }}</span>
            <span class="command-detail-id">{{ selectedEntry.processId }}</span>
          </header>
          <div class="command-detail-scroll-shell">
            <div ref="detailScroller" class="command-detail-scroll">
              <section class="command-detail-section">
                <h3>输入命令</h3>
                <pre>{{ selectedEntry.command || '(无命令文本)' }}</pre>
              </section>

              <section class="command-detail-section">
                <h3>输出日志</h3>
                <pre v-if="selectedEntry.stdout" class="command-log is-stdout">{{ selectedEntry.stdout }}</pre>
                <pre v-if="selectedEntry.stderr" class="command-log is-stderr">{{ selectedEntry.stderr }}</pre>
                <pre v-if="selectedEntry.progress" class="command-log is-progress">{{ selectedEntry.progress }}</pre>
                <p v-if="!selectedEntry.stdout && !selectedEntry.stderr && !selectedEntry.progress" class="command-empty-text">暂无已同步输出。</p>
              </section>

              <section class="command-detail-section">
                <h3>参数</h3>
                <dl class="command-param-grid">
                  <dt>Shell</dt><dd>{{ selectedEntry.shell }}</dd>
                  <dt>模式</dt><dd>{{ selectedEntry.mode }}</dd>
                  <dt>权限</dt><dd>{{ selectedEntry.accessLabel }}</dd>
                  <dt>工作目录</dt><dd>{{ selectedEntry.cwd || '-' }}</dd>
                  <dt>前台等待</dt><dd>{{ selectedEntry.foregroundWaitMs === undefined ? '-' : `${selectedEntry.foregroundWaitMs}ms` }}</dd>
                  <dt>调用次数</dt><dd>{{ selectedEntry.callCount }}</dd>
                  <dt>开始</dt><dd>{{ formatTime(selectedEntry.startedAt) }}</dd>
                  <dt>更新</dt><dd>{{ formatTime(selectedEntry.updatedAt) }}</dd>
                  <dt>Exit Code</dt><dd>{{ selectedEntry.exitCode === undefined ? '-' : selectedEntry.exitCode }}</dd>
                  <dt>Killed</dt><dd>{{ selectedEntry.killed === undefined ? '-' : selectedEntry.killed }}</dd>
                  <dt>Dropped</dt><dd>{{ selectedEntry.droppedChars === undefined ? '-' : selectedEntry.droppedChars }}</dd>
                </dl>
              </section>
            </div>
            <AdvancedScrollbar :scroller="detailScroller" :refresh-key="detailRefreshKey" variant="minimal" />
          </div>
        </article>
      </div>

      <div v-else class="background-command-empty">暂无后台命令。</div>
    </section>
  </div>
</template>

<style scoped>
.background-command-root {
  position: relative;
  flex: 0 0 auto;
}

.background-command-trigger {
  position: relative;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.background-command-trigger:hover,
.background-command-trigger:focus-visible,
.background-command-trigger.is-active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.background-command-trigger.has-running .background-command-trigger-icon {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.background-command-trigger-icon {
  width: 16px;
  height: 16px;
}

.background-command-count {
  position: absolute;
  right: -2px;
  bottom: -2px;
  min-width: 13px;
  height: 13px;
  padding: 0 3px;
  border: 1px solid var(--vscode-editor-background);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 68%, var(--vscode-editor-background) 32%);
  font-size: 9px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.background-command-panel {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  z-index: 40;
  width: min(760px, calc(100vw - 58px));
  height: min(430px, calc(100vh - 120px));
  min-height: 260px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.34);
  overflow: hidden;
}

.background-command-header {
  min-height: 38px;
  padding: 7px 8px 7px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.background-command-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: var(--font-size-sm);
  line-height: 1.25;
}

.background-command-title span:first-child {
  font-weight: 600;
}

.background-command-title span:last-child {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.background-command-close {
  width: 24px;
  height: 24px;
  min-width: 24px;
  min-height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.background-command-close:hover,
.background-command-close:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border, transparent);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.background-command-close svg {
  width: 15px;
  height: 15px;
}

.background-command-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
}

.background-command-list-shell,
.command-detail-scroll-shell {
  position: relative;
  min-height: 0;
}

.background-command-list-shell {
  border-right: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
}

.background-command-list,
.command-detail-scroll {
  height: 100%;
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
}

.background-command-list::-webkit-scrollbar,
.command-detail-scroll::-webkit-scrollbar {
  display: none;
}

.background-command-list {
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.background-command-item {
  width: 100%;
  min-height: 70px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  color: var(--vscode-foreground);
  background: transparent;
  text-align: left;
}

.background-command-item:hover,
.background-command-item:focus-visible,
.background-command-item.is-selected {
  border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.background-command-item.is-selected {
  box-shadow: inset 2px 0 0 var(--vscode-editorWarning-foreground, #cca700);
}

.background-command-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.command-status {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.25;
}

.command-status.is-running {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.command-status.is-done {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.command-status.is-warning {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.command-status.is-error {
  color: var(--vscode-errorForeground);
}

.command-shell,
.command-subline,
.command-detail-id {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.command-preview,
.command-subline {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-preview {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.background-command-detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.command-detail-header {
  min-height: 32px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
  display: flex;
  align-items: center;
  gap: 8px;
}

.command-detail-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.command-log-consume {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.36));
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font-size: var(--font-size-xs);
}

.command-log-consume:hover,
.command-log-consume:focus-visible {
  color: var(--vscode-errorForeground);
  border-color: color-mix(in srgb, var(--vscode-errorForeground) 55%, var(--vscode-panel-border) 45%);
  background: color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent);
  outline: none;
}

.command-detail-scroll-shell {
  flex: 1 1 auto;
}

.command-detail-scroll {
  padding: 10px 12px 12px;
}

.command-detail-section + .command-detail-section {
  margin-top: 12px;
}

.command-detail-section h3 {
  margin: 0 0 5px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.35;
}

.command-detail-section pre,
.command-log {
  margin: 0;
  padding: 8px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.command-log + .command-log {
  margin-top: 6px;
}

.command-log.is-stderr {
  color: var(--vscode-errorForeground);
}

.command-log.is-progress {
  color: var(--vscode-descriptionForeground);
}

.command-empty-text,
.background-command-empty {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.command-param-grid {
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 10px;
  font-size: var(--font-size-xs);
  line-height: 1.45;
}

.command-param-grid dt {
  color: var(--vscode-descriptionForeground);
}

.command-param-grid dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
}

.background-command-empty {
  padding: 16px;
}

@media (max-width: 560px) {
  .background-command-panel {
    right: 0;
    width: min(420px, calc(100vw - 24px));
  }

  .background-command-body {
    grid-template-columns: 1fr;
  }

  .background-command-list-shell {
    height: 150px;
    border-right: 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  }
}
</style>

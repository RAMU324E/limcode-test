<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IconPlayerRecord, IconPlayerStop, IconRefresh, IconFolder, IconDownload, IconSearch, IconTrash } from '@tabler/icons-vue';
import { createMessageId } from '@shared/protocol';
import type { DebugCaptureSettings, DebugCaptureStopReason } from '@shared/debugCapture';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useDebugCaptureStore } from '@webview/stores/useDebugCaptureStore';
import { useReliableKernelClientFeedStore } from '@webview/stores/useReliableKernelClientFeedStore';
import SettingsDropdown from './SettingsDropdown.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const settings = useGlobalSettingsStore();
const capture = useDebugCaptureStore();
const feed = useReliableKernelClientFeedStore();
const deleting = ref('');
const analysisScroller = ref<HTMLElement | null>(null);
const active = computed(() => capture.state?.active?.status !== 'sealed' ? capture.state?.active : undefined);
const conversationId = computed(() => {
  const window = feed.projections.activeConversationWindow as { conversationId?: unknown } | undefined;
  return typeof window?.conversationId === 'string' ? window.conversationId : undefined;
});
const scopes = [{ value: 'conversation', label: '当前对话' }, { value: 'workspace', label: '当前工作区全部对话' }];
const sizes = [8, 16, 32].map(value => ({ value: String(value), label: `${value} 兆` }));
const durations = [5, 15, 30].map(value => ({ value: String(value), label: `${value} 分钟` }));
const reasons: Record<DebugCaptureStopReason, string> = { user: '手动停止', time_limit: '达到时长上限', size_limit: '达到容量上限', memory_limit: '记录缓冲已满', write_failed: '写入失败', root_changed: '目录已切换', host_closed: '扩展已关闭', interrupted: '异常中断' };
const levelNames = { evidence: '事实', inference: '推断', unknown: '尚无法判断' };
const busy = computed(() => Boolean(capture.pending));
const choicesDisabled = computed(() => busy.value || Boolean(active.value) || Boolean(settings.pendingSettingsSections.debugCapture));
const bytes = (value: number) => `${(value / 1048576).toFixed(2)} 兆`;
function change(patch: Partial<DebugCaptureSettings>): void { settings.setDebugCaptureSettings(patch); }
function start(): void { capture.command({ action: 'start', commandId: createMessageId(), ...(conversationId.value ? { conversationId: conversationId.value } : {}) }); }
function remove(): void { const runId = deleting.value; deleting.value = ''; capture.command({ action: 'delete', runId }); }
onMounted(() => { settings.ensureDebugCaptureSettings(); capture.command({ action: 'status' }); });
</script>

<template>
  <section class="debug-settings" aria-label="流式输出调试">
    <header class="debug-heading"><h3>流式输出调试</h3><span :class="{ recording: active }">{{ active ? (active.status === 'stopping' ? '正在封存' : '正在记录') : '已关闭' }}</span></header>
    <div class="debug-fields">
      <label><span>记录范围</span><SettingsDropdown :model-value="settings.debugCapture.scope" :options="scopes" :disabled="choicesDisabled" @update:model-value="change({ scope: $event === 'workspace' ? 'workspace' : 'conversation' })" /></label>
      <label><span>单次容量</span><SettingsDropdown :model-value="String(settings.debugCapture.maxMiB)" :options="sizes" :disabled="choicesDisabled" @update:model-value="change({ maxMiB: Number($event) as 8 | 16 | 32 })" /></label>
      <label><span>最长时间</span><SettingsDropdown :model-value="String(settings.debugCapture.maxMinutes)" :options="durations" :disabled="choicesDisabled" @update:model-value="change({ maxMinutes: Number($event) as 5 | 15 | 30 })" /></label>
    </div>
    <div class="debug-actions">
      <button v-if="!active" type="button" :disabled="choicesDisabled || !settings.loadedSections.debugCapture || Boolean(settings.externalChangedSections.debugCapture) || (settings.debugCapture.scope === 'conversation' && !conversationId)" @click="start"><IconPlayerRecord :size="16" />开始记录</button>
      <button v-else type="button" :disabled="busy || active.status !== 'recording'" @click="capture.command({ action: 'stop', runId: active.runId })"><IconPlayerStop :size="16" />停止记录</button>
      <HoverTooltipPanel panel-title="重新读取" :rows="[]" :disabled="Boolean(deleting)"><button type="button" class="icon" aria-label="重新读取取证状态" :disabled="busy" @click="capture.command({ action: 'status' })"><IconRefresh :size="16" /></button></HoverTooltipPanel>
      <span v-if="settings.debugCapture.scope === 'conversation' && !conversationId">当前没有选定对话</span>
    </div>
    <dl v-if="active" class="debug-status">
      <dt>已用额度</dt><dd>{{ bytes(active.acceptedBytes) }} / {{ bytes(active.maxBytes) }}</dd>
      <dt>经过时间</dt><dd>{{ Math.floor(active.elapsedMs / 1000) }} 秒 / {{ active.maxDurationMs / 60000 }} 分钟</dd>
      <dt>可靠保存</dt><dd>第 {{ active.durableSeq }} 条 / 已接收 {{ active.lastAcceptedSeq }} 条</dd>
      <dt>实际范围</dt><dd>{{ active.target.scope === 'workspace' ? '当前工作区全部对话' : active.target.conversationId }}</dd>
    </dl>
    <p v-if="capture.error || capture.state?.error" role="alert" class="debug-error">{{ capture.error || capture.state?.error }}</p>
    <div class="debug-heading"><h4>已保留记录</h4><span>{{ capture.state?.runs.length ?? 0 }} / 16 份 · {{ bytes(capture.state?.totalBytes ?? 0) }} / 128 兆</span></div>
    <p v-if="!capture.state?.runs.length">暂无记录</p>
    <ol v-else class="debug-runs">
      <li v-for="run in capture.state.runs" :key="run.runId">
        <div class="debug-run-description"><time>{{ new Date(run.startedAt).toLocaleString('zh-CN') }}</time><span>{{ run.status !== 'sealed' ? '正在记录' : (reasons[run.stopReason!] ?? '已封存') }} · {{ bytes(run.payloadBytes + run.indexBytes) }}</span><strong v-if="run.hasGaps">记录不完整</strong><span v-if="run.gapReason" class="debug-error">{{ run.gapReason }}</span></div>
        <div class="debug-actions">
          <HoverTooltipPanel v-for="action in [{ key: 'open' as const, label: '打开目录', icon: IconFolder }, { key: 'export' as const, label: '导出记录', icon: IconDownload }, { key: 'analyze' as const, label: '离线分析', icon: IconSearch }, { key: 'delete' as const, label: '删除记录', icon: IconTrash }]" :key="action.key" :panel-title="action.label" :rows="[]" :disabled="Boolean(deleting)">
            <button type="button" class="icon" :aria-label="action.label" :disabled="busy || run.status !== 'sealed'" @click="action.key === 'delete' ? deleting = run.runId : capture.command({ action: action.key, runId: run.runId })"><component :is="action.icon" :size="16" /></button>
          </HoverTooltipPanel>
        </div>
      </li>
    </ol>
    <p v-if="capture.state?.directory" class="debug-path">{{ capture.state.directory }}</p>
    <section v-if="capture.analysis" class="debug-analysis" aria-label="取证分析结果">
      <h4>分析结果 · 已核验 {{ capture.analysis.events }} 条</h4>
      <p class="debug-path">记录编号：{{ capture.analysis.runId }}</p>
      <div class="debug-analysis-shell"><div ref="analysisScroller" class="debug-analysis-scroll">
        <p v-for="(item, index) in capture.analysis.integrity" :key="`integrity-${index}`" class="debug-error">{{ item }}</p>
        <p v-for="(item, index) in capture.analysis.findings" :key="index"><strong>{{ levelNames[item.level] }}{{ item.sequence ? ` · 第 ${item.sequence} 条` : '' }}</strong><br />{{ item.message }}</p>
        <p v-if="capture.analysis.truncated">显示数量已达上限，原始记录仍保留在文件中。</p>
      </div><AdvancedScrollbar :scroller="analysisScroller" variant="minimal" /></div>
    </section>
    <ConfirmPanel :open="Boolean(deleting)" title="删除这份取证记录？" description="仅删除选中的调试记录，不影响聊天记录。删除后无法恢复。" confirm-label="删除" danger @confirm="remove" @cancel="deleting = ''" />
  </section>
</template>

<style scoped>
.debug-settings { border-top: 1px solid var(--vscode-panel-border); padding-top: 20px; margin-top: 12px; min-width: 0; }
.debug-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; }
h3, h4 { font-size: 13px; font-weight: 600; margin: 0; letter-spacing: 0; }
.debug-heading > span { font-size: 11px; color: var(--vscode-descriptionForeground); }
.debug-heading .recording { color: var(--vscode-testing-iconPassed, #4a9167); }
.debug-fields { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.debug-fields label { display: flex; flex-direction: column; min-width: 0; gap: 6px; font-size: 12px; }
.debug-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0; font-size: 11px; }
.debug-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: transparent; color: inherit; padding: 4px 10px; cursor: pointer; }
.debug-actions button:hover:not(:disabled), .debug-actions button:focus-visible { background: var(--vscode-toolbar-hoverBackground, #ffffff12); }
.debug-actions button:disabled { opacity: .45; cursor: default; }
.debug-actions .icon { width: 30px; height: 30px; padding: 0; flex: 0 0 30px; }
.debug-status { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 12px; }
.debug-status dd { margin: 0; overflow-wrap: anywhere; }
.debug-status dt { color: var(--vscode-descriptionForeground); }
.debug-runs { list-style: none; margin: 0; padding: 0; }
.debug-runs li { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--vscode-panel-border); padding: 10px 0; }
.debug-run-description { display: flex; flex-direction: column; min-width: 0; flex: 1 1 180px; gap: 4px; font-size: 12px; overflow-wrap: anywhere; }
.debug-path, .debug-error { overflow-wrap: anywhere; font-size: 11px; }
.debug-path { color: var(--vscode-descriptionForeground); }
.debug-error { color: var(--vscode-errorForeground); }
.debug-analysis { padding-top: 16px; font-size: 12px; line-height: 1.65; }
.debug-analysis p { overflow-wrap: anywhere; }
.debug-analysis-shell { position: relative; }
.debug-analysis-scroll { max-height: 320px; overflow: auto; scrollbar-width: none; padding-right: 12px; }
.debug-analysis-scroll::-webkit-scrollbar { display: none; }
@media (max-width: 420px) { .debug-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } .debug-fields label:first-child { grid-column: 1 / -1; } }
</style>

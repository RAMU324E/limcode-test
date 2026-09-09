<script setup lang="ts">
import { computed, watch } from 'vue';
import {
  DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
  type LlmCompressionConfigRecord,
  type LlmProviderConfigRecord,
  type LlmUsageMetadataRecord
} from '@shared/protocol';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { formatCompactTokenNumber, formatTokenNumber, normalizeTokenUsage } from './tokenUsageModel';

const reliableConversation = useReliableConversation();
const globalSettings = useGlobalSettingsStore();
const modelProfiles = useModelProfileStore();

const conversationTurns = computed(() => new Map(Object.values(reliableConversation.feed.records.Turn ?? {})
  .filter((turn) => turn.conversation_id === reliableConversation.conversationId.value)
  .map((turn) => [String(turn.id), turn])));
const conversationRequests = computed(() => Object.values(reliableConversation.feed.records.ModelRequest ?? {})
  .filter((request) => conversationTurns.value.has(String(request.turn_id)))
  .sort((left, right) => requestOrder(right) - requestOrder(left) || integer(right.request_seq) - integer(left.request_seq)));
const ordinaryRequestIds = computed(() => new Set(
  Object.values(reliableConversation.feed.records.ModelRequestMessageLink ?? {})
    .map((link) => text(link.model_request_id))
    .filter(Boolean)
));
// Compression calls are ModelRequests too, but their usage describes the compaction operation rather
// than the ordinary model prompt. Only requests that own an assistant Message are context baselines.
const ordinaryRequests = computed(() => conversationRequests.value
  .filter((request) => ordinaryRequestIds.value.has(text(request.id))));
const latestOrdinaryRequest = computed(() => ordinaryRequests.value[0]);
const currentContextStatus = computed(() => Object.values(
  reliableConversation.feed.records.ConversationContextStatus ?? {}
).find((status) => status.conversation_id === reliableConversation.conversationId.value));
const latestOrdinaryProjection = computed(() => {
  const requestId = text(latestOrdinaryRequest.value?.id);
  if (!requestId) return undefined;
  return Object.values(reliableConversation.feed.records.ModelContextProjection ?? {})
    .find((projection) => projection.owner_kind === 'model_request' && projection.owner_id === requestId);
});
const ordinaryUsageStale = computed(() => {
  if (!latestOrdinaryRequest.value) return false;
  const currentRootId = text(currentContextStatus.value?.root_id);
  if (!currentRootId) return false;
  const requestRootId = text(latestOrdinaryProjection.value?.root_id);
  return !requestRootId || requestRootId !== currentRootId;
});
// Configuration may fall back to a compression request before an ordinary response is linked, but
// usage below must never use that compaction call as the conversation-context baseline.
const latestRequest = computed(() => latestOrdinaryRequest.value ?? conversationRequests.value[0]);
const providerConfig = computed(() => activeProviderConfig());
const modelId = computed(() => text(latestRequest.value?.model_id) || selectedModelId(providerConfig.value));
const modelConfig = computed(() => providerConfig.value?.modelConfigs.find((candidate) => candidate.modelId === modelId.value));
const contextWindowTokens = computed(() =>
  positiveInteger(latestRequest.value?.context_window_tokens)
  ?? positiveInteger(latestRequest.value?.contextWindowTokens)
  ?? nestedToken(latestRequest.value?.model_profile_json, 'contextWindowTokens', 'context_window_tokens')
  ?? positiveInteger(modelConfig.value?.contextWindowTokens)
  ?? positiveInteger(providerConfig.value?.contextWindowTokens)
);
const latestExactUsage = computed(() => {
  const requestId = text(latestOrdinaryRequest.value?.id);
  const transient = requestId
    ? reliableConversation.feed.transientModelRequests[requestId]?.usageMetadata
    : undefined;
  return transient ?? usageFromRequest(latestOrdinaryRequest.value);
});
const latestExactContextTokens = computed(() => tokenCount(latestExactUsage.value));
const exactContextTokens = computed(() => ordinaryUsageStale.value
  ? undefined
  : latestExactContextTokens.value);
const estimatedContextTokens = computed(() =>
  positiveInteger(currentContextStatus.value?.estimated_tokens)
  ?? positiveInteger(latestRequest.value?.estimated_context_tokens)
);
// The Context root only carries estimator units. A compaction that already ran published the
// Provider-calibrated size of the Context it produced, which is what the next request will actually
// report, so prefer that over re-estimating a body nobody has measured yet.
const latestCompressionBlock = computed(() => Object.values(reliableConversation.feed.records.CompressionBlock ?? {})
  .filter((block) => block.conversation_id === reliableConversation.conversationId.value && block.status === 'enabled')
  .sort((left, right) => timestamp(right.created_at) - timestamp(left.created_at))[0]);
const compressionProjectionApplies = computed(() => {
  if (!ordinaryUsageStale.value) return false;
  const blockCreatedAt = timestamp(latestCompressionBlock.value?.created_at);
  if (!blockCreatedAt) return false;
  // A rewind installs an older root; the projection then describes a Context nobody is sending.
  const rootCreatedAt = timestamp(currentContextStatus.value?.root_created_at);
  if (!rootCreatedAt || rootCreatedAt < blockCreatedAt) return false;
  return blockCreatedAt >= timestamp(latestOrdinaryRequest.value?.created_at);
});
const compressionProjectedContextTokens = computed(() => {
  if (!compressionProjectionApplies.value) return undefined;
  const blockId = text(latestCompressionBlock.value?.id);
  if (!blockId) return undefined;
  const detail = reliableConversation.feed.details[reliableKernelDetailKey('compression-presentation', blockId)];
  if (detail?.status !== 'ready') return undefined;
  return positiveInteger(parsePresentationTokens(detail.text));
});
const previousExactContextTokens = computed(() => {
  if (ordinaryUsageStale.value && latestExactContextTokens.value !== undefined) {
    return latestExactContextTokens.value;
  }
  for (const request of ordinaryRequests.value) {
    const tokens = tokenCount(usageFromRequest(request));
    if (tokens !== undefined && tokens !== exactContextTokens.value) return tokens;
  }
  return undefined;
});
const actualContextTokens = computed(() =>
  exactContextTokens.value
  ?? compressionProjectedContextTokens.value
  ?? estimatedContextTokens.value
  ?? previousExactContextTokens.value
);
const usageQuality = computed<'exact' | 'compression_projected' | 'estimated' | 'previous_exact' | 'unknown'>(() => {
  if (exactContextTokens.value !== undefined) return 'exact';
  if (compressionProjectedContextTokens.value !== undefined) return 'compression_projected';
  if (estimatedContextTokens.value !== undefined) return 'estimated';
  if (previousExactContextTokens.value !== undefined) return 'previous_exact';
  return 'unknown';
});
const thresholdTokens = computed(() =>
  positiveInteger(latestRequest.value?.compression_threshold_tokens)
  ?? positiveInteger(latestRequest.value?.compressionThresholdTokens)
  ?? nestedToken(latestRequest.value?.model_profile_json, 'compressionThresholdTokens', 'compression_threshold_tokens')
  ?? configuredCompressionThreshold(contextWindowTokens.value)
);
const currentConfiguredWindow = computed(() => positiveInteger(modelConfig.value?.contextWindowTokens)
  ?? positiveInteger(providerConfig.value?.contextWindowTokens));
const currentConfiguredThreshold = computed(() => configuredCompressionThreshold(currentConfiguredWindow.value));
const currentCompressionMode = computed(() => {
  const config = configuredCompressionConfig();
  if (config?.kind === 'disabled') return '已关闭';
  if (config?.trigger.mode === 'manual') return '仅手动压缩';
  return tokenValueLabel(currentConfiguredThreshold.value);
});
const usageRatio = computed(() => actualContextTokens.value !== undefined && contextWindowTokens.value !== undefined
  ? actualContextTokens.value / contextWindowTokens.value
  : undefined);
const fillStyle = computed(() => ({
  width: usageRatio.value === undefined ? '0%' : `${Math.max(0, Math.min(1, usageRatio.value)) * 100}%`
}));
const thresholdStyle = computed(() => ({
  left: contextWindowTokens.value && thresholdTokens.value !== undefined
    ? `${Math.max(0, Math.min(100, thresholdTokens.value / contextWindowTokens.value * 100))}%`
    : '100%'
}));
const compactLabel = computed(() => {
  const prefix = usageQuality.value === 'estimated' || usageQuality.value === 'compression_projected'
    ? '≈'
    : usageQuality.value === 'previous_exact' ? '≤' : '';
  const used = actualContextTokens.value === undefined ? '?' : `${prefix}${formatCompactTokenNumber(actualContextTokens.value)}`;
  const window = contextWindowTokens.value === undefined ? '?' : formatCompactTokenNumber(contextWindowTokens.value);
  return `${used} / ${window}`;
});
const percentLabel = computed(() => usageRatio.value === undefined ? '未知' : `${(usageRatio.value * 100).toFixed(usageRatio.value < 0.1 ? 1 : 0)}%`);
const tooltipRows = computed(() => [
  { label: 'LLM', value: modelId.value || '尚未发起 LLM 请求' },
  { label: '当前上下文', value: contextUsageLabel() },
  ...(ordinaryUsageStale.value && latestExactContextTokens.value !== undefined
    ? [{ label: '最近请求精确输入', value: `${formatTokenNumber(latestExactContextTokens.value)} Token` }]
    : []),
  { label: '上下文窗口', value: contextWindowTokens.value === undefined ? '未知（暂未获取，且配置中未设置）' : `${formatTokenNumber(contextWindowTokens.value)} Token` },
  { label: '窗口占用', value: percentLabel.value },
  { label: '当前配置压缩阈值', value: currentCompressionMode.value },
  { label: '最近请求采用阈值', value: latestRequest.value ? tokenValueLabel(thresholdTokens.value) : '尚未发起请求' },
  { label: '数据来源', value: usageSourceLabel() }
]);
const overThreshold = computed(() => actualContextTokens.value !== undefined
  && thresholdTokens.value !== undefined
  && actualContextTokens.value >= thresholdTokens.value);

watch(
  () => (compressionProjectionApplies.value ? text(latestCompressionBlock.value?.id) : ''),
  (blockId) => {
    if (!blockId) return;
    if (reliableConversation.feed.details[reliableKernelDetailKey('compression-presentation', blockId)]) return;
    reliableConversation.feed.requestDetail('compression-presentation', blockId, { priority: 'visible' });
  },
  { immediate: true }
);

function parsePresentationTokens(detailText: string): unknown {
  const record = asRecord(parseJson(detailText));
  return record?.calibratedTokensAfter;
}

function activeProviderConfig(): LlmProviderConfigRecord | undefined {
  const providerId = text(latestRequest.value?.provider_id);
  const configs = globalSettings.llmProviderConfigs.configs;
  if (providerId) {
    const frozen = configs.find((config) => config.id === providerId);
    if (frozen) return frozen;
  }
  const conversationId = reliableConversation.conversationId.value;
  const configuredId = conversationId
    ? modelProfiles.localProfileFor('conversation', conversationId).profile?.providerConfigId?.trim() ?? ''
    : '';
  return configs.find((config) => config.id === configuredId)
    ?? configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
    ?? configs[0];
}

function selectedModelId(config: LlmProviderConfigRecord | undefined): string {
  if (!config) return '';
  const conversationId = reliableConversation.conversationId.value;
  const profile = conversationId
    ? modelProfiles.localProfileFor('conversation', conversationId).profile
    : undefined;
  const override = profile?.providerConfigId?.trim() === config.id ? profile.model.trim() : '';
  return override || config.model?.trim() || '';
}

function configuredCompressionConfig(): LlmCompressionConfigRecord | undefined {
  const configId = providerConfig.value?.id;
  const model = modelId.value;
  const modelBinding = configId && model
    ? globalSettings.llmCompression.modelBindings.find((item) => item.providerConfigId === configId && item.modelId === model)
    : undefined;
  const providerBinding = configId
    ? globalSettings.llmCompression.providerBindings.find((item) => item.providerConfigId === configId)
    : undefined;
  const compressionId = modelBinding?.compressionConfigId
    ?? providerBinding?.compressionConfigId
    ?? globalSettings.llmCompression.defaultConfigId;
  return globalSettings.llmCompressionConfigs.configs.find((candidate) => candidate.id === compressionId)
    ?? globalSettings.llmCompressionConfigs.configs[0];
}

function configuredCompressionThreshold(contextWindow: number | undefined): number | undefined {
  if (!contextWindow) return undefined;
  const config = configuredCompressionConfig();
  const explicit = config?.trigger.thresholdUnit === 'tokens' ? positiveInteger(config.trigger.thresholdTokens) : undefined;
  if (explicit !== undefined) return Math.min(contextWindow, explicit);
  const percent = finiteNumber(config?.trigger?.thresholdPercent) ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT;
  return Math.round(contextWindow * Math.max(0, Math.min(100, percent)) / 100);
}

function usageFromRequest(request: Record<string, unknown> | undefined): LlmUsageMetadataRecord | undefined {
  if (!request) return undefined;
  const value = typeof request.usage_json === 'string' ? parseJson(request.usage_json) : request.usage_json;
  return asRecord(value) as LlmUsageMetadataRecord | undefined;
}

function tokenCount(usage: LlmUsageMetadataRecord | undefined): number | undefined {
  const normalized = usage ? normalizeTokenUsage(usage) : undefined;
  return normalized?.input ?? normalized?.total;
}

function contextUsageLabel(): string {
  const tokens = actualContextTokens.value;
  if (tokens === undefined) return '未知（尚未建立上下文）';
  const suffix = usageQuality.value === 'compression_projected'
    ? ' Token（压缩后实测换算）'
    : usageQuality.value === 'estimated'
      ? ' Token（当前估算）'
      : usageQuality.value === 'previous_exact'
        ? ' Token（上一轮精确值）'
        : ' Token（精确）';
  return `${formatTokenNumber(tokens)}${suffix}`;
}

function usageSourceLabel(): string {
  if (usageQuality.value === 'exact') return '最近一次 LLM 请求的实际输入用量';
  if (usageQuality.value === 'compression_projected') return '最近一次压缩按渠道实测倍率换算出的上下文体积';
  if (usageQuality.value === 'estimated') {
    return ordinaryUsageStale.value
      ? '当前 Context root 估算；最近请求精确输入仅作为校准'
      : '根据当前模型渠道的上下文规则估算';
  }
  if (usageQuality.value === 'previous_exact') return '上一次已完成 LLM 请求的实际输入用量';
  return latestRequest.value ? 'LLM 请求 / 当前 LLM 配置' : '当前 LLM 配置';
}

function tokenValueLabel(value: number | undefined): string {
  return value === undefined ? '未知' : `${formatTokenNumber(value)} Token`;
}

function nestedToken(value: unknown, ...keys: string[]): number | undefined {
  const source = asRecord(typeof value === 'string' ? parseJson(value) : value);
  if (!source) return undefined;
  for (const key of keys) {
    const result = positiveInteger(source[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function requestOrder(request: Record<string, unknown>): number {
  const turn = conversationTurns.value.get(String(request.turn_id));
  return timestamp(turn?.created_at) || timestamp(request.created_at);
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? Math.round(number) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function integer(value: unknown): number {
  const number = finiteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
</script>

<template>
  <HoverTooltipPanel
    class="reliable-context-status"
    :class="{ 'is-over-threshold': overThreshold, 'is-unknown': actualContextTokens === undefined }"
    panel-title="LLM 上下文"
    :rows="tooltipRows"
    :delay-ms="180"
  >
    <button type="button" class="reliable-context-button" :aria-label="`LLM 上下文 ${compactLabel}`">
      <span class="reliable-context-track" aria-hidden="true">
        <span class="reliable-context-fill" :style="fillStyle"></span>
        <span v-if="thresholdTokens !== undefined && contextWindowTokens" class="reliable-context-threshold" :style="thresholdStyle"></span>
      </span>
      <span class="reliable-context-label">{{ compactLabel }}</span>
    </button>
  </HoverTooltipPanel>
</template>

<style scoped>
.reliable-context-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-width: 86px;
}

.reliable-context-button {
  width: 100%;
  min-width: 86px;
  min-height: 22px;
  display: inline-grid;
  grid-template-columns: minmax(34px, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
}

.reliable-context-button:hover,
.reliable-context-button:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.reliable-context-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent);
}

.reliable-context-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--vscode-descriptionForeground);
  transition: width 160ms ease;
}

.reliable-context-threshold {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.reliable-context-label {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.reliable-context-status.is-over-threshold .reliable-context-fill {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.reliable-context-status.is-unknown .reliable-context-track {
  background: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent) 0 4px,
    transparent 4px 7px
  );
}

@media (max-width: 720px) {
  .reliable-context-button {
    min-width: 70px;
    grid-template-columns: 20px auto;
  }
}
</style>

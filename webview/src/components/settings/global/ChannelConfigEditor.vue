<script setup lang="ts">
import { computed } from 'vue';
import type { LlmCompressionConfigRecord, LlmCompressionFallbackKind, LlmGenerationConfigRecord,
  LlmNativeCompactionTrustMode, LlmProviderConfigRecord, LlmProviderHeadersRecord,
  LlmProviderModelConfigRecord, LlmPromptCacheConfigRecord, LlmRequestBodyRecord, LlmSummaryReasoningMode } from '@shared/protocol';
import type { OpenAIResponsesNativeSettings } from '@shared/openAIResponsesNative';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import LlmAdvancedConfigEditor from './LlmAdvancedConfigEditor.vue';
import LlmCompressionSettingsEditor from './LlmCompressionSettingsEditor.vue';

// One cached editor instance per exact provider/model target, owned only by the settings view.
const props = defineProps<{ providerConfigId: string; modelConfigId?: string }>();
const emit = defineEmits<{ (event: 'test-thinking', modelId: string, providerConfigId: string): void }>();
const settings = useGlobalSettingsStore();
const provider = computed(() => settings.llmProviderConfigs.configs.find(item => item.id === props.providerConfigId));
const modelConfig = computed(() => provider.value?.modelConfigs.find(item => item.id === props.modelConfigId));
const config = computed(() => props.modelConfigId
  ? modelConfig.value && modelConfigAsProviderConfig(modelConfig.value)
  : provider.value);
const compression = computed(() => settings.compressionConfigForProvider(props.providerConfigId, modelConfig.value?.modelId));
function modelConfigAsProviderConfig(modelConfig: LlmProviderModelConfigRecord): LlmProviderConfigRecord {
  const base = provider.value;
  const now = Date.now();
  return {
    id: base?.id ?? modelConfig.id,
    name: base ? `${base.name} · ${modelConfig.modelId}` : modelConfig.modelId,
    provider: base?.provider ?? 'openai-compatible',
    baseUrl: base?.baseUrl ?? '',
    model: modelConfig.modelId,
    models: base?.models ?? [],
    apiKey: base?.apiKey ?? '',
    toolCallFormat: modelConfig.toolCallFormat,
    openaiResponsesTransport: modelConfig.openaiResponsesTransport,
    stream: modelConfig.stream,
    retryOnError: modelConfig.retryOnError,
    retryForceAllErrors: modelConfig.retryForceAllErrors === true,
    retryMaxAttempts: modelConfig.retryMaxAttempts,
    retryDelaySeconds: modelConfig.retryDelaySeconds,
    enableMultimodalTools: modelConfig.enableMultimodalTools,
    historyImages: modelConfig.historyImages,
    contextWindowTokens: modelConfig.contextWindowTokens,
    systemPromptPrefix: modelConfig.systemPromptPrefix,
    promptCache: modelConfig.promptCache,
    ...(modelConfig.nativeResponses ? { nativeResponses: { ...modelConfig.nativeResponses } } : {}),
    // 模型级配置缺省时跟随渠道，与运行时冻结的取值一致。
    ...((modelConfig.claudeTurnScopedReminders ?? base?.claudeTurnScopedReminders) === true ? { claudeTurnScopedReminders: true } : {}),
    ...((modelConfig.openaiCompatibleThinkingFormat ?? base?.openaiCompatibleThinkingFormat)
      ? { openaiCompatibleThinkingFormat: modelConfig.openaiCompatibleThinkingFormat ?? base?.openaiCompatibleThinkingFormat } : {}),
    headers: modelConfig.headers ?? {},
    generationConfig: modelConfig.generationConfig ?? {},
    requestBody: modelConfig.requestBody ?? {},
    modelConfigs: [],
    createdAt: modelConfig.createdAt || now,
    updatedAt: modelConfig.updatedAt || now
  };
}

function updateField(patch: Partial<LlmProviderModelConfigRecord>): void {
  if (props.modelConfigId) settings.updateActiveModelConfig(props.modelConfigId, patch, props.providerConfigId);
  else settings.updateActiveLlmProviderConfig(patch, props.providerConfigId);
}
function updateContextWindowTokens(value: number | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigContextWindowTokens(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmContextWindowTokens(value, props.providerConfigId);
}
function updateGenerationConfig(value: LlmGenerationConfigRecord | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigGenerationConfig(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmGenerationConfig(value, props.providerConfigId);
}
function updateRequestBody(value: LlmRequestBodyRecord | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigRequestBody(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmRequestBody(value, props.providerConfigId);
}
function updatePromptCache(value: LlmPromptCacheConfigRecord | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigPromptCache(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmPromptCache(value, props.providerConfigId);
}
function updateNativeResponses(value: OpenAIResponsesNativeSettings | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigNativeResponses(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmNativeResponses(value, props.providerConfigId);
}
function updateHeaders(value: LlmProviderHeadersRecord | undefined): void {
  if (props.modelConfigId) settings.updateActiveModelConfigHeaders(props.modelConfigId, value, props.providerConfigId);
  else settings.updateActiveLlmHeaders(value, props.providerConfigId);
}
function updateCompressionTrigger(value: Partial<LlmCompressionConfigRecord['trigger']>): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.updateModelCompressionTrigger(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.updateActiveCompressionTrigger(value, props.providerConfigId);
}
function updateCompressionProviderConfig(value: string): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionProviderConfig(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionProviderConfig(value, props.providerConfigId);
}
function updateCompressionMethodKind(value: 'auto' | 'provider_native' | 'llm_summary' | 'segmented_summary' | 'deterministic_summary'): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionMethodKind(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionMethodKind(value, props.providerConfigId);
}
function updateCompressionMaxDurationMinutes(value: number): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionMaxDurationMinutes(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionMaxDurationMinutes(value, props.providerConfigId);
}
function updateCompressionBodyTargetTokens(value: number): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionBodyTargetTokens(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionBodyTargetTokens(value, props.providerConfigId);
}
function updateCompressionNativeTrustMode(value: LlmNativeCompactionTrustMode): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionNativeTrustMode(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionNativeTrustMode(value, props.providerConfigId);
}
function updateCompressionSummaryReasoningMode(value: LlmSummaryReasoningMode): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionSummaryReasoningMode(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionSummaryReasoningMode(value, props.providerConfigId);
}
function updateCompressionSummaryGenerationConfig(value: LlmGenerationConfigRecord | undefined): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionSummaryGenerationConfig(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionSummaryGenerationConfig(value, props.providerConfigId);
}
function updateCompressionFallbacks(value: LlmCompressionFallbackKind[]): void {
  if (props.modelConfigId) {
    if (modelConfig.value) settings.setModelCompressionFallbacks(modelConfig.value.modelId, value, props.providerConfigId);
  } else settings.setActiveCompressionFallbacks(value, props.providerConfigId);
}
</script>

<template>
  <LlmAdvancedConfigEditor
    v-if="config"
    :config="config"
    :thinking-probe="settings.thinkingProbeState(providerConfigId, config.model)"
    @test-thinking="emit('test-thinking', config.model, providerConfigId)"
    @update-field="updateField"
    @update-context-window-tokens="updateContextWindowTokens"
    @update-generation-config="updateGenerationConfig"
    @update-request-body="updateRequestBody"
    @update-prompt-cache="updatePromptCache"
    @update-native-responses="updateNativeResponses"
    @update-headers="updateHeaders"
  >
    <template #compression>
      <LlmCompressionSettingsEditor
        :config="compression"
        :current-provider-config="config"
        :provider-configs="settings.llmProviderConfigs.configs"
        :context-window-tokens="config.contextWindowTokens ?? 0"
        @verify-native="(configId, modelId) => settings.verifyNativeCompressionCapability(configId, modelId)"
        @update-provider-config-id="updateCompressionProviderConfig"
        @update-method-kind="updateCompressionMethodKind"
        @update-trigger="updateCompressionTrigger"
        @update-max-duration-minutes="updateCompressionMaxDurationMinutes"
        @update-body-target-tokens="updateCompressionBodyTargetTokens"
        @update-native-trust-mode="updateCompressionNativeTrustMode"
        @update-summary-reasoning-mode="updateCompressionSummaryReasoningMode"
        @update-summary-generation-config="updateCompressionSummaryGenerationConfig"
        @update-fallbacks="updateCompressionFallbacks"
      />
    </template>
  </LlmAdvancedConfigEditor>
</template>

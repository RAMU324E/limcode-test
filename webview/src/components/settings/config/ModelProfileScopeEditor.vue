<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useGuardedSettingsDraft } from '@webview/composables/useGuardedSettingsDraft';
import type { ConfigScopeKind, LlmProviderModelRecord } from '@shared/protocol';
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import SettingsDropdown, { type SettingsDropdownOption } from '@webview/components/settings/global/SettingsDropdown.vue';
import ModelFetchDialog from '@webview/components/settings/global/ModelFetchDialog.vue';
import InputPanel from '@webview/components/ui/InputPanel.vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import ModelProfileSaveStatus from '@webview/components/input/ModelProfileSaveStatus.vue';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const INHERIT_GLOBAL_MODEL_ID = '__inherit_global_model__';

const props = withDefaults(defineProps<{ scopeKind: ConfigScopeKind; scopeId?: string; title?: string; description?: string }>(), {
  title: 'LLM 配置',
  description: ''
});

const globalSettings = useGlobalSettingsStore();
const store = useModelProfileStore();
watch(() => [props.scopeKind, props.scopeId], (_value, _old, onCleanup) => onCleanup(store.activateScope(props.scopeKind, props.scopeId)), { immediate: true });
const { loading: modelLoading, text: modelLoadingText } = useSettingsLoadingText('LLM 配置', () => props.scopeKind, () => props.scopeId, {
  globalSettingsSections: ['llm', 'llmProviderConfigs'] as const
});
const local = computed(() => store.localProfileFor(props.scopeKind, props.scopeId));
const draftState = useGuardedSettingsDraft(
  () => JSON.stringify([props.scopeKind, props.scopeId ?? '']),
  () => {
    const profile = store.confirmedFor(props.scopeKind, props.scopeId)?.profile;
    if (!profile || profile.inheritModel) return { providerConfigId: INHERIT_GLOBAL_MODEL_ID, model: '' };
    const configId = profile.providerConfigId
      ?? globalSettings.llmProviderConfigs.configs.find(config => config.provider === profile.provider)?.id
      ?? globalSettings.activeLlmProviderConfig?.id ?? globalSettings.llmProviderConfigs.configs[0]?.id ?? '';
    const config = globalSettings.llmProviderConfigs.configs.find(item => item.id === configId);
    return { providerConfigId: configId, model: profile.model ?? config?.model ?? '' };
  }
);
const providerConfigId = computed({ get: () => draftState.value.value.providerConfigId,
  set: (value: string) => { draftState.value.value = { ...draftState.value.value, providerConfigId: value }; } });
const model = computed({ get: () => draftState.value.value.model,
  set: (value: string) => { draftState.value.value = { ...draftState.value.value, model: value }; } });
const draftChangedRemotely = draftState.remoteChanged;
let pendingDiscardReset: { requestId: string; reset: () => void } | undefined;
function discardDraft(): void {
  const reset = draftState.prepareReset();
  const requestId = store.discardPending(props.scopeKind, props.scopeId);
  if (requestId) pendingDiscardReset = { requestId, reset };
  else { pendingDiscardReset = undefined; reset(); }
}
watch(() => store.completedDiscardReadFor(props.scopeKind, props.scopeId), requestId => {
  if (!pendingDiscardReset || pendingDiscardReset.requestId !== requestId) return;
  pendingDiscardReset.reset();
  pendingDiscardReset = undefined;
}, { flush: 'sync' });
watch(() => store.completedSaveFor(props.scopeKind, props.scopeId), requestId => {
  const submissionRequestId = store.completedSubmissionFor(props.scopeKind, props.scopeId);
  if (requestId && submissionRequestId) draftState.confirmSubmitted(submissionRequestId);
}, { flush: 'sync' });
const isInheritSelected = computed(() => providerConfigId.value === INHERIT_GLOBAL_MODEL_ID);
const inheritedModelText = computed(() => {
  const config = globalSettings.activeLlmProviderConfig;
  return config?.model ? `${config.name} · ${config.model}` : '使用全局/对话当前渠道与 LLM';
});
const options = computed<SettingsDropdownOption[]>(() => [
  {
    value: INHERIT_GLOBAL_MODEL_ID,
    label: '继承全局',
    description: inheritedModelText.value
  },
  ...globalSettings.llmProviderConfigs.configs.map((config) => ({
    value: config.id,
    label: config.name,
    description: config.model || config.provider
  }))
]);
const activeConfig = computed(() => globalSettings.llmProviderConfigs.configs.find((config) => config.id === providerConfigId.value));
const modelOptions = computed<SettingsDropdownOption[]>(() => {
  if (isInheritSelected.value) return [{ value: '', label: '渠道默认配置', description: inheritedModelText.value,
    buttonLabel: `渠道默认配置 · ${inheritedModelText.value}` }];
  const config = activeConfig.value;
  if (!config) return [];
  const result: SettingsDropdownOption[] = [{ value: config.model, label: '渠道默认配置',
    description: config.model || '尚未设置默认模型', disabled: !config.model,
    buttonLabel: config.model ? `渠道默认配置 · ${config.model}` : '渠道默认配置' },
    ...config.models.filter(item => item.id !== config.model).map(item => ({
      value: item.id, label: item.name || item.id, description: item.id
    }))];
  if (model.value && !result.some(item => item.value === model.value)) {
    result.push({ value: model.value, label: model.value, description: '当前已选模型，未在渠道列表中' });
  }
  return result;
});
const selectedProviderConfigId = computed({
  get: () => providerConfigId.value,
  set: (value: string) => {
    const configId = value || INHERIT_GLOBAL_MODEL_ID;
    if (configId === providerConfigId.value) return;
    const config = globalSettings.llmProviderConfigs.configs.find(item => item.id === configId);
    draftState.value.value = { providerConfigId: configId, model: config?.model ?? '' };
  }
});

const manualModelOpen = ref(false);
const modelFetchConfigId = ref('');
const modelFetchDialog = computed(() => modelFetchConfigId.value
  && globalSettings.fetchedModelsDialog.configId === modelFetchConfigId.value ? globalSettings.fetchedModelsDialog : undefined);
function fetchModels(): void {
  if (!activeConfig.value) return;
  modelFetchConfigId.value = activeConfig.value.id;
  globalSettings.requestModelsForActiveConfig(activeConfig.value.id);
}
function closeModelFetch(): void {
  if (modelFetchDialog.value) globalSettings.closeFetchedModelsDialog();
  modelFetchConfigId.value = '';
}
function addFetchedModels(models: LlmProviderModelRecord[]): void {
  if (!modelFetchDialog.value) return;
  globalSettings.addFetchedModelsToConfig(models);
  modelFetchConfigId.value = '';
}
function confirmManualModel(value: string): void {
  manualModelOpen.value = false;
  const config = activeConfig.value, modelId = value.trim();
  if (!config || !modelId) return;
  if (!config.models.some(item => item.id === modelId)) globalSettings.addModelToActiveConfig(modelId, undefined, config.id);
  model.value = modelId;
}
watch(() => [props.scopeKind, props.scopeId, providerConfigId.value], () => {
  manualModelOpen.value = false;
  closeModelFetch();
}, { flush: 'sync' });
onBeforeUnmount(closeModelFetch);

function save(): void {
  if (isInheritSelected.value) {
    const requestId = store.clearProfileScope(props.scopeKind, props.scopeId);
    if (requestId) draftState.markSubmitted(requestId);
    else draftState.reset();
    return;
  }
  const config = activeConfig.value;
  model.value = model.value.trim();
  const requestId = store.setProfileForScope(props.scopeKind, props.scopeId, { providerConfigId: providerConfigId.value, provider: config?.provider, model: model.value.trim(), name: `${props.scopeKind} Model Profile` });
  if (requestId) draftState.markSubmitted(requestId);
  else draftState.reset(); // The current authority already confirms this selection; no write or receipt is invented.
}
</script>

<template>
  <section class="model-profile-editor">
    <header class="model-profile-header">
      <div>
        <h3>
          {{ title }}
          <SettingsLoadingInline :show="modelLoading" :text="modelLoadingText" />
        </h3>
        <p v-if="description">{{ description }}</p>
      </div>
       <span>{{ local.profile ? '当前范围已配置' : '继承全局' }}</span>
    </header>
    <div class="model-profile-grid">
      <label>
        <span>LLM 来源</span>
        <SettingsDropdown v-model="selectedProviderConfigId" :options="options" title="选择 LLM 来源" searchable search-placeholder="筛选 LLM 来源…" />
      </label>
      <label>
        <span>LLM</span>
        <SettingsDropdown v-model="model" :options="modelOptions" title="选择 LLM" :disabled="isInheritSelected || !activeConfig"
          searchable search-placeholder="筛选模型名称或 ID…" />
      </label>
    </div>
    <div class="model-profile-actions">
      <button type="button" :disabled="!activeConfig || modelFetchDialog?.loading" @click="fetchModels">获取模型</button>
      <button type="button" :disabled="!activeConfig" @click="manualModelOpen = true">手动输入模型</button>
      <span v-if="modelFetchConfigId" role="status">{{ globalSettings.status }}</span>
    </div>
    <template v-if="draftChangedRemotely">
      <span role="status">已保存内容有更新，当前草稿已保留</span>
      <button type="button" @click="draftState.reset()">读取已保存值</button>
    </template>
    <ModelProfileSaveStatus :scope-kind="scopeKind" :scope-id="scopeId" :discard-draft="discardDraft" />
    <div class="model-profile-actions">
      <button type="button" :disabled="!isInheritSelected && !model.trim()" @click="save">保存 LLM 配置</button>
      <span v-if="isInheritSelected">保存后继承全局/对话的 LLM 配置。</span>
      <span>{{ store.status }}</span>
    </div>
    <ModelFetchDialog :open="!!modelFetchDialog?.open" :loading="modelFetchDialog?.loading"
      :models="modelFetchDialog?.models ?? []" :existing-model-ids="activeConfig?.models.map(item => item.id) ?? []"
      @add="addFetchedModels" @close="closeModelFetch" />
    <InputPanel :open="manualModelOpen" title="手动输入模型" label="模型 ID" :initial-value="model"
      description="将模型添加到当前渠道的列表，并用于当前配置；不会改变渠道默认模型。"
      confirm-label="选择模型" @confirm="confirmManualModel" @cancel="manualModelOpen = false" />
  </section>
</template>

<style scoped>
.model-profile-editor { display: flex; flex-direction: column; gap: var(--space-2); }
.model-profile-header { display: flex; justify-content: space-between; gap: var(--space-3); color: var(--vscode-descriptionForeground); }
h3 { margin: 0; color: var(--vscode-foreground); font-size: var(--font-size-md); }
p { margin: 2px 0 0; font-size: var(--font-size-sm); }
.model-profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: var(--space-3); }
label { min-width: 0; display: flex; flex-direction: column; gap: var(--space-1); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.model-profile-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-sm); }
.model-profile-actions button {
  min-height: 28px;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: transparent;
}
.model-profile-actions button:hover:not(:disabled),
.model-profile-actions button:focus-visible,
.model-profile-actions button:active {
  border-color: var(--vscode-panel-border);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}
.model-profile-actions button:disabled {
  color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
  background: transparent;
  opacity: 0.55;
}
</style>

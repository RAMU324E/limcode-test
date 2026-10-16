<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import SettingsSelectableList, { type SettingsSelectableListItem } from '@webview/components/settings/global/SettingsSelectableList.vue';
defineProps<{ name: string; provider: string; items: SettingsSelectableListItem[]; selectedId: string; inline?: boolean }>();
const emit = defineEmits<{ (event: 'select', item: SettingsSelectableListItem): void; (event: 'back'): void }>();
const root = ref<HTMLElement | null>(null);
onMounted(() => { void nextTick(() => root.value?.querySelector('input')?.focus()); });
</script>

<template>
  <section ref="root" class="composer-model-menu" aria-label="切换 LLM" @click.stop>
    <div class="composer-model-heading">
      <button v-if="inline" type="button" class="composer-model-back" @click="emit('back')">‹ 返回渠道</button>
      <span>{{ name }}</span><small>{{ provider }}</small>
    </div>
    <SettingsSelectableList class="composer-model-list" :items="items" :selected-id="selectedId"
      search-placeholder="筛选 LLM…" empty-text="该渠道暂无 LLM 列表。" no-match-text="没有匹配的 LLM。"
      :max-height="220" @select="emit('select', $event)" />
  </section>
</template>

<style scoped>
.composer-model-menu { display: flex; flex-direction: column; min-width: 0; max-height: var(--composer-model-max-height, var(--settings-dropdown-panel-max-height, 320px)); overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
.composer-model-heading { flex: 0 0 auto; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); display: flex; flex-direction: column; gap: 2px; }
.composer-model-heading span, .composer-model-heading small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-model-heading small { color: var(--vscode-descriptionForeground); }
.composer-model-back { align-self: start; padding: 2px 4px; border: 0; color: var(--vscode-foreground); background: transparent; }
.composer-model-back:hover, .composer-model-back:focus-visible { background: var(--vscode-list-hoverBackground); }
.composer-model-list { display: flex; flex-direction: column; min-height: 0; border: 0; border-radius: 0; background: transparent; }
.composer-model-list :deep(.settings-selectable-filter) { flex: 0 0 auto; }
.composer-model-list :deep(.settings-selectable-shell) { min-height: 0; display: flex; }
.composer-model-list :deep(.settings-selectable-scroll) { min-height: 0; width: 100%; }
.composer-model-list :deep(.settings-selectable-item) { min-height: 42px; grid-template-columns: minmax(0, 1fr); }
</style>

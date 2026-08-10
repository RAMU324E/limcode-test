<script setup lang="ts">
import GlobalSettingsPanel from '@webview/components/settings/GlobalSettingsPanel.vue';
import { EXTENSION_BRAND } from '@shared/extensionIdentity';
</script>

<template>
  <div class="global-settings-view">
    <header class="view-header">
      <span class="view-title">{{ EXTENSION_BRAND }} 全局设置</span>
      <span class="view-hint">设置默认模型渠道、LLM 连接和其他全局选项。</span>
    </header>
    <div class="view-body">
      <GlobalSettingsPanel />
    </div>
  </div>
</template>

<style scoped>
.global-settings-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.view-header {
  flex: 0 0 auto;
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-wrap: wrap;
}

.view-title {
  font-weight: 600;
}

.view-hint {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.view-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: var(--space-4);
}
</style>

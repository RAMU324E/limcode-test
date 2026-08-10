<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import RulesEditor from '@webview/components/settings/rules/RulesEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: rulesLoading, text: rulesLoadingText } = useSettingsLoadingText('规则配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="规则配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          规则
          <SettingsLoadingInline :show="rulesLoading" :text="rulesLoadingText" />
        </h2>
        <p>规则来自项目根目录和数据目录中的 AGENTS.md / CLAUDE.md，会在对话开始时载入系统提示词，并对所有 Agent 生效。AGENTS.md 可在此编辑；CLAUDE.md 仅供兼容读取，需要自行修改文件。</p>
      </div>
    </header>

    <RulesEditor />
  </section>
</template>

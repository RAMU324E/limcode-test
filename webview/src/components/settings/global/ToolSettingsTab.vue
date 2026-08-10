<script setup lang="ts">
import SettingsLoadingInline from '@webview/components/settings/SettingsLoadingInline.vue';
import ToolPolicyEditor from '@webview/components/settings/tools/ToolPolicyEditor.vue';
import { useSettingsLoadingText } from '@webview/composables/useSettingsLoading';

const { loading: toolLoading, text: toolLoadingText } = useSettingsLoadingText('工具配置', 'global');
</script>

<template>
  <section class="global-settings-tab-section" aria-label="工具配置">
    <header class="global-settings-section-header">
      <div>
        <h2>
          工具
          <SettingsLoadingInline :show="toolLoading" :text="toolLoadingText" />
        </h2>
        <p>工具列表由系统提供；这里设置全局默认工具权限。对话、Agent 和工作流可以继承或单独覆盖。</p>
      </div>
    </header>

    <ToolPolicyEditor
      scope-kind="global"
      title="全局默认工具策略"
      description="新对话或未单独设置权限的 Agent 和工作流会继承这里的启用状态。MCP 工具的注册与连接状态在 MCP 页集中管理。"
    />
  </section>
</template>

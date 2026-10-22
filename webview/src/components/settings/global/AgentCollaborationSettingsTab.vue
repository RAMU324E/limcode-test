<script setup lang="ts">
import AgentCollaborationSettings from '@webview/components/settings/agent/AgentCollaborationSettings.vue';
</script>

<template>
  <section class="global-settings-tab-section" aria-label="Agent 协作默认值">
    <header class="global-settings-section-header">
      <div>
        <h2>Agent 协作默认值</h2>
        <p>统一设置协作开关、子 Agent 深度和团队预算。各 Agent 可单独设置，未单独设置的项继承全局默认值。</p>
      </div>
    </header>
    <AgentCollaborationSettings scope-kind="global" title="全局默认值" />
  </section>
</template>

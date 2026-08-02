<script setup lang="ts">
import { computed } from 'vue';
import { IconAlertTriangle, IconX } from '@tabler/icons-vue';
import type { RunTerminationRecord } from '@shared/protocol';

const props = defineProps<{ termination: RunTerminationRecord }>();
const emit = defineEmits<{ (event: 'dismiss'): void }>();

const title = computed(() => props.termination.kind === 'failed'
  ? '本轮执行失败'
  : props.termination.kind === 'cancelled'
    ? '本轮已取消'
    : '本轮已中断');
const detail = computed(() => props.termination.detail?.trim() || props.termination.reasonCode);
</script>

<template>
  <article class="reliable-termination-row" role="status" :aria-label="`${title}：${detail}`">
    <div class="reliable-termination-icon" aria-hidden="true">
      <IconAlertTriangle :size="17" stroke="1.9" />
    </div>
    <div class="reliable-termination-content">
      <strong>{{ title }}</strong>
      <p>{{ detail }}</p>
    </div>
    <button
      type="button"
      class="reliable-termination-dismiss"
      aria-label="关闭本轮终止提示"
      @click="emit('dismiss')"
    >
      <IconX :size="15" stroke="1.9" />
    </button>
  </article>
</template>

<style scoped>
.reliable-termination-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4))
    var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f48771) 46%, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editorError-foreground, #f48771) 6%);
}

.reliable-termination-icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--vscode-editorError-foreground, #f48771);
}

.reliable-termination-content {
  min-width: 0;
  flex: 1 1 auto;
}

.reliable-termination-dismiss {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -2px -4px 0 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.reliable-termination-dismiss:hover,
.reliable-termination-dismiss:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.reliable-termination-content strong {
  display: block;
  margin-bottom: 2px;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.reliable-termination-content p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { IconBraces, IconPencil, IconTerminal2, IconWriting } from '@tabler/icons-vue';
import type { ToolCallPreviewRecord } from '@shared/protocol';
import { toolCallPreviewPresentation } from '@shared/toolCallPreview';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const props = defineProps<{
  preview: ToolCallPreviewRecord;
}>();

const FRAME_INTERVAL_MS = 50;
const framedPreview = shallowRef<ToolCallPreviewRecord>({ ...props.preview });
const pendingPreview = shallowRef<ToolCallPreviewRecord | undefined>();
const previewScroller = ref<HTMLElement | null>(null);
let frameTimer: number | undefined;

const presentation = computed(() => toolCallPreviewPresentation(framedPreview.value));
const icon = computed(() => {
  if (presentation.value.kind === 'write') return IconWriting;
  if (presentation.value.kind === 'edit') return IconPencil;
  if (presentation.value.kind === 'command') return IconTerminal2;
  return IconBraces;
});

watch(
  () => props.preview,
  (next) => {
    pendingPreview.value = { ...next };
    if (frameTimer !== undefined) return;
    frameTimer = window.setTimeout(flushPreviewFrame, FRAME_INTERVAL_MS);
  },
  { deep: false }
);

onBeforeUnmount(() => {
  if (frameTimer !== undefined) window.clearTimeout(frameTimer);
  frameTimer = undefined;
  pendingPreview.value = undefined;
});

function flushPreviewFrame(): void {
  frameTimer = undefined;
  const next = pendingPreview.value;
  pendingPreview.value = undefined;
  if (next) framedPreview.value = next;
}
</script>

<template>
  <section class="tool-preview-card" aria-live="polite" :aria-label="presentation.title">
    <header class="tool-preview-header">
      <span class="tool-preview-icon" aria-hidden="true"><component :is="icon" :size="15" stroke="1.8" /></span>
      <span class="tool-preview-heading">
        <strong>{{ presentation.title }}</strong>
        <span v-if="presentation.subject" class="tool-preview-subject">{{ presentation.subject }}</span>
      </span>
      <span class="tool-preview-pulse" aria-hidden="true"><i></i><i></i><i></i></span>
    </header>
    <div class="tool-preview-detail">{{ presentation.detail }}</div>
    <div v-if="presentation.previewText" class="tool-preview-code-shell">
      <div ref="previewScroller" class="tool-preview-code-scroll">
        <pre><code>{{ presentation.previewText }}</code><span class="tool-preview-caret" aria-hidden="true"></span></pre>
      </div>
      <AdvancedScrollbar
        :scroller="previewScroller"
        :refresh-key="presentation.previewText"
        variant="minimal"
      />
    </div>
  </section>
</template>

<style scoped>
.tool-preview-card {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-left: 2px solid var(--vscode-descriptionForeground);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  color: var(--vscode-foreground);
  min-width: 0;
}

.tool-preview-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

.tool-preview-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--vscode-descriptionForeground);
}

.tool-preview-heading {
  flex: 1 1 auto;
  display: grid;
  gap: 2px;
  min-width: 0;
}

.tool-preview-heading strong {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.35;
}

.tool-preview-subject {
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-preview-detail {
  padding-left: 28px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-preview-pulse {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
}

.tool-preview-pulse i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.3;
  animation: tool-preview-pulse 1s ease-in-out infinite;
}

.tool-preview-pulse i:nth-child(2) { animation-delay: 120ms; }
.tool-preview-pulse i:nth-child(3) { animation-delay: 240ms; }

.tool-preview-code-shell {
  position: relative;
  min-width: 0;
  max-height: 168px;
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 76%, transparent);
  background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 86%, transparent);
}

.tool-preview-code-scroll {
  max-height: 168px;
  overflow: auto;
  scrollbar-width: none;
}

.tool-preview-code-scroll::-webkit-scrollbar { display: none; }

.tool-preview-code-scroll pre {
  width: max-content;
  min-width: 100%;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  box-sizing: border-box;
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  line-height: 1.5;
  white-space: pre;
}

.tool-preview-caret {
  display: inline-block;
  width: 1px;
  height: 1.05em;
  margin-left: 1px;
  vertical-align: -0.14em;
  background: currentColor;
  animation: tool-preview-caret 0.8s steps(2, end) infinite;
}

@keyframes tool-preview-pulse {
  0%, 70%, 100% { opacity: 0.25; transform: translateY(0); }
  35% { opacity: 0.9; transform: translateY(-2px); }
}

@keyframes tool-preview-caret {
  0%, 45% { opacity: 0.9; }
  46%, 100% { opacity: 0.15; }
}

@media (prefers-reduced-motion: reduce) {
  .tool-preview-pulse i,
  .tool-preview-caret { animation: none; }
}
</style>

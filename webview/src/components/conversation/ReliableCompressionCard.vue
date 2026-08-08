<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronRight, IconCopy, IconCheck, IconX } from '@tabler/icons-vue';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type ContentPart,
  type MessageContent
} from '@shared/protocol';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';

const props = defineProps<{
  block: Record<string, unknown>;
}>();
const emit = defineEmits<{ (event: 'dismiss'): void }>();

const { feed } = useReliableConversation();
const expanded = ref(false);
const copied = ref(false);

const blockId = computed(() => stringValue(props.block.id));
const contentDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-content', blockId.value)
]);
const titleDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-title', blockId.value)
]);
const presentationDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-presentation', blockId.value)
]);
const presentation = computed(() => parsePresentation(
  presentationDetail.value?.status === 'ready' ? presentationDetail.value.text : ''
));
const envelope = computed(() => parseEnvelope(contentDetail.value?.status === 'ready' ? contentDetail.value.text : ''));
const status = computed(() => stringValue(props.block.status) || 'enabled');
const committed = computed(() => ['enabled', 'disabled', 'soft_deleted'].includes(status.value));
const trigger = computed(() =>
  stringValue(props.block.trigger) || presentation.value.trigger || envelope.value.trigger || 'manual'
);
const methodKind = computed(() =>
  stringValue(props.block.method_kind ?? props.block.methodKind)
  || presentation.value.methodKind
  || envelope.value.methodKind
);
const title = computed(() => titleDetail.value?.status === 'ready' && titleDetail.value.text.trim()
  ? titleDetail.value.text.trim()
  : presentation.value.title
    || stringValue(props.block.title)
    || (trigger.value === 'auto' ? '自动上下文压缩' : '上下文压缩'));
const methodLabel = computed(() => {
  switch (methodKind.value) {
    case 'openai_responses_compact': return 'OpenAI 原生压缩';
    case 'llm_summary': return 'LLM 总结';
    case 'segmented_summary': return '分段总结';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    default: return '可靠压缩';
  }
});
const sourceCount = computed(() => nonNegativeInteger(props.block.source_count) ?? nonNegativeInteger(props.block.sourceCount));
const statusLabel = computed(() => status.value === 'enabled'
  ? '已完成'
  : status.value === 'disabled'
    ? '已禁用'
    : status.value === 'soft_deleted'
      ? '已删除'
      : status.value === 'pending'
        ? '准备中'
        : status.value === 'retrying'
          ? '恢复中'
          : status.value === 'committing'
            ? '保存中'
            : '压缩中');
const summaryText = computed(() => renderContents(envelope.value.contents));
const providerNative = computed(() => envelope.value.contents.some((content) =>
  content.parts.some((part) => isProviderContextPart(part))
));
const beforeTokens = computed(() => nonNegativeInteger(envelope.value.estimatedTokensBefore));
const afterTokens = computed(() => nonNegativeInteger(envelope.value.estimatedTokensAfter));
const savedTokens = computed(() => beforeTokens.value !== undefined && afterTokens.value !== undefined
  ? Math.max(0, beforeTokens.value - afterTokens.value)
  : undefined);
const subtitle = computed(() => {
  if (status.value === 'pending') return `${methodLabel.value} · 正在准备上下文压缩`;
  if (status.value === 'running') return `${methodLabel.value} · 正在压缩上下文`;
  if (status.value === 'committing') return `${methodLabel.value} · 压缩已完成，正在保存结果`;
  if (status.value === 'retrying') {
    const reason = stringValue(props.block.retry_reason_label) || '压缩连接异常';
    const seconds = nonNegativeInteger(props.block.retry_delay_seconds) ?? 0;
    const attempt = nonNegativeInteger(props.block.retry_attempt) ?? 0;
    const maximum = nonNegativeInteger(props.block.retry_max_attempts) ?? attempt;
    return `${reason} · ${seconds} 秒后自动恢复${attempt > 0 ? `（第 ${attempt}/${maximum} 次）` : ''}`;
  }
  const facts = [methodLabel.value];
  if (sourceCount.value !== undefined) facts.push(`${sourceCount.value} 个上下文段`);
  if (savedTokens.value !== undefined) facts.push(`节省约 ${savedTokens.value} tokens`);
  return facts.join(' · ');
});

watch(
  () => `${blockId.value}:${committed.value ? 'committed' : 'active'}:${presentationDetail.value?.status ?? 'missing'}`,
  () => {
    if (!blockId.value || !committed.value || presentationDetail.value) return;
    feed.requestDetail('compression-presentation', blockId.value, { priority: 'visible' });
  },
  { immediate: true }
);

function toggle(): void {
  if (!committed.value) return;
  expanded.value = !expanded.value;
  if (!expanded.value || !blockId.value) return;
  for (const kind of ['compression-title', 'compression-content'] as const) {
    const detail = feed.details[reliableKernelDetailKey(kind, blockId.value)];
    if (detail?.status === 'error') feed.retryDetail(kind, blockId.value, { priority: 'expanded' });
    else feed.requestDetail(kind, blockId.value, { priority: 'expanded' });
  }
}

async function copySummary(): Promise<void> {
  if (!summaryText.value) return;
  await navigator.clipboard.writeText(summaryText.value);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1200);
}

function parseEnvelope(text: string): {
  trigger?: string;
  methodKind?: string;
  contents: MessageContent[];
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
} {
  if (!text.trim()) return { contents: [] };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return { contents: normalizeContents(parsed) };
    const record = asRecord(parsed);
    if (!record) return { contents: [{ role: 'user', parts: [{ text }] }] };
    const contents = normalizeContents(record.contents ?? record.resultContents ?? []);
    return {
      contents,
      ...(stringValue(record.trigger) ? { trigger: stringValue(record.trigger) } : {}),
      ...(stringValue(record.methodKind ?? record.method_kind) ? { methodKind: stringValue(record.methodKind ?? record.method_kind) } : {}),
      ...(nonNegativeInteger(record.estimatedTokensBefore ?? record.estimated_tokens_before) !== undefined
        ? { estimatedTokensBefore: nonNegativeInteger(record.estimatedTokensBefore ?? record.estimated_tokens_before) }
        : {}),
      ...(nonNegativeInteger(record.estimatedTokensAfter ?? record.estimated_tokens_after) !== undefined
        ? { estimatedTokensAfter: nonNegativeInteger(record.estimatedTokensAfter ?? record.estimated_tokens_after) }
        : {})
    };
  } catch {
    return { contents: [{ role: 'user', parts: [{ text }] }] };
  }
}

function parsePresentation(text: string): { title?: string; trigger?: string; methodKind?: string } {
  if (!text.trim()) return {};
  try {
    const record = asRecord(JSON.parse(text) as unknown);
    if (!record) return {};
    return {
      ...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
      ...(stringValue(record.trigger) ? { trigger: stringValue(record.trigger) } : {}),
      ...(stringValue(record.methodKind) ? { methodKind: stringValue(record.methodKind) } : {})
    };
  } catch {
    return {};
  }
}

function normalizeContents(value: unknown): MessageContent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || !Array.isArray(record.parts)) return [];
    return [{
      role: record.role === 'model' ? 'model' : 'user',
      parts: record.parts as ContentPart[]
    } satisfies MessageContent];
  });
}

function renderContents(contents: MessageContent[]): string {
  return contents.flatMap((content) => content.parts.map(renderPart)).filter(Boolean).join('\n').trim();
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[工具调用] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[工具结果] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isProviderContextPart(part)) return `[Provider 原生上下文] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  if (isInlineDataPart(part)) return `[内联数据] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[文件] ${part.fileData.uri}`;
  return '';
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
</script>

<template>
  <section
    class="reliable-compression-card"
    data-testid="compression-card"
    :data-compression-block-id="blockId"
    :data-trigger="trigger"
    :data-status="status"
    :aria-busy="!committed"
  >
    <button
      type="button"
      class="compression-card-main"
      :class="{ active: !committed }"
      data-testid="compression-card-toggle"
      :disabled="!committed"
      @click="toggle"
    >
      <IconChevronRight v-if="committed" class="compression-card-chevron" :class="{ expanded }" size="16" />
      <span v-else class="compression-card-progress" aria-hidden="true" />
      <span class="compression-card-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 5h14l-7 6zM5 19h14l-7-6z" /></svg>
      </span>
      <span class="compression-card-copy">
        <strong>{{ title }}</strong>
        <small>{{ subtitle }}</small>
      </span>
      <span class="compression-card-status" role="status">{{ statusLabel }}</span>
    </button>
    <button
      v-if="committed"
      type="button"
      class="compression-card-dismiss"
      aria-label="关闭上下文压缩提示"
      @click="emit('dismiss')"
    >
      <IconX size="15" />
    </button>

    <div v-if="committed && expanded" class="compression-card-detail" data-testid="compression-detail">
      <p v-if="contentDetail?.status === 'loading' || !contentDetail">正在读取压缩结果…</p>
      <p v-else-if="contentDetail.status === 'error'" data-testid="compression-detail-error">{{ contentDetail.error || '压缩详情读取失败' }}</p>
      <template v-else>
        <p v-if="providerNative" class="compression-provider-note">该块保留 OpenAI Responses 原生上下文；下一请求会按原始结构复用，不会转换成 Markdown。</p>
        <pre v-if="summaryText" data-testid="compression-detail-summary">{{ summaryText }}</pre>
        <p v-else>压缩结果没有可见文本，但可能包含 Provider 原生上下文。</p>
        <button v-if="summaryText" type="button" class="compression-copy" @click="copySummary">
          <IconCheck v-if="copied" size="15" />
          <IconCopy v-else size="15" />
          {{ copied ? '已复制' : '复制压缩内容' }}
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.reliable-compression-card {
  position: relative;
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4)) var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}
.compression-card-main { width: 100%; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) 44px var(--space-3) var(--space-3); border: 0; color: inherit; background: transparent; text-align: left; }
.compression-card-main:disabled { cursor: default; opacity: 1; }
.compression-card-main.active { padding-right: var(--space-3); }
.compression-card-chevron { flex: 0 0 auto; transition: transform 120ms ease; }
.compression-card-chevron.expanded { transform: rotate(90deg); }
.compression-card-progress { width: 8px; height: 8px; margin: 0 4px; flex: 0 0 auto; border-radius: 50%; background: currentColor; animation: compression-pulse 1.2s ease-in-out infinite; }
.compression-card-symbol { width: 16px; height: 16px; flex: 0 0 auto; }
.compression-card-symbol svg { width: 100%; height: 100%; fill: currentColor; }
.compression-card-copy { min-width: 0; display: grid; gap: 2px; }
.compression-card-copy small { color: var(--vscode-descriptionForeground); }
.compression-card-status { margin-left: auto; color: var(--vscode-descriptionForeground); }
.compression-card-dismiss { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--vscode-descriptionForeground); background: transparent; }
.compression-card-dismiss:hover,
.compression-card-dismiss:focus-visible { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); outline: none; }
.compression-card-detail { display: grid; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3) calc(var(--space-3) + 40px); }
.compression-card-detail p { margin: 0; color: var(--vscode-descriptionForeground); }
.compression-card-detail pre { max-height: 320px; margin: 0; padding: var(--space-2); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); font: inherit; }
.compression-copy { justify-self: start; display: inline-flex; align-items: center; gap: 6px; }
@keyframes compression-pulse {
  0%, 100% { opacity: 0.28; transform: scale(0.72); }
  50% { opacity: 0.9; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .compression-card-progress { animation: none; opacity: 0.75; }
}
</style>

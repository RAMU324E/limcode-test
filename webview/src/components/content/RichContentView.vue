<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  isFunctionCallPart,
  type ContentPart,
  type FunctionCallPart,
  type ToolCallRecord,
  type ToolCallStatus,
  type ToolSchedulingMode
} from '@shared/protocol';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableToolCallForPart } from '@webview/domain/reliablePresentationIndex';
import { useContentBlockWindow } from '@webview/composables/useContentBlockWindow';
import StreamingIndicatorTail from './StreamingIndicatorTail.vue';
import { partViewComponent, RichRenderNodeProjector, type RichRenderNode } from './partRegistry';

const props = defineProps<{
  parts: ContentPart[];
  streaming?: boolean;
  markdown?: boolean;
  messageId?: string;
  scroller?: HTMLElement | null;
}>();

interface ToolBatchMeta {
  batchIndex: number;
  batchMode: ToolSchedulingMode;
  batchState: 'active' | 'completed' | 'pending';
  batchPosition: 'single' | 'first' | 'middle' | 'last';
  batchSize: number;
  activeBatchIndex?: number;
  batchColorIndex: number;
}

interface ToolCallNodeInfo {
  nodeIndex: number;
  call?: ToolCallRecord;
  mode: ToolSchedulingMode;
  blocking: boolean;
}

const reliableConversation = useReliableConversation();
const globalSettings = useGlobalSettingsStore();
const nodeProjector = new RichRenderNodeProjector();
const rawNodes = computed(() => nodeProjector.project(props.parts));
let previousBatchNodes = new Map<string, RichRenderNode>();
const nodes = computed(() => withToolBatchMeta(rawNodes.value));
const blockKeys = computed<readonly string[]>((previous) => {
  const next = nodes.value.map(node => node.key);
  return previous?.length === next.length && next.every((key, index) => key === previous[index]) ? previous : next;
});
const root = ref<HTMLElement | null>(null);
const blockWindow = useContentBlockWindow({ keys: blockKeys, root, scroller: computed(() => props.scroller) });
const visibleNodes = computed(() => nodes.value.slice(blockWindow.start.value, blockWindow.end.value));
const messageToolCalls = computed(() => props.messageId
  ? reliableConversation.projection.value.toolCallsByMessageId[props.messageId] : undefined);
const showToolExecutingTail = computed(() => {
  if (props.streaming || !props.messageId) return false;
  return messageToolCalls.value?.some(call => isToolExecutingStatus(call.status, call.progress)) ?? false;
});
const showStandaloneStreamingTail = computed(() => {
  if (!props.streaming || nodes.value.length === 0) return false;
  const lastIndex = nodes.value.length - 1;
  const last = nodes.value[lastIndex];
  return !!last && !nodeStreaming(last, lastIndex);
});
const standaloneStreamingPhase = computed(() => streamingPhase());
const standaloneStreamingText = computed(() => standaloneStreamingPhase.value === 'thinking'
  ? globalSettings.appearance.streamingTextThinking
  : globalSettings.appearance.streamingTextWriting
);

function nodeStreaming(node: RichRenderNode, index: number): boolean {
  if (!props.streaming || index !== nodes.value.length - 1) return false;
  if (node.kind === 'thought') return node.props.thoughtOpen === true;
  return node.kind === 'text';
}

function nodeComponentProps(node: RichRenderNode, index: number): Record<string, unknown> {
  if (node.kind === 'text') {
    return {
      ...node.props,
      markdown: props.markdown,
      streaming: nodeStreaming(node, index),
      streamingPhase: streamingPhase()
    };
  }
  if (node.kind === 'thought') {
    const thoughtProps = { ...node.props };
    delete thoughtProps.thoughtOpen;
    return {
      ...thoughtProps,
      streaming: nodeStreaming(node, index),
      streamingPhase: streamingPhase()
    };
  }
  if (node.kind === 'functionCall') {
    return {
      ...node.props,
      messageId: props.messageId,
      streaming: props.streaming === true
    };
  }
  if (node.kind === 'functionResponse' || node.kind === 'inlineData' || node.kind === 'fileData') {
    return { part: node.props.part };
  }
  return node.props;
}

/**
 * 判断当前流式阶段：
 *   - 'waiting'：流式中但还没有任何内容块
 *   - 'thinking'：最后一个内容块仍是思考；块间签名边界不能抢先宣告正文输出
 *   - 'writing'：最后一个内容块是正在输出的正文
 */
function streamingPhase(): 'waiting' | 'thinking' | 'writing' {
  if (!props.streaming) return 'writing';
  if (nodes.value.length === 0) return 'waiting';
  const last = nodes.value[nodes.value.length - 1]!;
  if (last.kind === 'thought') return 'thinking';
  return 'writing';
}

function withToolBatchMeta(inputNodes: RichRenderNode[]): RichRenderNode[] {
  const result = inputNodes.map((node) => node.kind === 'functionCall' ? { ...node, props: { ...node.props } } : node);
  let segment: ToolCallNodeInfo[] = [];
  let functionOrdinal = 0;

  const flushSegment = (): void => {
    if (segment.length === 0) return;
    applyBatchMeta(result, segment);
    segment = [];
  };

  for (let index = 0; index < result.length; index += 1) {
    const node = result[index]!;
    if (node.kind === 'functionCall') {
      node.props.toolOrdinal = functionOrdinal;
      functionOrdinal += 1;
      const call = toolCallForNode(node);
      segment.push({
        nodeIndex: index,
        call,
        mode: call?.schedulingMode ?? 'serial',
        blocking: call ? isBlockingToolCall(call) : true
      });
      continue;
    }
    flushSegment();
  }
  flushSegment();

  const next = new Map<string, RichRenderNode>();
  for (let index = 0; index < result.length; index += 1) {
    const node = result[index]!;
    if (node.kind !== 'functionCall') continue;
    const prior = previousBatchNodes.get(node.key);
    const keys = Object.keys(node.props);
    if (prior && keys.length === Object.keys(prior.props).length && keys.every(key => node.props[key] === prior.props[key])) result[index] = prior;
    next.set(node.key, result[index]!);
  }
  previousBatchNodes = next;
  return result;
}

function applyBatchMeta(nodesToUpdate: RichRenderNode[], segment: ToolCallNodeInfo[]): void {
  const batches: ToolCallNodeInfo[][] = [];
  for (const item of segment) {
    const current = batches[batches.length - 1];
    if (current && item.mode === 'parallel' && current[0]?.mode === 'parallel') {
      current.push(item);
    } else {
      batches.push([item]);
    }
  }

  const activeBatchOffset = batches.findIndex((batch) => batch.some((item) => item.blocking));
  const activeBatchIndex = activeBatchOffset >= 0 ? activeBatchOffset + 1 : undefined;

  batches.forEach((batch, batchOffset) => {
    const batchIndex = batchOffset + 1;
    const batchState: ToolBatchMeta['batchState'] = activeBatchIndex === undefined
      ? 'completed'
      : batchIndex < activeBatchIndex
        ? 'completed'
        : batchIndex === activeBatchIndex
          ? 'active'
          : 'pending';

    batch.forEach((item, positionIndex) => {
      const position = batch.length === 1
        ? 'single'
        : positionIndex === 0
          ? 'first'
          : positionIndex === batch.length - 1
            ? 'last'
            : 'middle';
      Object.assign(nodesToUpdate[item.nodeIndex]!.props, {
        batchIndex,
        batchMode: batch[0]!.mode,
        batchState,
        batchPosition: position,
        batchSize: batch.length,
        batchColorIndex: colorIndexForBatch(batchIndex),
        ...(activeBatchIndex !== undefined ? { activeBatchIndex } : {})
      } satisfies ToolBatchMeta);
    });
  });
}

function colorIndexForBatch(batchIndex: number): number {
  return ((batchIndex - 1) % 5) + 1;
}

function toolCallForNode(node: RichRenderNode): ToolCallRecord | undefined {
  if (!props.messageId) return undefined;
  const part = node.props.part;
  if (!isFunctionCallPart(part as ContentPart)) return undefined;
  const functionCallPart = part as FunctionCallPart;
  const ordinal = typeof node.props.toolOrdinal === 'number' ? node.props.toolOrdinal : undefined;
  return reliableToolCallForPart(reliableConversation.projection.value.index, props.messageId, functionCallPart, ordinal);
}

function isBlockingToolCall(call: ToolCallRecord): boolean {
  return call.status === 'streaming'
    || call.status === 'queued'
    || call.status === 'awaiting_approval'
    || call.status === 'awaiting_user_input'
    || call.status === 'awaiting_child'
    || call.status === 'executing'
    || call.status === 'awaiting_change_apply'
    || call.status === 'applying_change'
    || call.status === 'change_applied'
    || call.status === 'change_rejected'
    || call.status === 'awaiting_result_submit';
}

function isToolExecutingStatus(status: ToolCallStatus, progress: unknown): boolean {
  if (status === 'queued' || status === 'awaiting_child' || status === 'executing' || status === 'applying_change') return true;
  return status === 'awaiting_approval' && isExecutionApprovedProgress(progress);
}

function isExecutionApprovedProgress(progress: unknown): boolean {
  return !!progress
    && typeof progress === 'object'
    && !Array.isArray(progress)
    && (progress as Record<string, unknown>).executionApproved === true;
}
</script>

<template>
  <div ref="root" class="rich-content">
    <template v-if="nodes.length">
      <div v-if="blockWindow.beforeHeight.value > 0" class="rich-content-spacer" :style="{ height: `${blockWindow.beforeHeight.value}px` }" aria-hidden="true" />
      <div v-for="(node, index) in visibleNodes" :key="node.key"
        :ref="element => blockWindow.bindBlock(node.key, element)"
        class="rich-content-block" :data-content-block-key="node.key">
        <component :is="partViewComponent(node.kind)" v-bind="nodeComponentProps(node, blockWindow.start.value + index)" />
      </div>
      <div v-if="blockWindow.afterHeight.value > 0" class="rich-content-spacer" :style="{ height: `${blockWindow.afterHeight.value}px` }" aria-hidden="true" />
      <div v-if="showStandaloneStreamingTail" class="rich-streaming-tail-row">
        <StreamingIndicatorTail :text="standaloneStreamingText" :variant="standaloneStreamingPhase" />
      </div>
      <div v-if="showToolExecutingTail" class="rich-streaming-tail-row">
        <StreamingIndicatorTail :text="globalSettings.appearance.streamingTextToolExecuting" variant="executing" />
      </div>
    </template>
    <!-- 流式中但还没有任何内容块：渲染一个仅含光标的空文本节点。 -->
    <component
      :is="partViewComponent('text')"
      v-else-if="streaming"
      :text="''"
      :markdown="markdown"
      :streaming="true"
      :streaming-phase="'waiting'"
    />
  </div>
</template>

<style scoped>
.rich-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.rich-content-block { min-width: 0; }
.rich-content-spacer { flex-shrink: 0; pointer-events: none; }

.rich-streaming-tail-row {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: italic;
  min-width: 0;
}
</style>

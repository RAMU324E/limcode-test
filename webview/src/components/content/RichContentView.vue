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
import { IconTool } from '@tabler/icons-vue';
import StreamingIndicatorTail from './StreamingIndicatorTail.vue';
import CollapsibleContentBlock from './CollapsibleContentBlock.vue';
import { formatThoughtDuration } from './thoughtTiming';
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

interface StepGroup {
  items: { node: RichRenderNode; index: number }[];
  label: string;
  meta: string;
  active: boolean;
  forceOpen: boolean;
}

/** 简洁模式下，连续的思考与工具调用合并成一行可展开的步骤摘要；其余节点照常逐个显示。 */
type DisplayBlock =
  | { key: string; node: RichRenderNode; index: number; group?: undefined }
  | { key: string; group: StepGroup; node?: undefined; index?: undefined };

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
const displayBlocks = computed(() => globalSettings.appearance.conciseMode
  ? groupStepRuns(nodes.value)
  : nodes.value.map((node, index): DisplayBlock => ({ key: node.key, node, index })));
const expandedGroups = ref(new Set<string>());
const blockKeys = computed<readonly string[]>((previous) => {
  const next = displayBlocks.value.map(block => block.key);
  return previous?.length === next.length && next.every((key, index) => key === previous[index]) ? previous : next;
});
const root = ref<HTMLElement | null>(null);
const blockWindow = useContentBlockWindow({ keys: blockKeys, root, scroller: computed(() => props.scroller) });
const visibleBlocks = computed(() => displayBlocks.value.slice(blockWindow.start.value, blockWindow.end.value));
const messageToolCalls = computed(() => props.messageId
  ? reliableConversation.projection.value.toolCallsByMessageId[props.messageId] : undefined);
const endsWithStepGroup = computed(() => displayBlocks.value[displayBlocks.value.length - 1]?.group !== undefined);
const showToolExecutingTail = computed(() => {
  if (props.streaming || !props.messageId || endsWithStepGroup.value) return false;
  return messageToolCalls.value?.some(call => isToolExecutingStatus(call.status, call.progress)) ?? false;
});
const showStandaloneStreamingTail = computed(() => {
  if (!props.streaming || nodes.value.length === 0 || endsWithStepGroup.value) return false;
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

function groupStepRuns(inputNodes: RichRenderNode[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  let run: { node: RichRenderNode; index: number }[] = [];
  const flushRun = (): void => {
    // 思考一出现就进步骤卡，之后只在这一行里更新文字，不再从思考行、编写中尾行切换成卡片。
    if (run.some(item => item.node.kind === 'thought' || item.node.kind === 'functionCall')) {
      blocks.push({ key: `steps:${run[0]!.node.key}`, group: stepGroup(run, run[run.length - 1]!.index === inputNodes.length - 1) });
    } else {
      for (const item of run) blocks.push({ key: item.node.key, ...item });
    }
    run = [];
  };
  inputNodes.forEach((node, index) => {
    if (node.kind === 'thought' || node.kind === 'functionCall' || node.kind === 'functionResponse') {
      run.push({ node, index });
      return;
    }
    flushRun();
    blocks.push({ key: node.key, node, index });
  });
  flushRun();
  return blocks;
}

function stepGroup(items: StepGroup['items'], atEnd: boolean): StepGroup {
  const steps: string[] = [];
  let active = props.streaming === true && atEnd;
  let forceOpen = false;
  let failed = 0;
  for (const { node } of items) {
    if (node.kind !== 'functionCall') continue;
    const call = toolCallForNode(node);
    steps.push(stepLabel(node.props.part as FunctionCallPart, call));
    if (!call) {
      active ||= props.streaming === true;
      continue;
    }
    active ||= isBlockingToolCall(call);
    // 等待用户处理（执行审批、修改审批、提问等）的调用不能藏在收起的摘要里。
    forceOpen ||= call.status === 'awaiting_user_input'
      || reliableConversation.projection.value.interactionByToolCallId[call.id]?.status === 'pending';
    if (call.status === 'error') failed += 1;
  }
  const last = items[items.length - 1]!.node;
  const thinking = props.streaming === true && atEnd && last.kind === 'thought' && last.props.thoughtOpen === true;
  let label = steps.slice(0, 3).join(' · ');
  if (steps.length > 3) label += active ? ` … ${steps[steps.length - 1]}` : ' 等';
  if (!label) label = thinking ? globalSettings.appearance.streamingTextThinking : thoughtLabel(items);
  const meta = [steps.length > 0 ? `${steps.length} 步` : '', failed > 0 ? `${failed} 失败` : '',
    thinking && steps.length > 0 ? '思考中' : active && !thinking ? '进行中' : ''].filter(Boolean).join(' · ');
  return { items, label, meta, active, forceOpen };
}

function thoughtLabel(items: StepGroup['items']): string {
  const durationMs = items.reduce((sum, { node }) => sum + (typeof node.props.durationMs === 'number' ? node.props.durationMs : 0), 0);
  return durationMs > 0 ? `已思考 ${formatThoughtDuration(durationMs)}` : '思考';
}

function stepLabel(part: FunctionCallPart, call: ToolCallRecord | undefined): string {
  const args = part.functionCall.args && typeof part.functionCall.args === 'object' && !Array.isArray(part.functionCall.args)
    ? part.functionCall.args as Record<string, unknown> : undefined;
  const path = typeof args?.path === 'string' ? args.path.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const fallback = [call?.summary, args?.command, args?.query, args?.url, args?.explanation]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const target = path ?? (fallback ? shortStepText(fallback) : undefined);
  return target ? `${part.functionCall.name} ${target}` : part.functionCall.name;
}

function shortStepText(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
}

function toggleStepGroup(key: string, expanded: boolean): void {
  const next = new Set(expandedGroups.value);
  if (expanded) next.add(key);
  else next.delete(key);
  expandedGroups.value = next;
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
      <div v-for="block in visibleBlocks" :key="block.key"
        :ref="element => blockWindow.bindBlock(block.key, element)"
        class="rich-content-block" :data-content-block-key="block.key">
        <component :is="partViewComponent(block.node.kind)" v-if="block.node" v-bind="nodeComponentProps(block.node, block.index)" />
        <CollapsibleContentBlock v-else class="rich-step-group"
          :expanded="block.group.forceOpen || expandedGroups.has(block.key)"
          :icon-active="block.group.active"
          :aria-label="`${block.group.label}（${block.group.meta}）`"
          @update:expanded="toggleStepGroup(block.key, $event)">
          <template #icon><IconTool stroke="2" /></template>
          <template #summary>
            <span class="rich-step-group-label">{{ block.group.label }}</span>
            <span class="rich-step-group-meta">{{ block.group.meta }}</span>
          </template>
          <div class="rich-step-group-body">
            <div v-for="item in block.group.items" :key="item.node.key" class="rich-content-block">
              <component :is="partViewComponent(item.node.kind)" v-bind="nodeComponentProps(item.node, item.index)" />
            </div>
          </div>
        </CollapsibleContentBlock>
      </div>
      <div v-if="blockWindow.afterHeight.value > 0" class="rich-content-spacer" :style="{ height: `${blockWindow.afterHeight.value}px` }" aria-hidden="true" />
      <div v-if="showStandaloneStreamingTail" class="rich-streaming-tail-row">
        <StreamingIndicatorTail :text="standaloneStreamingText" :variant="standaloneStreamingPhase" />
      </div>
      <div v-if="showToolExecutingTail" class="rich-streaming-tail-row">
        <StreamingIndicatorTail :text="globalSettings.appearance.streamingTextToolExecuting" variant="executing" />
      </div>
    </template>
    <!-- 简洁模式下等待首个内容块时就显示步骤卡的样子，内容到达后原地变成步骤摘要。 -->
    <CollapsibleContentBlock v-else-if="streaming && globalSettings.appearance.conciseMode" class="rich-step-group"
      :collapsible="false" icon-active :aria-label="globalSettings.appearance.streamingTextWaiting">
      <template #icon><IconTool stroke="2" /></template>
      <template #summary><span class="rich-step-group-label">{{ globalSettings.appearance.streamingTextWaiting }}</span></template>
    </CollapsibleContentBlock>
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

.rich-step-group-label {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rich-step-group-meta {
  flex: 0 0 auto;
  margin-left: 6px;
  opacity: 0.75;
  white-space: nowrap;
}

.rich-step-group-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}
.rich-content-spacer { flex-shrink: 0; pointer-events: none; }

.rich-streaming-tail-row {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: italic;
  min-width: 0;
}
</style>

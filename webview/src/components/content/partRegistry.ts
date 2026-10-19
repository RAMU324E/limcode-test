import { reliableOutputItemIdentity } from '@webview/domain/reliableOutputItemIdentity';
import type { Component } from 'vue';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart,
  type ContentPart,
  type TextPart
} from '@shared/protocol';
import TextPartView from './parts/TextPartView.vue';
import ThoughtPartView from './parts/ThoughtPartView.vue';
import FunctionCallPartView from './parts/FunctionCallPartView.vue';
import FunctionResponsePartView from './parts/FunctionResponsePartView.vue';
import InlineDataPartView from './parts/InlineDataPartView.vue';
import FileDataPartView from './parts/FileDataPartView.vue';

/**
 * 富内容显示子组件注册表。
 *
 * 这里是 ContentPart -> 渲染节点的唯一编排层。它按后端传来的 parts 原始顺序生成节点，
 * MessageItem 不再关心正文、思考、工具、附件之间的排列关系。
 */
export type RichPartKind = 'text' | 'thought' | 'functionCall' | 'functionResponse' | 'inlineData' | 'fileData';

export interface RichRenderNode {
  readonly key: string;
  readonly kind: RichPartKind;
  readonly props: Record<string, unknown>;
}

const COMPONENTS: Record<RichPartKind, Component> = {
  text: TextPartView,
  thought: ThoughtPartView,
  functionCall: FunctionCallPartView,
  functionResponse: FunctionResponsePartView,
  inlineData: InlineDataPartView,
  fileData: FileDataPartView
};

export function partViewComponent(kind: RichPartKind): Component {
  return COMPONENTS[kind];
}

interface TextBuffer {
  kind: 'text' | 'thought';
  startIndex: number;
  endIndex: number;
  parts: TextPart[];
}

/** 把消息 parts 按原始顺序归约为渲染节点。只合并连续同类文本，不跨工具/附件/思考边界重排。 */
export function toRenderNodes(parts: readonly ContentPart[], startIndex = 0, atMessageStart = true): RichRenderNode[] {
  const nodes: RichRenderNode[] = [];
  let textBuffer: TextBuffer | undefined;

  const flushTextBuffer = (): void => {
    if (!textBuffer) return;
    const buffer = textBuffer;
    textBuffer = undefined;
    const separator = buffer.kind === 'thought' ? '\n' : '';
    const text = buffer.parts.map((part) => part.text).join(separator);
    const normalizedText = atMessageStart && nodes.length === 0 && buffer.kind === 'text' ? text.trimStart() : text;
    const hasThoughtTiming = buffer.kind === 'thought' && buffer.parts.some((part) =>
      (typeof part.thoughtStartedAt === 'number' && Number.isFinite(part.thoughtStartedAt) && part.thoughtStartedAt > 0)
      || (typeof part.thoughtCompletedDurationMs === 'number' && Number.isFinite(part.thoughtCompletedDurationMs) && part.thoughtCompletedDurationMs > 0)
      || (typeof part.thoughtElapsedMs === 'number' && Number.isFinite(part.thoughtElapsedMs) && part.thoughtElapsedMs > 0)
      || (typeof part.thoughtDurationMs === 'number' && Number.isFinite(part.thoughtDurationMs) && part.thoughtDurationMs > 0)
    );
    if (!normalizedText.trim() && !hasThoughtTiming) return;

    if (buffer.kind === 'thought') {
      const durations = buffer.parts
        .map((part) => part.thoughtDurationMs)
        .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
      const summedCompletedDurationMs = durations.reduce((sum, duration) => sum + duration, 0);
      const carriedCompletedDurations = buffer.parts
        .map((part) => part.thoughtCompletedDurationMs)
        .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
      const carriedCompletedDurationMs = carriedCompletedDurations.length > 0
        ? carriedCompletedDurations.reduce((max, duration) => Math.max(max, duration), 0)
        : undefined;
      const completedDurationMs = durations.length > 0 || carriedCompletedDurationMs !== undefined
        ? Math.max(summedCompletedDurationMs, carriedCompletedDurationMs ?? 0)
        : undefined;
      const thoughtOpen = buffer.parts.some((part) => part.thoughtDurationMs === undefined);
      const elapsedMs = thoughtOpen
        ? buffer.parts
          .map((part) => part.thoughtElapsedMs)
          .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration))
          .reduce((max, duration) => Math.max(max, duration), 0)
        : undefined;
      let startedAt: number | undefined;
      if (thoughtOpen) {
        for (let index = buffer.parts.length - 1; index >= 0; index -= 1) {
          const candidate = buffer.parts[index]?.thoughtStartedAt;
          if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
            startedAt = candidate;
            break;
          }
        }
      }
      const firstOutputItemId = reliableOutputItemIdentity(buffer.parts[0]?.outputItem);
      nodes.push({
        // Adjacent reasoning output items share one visible card. Anchor that card to its first
        // provider item so appending another reasoning item updates the existing Vue component
        // instead of remounting it and resetting its local expanded state.
        key: firstOutputItemId ? `thought:${firstOutputItemId}` : `thought:${buffer.startIndex}`,
        kind: 'thought',
        props: {
          text: normalizedText.trimEnd(),
          ...(!thoughtOpen && completedDurationMs !== undefined ? { durationMs: completedDurationMs } : {}),
          ...(thoughtOpen && completedDurationMs !== undefined ? { completedDurationMs } : {}),
          ...(elapsedMs !== undefined ? { elapsedMs } : {}),
          ...(startedAt !== undefined ? { startedAt } : {}),
          thoughtOpen
        }
      });
      return;
    }

    nodes.push({
      key: reliableOutputItemIdentity(buffer.parts[0]?.outputItem) ? `text:${reliableOutputItemIdentity(buffer.parts[0]?.outputItem)}` : `text:${buffer.startIndex}`,
      kind: 'text',
      props: { text: normalizedText }
    });
  };

  const pushTextPart = (part: TextPart, index: number): void => {
    const kind: TextBuffer['kind'] = part.thought === true ? 'thought' : 'text';
    const priorOutputItemId = reliableOutputItemIdentity(textBuffer?.parts[textBuffer.parts.length - 1]?.outputItem);
    const nextOutputItemId = reliableOutputItemIdentity(part.outputItem);
    const textOutputItemChanged = kind === 'text' && priorOutputItemId !== nextOutputItemId;
    if (!textBuffer || textBuffer.kind !== kind || textOutputItemChanged) {
      flushTextBuffer();
      textBuffer = { kind, startIndex: index, endIndex: index, parts: [part] };
      return;
    }

    textBuffer.endIndex = index;
    textBuffer.parts.push(part);
  };

  parts.forEach((part, localIndex) => {
    const index = startIndex + localIndex;
    if (isTextPart(part)) {
      pushTextPart(part, index);
      return;
    }

    flushTextBuffer();
    if (isFunctionCallPart(part)) {
      nodes.push({
        key: part.id ? `functionCall:${part.id}` : `functionCall:${index}:${part.functionCall.name}`,
        kind: 'functionCall',
        props: { part, partIndex: index }
      });
      return;
    }
    if (isFunctionResponsePart(part)) {
      nodes.push({
        key: part.id ? `functionResponse:${part.id}` : `functionResponse:${index}:${part.functionResponse.name}`,
        kind: 'functionResponse',
        props: { part, partIndex: index }
      });
      return;
    }
    if (isInlineDataPart(part)) {
      const identity = part.inlineData.attachmentId
        ?? part.inlineData.sourcePath
        ?? part.inlineData.sha256
        ?? part.inlineData.name
        ?? part.inlineData.mimeType;
      nodes.push({ key: `inlineData:${index}:${identity}`, kind: 'inlineData', props: { part, partIndex: index } });
      return;
    }
    if (isFileDataPart(part)) {
      nodes.push({ key: `fileData:${index}:${part.fileData.uri}`, kind: 'fileData', props: { part, partIndex: index } });
    }
  });

  flushTextBuffer();
  return nodes;
}


/** Completed blocks keep their render objects. Only a changed text run is joined again. */
export class RichRenderNodeProjector {
  private blocks = new Map<string, { parts: readonly ContentPart[]; start: number; first: boolean; nodes: RichRenderNode[] }>();
  private thoughtGroupKeys = new Map<string, string>();

  project(parts: readonly ContentPart[]): RichRenderNode[] {
    const next = new Map<string, { parts: readonly ContentPart[]; start: number; first: boolean; nodes: RichRenderNode[] }>();
    const nextThoughtGroupKeys = new Map<string, string>();
    const nodes: RichRenderNode[] = [];
    for (let start = 0; start < parts.length;) {
      const firstPart = parts[start]!;
      let end = start + 1;
      if (isTextPart(firstPart)) {
        while (end < parts.length) {
          const part = parts[end]!;
          if (!isTextPart(part) || (part.thought === true) !== (firstPart.thought === true)
            || (firstPart.thought !== true && reliableOutputItemIdentity(part.outputItem) !== reliableOutputItemIdentity(firstPart.outputItem))) break;
          end += 1;
        }
      }
      let key = isTextPart(firstPart) ? `${firstPart.thought ? 'thought' : 'text'}:${reliableOutputItemIdentity(firstPart.outputItem) ?? start}`
        : isFunctionCallPart(firstPart) ? `call:${firstPart.id ?? start}`
        : isFunctionResponsePart(firstPart) ? `result:${firstPart.id ?? start}` : `part:${start}`;
      if (isTextPart(firstPart) && firstPart.thought === true) {
        const itemIds: string[] = [];
        let retainedKey: string | undefined;
        for (let index = start; index < end; index += 1) {
          const itemId = reliableOutputItemIdentity(parts[index]!.outputItem);
          if (!itemId) continue;
          itemIds.push(itemId);
          const priorKey = this.thoughtGroupKeys.get(itemId);
          if (!retainedKey && priorKey && !next.has(priorKey)) retainedKey = priorKey;
        }
        // A resident item carries its card identity across prepends and prefix eviction. Only one
        // new group can inherit an old card if a changed boundary splits the previous group.
        key = retainedKey ?? key;
        for (const itemId of itemIds) nextThoughtGroupKeys.set(itemId, key);
      }
      const previous = this.blocks.get(key);
      const atStart = nodes.length === 0;
      const unchanged = previous && previous.start === start && previous.first === atStart
        && previous.parts.length === end - start && previous.parts.every((part, index) => part === parts[start + index]);
      const block = unchanged ? previous : {
        parts: parts.slice(start, end), start, first: atStart,
        nodes: toRenderNodes(parts.slice(start, end), start, atStart)
          .map(node => node.kind === 'thought' && node.key !== key ? { ...node, key } : node)
      };
      next.set(key, block);
      for (const node of block.nodes) nodes.push(node);
      start = end;
    }
    this.blocks = next;
    this.thoughtGroupKeys = nextThoughtGroupKeys;
    return nodes;
  }
}

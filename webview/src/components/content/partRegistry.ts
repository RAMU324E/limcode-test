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
export function toRenderNodes(parts: readonly ContentPart[]): RichRenderNode[] {
  const nodes: RichRenderNode[] = [];
  let textBuffer: TextBuffer | undefined;

  const flushTextBuffer = (): void => {
    if (!textBuffer) return;
    const buffer = textBuffer;
    textBuffer = undefined;
    const text = buffer.parts.map((part) => part.text).join('');
    const normalizedText = nodes.length === 0 && buffer.kind === 'text' ? text.trimStart() : text;
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
      nodes.push({
        key: `thought:${buffer.startIndex}:${buffer.endIndex}`,
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
      key: `text:${buffer.startIndex}:${buffer.endIndex}`,
      kind: 'text',
      props: { text: normalizedText }
    });
  };

  const pushTextPart = (part: TextPart, index: number): void => {
    const kind: TextBuffer['kind'] = part.thought === true ? 'thought' : 'text';
    if (!textBuffer || textBuffer.kind !== kind) {
      flushTextBuffer();
      textBuffer = { kind, startIndex: index, endIndex: index, parts: [part] };
      return;
    }

    textBuffer.endIndex = index;
    textBuffer.parts.push(part);
  };

  parts.forEach((part, index) => {
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

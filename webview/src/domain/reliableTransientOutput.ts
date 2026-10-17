import { reliableOutputItemIdentity } from './reliableOutputItemIdentity';
import type {
  ContentPart,
  MessageContent,
  ModelOutputItemReference,
  TextPart
} from '@shared/protocol';
import {
  transientFunctionCallParts,
  type ReliableTransientToolCallState
} from './reliableTransientModel';

export interface ReliableTransientTextDelta {
  text: string;
  thought: boolean;
  outputItem?: ModelOutputItemReference;
  thoughtSignature?: string;
  thoughtStartedAt?: number;
  thoughtCompletedDurationMs?: number;
  thoughtElapsedMs?: number;
}

export interface ReliableTransientThoughtUpdate {
  outputItem?: ModelOutputItemReference;
  thoughtSignature?: string;
  thoughtStartedAt?: number;
  thoughtCompletedDurationMs?: number;
  thoughtElapsedMs?: number;
  thoughtDurationMs?: number;
  done?: boolean;
}

/** Appends one text delta to its owning output item without moving prior tools or text blocks. */
export function appendReliableTransientTextPart(
  current: readonly ContentPart[],
  input: ReliableTransientTextDelta
): ContentPart[] {
  const next = [...current];
  const targetIndex = textPartIndex(next, input.thought, input.outputItem);
  if (targetIndex >= 0) {
    const target = next[targetIndex] as TextPart;
    next[targetIndex] = {
      ...target,
      text: target.text + input.text,
      ...(input.outputItem ? { outputItem: input.outputItem } : {}),
      ...(input.thoughtSignature ? { thoughtSignature: input.thoughtSignature } : {}),
      ...(input.thoughtStartedAt !== undefined ? { thoughtStartedAt: input.thoughtStartedAt } : {}),
      ...(input.thoughtCompletedDurationMs !== undefined
        ? { thoughtCompletedDurationMs: input.thoughtCompletedDurationMs }
        : {}),
      ...(input.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: input.thoughtElapsedMs } : {})
    };
    return next;
  }

  const part: TextPart = {
    text: input.text,
    ...(input.thought ? { thought: true } : {}),
    ...(input.outputItem ? { outputItem: input.outputItem } : {}),
    ...(input.thoughtSignature ? { thoughtSignature: input.thoughtSignature } : {}),
    ...(input.thoughtStartedAt !== undefined ? { thoughtStartedAt: input.thoughtStartedAt } : {}),
    ...(input.thoughtCompletedDurationMs !== undefined
      ? { thoughtCompletedDurationMs: input.thoughtCompletedDurationMs }
      : {}),
    ...(input.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: input.thoughtElapsedMs } : {})
  };
  return insertByOutputOrdinal(next, part);
}

/** Updates timing/signature for one reasoning item, creating an empty timed item when needed. */
export function updateReliableTransientThoughtPart(
  current: readonly ContentPart[],
  input: ReliableTransientThoughtUpdate
): ContentPart[] {
  let next = [...current];
  let targetIndex = textPartIndex(next, true, input.outputItem);
  if (targetIndex < 0) {
    next = insertByOutputOrdinal(next, {
      text: '',
      thought: true,
      ...(input.outputItem ? { outputItem: input.outputItem } : {})
    });
    targetIndex = textPartIndex(next, true, input.outputItem);
  }
  if (targetIndex < 0) return next;

  const target = next[targetIndex] as TextPart;
  const updated: TextPart = {
    ...target,
    ...(input.outputItem ? { outputItem: input.outputItem } : {}),
    ...(input.thoughtSignature ? { thoughtSignature: input.thoughtSignature } : {}),
    ...(input.thoughtStartedAt !== undefined ? { thoughtStartedAt: input.thoughtStartedAt } : {}),
    ...(input.thoughtCompletedDurationMs !== undefined
      ? { thoughtCompletedDurationMs: input.thoughtCompletedDurationMs }
      : {}),
    ...(input.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: input.thoughtElapsedMs } : {}),
    ...(input.thoughtDurationMs !== undefined ? { thoughtDurationMs: input.thoughtDurationMs } : {})
  };
  if (input.done) {
    delete updated.thoughtStartedAt;
    delete updated.thoughtElapsedMs;
    delete updated.thoughtCompletedDurationMs;
  }
  next[targetIndex] = updated;
  return next;
}

/** Applies late terminal metadata such as assistant phase without changing item position. */
export function applyReliableTransientOutputItem(
  current: readonly ContentPart[],
  outputItem: ModelOutputItemReference
): ContentPart[] {
  return current.map((part) => reliableOutputItemIdentity(part.outputItem) === reliableOutputItemIdentity(outputItem)
    ? { ...part, outputItem } as ContentPart
    : part);
}

/** Inserts or updates transient function-call parts at their first provider output position. */
export function syncReliableTransientFunctionCallParts(
  current: readonly ContentPart[],
  calls: readonly ReliableTransientToolCallState[]
): ContentPart[] {
  let next = [...current];
  for (const part of transientFunctionCallParts(calls)) {
    const index = part.id
      ? next.findIndex((candidate) => 'functionCall' in candidate && candidate.id === part.id)
      : -1;
    if (index >= 0) {
      const existing = next[index]!;
      next[index] = {
        ...part,
        ...(part.outputItem ?? existing.outputItem
          ? { outputItem: part.outputItem ?? existing.outputItem }
          : {})
      };
      continue;
    }
    next = insertByOutputOrdinal(next, part);
  }
  return next;
}

export function cloneReliableTransientParts(parts: readonly ContentPart[]): MessageContent['parts'] {
  return structuredClone(parts) as MessageContent['parts'];
}

function textPartIndex(
  parts: readonly ContentPart[],
  thought: boolean,
  outputItem: ModelOutputItemReference | undefined
): number {
  if (outputItem) {
    return parts.findIndex((part) =>
      'text' in part
      && (part.thought === true) === thought
      && reliableOutputItemIdentity(part.outputItem) === reliableOutputItemIdentity(outputItem));
  }
  const lastIndex = parts.length - 1;
  const last = parts[lastIndex];
  return last && 'text' in last && (last.thought === true) === thought && !last.outputItem
    ? lastIndex
    : -1;
}

function insertByOutputOrdinal(parts: ContentPart[], part: ContentPart): ContentPart[] {
  const item = part.outputItem;
  if (!item) return [...parts, part];
  const responseId = item.providerResponseId;
  let insertion = -1, lastSameResponse = -1, lastPredecessor = -1;
  parts.forEach((candidate, index) => {
    const existing = candidate.outputItem;
    if (existing?.providerResponseId === responseId) {
      lastSameResponse = index;
      if (insertion < 0 && existing && existing.ordinal > item.ordinal) insertion = index;
    }
    if (item.previousResponseId && existing?.providerResponseId === item.previousResponseId) lastPredecessor = index;
  });
  if (insertion < 0) insertion = lastSameResponse >= 0 ? lastSameResponse + 1 : lastPredecessor >= 0 ? lastPredecessor + 1 : parts.length;
  return [...parts.slice(0, insertion), part, ...parts.slice(insertion)];
}


/** A sealed item carries the exact committed part, replacing only that physical response item. */
export function replaceReliableTransientCommittedPart(current: readonly ContentPart[], part: ContentPart): ContentPart[] {
  const id = reliableOutputItemIdentity(part.outputItem);
  const index = id ? current.findIndex(candidate => reliableOutputItemIdentity(candidate.outputItem) === id) : -1;
  if (index < 0) return insertByOutputOrdinal([...current], part);
  const next = [...current]; next[index] = part; return next;
}

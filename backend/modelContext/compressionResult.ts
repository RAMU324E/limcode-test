import type { MessageContent } from '../../shared/protocol';

/** Applies deterministic, projector-frozen addenda without mutating provider output. */
export function applyCompressionResultAddenda(
  contents: readonly MessageContent[],
  addenda: readonly MessageContent[] | undefined
): MessageContent[] {
  return [
    ...contents.map(clone),
    ...(addenda ?? []).map(clone)
  ];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

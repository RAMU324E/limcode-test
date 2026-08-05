import type { ReliableKernelTransientState } from '@webview/stores/useReliableKernelClientFeedStore';

/** True only when the transient already renders model-owned content in the timeline. */
export function hasVisibleReliableTransientOutput(
  transient: Pick<
    ReliableKernelTransientState,
    'text' | 'thought' | 'thoughtElapsedMs' | 'thoughtDurationMs' | 'toolCalls'
  >
): boolean {
  return Boolean(
    transient.text
    || transient.thought.trim()
    || (transient.thoughtElapsedMs ?? 0) > 0
    || (transient.thoughtDurationMs ?? 0) > 0
    || transient.toolCalls.length > 0
  );
}

/**
 * A historical/terminal overlay must never hide the activity row of a later Turn. Only visible,
 * currently-streaming output owned by the exact active Turn replaces that row.
 */
export function hasVisibleStreamingTransientForTurn(
  requests: Readonly<Record<string, ReliableKernelTransientState>>,
  turnId: string
): boolean {
  return Object.values(requests).some((entry) =>
    entry.turnId === turnId
    && entry.status === 'streaming'
    && hasVisibleReliableTransientOutput(entry)
  );
}

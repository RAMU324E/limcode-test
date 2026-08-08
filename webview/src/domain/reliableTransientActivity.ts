import type { ReliableKernelTransientState } from '@webview/stores/useReliableKernelClientFeedStore';

/** True only when the transient already renders model-owned content in the timeline. */
export function hasVisibleReliableTransientOutput(
  transient: Pick<
    ReliableKernelTransientState,
    'text' | 'thought' | 'thoughtActive' | 'thoughtElapsedMs' | 'thoughtCompletedDurationMs' | 'thoughtDurationMs' | 'toolCalls'
  >
): boolean {
  return Boolean(
    transient.text
    || transient.thought.trim()
    || transient.thoughtActive === true
    || (transient.thoughtElapsedMs ?? 0) > 0
    || (transient.thoughtCompletedDurationMs ?? 0) > 0
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
  turnId: string,
  mountedModelRequestIds?: ReadonlySet<string>
): boolean {
  return Object.values(requests).some((entry) =>
    entry.turnId === turnId
    && entry.status === 'streaming'
    && (!mountedModelRequestIds || mountedModelRequestIds.has(entry.modelRequestId))
    && hasVisibleReliableTransientOutput(entry)
  );
}

/** True only for visible streaming output owned by the exact durable request attempt. */
export function hasVisibleStreamingTransientForRequestAttempt(
  requests: Readonly<Record<string, ReliableKernelTransientState>>,
  modelRequestId: string,
  attemptSeq: string,
  mountedModelRequestIds?: ReadonlySet<string>
): boolean {
  const entry = requests[modelRequestId];
  return Boolean(
    entry
    && entry.modelRequestId === modelRequestId
    && entry.attemptSeq === attemptSeq
    && entry.status === 'streaming'
    && (!mountedModelRequestIds || mountedModelRequestIds.has(entry.modelRequestId))
    && hasVisibleReliableTransientOutput(entry)
  );
}

export function reliableRetryStreamingActivityLabel(input: {
  retryAttempt: number;
  retryMaxAttempts: number;
  hasVisibleOutput: boolean;
}): string {
  const identity = `第 ${input.retryAttempt}/${input.retryMaxAttempts} 次自动恢复`;
  return input.hasVisibleOutput
    ? `${identity}中，正在接收模型输出`
    : `${identity}已启动，正在连接并等待模型输出`;
}

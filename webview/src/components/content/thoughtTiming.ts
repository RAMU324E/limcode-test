export const THOUGHT_TIMER_REFRESH_INTERVAL_MS = 100;

export interface LiveThoughtTimingInput {
  completedDurationMs?: number;
  elapsedMs?: number;
  startedAt?: number;
}

/**
 * 后端时间是权威校准，墙钟差值只负责两次低频事件之间的平滑显示。
 * 使用绝对时间而不是逐 tick 累加，因此 Webview 被节流后恢复时不会丢时间。
 */
export function liveThoughtDurationMs(input: LiveThoughtTimingInput, now = Date.now()): number {
  const completedDurationMs = nonNegativeFinite(input.completedDurationMs) ?? 0;
  const authoritativeElapsedMs = nonNegativeFinite(input.elapsedMs) ?? 0;
  const startedAt = positiveFinite(input.startedAt);
  const localElapsedMs = startedAt !== undefined && Number.isFinite(now)
    ? Math.max(0, now - startedAt)
    : 0;
  return completedDurationMs + Math.max(authoritativeElapsedMs, localElapsedMs);
}

/** 一分钟内显示到 0.1 秒；满一分钟后显示整秒，并始终向下取整以免领先权威墙钟。 */
export function formatThoughtDuration(durationMs: number): string {
  const normalizedDurationMs = nonNegativeFinite(durationMs) ?? 0;
  const totalTenths = Math.max(0, Math.floor(normalizedDurationMs / 100));
  if (totalTenths < 600) return `${(totalTenths / 10).toFixed(1)}秒`;

  const totalSeconds = Math.floor(normalizedDurationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes}分${seconds}秒`;
  return `${minutes}分${seconds}秒`;
}

function nonNegativeFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveFinite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

import type { OpenAIResponsesNativeCapabilities } from '@shared/openAIResponsesNative';

/** ModelRequest.stream_stats_json 在 feed 里可能是对象或 JSON 字符串；两种形态都接受。 */
export function modelRequestStreamStats(request: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = request.stream_stats_json;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 进行中原生请求的冻结能力投影，由后端在原生 response.created 后写入 stream_stats。
 * 缺失或形状不符时返回 undefined——调用方必须把它当作「能力不可用」，不得回退到可编辑设置。
 */
export function modelRequestNativeCapabilities(
  request: Record<string, unknown> | undefined
): OpenAIResponsesNativeCapabilities | undefined {
  if (!request) return undefined;
  const raw = modelRequestStreamStats(request)?.nativeCapabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    asyncTools: record.asyncTools === true,
    steering: record.steering === true,
    reasoningUpdates: record.reasoningUpdates === true,
    multiplexing: record.multiplexing === true,
    explicitCaching: record.explicitCaching === true
  };
}

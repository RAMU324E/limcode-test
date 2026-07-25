import type { LlmInvocationSettingsSnapshotRecord, LlmUsageMetadataRecord } from '../../../../shared/protocol';

/** unified-llm-provider 已将各 provider 的 usage 归一到 Gemini-like 字段。 */
export function observedUsageTokenCount(usage: LlmUsageMetadataRecord): number | undefined {
  const total = finitePositiveInteger(usage.totalTokenCount);
  if (total !== undefined) return total;

  const prompt = finitePositiveInteger(usage.promptTokenCount) ?? 0;
  const candidates = finitePositiveInteger(usage.candidatesTokenCount) ?? 0;
  const thoughts = finitePositiveInteger(usage.thoughtsTokenCount) ?? 0;
  const sum = prompt + candidates + thoughts;
  return sum > 0 ? sum : undefined;
}

export type CompressionThresholdResolution =
  | { kind: 'resolved'; unit: 'tokens' | 'percent'; thresholdTokens: number }
  | {
      kind: 'unavailable';
      reason: 'trigger_missing' | 'threshold_unit_missing' | 'threshold_tokens_missing' | 'threshold_percent_missing' | 'context_window_missing';
    };

/** Resolves only the field selected by the frozen thresholdUnit; no cross-unit fallback is allowed. */
export function resolveCompressionThreshold(settings: LlmInvocationSettingsSnapshotRecord): CompressionThresholdResolution {
  const trigger = settings.compressionTrigger;
  if (!trigger) return { kind: 'unavailable', reason: 'trigger_missing' };
  if (trigger.thresholdUnit === 'tokens') {
    const thresholdTokens = finitePositiveInteger(trigger.thresholdTokens);
    return thresholdTokens === undefined
      ? { kind: 'unavailable', reason: 'threshold_tokens_missing' }
      : { kind: 'resolved', unit: 'tokens', thresholdTokens };
  }
  if (trigger.thresholdUnit === 'percent') {
    const thresholdPercent = finitePercent(trigger.thresholdPercent);
    if (thresholdPercent === undefined) return { kind: 'unavailable', reason: 'threshold_percent_missing' };
    const contextWindowTokens = finitePositiveInteger(settings.contextWindowTokens);
    return contextWindowTokens === undefined
      ? { kind: 'unavailable', reason: 'context_window_missing' }
      : { kind: 'resolved', unit: 'percent', thresholdTokens: Math.max(1, Math.floor(contextWindowTokens * thresholdPercent / 100)) };
  }
  return { kind: 'unavailable', reason: 'threshold_unit_missing' };
}

export function compressionThresholdTokens(settings: LlmInvocationSettingsSnapshotRecord): number | undefined {
  const resolved = resolveCompressionThreshold(settings);
  return resolved.kind === 'resolved' ? resolved.thresholdTokens : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finitePercent(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100) return undefined;
  return number;
}

import type { LlmOpenAIResponsesTransport, LlmProviderKind } from './protocol';
import type { OpenAIResponsesNativeCapabilities, OpenAIResponsesNativeSettings } from './openAIResponsesNative';

/** Exact Astra model family. Other gpt-* models must never be inferred as Astra-capable. */
export const ASTRA_MODEL_ID = 'gpt-6-astra';
const ASTRA_DATED_MODEL_PATTERN = /^gpt-6-astra-\d{4}-\d{2}-\d{2}$/;
const OFFICIAL_OPENAI_HOST = 'api.openai.com';

export function isAstraModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === ASTRA_MODEL_ID || ASTRA_DATED_MODEL_PATTERN.test(normalized);
}

/** The official OpenAI channel supports Astra natively; any other channel needs an explicit enabled setting. */
export function isOfficialOpenAIChannel(baseUrl: string | undefined): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return true;
  try {
    return new URL(trimmed).host === OFFICIAL_OPENAI_HOST;
  } catch {
    return false;
  }
}

export function normalizeOpenAIResponsesNativeSettings(value: unknown): OpenAIResponsesNativeSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const normalized: OpenAIResponsesNativeSettings = {};
  if (typeof record.enabled === 'boolean') normalized.enabled = record.enabled;
  if (typeof record.asyncTools === 'boolean') normalized.asyncTools = record.asyncTools;
  if (typeof record.steering === 'boolean') normalized.steering = record.steering;
  if (typeof record.reasoningUpdates === 'boolean') normalized.reasoningUpdates = record.reasoningUpdates;
  if (typeof record.multiplexing === 'boolean') normalized.multiplexing = record.multiplexing;
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export interface OpenAIResponsesNativeCapabilityInput {
  provider?: LlmProviderKind;
  model?: string;
  baseUrl?: string;
  transport?: LlmOpenAIResponsesTransport;
  nativeResponses?: OpenAIResponsesNativeSettings;
}

const NO_NATIVE_CAPABILITIES: OpenAIResponsesNativeCapabilities = {
  asyncTools: false,
  steering: false,
  reasoningUpdates: false,
  multiplexing: false,
  explicitCaching: false
};

/**
 * Exact native capability gate. Every flag requires provider `openai-responses`, an exact Astra
 * model and either the official OpenAI channel or an explicit `enabled` value (which confirms a
 * relay's support). Feature subflags default to available once native is enabled; an explicit
 * `false` disables one feature. Async tools and reasoning updates are transport-independent:
 * over HTTP/SSE early admission proofs and delayed results ride stateless full-history
 * continuation (store=false, no fabricated connection identity). Steering and multiplexing are
 * WebSocket-only because they ride a shared physical connection.
 */
export function openAIResponsesNativeCapabilities(
  input: OpenAIResponsesNativeCapabilityInput
): OpenAIResponsesNativeCapabilities {
  if (input.provider !== 'openai-responses' || !isAstraModel(input.model)) return { ...NO_NATIVE_CAPABILITIES };
  const settings = normalizeOpenAIResponsesNativeSettings(input.nativeResponses);
  if (settings?.enabled === false) return { ...NO_NATIVE_CAPABILITIES };
  if (settings?.enabled !== true && !isOfficialOpenAIChannel(input.baseUrl)) return { ...NO_NATIVE_CAPABILITIES };
  const websocket = input.transport === 'websocket';
  return {
    asyncTools: settings?.asyncTools !== false,
    steering: websocket && settings?.steering !== false,
    reasoningUpdates: settings?.reasoningUpdates !== false,
    multiplexing: websocket && settings?.multiplexing !== false,
    explicitCaching: true
  };
}

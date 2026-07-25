import { createHash } from 'node:crypto';
import type { JsonValue } from '../../shared/conversationReliability';
import type { StagedToolResultContent, ToolCallStatus } from '../../shared/protocol';
import { simplifyToolResponseForModel } from '../world/modules/tools/responseSimplifier';
import { canonicalJson } from './canonicalJson';

export const TOOL_RESULT_INLINE_THRESHOLD_BYTES = 32 * 1024;
export const TOOL_RESULT_PREVIEW_MAX_BYTES = 8 * 1024;
export const TOOL_MODEL_RESPONSE_MAX_BYTES = 64 * 1024;

export interface PreparedToolResultContent {
  staged: StagedToolResultContent;
  /** Exact canonical bytes admitted under the ToolResult blob resource lock. */
  canonicalBytes: Uint8Array;
}

/** Canonicalizes a raw result exactly once without performing I/O. */
export function prepareToolResultContent(content: JsonValue): PreparedToolResultContent {
  const canonical = canonicalJson(content);
  const canonicalBytes = Buffer.from(canonical, 'utf8');
  const contentHash = createHash('sha256').update(canonicalBytes).digest('hex');
  const common = {
    contentHash,
    mediaType: 'application/json' as const,
    byteLength: canonicalBytes.byteLength,
    preview: boundedToolResultPreview(canonical)
  };
  return {
    staged: canonicalBytes.byteLength <= TOOL_RESULT_INLINE_THRESHOLD_BYTES
      ? { ...common, storageKind: 'inline', inlineContent: cloneJson(content) }
      : { ...common, storageKind: 'blob', blobHash: contentHash },
    canonicalBytes
  };
}

/** Builds the only model-facing response from one raw result, then deterministically bounds it. */
export function modelResponseForToolResult(input: {
  toolName: string;
  status: ToolCallStatus;
  result: JsonValue;
  error?: string;
}): JsonValue {
  const rawRecord = asRecord(input.result);
  const structuredInterruption = rawRecord?.interrupted === true || rawRecord?.outcomeUnknown === true;
  const raw = input.status === 'error'
    ? { ok: false, output: input.result ?? input.error ?? 'Tool execution failed.' }
    : { ok: true, output: input.result };
  const response = structuredInterruption
    ? cloneJson(input.result)
    : simplifyToolResponseForModel(input.toolName, input.status, raw) as JsonValue;
  return boundJsonForModel(response, TOOL_MODEL_RESPONSE_MAX_BYTES);
}

export function boundedToolResultPreview(canonical: string): string {
  return boundedUtf8Prefix(canonical, TOOL_RESULT_PREVIEW_MAX_BYTES);
}

export function boundJsonForModel(value: JsonValue, maxBytes: number): JsonValue {
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, 'utf8') <= maxBytes) return cloneJson(value);

  const stringCount = Math.max(1, countStrings(value));
  let perStringBytes = Math.max(64, Math.floor((maxBytes * 0.8) / stringCount));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const bounded = clampJson(value, perStringBytes, 64);
    if (Buffer.byteLength(canonicalJson(bounded), 'utf8') <= maxBytes) return bounded;
    perStringBytes = Math.max(32, Math.floor(perStringBytes / 2));
  }

  const originalBytes = Buffer.byteLength(canonical, 'utf8');
  const fixed = canonicalJson({ truncated: true, originalBytes, preview: '' });
  const previewBudget = Math.max(0, maxBytes - Buffer.byteLength(fixed, 'utf8') - 8);
  return {
    truncated: true,
    originalBytes,
    preview: boundedUtf8Prefix(canonical, previewBudget)
  };
}

export function boundedUtf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const marker = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > budget) break;
    result += character;
    used += size;
  }
  return `${result}${marker}`;
}

function clampJson(value: JsonValue, maxStringBytes: number, maxArrayItems: number): JsonValue {
  if (typeof value === 'string') return boundedUtf8Prefix(value, maxStringBytes);
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArrayItems).map((item) => clampJson(item, maxStringBytes, maxArrayItems));
    if (value.length > maxArrayItems) {
      items.push({ truncatedItems: value.length - maxArrayItems });
    }
    return items;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    clampJson(value[key]!, maxStringBytes, maxArrayItems)
  ])) as JsonValue;
}

function countStrings(value: JsonValue): number {
  if (typeof value === 'string') return 1;
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += countStrings(item);
    return count;
  }
  if (!value || typeof value !== 'object') return 0;
  let count = 0;
  for (const item of Object.values(value)) count += countStrings(item);
  return count;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

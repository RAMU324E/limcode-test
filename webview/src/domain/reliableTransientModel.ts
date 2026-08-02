import type { FunctionCallPart, ToolCallPreviewRecord } from '@shared/protocol';
import {
  advanceToolCallPreviewFields,
  appendToolCallPreviewArguments,
  type ToolCallPreviewIncrementalState
} from '@shared/toolCallPreview';

export interface ReliableTransientToolCallState extends ToolCallPreviewRecord {
  final: boolean;
  argumentsValue?: unknown;
  /** Process-local lexer state; never crosses the Webview bridge. */
  argumentPreviewState?: ToolCallPreviewIncrementalState;
}

export interface ReliableTransientAttemptIdentity {
  attemptSeq?: string;
  socketGeneration?: string;
}

/** attemptSeq is the major key because every provider retry may reset its socket generation. */
export function compareReliableTransientIdentity(
  current: ReliableTransientAttemptIdentity | undefined,
  attemptSeq: string | undefined,
  socketGeneration: string | undefined
): 'same' | 'newer' | 'stale' {
  if (!current) return 'newer';
  if (current.attemptSeq !== undefined && attemptSeq !== undefined) {
    if (BigInt(attemptSeq) > BigInt(current.attemptSeq)) return 'newer';
    if (BigInt(attemptSeq) < BigInt(current.attemptSeq)) return 'stale';
  }
  if (current.socketGeneration !== undefined && socketGeneration !== undefined) {
    if (BigInt(socketGeneration) > BigInt(current.socketGeneration)) return 'newer';
    if (BigInt(socketGeneration) < BigInt(current.socketGeneration)) return 'stale';
  }
  return 'same';
}

interface ToolCallDelta {
  id?: string;
  name?: string;
  argumentsDelta: string;
  replace?: boolean;
  streamIndex?: string;
}

interface CompletedToolCall {
  id?: string;
  name: string;
  arguments: unknown;
  streamIndex?: string;
}

/**
 * Merges raw provider argument deltas by durable call identity first and stream index second. The
 * process-local preview retains the complete raw argument stream until the durable completed
 * call replaces it or the request's transient lifecycle clears it.
 */
export function mergeReliableToolCallDeltas(
  current: readonly ReliableTransientToolCallState[],
  input: unknown,
  modelRequestId: string,
  observedAt: number
): ReliableTransientToolCallState[] {
  if (!Array.isArray(input)) return [...current];
  const next = current.map((call) => ({ ...call }));
  const deltas = input.map(toolCallDelta).filter((call): call is ToolCallDelta => call !== undefined);
  for (let inputIndex = 0; inputIndex < deltas.length; inputIndex += 1) {
    const delta = deltas[inputIndex]!;
    const existingIndex = findToolCallIndex(next, delta, inputIndex);
    const existing = existingIndex === undefined ? undefined : next[existingIndex];
    const callId = delta.id ?? existing?.callId ?? syntheticCallId(modelRequestId, delta.streamIndex, inputIndex);
    const preview = appendArgumentsPreview(existing, delta.argumentsDelta, delta.replace === true);
    const call: ReliableTransientToolCallState = {
      id: existing?.id ?? `transient-tool-preview:${modelRequestId}:${callId}`,
      callId,
      ...(delta.name ?? existing?.name ? { name: delta.name ?? existing?.name } : {}),
      ...(delta.streamIndex ?? existing?.streamIndex ? { streamIndex: delta.streamIndex ?? existing?.streamIndex } : {}),
      ...preview,
      final: false,
      createdAt: existing?.createdAt ?? observedAt,
      updatedAt: observedAt
    };
    if (existingIndex === undefined) next.push(call);
    else next[existingIndex] = call;
  }
  return next;
}

/** The provider's completed call list is authoritative and replaces every partial preview at once. */
export function replaceReliableCompletedToolCalls(
  input: unknown,
  modelRequestId: string,
  observedAt: number
): ReliableTransientToolCallState[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const calls = input.map(completedToolCall).filter((call): call is CompletedToolCall => call !== undefined);
  return calls.map((call, index) => {
    const callId = call.id ?? syntheticCallId(modelRequestId, call.streamIndex, index);
    const raw = stringifyArguments(call.arguments);
    return {
      id: `transient-tool-preview:${modelRequestId}:${callId}`,
      callId,
      name: call.name,
      ...(call.streamIndex ? { streamIndex: call.streamIndex } : {}),
      ...previewFromText(raw),
      final: true,
      argumentsValue: call.arguments,
      createdAt: observedAt,
      updatedAt: observedAt
    };
  });
}

/**
 * output_item_done is an item delta, not a full provider response snapshot. Merge each completed
 * call into first-seen order; only the terminal completed event may replace the whole list.
 */
export function mergeReliableCompletedToolCalls(
  current: readonly ReliableTransientToolCallState[],
  input: unknown,
  modelRequestId: string,
  observedAt: number
): ReliableTransientToolCallState[] {
  const completed = replaceReliableCompletedToolCalls(input, modelRequestId, observedAt);
  if (!completed) return [...current];
  const next = current.map((call) => ({ ...call }));
  for (const call of completed) {
    const index = next.findIndex((candidate) => candidate.callId === call.callId);
    if (index < 0) next.push(call);
    else next[index] = call;
  }
  return next;
}

export function transientFunctionCallParts(
  calls: readonly ReliableTransientToolCallState[]
): FunctionCallPart[] {
  return calls.flatMap((call) => {
    const name = call.name?.trim();
    if (!name) return [];
    return [{
      id: call.callId,
      functionCall: {
        name,
        args: call.final
          ? (Object.prototype.hasOwnProperty.call(call, 'argumentsValue') ? call.argumentsValue : parseCompleteArguments(call))
          : parsePartialArguments(call)
      }
    }];
  });
}

export function toolCallPreviewByCallId(
  calls: readonly ReliableTransientToolCallState[],
  callId: string | undefined
): ToolCallPreviewRecord | undefined {
  const id = callId?.trim();
  if (!id) return undefined;
  const call = calls.find((candidate) => candidate.callId === id && !candidate.final);
  return call ? { ...call } : undefined;
}

export function transientToolCallPreviewForMessage(
  requests: Record<string, { conversationId: string; toolCalls: readonly ReliableTransientToolCallState[] }>,
  links: Array<Record<string, unknown>>,
  conversationId: string,
  messageId: string,
  callId: string
): ToolCallPreviewRecord | undefined {
  const linkedRequestId = messageId.startsWith('transient:')
    ? messageId.slice('transient:'.length)
    : links.find((link) => link.message_id === messageId)?.model_request_id;
  if (typeof linkedRequestId !== 'string' || !linkedRequestId) return undefined;
  const request = requests[linkedRequestId];
  if (!request || request.conversationId !== conversationId) return undefined;
  return toolCallPreviewByCallId(request.toolCalls, callId);
}

function appendArgumentsPreview(
  current: ReliableTransientToolCallState | undefined,
  delta: string,
  replace: boolean
): Pick<ToolCallPreviewRecord, 'argumentsText' | 'receivedChars' | 'argumentPreviewFields'> & {
  argumentPreviewState: ToolCallPreviewIncrementalState;
} {
  const text = appendToolCallPreviewArguments(current, delta, replace);
  const priorState = !replace && current && !current.argumentPreviewState
    ? advanceToolCallPreviewFields(undefined, current.argumentsText, true)
    : current?.argumentPreviewState;
  const argumentPreviewState = advanceToolCallPreviewFields(priorState, delta, replace);
  return {
    ...text,
    argumentPreviewState,
    argumentPreviewFields: argumentPreviewState.fields
  };
}

function previewFromText(
  text: string,
  receivedChars = text.length
): Pick<ToolCallPreviewRecord, 'argumentsText' | 'receivedChars'> {
  return { argumentsText: text, receivedChars };
}

function findToolCallIndex(
  calls: readonly ReliableTransientToolCallState[],
  delta: ToolCallDelta,
  fallbackIndex: number
): number | undefined {
  if (delta.id) {
    const byId = calls.findIndex((call) => call.callId === delta.id);
    return byId >= 0 ? byId : undefined;
  }
  if (delta.streamIndex) {
    const byStreamIndex = calls.findIndex((call) => call.streamIndex === delta.streamIndex);
    return byStreamIndex >= 0 ? byStreamIndex : undefined;
  }
  return calls[fallbackIndex] ? fallbackIndex : undefined;
}

function toolCallDelta(value: unknown): ToolCallDelta | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const argumentsDelta = typeof source.argumentsDelta === 'string' ? source.argumentsDelta : undefined;
  if (argumentsDelta === undefined) return undefined;
  return {
    ...optionalTextField(source, 'id'),
    ...optionalTextField(source, 'name'),
    argumentsDelta,
    ...(source.replace === true ? { replace: true } : {}),
    ...streamIdentityField(source)
  };
}

function completedToolCall(value: unknown): CompletedToolCall | undefined {
  const source = asRecord(value);
  const name = source && typeof source.name === 'string' ? source.name.trim() : '';
  if (!source || !name || !Object.prototype.hasOwnProperty.call(source, 'arguments')) return undefined;
  return {
    ...optionalTextField(source, 'id'),
    name,
    arguments: source.arguments,
    ...streamIdentityField(source)
  };
}

function optionalTextField<TKey extends string>(
  source: Record<string, unknown>,
  key: TKey
): Partial<Record<TKey, string>> {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Partial<Record<TKey, string>> : {};
}

function syntheticCallId(modelRequestId: string, streamIndex: string | undefined, index: number): string {
  return `transient-call:${modelRequestId}:${streamIndex ?? index}`;
}

function streamIdentityField(source: Record<string, unknown>): { streamIndex?: string } {
  const value = source.streamIndex ?? source.ordinal;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return { streamIndex: value };
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return { streamIndex: String(value) };
  return {};
}

function parseCompleteArguments(call: ReliableTransientToolCallState): unknown {
  try {
    return JSON.parse(call.argumentsText) as unknown;
  } catch {
    return call.argumentsText;
  }
}

function parsePartialArguments(call: ReliableTransientToolCallState): unknown {
  // A partial call is presentation-only. Parsing the ever-growing prefix on every projection is
  // quadratic and provides no durable fact; the completed provider event supplies exact args once.
  return {};
}

function stringifyArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

import { createHash } from 'crypto';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { type RawData } from 'ws';
import type {
  Content,
  LLMRequest,
  LLMResponse,
  LLMStreamChunk,
  StreamDecodeState
} from 'unified-llm-provider';

const MAX_SOCKET_AGE_MS = 55 * 60 * 1_000;
const MAX_RETAINED_SESSIONS = 32;
const IDLE_SESSION_TTL_MS = 15 * 60 * 1_000;

export const LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION = 'codex-output-items-v1';

export interface OpenAIResponsesToolCallArgumentDelta {
  callId: string;
  name?: string;
  argumentsDelta: string;
  replace?: boolean;
  streamIndex?: string;
}

export interface LimCodeOpenAIResponsesStreamChunk extends LLMStreamChunk {
  toolCallArgumentDeltas?: OpenAIResponsesToolCallArgumentDelta[];
}

export interface OpenAIResponsesWebSocketDecision {
  sessionKeyHash: string;
  connectionGeneration: number;
  connectionReused: boolean;
  connectionReason: 'reused' | 'new_connection' | 'socket_expired' | 'handshake_identity_changed';
  mode: 'full' | 'incremental';
  reason: string;
  fullInputItemCount: number;
  sentInputItemCount: number;
  fullInputFingerprint: string;
  sentInputFingerprint: string;
  baselineFingerprint?: string;
  previousResponseIdUsed?: string;
}

export interface OpenAIResponsesFormatAdapter {
  createStreamState(): StreamDecodeState;
  decodeStreamChunk(raw: unknown, state: StreamDecodeState): LLMStreamChunk;
  decodeResponse(raw: unknown): LLMResponse;
  encodeRequest(request: LLMRequest, stream?: boolean): unknown;
}

export interface OpenAIResponsesWebSocketStreamOptions {
  sessionKey: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  format: OpenAIResponsesFormatAdapter;
  signal?: AbortSignal;
  proxy?: string;
  onDecision?: (decision: OpenAIResponsesWebSocketDecision) => void;
}

interface LastRequestState {
  body: Record<string, unknown>;
  inputItems: unknown[];
  baseSignature: string;
}

interface LastResponseState {
  responseId: string;
  outputItems: unknown[];
}

interface WebSocketSession {
  key: string;
  socket?: WebSocket;
  connectedAt?: number;
  connectionIdentityHash?: string;
  connectionGeneration: number;
  lastUsedAt: number;
  lastRequest?: LastRequestState;
  lastResponse?: LastResponseState;
  lockTail: Promise<void>;
  activeOperations: number;
}

interface PreparedCreatePayload {
  payload: Record<string, unknown>;
  fullBody: Record<string, unknown>;
  fullInputItems: unknown[];
  baseSignature: string;
  decision: OpenAIResponsesWebSocketDecision;
}

interface WebSocketConnectionConfig {
  url: string;
  headers: Record<string, string>;
  proxy?: string;
  identityHash: string;
}

interface SocketAdmission {
  reused: boolean;
  reason: OpenAIResponsesWebSocketDecision['connectionReason'];
}

interface ToolCallAccumulator {
  callId: string;
  name?: string;
  arguments: string;
  streamIndex?: string;
}

const sessions = new Map<string, WebSocketSession>();
const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

/**
 * Codex-style Responses WebSocket session:
 * - continuation is tied to one physical socket generation;
 * - the baseline uses exact response.output_item.done items;
 * - only response.completed commits continuation state;
 * - every uncertainty falls back to a full request.
 */
export async function* streamOpenAIResponsesWebSocketSession(
  options: OpenAIResponsesWebSocketStreamOptions
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  const session = sessionFor(options.sessionKey);
  yield* withSessionLock(session, options.signal, () => streamLocked(session, options));
}

export function resetOpenAIResponsesWebSocketSessions(): void {
  for (const session of sessions.values()) closeAndInvalidate(session, true);
  sessions.clear();
  proxyAgents.clear();
}

async function* streamLocked(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  throwIfAborted(options.signal);
  const connection = await ensureSocket(session, options);
  const socket = session.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    closeAndInvalidate(session, true);
    throw new Error('OpenAI Responses WebSocket connection is unavailable.');
  }

  const fullBody = sanitizeResponsesCreateBody(options.body);
  const prepared = prepareCreatePayload(session, fullBody, connection);
  options.onDecision?.(prepared.decision);

  const decodeState = options.format.createStreamState();
  const completedOutputItems: unknown[] = [];
  const completedOutputKeys = new Map<string, number>();
  const toolCalls = new Map<string, ToolCallAccumulator>();
  let responseId: string | undefined;
  let completedResponse: Record<string, unknown> | undefined;
  let sawSemanticOutput = false;
  let completed = false;

  try {
    for await (const raw of sendCreateAndReadEvents(socket, prepared.payload, options.signal)) {
      const type = eventType(raw);
      responseId = responseIdFromPayload(raw) ?? responseId;
      captureOutputItemDone(raw, completedOutputItems, completedOutputKeys);
      const argumentDeltas = captureToolCallArgumentDeltas(raw, toolCalls);
      if (isSemanticOutputEvent(type) || argumentDeltas.length > 0) sawSemanticOutput = true;

      if (type === 'response.completed') {
        completedResponse = responseObject(raw);
        const completedItems = completedResponse?.output;
        if (completedOutputItems.length === 0 && Array.isArray(completedItems)) {
          for (const item of completedItems) completedOutputItems.push(cloneJson(item));
        }
      }

      if (isProviderErrorPayload(raw)) {
        closeAndInvalidate(session, true);
        yield createErrorStreamChunk(errorInfoFromPayload(raw));
        return;
      }

      let decoded: LLMStreamChunk;
      try {
        decoded = options.format.decodeStreamChunk(raw, decodeState);
      } catch (error) {
        closeAndInvalidate(session, true);
        const wrapped = new Error(`OpenAI Responses WebSocket decode failed: ${errorText(error)}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
      }

      const chunk: LimCodeOpenAIResponsesStreamChunk = {
        ...decoded,
        ...(argumentDeltas.length > 0 ? { toolCallArgumentDeltas: argumentDeltas } : {})
      };
      if (hasMeaningfulChunk(chunk)) yield chunk;

      if (type === 'response.completed') {
        completed = true;
        break;
      }
      if (isTerminalEvent(raw)) {
        closeAndInvalidate(session, true);
        return;
      }
    }

    if (!completed) {
      closeAndInvalidate(session, true);
      throw new Error('OpenAI Responses WebSocket closed before response.completed.');
    }

    const resolvedResponseId = responseId
      ?? (completedResponse ? normalizedString(completedResponse.id) : undefined);
    const normalizedOutputItems = normalizeCompletedOutputItems(
      options.format,
      completedResponse,
      completedOutputItems
    );
    const outputStateReliable = normalizedOutputItems !== undefined
      && (normalizedOutputItems.length > 0 || !sawSemanticOutput);

    if (!resolvedResponseId || !outputStateReliable || session.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      invalidateContinuation(session);
      return;
    }

    session.lastRequest = {
      body: cloneJson(prepared.fullBody),
      inputItems: prepared.fullInputItems.map(cloneJson),
      baseSignature: prepared.baseSignature
    };
    session.lastResponse = {
      responseId: resolvedResponseId,
      outputItems: normalizedOutputItems.map(cloneJson)
    };
    session.lastUsedAt = Date.now();
  } catch (error) {
    closeAndInvalidate(session, true);
    if (isAbort(options.signal, error)) throw abortError(options.signal);
    throw error;
  } finally {
    if (!completed) closeAndInvalidate(session, true);
  }
}

async function* withSessionLock<T>(
  session: WebSocketSession,
  signal: AbortSignal | undefined,
  operation: () => AsyncGenerator<T>
): AsyncGenerator<T> {
  const previous = session.lockTail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  session.lockTail = previous.then(() => gate);

  let acquired = false;
  try {
    await waitForTurn(previous, signal);
    acquired = true;
    session.activeOperations += 1;
    yield* operation();
  } finally {
    if (acquired) {
      session.activeOperations = Math.max(0, session.activeOperations - 1);
      release();
    } else void previous.finally(release);
  }
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function sessionFor(key: string): WebSocketSession {
  evictIdleSessions();
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const session: WebSocketSession = {
    key,
    connectionGeneration: 0,
    lastUsedAt: Date.now(),
    lockTail: Promise.resolve(),
    activeOperations: 0
  };
  sessions.set(key, session);
  evictOverflowSessions();
  return session;
}

function evictIdleSessions(now = Date.now()): void {
  for (const [key, session] of sessions) {
    if (session.activeOperations > 0) continue;
    if (now - session.lastUsedAt < IDLE_SESSION_TTL_MS) continue;
    if (session.socket?.readyState === WebSocket.OPEN && session.connectedAt !== undefined
      && now - session.connectedAt < MAX_SOCKET_AGE_MS) continue;
    closeAndInvalidate(session, true);
    sessions.delete(key);
  }
}

function evictOverflowSessions(): void {
  if (sessions.size <= MAX_RETAINED_SESSIONS) return;
  const candidates = [...sessions.values()]
    .filter((session) => session.activeOperations === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const session of candidates.slice(0, Math.max(0, sessions.size - MAX_RETAINED_SESSIONS))) {
    closeAndInvalidate(session, true);
    sessions.delete(session.key);
  }
}

async function ensureSocket(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions
): Promise<SocketAdmission> {
  const connection = webSocketConnectionConfig(options);
  const socket = session.socket;
  const expired = session.connectedAt !== undefined
    && Date.now() - session.connectedAt >= MAX_SOCKET_AGE_MS;
  const identityMatches = session.connectionIdentityHash === connection.identityHash;
  if (socket?.readyState === WebSocket.OPEN && !expired && identityMatches) {
    return { reused: true, reason: 'reused' };
  }

  const reason: SocketAdmission['reason'] = socket?.readyState === WebSocket.OPEN && !identityMatches
    ? 'handshake_identity_changed'
    : expired
      ? 'socket_expired'
      : 'new_connection';

  // previous_response_id is connection-local. Any physical reconnect starts a new chain.
  closeAndInvalidate(session, true);
  session.socket = await openSocket(connection, options.signal);
  session.connectedAt = Date.now();
  session.connectionIdentityHash = connection.identityHash;
  session.connectionGeneration += 1;
  session.lastUsedAt = Date.now();
  return { reused: false, reason };
}

function webSocketConnectionConfig(options: OpenAIResponsesWebSocketStreamOptions): WebSocketConnectionConfig {
  const url = toWebSocketUrl(options.url);
  const headers = webSocketHeaders(options.headers);
  const proxy = normalizeProxyUrl(options.proxy);
  return {
    url,
    headers,
    ...(proxy ? { proxy } : {}),
    identityHash: canonicalHash({ url, headers, proxy: proxy ?? null })
  };
}

function prepareCreatePayload(
  session: WebSocketSession,
  fullBody: Record<string, unknown>,
  connection: SocketAdmission
): PreparedCreatePayload {
  const connectionReused = connection.reused;
  const fullInputItems = Array.isArray(fullBody.input) ? fullBody.input.map(cloneJson) : [];
  const baseSignature = canonicalHash(requestBase(fullBody));
  const baseline = session.lastRequest && session.lastResponse
    ? [...session.lastRequest.inputItems, ...session.lastResponse.outputItems]
    : undefined;

  let reason = 'no_completed_baseline';
  let canIncrement = false;
  if (!connectionReused) reason = 'new_socket_generation';
  else if (!session.lastRequest || !session.lastResponse || !baseline) reason = 'no_completed_baseline';
  else if (session.lastRequest.baseSignature !== baseSignature) reason = 'request_properties_changed';
  else {
    const mismatch = prefixMismatchReason(fullInputItems, baseline);
    if (mismatch) reason = mismatch;
    else if (fullInputItems.length <= baseline.length) reason = 'no_strict_input_suffix';
    else {
      reason = 'matched_exact_prefix';
      canIncrement = true;
    }
  }

  const sentInput = canIncrement && baseline
    ? fullInputItems.slice(baseline.length)
    : fullInputItems;
  const payload: Record<string, unknown> = {
    type: 'response.create',
    ...fullBody,
    input: sentInput,
    store: false,
    ...(canIncrement && session.lastResponse
      ? { previous_response_id: session.lastResponse.responseId }
      : {})
  };
  return {
    payload,
    fullBody,
    fullInputItems,
    baseSignature,
    decision: {
      sessionKeyHash: createHash('sha256').update(session.key).digest('hex').slice(0, 12),
      connectionGeneration: session.connectionGeneration,
      connectionReused,
      connectionReason: connection.reason,
      mode: canIncrement ? 'incremental' : 'full',
      reason,
      fullInputItemCount: fullInputItems.length,
      sentInputItemCount: sentInput.length,
      fullInputFingerprint: shortCanonicalHash(fullInputItems),
      sentInputFingerprint: shortCanonicalHash(sentInput),
      ...(baseline ? { baselineFingerprint: shortCanonicalHash(baseline) } : {}),
      ...(canIncrement && session.lastResponse
        ? { previousResponseIdUsed: session.lastResponse.responseId }
        : {})
    }
  };
}

function sanitizeResponsesCreateBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('OpenAI Responses WebSocket body must be a JSON object.');
  const next = cloneJson(value);
  delete next.type;
  delete next.stream;
  delete next.background;
  delete next.previous_response_id;
  delete next.prompt_cache_options;
  next.store = false;
  next.input = Array.isArray(next.input) ? next.input.map(stripWebSocketOnlyInputFields) : [];
  return next;
}

function stripWebSocketOnlyInputFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWebSocketOnlyInputFields);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'prompt_cache_breakpoint') continue;
    result[key] = stripWebSocketOnlyInputFields(child);
  }
  return result;
}

function requestBase(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'input' || key === 'previous_response_id' || key === 'stream'
      || key === 'background' || key === 'type') continue;
    result[key] = value;
  }
  return result;
}

function prefixMismatchReason(items: unknown[], prefix: unknown[]): string | undefined {
  if (prefix.length > items.length) return `cached_prefix_longer:${prefix.length}>${items.length}`;
  for (let index = 0; index < prefix.length; index += 1) {
    if (canonicalString(items[index]) !== canonicalString(prefix[index])) {
      return `input_prefix_mismatch_at:${index}`;
    }
  }
  return undefined;
}

function normalizeCompletedOutputItems(
  format: OpenAIResponsesFormatAdapter,
  completedResponse: Record<string, unknown> | undefined,
  outputItems: unknown[]
): unknown[] | undefined {
  const response = {
    ...(completedResponse ?? {}),
    output: outputItems.map(cloneJson)
  };
  try {
    const decoded = format.decodeResponse(response);
    const encoded = format.encodeRequest({ contents: [decoded.content] }, false);
    if (!isRecord(encoded) || !Array.isArray(encoded.input)) return undefined;
    return encoded.input.map(stripWebSocketOnlyInputFields);
  } catch {
    return undefined;
  }
}

async function openSocket(connection: WebSocketConnectionConfig, signal?: AbortSignal): Promise<WebSocket> {
  throwIfAborted(signal);
  const agent = proxyAgent(connection.proxy);
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(connection.url, {
      headers: connection.headers,
      perMessageDeflate: false,
      ...(agent ? { agent } : {}),
      ...(connection.proxy ? { rejectUnauthorized: false } : {})
    });
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try { socket.terminate(); } catch { /* noop */ }
        reject(error);
      } else resolve(socket);
    };
    const onAbort = () => finish(abortError(signal));
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) => finish(
      new Error(`OpenAI Responses WebSocket closed before open: ${code} ${reason.toString('utf8')}`.trim())
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function* sendCreateAndReadEvents(
  socket: WebSocket,
  payload: Record<string, unknown>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const queue = new MergeableAsyncQueue<Record<string, unknown>>(mergeDeltaEvents);
  let sawTerminal = false;
  const cleanup = () => {
    signal?.removeEventListener('abort', onAbort);
    socket.off('message', onMessage);
    socket.off('error', onError);
    socket.off('close', onClose);
  };
  const onAbort = () => queue.fail(abortError(signal));
  const onMessage = (data: RawData) => {
    const parsed = parseWebSocketData(data);
    if (!parsed.ok) {
      queue.fail(parsed.error);
      return;
    }
    const value = parsed.value;
    queue.push(value);
    if (isTerminalEvent(value)) {
      sawTerminal = true;
      queue.end();
    }
  };
  const onError = (error: Error) => queue.fail(error);
  const onClose = (code: number, reason: Buffer) => {
    if (sawTerminal) queue.end();
    else queue.fail(new Error(
      `OpenAI Responses WebSocket closed before terminal event: ${code} ${reason.toString('utf8')}`.trim()
    ));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.on('message', onMessage);
  socket.once('error', onError);
  socket.once('close', onClose);

  try {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => error ? reject(error) : resolve());
    });
    yield* queue;
  } finally {
    cleanup();
  }
}

class MergeableAsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: Array<{ value?: T; done?: true; error?: Error }> = [];
  private readonly waiters: Array<(item: { value?: T; done?: true; error?: Error }) => void> = [];
  private closed = false;

  public constructor(private readonly merge: (previous: T, next: T) => T | undefined) {}

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value });
      return;
    }
    const last = this.items[this.items.length - 1];
    if (last?.value !== undefined) {
      const merged = this.merge(last.value, value);
      if (merged !== undefined) {
        last.value = merged;
        return;
      }
    }
    this.items.push({ value });
  }

  public end(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ done: true });
  }

  public fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ error });
  }

  private emit(item: { value?: T; done?: true; error?: Error }): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift() ?? await new Promise<{
        value?: T;
        done?: true;
        error?: Error;
      }>((resolve) => this.waiters.push(resolve));
      if (item.error) throw item.error;
      if (item.done) return;
      if (item.value !== undefined) yield item.value;
    }
  }
}

const MERGEABLE_DELTA_EVENTS = new Set([
  'response.output_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning_text.delta',
  'response.reasoning.delta',
  'response.function_call_arguments.delta',
  'response.custom_tool_call_input.delta'
]);
const DELTA_IDENTITY_FIELDS = [
  'response_id',
  'item_id',
  'call_id',
  'output_index',
  'content_index',
  'summary_index'
];

function mergeDeltaEvents(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
): Record<string, unknown> | undefined {
  const type = eventType(previous);
  if (!type || type !== eventType(next) || !MERGEABLE_DELTA_EVENTS.has(type)) return undefined;
  if (typeof previous.delta !== 'string' || typeof next.delta !== 'string') return undefined;
  for (const field of DELTA_IDENTITY_FIELDS) {
    if (previous[field] !== next[field]) return undefined;
  }
  return { ...previous, ...next, delta: previous.delta + next.delta };
}

function captureOutputItemDone(
  raw: Record<string, unknown>,
  output: unknown[],
  keys: Map<string, number>
): void {
  if (eventType(raw) !== 'response.output_item.done' || !isRecord(raw.item)) return;
  const item = cloneJson(raw.item);
  const key = normalizedString(raw.item.id)
    ?? (typeof raw.output_index === 'number' ? `output:${raw.output_index}` : undefined)
    ?? `ordinal:${output.length}`;
  const existing = keys.get(key);
  if (existing === undefined) {
    keys.set(key, output.length);
    output.push(item);
  } else output[existing] = item;
}

function captureToolCallArgumentDeltas(
  raw: Record<string, unknown>,
  accumulators: Map<string, ToolCallAccumulator>
): OpenAIResponsesToolCallArgumentDelta[] {
  const type = eventType(raw);
  if (type === 'response.output_item.added' && isRecord(raw.item)
    && raw.item.type === 'function_call') {
    const accumulator = toolAccumulatorFromItem(raw.item, raw);
    if (!accumulator) return [];
    accumulators.set(accumulatorKey(raw.item, raw, accumulator.callId), accumulator);
    return accumulator.arguments
      ? [{
          callId: accumulator.callId,
          ...(accumulator.name ? { name: accumulator.name } : {}),
          argumentsDelta: accumulator.arguments,
          ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
        }]
      : [];
  }

  if (type === 'response.function_call_arguments.delta') {
    const accumulator = findToolAccumulator(raw, accumulators);
    const delta = typeof raw.delta === 'string' ? raw.delta : '';
    if (!accumulator || !delta) return [];
    accumulator.arguments += delta;
    return [{
      callId: accumulator.callId,
      ...(accumulator.name ? { name: accumulator.name } : {}),
      argumentsDelta: delta,
      ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
    }];
  }

  if ((type === 'response.function_call_arguments.done'
      || type === 'response.output_item.done')
    && (type !== 'response.output_item.done'
      || (isRecord(raw.item) && raw.item.type === 'function_call'))) {
    const source = type === 'response.output_item.done' && isRecord(raw.item) ? raw.item : raw;
    const accumulator = findToolAccumulator(raw, accumulators)
      ?? (isRecord(source) ? toolAccumulatorFromItem(source, raw) : undefined);
    const finalArguments = isRecord(source) ? normalizedString(source.arguments) : undefined;
    if (!accumulator || finalArguments === undefined || finalArguments === accumulator.arguments) return [];
    if (finalArguments.startsWith(accumulator.arguments)) {
      const suffix = finalArguments.slice(accumulator.arguments.length);
      accumulator.arguments = finalArguments;
      return suffix ? [{
        callId: accumulator.callId,
        ...(accumulator.name ? { name: accumulator.name } : {}),
        argumentsDelta: suffix,
        ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
      }] : [];
    }
    accumulator.arguments = finalArguments;
    return [{
      callId: accumulator.callId,
      ...(accumulator.name ? { name: accumulator.name } : {}),
      argumentsDelta: finalArguments,
      replace: true,
      ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
    }];
  }
  return [];
}

function toolAccumulatorFromItem(
  item: Record<string, unknown>,
  event: Record<string, unknown>
): ToolCallAccumulator | undefined {
  const callId = normalizedString(item.call_id) ?? normalizedString(event.call_id);
  if (!callId) return undefined;
  return {
    callId,
    ...(normalizedString(item.name) ? { name: normalizedString(item.name) } : {}),
    arguments: normalizedString(item.arguments) ?? '',
    ...(streamIndex(item, event) ? { streamIndex: streamIndex(item, event) } : {})
  };
}

function findToolAccumulator(
  event: Record<string, unknown>,
  accumulators: Map<string, ToolCallAccumulator>
): ToolCallAccumulator | undefined {
  const item = isRecord(event.item) ? event.item : undefined;
  const directKeys = [
    normalizedString(event.item_id),
    item ? normalizedString(item.id) : undefined,
    typeof event.output_index === 'number' ? `output:${event.output_index}` : undefined,
    normalizedString(event.call_id),
    item ? normalizedString(item.call_id) : undefined
  ].filter((key): key is string => !!key);
  for (const key of directKeys) {
    const found = accumulators.get(key);
    if (found) return found;
  }
  const callId = normalizedString(event.call_id) ?? (item ? normalizedString(item.call_id) : undefined);
  if (callId) {
    for (const value of accumulators.values()) if (value.callId === callId) return value;
  }
  return accumulators.size === 1 ? accumulators.values().next().value : undefined;
}

function accumulatorKey(
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  callId: string
): string {
  return normalizedString(item.id)
    ?? normalizedString(event.item_id)
    ?? (typeof event.output_index === 'number' ? `output:${event.output_index}` : undefined)
    ?? callId;
}

function streamIndex(item: Record<string, unknown>, event: Record<string, unknown>): string | undefined {
  return normalizedString(item.id)
    ?? normalizedString(event.item_id)
    ?? (typeof event.output_index === 'number' ? `output:${event.output_index}` : undefined);
}

function responseObject(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  return isRecord(raw.response) ? raw.response : undefined;
}

function responseIdFromPayload(raw: Record<string, unknown>): string | undefined {
  return normalizedString(raw.response_id)
    ?? (isRecord(raw.response) ? normalizedString(raw.response.id) : undefined)
    ?? (eventType(raw) === 'response.created' ? normalizedString(raw.id) : undefined);
}

function isSemanticOutputEvent(type: string): boolean {
  return type.includes('output_text')
    || type.includes('reasoning')
    || type.includes('function_call')
    || type.includes('custom_tool_call');
}

function isTerminalEvent(value: Record<string, unknown>): boolean {
  const type = eventType(value);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'response.cancelled'
    || type === 'error'
    || type.endsWith('.failed')
    || type.endsWith('.incomplete');
}

function isProviderErrorPayload(value: Record<string, unknown>): boolean {
  const type = eventType(value);
  if (type === 'error' || type.includes('error') || type.includes('failed') || type.includes('incomplete')) return true;
  if (value.error !== undefined && value.error !== null) return true;
  const response = value.response;
  if (!isRecord(response)) return false;
  const status = normalizedString(response.status)?.toLowerCase();
  return status === 'failed' || status === 'incomplete' || status === 'cancelled';
}

function errorInfoFromPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const status = numericField(payload.status)
    ?? numericField(payload.status_code)
    ?? (isRecord(payload.response) ? numericField(payload.response.status_code) : undefined);
  return {
    kind: 'stream_error',
    rawChunk: cloneJson(payload),
    event: eventType(payload) || undefined,
    ...(status !== undefined ? { status } : {}),
    ...(payload.headers && isRecord(payload.headers) ? { headers: cloneJson(payload.headers) } : {}),
    ...(nestedMessage(payload) ? { message: nestedMessage(payload) } : {}),
    rawBody: cloneJson(payload)
  };
}

function createErrorStreamChunk(error: Record<string, unknown>): LimCodeOpenAIResponsesStreamChunk {
  return {
    error: error as never,
    rawChunk: error.rawChunk ?? error.rawBody ?? error.message
  };
}

function hasMeaningfulChunk(chunk: LimCodeOpenAIResponsesStreamChunk): boolean {
  return !!chunk.textDelta
    || (chunk.partsDelta?.length ?? 0) > 0
    || (chunk.functionCalls?.length ?? 0) > 0
    || (chunk.toolCallArgumentDeltas?.length ?? 0) > 0
    || !!chunk.finishReason
    || !!chunk.usageMetadata
    || !!chunk.error
    || !!chunk.thoughtSignature
    || !!chunk.thoughtSignatures;
}

function closeAndInvalidate(session: WebSocketSession, terminate: boolean): void {
  const socket = session.socket;
  session.socket = undefined;
  session.connectedAt = undefined;
  session.connectionIdentityHash = undefined;
  invalidateContinuation(session);
  if (!socket) return;
  try {
    if (terminate) socket.terminate();
    else socket.close();
  } catch { /* noop */ }
}

function invalidateContinuation(session: WebSocketSession): void {
  session.lastRequest = undefined;
  session.lastResponse = undefined;
}

function webSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'content-type' || normalized === 'content-length'
      || normalized === 'connection' || normalized === 'upgrade'
      || normalized.startsWith('sec-websocket-')) continue;
    result[normalized] = value;
  }
  return result;
}

function normalizeProxyUrl(proxy?: string): string | undefined {
  const normalized = proxy?.trim();
  return normalized ? new URL(normalized).toString() : undefined;
}

function proxyAgent(proxy?: string): HttpsProxyAgent<string> | undefined {
  const normalized = proxy?.trim();
  if (!normalized) return undefined;
  const cached = proxyAgents.get(normalized);
  if (cached) return cached;
  const agent = new HttpsProxyAgent(normalized, { rejectUnauthorized: false });
  proxyAgents.set(normalized, agent);
  return agent;
}

function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

function parseWebSocketData(data: RawData): { ok: true; value: Record<string, unknown> } | { ok: false; error: Error } {
  try {
    const text = typeof data === 'string'
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data)).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as Uint8Array).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('WebSocket event must be a JSON object.');
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function eventType(value: Record<string, unknown>): string {
  return typeof value.type === 'string'
    ? value.type
    : typeof value.event === 'string'
      ? value.event
      : '';
}

function nestedMessage(value: Record<string, unknown>): string | undefined {
  const direct = normalizedString(value.message);
  if (direct && !isGenericErrorLabel(direct)) return direct;
  if (isRecord(value.error)) {
    const message = normalizedString(value.error.message);
    if (message && !isGenericErrorLabel(message)) return message;
  }
  if (isRecord(value.response)) return nestedMessage(value.response);
  return undefined;
}

function isGenericErrorLabel(value: string): boolean {
  return new Set([
    'stream_error',
    'upstream_error',
    'http_error',
    'response_error',
    'decode_error',
    'stream_read_error',
    'stream_parse_error',
    'llm_error'
  ]).has(value.trim().toLowerCase());
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalString(value)).digest('hex');
}

function shortCanonicalHash(value: unknown): string {
  return canonicalHash(value).slice(0, 16);
}

function canonicalString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(record[key])}`).join(',')}}`;
}

function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : 'OpenAI Responses WebSocket request aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

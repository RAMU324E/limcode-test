import { createHash } from 'node:crypto';
import type { LlmProviderKind } from '../../shared/protocol';

const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60_000;

export interface LlmProviderWireToolItemTrace {
  index: string;
  idSha256?: string;
}

export interface LlmProviderWireInvariantTrace {
  bodySha256: string;
  messageCount: number;
  toolItems: LlmProviderWireToolItemTrace[];
}

export interface TerminalValidatedFetchOptions {
  bodyIdleTimeoutMs?: number;
  onWireInvariantTrace?: (trace: LlmProviderWireInvariantTrace) => void;
}

export class LlmHttpStreamTerminationError extends Error {
  public readonly code: 'LLM_STREAM_TRUNCATED' | 'LLM_TRANSPORT_TIMEOUT';
  public readonly phase = 'response_body';

  public constructor(
    message: string,
    code: 'LLM_STREAM_TRUNCATED' | 'LLM_TRANSPORT_TIMEOUT' = 'LLM_STREAM_TRUNCATED',
    public readonly timeoutMs?: number
  ) {
    super(message);
    this.name = 'LlmHttpStreamTerminationError';
    this.code = code;
  }
}

/**
 * Keeps the provider package's format decoding, but refuses to turn a transport EOF into a
 * successful model completion unless the raw SSE protocol carried provider terminal evidence.
 */
export function createTerminalValidatedFetch(
  baseFetch: typeof fetch,
  provider: LlmProviderKind,
  options: TerminalValidatedFetchOptions = {}
): typeof fetch {
  const bodyIdleTimeoutMs = positiveTimeout(options.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS);
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const wireTrace = await inspectFinalWireBody(input, init, provider);
    if (wireTrace) emitWireInvariantTrace(options.onWireInvariantTrace, wireTrace);
    let response = await baseFetch(input, init);
    if (!response.ok && wireTrace?.toolItems.length) {
      response = annotateRemoteError(response, wireTrace.bodySha256);
    }
    if (!response.ok || !response.body || !isEventStream(response.headers.get('content-type'))) return response;

    const reader = response.body.getReader();
    const tracker = new SseTerminalTracker(provider);
    // Fetch implementations expose decoded response bytes while commonly retaining the encoded
    // Content-Length header. Only compare lengths when no content coding can change the byte count.
    const expectedBytes = hasIdentityContentEncoding(response.headers.get('content-encoding'))
      ? contentLength(response.headers.get('content-length'))
      : undefined;
    let receivedBytes = 0;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        try {
          const next = await readWithIdleDeadline(reader, bodyIdleTimeoutMs);
          if (!next.done) {
            receivedBytes += next.value.byteLength;
            tracker.push(next.value);
            controller.enqueue(next.value);
            return;
          }

          closed = true;
          tracker.finish();
          if (expectedBytes !== undefined && receivedBytes !== expectedBytes) {
            throw new LlmHttpStreamTerminationError(
              `HTTP stream ended after ${receivedBytes} of ${expectedBytes} declared bytes.`
            );
          }
          if (!tracker.sawTerminal) {
            throw new LlmHttpStreamTerminationError(
              `${provider} SSE stream ended without provider terminal evidence.`
            );
          }
          controller.close();
        } catch (error) {
          closed = true;
          void reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        closed = true;
        await reader.cancel(reason);
      }
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

async function inspectFinalWireBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
  provider: LlmProviderKind
): Promise<LlmProviderWireInvariantTrace | undefined> {
  const bytes = await requestBodyBytes(input, init);
  if (!bytes) return undefined;
  const bodySha256 = createHash('sha256').update(bytes).digest('hex');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    throw wireInvariantError(provider, bodySha256, 'final request body is not valid UTF-8 JSON', cause);
  }
  const root = requireWireRecord(body, provider, bodySha256, 'request body');
  const toolItems: LlmProviderWireToolItemTrace[] = [];
  let messageCount: number;
  if (provider === 'openai-compatible' || provider === 'deepseek') {
    const messages = requireWireArray(root.messages, provider, bodySha256, 'messages');
    messageCount = messages.length;
    for (let index = 0; index < messages.length; index += 1) {
      const message = asWireRecord(messages[index]);
      if (message?.role !== 'tool') continue;
      toolItems.push(requiredIdTrace(
        message.tool_call_id,
        `messages[${index}]`,
        'tool_call_id',
        provider,
        bodySha256
      ));
    }
  } else if (provider === 'openai-responses') {
    const inputItems = requireWireArray(root.input, provider, bodySha256, 'input');
    messageCount = inputItems.length;
    for (let index = 0; index < inputItems.length; index += 1) {
      const item = asWireRecord(inputItems[index]);
      if (item?.type !== 'function_call_output') continue;
      toolItems.push(requiredIdTrace(
        item.call_id,
        `input[${index}]`,
        'call_id',
        provider,
        bodySha256
      ));
    }
  } else if (provider === 'claude') {
    const messages = requireWireArray(root.messages, provider, bodySha256, 'messages');
    messageCount = messages.length;
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = asWireRecord(messages[messageIndex]);
      if (!Array.isArray(message?.content)) continue;
      for (let itemIndex = 0; itemIndex < message.content.length; itemIndex += 1) {
        const item = asWireRecord(message.content[itemIndex]);
        if (item?.type !== 'tool_result') continue;
        toolItems.push(requiredIdTrace(
          item.tool_use_id,
          `messages[${messageIndex}].content[${itemIndex}]`,
          'tool_use_id',
          provider,
          bodySha256
        ));
      }
    }
  } else {
    const contents = requireWireArray(root.contents, provider, bodySha256, 'contents');
    messageCount = contents.length;
    for (let contentIndex = 0; contentIndex < contents.length; contentIndex += 1) {
      const content = asWireRecord(contents[contentIndex]);
      if (!Array.isArray(content?.parts)) continue;
      for (let partIndex = 0; partIndex < content.parts.length; partIndex += 1) {
        const part = asWireRecord(content.parts[partIndex]);
        if (!part || !Object.prototype.hasOwnProperty.call(part, 'functionResponse')) continue;
        const response = requireWireRecord(
          part.functionResponse,
          provider,
          bodySha256,
          `contents[${contentIndex}].parts[${partIndex}].functionResponse`
        );
        if (typeof response.name !== 'string' || !response.name.trim()) {
          throw wireInvariantError(
            provider,
            bodySha256,
            `Gemini contents[${contentIndex}].parts[${partIndex}].functionResponse.name must be non-empty`
          );
        }
        if (!asWireRecord(response.response)) {
          throw wireInvariantError(
            provider,
            bodySha256,
            `Gemini contents[${contentIndex}].parts[${partIndex}].functionResponse.response must be an object`
          );
        }
        const itemTrace: LlmProviderWireToolItemTrace = {
          index: `contents[${contentIndex}].parts[${partIndex}]`
        };
        if (response.id !== undefined) {
          if (typeof response.id !== 'string' || !response.id.trim()) {
            throw wireInvariantError(
              provider,
              bodySha256,
              `Gemini ${itemTrace.index}.functionResponse.id must be non-empty when provided`
            );
          }
          itemTrace.idSha256 = hashId(response.id);
        }
        toolItems.push(itemTrace);
      }
    }
  }
  return { bodySha256, messageCount, toolItems };
}

async function requestBodyBytes(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<Buffer | undefined> {
  if (init?.body !== undefined && init.body !== null) return bodyValueBytes(init.body);
  if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
    return Buffer.from(await input.clone().arrayBuffer());
  }
  return undefined;
}

async function bodyValueBytes(body: NonNullable<RequestInit['body']>): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('LLM final request body must be inspectable bytes before fetch.');
}

function requiredIdTrace(
  value: unknown,
  index: string,
  field: string,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireToolItemTrace {
  if (typeof value !== 'string' || !value.trim()) {
    throw wireInvariantError(provider, bodySha256, `${index}.${field} must be a non-empty string`);
  }
  return { index, idSha256: hashId(value) };
}

function hashId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireWireArray(
  value: unknown,
  provider: LlmProviderKind,
  bodySha256: string,
  label: string
): unknown[] {
  if (!Array.isArray(value)) throw wireInvariantError(provider, bodySha256, `${label} must be an array`);
  return value;
}

function requireWireRecord(
  value: unknown,
  provider: LlmProviderKind,
  bodySha256: string,
  label: string
): Record<string, unknown> {
  const record = asWireRecord(value);
  if (!record) throw wireInvariantError(provider, bodySha256, `${label} must be an object`);
  return record;
}

function asWireRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function wireInvariantError(
  provider: LlmProviderKind,
  bodySha256: string,
  detail: string,
  cause?: unknown
): Error {
  const error = new Error(`LLM ${provider} wire invariant failed: ${detail}; body_sha256=${bodySha256}.`);
  return Object.assign(
    error,
    { code: 'LLM_WIRE_INVARIANT_FAILED', provider, bodySha256, ...(cause === undefined ? {} : { cause }) }
  );
}

function emitWireInvariantTrace(
  observer: TerminalValidatedFetchOptions['onWireInvariantTrace'],
  trace: LlmProviderWireInvariantTrace
): void {
  try {
    observer?.(trace);
  } catch {
    // Privacy-safe observability is best effort and never provider authority.
  }
  if (trace.toolItems.length > 0) {
    console.info('[LimCode][ProviderWireInvariant]', JSON.stringify(trace));
  }
}

function annotateRemoteError(response: Response, bodySha256: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-limcode-wire-invariant', `passed; body_sha256=${bodySha256}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

class SseTerminalTracker {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private currentEvent = '';
  private dataLines: string[] = [];
  public sawTerminal = false;

  public constructor(private readonly provider: LlmProviderKind) {}

  public push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    this.consumeCompleteLines();
  }

  public finish(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer) {
      const trailing = this.buffer;
      this.buffer = '';
      this.consumeLine(trailing.endsWith('\r') ? trailing.slice(0, -1) : trailing);
    }
    this.dispatch();
  }

  private consumeCompleteLines(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  private consumeLine(line: string): void {
    if (!line) {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') this.currentEvent = value.trim();
    else if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(): void {
    const event = this.currentEvent;
    const data = this.dataLines.join('\n');
    this.currentEvent = '';
    this.dataLines = [];
    if (!data && !event) return;
    if (data.trim() === '[DONE]' || terminalEventName(event)) {
      this.sawTerminal = true;
      return;
    }
    if (!data) return;
    try {
      if (hasTerminalJsonEvidence(JSON.parse(data), this.provider)) this.sawTerminal = true;
    } catch {
      // The provider package owns parse errors. This layer only records positive terminal evidence.
    }
  }
}

function terminalEventName(event: string): boolean {
  return event === 'response.completed' || event === 'message_stop';
}

function hasTerminalJsonEvidence(value: unknown, provider: LlmProviderKind, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((entry) => hasTerminalJsonEvidence(entry, provider, depth + 1));
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'response.completed' || record.type === 'message_stop') return true;
  if (provider === 'openai-responses') {
    const response = record.response;
    if (response && typeof response === 'object'
      && (response as Record<string, unknown>).status === 'completed') return true;
  }
  for (const key of ['finish_reason', 'finishReason', 'stop_reason']) {
    const reason = record[key];
    if (typeof reason === 'string' && reason.trim()) return true;
  }
  return Object.values(record).some((entry) => hasTerminalJsonEvidence(entry, provider, depth + 1));
}

async function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmHttpStreamTerminationError(
      `HTTP response body was idle for ${timeoutMs}ms.`,
      'LLM_TRANSPORT_TIMEOUT',
      timeoutMs
    )), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isEventStream(value: string | null): boolean {
  return value?.toLowerCase().split(';', 1)[0]?.trim() === 'text/event-stream';
}

function contentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function hasIdentityContentEncoding(value: string | null): boolean {
  return value === null || value.trim() === '' || value.trim().toLowerCase() === 'identity';
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('bodyIdleTimeoutMs must be positive.');
  return value;
}

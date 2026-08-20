import type { LlmProviderKind } from '../../shared/protocol';
import {
  annotateProviderWireError,
  emitProviderWireInvariantTrace,
  inspectFinalProviderWireBody,
  type LlmProviderWireInvariantTrace
} from './providerWireInvariant';

export type {
  LlmProviderWireInvariantTrace,
  LlmProviderWireToolItemTrace
} from './providerWireInvariant';

const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60_000;

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
    const wireTrace = await inspectFinalProviderWireBody(input, init, provider);
    if (wireTrace) emitProviderWireInvariantTrace(options.onWireInvariantTrace, wireTrace);
    let response = await baseFetch(input, init);
    if (!response.ok && wireTrace?.toolItems.length) {
      response = annotateProviderWireError(response, wireTrace.bodySha256);
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

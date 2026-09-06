import { randomUUID } from 'node:crypto';
import type { LlmResponseObserver, LlmResponseObservation } from 'unified-llm-provider';
import type { DebugCaptureContext, DebugCaptureSourceRef } from '../../../shared/debugCapture';

export interface DebugCaptureInput {
  stage: string;
  context?: DebugCaptureContext;
  sources?: readonly DebugCaptureSourceRef[];
  metadata?: Record<string, string | number | boolean | null>;
  payload?: unknown;
  bytes?: Uint8Array | ArrayBuffer | readonly Uint8Array[];
}

export interface DebugCaptureRecorder {
  active(context?: DebugCaptureContext): string | undefined;
  record(input: DebugCaptureInput): DebugCaptureSourceRef | undefined;
}

const contexts = new WeakMap<object, DebugCaptureContext>();
const sources = new WeakMap<object, readonly DebugCaptureSourceRef[]>();

export function setDebugCaptureContext(value: object, context: DebugCaptureContext): void { contexts.set(value, context); }
export function getDebugCaptureContext(value: object): DebugCaptureContext | undefined { return contexts.get(value); }
export function debugCaptureSources(value: unknown): readonly DebugCaptureSourceRef[] {
  return value !== null && typeof value === 'object' ? sources.get(value) ?? [] : [];
}
export function associateDebugCapture(value: unknown, refs: readonly DebugCaptureSourceRef[]): void {
  if (value !== null && typeof value === 'object' && refs.length) sources.set(value, refs);
}
export function debugSource(value: unknown): DebugCaptureSourceRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as DebugCaptureSourceRef;
  return typeof ref.runId === 'string' && Number.isSafeInteger(ref.captureSeq) ? ref : undefined;
}

export function captureDebug(
  recorder: DebugCaptureRecorder | undefined,
  context: DebugCaptureContext | undefined,
  input: () => Omit<DebugCaptureInput, 'context'>
): DebugCaptureSourceRef | undefined {
  try {
    if (!recorder?.active(context)) return undefined;
    const event = input();
    const requiresSource = ['ws.decode_input', 'ws.decoded', 'ws.tool_assembly', 'http.decode_input', 'http.decoded', 'http.tool_assembly', 'capability.output'].includes(event.stage);
    return recorder.record({ ...event, ...(context ? { context } : {}),
      ...(requiresSource && !event.sources?.length ? { metadata: { ...event.metadata, sourceUnlinked: true } } : {}) });
  } catch { return undefined; }
}

export class DebugHttpObservation {
  public readonly streamId = randomUUID();
  private offset = 0;
  private readSeq = 0;
  public readonly observer: LlmResponseObserver;

  public constructor(
    private readonly recorder: DebugCaptureRecorder,
    private readonly context: DebugCaptureContext,
    private readonly attach: (response: Response, observer: LlmResponseObserver) => Response
  ) {
    this.observer = {
      streamId: this.streamId,
      active: () => this.recorder.active(this.context),
      observe: (event) => this.decoded(event)
    };
  }

  public request(input: string | URL | Request, init?: RequestInit): void {
    captureDebug(this.recorder, this.context, () => ({
      stage: 'transport.send', payload: typeof init?.body === 'string' ? init.body : undefined,
      metadata: { transport: 'http', streamId: this.streamId, url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        bodyAvailable: typeof init?.body === 'string' }
    }));
  }

  public raw(bytes: Uint8Array): void {
    const start = this.offset;
    this.offset += bytes.byteLength;
    this.readSeq += 1;
    captureDebug(this.recorder, this.context, () => ({ stage: 'transport.receive', bytes,
      metadata: { transport: 'http', streamId: this.streamId, readSeq: this.readSeq, byteStart: start, byteEnd: this.offset } }));
  }

  public end(reason: string, error?: unknown): void {
    captureDebug(this.recorder, this.context, () => ({ stage: 'transport.end',
      metadata: { transport: 'http', streamId: this.streamId, byteEnd: this.offset, reason },
      ...(error === undefined ? {} : { payload: error instanceof Error ? { name: error.name, message: error.message } : String(error) }) }));
  }

  public bind(response: Response): Response {
    return this.attach(response, this.observer);
  }

  private decoded(event: LlmResponseObservation): DebugCaptureSourceRef | undefined {
    if (this.recorder.active(this.context) !== event.captureToken) return undefined;
    const parent = debugSource(event.parent);
    if (event.kind === 'tool_assembly') {
      const value = event.value as { baseline?: string; fragment: string; callId: string; streamIndex: string; beforeChars: number; afterChars: number; operation: string; selectionReason: string };
      const metadata = { transport: 'http', streamId: event.streamId, callId: value.callId, streamIndex: value.streamIndex,
        beforeChars: value.beforeChars, afterChars: value.afterChars, operation: value.operation, selectionReason: value.selectionReason };
      if (value.baseline !== undefined) captureDebug(this.recorder, this.context, () => ({ stage: 'http.tool_baseline', metadata, payload: value.baseline }));
      return captureDebug(this.recorder, this.context, () => ({ stage: 'http.tool_assembly', metadata, payload: value.fragment, sources: parent ? [parent] : [] }));
    }
    return captureDebug(this.recorder, this.context, () => ({
      stage: `http.${event.kind}`, payload: event.value, sources: parent ? [parent] : [],
      metadata: { transport: 'http', streamId: event.streamId,
        ...(event.eventSeq === undefined ? {} : { eventSeq: event.eventSeq }),
        ...(event.byteStart === undefined ? {} : { byteStart: event.byteStart }),
        ...(event.byteEnd === undefined ? {} : { byteEnd: event.byteEnd }),
        ...(event.kind === 'sse_event' && event.byteStart === undefined ? { missingStart: true } : {}) }
    }));
  }
}

import type { DebugCaptureContext } from '../../../shared/debugCapture';
import { captureDebug, debugCaptureSources, type DebugCaptureRecorder } from './observer';

export interface DebugWebSocketObservation {
  recorder: DebugCaptureRecorder;
  context: DebugCaptureContext;
  metadata?: Record<string, string | number | boolean | null>;
}

const baselines = new WeakMap<object, string>();

export function observeToolAssembly(
  debug: DebugWebSocketObservation | undefined,
  raw: Record<string, unknown>,
  accumulator: { callId: string; streamIndex?: string; arguments: string } | undefined,
  before: string,
  applied: string,
  operation: 'append' | 'replace' | 'complete' | 'rejected',
  selectionReason: string
): void {
  if (!debug) return;
  const runId = debug.recorder.active(debug.context);
  if (!runId) return;
  const item = raw.item && typeof raw.item === 'object' ? raw.item as Record<string, unknown> : undefined;
  const metadata = {
    ...debug.metadata,
    callId: accumulator?.callId ?? null,
    streamIndex: accumulator?.streamIndex ?? null,
    rawItemId: typeof (raw.item_id ?? item?.id) === 'string' ? String(raw.item_id ?? item?.id) : null,
    rawCallId: typeof (raw.call_id ?? item?.call_id) === 'string' ? String(raw.call_id ?? item?.call_id) : null,
    outputIndex: typeof raw.output_index === 'number' ? raw.output_index : null,
    beforeChars: before.length,
    afterChars: accumulator?.arguments.length ?? before.length,
    operation,
    selectionReason
  };
  if (accumulator && baselines.get(accumulator) !== runId) {
    captureDebug(debug.recorder, debug.context, () => ({ stage: 'ws.tool_baseline', metadata, payload: before }));
    baselines.set(accumulator, runId);
  }
  captureDebug(debug.recorder, debug.context, () => ({
    stage: 'ws.tool_assembly', metadata, payload: applied, sources: debugCaptureSources(raw)
  }));
}

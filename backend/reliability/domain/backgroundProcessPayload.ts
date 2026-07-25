import type { BackgroundProcessCompletionPayload } from './types';

/** Hard bound for process-store data copied into the generic RuntimeInbox payload. */
export const MAX_BACKGROUND_PROCESS_COMPLETION_PAYLOAD_CHARS = 12_000;

export interface BackgroundProcessCompletionInput {
  processId: string;
  toolName: 'shell' | 'bash';
  command: string;
  cwd: string;
  status: 'exited' | 'killed' | 'abnormal';
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  droppedChars?: number;
}

export function normalizeBackgroundProcessCompletionPayload(input: BackgroundProcessCompletionInput): BackgroundProcessCompletionPayload {
  const baseDropped = nonNegativeInteger(input.droppedChars ?? 0);
  let payload: BackgroundProcessCompletionPayload = {
    processId: boundedEdge(input.processId, 256),
    toolName: input.toolName,
    command: boundedEdge(input.command, 2_000),
    cwd: boundedEdge(input.cwd, 1_000),
    status: input.status,
    exitCode: Number.isFinite(input.exitCode) ? Math.trunc(input.exitCode) : 1,
    killed: input.killed === true,
    stdout: tail(input.stdout, 4_000),
    stderr: tail(input.stderr, 4_000),
    ...(baseDropped > 0 ? { droppedChars: baseDropped } : {})
  };
  let encodedLength = JSON.stringify(payload).length;
  let additionalDropped = Math.max(0, input.stdout.length - payload.stdout.length)
    + Math.max(0, input.stderr.length - payload.stderr.length);

  // JSON escaping can expand control-heavy output. Shrink the longest free-text field until the
  // serialized pure-data payload itself—not only its source strings—fits the durable bound.
  for (let guard = 0; encodedLength > MAX_BACKGROUND_PROCESS_COMPLETION_PAYLOAD_CHARS && guard < 32; guard += 1) {
    const candidates = [
      ['stdout', payload.stdout] as const,
      ['stderr', payload.stderr] as const,
      ['command', payload.command] as const,
      ['cwd', payload.cwd] as const
    ].sort((left, right) => right[1].length - left[1].length);
    const [field, value] = candidates[0];
    if (value.length === 0) break;
    const reduction = Math.max(1, Math.ceil((encodedLength - MAX_BACKGROUND_PROCESS_COMPLETION_PAYLOAD_CHARS) / 2));
    const nextLength = Math.max(0, value.length - reduction);
    const next = field === 'command' || field === 'cwd' ? boundedEdge(value, nextLength) : tail(value, nextLength);
    if (field === 'stdout' || field === 'stderr') additionalDropped += value.length - next.length;
    payload = { ...payload, [field]: next };
    encodedLength = JSON.stringify(payload).length;
  }
  const droppedChars = baseDropped + additionalDropped;
  payload = {
    ...payload,
    ...(droppedChars > 0 ? { droppedChars } : {})
  };
  if (JSON.stringify(payload).length > MAX_BACKGROUND_PROCESS_COMPLETION_PAYLOAD_CHARS) {
    const stdout = tail(payload.stdout, 2_000);
    const stderr = tail(payload.stderr, 2_000);
    payload = {
      ...payload,
      command: boundedEdge(payload.command, 512),
      cwd: boundedEdge(payload.cwd, 256),
      stdout,
      stderr,
      droppedChars: nonNegativeInteger((payload.droppedChars ?? 0)
        + payload.stdout.length - stdout.length
        + payload.stderr.length - stderr.length)
    };
  }
  if (JSON.stringify(payload).length > MAX_BACKGROUND_PROCESS_COMPLETION_PAYLOAD_CHARS) {
    throw new Error('Background-process completion payload could not be bounded safely.');
  }
  return payload;
}

function boundedEdge(value: string, maxChars: number): string {
  const normalized = typeof value === 'string' ? value : String(value ?? '');
  if (maxChars <= 0) return '';
  if (normalized.length <= maxChars) return normalized;
  if (maxChars < 32) return normalized.slice(0, maxChars);
  const head = Math.floor((maxChars - 18) / 2);
  const tailLength = maxChars - 18 - head;
  return `${normalized.slice(0, head)}…[truncated]…${normalized.slice(-tailLength)}`;
}

function tail(value: string, maxChars: number): string {
  const normalized = typeof value === 'string' ? value : String(value ?? '');
  if (maxChars <= 0) return '';
  return normalized.length <= maxChars ? normalized : normalized.slice(-maxChars);
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

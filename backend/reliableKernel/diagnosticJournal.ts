import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import { RootAuthority } from './rootAuthority';

export type ReliableDiagnosticScopeKind =
  | 'runtime'
  | 'conversation'
  | 'turn'
  | 'model_request'
  | 'tool_call'
  | 'feed_session';

export interface ReliableDiagnosticEventInput {
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  correlationId?: string;
  observedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ReliableDiagnosticEventRecord {
  schema: 'limcode-reliable-diagnostic';
  id: string;
  eventKind: string;
  scopeKind?: ReliableDiagnosticScopeKind;
  scopeId?: string;
  correlationId?: string;
  observedAt: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface ReliableDiagnosticObserver {
  observe(event: ReliableDiagnosticEventInput): void;
}

export interface ReliableDiagnosticSpanRecord {
  kind: 'provider-first-paint' | 'feed-roundtrip' | 'diff-open';
  correlationId: string;
  milestones: Record<string, string>;
  startedAt?: string;
  completedAt?: string;
  elapsedMs?: number;
}

export interface ReliableDiagnosticJournalInspection {
  bounds: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxPendingEvents: number;
    retentionMs: number;
    maxReturnedEvents: number;
    maxReturnedSpans: number;
  };
  state: {
    pendingEvents: number;
    droppedEvents: number;
    persistedEvents: number;
    rotations: number;
    lastFailureCode?: string;
  };
  events: ReliableDiagnosticEventRecord[];
  spans: ReliableDiagnosticSpanRecord[];
}

const DIAGNOSTIC_DIRECTORY = 'diagnostics';
const CURRENT_FILE = 'events.jsonl';
const MAX_FILES = 4;
const MAX_FILE_BYTES = 1_048_576;
const MAX_PENDING_EVENTS = 256;
const MAX_FLUSH_EVENTS = 128;
const MAX_RETURNED_EVENTS = 200;
const MAX_RETURNED_SPANS = 100;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const FLUSH_DELAY_MS = 750;
const MAX_METADATA_FIELDS = 16;
const MAX_METADATA_STRING_LENGTH = 192;
const MAX_ID_LENGTH = 256;

const ALLOWED_METADATA_KEYS = new Set([
  'conversationId',
  'turnId',
  'modelRequestId',
  'toolCallId',
  'sessionId',
  'hostBootId',
  'messageSeq',
  'commitSeq',
  'streamSeq',
  'stage',
  'sessionKeyHash',
  'connectionGeneration',
  'connectionReused',
  'connectionReason',
  'mode',
  'timeoutPhase',
  'leaseGeneration',
  'leaseExpiresAt',
  'remainingMs',
  'renewalReason',
  'fullInputItemCount',
  'sentInputItemCount',
  'responseCreateFrameSha256',
  'responseCreateFrameBytes',
  'responseCreateSeq',
  'kind',
  'status',
  'operation',
  'reasonCode',
  'errorName',
  'elapsedMs',
  'bytes',
  'changeCount',
  'memberCount',
  'scanned',
  'reconciled',
  'unchanged',
  'unknown',
  'round',
  'cacheEntries',
  'cacheBytes',
  'cacheHits',
  'cacheMisses',
  'cacheEvictions',
  'openTaskCount',
  'taskCardSha256',
  'activeChildCount',
  'runningProcessCount',
  'droppedEvents'
]);

/**
 * Metadata-only rolling journal stored under the current fenced Runtime root.
 *
 * It is deliberately not a Runtime authority table: diagnostics must never advance domain state or
 * feed commitSeq. Every write revalidates the complete RootBinding, files are capped to 4 MiB total,
 * stale rotations are removed after seven days, and pending memory is bounded. Prompt/output/tool
 * arguments, credentials, headers, paths and arbitrary nested objects are rejected by construction.
 */
export class ReliableDiagnosticJournal implements ReliableDiagnosticObserver {
  private readonly pending: ReliableDiagnosticEventRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushPromise: Promise<void> | undefined;
  private closed = false;
  private droppedEvents = 0;
  private persistedEvents = 0;
  private rotations = 0;
  private lastFailureCode: string | undefined;

  public constructor(
    private readonly authority: RootAuthority,
    private readonly binding: RootBinding,
    private readonly now: () => Date = () => new Date()
  ) {}

  public observe(input: ReliableDiagnosticEventInput): void {
    if (this.closed) return;
    let event: ReliableDiagnosticEventRecord;
    try {
      event = normalizeEvent(input, this.now());
    } catch {
      this.droppedEvents += 1;
      return;
    }
    if (this.pending.length >= MAX_PENDING_EVENTS) {
      this.pending.shift();
      this.droppedEvents += 1;
    }
    this.pending.push(event);
    if (this.pending.length >= MAX_FLUSH_EVENTS) void this.flush();
    else this.scheduleFlush();
  }

  public async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.clearFlushTimer();
    if (this.pending.length === 0) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      if (!this.closed && this.pending.length > 0) this.scheduleFlush();
    });
    return this.flushPromise;
  }

  public async inspect(input: { scopeId?: string; limit?: number } = {}): Promise<ReliableDiagnosticJournalInspection> {
    while (this.flushPromise || this.pending.length > 0) await this.flush();
    const limit = normalizeLimit(input.limit);
    const scopeId = input.scopeId?.trim();
    let events: ReliableDiagnosticEventRecord[] = [];
    try {
      await this.authority.validate(this.binding);
      events = await readJournalEvents(this.rootPath(), this.now().getTime() - RETENTION_MS);
      this.lastFailureCode = undefined;
    } catch (error) {
      this.lastFailureCode = errorCode(error);
    }
    if (scopeId) {
      events = events.filter((event) =>
        event.scopeId === scopeId
        || event.metadata.conversationId === scopeId
        || event.metadata.turnId === scopeId
        || event.metadata.modelRequestId === scopeId
        || event.metadata.toolCallId === scopeId
      );
    }
    events.sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.id.localeCompare(right.id)
    );
    return {
      bounds: {
        maxFiles: MAX_FILES,
        maxFileBytes: MAX_FILE_BYTES,
        maxTotalBytes: MAX_FILES * MAX_FILE_BYTES,
        maxPendingEvents: MAX_PENDING_EVENTS,
        retentionMs: RETENTION_MS,
        maxReturnedEvents: MAX_RETURNED_EVENTS,
        maxReturnedSpans: MAX_RETURNED_SPANS
      },
      state: {
        pendingEvents: this.pending.length,
        droppedEvents: this.droppedEvents,
        persistedEvents: this.persistedEvents,
        rotations: this.rotations,
        ...(this.lastFailureCode ? { lastFailureCode: this.lastFailureCode } : {})
      },
      events: events.slice(-limit),
      spans: buildDiagnosticSpans(events).slice(-MAX_RETURNED_SPANS)
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearFlushTimer();
    while (this.flushPromise || this.pending.length > 0) await this.flush();
  }

  private async flushOnce(): Promise<void> {
    const batch = this.pending.splice(0, MAX_FLUSH_EVENTS);
    if (batch.length === 0) return;
    try {
      await this.authority.validate(this.binding);
      const root = this.rootPath();
      await fs.mkdir(root, { recursive: true });
      await pruneExpiredFiles(root, this.now().getTime() - RETENTION_MS);
      const bytes = Buffer.from(batch.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
      if (bytes.length > MAX_FILE_BYTES) throw new Error('diagnostic-batch-too-large');
      const current = path.join(root, CURRENT_FILE);
      const currentBytes = await fileSize(current);
      if (currentBytes + bytes.length > MAX_FILE_BYTES) {
        await rotateFiles(root);
        this.rotations += 1;
      }
      await fs.appendFile(current, bytes, { mode: 0o600 });
      this.persistedEvents += batch.length;
      this.lastFailureCode = undefined;
    } catch (error) {
      // Diagnostics are observational and must never become a second control path. Failed batches are
      // dropped rather than retried without bound; the inspector exposes only a redacted error code.
      this.droppedEvents += batch.length;
      this.lastFailureCode = errorCode(error);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private rootPath(): string {
    return path.join(this.binding.paths.dataRootPath, DIAGNOSTIC_DIRECTORY);
  }
}

function normalizeEvent(input: ReliableDiagnosticEventInput, now: Date): ReliableDiagnosticEventRecord {
  const eventKind = normalizeToken(input.eventKind, 'eventKind', 96, /^[a-z][a-z0-9_.-]*$/);
  const scopeKind = input.scopeKind;
  if (scopeKind && !['runtime', 'conversation', 'turn', 'model_request', 'tool_call', 'feed_session'].includes(scopeKind)) {
    throw new TypeError('Diagnostic scopeKind is invalid.');
  }
  const scopeId = optionalId(input.scopeId, 'scopeId');
  const correlationId = optionalId(input.correlationId, 'correlationId');
  const observedAt = normalizeTimestamp(input.observedAt, now);
  const metadata: ReliableDiagnosticEventRecord['metadata'] = {};
  for (const [key, value] of Object.entries(input.metadata ?? {}).slice(0, MAX_METADATA_FIELDS)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) continue;
    const normalized = normalizeMetadataValue(value);
    if (normalized !== undefined) metadata[key] = normalized;
  }
  return {
    schema: 'limcode-reliable-diagnostic',
    id: `diagnostic-${randomUUID()}`,
    eventKind,
    ...(scopeKind ? { scopeKind } : {}),
    ...(scopeId ? { scopeId } : {}),
    ...(correlationId ? { correlationId } : {}),
    observedAt,
    metadata
  };
}

function buildDiagnosticSpans(events: ReliableDiagnosticEventRecord[]): ReliableDiagnosticSpanRecord[] {
  const spans = new Map<string, ReliableDiagnosticSpanRecord>();
  for (const event of events) {
    const providerRequestId = metadataText(event.metadata.modelRequestId)
      ?? (event.scopeKind === 'model_request' ? event.scopeId : undefined);
    if (
      providerRequestId
      && (
        (event.eventKind === 'agent.lifecycle' && event.metadata.stage === 'provider_dispatch_started')
        || event.eventKind === 'provider.transient.first_event'
        || event.eventKind === 'webview.transient.painted'
      )
    ) {
      const span = getSpan(spans, `provider:${providerRequestId}`, 'provider-first-paint', providerRequestId);
      if (event.eventKind === 'agent.lifecycle') span.milestones.dispatchStarted = event.observedAt;
      else if (event.eventKind === 'provider.transient.first_event') span.milestones.firstEvent = event.observedAt;
      else span.milestones.firstPaint = event.observedAt;
      continue;
    }
    if (
      event.scopeKind === 'feed_session'
      && event.scopeId
      && event.correlationId
      && ['feed.data.posted', 'feed.data.acked', 'feed.data.post_failed', 'webview.feed.painted'].includes(event.eventKind)
    ) {
      const correlationId = `${event.scopeId}:${event.correlationId}`;
      const span = getSpan(spans, `feed:${correlationId}`, 'feed-roundtrip', correlationId);
      if (event.eventKind === 'feed.data.posted') span.milestones.posted = event.observedAt;
      else if (event.eventKind === 'feed.data.acked') span.milestones.acked = event.observedAt;
      else if (event.eventKind === 'feed.data.post_failed') span.milestones.postFailed = event.observedAt;
      else span.milestones.painted = event.observedAt;
      continue;
    }
    if (event.scopeKind === 'tool_call' && event.scopeId && event.eventKind.startsWith('diff.')) {
      const span = getSpan(spans, `diff:${event.scopeId}`, 'diff-open', event.scopeId);
      if (event.eventKind === 'diff.open.requested') span.milestones.requested = event.observedAt;
      else if (event.eventKind === 'diff.cas.loaded') span.milestones.casLoaded = event.observedAt;
      else if (event.eventKind === 'diff.editor.shown') span.milestones.editorShown = event.observedAt;
      else if (event.eventKind === 'diff.open.failed') span.milestones.failed = event.observedAt;
    }
  }
  const result = [...spans.values()];
  for (const span of result) {
    const times = Object.values(span.milestones)
      .map((value) => ({ value, time: Date.parse(value) }))
      .filter((entry) => Number.isFinite(entry.time))
      .sort((left, right) => left.time - right.time);
    if (times.length === 0) continue;
    span.startedAt = times[0].value;
    if (times.length > 1) {
      span.completedAt = times[times.length - 1].value;
      span.elapsedMs = Math.max(0, times[times.length - 1].time - times[0].time);
    }
  }
  return result.sort((left, right) =>
    Date.parse(left.startedAt ?? '') - Date.parse(right.startedAt ?? '')
    || left.correlationId.localeCompare(right.correlationId)
  );
}

function getSpan(
  spans: Map<string, ReliableDiagnosticSpanRecord>,
  key: string,
  kind: ReliableDiagnosticSpanRecord['kind'],
  correlationId: string
): ReliableDiagnosticSpanRecord {
  const existing = spans.get(key);
  if (existing) return existing;
  const created: ReliableDiagnosticSpanRecord = { kind, correlationId, milestones: {} };
  spans.set(key, created);
  return created;
}

function metadataText(value: string | number | boolean | null | undefined): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function normalizeMetadataValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.slice(0, MAX_METADATA_STRING_LENGTH);
}

function normalizeTimestamp(value: string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError('Diagnostic observedAt must be ISO-compatible.');
  return new Date(time).toISOString();
}

function optionalId(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return normalizeToken(value, label, MAX_ID_LENGTH, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
}

function normalizeToken(value: string, label: string, maxLength: number, pattern: RegExp): string {
  if (typeof value !== 'string') throw new TypeError(`Diagnostic ${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > maxLength || !pattern.test(text)) {
    throw new TypeError(`Diagnostic ${label} is invalid.`);
  }
  return text;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return MAX_RETURNED_EVENTS;
  if (!Number.isSafeInteger(value) || value <= 0) return MAX_RETURNED_EVENTS;
  return Math.min(value, MAX_RETURNED_EVENTS);
}

async function readJournalEvents(root: string, cutoffMs: number): Promise<ReliableDiagnosticEventRecord[]> {
  const result: ReliableDiagnosticEventRecord[] = [];
  for (let index = MAX_FILES - 1; index >= 0; index -= 1) {
    const file = journalFile(root, index);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ReliableDiagnosticEventRecord;
        if (
          parsed?.schema === 'limcode-reliable-diagnostic'
          && typeof parsed.observedAt === 'string'
          && Date.parse(parsed.observedAt) >= cutoffMs
          && parsed.metadata !== null
          && typeof parsed.metadata === 'object'
          && !Array.isArray(parsed.metadata)
        ) result.push(parsed);
      } catch {
        // A torn final diagnostic line is non-authoritative and ignored.
      }
    }
  }
  return result;
}

async function pruneExpiredFiles(root: string, cutoffMs: number): Promise<void> {
  for (let index = 0; index < MAX_FILES; index += 1) {
    const file = journalFile(root, index);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoffMs) await fs.rm(file, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function rotateFiles(root: string): Promise<void> {
  await fs.rm(journalFile(root, MAX_FILES - 1), { force: true });
  for (let index = MAX_FILES - 2; index >= 0; index -= 1) {
    try {
      await fs.rename(journalFile(root, index), journalFile(root, index + 1));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function journalFile(root: string, index: number): string {
  return index === 0 ? path.join(root, CURRENT_FILE) : path.join(root, `events.${index}.jsonl`);
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)) return error.name;
  return 'diagnostic-write-failed';
}

import { randomUUID } from 'node:crypto';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_CHANGE_TYPES,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  type ReliableKernelChangesMessage,
  type ReliableKernelClientChange,
  type ReliableKernelDataMessage,
  type ReliableKernelSnapshotMessage
} from '../../shared/reliableKernelClientFeed';
import type { PlainData } from '../../shared/plainData';
import {
  CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE,
  CLIENT_CHANGE_BATCH_MAX_BYTES,
  CLIENT_CHANGE_BATCH_MAX_RECORDS,
  CLIENT_DETAIL_MAX_RESPONSE_BYTES,
  CLIENT_MAX_INFLIGHT_DATA_MESSAGES,
  CLIENT_MAX_QUEUED_BATCHES,
  CLIENT_MAX_QUEUED_BYTES,
  CLIENT_MESSAGE_WINDOW_LIMIT,
  CLIENT_PAGE_MAX_BYTES,
  CLIENT_PAGE_MAX_ROWS,
  CLIENT_SNAPSHOT_MAX_BYTES,
  CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES
} from './clientFeedBounds';
import type {
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientProjectionSnapshot
} from './databaseWorkerProtocol';
import {
  ContentAddressedStore,
  type ContentObjectMetadata
} from './contentAddressedStore';
import type { RuntimeCommitResult } from './contracts';
import { requirePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ClientFeedSessionView {
  sessionId: string;
  hostBootId: string;
  nextMessageSeq: string;
  inflightMessageSeq: string | null;
  lastAckedCommitSeq: string | null;
  snapshotRequired: boolean;
  queuedBatches: number;
  queuedBytes: number;
}

export interface ClientFeedConnection {
  sessionId: string;
  hostBootId: string;
}

interface QueuedDataMessage {
  message: ReliableKernelDataMessage;
  bytes: number;
  commitSeq: string;
}

interface ClientFeedSession {
  sessionId: string;
  hostBootId: string;
  activeConversationId: string | null;
  nextMessageSeq: bigint;
  inflight: QueuedDataMessage | null;
  lastAckedCommitSeq: string | null;
  snapshotRequired: boolean;
  queue: QueuedDataMessage[];
  queuedBytes: number;
  send(message: ReliableKernelDataMessage): void;
  unsubscribe: (() => void) | null;
  initializing: boolean;
  refreshing: boolean;
  collectingRefresh: boolean;
  handoffCommits: RuntimeCommitResult[];
  closed: boolean;
}

export class UnknownClientSessionError extends Error {
  public readonly code = 'unknown-session';

  public constructor(sessionId: string) {
    super(`Unknown bounded client feed session: ${sessionId}`);
    this.name = 'UnknownClientSessionError';
  }
}

/** Memory-only, one-inflight bounded Extension Host feed. */
export class BoundedClientFeed {
  private readonly sessions = new Map<string, ClientFeedSession>();

  public constructor(private readonly database: RuntimeDatabase) {
    if (CLIENT_MAX_INFLIGHT_DATA_MESSAGES !== 1) {
      throw new Error('BoundedClientFeed implementation requires maxInflightDataMessages=1.');
    }
  }

  public async connect(input: {
    activeConversationId?: string | null;
    send(message: ReliableKernelDataMessage): void;
  }): Promise<ClientFeedConnection> {
    if (typeof input.send !== 'function') throw new TypeError('Client feed send callback is required.');
    const activeConversationId = input.activeConversationId === undefined || input.activeConversationId === null
      ? null
      : requirePhaseFId(input.activeConversationId, 'activeConversationId');
    const session: ClientFeedSession = {
      sessionId: randomUUID(),
      hostBootId: this.database.hostBootId,
      activeConversationId,
      nextMessageSeq: 1n,
      inflight: null,
      lastAckedCommitSeq: null,
      snapshotRequired: false,
      queue: [],
      queuedBytes: 0,
      send: input.send,
      unsubscribe: null,
      initializing: true,
      refreshing: false,
      collectingRefresh: false,
      handoffCommits: [],
      closed: false
    };
    this.sessions.set(session.sessionId, session);
    try {
      const subscription = await this.database.clientProjectionSnapshotAndSubscribe(
        activeConversationId,
        (commit) => this.onCommit(session, commit)
      );
      session.unsubscribe = subscription.unsubscribe;
      const snapshot = this.createSnapshotMessage(session, subscription.barrier.snapshotCommitSeq, subscription.barrier.snapshot);
      this.sendNow(session, snapshot, subscription.barrier.snapshotCommitSeq);
      session.initializing = false;
      const buffered = session.handoffCommits;
      session.handoffCommits = [];
      for (const commit of buffered) this.enqueueCommit(session, commit);
      return { sessionId: session.sessionId, hostBootId: session.hostBootId };
    } catch (error) {
      session.unsubscribe?.();
      this.sessions.delete(session.sessionId);
      throw error;
    }
  }

  public acknowledge(input: {
    sessionId: string;
    hostBootId: string;
    messageSeq: string;
  }): void {
    const session = this.requireSession(input.sessionId);
    if (input.hostBootId !== session.hostBootId) throw new UnknownClientSessionError(input.sessionId);
    const messageSeq = requireDecimal(input.messageSeq, 'messageSeq');
    if (!session.inflight || session.inflight.message.messageSeq !== messageSeq) {
      throw new Error(`Client ACK ${messageSeq} does not match the one inflight data message.`);
    }
    session.lastAckedCommitSeq = session.inflight.commitSeq;
    session.inflight = null;
    if (session.snapshotRequired) {
      void this.refreshSnapshot(session).catch((error) => this.closeFailedSession(session, error));
      return;
    }
    this.flushNext(session);
  }

  public requestSnapshot(sessionIdInput: string, activeConversationId?: string | null): void {
    const session = this.requireSession(sessionIdInput);
    session.activeConversationId = activeConversationId === undefined || activeConversationId === null
      ? null
      : requirePhaseFId(activeConversationId, 'activeConversationId');
    this.enterSnapshotRequired(session);
  }

  public disconnect(sessionIdInput: string): void {
    const sessionId = requirePhaseFId(sessionIdInput, 'sessionId');
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    session.unsubscribe?.();
    session.queue = [];
    session.queuedBytes = 0;
    session.inflight = null;
    this.sessions.delete(sessionId);
  }

  public inspectSession(sessionIdInput: string): ClientFeedSessionView {
    const session = this.requireSession(sessionIdInput);
    return {
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      nextMessageSeq: session.nextMessageSeq.toString(),
      inflightMessageSeq: session.inflight?.message.messageSeq ?? null,
      lastAckedCommitSeq: session.lastAckedCommitSeq,
      snapshotRequired: session.snapshotRequired,
      queuedBatches: session.queue.length,
      queuedBytes: session.queuedBytes
    };
  }

  public close(): void {
    for (const session of [...this.sessions.values()]) this.disconnect(session.sessionId);
  }

  private onCommit(session: ClientFeedSession, commit: RuntimeCommitResult): void {
    if (session.closed) return;
    if (session.initializing || session.collectingRefresh) {
      session.handoffCommits.push(commit);
      return;
    }
    if (session.snapshotRequired) return;
    this.enqueueCommit(session, commit);
  }

  private enqueueCommit(session: ClientFeedSession, commit: RuntimeCommitResult): void {
    if (session.closed || session.snapshotRequired) return;
    const message = this.createChangesMessage(session, commit);
    const bytes = wireBytes(message);
    if (message.changes.length > CLIENT_CHANGE_BATCH_MAX_RECORDS || bytes > CLIENT_CHANGE_BATCH_MAX_BYTES) {
      this.enterSnapshotRequired(session);
      return;
    }
    const queued: QueuedDataMessage = { message, bytes, commitSeq: commit.commitSeq };
    if (!session.inflight && session.queue.length === 0 && !session.refreshing) {
      this.sendQueuedNow(session, queued);
      return;
    }
    if (
      session.queue.length + 1 > CLIENT_MAX_QUEUED_BATCHES
      || session.queuedBytes + bytes > CLIENT_MAX_QUEUED_BYTES
    ) {
      this.enterSnapshotRequired(session);
      return;
    }
    session.queue.push(queued);
    session.queuedBytes += bytes;
  }

  private enterSnapshotRequired(session: ClientFeedSession): void {
    if (session.closed) return;
    session.queue = [];
    session.queuedBytes = 0;
    session.snapshotRequired = true;
    if (!session.inflight && !session.refreshing && !session.initializing) {
      void this.refreshSnapshot(session).catch((error) => this.closeFailedSession(session, error));
    }
  }

  private async refreshSnapshot(session: ClientFeedSession): Promise<void> {
    if (session.closed || session.refreshing || session.inflight) return;
    session.refreshing = true;
    session.collectingRefresh = true;
    session.handoffCommits = [];
    try {
      const barrier = await this.database.clientProjectionSnapshot(session.activeConversationId);
      const visible = BigInt(barrier.snapshotCommitSeq);
      const buffered = session.handoffCommits.filter((commit) => BigInt(commit.commitSeq) > visible);
      session.handoffCommits = [];
      session.collectingRefresh = false;
      session.snapshotRequired = false;
      const snapshot = this.createSnapshotMessage(session, barrier.snapshotCommitSeq, barrier.snapshot);
      this.sendNow(session, snapshot, barrier.snapshotCommitSeq);
      for (const commit of buffered) this.enqueueCommit(session, commit);
    } finally {
      session.collectingRefresh = false;
      session.refreshing = false;
    }
  }

  private flushNext(session: ClientFeedSession): void {
    if (session.closed || session.inflight || session.snapshotRequired || session.refreshing) return;
    const next = session.queue.shift();
    if (!next) return;
    session.queuedBytes -= next.bytes;
    this.sendQueuedNow(session, next);
  }

  private sendQueuedNow(session: ClientFeedSession, queued: QueuedDataMessage): void {
    if (session.inflight) throw new Error('Client feed attempted more than one inflight data message.');
    session.inflight = queued;
    session.send(queued.message);
  }

  private sendNow(
    session: ClientFeedSession,
    message: ReliableKernelDataMessage,
    commitSeq: string
  ): void {
    const queued: QueuedDataMessage = {
      message,
      bytes: wireBytes(message),
      commitSeq
    };
    this.sendQueuedNow(session, queued);
  }

  private createSnapshotMessage(
    session: ClientFeedSession,
    snapshotCommitSeq: string,
    projectionInput: ClientProjectionSnapshot
  ): ReliableKernelSnapshotMessage {
    const messageSeq = this.allocateMessageSeq(session);
    const projections = boundProjectionRecords(toWirePlain(projectionInput) as Record<string, PlainData>);
    const message: ReliableKernelSnapshotMessage = {
      type: RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      messageSeq,
      snapshotCommitSeq: requireDecimal(snapshotCommitSeq, 'snapshotCommitSeq'),
      projections
    };
    enforceSnapshotBounds(message);
    return message;
  }

  private createChangesMessage(
    session: ClientFeedSession,
    commit: RuntimeCommitResult
  ): ReliableKernelChangesMessage {
    const changes: ReliableKernelClientChange[] = [];
    for (const change of commit.changes) {
      if (!RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(change.domain as never)) continue;
      if (change.kind === 'remove') {
        changes.push({ type: change.domain, operation: 'remove', id: change.id });
        continue;
      }
      if (!change.record) throw new Error(`Committed client upsert ${change.domain}/${change.id} has no record projection.`);
      const record = boundRecord(toWirePlain(change.record) as Record<string, PlainData>);
      if (record.id !== change.id) throw new Error('Committed client upsert record identity mismatch.');
      changes.push({ type: change.domain, operation: 'upsert', id: change.id, record });
    }
    return {
      type: RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      messageSeq: this.allocateMessageSeq(session),
      commitSeq: requireDecimal(commit.commitSeq, 'commitSeq'),
      changes
    };
  }

  private allocateMessageSeq(session: ClientFeedSession): string {
    const value = session.nextMessageSeq;
    session.nextMessageSeq += 1n;
    return value.toString();
  }

  private requireSession(sessionIdInput: string): ClientFeedSession {
    const sessionId = requirePhaseFId(sessionIdInput, 'sessionId');
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new UnknownClientSessionError(sessionId);
    return session;
  }

  private closeFailedSession(session: ClientFeedSession, error: unknown): void {
    this.disconnect(session.sessionId);
    queueMicrotask(() => { throw error; });
  }
}

/** Fixed keyset pagination facade; offset and mutable sort keys are not accepted. */
export class ClientHistoryReader {
  public constructor(private readonly database: RuntimeDatabase) {}

  public async page(input: ClientKeysetPageInput): Promise<ClientKeysetPageResult> {
    if ('offset' in (input as unknown as Record<string, unknown>)) {
      throw new TypeError('Offset pagination is forbidden.');
    }
    const result = await this.database.clientKeysetPage(input);
    if (result.rows.length > CLIENT_PAGE_MAX_ROWS || result.responseBytes > CLIENT_PAGE_MAX_BYTES) {
      throw new Error('Database worker returned an out-of-bounds keyset page.');
    }
    return toWirePlain(result) as unknown as ClientKeysetPageResult;
  }
}

export type ClientDetailKind =
  | 'message-content'
  | 'tool-result-content'
  | 'file-change-content'
  | 'process-output'
  | 'context-projection-detail'
  | 'answer-content';

export interface ClientDetailChunk {
  recordId: string;
  offset: number;
  chunk: string;
  encoding: 'base64';
  nextOffset?: number;
  totalBytes: number;
  hasMore: boolean;
  responseBytes: number;
}

/** On-demand CAS detail reader with an actual wire-byte response cap. */
export class ClientDetailReader {
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore
  ) {}

  public async read(input: {
    kind: ClientDetailKind;
    recordId: string;
    offset: number;
    maxBytes: number;
  }): Promise<ClientDetailChunk> {
    const recordId = requirePhaseFId(input.recordId, 'recordId');
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new RangeError('Detail offset must be non-negative.');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new RangeError('Detail maxBytes must be positive.');
    const maxRawBytes = detailRawByteLimit(input.maxBytes);
    if (input.kind === 'context-projection-detail') {
      const bytes = await this.materializeContextProjectionDetail(recordId);
      if (input.offset > bytes.length) throw new RangeError('Detail offset exceeds structural payload length.');
      const end = Math.min(bytes.length, input.offset + maxRawBytes);
      return buildDetailChunk(recordId, input.offset, bytes.subarray(input.offset, end), bytes.length);
    }
    const contentObjectId = await this.resolveContentObjectId(input.kind, recordId);
    const contentRow = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    const range = await this.contentStore.readChunk(contentRow, input.offset, maxRawBytes);
    return buildDetailChunk(recordId, input.offset, range.chunk, range.totalBytes);
  }

  private async materializeContextProjectionDetail(recordId: string): Promise<Buffer> {
    const projection = await this.requireExisting('ModelContextProjection', recordId);
    const rootId = requirePhaseFId(projection.root_id, 'ModelContextProjection.root_id');
    const barrier = await this.database.materializeContext(rootId);
    const structural = toWirePlain({
      projection,
      snapshotCommitSeq: barrier.snapshotCommitSeq,
      root: barrier.snapshot.root,
      records: barrier.snapshot.records.map((record) => ({
        node: record.node,
        segment: record.segment,
        contentObject: {
          id: record.contentObject.id,
          content_type: record.contentObject.content_type,
          sha256: record.contentObject.sha256,
          byte_length: record.contentObject.byte_length
        },
        messageRole: record.messageRole
      }))
    });
    return Buffer.from(JSON.stringify(structural), 'utf8');
  }

  private async resolveContentObjectId(kind: Exclude<ClientDetailKind, 'context-projection-detail'>, recordId: string): Promise<string> {
    switch (kind) {
      case 'message-content':
        return this.objectIdFromRow('MessageRevision', recordId, 'content_object_id');
      case 'tool-result-content': {
        const outcome = await this.maybeGet('ToolOutcome', recordId)
          ?? (await this.listRows('ToolOutcome', { tool_call_id: recordId }, 2))[0];
        if (!outcome) throw new Error(`Tool result ${recordId} does not exist.`);
        return requirePhaseFId(outcome.content_object_id, 'ToolOutcome.content_object_id');
      }
      case 'file-change-content':
        return this.objectIdFromRow('FileChangeSetMember', recordId, 'target_content_object_id');
      case 'process-output':
        return this.objectIdFromRow('ProcessOutputChunk', recordId, 'content_object_id');
      case 'answer-content': {
        const payload = await this.maybeGet('AnswerPayload', recordId)
          ?? (await this.listRows('AnswerPayload', { submission_id: recordId }, 2))[0];
        if (!payload) throw new Error(`Answer detail ${recordId} does not exist.`);
        return requirePhaseFId(payload.content_object_id, 'AnswerPayload.content_object_id');
      }
    }
  }

  private async objectIdFromRow(domain: string, id: string, field: string): Promise<string> {
    const row = await this.requireExisting(domain, id);
    return requirePhaseFId(row[field], `${domain}.${field}`);
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = barrier.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} detail lookup did not return rows.`);
    return rows;
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function detailRawByteLimit(requestedMaxBytes: number): number {
  // Base64 expands 4/3; reserve envelope space and enforce the actual encoded response below.
  return Math.min(
    requestedMaxBytes,
    Math.floor((CLIENT_DETAIL_MAX_RESPONSE_BYTES - 2048) * 3 / 4)
  );
}

function buildDetailChunk(
  recordId: string,
  offset: number,
  chunk: Buffer,
  totalBytes: number
): ClientDetailChunk {
  const nextOffsetValue = offset + chunk.length;
  const hasMore = nextOffsetValue < totalBytes;
  const response: ClientDetailChunk = {
    recordId,
    offset,
    chunk: chunk.toString('base64'),
    encoding: 'base64',
    ...(hasMore ? { nextOffset: nextOffsetValue } : {}),
    totalBytes,
    hasMore,
    responseBytes: 0
  };
  response.responseBytes = wireBytes(response);
  if (response.responseBytes > CLIENT_DETAIL_MAX_RESPONSE_BYTES) {
    throw new Error('Detail chunk exceeds maxResponseBytes after wire encoding.');
  }
  return response;
}

function boundProjectionRecords(projections: Record<string, PlainData>): Record<string, PlainData> {
  const visit = (value: PlainData, key = ''): PlainData => {
    if (Array.isArray(value)) {
      const limit = key === 'messages' ? CLIENT_MESSAGE_WINDOW_LIMIT : CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE;
      return value.slice(0, limit).map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) return boundRecord(entry);
        return visit(entry);
      });
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [nestedKey, visit(nested, nestedKey)]));
  };
  return visit(projections) as Record<string, PlainData>;
}

function boundRecord(recordInput: Record<string, PlainData>): Record<string, PlainData> {
  let record = structuredClone(recordInput);
  if (wireBytes(record) <= CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) return record;
  record = truncateStrings(record, 256) as Record<string, PlainData>;
  if (wireBytes(record) <= CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) return record;
  const essential = new Set(['id', 'status', 'state', 'phase', 'parent_handling_state']);
  const compact: Record<string, PlainData> = { summary_truncated: true };
  for (const [key, value] of Object.entries(record)) {
    if (essential.has(key) || key.endsWith('_id') || key.endsWith('_seq')) compact[key] = value;
  }
  if (wireBytes(compact) > CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) {
    throw new Error(`Client summary ${String(record.id ?? '<unknown>')} exceeds windowRecordSummaryMaxBytes.`);
  }
  return compact;
}

function enforceSnapshotBounds(message: ReliableKernelSnapshotMessage): void {
  let bytes = wireBytes(message);
  if (bytes <= CLIENT_SNAPSHOT_MAX_BYTES) return;
  const arrays: PlainData[][] = [];
  const collect = (value: PlainData): void => {
    if (Array.isArray(value)) {
      arrays.push(value);
      for (const entry of value) collect(entry);
    } else if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) collect(nested);
    }
  };
  collect(message.projections);
  while (bytes > CLIENT_SNAPSHOT_MAX_BYTES) {
    const target = arrays.filter((array) => array.length > 0).sort((left, right) => right.length - left.length)[0];
    if (!target) throw new Error('Client snapshot fixed envelope exceeds maxBytes.');
    target.shift();
    bytes = wireBytes(message);
  }
}

function truncateStrings(value: PlainData, maxLength: number): PlainData {
  if (typeof value === 'string') return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry, maxLength));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, truncateStrings(nested, maxLength)]));
}

function toWirePlain(value: unknown, ancestors = new WeakSet<object>()): PlainData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Client wire data contains a non-finite number.');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') throw new TypeError('Client wire data contains an unsupported value.');
  if (
    Buffer.isBuffer(value)
    || value instanceof Map
    || value instanceof Set
    || value instanceof Date
    || value instanceof RegExp
  ) throw new TypeError('Client wire data contains a forbidden non-plain value.');
  if (ancestors.has(value)) throw new TypeError('Client wire data contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => toWirePlain(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Client wire data contains a class instance.');
    }
    const result: Record<string, PlainData> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) result[key] = toWirePlain(nested, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

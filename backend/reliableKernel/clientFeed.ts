import { randomUUID } from 'node:crypto';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_CHANGE_TYPES,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  type ReliableKernelChangesMessage,
  type ReliableKernelClientChange,
  type ReliableKernelClientDetailKind,
  type ReliableKernelDataMessage,
  type ReliableKernelSnapshotMessage
} from '../../shared/reliableKernelClientFeed';
import type { PlainData } from '../../shared/plainData';
import { buildFileDiffRecord } from '../capabilities/fileDiff';
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
import type { RuntimeChange, RuntimeCommitResult } from './contracts';
import { requirePhaseFId, requirePhaseFText } from './phaseFIdentity';
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
  activeRecordIds: Set<string>;
  navigationConversationIds: Set<string>;
  newVisibleRecordsSinceSnapshot: number;
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
      activeRecordIds: new Set<string>(),
      navigationConversationIds: new Set<string>(),
      newVisibleRecordsSinceSnapshot: 0,
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
    const scoped = this.scopeCommit(session, commit);
    if (scoped.requiresSnapshot) {
      this.enterSnapshotRequired(session);
      return;
    }
    const message = this.createChangesMessage(session, { ...commit, changes: scoped.changes });
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
    this.resetVisibleIdentities(session, projections);
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

  private scopeCommit(
    session: ClientFeedSession,
    commit: RuntimeCommitResult
  ): { changes: RuntimeChange[]; requiresSnapshot: boolean } {
    const accepted: RuntimeChange[] = [];
    const pending: RuntimeChange[] = [];
    let requiresSnapshot = false;

    for (const change of commit.changes) {
      if (change.domain === 'Conversation') {
        accepted.push(change);
        if (change.kind === 'remove') {
          session.navigationConversationIds.delete(change.id);
        } else if (!session.navigationConversationIds.has(change.id)) {
          if (session.navigationConversationIds.size >= CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) requiresSnapshot = true;
          else session.navigationConversationIds.add(change.id);
        }
        continue;
      }
      if (change.kind === 'remove') {
        if (session.activeRecordIds.has(change.id)) accepted.push(change);
        session.activeRecordIds.delete(change.id);
        continue;
      }
      pending.push(change);
    }

    let changed = true;
    while (changed && pending.length > 0) {
      changed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const change = pending[index];
        const record = change.record;
        if (!record || !this.recordVisibleToSession(session, change.id, record)) continue;
        const wasKnown = session.activeRecordIds.has(change.id);
        accepted.push(change);
        pending.splice(index, 1);
        collectRecordIdentities(record, session.activeRecordIds);
        session.activeRecordIds.add(change.id);
        if (!wasKnown) session.newVisibleRecordsSinceSnapshot += 1;
        changed = true;
      }
    }

    if (session.newVisibleRecordsSinceSnapshot >= 100) requiresSnapshot = true;
    const acceptedIds = new Set(accepted.map((change) => `${change.domain}\0${change.id}\0${change.kind}`));
    return {
      changes: commit.changes.filter((change) => acceptedIds.has(`${change.domain}\0${change.id}\0${change.kind}`)),
      requiresSnapshot
    };
  }

  private recordVisibleToSession(
    session: ClientFeedSession,
    id: string,
    record: Record<string, unknown>
  ): boolean {
    if (session.activeRecordIds.has(id)) return true;
    const activeConversationId = session.activeConversationId;
    if (!activeConversationId) return false;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue;
      if (
        (key === 'conversation_id' || key === 'target_conversation_id' || key === 'child_conversation_id')
        && value === activeConversationId
      ) return true;
      if (isIdentityField(key) && session.activeRecordIds.has(value)) return true;
    }
    return false;
  }

  private resetVisibleIdentities(
    session: ClientFeedSession,
    projections: Record<string, PlainData>
  ): void {
    session.activeRecordIds.clear();
    session.navigationConversationIds.clear();
    session.newVisibleRecordsSinceSnapshot = 0;
    const navigation = projections.navigationSummary;
    if (isPlainRecord(navigation) && Array.isArray(navigation.conversations)) {
      for (const conversation of navigation.conversations) {
        if (!isPlainRecord(conversation)) continue;
        const id = conversation.id;
        if (typeof id === 'string' && id) session.navigationConversationIds.add(id);
      }
    }
    for (const [key, value] of Object.entries(projections)) {
      if (key === 'navigationSummary') continue;
      collectPlainIdentities(value, session.activeRecordIds);
    }
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

export type ClientDetailKind = ReliableKernelClientDetailKind;

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
    if (input.kind === 'context-projection-detail' || input.kind === 'file-change-diff') {
      const bytes = input.kind === 'context-projection-detail'
        ? await this.materializeContextProjectionDetail(recordId)
        : await this.materializeFileChangeDiff(recordId);
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

  private async materializeFileChangeDiff(recordId: string): Promise<Buffer> {
    const member = await this.requireExisting('FileChangeSetMember', recordId);
    const operation = requireFileChangeOperation(member.operation);
    const targetPath = requirePhaseFText(member.target_path, 'FileChangeSetMember.target_path');
    const baseContent = await this.readOptionalContent(member.base_content_object_id, 'FileChangeSetMember.base_content_object_id');
    const targetContent = await this.readOptionalContent(member.target_content_object_id, 'FileChangeSetMember.target_content_object_id');
    const before = decodeUtf8DiffContent(baseContent, 'base');
    const after = decodeUtf8DiffContent(targetContent, 'target');
    const diff = operation === 'create_directory' || operation === 'delete_directory_tree'
      ? undefined
      : buildFileDiffRecord(targetPath, before, after, operation !== 'create_file');
    return Buffer.from(JSON.stringify(toWirePlain({
      memberId: recordId,
      operation,
      path: targetPath,
      action: operation === 'create_file'
        ? 'created'
        : operation === 'delete_file' || operation === 'delete_directory_tree'
          ? 'deleted'
          : operation === 'create_directory'
            ? 'created-directory'
            : 'modified',
      ...(diff ? { diff } : {})
    })), 'utf8');
  }

  private async readOptionalContent(value: unknown, label: string): Promise<Buffer> {
    if (value === null) return Buffer.alloc(0);
    const metadata = await this.requireExisting('ContentObject', requirePhaseFId(value, label)) as ContentObjectMetadata;
    return this.contentStore.read(metadata);
  }

  private async resolveContentObjectId(
    kind: Exclude<ClientDetailKind, 'context-projection-detail' | 'file-change-diff'>,
    recordId: string
  ): Promise<string> {
    switch (kind) {
      case 'message-content':
        return this.objectIdFromRow('MessageRevision', recordId, 'content_object_id');
      case 'tool-arguments-content':
        return this.objectIdFromRow('ToolCall', recordId, 'arguments_object_id');
      case 'tool-result-content': {
        const outcome = await this.maybeGet('ToolOutcome', recordId)
          ?? (await this.listRows('ToolOutcome', { tool_call_id: recordId }, 2))[0];
        if (!outcome) throw new Error(`Tool result ${recordId} does not exist.`);
        return requirePhaseFId(outcome.content_object_id, 'ToolOutcome.content_object_id');
      }
      case 'file-change-base-content':
        return this.objectIdFromRow('FileChangeSetMember', recordId, 'base_content_object_id');
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

function requireFileChangeOperation(value: unknown): 'create_file' | 'replace_file' | 'delete_file' | 'create_directory' | 'delete_directory_tree' {
  if (!['create_file', 'replace_file', 'delete_file', 'create_directory', 'delete_directory_tree'].includes(String(value))) {
    throw new TypeError(`Unsupported FileChangeSetMember operation: ${String(value)}.`);
  }
  return value as 'create_file' | 'replace_file' | 'delete_file' | 'create_directory' | 'delete_directory_tree';
}

function decodeUtf8DiffContent(bytes: Buffer, role: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`File change ${role} content is not exact UTF-8 text and cannot be rendered as an inline Diff.`);
  }
  return text;
}

function isIdentityField(key: string): boolean {
  return key === 'id' || key.endsWith('_id');
}

function collectRecordIdentities(record: Record<string, unknown>, target: Set<string>): void {
  for (const [key, value] of Object.entries(record)) {
    if (isIdentityField(key) && typeof value === 'string' && value) target.add(value);
  }
}

function collectPlainIdentities(value: PlainData, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectPlainIdentities(entry, target);
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (isIdentityField(key) && typeof nested === 'string' && nested) target.add(nested);
    collectPlainIdentities(nested, target);
  }
}

function isPlainRecord(value: PlainData | undefined): value is { [key: string]: PlainData } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

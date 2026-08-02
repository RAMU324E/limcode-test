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
import {
  RUNTIME_DOMAIN_SCHEMA_BY_KEY,
  RUNTIME_DOMAIN_SCHEMA_BY_TABLE
} from './schema/domainManifest';

export interface ClientFeedSessionView {
  sessionId: string;
  hostBootId: string;
  nextMessageSeq: string;
  inflightMessageSeq: string | null;
  lastAckedCommitSeq: string | null;
  snapshotRequired: boolean;
  queuedBatches: number;
  queuedBytes: number;
  activeRecordKeyCount: number;
  materializedRecordCount: number;
  maxMaterializedRecordsPerType: number;
  latestMessageSeq: string;
  latestVisibleMessageFloor: string;
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
  snapshotRequestGeneration: number;
  queue: QueuedDataMessage[];
  queuedBytes: number;
  send(message: ReliableKernelDataMessage): void;
  onFailure?: (error: unknown) => void;
  unsubscribe: (() => void) | null;
  initializing: boolean;
  refreshing: boolean;
  collectingRefresh: boolean;
  handoffCommits: RuntimeCommitResult[];
  /** Typed (domain,id) identities reachable from the active conversation projection. */
  activeRecordKeys: Set<string>;
  activeRecordKeyRefCounts: Map<string, number>;
  materializedRecordKeys: Set<string>;
  materializedRecordReferences: Map<string, Set<string>>;
  materializedRecordTemporal: Map<string, string>;
  activeRecordCounts: Map<string, number>;
  latestMessageSeq: bigint;
  latestVisibleMessageFloor: bigint;
  messageDisplayFloors: Map<string, bigint>;
  navigationConversationIds: Set<string>;
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
  private readonly sharedSnapshotReads = new Map<string, Promise<Awaited<ReturnType<RuntimeDatabase['clientProjectionSnapshot']>>>>();
  private externalDataVersion: string | null = null;
  private externalPollTimer: NodeJS.Timeout | null = null;
  private externalPollInitialization: Promise<void> | null = null;
  private externalPollInFlight = false;

  public constructor(private readonly database: RuntimeDatabase) {
    if (CLIENT_MAX_INFLIGHT_DATA_MESSAGES !== 1) {
      throw new Error('BoundedClientFeed implementation requires maxInflightDataMessages=1.');
    }
  }

  public async connect(input: {
    activeConversationId?: string | null;
    send(message: ReliableKernelDataMessage): void;
    /** Called after an already-connected asynchronous feed session becomes unusable. */
    onFailure?(error: unknown): void;
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
      snapshotRequestGeneration: 0,
      queue: [],
      queuedBytes: 0,
      send: input.send,
      onFailure: input.onFailure,
      unsubscribe: null,
      initializing: true,
      refreshing: false,
      collectingRefresh: false,
      handoffCommits: [],
      activeRecordKeys: new Set<string>(),
      activeRecordKeyRefCounts: new Map<string, number>(),
      materializedRecordKeys: new Set<string>(),
      materializedRecordReferences: new Map<string, Set<string>>(),
      materializedRecordTemporal: new Map<string, string>(),
      activeRecordCounts: new Map<string, number>(),
      latestMessageSeq: 0n,
      latestVisibleMessageFloor: 0n,
      messageDisplayFloors: new Map<string, bigint>(),
      navigationConversationIds: new Set<string>(),
      closed: false
    };
    this.sessions.set(session.sessionId, session);
    try {
      // Establish the external-writer baseline before the initial snapshot. A commit racing after
      // this read is consequently discovered by the poller and cannot fall through the handoff.
      await this.ensureExternalCommitPolling();
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
      this.stopExternalCommitPollingIfIdle();
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
    this.stopExternalCommitPollingIfIdle();
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
      queuedBytes: session.queuedBytes,
      activeRecordKeyCount: session.activeRecordKeys.size,
      materializedRecordCount: session.materializedRecordKeys.size,
      maxMaterializedRecordsPerType: Math.max(0, ...session.activeRecordCounts.values()),
      latestMessageSeq: session.latestMessageSeq.toString(),
      latestVisibleMessageFloor: session.latestVisibleMessageFloor.toString()
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
    // Database commitSeq is intentionally allowed to jump on the wire. Commits with no visible
    // records must not consume the one-inflight ACK channel or invalidate the Webview projection.
    if (scoped.changes.length === 0) return;
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
    session.snapshotRequestGeneration += 1;
    if (!session.inflight && !session.refreshing && !session.initializing) {
      void this.refreshSnapshot(session).catch((error) => this.closeFailedSession(session, error));
    }
  }

  private async refreshSnapshot(session: ClientFeedSession): Promise<void> {
    if (session.closed || session.refreshing || session.inflight) return;
    session.refreshing = true;
    session.collectingRefresh = true;
    session.handoffCommits = [];
    const refreshRequestGeneration = session.snapshotRequestGeneration;
    try {
      const barrier = await this.sharedProjectionSnapshot(session.activeConversationId);
      const visible = BigInt(barrier.snapshotCommitSeq);
      const buffered = session.handoffCommits.filter((commit) => BigInt(commit.commitSeq) > visible);
      session.handoffCommits = [];
      session.collectingRefresh = false;
      // An external commit may arrive while the read transaction is materializing this snapshot.
      // Preserve that later request so the ACK of this snapshot schedules one more refresh.
      session.snapshotRequired = session.snapshotRequestGeneration !== refreshRequestGeneration;
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
    // Seed visibility from exactly what survived all byte/row bounds. Seeding before final
    // truncation leaves ghost identities that can admit unrelated incremental records.
    this.resetVisibleIdentities(session, message.projections);
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
    const evictions: RuntimeChange[] = [];
    const pending: RuntimeChange[] = [];
    let requiresSnapshot = false;

    for (const change of commit.changes) {
      // These persisted facts retain their current-epoch detail/none client mappings. The database
      // worker emits only the derived ConversationContextStatus view for head mutations.
      if (
        change.domain === 'ContextSequenceRoot'
        || change.domain === 'ConversationContextHeadLink'
        || change.domain === 'ProcessOutputChunk'
      ) {
        continue;
      }
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
        const key = recordKey(change.domain, change.id);
        if (change.domain === 'Message') requiresSnapshot = true;
        // Removing the independent relationship changes ProjectContext reachability; a bounded
        // snapshot atomically removes the now-unreferenced context instead of retaining an orphan.
        if (change.domain === 'ConversationProjectLink' && session.materializedRecordKeys.has(key)) {
          requiresSnapshot = true;
        }
        if (session.materializedRecordKeys.has(key)) {
          accepted.push(change);
          decrementRecordCount(session.activeRecordCounts, change.domain);
          releaseMaterializedRecordReferences(session, key);
        }
        forgetMessageDisplayFloor(session, key);
        session.materializedRecordKeys.delete(key);
        session.materializedRecordTemporal.delete(key);
        continue;
      }
      pending.push(change);
    }

    let changed = true;
    while (changed && pending.length > 0) {
      changed = false;
      for (let index = 0; index < pending.length;) {
        const change = pending[index];
        let record = change.record;
        if (!record || !this.recordVisibleToSession(session, change.domain, change.id, record)) {
          index += 1;
          continue;
        }
        let acceptedChange = change;
        if (change.domain === 'Message') {
          const projected = attachMessageDisplayFloor(session, change.id, record);
          if (!projected) {
            requiresSnapshot = true;
            pending.splice(index, 1);
            changed = true;
            continue;
          }
          record = projected;
          acceptedChange = { ...change, record };
        }
        const ownKey = recordKey(change.domain, change.id);
        const wasKnown = session.materializedRecordKeys.has(ownKey);
        accepted.push(acceptedChange);
        pending.splice(index, 1);
        if (wasKnown) releaseMaterializedRecordReferences(session, ownKey);
        session.materializedRecordKeys.add(ownKey);
        session.materializedRecordTemporal.set(ownKey, recordTemporalKey(change.domain, record, change.id));
        retainMaterializedRecordReferences(session, change.domain, change.id, record);
        if (!wasKnown) {
          const count = incrementRecordCount(session.activeRecordCounts, change.domain);
          if (count > CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) {
            if (change.domain === 'ModelRequest' || change.domain === 'ModelRequestMessageLink') {
              // Their bounded window is a causal request↔message bundle. Re-read it atomically
              // instead of independently evicting one side by an opaque id.
              requiresSnapshot = true;
            }
            const victim = oldestMaterializedRecord(session, change.domain);
            if (!victim) requiresSnapshot = true;
            else {
              releaseMaterializedRecordReferences(session, victim);
              forgetMessageDisplayFloor(session, victim);
              session.materializedRecordKeys.delete(victim);
              session.materializedRecordTemporal.delete(victim);
              decrementRecordCount(session.activeRecordCounts, change.domain);
              evictions.push({ domain: change.domain, kind: 'remove', id: recordIdFromKey(victim) });
            }
          }
        }
        changed = true;
      }
    }

    const acceptedById = new Map(accepted.map((change) => [
      `${change.domain}\0${change.id}\0${change.kind}`,
      change
    ]));
    return {
      changes: [
        ...commit.changes.flatMap((change) => {
          const acceptedChange = acceptedById.get(`${change.domain}\0${change.id}\0${change.kind}`);
          return acceptedChange ? [acceptedChange] : [];
        }),
        ...evictions
      ],
      requiresSnapshot
    };
  }

  private recordVisibleToSession(
    session: ClientFeedSession,
    domain: string,
    id: string,
    record: Record<string, unknown>
  ): boolean {
    if (session.activeRecordKeys.has(recordKey(domain, id))) return true;
    const activeConversationId = session.activeConversationId;
    if (!activeConversationId) return false;
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== 'string') continue;
      if (CONVERSATION_REFERENCE_FIELDS.has(key) && value === activeConversationId) return true;
      const targetDomain = referenceDomain(domain, key);
      if (targetDomain && session.activeRecordKeys.has(recordKey(targetDomain, value))) return true;
    }
    return false;
  }

  private resetVisibleIdentities(
    session: ClientFeedSession,
    projections: Record<string, PlainData>
  ): void {
    session.activeRecordKeys.clear();
    session.activeRecordKeyRefCounts.clear();
    session.materializedRecordKeys.clear();
    session.materializedRecordReferences.clear();
    session.materializedRecordTemporal.clear();
    session.activeRecordCounts.clear();
    session.latestMessageSeq = 0n;
    session.latestVisibleMessageFloor = 0n;
    session.messageDisplayFloors.clear();
    session.navigationConversationIds.clear();
    const navigation = projections.navigationSummary;
    if (isPlainRecord(navigation) && Array.isArray(navigation.conversations)) {
      for (const conversation of navigation.conversations) {
        if (!isPlainRecord(conversation)) continue;
        const id = conversation.id;
        if (typeof id === 'string' && id) session.navigationConversationIds.add(id);
      }
    }
    const countedRecords = new Set<string>();
    for (const [key, value] of Object.entries(projections)) {
      if (key === 'navigationSummary') continue;
      collectProjectionRecordKeys(
        value,
        session.activeRecordKeys,
        session.activeRecordKeyRefCounts,
        session.materializedRecordReferences,
        session.activeRecordCounts,
        countedRecords,
        session.materializedRecordTemporal
      );
    }
    for (const key of countedRecords) session.materializedRecordKeys.add(key);
    const activeWindow = projections.activeConversationWindow;
    if (isPlainRecord(activeWindow)) {
      session.latestMessageSeq = plainNonNegativeBigInt(activeWindow.lastMessageSeq);
      session.latestVisibleMessageFloor = plainNonNegativeBigInt(activeWindow.visibleMessageCount);
      if (Array.isArray(activeWindow.messages)) {
        for (const message of activeWindow.messages) {
          if (!isPlainRecord(message) || typeof message.id !== 'string') continue;
          const displayFloor = plainNonNegativeBigInt(message.display_seq);
          if (displayFloor > 0n) session.messageDisplayFloors.set(message.id, displayFloor);
        }
      }
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
    if (session.closed) return;
    this.disconnect(session.sessionId);
    // An asynchronous refresh cannot reject the already-resolved connect() promise. Notify its
    // bridge explicitly after closing the unusable session so the bridge can enter its bounded
    // reconnect loop instead of retaining a dead session forever.
    console.error(`[LimCode] Bounded client feed session ${session.sessionId} closed after failure.`, error);
    try {
      session.onFailure?.(error);
    } catch (notificationError) {
      console.error(`[LimCode] Bounded client feed failure notification for ${session.sessionId} failed.`, notificationError);
    }
  }

  private sharedProjectionSnapshot(
    activeConversationId: string | null
  ): Promise<Awaited<ReturnType<RuntimeDatabase['clientProjectionSnapshot']>>> {
    const key = activeConversationId ?? '\0navigation-only';
    const existing = this.sharedSnapshotReads.get(key);
    if (existing) return existing;
    const read = this.database.clientProjectionSnapshot(activeConversationId);
    this.sharedSnapshotReads.set(key, read);
    void read.finally(() => {
      if (this.sharedSnapshotReads.get(key) === read) this.sharedSnapshotReads.delete(key);
    }).catch(() => undefined);
    return read;
  }

  private async ensureExternalCommitPolling(): Promise<void> {
    if (this.externalPollTimer) return;
    if (!this.externalPollInitialization) {
      this.externalPollInitialization = (async () => {
        this.externalDataVersion = await this.database.externalDataVersion();
        if (this.sessions.size === 0 || this.externalPollTimer) return;
        this.externalPollTimer = setInterval(() => {
          void this.pollExternalCommits();
        }, 1_000);
        this.externalPollTimer.unref();
      })().finally(() => {
        this.externalPollInitialization = null;
      });
    }
    await this.externalPollInitialization;
  }

  private async pollExternalCommits(): Promise<void> {
    if (this.externalPollInFlight || this.sessions.size === 0) return;
    this.externalPollInFlight = true;
    try {
      const nextVersion = await this.database.externalDataVersion();
      if (this.externalDataVersion === null) {
        this.externalDataVersion = nextVersion;
        return;
      }
      if (nextVersion === this.externalDataVersion) return;
      this.externalDataVersion = nextVersion;
      for (const session of this.sessions.values()) this.enterSnapshotRequired(session);
    } catch (error) {
      for (const session of [...this.sessions.values()]) this.closeFailedSession(session, error);
    } finally {
      this.externalPollInFlight = false;
    }
  }

  private stopExternalCommitPollingIfIdle(): void {
    if (this.sessions.size > 0) return;
    if (this.externalPollTimer) clearInterval(this.externalPollTimer);
    this.externalPollTimer = null;
    this.externalDataVersion = null;
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

interface ProcessStreamChunkIndexEntry {
  row: DomainRow;
  offset: number;
  byteLength: number;
}

interface ProcessOutputDetailIndex {
  retainedBytes: string;
  retainedChunks: string;
  stdout: ProcessStreamChunkIndexEntry[];
  stderr: ProcessStreamChunkIndexEntry[];
  stdoutBytes: number;
  stderrBytes: number;
  lastAccessedAt: number;
}

interface ProcessDetailReconciliation {
  retainedBytes: string;
  retainedChunks: string;
  stdout: Buffer;
  stderr: Buffer;
}

const PROCESS_DETAIL_INDEX_CACHE_ENTRIES = 8;

/** On-demand CAS detail reader with an actual wire-byte response cap. */
export class ClientDetailReader {
  /** Rebuildable chunk metadata only; output bytes remain in CAS and are read one requested page at a time. */
  private readonly processOutputIndexes = new Map<string, ProcessOutputDetailIndex>();
  private readonly processOutputReconciliations = new Map<string, Promise<ProcessDetailReconciliation>>();
  private reconcileProcessOutput: ((processId: string) => Promise<ProcessDetailReconciliation>) | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore
  ) {}

  /** Product composition supplies the verified spool importer after ProcessControlPlane exists. */
  public setProcessOutputReconciler(
    reconcile: (processId: string) => Promise<ProcessDetailReconciliation>
  ): void {
    this.reconcileProcessOutput = reconcile;
  }

  public async read(input: {
    kind: ClientDetailKind;
    recordId: string;
    offset: number;
    maxBytes: number;
    expectedTotalBytes?: number;
    /** Webview transport scope. Undefined is reserved for trusted in-process callers. */
    conversationId?: string | null;
  }): Promise<ClientDetailChunk> {
    const recordId = requirePhaseFId(input.recordId, 'recordId');
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new RangeError('Detail offset must be non-negative.');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new RangeError('Detail maxBytes must be positive.');
    const maxRawBytes = detailRawByteLimit(input.maxBytes);
    if (input.kind === 'process-stdout' || input.kind === 'process-stderr') {
      return this.readProcessStreamDetail(
        recordId,
        input.kind === 'process-stdout' ? 'stdout' : 'stderr',
        input.offset,
        maxRawBytes,
        input.conversationId,
        input.expectedTotalBytes
      );
    }
    if (input.kind === 'context-projection-detail' || input.kind === 'file-change-diff') {
      const bytes = input.kind === 'context-projection-detail'
        ? await this.materializeContextProjectionDetail(recordId)
        : await this.materializeFileChangeDiff(recordId);
      if (input.offset > bytes.length) throw new RangeError('Detail offset exceeds structural payload length.');
      const end = Math.min(bytes.length, input.offset + maxRawBytes);
      return buildDetailChunk(recordId, input.offset, bytes.subarray(input.offset, end), bytes.length);
    }
    const contentObjectId = await this.resolveContentObjectId(
      input.kind,
      recordId,
      input.conversationId
    );
    const contentRow = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    const range = await this.contentStore.readChunk(contentRow, input.offset, maxRawBytes);
    return buildDetailChunk(recordId, input.offset, range.chunk, range.totalBytes);
  }

  private async readProcessStreamDetail(
    processId: string,
    streamKind: 'stdout' | 'stderr',
    offset: number,
    maxRawBytes: number,
    conversationId?: string | null,
    expectedTotalBytes?: number
  ): Promise<ClientDetailChunk> {
    if (conversationId !== undefined) await this.assertProcessVisible(processId, conversationId);
    // A new demand/refresh captures one verified CAS/live pairing. Continuation pages only need a
    // new pairing while their frozen prefix still extends beyond the now-durable CAS frontier.
    let liveSnapshot = expectedTotalBytes === undefined
      ? await this.reconcileProcessOutputForDetail(processId)
      : undefined;
    let index: ProcessOutputDetailIndex;
    for (;;) {
      const processRow = await this.requireExisting('Process', processId);
      index = await this.processOutputIndex(processId, processRow);
      const durableBytes = streamKind === 'stdout' ? index.stdoutBytes : index.stderrBytes;
      if (expectedTotalBytes !== undefined && expectedTotalBytes <= durableBytes) {
        liveSnapshot = undefined;
        break;
      }
      if (!liveSnapshot) {
        liveSnapshot = await this.reconcileProcessOutputForDetail(processId);
        continue;
      }
      if (
        liveSnapshot.retainedBytes !== index.retainedBytes
        || liveSnapshot.retainedChunks !== index.retainedChunks
      ) {
        liveSnapshot = await this.reconcileProcessOutputForDetail(processId);
        continue;
      }
      break;
    }
    const durableBytes = streamKind === 'stdout' ? index.stdoutBytes : index.stderrBytes;
    const liveBytes = liveSnapshot?.[streamKind] ?? Buffer.alloc(0);
    const currentTotalBytes = durableBytes + liveBytes.byteLength;
    if (!Number.isSafeInteger(currentTotalBytes)) {
      throw new RangeError('Process stream length exceeds the pageable detail protocol integer range.');
    }
    const renderableTotalBytes = expectedTotalBytes ?? currentTotalBytes - incompleteUtf8TailLength(
      await this.readProcessStreamRange(
        processId,
        index[streamKind],
        durableBytes,
        liveBytes,
        Math.max(0, currentTotalBytes - 4),
        Math.min(4, currentTotalBytes)
      )
    );
    if (
      !Number.isSafeInteger(renderableTotalBytes)
      || renderableTotalBytes < 0
      || renderableTotalBytes > currentTotalBytes
    ) throw new RangeError('Frozen process detail prefix is outside the verified stream.');
    const totalBytes = renderableTotalBytes;
    if (offset > totalBytes) throw new RangeError('Detail offset exceeds process stream length.');
    const bytes = await this.readProcessStreamRange(
      processId,
      index[streamKind],
      durableBytes,
      liveBytes,
      offset,
      Math.min(maxRawBytes, totalBytes - offset)
    );
    return buildDetailChunk(processId, offset, bytes, totalBytes);
  }

  private async readProcessStreamRange(
    processId: string,
    entries: readonly ProcessStreamChunkIndexEntry[],
    durableBytes: number,
    liveBytes: Buffer,
    offset: number,
    byteLength: number
  ): Promise<Buffer> {
    let cursor = offset;
    let remaining = byteLength;
    const parts: Buffer[] = [];
    let chunkIndex = firstChunkEndingAfter(entries, cursor);
    while (remaining > 0 && cursor < durableBytes && chunkIndex < entries.length) {
      const entry = entries[chunkIndex++]!;
      const localOffset = Math.max(0, cursor - entry.offset);
      const take = Math.min(entry.byteLength - localOffset, durableBytes - cursor, remaining);
      const metadata = await this.requireExisting(
        'ContentObject',
        requirePhaseFId(entry.row.content_object_id, 'ProcessOutputChunk.content_object_id')
      ) as ContentObjectMetadata;
      const range = await this.contentStore.readChunk(metadata, localOffset, take);
      if (range.totalBytes !== entry.byteLength || range.chunk.byteLength !== take) {
        throw new Error(`ProcessOutputChunk ${String(entry.row.id)} CAS range is incomplete.`);
      }
      parts.push(range.chunk);
      cursor += take;
      remaining -= take;
    }
    if (remaining > 0) {
      const liveOffset = cursor - durableBytes;
      const take = Math.min(Math.max(0, liveBytes.byteLength - liveOffset), remaining);
      if (take > 0) {
        parts.push(liveBytes.subarray(liveOffset, liveOffset + take));
        cursor += take;
        remaining -= take;
      }
    }
    if (remaining !== 0) {
      throw new Error(`Process ${processId} stream snapshot is not continuous.`);
    }
    return Buffer.concat(parts, byteLength);
  }

  private reconcileProcessOutputForDetail(processId: string): Promise<ProcessDetailReconciliation> {
    if (!this.reconcileProcessOutput) {
      throw new Error('Process detail reader is not connected to ProcessControlPlane.');
    }
    const existing = this.processOutputReconciliations.get(processId);
    if (existing) return existing;
    const task = Promise.resolve(this.reconcileProcessOutput(processId))
      .finally(() => {
        if (this.processOutputReconciliations.get(processId) === task) {
          this.processOutputReconciliations.delete(processId);
        }
      });
    this.processOutputReconciliations.set(processId, task);
    return task;
  }

  private async processOutputIndex(processId: string, processRow: DomainRow): Promise<ProcessOutputDetailIndex> {
    const retainedChunks = requireRuntimeNonNegativeBigInt(processRow.retained_chunks, 'Process.retained_chunks');
    const retainedBytes = requireRuntimeNonNegativeBigInt(processRow.retained_bytes, 'Process.retained_bytes');
    const cached = this.processOutputIndexes.get(processId);
    if (
      cached
      && cached.retainedChunks === retainedChunks.toString()
      && cached.retainedBytes === retainedBytes.toString()
    ) {
      cached.lastAccessedAt = Date.now();
      return cached;
    }
    const chunks = await this.database.snapshotAll(DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').list({
      where: { process_id: processId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1_000
    }));
    // Reconciliation publishes chunk rows in bounded transactions and advances Process counters as
    // its final fence. Rows beyond that fence belong to a later prefix and are not visible yet.
    const retainedChunkCount = runtimeNonNegativeSafeInteger(retainedChunks, 'Process.retained_chunks');
    const allRows = chunks.snapshot
      .sort((left, right) => compareRuntimeIntegers(left.chunk_seq, right.chunk_seq))
      .slice(0, retainedChunkCount);
    let allBytes = 0n;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: ProcessStreamChunkIndexEntry[] = [];
    const stderr: ProcessStreamChunkIndexEntry[] = [];
    for (let rowIndex = 0; rowIndex < allRows.length; rowIndex += 1) {
      const row = allRows[rowIndex]!;
      if (requireRuntimeNonNegativeBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq') !== BigInt(rowIndex + 1)) {
        throw new Error(`Process ${processId} output chunk sequence is not contiguous.`);
      }
      const byteLength = runtimeNonNegativeSafeInteger(row.byte_length, 'ProcessOutputChunk.byte_length');
      allBytes += BigInt(byteLength);
      if (row.stream_kind === 'stdout') {
        stdout.push({ row, offset: stdoutBytes, byteLength });
        stdoutBytes += byteLength;
      } else if (row.stream_kind === 'stderr') {
        stderr.push({ row, offset: stderrBytes, byteLength });
        stderrBytes += byteLength;
      } else {
        throw new Error(`ProcessOutputChunk ${String(row.id)} has an invalid stream kind.`);
      }
      if (!Number.isSafeInteger(stdoutBytes) || !Number.isSafeInteger(stderrBytes)) {
        throw new Error(`Process ${processId} stream length exceeds the pageable detail protocol integer range.`);
      }
    }
    if (allRows.length !== retainedChunkCount || allBytes !== retainedBytes) {
      throw new Error(`Process ${processId} output CAS materialization is not complete yet.`);
    }
    const built: ProcessOutputDetailIndex = {
      retainedBytes: retainedBytes.toString(),
      retainedChunks: retainedChunks.toString(),
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      lastAccessedAt: Date.now()
    };
    this.processOutputIndexes.delete(processId);
    this.processOutputIndexes.set(processId, built);
    if (this.processOutputIndexes.size > PROCESS_DETAIL_INDEX_CACHE_ENTRIES) {
      const oldest = [...this.processOutputIndexes.entries()]
        .filter(([candidateId]) => candidateId !== processId)
        .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt || left[0].localeCompare(right[0]))[0];
      if (oldest) this.processOutputIndexes.delete(oldest[0]);
    }
    return built;
  }

  private async assertProcessVisible(processId: string, conversationId: string | null): Promise<void> {
    const scopedConversationId = conversationId === null
      ? null
      : requirePhaseFId(conversationId, 'detail.conversationId');
    if (!scopedConversationId) throw new Error(`Process ${processId} is not visible without an active Conversation.`);
    const origins = await this.listRows('ProcessOriginLink', { process_id: processId }, 2);
    if (origins.length !== 1) throw new Error(`Process ${processId} does not have one visible origin.`);
    const call = await this.requireExisting(
      'ToolCall',
      requirePhaseFId(origins[0]!.tool_call_id, 'ProcessOriginLink.tool_call_id')
    );
    const turn = await this.requireExisting('Turn', requirePhaseFId(call.turn_id, 'ToolCall.turn_id'));
    if (turn.conversation_id !== scopedConversationId) {
      throw new Error(`Process ${processId} is not visible in the active Conversation.`);
    }
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
    kind: Exclude<
      ClientDetailKind,
      'context-projection-detail' | 'file-change-diff' | 'process-stdout' | 'process-stderr'
    >,
    recordId: string,
    conversationId?: string | null
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
      case 'tool-event-content':
        return this.objectIdFromRow('ToolCallEvent', recordId, 'content_object_id');
      case 'interaction-prompt':
        return this.objectIdFromRow('InteractionRequest', recordId, 'prompt_object_id');
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
      case 'compression-content':
        return this.compressionObjectId(recordId, 'summary_object_id', conversationId);
      case 'compression-title':
        return this.compressionObjectId(recordId, 'title_object_id', conversationId);
    }
  }

  private async compressionObjectId(
    recordId: string,
    field: 'summary_object_id' | 'title_object_id',
    conversationId?: string | null
  ): Promise<string> {
    const block = await this.requireExisting('CompressionBlock', recordId);
    if (conversationId !== undefined) {
      const scopedConversationId = conversationId === null
        ? null
        : requirePhaseFId(conversationId, 'detail.conversationId');
      if (!scopedConversationId || block.conversation_id !== scopedConversationId) {
        throw new Error(`CompressionBlock ${recordId} is not visible in the active Conversation.`);
      }
    }
    return requirePhaseFId(block[field], `CompressionBlock.${field}`);
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

const CONVERSATION_REFERENCE_FIELDS = new Set([
  'conversation_id',
  'target_conversation_id',
  'child_conversation_id'
]);

/** Text links which are intentionally not SQLite foreign keys still need an explicit type. */
const EXPLICIT_REFERENCE_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  conversation_id: 'Conversation',
  target_conversation_id: 'Conversation',
  source_conversation_id: 'Conversation',
  child_conversation_id: 'Conversation',
  project_context_id: 'ProjectContext',
  turn_id: 'Turn',
  target_turn_id: 'Turn',
  parent_turn_id: 'Turn',
  source_turn_id: 'Turn',
  message_id: 'Message',
  revision_id: 'MessageRevision',
  message_revision_id: 'MessageRevision',
  source_message_revision_id: 'MessageRevision',
  tool_call_id: 'ToolCall',
  source_tool_call_id: 'ToolCall',
  model_request_id: 'ModelRequest',
  request_id: 'InteractionRequest',
  process_id: 'Process',
  change_set_id: 'FileChangeSet',
  child_execution_id: 'ChildExecution',
  parent_child_execution_id: 'ChildExecution',
  answer_bridge_id: 'AnswerBridge',
  current_submission_id: 'AnswerSubmission',
  submission_id: 'AnswerSubmission',
  inbox_item_id: 'RuntimeInboxItem',
  delivery_id: 'RuntimeDelivery',
  retry_of_delivery_id: 'RuntimeDelivery',
  root_id: 'ContextSequenceRoot'
});

const CLIENT_PROJECTION_ARRAY_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  messages: 'Message',
  projectContexts: 'ProjectContext',
  conversationProjectLinks: 'ConversationProjectLink',
  conversationReuseLinks: 'ConversationReuseLink',
  conversationBranchLinks: 'ConversationBranchLink',
  conversationOriginLinks: 'ConversationOriginLink',
  agentConversationLinks: 'AgentConversationLink',
  compressionBlocks: 'CompressionBlock',
  conversationContextStatuses: 'ConversationContextStatus',
  turns: 'Turn',
  executionLeases: 'ExecutionLease',
  turnTerminations: 'TurnTermination',
  turnExecutorLinks: 'TurnExecutorLink',
  modelRequests: 'ModelRequest',
  modelRequestMessageLinks: 'ModelRequestMessageLink',
  messageTurnLinks: 'MessageTurnLink',
  toolCalls: 'ToolCall',
  toolCallSourceLinks: 'ToolCallSourceLink',
  toolCallPolicySnapshots: 'ToolCallPolicySnapshot',
  toolCallEvents: 'ToolCallEvent',
  toolExecutions: 'ToolExecution',
  toolOutcomes: 'ToolOutcome',
  toolModelResults: 'ToolModelResult',
  toolResultArtifacts: 'ToolResultArtifact',
  interactionRequests: 'InteractionRequest',
  interactionOwnerLinks: 'InteractionOwnerLink',
  interactionToolCallLinks: 'InteractionToolCallLink',
  interactionResponses: 'InteractionResponse',
  fileChangeSets: 'FileChangeSet',
  fileChangeSetMembers: 'FileChangeSetMember',
  fileChangeDecisions: 'FileChangeDecision',
  fileMutationReceipts: 'FileMutationReceipt',
  fileMutationReceiptMembers: 'FileMutationReceiptMember',
  processes: 'Process',
  processOriginLinks: 'ProcessOriginLink',
  processOutputChunks: 'ProcessOutputChunk',
  processReceipts: 'ProcessReceipt',
  childExecutions: 'ChildExecution',
  childExecutionParentLinks: 'ChildExecutionParentLink',
  childExecutionTurnLinks: 'ChildExecutionTurnLink',
  childExecutionActiveTurnLinks: 'ChildExecutionActiveTurnLink',
  childTurns: 'Turn',
  childExecutionLeases: 'ExecutionLease',
  childTurnTerminations: 'TurnTermination',
  childTurnExecutorLinks: 'TurnExecutorLink',
  answerBridges: 'AnswerBridge',
  answerSubmissions: 'AnswerSubmission',
  runtimeInboxItems: 'RuntimeInboxItem',
  runtimeDeliveries: 'RuntimeDelivery'
});

function recordKey(domain: string, id: string): string {
  return `${domain}\0${id}`;
}

function referenceDomain(domain: string, field: string): string | undefined {
  const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain);
  const column = schema?.columns.find((candidate) => candidate.name === field);
  if (column?.references) return RUNTIME_DOMAIN_SCHEMA_BY_TABLE.get(column.references.table)?.key;
  return EXPLICIT_REFERENCE_DOMAINS[field];
}

function typedRecordReferenceKeys(
  domain: string,
  record: Record<string, unknown>
): Set<string> {
  const references = new Set<string>();
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || !value) continue;
    const targetDomain = referenceDomain(domain, field);
    if (targetDomain) references.add(recordKey(targetDomain, value));
  }
  return references;
}

function retainMaterializedRecordReferences(
  session: ClientFeedSession,
  domain: string,
  id: string,
  record: Record<string, unknown>
): void {
  const ownKey = recordKey(domain, id);
  const references = typedRecordReferenceKeys(domain, record);
  references.add(ownKey);
  session.materializedRecordReferences.set(ownKey, references);
  for (const reference of references) retainActiveRecordKey(session, reference);
}

function releaseMaterializedRecordReferences(session: ClientFeedSession, ownKey: string): void {
  const references = session.materializedRecordReferences.get(ownKey);
  if (!references) return;
  session.materializedRecordReferences.delete(ownKey);
  for (const reference of references) releaseActiveRecordKey(session, reference);
}

function retainActiveRecordKey(session: ClientFeedSession, key: string): void {
  const next = (session.activeRecordKeyRefCounts.get(key) ?? 0) + 1;
  session.activeRecordKeyRefCounts.set(key, next);
  session.activeRecordKeys.add(key);
}

function releaseActiveRecordKey(session: ClientFeedSession, key: string): void {
  const next = Math.max(0, (session.activeRecordKeyRefCounts.get(key) ?? 0) - 1);
  if (next === 0) {
    session.activeRecordKeyRefCounts.delete(key);
    session.activeRecordKeys.delete(key);
  } else {
    session.activeRecordKeyRefCounts.set(key, next);
  }
}

function attachMessageDisplayFloor(
  session: ClientFeedSession,
  messageId: string,
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const rawSequence = runtimeNonNegativeBigInt(record.message_seq);
  if (rawSequence === undefined || rawSequence === 0n) return undefined;
  const visible = record.deleted_at === null || record.deleted_at === undefined
    ? record.role === 'user' || record.role === 'model'
    : false;
  const existingFloor = session.messageDisplayFloors.get(messageId);
  if (existingFloor !== undefined) {
    if (!visible) return undefined;
    return { ...record, display_seq: existingFloor };
  }
  if (rawSequence <= session.latestMessageSeq) {
    // An update to an evicted/historical visible message can change every later display rank. A
    // bounded snapshot recomputes that rank atomically; hidden tool messages need no floor.
    return visible ? undefined : record;
  }
  session.latestMessageSeq = rawSequence;
  if (!visible) return record;
  session.latestVisibleMessageFloor += 1n;
  session.messageDisplayFloors.set(messageId, session.latestVisibleMessageFloor);
  return { ...record, display_seq: session.latestVisibleMessageFloor };
}

function forgetMessageDisplayFloor(session: ClientFeedSession, typedKey: string): void {
  if (!typedKey.startsWith('Message\0')) return;
  session.messageDisplayFloors.delete(recordIdFromKey(typedKey));
}

function runtimeNonNegativeBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return undefined;
}

function plainNonNegativeBigInt(value: PlainData | undefined): bigint {
  const parsed = runtimeNonNegativeBigInt(value);
  return parsed ?? 0n;
}

function collectProjectionRecordKeys(
  value: PlainData,
  target: Set<string>,
  refCounts: Map<string, number>,
  referencesByRecord: Map<string, Set<string>>,
  counts: Map<string, number>,
  countedRecords: Set<string>,
  temporal: Map<string, string>
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProjectionRecordKeys(entry, target, refCounts, referencesByRecord, counts, countedRecords, temporal);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const domain = CLIENT_PROJECTION_ARRAY_DOMAINS[key];
    if (domain && Array.isArray(nested)) {
      for (const entry of nested) {
        if (!isPlainRecord(entry)) continue;
        const id = entry.id;
        if (typeof id !== 'string' || !id) continue;
        const ownKey = recordKey(domain, id);
        if (!countedRecords.has(ownKey)) {
          countedRecords.add(ownKey);
          incrementRecordCount(counts, domain);
          const references = typedRecordReferenceKeys(domain, entry);
          references.add(ownKey);
          referencesByRecord.set(ownKey, references);
          for (const reference of references) {
            const next = (refCounts.get(reference) ?? 0) + 1;
            refCounts.set(reference, next);
            target.add(reference);
          }
        }
        temporal.set(ownKey, recordTemporalKey(domain, entry, id));
      }
    }
    collectProjectionRecordKeys(nested, target, refCounts, referencesByRecord, counts, countedRecords, temporal);
  }
}

function incrementRecordCount(counts: Map<string, number>, domain: string): number {
  const count = (counts.get(domain) ?? 0) + 1;
  counts.set(domain, count);
  return count;
}

function decrementRecordCount(counts: Map<string, number>, domain: string): void {
  const next = Math.max(0, (counts.get(domain) ?? 0) - 1);
  if (next === 0) counts.delete(domain);
  else counts.set(domain, next);
}

function oldestMaterializedRecord(session: ClientFeedSession, domain: string): string | undefined {
  const prefix = `${domain}\0`;
  return [...session.materializedRecordKeys]
    .filter((key) => key.startsWith(prefix))
    .sort((left, right) => {
      const leftTemporal = session.materializedRecordTemporal.get(left) ?? '';
      const rightTemporal = session.materializedRecordTemporal.get(right) ?? '';
      return leftTemporal.localeCompare(rightTemporal) || left.localeCompare(right);
    })[0];
}

function recordTemporalKey(domain: string, record: Record<string, unknown>, id: string): string {
  const messageSequence = runtimeNonNegativeBigInt(record.message_seq);
  if (messageSequence !== undefined) return `${messageSequence.toString().padStart(32, '0')}\0${id}`;
  if (domain === 'ModelRequest') {
    const requestSequence = runtimeNonNegativeBigInt(record.request_seq) ?? 0n;
    const createdAt = typeof record.created_at === 'string' ? Date.parse(record.created_at) : 0;
    const createdKey = Number.isFinite(createdAt) ? String(createdAt).padStart(16, '0') : '0000000000000000';
    return `${createdKey}\0${requestSequence.toString().padStart(32, '0')}\0${id}`;
  }
  for (const field of [
    'updated_at',
    'created_at',
    'received_at',
    'started_at',
    'completed_at',
    'decided_at',
    'handled_at'
  ]) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return `${String(timestamp).padStart(16, '0')}\0${id}`;
  }
  return `0000000000000000\0${id}`;
}

function recordIdFromKey(key: string): string {
  const separator = key.indexOf('\0');
  if (separator < 0 || separator === key.length - 1) throw new Error(`Invalid typed client record key: ${key}`);
  return key.slice(separator + 1);
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

function runtimeNonNegativeSafeInteger(value: unknown, label: string): number {
  const integer = requireRuntimeNonNegativeBigInt(value, label);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(integer);
}

function requireRuntimeNonNegativeBigInt(value: unknown, label: string): bigint {
  const integer = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
        ? BigInt(value)
        : undefined;
  if (integer === undefined || integer < 0n) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return integer;
}

function compareRuntimeIntegers(left: unknown, right: unknown): number {
  const leftValue = runtimeNonNegativeSafeInteger(left, 'left runtime integer');
  const rightValue = runtimeNonNegativeSafeInteger(right, 'right runtime integer');
  return leftValue - rightValue;
}

function firstChunkEndingAfter(chunks: readonly ProcessStreamChunkIndexEntry[], offset: number): number {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = chunks[middle]!;
    if (candidate.offset + candidate.byteLength <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function incompleteUtf8TailLength(bytes: Buffer): number {
  let leadingIndex = bytes.byteLength - 1;
  while (leadingIndex >= 0 && (bytes[leadingIndex]! & 0xc0) === 0x80) leadingIndex -= 1;
  if (leadingIndex < 0) return 0;
  const leading = bytes[leadingIndex]!;
  const expectedLength = leading >= 0xc2 && leading <= 0xdf
    ? 2
    : leading >= 0xe0 && leading <= 0xef
      ? 3
      : leading >= 0xf0 && leading <= 0xf4
        ? 4
        : 1;
  const available = bytes.byteLength - leadingIndex;
  return expectedLength > available ? available : 0;
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
      const retained = OLDEST_FIRST_SNAPSHOT_ARRAYS.has(key)
        ? value.slice(Math.max(0, value.length - limit))
        : value.slice(0, limit);
      return retained.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) return boundRecord(entry);
        return visit(entry);
      });
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [nestedKey, visit(nested, nestedKey)]));
  };
  return visit(projections) as Record<string, PlainData>;
}

const OLDEST_FIRST_SNAPSHOT_ARRAYS = new Set([
  'messages',
  'compressionBlocks',
  'modelRequests',
  'modelRequestMessageLinks',
  'messageTurnLinks'
]);

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
  // Identity fields are exact protocol keys, not display text. A long provider_call_id may make
  // this one summary exceed the display target; the enclosing message/snapshot byte bounds still
  // paginate or refresh transport, while replacement identity remains lossless.
  return compact;
}

function enforceSnapshotBounds(message: ReliableKernelSnapshotMessage): void {
  let bytes = wireBytes(message);
  if (bytes <= CLIENT_SNAPSHOT_MAX_BYTES) return;
  const activeWindow = requireSnapshotSection(message.projections, 'activeConversationWindow');
  const activeConversationId = typeof activeWindow.conversationId === 'string'
    ? activeWindow.conversationId
    : undefined;
  while (bytes > CLIENT_SNAPSHOT_MAX_BYTES) {
    const candidates = snapshotRetentionCandidates(message.projections, activeConversationId);
    const target = candidates.sort((left, right) =>
      right.weight - left.weight || right.eligibleCount - left.eligibleCount || left.key.localeCompare(right.key)
    )[0];
    if (!target) throw new Error('Client snapshot fixed envelope exceeds maxBytes.');
    const averageRecordBytes = Math.max(1, Math.ceil(target.weight / target.values.length));
    const desired = Math.max(1, Math.ceil((bytes - CLIENT_SNAPSHOT_MAX_BYTES) / averageRecordBytes));
    const dropCount = Math.min(
      target.eligibleCount,
      Math.max(1, Math.min(Math.ceil(target.eligibleCount / 4), desired))
    );
    dropOldestSnapshotRecords(target, dropCount);
    reconcileSnapshotCausalBundles(message.projections);
    bytes = wireBytes(message);
  }
}

interface SnapshotRetentionCandidate {
  key: string;
  values: PlainData[];
  direction: 'oldest-first' | 'newest-first';
  protectedId?: string;
  eligibleCount: number;
  weight: number;
}

/**
 * Only independently meaningful temporal anchors are eligible for byte-pressure trimming. Link and
 * child arrays are deliberately absent: `reconcileSnapshotCausalBundles` prunes them with their
 * anchor, so request↔message, tool↔source, message↔turn and process↔origin cannot be split by
 * an arbitrary longest-array pop.
 */
function snapshotRetentionCandidates(
  projections: Record<string, PlainData>,
  activeConversationId?: string
): SnapshotRetentionCandidate[] {
  const navigation = requireSnapshotSection(projections, 'navigationSummary');
  const window = requireSnapshotSection(projections, 'activeConversationWindow');
  const turns = requireSnapshotSection(projections, 'activeTurnSummary');
  const tools = requireSnapshotSection(projections, 'activeToolAndInteractionSummary');
  const subagents = requireSnapshotSection(projections, 'subagentDeliverySummary');
  const candidates: SnapshotRetentionCandidate[] = [];
  const add = (
    section: Record<string, PlainData>,
    key: string,
    direction: SnapshotRetentionCandidate['direction'],
    protectedId?: string
  ): void => {
    const values = snapshotArray(section, key);
    const eligibleCount = protectedId
      ? values.filter((value) => snapshotRecordId(value) !== protectedId).length
      : values.length;
    if (eligibleCount === 0) return;
    candidates.push({
      key,
      values,
      direction,
      ...(protectedId ? { protectedId } : {}),
      eligibleCount,
      weight: wireBytes(values)
    });
  };

  add(navigation, 'conversations', 'newest-first', activeConversationId);
  add(window, 'messages', 'oldest-first');
  add(window, 'conversationProjectLinks', 'newest-first');
  add(window, 'conversationReuseLinks', 'newest-first');
  add(window, 'conversationBranchLinks', 'newest-first');
  add(window, 'conversationOriginLinks', 'newest-first');
  add(window, 'agentConversationLinks', 'newest-first');
  add(window, 'compressionBlocks', 'oldest-first');
  add(window, 'conversationContextStatuses', 'newest-first');
  add(turns, 'turns', 'newest-first');
  add(turns, 'modelRequests', 'oldest-first');
  add(tools, 'toolCalls', 'newest-first');
  add(tools, 'interactionRequests', 'newest-first');
  add(tools, 'fileChangeSets', 'newest-first');
  add(tools, 'processes', 'newest-first');
  add(subagents, 'childExecutions', 'newest-first');
  add(subagents, 'runtimeDeliveries', 'newest-first');
  return candidates;
}

function dropOldestSnapshotRecords(target: SnapshotRetentionCandidate, count: number): void {
  let remaining = count;
  while (remaining > 0 && target.values.length > 0) {
    let index = target.direction === 'oldest-first' ? 0 : target.values.length - 1;
    if (target.protectedId) {
      while (
        index >= 0
        && index < target.values.length
        && snapshotRecordId(target.values[index]) === target.protectedId
      ) {
        index += target.direction === 'oldest-first' ? 1 : -1;
      }
    }
    if (index < 0 || index >= target.values.length) return;
    target.values.splice(index, 1);
    remaining -= 1;
  }
}

function reconcileSnapshotCausalBundles(projections: Record<string, PlainData>): void {
  const window = requireSnapshotSection(projections, 'activeConversationWindow');
  const turns = requireSnapshotSection(projections, 'activeTurnSummary');
  const tools = requireSnapshotSection(projections, 'activeToolAndInteractionSummary');
  const subagents = requireSnapshotSection(projections, 'subagentDeliverySummary');

  let turnIds = snapshotIds(turns, 'turns');
  const messageTurnLinks = snapshotArray(tools, 'messageTurnLinks');
  const messagesWithoutTurn = new Set<string>();
  for (const link of messageTurnLinks) {
    const messageId = snapshotField(link, 'message_id');
    const turnId = snapshotField(link, 'turn_id');
    if (messageId && turnId && !turnIds.has(turnId)) messagesWithoutTurn.add(messageId);
  }
  removeSnapshotIds(window, 'messages', messagesWithoutTurn);
  let messageIds = snapshotIds(window, 'messages');

  const requestMessageLinks = snapshotArray(turns, 'modelRequestMessageLinks');
  const requestIdsWithMissingMessages = new Set<string>();
  for (const link of requestMessageLinks) {
    const requestId = snapshotField(link, 'model_request_id');
    const messageId = snapshotField(link, 'message_id');
    if (requestId && messageId && !messageIds.has(messageId)) requestIdsWithMissingMessages.add(requestId);
  }
  filterSnapshotArray(turns, 'modelRequests', (request) => {
    const id = snapshotRecordId(request);
    const turnId = snapshotField(request, 'turn_id');
    return Boolean(id && turnId && turnIds.has(turnId) && !requestIdsWithMissingMessages.has(id));
  });
  let requestIds = snapshotIds(turns, 'modelRequests');

  const sourceLinks = snapshotArray(tools, 'toolCallSourceLinks');
  const toolIdsWithMissingSources = new Set<string>();
  for (const link of sourceLinks) {
    const toolCallId = snapshotField(link, 'tool_call_id');
    const requestId = snapshotField(link, 'model_request_id');
    const messageId = snapshotField(link, 'message_id');
    if (
      toolCallId
      && ((requestId && !requestIds.has(requestId)) || (messageId && !messageIds.has(messageId)))
    ) toolIdsWithMissingSources.add(toolCallId);
  }
  filterSnapshotArray(tools, 'toolCalls', (toolCall) => {
    const id = snapshotRecordId(toolCall);
    const turnId = snapshotField(toolCall, 'turn_id');
    return Boolean(id && turnId && turnIds.has(turnId) && !toolIdsWithMissingSources.has(id));
  });
  let toolCallIds = snapshotIds(tools, 'toolCalls');

  const processOriginLinks = snapshotArray(tools, 'processOriginLinks');
  const processIdsWithMissingOrigins = new Set<string>();
  for (const link of processOriginLinks) {
    const processId = snapshotField(link, 'process_id');
    const toolCallId = snapshotField(link, 'tool_call_id');
    if (processId && toolCallId && !toolCallIds.has(toolCallId)) processIdsWithMissingOrigins.add(processId);
  }
  filterSnapshotArray(tools, 'processes', (process) => {
    const id = snapshotRecordId(process);
    return Boolean(id && !processIdsWithMissingOrigins.has(id));
  });
  const processIds = snapshotIds(tools, 'processes');

  // Re-read anchor sets after cascades, then retain every dependent fact only with its owner.
  turnIds = snapshotIds(turns, 'turns');
  messageIds = snapshotIds(window, 'messages');
  requestIds = snapshotIds(turns, 'modelRequests');
  toolCallIds = snapshotIds(tools, 'toolCalls');
  filterSnapshotReference(turns, 'executionLeases', 'turn_id', turnIds);
  filterSnapshotReference(turns, 'turnTerminations', 'turn_id', turnIds);
  filterSnapshotReference(turns, 'turnExecutorLinks', 'turn_id', turnIds);
  filterSnapshotArray(turns, 'modelRequestMessageLinks', (link) =>
    requestIds.has(snapshotField(link, 'model_request_id') ?? '')
    && messageIds.has(snapshotField(link, 'message_id') ?? '')
  );
  filterSnapshotArray(tools, 'messageTurnLinks', (link) =>
    messageIds.has(snapshotField(link, 'message_id') ?? '')
    && turnIds.has(snapshotField(link, 'turn_id') ?? '')
  );
  filterSnapshotArray(tools, 'toolCallSourceLinks', (link) => {
    const requestId = snapshotField(link, 'model_request_id');
    const messageId = snapshotField(link, 'message_id');
    return toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
      && (!requestId || requestIds.has(requestId))
      && (!messageId || messageIds.has(messageId));
  });
  for (const key of [
    'toolCallPolicySnapshots',
    'toolCallEvents',
    'toolExecutions',
    'toolOutcomes',
    'toolModelResults',
    'toolResultArtifacts'
  ]) filterSnapshotReference(tools, key, 'tool_call_id', toolCallIds);
  filterSnapshotReference(window, 'taskList', 'tool_call_id', toolCallIds);

  const retainedInteractionRequestIds = snapshotIds(tools, 'interactionRequests');
  const ownerLinks = snapshotArray(tools, 'interactionOwnerLinks')
    .filter((link) =>
      turnIds.has(snapshotField(link, 'turn_id') ?? '')
      && retainedInteractionRequestIds.has(snapshotField(link, 'request_id') ?? '')
    );
  tools.interactionOwnerLinks = ownerLinks;
  const interactionIds = new Set(ownerLinks.flatMap((link) => {
    const id = snapshotField(link, 'request_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(tools, 'interactionRequests', (request) => interactionIds.has(snapshotRecordId(request) ?? ''));
  filterSnapshotArray(tools, 'interactionToolCallLinks', (link) =>
    interactionIds.has(snapshotField(link, 'request_id') ?? '')
    && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
  );
  filterSnapshotReference(tools, 'interactionResponses', 'request_id', interactionIds);

  filterSnapshotReference(tools, 'fileChangeSets', 'tool_call_id', toolCallIds);
  const changeSetIds = snapshotIds(tools, 'fileChangeSets');
  filterSnapshotReference(tools, 'fileChangeSetMembers', 'change_set_id', changeSetIds);
  filterSnapshotReference(tools, 'fileChangeDecisions', 'change_set_id', changeSetIds);
  filterSnapshotReference(tools, 'fileMutationReceipts', 'change_set_id', changeSetIds);
  const mutationReceiptIds = snapshotIds(tools, 'fileMutationReceipts');
  filterSnapshotReference(tools, 'fileMutationReceiptMembers', 'receipt_id', mutationReceiptIds);

  filterSnapshotArray(tools, 'processOriginLinks', (link) =>
    processIds.has(snapshotField(link, 'process_id') ?? '')
    && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
  );
  filterSnapshotReference(tools, 'processOutputChunks', 'process_id', processIds);
  filterSnapshotReference(tools, 'processReceipts', 'process_id', processIds);

  const projectLinkIds = snapshotArray(window, 'conversationProjectLinks');
  const projectContextIds = new Set(projectLinkIds.flatMap((link) => {
    const id = snapshotField(link, 'project_context_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(window, 'projectContexts', (context) => projectContextIds.has(snapshotRecordId(context) ?? ''));

  const childIds = snapshotIds(subagents, 'childExecutions');
  for (const key of [
    'childExecutionParentLinks',
    'childExecutionTurnLinks',
    'childExecutionActiveTurnLinks'
  ]) filterSnapshotReference(subagents, key, 'child_execution_id', childIds);
  const childTurnIds = new Set([
    ...snapshotArray(subagents, 'childExecutionTurnLinks'),
    ...snapshotArray(subagents, 'childExecutionActiveTurnLinks')
  ].flatMap((link) => {
    const id = snapshotField(link, 'turn_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(subagents, 'childTurns', (turn) => childTurnIds.has(snapshotRecordId(turn) ?? ''));
  filterSnapshotReference(subagents, 'childExecutionLeases', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'childTurnTerminations', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'childTurnExecutorLinks', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'answerBridges', 'child_execution_id', childIds);
  const answerBridgeIds = snapshotIds(subagents, 'answerBridges');
  filterSnapshotReference(subagents, 'answerSubmissions', 'answer_bridge_id', answerBridgeIds);

  const deliveryIds = snapshotIds(subagents, 'runtimeDeliveries');
  const inboxIds = new Set(snapshotArray(subagents, 'runtimeDeliveries').flatMap((delivery) => {
    const id = snapshotField(delivery, 'inbox_item_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(subagents, 'runtimeInboxItems', (item) => inboxIds.has(snapshotRecordId(item) ?? ''));
  if (deliveryIds.size === 0) subagents.runtimeInboxItems = [];
}

function requireSnapshotSection(
  projections: Record<string, PlainData>,
  key: string
): Record<string, PlainData> {
  const section = projections[key];
  if (!isPlainRecord(section)) throw new Error(`Client snapshot is missing ${key}.`);
  return section;
}

function snapshotArray(section: Record<string, PlainData>, key: string): PlainData[] {
  const value = section[key];
  if (!Array.isArray(value)) throw new Error(`Client snapshot projection ${key} must be an array.`);
  return value;
}

function snapshotRecordId(value: PlainData | undefined): string | undefined {
  return isPlainRecord(value) && typeof value.id === 'string' ? value.id : undefined;
}

function snapshotField(value: PlainData | undefined, field: string): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue ? fieldValue : undefined;
}

function snapshotIds(section: Record<string, PlainData>, key: string): Set<string> {
  return new Set(snapshotArray(section, key).flatMap((value) => {
    const id = snapshotRecordId(value);
    return id ? [id] : [];
  }));
}

function removeSnapshotIds(section: Record<string, PlainData>, key: string, ids: Set<string>): void {
  if (ids.size === 0) return;
  filterSnapshotArray(section, key, (value) => !ids.has(snapshotRecordId(value) ?? ''));
}

function filterSnapshotReference(
  section: Record<string, PlainData>,
  key: string,
  field: string,
  retainedIds: Set<string>
): void {
  filterSnapshotArray(section, key, (value) => retainedIds.has(snapshotField(value, field) ?? ''));
}

function filterSnapshotArray(
  section: Record<string, PlainData>,
  key: string,
  retain: (value: PlainData) => boolean
): void {
  section[key] = snapshotArray(section, key).filter(retain);
}

function truncateStrings(value: PlainData, maxLength: number, field = ''): PlainData {
  if (typeof value === 'string') {
    if (field === 'id' || field.endsWith('_id') || field.endsWith('_seq')) return value;
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry, maxLength, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, truncateStrings(nested, maxLength, key)]));
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

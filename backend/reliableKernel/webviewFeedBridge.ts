import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';
import {
  RELIABLE_KERNEL_ACK_MESSAGE,
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
  RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
  RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
  RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_MESSAGE,
  type ReliableKernelAckMessage,
  type ReliableKernelClientDiagnosticMessage,
  type ReliableKernelDataMessage,
  type ReliableKernelDetailRequestMessage,
  type ReliableKernelSnapshotRequestMessage
} from '../../shared/reliableKernelClientFeed';
import { toStructuredClonePlainData } from '../../shared/plainData';
import {
  BridgeMessageType,
  type BridgeClientId,
  type RuntimeBuildInfoRecord,
  type WebviewClientMeta
} from '../../shared/protocol';
import type { ReliableAgentTransientEvent } from './agentLoop';
import type { BoundedClientFeed, ClientDetailReader, ClientFeedConnection } from './clientFeed';
import type { ReliableDiagnosticObserver } from './diagnosticJournal';

interface FeedClient {
  clientId: BridgeClientId;
  webview: vscode.Webview;
  meta: WebviewClientMeta;
  navigationGeneration: number;
  closed: boolean;
  connection: Promise<ClientFeedConnection>;
  detailRequests: Set<string>;
  recoveryAttempt: number;
  recoveryTimer?: NodeJS.Timeout;
  recoveryWake?: (retry: boolean) => void;
  lastDataPost?: {
    sessionId: string;
    messageSeq: string;
    postedAt: number;
    emptyChanges: boolean;
    ackTimer: NodeJS.Timeout;
  };
}

const FEED_ACK_TIMEOUT_MS = 30_000;
const FEED_RECOVERY_MAX_DELAY_MS = 30_000;

export type ReliableKernelFeedBridgeErrorHandler = (
  error: unknown,
  context: { clientId: BridgeClientId; operation: 'connect' | 'post' | 'control' }
) => void;

/**
 * VS Code Webview 与 bounded Client Feed 之间的唯一数据通道。
 *
 * 每个 Webview 对应一个内存 Feed session；detach 后立即断开订阅。Bridge 只接受 ACK 与
 * snapshot-request 两类控制消息，不转发或合成旧 ClientState patch。
 */
export class ReliableKernelWebviewFeedBridge {
  private readonly clients = new Map<BridgeClientId, FeedClient>();
  private closed = false;

  public constructor(
    private readonly feed: BoundedClientFeed,
    private readonly details: ClientDetailReader,
    private readonly onError: ReliableKernelFeedBridgeErrorHandler = defaultErrorHandler,
    private readonly diagnostics?: ReliableDiagnosticObserver,
    private readonly runtimeBuildInfo?: () => RuntimeBuildInfoRecord
  ) {}

  public attach(
    webview: vscode.Webview,
    meta: WebviewClientMeta = { kind: 'unknown' }
  ): BridgeClientId {
    if (this.closed) throw new Error('ReliableKernelWebviewFeedBridge 已关闭。');
    const clientId = `feed-${randomUUID()}`;
    const client = {} as FeedClient;
    client.clientId = clientId;
    client.webview = webview;
    client.meta = plainMeta(meta);
    client.navigationGeneration = 1;
    client.closed = false;
    client.detailRequests = new Set<string>();
    client.recoveryAttempt = 0;
    client.connection = this.connect(client, client.navigationGeneration);
    this.clients.set(clientId, client);
    this.post(client, {
      id: randomUUID(),
      type: BridgeMessageType.Hello,
      clientId: client.clientId,
      payload: this.helloPayload(client.meta)
    });
    return clientId;
  }

  /** Reconnects after Webview Ready so a snapshot posted before its script boot cannot strand ACK flow. */
  public reconnect(clientId: BridgeClientId, activeConversationId?: string | null): void {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    this.reconnectClient(client, activeConversationId, true);
  }

  private reconnectClient(
    client: FeedClient,
    activeConversationId: string | null | undefined,
    resetRecoveryBackoff: boolean
  ): void {
    const previous = client.connection;
    this.cancelRecoveryTimer(client);
    if (resetRecoveryBackoff) client.recoveryAttempt = 0;
    if (activeConversationId !== undefined) {
      client.meta = plainMeta({ ...client.meta, conversationId: activeConversationId ?? undefined });
    }
    this.clearLastDataPost(client);
    client.detailRequests.clear();
    client.navigationGeneration += 1;
    client.connection = this.connect(client, client.navigationGeneration);
    void previous.then((connection) => this.feed.disconnect(connection.sessionId), () => undefined);
    this.post(client, {
      id: randomUUID(),
      type: BridgeMessageType.Hello,
      clientId: client.clientId,
      payload: this.helloPayload(client.meta)
    });
  }

  private helloPayload(meta: WebviewClientMeta): { meta: WebviewClientMeta; runtime?: RuntimeBuildInfoRecord } {
    return {
      meta,
      ...(this.runtimeBuildInfo ? { runtime: this.runtimeBuildInfo() } : {})
    };
  }

  public detach(clientId: BridgeClientId): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.closed = true;
    this.cancelRecoveryTimer(client);
    this.clearLastDataPost(client);
    this.clients.delete(clientId);
    void client.connection.then(
      (connection) => this.feed.disconnect(connection.sessionId),
      () => undefined
    );
  }

  /** Returns true only when the message belongs to the reliable feed control protocol. */
  public async handleControl(clientId: BridgeClientId, message: unknown): Promise<boolean> {
    if (!isRecord(message)) return false;
    if (
      message.type !== RELIABLE_KERNEL_ACK_MESSAGE
      && message.type !== RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE
      && message.type !== RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE
    ) {
      return false;
    }
    const client = this.clients.get(clientId);
    if (!client || client.closed) return true;
    try {
      const connection = await client.connection;
      if (client.closed) return true;
      if (message.type === RELIABLE_KERNEL_ACK_MESSAGE) {
        const ack = normalizeAck(message);
        if (ack.sessionId !== connection.sessionId || ack.hostBootId !== connection.hostBootId) return true;
        this.feed.acknowledge(ack);
        this.observeAck(client, ack);
        return true;
      }
      if (message.type === RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE) {
        const request = normalizeSnapshotRequest(message);
        if (request.sessionId && request.sessionId !== connection.sessionId) return true;
        this.feed.requestSnapshot(
          connection.sessionId,
          request.activeConversationId ?? client.meta.conversationId ?? null
        );
        return true;
      }
      if (message.type === RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE) {
        const diagnostic = normalizeClientDiagnostic(message);
        if (diagnostic.sessionId !== connection.sessionId) return true;
        this.observeClientDiagnostic(diagnostic);
        return true;
      }
      const request = normalizeDetailRequest(message);
      if (request.sessionId && request.sessionId !== connection.sessionId) return true;
      await this.readDetail(client, connection, request);
      return true;
    } catch (error) {
      this.onError(error, { clientId, operation: 'control' });
      return true;
    }
  }

  private async readDetail(
    client: FeedClient,
    connection: ClientFeedConnection,
    request: ReliableKernelDetailRequestMessage
  ): Promise<void> {
    if (client.detailRequests.has(request.requestId)) return;
    if (client.detailRequests.size >= 4) {
      this.post(client, {
        type: RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        message: '按需详情请求过多，请稍后重试。'
      });
      return;
    }
    client.detailRequests.add(request.requestId);
    try {
      const detail = await this.details.read({
        ...request,
        // Every Webview detail lookup is scoped to its current navigation generation. Passing
        // null (rather than omitting the field) makes a navigation-only panel fail closed.
        conversationId: client.meta.conversationId ?? null
      });
      if (client.closed) return;
      this.post(client, {
        type: RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
        requestId: request.requestId,
        sessionId: connection.sessionId,
        detail
      });
    } catch (error) {
      if (!client.closed) {
        this.post(client, {
          type: RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
          requestId: request.requestId,
          sessionId: connection.sessionId,
          message: error instanceof Error ? error.message : '读取详情失败。'
        });
      }
    } finally {
      client.detailRequests.delete(request.requestId);
    }
  }

  /** Broadcasts a memory-only stream overlay only to panels scoped to the same Conversation. */
  public broadcastTransient(event: ReliableAgentTransientEvent): void {
    if (this.closed) return;
    for (const client of this.clients.values()) {
      if (client.closed || client.meta.conversationId !== event.conversationId) continue;
      const connectionPromise = client.connection;
      void connectionPromise.then((connection) => {
        if (
          client.closed
          || client.connection !== connectionPromise
          || client.meta.conversationId !== event.conversationId
        ) return;
        this.post(client, {
          type: RELIABLE_KERNEL_TRANSIENT_MESSAGE,
          sessionId: connection.sessionId,
          navigationGeneration: String(client.navigationGeneration),
          hostBootId: connection.hostBootId,
          conversationId: event.conversationId,
          turnId: event.turnId,
          modelRequestId: event.modelRequestId,
          requestSeq: event.requestSeq,
          providerId: event.providerId,
          modelId: event.modelId,
          attemptSeq: event.attemptSeq,
          socketGeneration: event.socketGeneration,
          afterCommitSeq: event.afterCommitSeq,
          observedAt: event.observedAt,
          event: event.event
        });
      }, (error) => {
        if (
          error instanceof FeedConnectionSupersededError
          || client.closed
          || client.connection !== connectionPromise
        ) return;
        this.onError(error, { clientId: client.clientId, operation: 'post' });
      });
    }
  }

  public async setActiveConversation(
    clientId: BridgeClientId,
    activeConversationId: string | null
  ): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client || client.closed) return;
    // Navigation is a transport-generation boundary. Reusing the prior session lets an older
    // snapshot/detail/transient callback race into the newly selected conversation.
    this.reconnect(clientId, activeConversationId);
    await client.connection;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const clientId of [...this.clients.keys()]) this.detach(clientId);
  }

  private async connect(client: FeedClient, navigationGeneration: number): Promise<ClientFeedConnection> {
    while (!client.closed && client.navigationGeneration === navigationGeneration) {
      try {
        const connection = await this.feed.connect({
          activeConversationId: client.meta.conversationId ?? null,
          send: (message) => {
            if (!client.closed && client.navigationGeneration === navigationGeneration) {
              this.post(client, { ...message, navigationGeneration: String(navigationGeneration) });
            }
          },
          onFailure: (error) => {
            if (client.closed || client.navigationGeneration !== navigationGeneration) return;
            this.onError(error, { clientId: client.clientId, operation: 'connect' });
            this.scheduleRecovery(client);
          }
        });
        if (client.closed || client.navigationGeneration !== navigationGeneration) {
          this.feed.disconnect(connection.sessionId);
          throw new FeedConnectionSupersededError();
        }
        return connection;
      } catch (error) {
        if (error instanceof FeedConnectionSupersededError) throw error;
        this.onError(error, { clientId: client.clientId, operation: 'connect' });
        if (!await this.waitForConnectRecovery(client, navigationGeneration)) {
          throw new FeedConnectionSupersededError();
        }
      }
    }
    throw new FeedConnectionSupersededError();
  }

  private post(client: FeedClient, message: ReliableKernelDataMessage | Record<string, unknown>): void {
    const detailMessage = message.type === RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE
      || message.type === RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE;
    let plain: unknown;
    try {
      plain = toStructuredClonePlainData(message, 'reliable kernel webview message');
    } catch (error) {
      this.onError(error, { clientId: client.clientId, operation: 'post' });
      if (detailMessage && !client.closed) this.scheduleRecovery(client);
      return;
    }
    const dataMessage = reliableDataDiagnostic(message);
    if (dataMessage) {
      this.clearLastDataPost(client);
      const ackTimer = setTimeout(() => {
        const pending = client.lastDataPost;
        if (
          client.closed
          || !pending
          || pending.sessionId !== dataMessage.sessionId
          || pending.messageSeq !== dataMessage.messageSeq
        ) return;
        this.onError(new Error(`Reliable feed ACK ${dataMessage.messageSeq} timed out.`), {
          clientId: client.clientId,
          operation: 'post'
        });
        this.scheduleRecovery(client);
      }, FEED_ACK_TIMEOUT_MS);
      ackTimer.unref();
      client.lastDataPost = {
        sessionId: dataMessage.sessionId,
        messageSeq: dataMessage.messageSeq,
        postedAt: Date.now(),
        emptyChanges: dataMessage.emptyChanges,
        ackTimer
      };
      if (!dataMessage.emptyChanges) {
        this.diagnostics?.observe({
          eventKind: 'feed.data.posted',
          scopeKind: 'feed_session',
          scopeId: dataMessage.sessionId,
          correlationId: dataMessage.messageSeq,
          metadata: {
            ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
            sessionId: dataMessage.sessionId,
            messageSeq: dataMessage.messageSeq,
            commitSeq: dataMessage.commitSeq,
            kind: dataMessage.kind,
            bytes: wireBytes(plain),
            changeCount: dataMessage.changeCount
          }
        });
      }
    }
    void client.webview.postMessage(plain).then(
      (delivered) => {
        if (delivered !== false || client.closed) return;
        if (detailMessage) {
          this.onError(new Error('VS Code rejected reliable detail postMessage delivery.'), {
            clientId: client.clientId,
            operation: 'post'
          });
          this.scheduleRecovery(client);
          return;
        }
        if (!dataMessage) return;
        const pending = client.lastDataPost;
        if (pending?.sessionId !== dataMessage.sessionId || pending.messageSeq !== dataMessage.messageSeq) return;
        this.onError(new Error('VS Code rejected reliable feed postMessage delivery.'), {
          clientId: client.clientId,
          operation: 'post'
        });
        this.scheduleRecovery(client);
      },
      (error) => {
        if (dataMessage && !dataMessage.emptyChanges) {
          this.diagnostics?.observe({
            eventKind: 'feed.data.post_failed',
            scopeKind: 'feed_session',
            scopeId: dataMessage.sessionId,
            correlationId: dataMessage.messageSeq,
            metadata: {
              ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
              sessionId: dataMessage.sessionId,
              messageSeq: dataMessage.messageSeq,
              errorName: error instanceof Error ? error.name : 'UnknownError'
            }
          });
        }
        this.onError(error, { clientId: client.clientId, operation: 'post' });
        if (detailMessage && !client.closed) {
          this.scheduleRecovery(client);
          return;
        }
        if (dataMessage && !client.closed) {
          const pending = client.lastDataPost;
          if (pending?.sessionId === dataMessage.sessionId && pending.messageSeq === dataMessage.messageSeq) {
            this.scheduleRecovery(client);
          }
        }
      }
    );
  }

  private observeClientDiagnostic(message: ReliableKernelClientDiagnosticMessage): void {
    if (message.eventKind === 'feed-painted') {
      if (!message.messageSeq) return;
      this.diagnostics?.observe({
        eventKind: 'webview.feed.painted',
        scopeKind: 'feed_session',
        scopeId: message.sessionId,
        correlationId: message.messageSeq,
        observedAt: message.observedAt,
        metadata: {
          ...(message.conversationId ? { conversationId: message.conversationId } : {}),
          sessionId: message.sessionId,
          messageSeq: message.messageSeq
        }
      });
      return;
    }
    if (!message.modelRequestId) return;
    this.diagnostics?.observe({
      eventKind: 'webview.transient.painted',
      scopeKind: 'model_request',
      scopeId: message.modelRequestId,
      correlationId: message.streamSeq,
      observedAt: message.observedAt,
      metadata: {
        ...(message.conversationId ? { conversationId: message.conversationId } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
        modelRequestId: message.modelRequestId,
        ...(message.attemptSeq ? { attemptSeq: message.attemptSeq } : {}),
        ...(message.socketGeneration ? { socketGeneration: message.socketGeneration } : {}),
        ...(message.streamSeq ? { streamSeq: message.streamSeq } : {})
      }
    });
  }

  private observeAck(client: FeedClient, ack: ReliableKernelAckMessage): void {
    const posted = client.lastDataPost;
    if (!posted || posted.sessionId !== ack.sessionId || posted.messageSeq !== ack.messageSeq) return;
    this.clearLastDataPost(client);
    this.cancelRecoveryTimer(client);
    client.recoveryAttempt = 0;
    if (posted.emptyChanges) return;
    this.diagnostics?.observe({
      eventKind: 'feed.data.acked',
      scopeKind: 'feed_session',
      scopeId: ack.sessionId,
      correlationId: ack.messageSeq,
      metadata: {
        ...(client.meta.conversationId ? { conversationId: client.meta.conversationId } : {}),
        sessionId: ack.sessionId,
        messageSeq: ack.messageSeq,
        elapsedMs: Math.max(0, Date.now() - posted.postedAt)
      }
    });
  }

  private clearLastDataPost(client: FeedClient): void {
    if (client.lastDataPost) clearTimeout(client.lastDataPost.ackTimer);
    client.lastDataPost = undefined;
  }

  private scheduleRecovery(client: FeedClient): void {
    if (client.closed || client.recoveryTimer) return;
    const delay = this.nextRecoveryDelay(client);
    client.recoveryTimer = setTimeout(() => {
      client.recoveryTimer = undefined;
      if (!client.closed) this.reconnectClient(client, client.meta.conversationId ?? null, false);
    }, delay);
    client.recoveryTimer.unref();
  }

  /**
   * Initial connect and reconnect attempts use the same bounded backoff as ACK/post recovery. The
   * active `connection` promise therefore stays pending across a one-shot transport failure instead
   * of becoming a permanently rejected handle that every later control message would await.
   */
  private waitForConnectRecovery(client: FeedClient, navigationGeneration: number): Promise<boolean> {
    if (client.closed || client.navigationGeneration !== navigationGeneration) return Promise.resolve(false);
    // A synchronous post failure can schedule recovery while feed.connect() is still unwinding.
    // Keep the active connection promise as the sole owner of recovery instead of letting that
    // timer replace it after this attempt rejects.
    if (client.recoveryTimer) this.cancelRecoveryTimer(client);
    const delay = this.nextRecoveryDelay(client);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (retry: boolean): void => {
        if (settled) return;
        settled = true;
        if (client.recoveryTimer) clearTimeout(client.recoveryTimer);
        client.recoveryTimer = undefined;
        client.recoveryWake = undefined;
        resolve(retry && !client.closed && client.navigationGeneration === navigationGeneration);
      };
      client.recoveryWake = finish;
      client.recoveryTimer = setTimeout(() => finish(true), delay);
      client.recoveryTimer.unref();
    });
  }

  private nextRecoveryDelay(client: FeedClient): number {
    const delay = Math.min(FEED_RECOVERY_MAX_DELAY_MS, 1_000 * 2 ** Math.min(client.recoveryAttempt, 5));
    client.recoveryAttempt += 1;
    return delay;
  }

  private cancelRecoveryTimer(client: FeedClient): void {
    if (client.recoveryTimer) clearTimeout(client.recoveryTimer);
    client.recoveryTimer = undefined;
    const wake = client.recoveryWake;
    client.recoveryWake = undefined;
    wake?.(false);
  }
}

class FeedConnectionSupersededError extends Error {
  public constructor() {
    super('Reliable feed connection attempt was superseded.');
    this.name = 'FeedConnectionSupersededError';
  }
}

function reliableDataDiagnostic(message: unknown): {
  kind: 'snapshot' | 'changes';
  sessionId: string;
  messageSeq: string;
  commitSeq: string;
  changeCount: number;
  emptyChanges: boolean;
} | undefined {
  if (!isRecord(message)) return undefined;
  if (message.type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
    if (
      typeof message.sessionId !== 'string'
      || typeof message.messageSeq !== 'string'
      || typeof message.snapshotCommitSeq !== 'string'
    ) return undefined;
    return {
      kind: 'snapshot',
      sessionId: message.sessionId,
      messageSeq: message.messageSeq,
      commitSeq: message.snapshotCommitSeq,
      changeCount: 0,
      emptyChanges: false
    };
  }
  if (message.type !== RELIABLE_KERNEL_CHANGES_MESSAGE) return undefined;
  if (
    typeof message.sessionId !== 'string'
    || typeof message.messageSeq !== 'string'
    || typeof message.commitSeq !== 'string'
    || !Array.isArray(message.changes)
  ) return undefined;
  return {
    kind: 'changes',
    sessionId: message.sessionId,
    messageSeq: message.messageSeq,
    commitSeq: message.commitSeq,
    changeCount: message.changes.length,
    emptyChanges: message.changes.length === 0
  };
}

function wireBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function normalizeAck(message: Record<string, unknown>): ReliableKernelAckMessage {
  return {
    type: RELIABLE_KERNEL_ACK_MESSAGE,
    sessionId: requireText(message.sessionId, 'ack.sessionId'),
    hostBootId: requireText(message.hostBootId, 'ack.hostBootId'),
    messageSeq: requireDecimal(message.messageSeq, 'ack.messageSeq')
  };
}

function normalizeClientDiagnostic(message: Record<string, unknown>): ReliableKernelClientDiagnosticMessage {
  const eventKind = message.eventKind;
  if (eventKind !== 'feed-painted' && eventKind !== 'transient-painted') {
    throw new TypeError('client diagnostic.eventKind is invalid.');
  }
  const observedAt = requireText(message.observedAt, 'client diagnostic.observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new TypeError('client diagnostic.observedAt is invalid.');
  return {
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId: requireText(message.sessionId, 'client diagnostic.sessionId'),
    eventKind,
    observedAt: new Date(Date.parse(observedAt)).toISOString(),
    ...(message.conversationId === undefined ? {} : { conversationId: requireText(message.conversationId, 'client diagnostic.conversationId') }),
    ...(message.turnId === undefined ? {} : { turnId: requireText(message.turnId, 'client diagnostic.turnId') }),
    ...(message.messageSeq === undefined ? {} : { messageSeq: requireDecimal(message.messageSeq, 'client diagnostic.messageSeq') }),
    ...(message.modelRequestId === undefined ? {} : { modelRequestId: requireText(message.modelRequestId, 'client diagnostic.modelRequestId') }),
    ...(message.streamSeq === undefined ? {} : { streamSeq: requireDecimal(message.streamSeq, 'client diagnostic.streamSeq') }),
    ...(message.attemptSeq === undefined ? {} : { attemptSeq: requireDecimal(message.attemptSeq, 'client diagnostic.attemptSeq') }),
    ...(message.socketGeneration === undefined ? {} : { socketGeneration: requireDecimal(message.socketGeneration, 'client diagnostic.socketGeneration') })
  };
}

function normalizeSnapshotRequest(message: Record<string, unknown>): ReliableKernelSnapshotRequestMessage {
  return {
    type: RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
    ...(message.sessionId === undefined ? {} : { sessionId: requireText(message.sessionId, 'snapshotRequest.sessionId') }),
    ...(message.activeConversationId === undefined
      ? {}
      : { activeConversationId: requireText(message.activeConversationId, 'snapshotRequest.activeConversationId') })
  };
}

function normalizeDetailRequest(message: Record<string, unknown>): ReliableKernelDetailRequestMessage {
  const kind = message.kind;
  if (![
    'message-content',
    'turn-intent-preview',
    'tool-arguments-content',
    'tool-result-content',
    'tool-event-content',
    'interaction-prompt',
    'file-change-base-content',
    'file-change-content',
    'file-change-diff',
    'process-output',
    'process-stdout',
    'process-stderr',
    'context-projection-detail',
    'compression-content',
    'compression-title',
    'answer-content'
  ].includes(String(kind))) throw new TypeError('detail.kind is invalid.');
  if (!Number.isSafeInteger(message.offset) || (message.offset as number) < 0) {
    throw new TypeError('detail.offset must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(message.maxBytes) || (message.maxBytes as number) <= 0 || (message.maxBytes as number) > 2_097_152) {
    throw new TypeError('detail.maxBytes must be from 1 to 2097152.');
  }
  if (
    message.expectedTotalBytes !== undefined
    && (!Number.isSafeInteger(message.expectedTotalBytes) || (message.expectedTotalBytes as number) < 0)
  ) throw new TypeError('detail.expectedTotalBytes must be a non-negative integer.');
  return {
    type: RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
    requestId: requireText(message.requestId, 'detail.requestId'),
    ...(message.sessionId === undefined ? {} : { sessionId: requireText(message.sessionId, 'detail.sessionId') }),
    kind: kind as ReliableKernelDetailRequestMessage['kind'],
    recordId: requireText(message.recordId, 'detail.recordId'),
    offset: message.offset as number,
    maxBytes: message.maxBytes as number,
    ...(message.expectedTotalBytes === undefined
      ? {}
      : { expectedTotalBytes: message.expectedTotalBytes as number })
  };
}

function plainMeta(meta: WebviewClientMeta): WebviewClientMeta {
  return toStructuredClonePlainData({
    kind: meta.kind,
    ...(meta.panelId ? { panelId: meta.panelId } : {}),
    ...(meta.title ? { title: meta.title } : {}),
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    ...(meta.toolCallId ? { toolCallId: meta.toolCallId } : {}),
    ...(meta.planProposalId ? { planProposalId: meta.planProposalId } : {})
  }, 'webview meta') as unknown as WebviewClientMeta;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!/^(?:0|[1-9]\d*)$/.test(text)) throw new TypeError(`${label} must be a decimal integer string.`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function defaultErrorHandler(error: unknown, context: { clientId: BridgeClientId; operation: string }): void {
  console.error(`[LimCode] Reliable client feed ${context.operation} failed for ${context.clientId}.`, error);
}

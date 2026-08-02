import { defineStore } from 'pinia';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
  RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
  RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
  RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_MESSAGE,
  applyReliableKernelDataMessage,
  createEmptyReliableKernelClientState,
  type ReliableKernelBoundedClientState,
  type ReliableKernelClientDetailKind,
  type ReliableKernelDetailErrorMessage,
  type ReliableKernelDetailResultMessage,
  type ReliableKernelTransientMessage
} from '@shared/reliableKernelClientFeed';
import { createMessageId, type LlmUsageMetadataRecord } from '@shared/protocol';
import {
  compareReliableTransientIdentity,
  mergeReliableCompletedToolCalls,
  mergeReliableToolCallDeltas,
  replaceReliableCompletedToolCalls,
  type ReliableTransientToolCallState
} from '@webview/domain/reliableTransientModel';
import { reconcileReliableTransientRequests } from '@webview/domain/reliableTransientLifecycle';
import { bridge } from '@webview/transport';

export interface ReliableKernelDetailState {
  status: 'loading' | 'ready' | 'error';
  text: string;
  totalBytes: number;
  error?: string;
}

interface PendingDetailRequest {
  key: string;
  kind: ReliableKernelClientDetailKind;
  recordId: string;
  nextOffset: number;
  totalBytes?: number;
  sessionId: string;
  priority: ReliableKernelDetailPriority;
  enqueuedAt: number;
}

export type ReliableKernelDetailPriority = 'critical' | 'expanded' | 'visible' | 'background';

interface ReliableKernelDetailCacheMeta {
  lastAccessedAt: number;
  bytes: number;
}

export interface ReliableKernelTransientState {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq?: string;
  socketGeneration?: string;
  afterCommitSeq?: string;
  streamSeq: string;
  text: string;
  thought: string;
  thoughtSignature?: string;
  thoughtElapsedMs?: number;
  thoughtDurationMs?: number;
  toolCalls: ReliableTransientToolCallState[];
  usageMetadata?: LlmUsageMetadataRecord;
  providerStartedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  updatedAt: number;
}

interface ReliableKernelFeedStoreState extends ReliableKernelBoundedClientState {
  details: Record<string, ReliableKernelDetailState>;
  pendingDetails: Record<string, PendingDetailRequest>;
  detailQueue: string[];
  activeDetailRequestIds: string[];
  detailCacheMeta: Record<string, ReliableKernelDetailCacheMeta>;
  retiredSessionIds: string[];
  navigationGeneration: string | null;
  transientModelRequests: Record<string, ReliableKernelTransientState>;
}

const DETAIL_CHUNK_MAX_BYTES = 262_144;
const DETAIL_MAX_INFLIGHT_REQUESTS = 4;
const DETAIL_CACHE_MAX_ENTRIES = 256;
const DETAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REPORTED_TRANSIENT_PAINTS = 512;
const reportedTransientPaints = new Set<string>();
const detailDecoders = new Map<string, TextDecoder>();
// Streaming pieces stay outside Vue deep reactivity. Reassigning one growing string for every
// frame copies its entire prefix repeatedly; a single final join keeps large details linear.
const detailTextChunks = new Map<string, string[]>();
const DETAIL_PRIORITY_ORDER: Readonly<Record<ReliableKernelDetailPriority, number>> = Object.freeze({
  critical: 0,
  expanded: 1,
  visible: 2,
  background: 3
});

export const useReliableKernelClientFeedStore = defineStore('reliableKernelClientFeed', {
  state: (): ReliableKernelFeedStoreState => ({
    ...createEmptyReliableKernelClientState(),
    details: {},
    pendingDetails: {},
    detailQueue: [],
    activeDetailRequestIds: [],
    detailCacheMeta: {},
    retiredSessionIds: [],
    navigationGeneration: null,
    transientModelRequests: {}
  }),
  getters: {
    childExecutionFacts: (state) => Object.values(state.records.ChildExecution ?? {}),
    activeChildTurnFacts: (state) => Object.values(state.records.ChildExecutionActiveTurnLink ?? {}),
    answerBridgeFacts: (state) => Object.values(state.records.AnswerBridge ?? {}),
    answerSubmissionFacts: (state) => Object.values(state.records.AnswerSubmission ?? {}),
    runtimeDeliveryFacts: (state) => Object.values(state.records.RuntimeDelivery ?? {}),
    terminationFacts: (state) => Object.values(state.records.TurnTermination ?? {})
  },
  actions: {
    observe(message: unknown): void {
      if (isReliableKernelFeedDataMessage(message)) {
        this.observeData(message);
        return;
      }
      if (isReliableKernelDetailResultMessage(message)) {
        this.observeDetailResult(message);
        return;
      }
      if (isReliableKernelDetailErrorMessage(message)) {
        this.observeDetailError(message);
        return;
      }
      if (isReliableKernelTransientMessage(message)) this.observeTransient(message);
    },

    observeData(message: unknown): void {
      const envelope = plainRecord(message);
      const incomingSessionId = stringValue(envelope?.sessionId);
      const incomingType = stringValue(envelope?.type);
      const incomingGeneration = optionalDecimal(envelope?.navigationGeneration);
      if (!incomingSessionId) return;
      if (this.retiredSessionIds.includes(incomingSessionId)) return;
      if (incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE && this.sessionId !== incomingSessionId) return;
      if (
        incomingGeneration
        && this.navigationGeneration
        && BigInt(incomingGeneration) < BigInt(this.navigationGeneration)
      ) return;
      const previousSessionId = this.sessionId;
      const previousHostBootId = this.hostBootId;
      const previousConversationId = activeConversationId(this.projections);
      const result = applyReliableKernelDataMessage(this.$state, message);
      let replayDetails: Array<{
        kind: ReliableKernelClientDetailKind;
        recordId: string;
        priority: ReliableKernelDetailPriority;
      }> = [];
      if (previousSessionId && result.state.sessionId !== previousSessionId) {
        this.retiredSessionIds = [...this.retiredSessionIds, previousSessionId].slice(-16);
        const sameTransientScope = previousHostBootId === result.state.hostBootId
          && previousConversationId !== undefined
          && previousConversationId === activeConversationId(result.state.projections);
        if (sameTransientScope) {
          replayDetails = Object.values(this.pendingDetails).map((pending) => ({
            kind: pending.kind,
            recordId: pending.recordId,
            priority: pending.priority
          }));
        }
        cancelAllDetailRequests(this.$state);
        if (!sameTransientScope) {
          this.transientModelRequests = {};
          reportedTransientPaints.clear();
        }
      }
      if (previousHostBootId && result.state.hostBootId !== previousHostBootId) {
        this.details = {};
        this.detailCacheMeta = {};
      }
      this.sessionId = result.state.sessionId;
      this.hostBootId = result.state.hostBootId;
      this.lastMessageSeq = result.state.lastMessageSeq;
      this.lastCommitSeq = result.state.lastCommitSeq;
      this.projections = result.state.projections;
      this.records = result.state.records;
      this.snapshotRequired = result.state.snapshotRequired;
      if (incomingGeneration) this.navigationGeneration = incomingGeneration;
      for (const detail of replayDetails) {
        this.requestDetail(detail.kind, detail.recordId, { priority: detail.priority });
      }
      reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      if (result.ack) {
        bridge.postRaw(result.ack);
        reportFeedPaint(
          message,
          stringValue(plainRecord(this.projections.activeConversationWindow)?.conversationId)
        );
      }
      if (result.snapshotRequired) {
        bridge.postRaw({
          type: RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
          ...(this.sessionId ? { sessionId: this.sessionId } : {})
        });
      }
    },

    observeTransient(message: ReliableKernelTransientMessage): void {
      if (
        !this.hostBootId
        || message.hostBootId !== this.hostBootId
        || !this.sessionId
        || message.sessionId !== this.sessionId
        || this.retiredSessionIds.includes(message.sessionId)
      ) return;
      const activeConversationId = stringValue(plainRecord(this.projections.activeConversationWindow)?.conversationId);
      if (!activeConversationId || message.conversationId !== activeConversationId) return;
      const incomingGeneration = optionalDecimal(message.navigationGeneration);
      if (
        incomingGeneration
        && this.navigationGeneration
        && BigInt(incomingGeneration) !== BigInt(this.navigationGeneration)
      ) return;
      const sequence = decimal(message.event.streamSeq);
      const requestSeq = positiveDecimal(message.requestSeq);
      const providerId = nonEmptyString(message.providerId);
      const modelId = nonEmptyString(message.modelId);
      if (sequence === undefined || !requestSeq || !providerId || !modelId) return;
      const attemptSeq = optionalDecimal(message.attemptSeq);
      const socketGeneration = optionalDecimal(message.socketGeneration);
      const afterCommitSeq = optionalDecimal(message.afterCommitSeq);
      const prior = this.transientModelRequests[message.modelRequestId];
      const identity = compareReliableTransientIdentity(prior, attemptSeq, socketGeneration);
      if (identity === 'stale') return;
      const current = identity === 'newer' ? undefined : prior;
      if (current && BigInt(current.streamSeq) >= BigInt(sequence)) return;
      const content = plainRecord(message.event.content);
      const observedAt = timestamp(message.observedAt) || Date.now();
      const next: ReliableKernelTransientState = current
        ? {
            ...current,
            streamSeq: sequence,
            updatedAt: observedAt,
            ...(afterCommitSeq ? { afterCommitSeq } : {})
          }
        : {
            conversationId: message.conversationId,
            turnId: message.turnId,
            modelRequestId: message.modelRequestId,
            requestSeq,
            providerId,
            modelId,
            ...(attemptSeq ? { attemptSeq } : {}),
            ...(socketGeneration ? { socketGeneration } : {}),
            ...(afterCommitSeq ? { afterCommitSeq } : {}),
            streamSeq: sequence,
            text: '',
            thought: '',
            toolCalls: [],
            status: 'streaming',
            startedAt: observedAt,
            updatedAt: observedAt
          };
      if (message.event.kind === 'completed') {
        next.text = stringValue(content?.text) ?? next.text;
        next.thought = stringValue(content?.thought) ?? next.thought;
        next.thoughtSignature = stringValue(content?.thoughtSignature) ?? next.thoughtSignature;
        next.thoughtDurationMs = nonNegativeNumber(content?.thoughtDurationMs)
          ?? next.thoughtDurationMs
          ?? next.thoughtElapsedMs;
        next.toolCalls = replaceReliableCompletedToolCalls(
          content?.toolCalls,
          message.modelRequestId,
          observedAt
        ) ?? next.toolCalls;
        const usage = plainRecord(message.event.usage);
        if (usage) next.usageMetadata = usage;
        const timing = plainRecord(message.event.timing);
        next.providerStartedAt = positiveNumber(timing?.providerStartedAt) ?? next.providerStartedAt;
        next.firstOutputAt = positiveNumber(timing?.firstOutputAt) ?? next.firstOutputAt;
        next.completedAt = positiveNumber(timing?.completedAt) ?? next.completedAt;
        next.streamOutputDurationMs = nonNegativeNumber(timing?.streamOutputDurationMs)
          ?? next.streamOutputDurationMs;
        next.status = 'completed';
      } else if (message.event.kind === 'failed' || message.event.kind === 'cancelled') {
        next.status = message.event.kind;
        const terminalText = stringValue(content?.text);
        if (terminalText !== undefined) next.text = terminalText;
        const terminalThought = stringValue(content?.thought);
        if (terminalThought !== undefined) next.thought = terminalThought;
      } else if (content?.type === 'text_delta') {
        next.text += stringValue(content.text) ?? '';
      } else if (content?.type === 'thought_delta') {
        next.thought += stringValue(content.text) ?? '';
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        next.thoughtElapsedMs = nonNegativeNumber(content.thoughtElapsedMs) ?? next.thoughtElapsedMs;
      } else if (content?.type === 'thought_progress') {
        next.thoughtElapsedMs = nonNegativeNumber(content.thoughtElapsedMs) ?? next.thoughtElapsedMs;
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
      } else if (content?.type === 'thought_done') {
        next.thoughtDurationMs = nonNegativeNumber(content.thoughtDurationMs)
          ?? next.thoughtElapsedMs;
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
      } else if (content?.type === 'tool_call_delta') {
        next.toolCalls = mergeReliableToolCallDeltas(
          next.toolCalls,
          content.calls,
          message.modelRequestId,
          observedAt
        );
      } else if (content?.type === 'tool_calls' && Array.isArray(content.calls)) {
        next.toolCalls = mergeReliableCompletedToolCalls(
          next.toolCalls,
          content.calls,
          message.modelRequestId,
          observedAt
        );
      }
      this.transientModelRequests[message.modelRequestId] = next;
      reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      if (!current) reportTransientPaint(this.sessionId, message, sequence);
    },

    requestDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return undefined;
      const key = detailKey(kind, id);
      const current = this.details[key];
      if (current?.status === 'ready') {
        this.detailCacheMeta[key] = {
          lastAccessedAt: Date.now(),
          bytes: current.totalBytes
        };
        return key;
      }
      if (current?.status === 'error') return key;
      const priority = options.priority ?? 'visible';
      if (current?.status === 'loading') {
        const pending = Object.values(this.pendingDetails).find((request) => request.key === key);
        if (pending && DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[pending.priority]) {
          pending.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        return key;
      }
      const requestId = createMessageId();
      this.details[key] = { status: 'loading', text: '', totalBytes: 0 };
      detailTextChunks.set(requestId, []);
      this.pendingDetails[requestId] = {
        key,
        kind,
        recordId: id,
        nextOffset: 0,
        sessionId,
        priority,
        enqueuedAt: Date.now()
      };
      this.detailQueue.push(requestId);
      this.sortDetailQueue();
      this.pumpDetailQueue();
      return key;
    },

    retryDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      delete this.details[detailKey(kind, recordId)];
      delete this.detailCacheMeta[detailKey(kind, recordId)];
      return this.requestDetail(kind, recordId, options);
    },

    /** Continues a mutable process stream from its already-rendered durable byte prefix. */
    refreshDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      const key = detailKey(kind, id);
      const current = this.details[key];
      if (!id || !sessionId || current?.status !== 'ready') {
        return this.requestDetail(kind, recordId, options);
      }
      if (Object.values(this.pendingDetails).some((request) => request.key === key)) return key;
      const requestId = createMessageId();
      this.details[key] = {
        status: 'loading',
        text: current.text,
        totalBytes: current.totalBytes
      };
      detailTextChunks.set(requestId, [current.text]);
      this.pendingDetails[requestId] = {
        key,
        kind,
        recordId: id,
        nextOffset: current.totalBytes,
        sessionId,
        priority: options.priority ?? 'visible',
        enqueuedAt: Date.now()
      };
      this.detailQueue.push(requestId);
      this.sortDetailQueue();
      this.pumpDetailQueue();
      return key;
    },

    observeDetailResult(message: ReliableKernelDetailResultMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId || message.detail.recordId !== pending.recordId) return;
      if (
        message.detail.offset !== pending.nextOffset
        || (pending.totalBytes !== undefined && pending.totalBytes !== message.detail.totalBytes)
      ) {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: message.detail.totalBytes,
          error: '详情分块不连续；未将不完整内容标记为已就绪。'
        };
        this.finishDetailRequest(message.requestId);
        return;
      }
      const bytes = decodeBase64Bytes(message.detail.chunk);
      const nextOffset = message.detail.offset + bytes.byteLength;
      if (
        nextOffset > message.detail.totalBytes
        || (message.detail.hasMore && message.detail.nextOffset !== nextOffset)
        || (!message.detail.hasMore && nextOffset !== message.detail.totalBytes)
      ) {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: message.detail.totalBytes,
          error: '详情分块边界与持久化长度不一致。'
        };
        this.finishDetailRequest(message.requestId);
        return;
      }
      pending.nextOffset = nextOffset;
      pending.totalBytes = message.detail.totalBytes;
      const decoder = detailDecoder(message.requestId);
      const currentDetail = this.details[pending.key];
      if (!currentDetail || currentDetail.status !== 'loading') return;
      try {
        detailTextChunks.get(message.requestId)?.push(
          decoder.decode(bytes, { stream: message.detail.hasMore })
        );
        currentDetail.totalBytes = message.detail.totalBytes;
      } catch (error) {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: message.detail.totalBytes,
          error: error instanceof Error ? error.message : '详情内容解码失败。'
        };
        this.finishDetailRequest(message.requestId);
        return;
      }
      if (message.detail.hasMore && message.detail.nextOffset !== undefined) {
        this.postDetailChunk(message.requestId, message.detail.nextOffset);
        return;
      }
      try {
        const chunks = detailTextChunks.get(message.requestId) ?? [];
        chunks.push(decoder.decode());
        currentDetail.text = chunks.join('');
        currentDetail.status = 'ready';
        this.detailCacheMeta[pending.key] = {
          lastAccessedAt: Date.now(),
          bytes: message.detail.totalBytes
        };
        pruneDetailCache(this.$state);
        // The durable Message shell can precede its on-demand body. Retire a completed transient
        // overlay in the same action that makes the final detail ready, rather than waiting for an
        // unrelated later feed commit or transient event to trigger reconciliation.
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      } catch (error) {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: message.detail.totalBytes,
          error: error instanceof Error ? error.message : '详情内容解码失败。'
        };
      }
      this.finishDetailRequest(message.requestId);
    },

    observeDetailError(message: ReliableKernelDetailErrorMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId) return;
      this.details[pending.key] = {
        status: 'error',
        text: '',
        totalBytes: 0,
        error: message.message
      };
      this.finishDetailRequest(message.requestId);
    },

    pumpDetailQueue(): void {
      this.sortDetailQueue();
      while (
        this.activeDetailRequestIds.length < DETAIL_MAX_INFLIGHT_REQUESTS
        && this.detailQueue.length > 0
      ) {
        const requestId = this.detailQueue.shift();
        const pending = requestId ? this.pendingDetails[requestId] : undefined;
        if (!requestId || !pending) continue;
        this.activeDetailRequestIds.push(requestId);
        this.postDetailChunk(requestId, pending.nextOffset);
      }
    },

    finishDetailRequest(requestId: string): void {
      detailDecoders.delete(requestId);
      detailTextChunks.delete(requestId);
      delete this.pendingDetails[requestId];
      this.activeDetailRequestIds = this.activeDetailRequestIds.filter((id) => id !== requestId);
      this.detailQueue = this.detailQueue.filter((id) => id !== requestId);
      this.pumpDetailQueue();
    },

    sortDetailQueue(): void {
      this.detailQueue.sort((leftId, rightId) => {
        const left = this.pendingDetails[leftId];
        const right = this.pendingDetails[rightId];
        if (!left) return 1;
        if (!right) return -1;
        return DETAIL_PRIORITY_ORDER[left.priority] - DETAIL_PRIORITY_ORDER[right.priority]
          || left.enqueuedAt - right.enqueuedAt
          || leftId.localeCompare(rightId);
      });
    },

    postDetailChunk(requestId: string, offset: number): void {
      const pending = this.pendingDetails[requestId];
      const sessionId = this.sessionId;
      if (
        !pending
        || !sessionId
        || pending.sessionId !== sessionId
        || !this.activeDetailRequestIds.includes(requestId)
      ) return;
      bridge.postRaw({
        type: RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
        requestId,
        sessionId,
        kind: pending.kind,
        recordId: pending.recordId,
        offset,
        maxBytes: DETAIL_CHUNK_MAX_BYTES,
        ...(pending.totalBytes === undefined ? {} : { expectedTotalBytes: pending.totalBytes })
      });
    }
  }
});

export function isReliableKernelFeedMessage(message: unknown): boolean {
  return isReliableKernelFeedDataMessage(message)
    || isReliableKernelDetailResultMessage(message)
    || isReliableKernelDetailErrorMessage(message)
    || isReliableKernelTransientMessage(message);
}

export function isReliableKernelFeedDataMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const type = (message as Record<string, unknown>).type;
  return type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE || type === RELIABLE_KERNEL_CHANGES_MESSAGE;
}

function isReliableKernelDetailResultMessage(message: unknown): message is ReliableKernelDetailResultMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE;
}

function isReliableKernelDetailErrorMessage(message: unknown): message is ReliableKernelDetailErrorMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE;
}

function isReliableKernelTransientMessage(message: unknown): message is ReliableKernelTransientMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_TRANSIENT_MESSAGE
    && isRecord(message.event);
}

function reportFeedPaint(message: unknown, conversationId?: string): void {
  const record = plainRecord(message);
  const sessionId = stringValue(record?.sessionId);
  const messageSeq = decimal(record?.messageSeq);
  if (!sessionId || !messageSeq) return;
  afterNextPaint(() => bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId,
    eventKind: 'feed-painted',
    observedAt: new Date().toISOString(),
    ...(conversationId ? { conversationId } : {}),
    messageSeq
  }));
}

function reportTransientPaint(
  sessionId: string | null,
  message: ReliableKernelTransientMessage,
  streamSeq: string
): void {
  const generation = `${message.modelRequestId}:${message.attemptSeq ?? '0'}:${message.socketGeneration ?? '0'}`;
  if (!sessionId || reportedTransientPaints.has(generation)) return;
  reportedTransientPaints.add(generation);
  while (reportedTransientPaints.size > MAX_REPORTED_TRANSIENT_PAINTS) {
    const oldest = reportedTransientPaints.values().next().value as string | undefined;
    if (!oldest) break;
    reportedTransientPaints.delete(oldest);
  }
  afterNextPaint(() => bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId,
    eventKind: 'transient-painted',
    observedAt: new Date().toISOString(),
    conversationId: message.conversationId,
    turnId: message.turnId,
    modelRequestId: message.modelRequestId,
    ...(message.attemptSeq ? { attemptSeq: message.attemptSeq } : {}),
    ...(message.socketGeneration ? { socketGeneration: message.socketGeneration } : {}),
    streamSeq
  }));
}

function afterNextPaint(callback: () => void): void {
  window.requestAnimationFrame(() => window.requestAnimationFrame(callback));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : undefined;
}

function optionalDecimal(value: unknown): string | undefined {
  return value === undefined ? undefined : decimal(value);
}

function positiveDecimal(value: unknown): string | undefined {
  const normalized = decimal(value);
  return normalized && normalized !== '0' ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function cancelAllDetailRequests(state: ReliableKernelFeedStoreState): void {
  for (const requestId of Object.keys(state.pendingDetails)) {
    detailDecoders.delete(requestId);
    detailTextChunks.delete(requestId);
  }
  for (const pending of Object.values(state.pendingDetails)) {
    if (state.details[pending.key]?.status === 'loading') delete state.details[pending.key];
  }
  for (const [key, detail] of Object.entries(state.details)) {
    if (detail.status === 'error') delete state.details[key];
  }
  state.pendingDetails = {};
  state.detailQueue = [];
  state.activeDetailRequestIds = [];
}

function pruneDetailCache(state: ReliableKernelFeedStoreState): void {
  const candidates = Object.entries(state.detailCacheMeta)
    .filter(([key]) => state.details[key]?.status === 'ready')
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt || left[0].localeCompare(right[0]));
  let totalBytes = candidates.reduce((total, [, meta]) => total + meta.bytes, 0);
  let totalEntries = candidates.length;
  for (const [key, meta] of candidates) {
    if (totalEntries <= DETAIL_CACHE_MAX_ENTRIES && totalBytes <= DETAIL_CACHE_MAX_BYTES) break;
    // Keep the newest/only oversized detail while it is being viewed; otherwise its watcher would
    // immediately request the same payload again and create a hydration loop.
    if (totalEntries <= 1) break;
    delete state.details[key];
    delete state.detailCacheMeta[key];
    totalEntries -= 1;
    totalBytes -= meta.bytes;
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function detailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

function decodeBase64Bytes(chunk: string): Uint8Array {
  const binary = window.atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function detailDecoder(requestId: string): TextDecoder {
  const existing = detailDecoders.get(requestId);
  if (existing) return existing;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  detailDecoders.set(requestId, decoder);
  return decoder;
}

function activeConversationId(projections: Record<string, unknown>): string | undefined {
  return stringValue(plainRecord(projections.activeConversationWindow)?.conversationId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

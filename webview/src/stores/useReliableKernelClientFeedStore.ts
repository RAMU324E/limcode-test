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
import { createMessageId } from '@shared/protocol';
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
  chunks: string[];
}

export interface ReliableKernelTransientState {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  streamSeq: string;
  text: string;
  thought: string;
  thoughtSignature?: string;
  toolCalls: unknown[];
  status: 'streaming' | 'completed';
  startedAt: number;
  updatedAt: number;
}

interface ReliableKernelFeedStoreState extends ReliableKernelBoundedClientState {
  details: Record<string, ReliableKernelDetailState>;
  pendingDetails: Record<string, PendingDetailRequest>;
  detailQueue: string[];
  activeDetailRequestIds: string[];
  transientModelRequests: Record<string, ReliableKernelTransientState>;
}

const DETAIL_CHUNK_MAX_BYTES = 262_144;
const DETAIL_MAX_INFLIGHT_REQUESTS = 4;
const MAX_REPORTED_TRANSIENT_PAINTS = 512;
const reportedTransientPaints = new Set<string>();

export const useReliableKernelClientFeedStore = defineStore('reliableKernelClientFeed', {
  state: (): ReliableKernelFeedStoreState => ({
    ...createEmptyReliableKernelClientState(),
    details: {},
    pendingDetails: {},
    detailQueue: [],
    activeDetailRequestIds: [],
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
      const previousSessionId = this.sessionId;
      const result = applyReliableKernelDataMessage(this.$state, message);
      if (previousSessionId && result.state.sessionId !== previousSessionId) {
        this.details = {};
        this.pendingDetails = {};
        this.detailQueue = [];
        this.activeDetailRequestIds = [];
        this.transientModelRequests = {};
        reportedTransientPaints.clear();
      }
      this.sessionId = result.state.sessionId;
      this.hostBootId = result.state.hostBootId;
      this.lastCommitSeq = result.state.lastCommitSeq;
      this.projections = result.state.projections;
      this.records = result.state.records;
      this.snapshotRequired = result.state.snapshotRequired;
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
      if (!this.hostBootId || message.hostBootId !== this.hostBootId) return;
      const sequence = decimal(message.event.streamSeq);
      if (sequence === undefined) return;
      const current = this.transientModelRequests[message.modelRequestId];
      if (current && BigInt(current.streamSeq) >= BigInt(sequence)) return;
      const content = plainRecord(message.event.content);
      const observedAt = timestamp(message.observedAt) || Date.now();
      const next: ReliableKernelTransientState = current
        ? { ...current, streamSeq: sequence, updatedAt: observedAt }
        : {
            conversationId: message.conversationId,
            turnId: message.turnId,
            modelRequestId: message.modelRequestId,
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
        next.toolCalls = Array.isArray(content?.toolCalls) ? [...content.toolCalls] : next.toolCalls;
        next.status = 'completed';
      } else if (content?.type === 'text_delta') {
        next.text += stringValue(content.text) ?? '';
      } else if (content?.type === 'thought_delta') {
        next.thought += stringValue(content.text) ?? '';
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
      } else if (content?.type === 'tool_calls' && Array.isArray(content.calls)) {
        next.toolCalls = [...content.calls];
      }
      this.transientModelRequests[message.modelRequestId] = next;
      if (!current) reportTransientPaint(this.sessionId, message, sequence);
    },

    requestDetail(kind: ReliableKernelClientDetailKind, recordId: string): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return undefined;
      const key = detailKey(kind, id);
      const current = this.details[key];
      if (current?.status === 'loading' || current?.status === 'ready') return key;
      const requestId = createMessageId();
      this.details[key] = { status: 'loading', text: '', totalBytes: 0 };
      this.pendingDetails[requestId] = { key, kind, recordId: id, chunks: [] };
      this.detailQueue.push(requestId);
      this.pumpDetailQueue();
      return key;
    },

    retryDetail(kind: ReliableKernelClientDetailKind, recordId: string): string | undefined {
      delete this.details[detailKey(kind, recordId)];
      return this.requestDetail(kind, recordId);
    },

    observeDetailResult(message: ReliableKernelDetailResultMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || message.detail.recordId !== pending.recordId) return;
      pending.chunks.push(message.detail.chunk);
      if (message.detail.hasMore && message.detail.nextOffset !== undefined) {
        this.postDetailChunk(message.requestId, message.detail.nextOffset);
        return;
      }
      try {
        this.details[pending.key] = {
          status: 'ready',
          text: decodeBase64Utf8Chunks(pending.chunks),
          totalBytes: message.detail.totalBytes
        };
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
      if (!pending) return;
      this.details[pending.key] = {
        status: 'error',
        text: '',
        totalBytes: 0,
        error: message.message
      };
      this.finishDetailRequest(message.requestId);
    },

    pumpDetailQueue(): void {
      while (
        this.activeDetailRequestIds.length < DETAIL_MAX_INFLIGHT_REQUESTS
        && this.detailQueue.length > 0
      ) {
        const requestId = this.detailQueue.shift();
        if (!requestId || !this.pendingDetails[requestId]) continue;
        this.activeDetailRequestIds.push(requestId);
        this.postDetailChunk(requestId, 0);
      }
    },

    finishDetailRequest(requestId: string): void {
      delete this.pendingDetails[requestId];
      this.activeDetailRequestIds = this.activeDetailRequestIds.filter((id) => id !== requestId);
      this.detailQueue = this.detailQueue.filter((id) => id !== requestId);
      this.pumpDetailQueue();
    },

    postDetailChunk(requestId: string, offset: number): void {
      const pending = this.pendingDetails[requestId];
      const sessionId = this.sessionId;
      if (!pending || !sessionId || !this.activeDetailRequestIds.includes(requestId)) return;
      bridge.postRaw({
        type: RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
        requestId,
        sessionId,
        kind: pending.kind,
        recordId: pending.recordId,
        offset,
        maxBytes: DETAIL_CHUNK_MAX_BYTES
      });
    }
  }
});

export function reliableKernelDetailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return detailKey(kind, recordId);
}

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
  if (!sessionId || reportedTransientPaints.has(message.modelRequestId)) return;
  reportedTransientPaints.add(message.modelRequestId);
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

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function detailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

function decodeBase64Utf8Chunks(chunks: string[]): string {
  const parts = chunks.map((chunk) => {
    const binary = window.atob(chunk);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  });
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

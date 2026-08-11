import { defineStore } from 'pinia';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_CHANGE_TYPES,
  RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
  RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
  RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
  RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_MESSAGE,
  applyReliableKernelDataMessage,
  createEmptyReliableKernelClientState,
  type ReliableKernelBoundedClientState,
  type ReliableKernelClientDetailKind,
  type ReliableKernelDetailErrorMessage,
  type ReliableKernelDetailResultMessage,
  type ReliableKernelHistoryPageErrorMessage,
  type ReliableKernelHistoryPageResultMessage,
  type ReliableKernelTransientBatchMessage,
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
  /** A mutable detail is being extended while its last complete value remains renderable. */
  refreshing?: boolean;
  /** The last background refresh failed. This never invalidates the complete value in `text`. */
  refreshError?: string;
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
  mode: 'initial' | 'refresh';
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
  /** 当前思考块是否仍活动；与整个 Provider 请求的 streaming 状态相互独立。 */
  thoughtActive?: boolean;
  thoughtStartedAt?: number;
  thoughtCompletedDurationMs?: number;
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
  /** Memory-only immutable history prefix for the currently projected Conversation. */
  historyConversationId: string | null;
  historyRecords: ReliableKernelBoundedClientState['records'];
  historyNextBeforeMessageSeq: string | null;
  historyNextBeforeId: string | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historyRequestId: string | null;
  historyLoadedPages: number;
}

const DETAIL_CHUNK_MAX_BYTES = 262_144;
const DETAIL_MAX_INFLIGHT_REQUESTS = 4;
const DETAIL_REQUEST_DEADLINE_MS = 20_000;
// The byte budget remains authoritative. A 256-entry cap evicted many small historical messages
// after roughly eight conversations while leaving most of the 16 MiB budget unused.
const DETAIL_CACHE_MAX_ENTRIES = 1_024;
const DETAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_PAGE_LIMIT = 200;
const MAX_REPORTED_TRANSIENT_PAINTS = 512;
const reportedTransientPaints = new Set<string>();
const detailDecoders = new Map<string, TextDecoder>();
// Streaming pieces stay outside Vue deep reactivity. Reassigning one growing string for every
// frame copies its entire prefix repeatedly; a single final join keeps large details linear.
const detailTextChunks = new Map<string, string[]>();
const detailRequestTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
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
    transientModelRequests: {},
    historyConversationId: null,
    historyRecords: {},
    historyNextBeforeMessageSeq: null,
    historyNextBeforeId: null,
    historyHasMore: false,
    historyLoading: false,
    historyError: null,
    historyRequestId: null,
    historyLoadedPages: 0
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
      if (isReliableKernelHistoryPageResultMessage(message)) {
        this.observeHistoryPageResult(message);
        return;
      }
      if (isReliableKernelHistoryPageErrorMessage(message)) {
        this.observeHistoryPageError(message);
        return;
      }
      if (isReliableKernelTransientBatchMessage(message)) {
        this.observeTransientBatch(message);
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
      const nextConversationId = activeConversationId(result.state.projections);
      const nextVisibleMessages = visibleMessageCount(result.state.projections);
      const previousLoadedFloorCeiling = maximumVisibleMessageFloor(
        this.historyRecords,
        this.records,
        previousConversationId ?? ''
      );
      const continuingLoadedHistory = Boolean(
        result.ack
        && previousConversationId
        && previousConversationId === nextConversationId
        && this.historyConversationId === previousConversationId
        && (this.historyLoadedPages > 0 || this.historyLoading)
      );
      const historyInvalidated = continuingLoadedHistory
        && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
        && nextVisibleMessages < previousLoadedFloorCeiling;
      const nextSuffixFloor = previousConversationId
        ? visibleMessageSuffixFloor(result.state.records.Message ?? {}, previousConversationId)
        : undefined;
      const snapshotSkippedLoadedFloors = continuingLoadedHistory
        && !historyInvalidated
        && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
        && nextSuffixFloor !== undefined
        && previousLoadedFloorCeiling > 0n
        && nextSuffixFloor > previousLoadedFloorCeiling + 1n;
      const rolledMessageIds = continuingLoadedHistory && !historyInvalidated && previousConversationId
        ? rolledOffVisibleMessageIds(this.records, result.state.records, previousConversationId)
        : new Set<string>();
      if (rolledMessageIds.size > 0) {
        this.historyRecords = retainRolledOffLiveRecords(
          this.historyRecords,
          this.records,
          result.state.records,
          rolledMessageIds
        );
      }
      if (continuingLoadedHistory && incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE) {
        this.historyRecords = reconcileHistoryRecordsWithLiveChanges(
          this.historyRecords,
          envelope,
          result.state.records,
          rolledMessageIds
        );
      }
      let replayDetails: Array<{
        kind: ReliableKernelClientDetailKind;
        recordId: string;
        priority: ReliableKernelDetailPriority;
        mode: 'initial' | 'refresh';
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
            priority: pending.priority,
            mode: pending.mode
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
      if (result.ack) {
        if (historyInvalidated) {
          resetHistoryState(this.$state, nextConversationId ?? null);
        } else {
          this.synchronizeHistoryScope(
            nextConversationId ?? '',
            Boolean(previousSessionId && previousSessionId !== result.state.sessionId)
          );
          if (snapshotSkippedLoadedFloors && nextConversationId) {
            this.historyLoading = false;
            this.historyRequestId = null;
            this.historyError = null;
            seedHistoryCursorFromLiveRecords(this.$state, nextConversationId);
          }
        }
      }
      // ACK means the ordered durable state was accepted. Send it before optional detail replay and
      // transient-overlay reconciliation so rendering work cannot head-of-line block the Feed.
      if (result.ack) bridge.postRaw(result.ack);
      for (const detail of replayDetails) {
        if (detail.mode === 'refresh') {
          this.refreshDetail(detail.kind, detail.recordId, { priority: detail.priority });
        } else {
          this.requestDetail(detail.kind, detail.recordId, { priority: detail.priority });
        }
      }
      reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      if (result.ack) {
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

    synchronizeHistoryScope(conversationId: string, sessionChanged: boolean): void {
      const normalized = conversationId.trim();
      if (this.historyConversationId !== (normalized || null)) {
        resetHistoryState(this.$state, normalized || null);
      } else if (sessionChanged) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = null;
      }
      if (!normalized || this.historyLoadedPages > 0 || this.historyLoading) return;
      seedHistoryCursorFromLiveRecords(this.$state, normalized);
    },

    requestEarlierHistory(conversationId: string): boolean {
      const normalized = conversationId.trim();
      const sessionId = this.sessionId;
      if (
        !normalized
        || !sessionId
        || activeConversationId(this.projections) !== normalized
        || this.historyConversationId !== normalized
        || this.historyLoading
        || !this.historyHasMore
      ) return false;
      const beforeMessageSeq = this.historyNextBeforeMessageSeq;
      const beforeId = this.historyNextBeforeId;
      if (!beforeMessageSeq || !beforeId) {
        this.historyError = '更早消息的分页游标不可用。';
        return false;
      }
      const requestId = createMessageId();
      this.historyLoading = true;
      this.historyError = null;
      this.historyRequestId = requestId;
      try {
        bridge.postRaw({
          type: RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
          requestId,
          sessionId,
          conversationId: normalized,
          beforeMessageSeq,
          beforeId,
          limit: HISTORY_PAGE_LIMIT
        });
      } catch (error) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = error instanceof Error ? error.message : '请求更早消息失败。';
        return false;
      }
      return true;
    },

    observeHistoryPageResult(message: ReliableKernelHistoryPageResultMessage): void {
      if (
        message.sessionId !== this.sessionId
        || message.conversationId !== this.historyConversationId
        || message.requestId !== this.historyRequestId
      ) return;
      if (
        message.page.hasMore
        && (!message.page.nextBeforeMessageSeq || !message.page.nextBeforeId)
      ) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = '更早消息页面缺少连续分页游标。';
        return;
      }
      try {
        this.historyRecords = mergeHistoryRecordPage(this.historyRecords, message.page.records);
      } catch (error) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = error instanceof Error ? error.message : '更早消息页面格式无效。';
        return;
      }
      this.historyNextBeforeMessageSeq = message.page.nextBeforeMessageSeq ?? null;
      this.historyNextBeforeId = message.page.nextBeforeId ?? null;
      this.historyHasMore = message.page.hasMore;
      this.historyLoading = false;
      this.historyError = null;
      this.historyRequestId = null;
      this.historyLoadedPages += 1;
    },

    observeHistoryPageError(message: ReliableKernelHistoryPageErrorMessage): void {
      if (
        message.sessionId !== this.sessionId
        || message.conversationId !== this.historyConversationId
        || message.requestId !== this.historyRequestId
      ) return;
      this.historyLoading = false;
      this.historyRequestId = null;
      this.historyError = message.message.trim() || '读取更早消息失败。';
    },

    observeTransientBatch(message: ReliableKernelTransientBatchMessage): void {
      for (const event of message.events) {
        this.observeTransient({
          type: RELIABLE_KERNEL_TRANSIENT_MESSAGE,
          ...event,
          sessionId: message.sessionId,
          ...(message.navigationGeneration ? { navigationGeneration: message.navigationGeneration } : {}),
          hostBootId: message.hostBootId,
          conversationId: message.conversationId
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
        const thoughtDurationMs = nonNegativeNumber(content?.thoughtDurationMs)
          ?? next.thoughtDurationMs
          ?? (next.thoughtActive
            ? (next.thoughtCompletedDurationMs ?? 0) + currentTransientThoughtDurationMs(next, observedAt)
            : next.thoughtCompletedDurationMs);
        if (thoughtDurationMs !== undefined) {
          next.thoughtDurationMs = thoughtDurationMs;
          next.thoughtCompletedDurationMs = thoughtDurationMs;
        }
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
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
        if (next.thoughtActive) {
          next.thoughtDurationMs = (next.thoughtCompletedDurationMs ?? 0)
            + currentTransientThoughtDurationMs(next, observedAt);
          next.thoughtCompletedDurationMs = next.thoughtDurationMs;
        }
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
      } else if (content?.type === 'text_delta') {
        next.text += stringValue(content.text) ?? '';
      } else if (content?.type === 'thought_delta') {
        next.thought += stringValue(content.text) ?? '';
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        openTransientThought(next, content, observedAt);
      } else if (content?.type === 'thought_progress') {
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        openTransientThought(next, content, observedAt);
      } else if (content?.type === 'thought_done') {
        const thoughtDurationMs = nonNegativeNumber(content.thoughtDurationMs)
          ?? nonNegativeNumber(content.thoughtCompletedDurationMs)
          ?? (next.thoughtCompletedDurationMs ?? 0) + currentTransientThoughtDurationMs(next, observedAt);
        next.thoughtDurationMs = thoughtDurationMs;
        next.thoughtCompletedDurationMs = thoughtDurationMs;
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
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
      // A streaming delta cannot retire any overlay. Full reconciliation scans the bounded durable
      // window and is needed only at terminal events or durable Feed commits.
      if (next.status !== 'streaming') {
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      }
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
        const priority = options.priority ?? 'visible';
        const pending = Object.values(this.pendingDetails).find((request) => request.key === key);
        if (pending && DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[pending.priority]) {
          pending.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
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
        enqueuedAt: Date.now(),
        mode: 'initial'
      };
      this.detailQueue.push(requestId);
      this.sortDetailQueue();
      this.pumpDetailQueue();
      return key;
    },

    reloadDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const id = recordId.trim();
      if (!id) return undefined;
      const key = detailKey(kind, id);
      const cancelledRequestIds = Object.entries(this.pendingDetails)
        .filter(([, pending]) => pending.key === key)
        .map(([requestId]) => requestId);
      for (const requestId of cancelledRequestIds) {
        const timeout = detailRequestTimeouts.get(requestId);
        if (timeout !== undefined) clearTimeout(timeout);
        detailRequestTimeouts.delete(requestId);
        detailDecoders.delete(requestId);
        detailTextChunks.delete(requestId);
        delete this.pendingDetails[requestId];
      }
      if (cancelledRequestIds.length > 0) {
        const cancelled = new Set(cancelledRequestIds);
        this.detailQueue = this.detailQueue.filter((requestId) => !cancelled.has(requestId));
        this.activeDetailRequestIds = this.activeDetailRequestIds.filter((requestId) => !cancelled.has(requestId));
      }
      delete this.details[key];
      delete this.detailCacheMeta[key];
      const requested = this.requestDetail(kind, id, options);
      this.pumpDetailQueue();
      return requested;
    },

    retryDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const key = detailKey(kind, recordId);
      const current = this.details[key];
      if (current?.status === 'ready') {
        return this.refreshDetail(kind, recordId, options);
      }
      delete this.details[key];
      delete this.detailCacheMeta[key];
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
      const existing = Object.values(this.pendingDetails).find((request) => request.key === key);
      if (existing) {
        const priority = options.priority ?? 'visible';
        if (DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[existing.priority]) {
          existing.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        return key;
      }
      const requestId = createMessageId();
      this.details[key] = {
        status: 'ready',
        text: current.text,
        totalBytes: current.totalBytes,
        refreshing: true
      };
      detailTextChunks.set(requestId, [current.text]);
      this.pendingDetails[requestId] = {
        key,
        kind,
        recordId: id,
        nextOffset: current.totalBytes,
        sessionId,
        priority: options.priority ?? 'visible',
        enqueuedAt: Date.now(),
        mode: 'refresh'
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
        this.failDetailRequest(
          message.requestId,
          '详情分块不连续；未将不完整内容标记为已就绪。',
          message.detail.totalBytes
        );
        return;
      }
      const bytes = decodeBase64Bytes(message.detail.chunk);
      const nextOffset = message.detail.offset + bytes.byteLength;
      if (
        nextOffset > message.detail.totalBytes
        || (message.detail.hasMore && message.detail.nextOffset !== nextOffset)
        || (!message.detail.hasMore && nextOffset !== message.detail.totalBytes)
      ) {
        this.failDetailRequest(
          message.requestId,
          '对话详情数据不完整，请重新加载。',
          message.detail.totalBytes
        );
        return;
      }
      pending.nextOffset = nextOffset;
      pending.totalBytes = message.detail.totalBytes;
      const decoder = detailDecoder(message.requestId);
      const currentDetail = this.details[pending.key];
      const requestOwnsDetail = pending.mode === 'refresh'
        ? currentDetail?.status === 'ready' && currentDetail.refreshing === true
        : currentDetail?.status === 'loading';
      if (!currentDetail || !requestOwnsDetail) {
        this.finishDetailRequest(message.requestId);
        return;
      }
      try {
        detailTextChunks.get(message.requestId)?.push(
          decoder.decode(bytes, { stream: message.detail.hasMore })
        );
        if (pending.mode === 'initial') currentDetail.totalBytes = message.detail.totalBytes;
      } catch (error) {
        this.failDetailRequest(
          message.requestId,
          error instanceof Error ? error.message : '详情内容解码失败。',
          message.detail.totalBytes
        );
        return;
      }
      if (message.detail.hasMore && message.detail.nextOffset !== undefined) {
        this.postDetailChunk(message.requestId, message.detail.nextOffset);
        return;
      }
      try {
        const chunks = detailTextChunks.get(message.requestId) ?? [];
        chunks.push(decoder.decode());
        this.details[pending.key] = {
          status: 'ready',
          text: chunks.join(''),
          totalBytes: message.detail.totalBytes
        };
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
        this.failDetailRequest(
          message.requestId,
          error instanceof Error ? error.message : '详情内容解码失败。',
          message.detail.totalBytes
        );
        return;
      }
      this.finishDetailRequest(message.requestId);
    },

    observeDetailError(message: ReliableKernelDetailErrorMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId) return;
      this.failDetailRequest(message.requestId, message.message);
    },

    failDetailRequest(requestId: string, error: string, totalBytes?: number): void {
      const pending = this.pendingDetails[requestId];
      if (!pending) return;
      const current = this.details[pending.key];
      if (pending.mode === 'refresh' && current?.status === 'ready') {
        this.details[pending.key] = {
          status: 'ready',
          text: current.text,
          totalBytes: current.totalBytes,
          refreshError: error
        };
      } else {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: totalBytes ?? current?.totalBytes ?? 0,
          error
        };
      }
      this.finishDetailRequest(requestId);
    },

    expireDetailRequest(requestId: string): void {
      if (!this.pendingDetails[requestId]) return;
      this.failDetailRequest(requestId, '详情请求超时，可重试。');
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
      const timeout = detailRequestTimeouts.get(requestId);
      if (timeout !== undefined) clearTimeout(timeout);
      detailRequestTimeouts.delete(requestId);
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
      const priorTimeout = detailRequestTimeouts.get(requestId);
      if (priorTimeout !== undefined) clearTimeout(priorTimeout);
      detailRequestTimeouts.set(requestId, setTimeout(() => {
        detailRequestTimeouts.delete(requestId);
        this.expireDetailRequest(requestId);
      }, DETAIL_REQUEST_DEADLINE_MS));
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
    || isReliableKernelHistoryPageResultMessage(message)
    || isReliableKernelHistoryPageErrorMessage(message)
    || isReliableKernelTransientBatchMessage(message)
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

function isReliableKernelHistoryPageResultMessage(message: unknown): message is ReliableKernelHistoryPageResultMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE
    && isRecord(message.page)
    && isRecord(message.page.records);
}

function isReliableKernelHistoryPageErrorMessage(message: unknown): message is ReliableKernelHistoryPageErrorMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE;
}

function isReliableKernelTransientBatchMessage(message: unknown): message is ReliableKernelTransientBatchMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE
    && Array.isArray(message.events)
    && message.events.every((event) => isRecord(event) && isRecord(event.event));
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

function resetHistoryState(
  state: ReliableKernelFeedStoreState,
  conversationId: string | null
): void {
  state.historyConversationId = conversationId;
  state.historyRecords = {};
  state.historyNextBeforeMessageSeq = null;
  state.historyNextBeforeId = null;
  state.historyHasMore = false;
  state.historyLoading = false;
  state.historyError = null;
  state.historyRequestId = null;
  state.historyLoadedPages = 0;
  if (conversationId) seedHistoryCursorFromLiveRecords(state, conversationId);
}

function seedHistoryCursorFromLiveRecords(
  state: ReliableKernelFeedStoreState,
  conversationId: string
): void {
  const suffixFloor = visibleMessageSuffixFloor(state.records.Message ?? {}, conversationId);
  const oldest = Object.values(state.records.Message ?? {})
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const id = nonEmptyString(message.id);
      const messageSeq = integerString(message.message_seq);
      const displaySeq = integerString(message.display_seq);
      return id && messageSeq && displaySeq && BigInt(displaySeq) === suffixFloor
        ? [{ id, messageSeq }]
        : [];
    })
    .sort((left, right) => compareIntegerStrings(left.messageSeq, right.messageSeq)
      || left.id.localeCompare(right.id))[0];
  const hasMore = Boolean(oldest && suffixFloor && suffixFloor > 1n);
  state.historyHasMore = hasMore;
  state.historyNextBeforeMessageSeq = hasMore ? oldest!.messageSeq : null;
  state.historyNextBeforeId = hasMore ? oldest!.id : null;
}

function visibleMessageCount(projections: Record<string, unknown>): bigint {
  const count = integerString(plainRecord(projections.activeConversationWindow)?.visibleMessageCount);
  return count ? BigInt(count) : 0n;
}

function maximumVisibleMessageFloor(
  history: ReliableKernelBoundedClientState['records'],
  live: ReliableKernelBoundedClientState['records'],
  conversationId: string
): bigint {
  let maximum = 0n;
  for (const bucket of [history.Message ?? {}, live.Message ?? {}]) {
    for (const message of Object.values(bucket)) {
      if (!isVisibleConversationMessage(message, conversationId)) continue;
      const displaySeq = integerString(message.display_seq);
      if (displaySeq && BigInt(displaySeq) > maximum) maximum = BigInt(displaySeq);
    }
  }
  return maximum;
}

/**
 * Once history has been requested, a bounded live window must hand records that roll out of its
 * front to the memory-only prefix. Its full causal bundle is copied at that boundary even when a
 * dependency remains live for a later Message; subsequent live changes keep overlapping ids fresh.
 */
function retainRolledOffLiveRecords(
  history: ReliableKernelBoundedClientState['records'],
  previousLive: ReliableKernelBoundedClientState['records'],
  nextLive: ReliableKernelBoundedClientState['records'],
  rolledMessageIds: ReadonlySet<string>
): ReliableKernelBoundedClientState['records'] {
  const causalRecordIds = rolledMessageCausalRecordIds(previousLive, rolledMessageIds);

  let changed = false;
  const retained = { ...history };
  for (const [type, previousBucket] of Object.entries(previousLive)) {
    let retainedBucket = retained[type];
    for (const [id, record] of Object.entries(previousBucket)) {
      if (!causalRecordIds[type]?.has(id)) continue;
      if (!changed || retainedBucket === history[type]) retainedBucket = { ...(retainedBucket ?? {}) };
      retainedBucket[id] = nextLive[type]?.[id] ?? record;
      changed = true;
    }
    if (retainedBucket && retainedBucket !== retained[type]) retained[type] = retainedBucket;
  }
  return changed ? retained : history;
}

function rolledOffVisibleMessageIds(
  previousLive: ReliableKernelBoundedClientState['records'],
  nextLive: ReliableKernelBoundedClientState['records'],
  conversationId: string
): Set<string> {
  const nextMessages = nextLive.Message ?? {};
  const nextSuffixFloor = visibleMessageSuffixFloor(nextMessages, conversationId);
  if (nextSuffixFloor === undefined) return new Set();
  return new Set(Object.values(previousLive.Message ?? {})
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const id = nonEmptyString(message.id);
      const displaySeq = integerString(message.display_seq);
      return id && displaySeq && BigInt(displaySeq) < nextSuffixFloor && !nextMessages[id]
        ? [id]
        : [];
    }));
}

/** Mirrors the backend history-page closure without traversing sideways through a shared Turn. */
function rolledMessageCausalRecordIds(
  records: ReliableKernelBoundedClientState['records'],
  messageIds: ReadonlySet<string>
): Record<string, Set<string>> {
  const kept: Record<string, Set<string>> = {};
  const rows = (type: string): Array<Record<string, unknown>> => Object.values(records[type] ?? {});
  const value = (row: Record<string, unknown>, field: string): string | undefined =>
    nonEmptyString(row[field]);
  const byId = (type: string, ids: ReadonlySet<string>): Array<Record<string, unknown>> =>
    rows(type).filter((row) => {
      const id = value(row, 'id');
      return Boolean(id && ids.has(id));
    });
  const byField = (
    type: string,
    field: string,
    ids: ReadonlySet<string>
  ): Array<Record<string, unknown>> => rows(type).filter((row) => {
    const id = value(row, field);
    return Boolean(id && ids.has(id));
  });
  const idsFrom = (selected: readonly Record<string, unknown>[], field: string): Set<string> =>
    new Set(selected.flatMap((row) => {
      const id = value(row, field);
      return id ? [id] : [];
    }));
  const union = (...sets: ReadonlySet<string>[]): Set<string> =>
    new Set(sets.flatMap((set) => [...set]));
  const include = (type: string, selected: readonly Record<string, unknown>[]): void => {
    for (const id of idsFrom(selected, 'id')) (kept[type] ??= new Set()).add(id);
  };

  include('Message', byId('Message', messageIds));
  const messageTurnLinks = byField('MessageTurnLink', 'message_id', messageIds);
  const requestMessageLinks = byField('ModelRequestMessageLink', 'message_id', messageIds);
  const sourceLinks = byField('ToolCallSourceLink', 'message_id', messageIds);
  include('MessageTurnLink', messageTurnLinks);
  include('ModelRequestMessageLink', requestMessageLinks);
  include('ToolCallSourceLink', sourceLinks);

  const requestIds = union(
    idsFrom(requestMessageLinks, 'model_request_id'),
    idsFrom(sourceLinks, 'model_request_id')
  );
  const modelRequests = byId('ModelRequest', requestIds);
  include('ModelRequest', modelRequests);

  const toolCallIds = idsFrom(sourceLinks, 'tool_call_id');
  const toolCalls = byId('ToolCall', toolCallIds);
  include('ToolCall', toolCalls);
  for (const type of [
    'ToolCallPolicySnapshot',
    'ToolCallEvent',
    'ToolExecution',
    'ToolOutcome',
    'ToolModelResult',
    'ToolResultArtifact'
  ]) {
    include(type, byField(type, 'tool_call_id', toolCallIds));
  }

  const interactionToolLinks = byField('InteractionToolCallLink', 'tool_call_id', toolCallIds);
  const interactionRequestIds = idsFrom(interactionToolLinks, 'request_id');
  const interactionRequests = byId('InteractionRequest', interactionRequestIds);
  const interactionOwnerLinks = byField('InteractionOwnerLink', 'request_id', interactionRequestIds);
  include('InteractionToolCallLink', interactionToolLinks);
  include('InteractionRequest', interactionRequests);
  include('InteractionOwnerLink', interactionOwnerLinks);
  include('InteractionResponse', byField('InteractionResponse', 'request_id', interactionRequestIds));

  const fileChangeSets = byField('FileChangeSet', 'tool_call_id', toolCallIds);
  const fileChangeSetIds = idsFrom(fileChangeSets, 'id');
  const mutationReceipts = byField('FileMutationReceipt', 'change_set_id', fileChangeSetIds);
  include('FileChangeSet', fileChangeSets);
  include('FileChangeSetMember', byField('FileChangeSetMember', 'change_set_id', fileChangeSetIds));
  include('FileChangeDecision', byField('FileChangeDecision', 'change_set_id', fileChangeSetIds));
  include('FileMutationReceipt', mutationReceipts);
  include('FileMutationReceiptMember', byField(
    'FileMutationReceiptMember',
    'receipt_id',
    idsFrom(mutationReceipts, 'id')
  ));

  const processOriginLinks = byField('ProcessOriginLink', 'tool_call_id', toolCallIds);
  const processIds = idsFrom(processOriginLinks, 'process_id');
  include('ProcessOriginLink', processOriginLinks);
  include('Process', byId('Process', processIds));
  include('ProcessReceipt', byField('ProcessReceipt', 'process_id', processIds));

  const childParentLinks = byField('ChildExecutionParentLink', 'source_tool_call_id', toolCallIds);
  const childExecutionIds = idsFrom(childParentLinks, 'child_execution_id');
  const childExecutions = byId('ChildExecution', childExecutionIds);
  const childActiveLinks = byField('ChildExecutionActiveTurnLink', 'child_execution_id', childExecutionIds);
  const childTurnLinks = byField('ChildExecutionTurnLink', 'child_execution_id', childExecutionIds);
  const childTurnIds = union(
    idsFrom(childActiveLinks, 'turn_id'),
    idsFrom(childTurnLinks, 'turn_id')
  );
  include('ChildExecutionParentLink', childParentLinks);
  include('ChildExecution', childExecutions);
  include('ChildExecutionActiveTurnLink', childActiveLinks);
  include('ChildExecutionTurnLink', childTurnLinks);
  include('AgentConversationLink', byField(
    'AgentConversationLink',
    'conversation_id',
    idsFrom(childExecutions, 'child_conversation_id')
  ));

  const answerBridges = byField('AnswerBridge', 'child_execution_id', childExecutionIds);
  include('AnswerBridge', answerBridges);
  include('AnswerSubmission', byId(
    'AnswerSubmission',
    idsFrom(answerBridges, 'current_submission_id')
  ));

  const turnIds = union(
    idsFrom(messageTurnLinks, 'turn_id'),
    idsFrom(modelRequests, 'turn_id'),
    idsFrom(toolCalls, 'turn_id'),
    idsFrom(interactionOwnerLinks, 'turn_id'),
    idsFrom(childParentLinks, 'parent_turn_id'),
    childTurnIds
  );
  include('Turn', byId('Turn', turnIds));
  include('ExecutionLease', byField('ExecutionLease', 'turn_id', turnIds));
  include('TurnTermination', byField('TurnTermination', 'turn_id', turnIds));
  include('TurnExecutorLink', byField('TurnExecutorLink', 'turn_id', turnIds));
  return kept;
}

/** Keeps mutable historical summaries aligned with any later live upsert/remove for the same id. */
function reconcileHistoryRecordsWithLiveChanges(
  history: ReliableKernelBoundedClientState['records'],
  envelope: Record<string, unknown> | undefined,
  nextLive: ReliableKernelBoundedClientState['records'],
  rolledMessageIds: ReadonlySet<string>
): ReliableKernelBoundedClientState['records'] {
  const changes = Array.isArray(envelope?.changes) ? envelope.changes : [];
  let next = history;
  const copiedTypes = new Set<string>();
  for (const value of changes) {
    const change = plainRecord(value);
    const type = nonEmptyString(change?.type);
    const id = nonEmptyString(change?.id);
    if (!type || !id || !history[type]?.[id]) continue;
    if (type === 'Message' && change?.operation === 'remove' && rolledMessageIds.has(id)) continue;
    if (next === history) next = { ...history };
    if (!copiedTypes.has(type)) {
      next[type] = { ...(history[type] ?? {}) };
      copiedTypes.add(type);
    }
    const liveRecord = nextLive[type]?.[id];
    if (change?.operation === 'remove' || !liveRecord) {
      delete next[type][id];
    } else {
      next[type][id] = liveRecord;
    }
  }
  return next;
}

/** Finds the first row in the newest contiguous display-rank suffix, ignoring pinned old anchors. */
function visibleMessageSuffixFloor(
  messages: Record<string, Record<string, unknown>>,
  conversationId: string
): bigint | undefined {
  const ranks = Object.values(messages)
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const displaySeq = integerString(message.display_seq);
      return displaySeq && displaySeq !== '0' ? [BigInt(displaySeq)] : [];
    })
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  let floor = ranks[ranks.length - 1];
  if (floor === undefined) return undefined;
  for (let index = ranks.length - 2; index >= 0; index -= 1) {
    if (ranks[index] !== floor - 1n) break;
    floor = ranks[index];
  }
  return floor;
}

function isVisibleConversationMessage(
  message: Record<string, unknown>,
  conversationId: string
): boolean {
  return message.conversation_id === conversationId
    && (message.deleted_at === null || message.deleted_at === undefined)
    && (message.role === 'user' || message.role === 'model');
}

function mergeHistoryRecordPage(
  current: ReliableKernelBoundedClientState['records'],
  page: ReliableKernelHistoryPageResultMessage['page']['records']
): ReliableKernelBoundedClientState['records'] {
  const next = { ...current };
  for (const [type, rows] of Object.entries(page)) {
    if (!RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(type as never)) {
      throw new TypeError(`更早消息页面包含未知记录类型：${type}`);
    }
    if (!Array.isArray(rows)) throw new TypeError(`更早消息页面的 ${type} 记录无效。`);
    const bucket = { ...(next[type] ?? {}) };
    for (const row of rows) {
      if (!isRecord(row) || !nonEmptyString(row.id)) {
        throw new TypeError(`更早消息页面的 ${type} 记录缺少稳定 id。`);
      }
      bucket[row.id as string] = row;
    }
    next[type] = bucket;
  }
  return next;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  return undefined;
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function cancelAllDetailRequests(state: ReliableKernelFeedStoreState): void {
  for (const requestId of Object.keys(state.pendingDetails)) {
    const timeout = detailRequestTimeouts.get(requestId);
    if (timeout !== undefined) clearTimeout(timeout);
    detailRequestTimeouts.delete(requestId);
    detailDecoders.delete(requestId);
    detailTextChunks.delete(requestId);
  }
  for (const pending of Object.values(state.pendingDetails)) {
    const detail = state.details[pending.key];
    if (detail?.status === 'loading') {
      delete state.details[pending.key];
    } else if (pending.mode === 'refresh' && detail?.status === 'ready') {
      state.details[pending.key] = {
        status: 'ready',
        text: detail.text,
        totalBytes: detail.totalBytes
      };
    }
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

function openTransientThought(
  state: ReliableKernelTransientState,
  content: Record<string, unknown>,
  observedAt: number
): void {
  const incomingElapsedMs = nonNegativeNumber(content.thoughtElapsedMs);
  const incomingStartedAt = positiveNumber(content.thoughtStartedAt);
  const blockChanged = state.thoughtActive !== true
    || (incomingStartedAt !== undefined && incomingStartedAt !== state.thoughtStartedAt);
  const completedDurationMs = nonNegativeNumber(content.thoughtCompletedDurationMs)
    ?? state.thoughtCompletedDurationMs
    ?? state.thoughtDurationMs
    ?? 0;

  state.thoughtActive = true;
  state.thoughtCompletedDurationMs = completedDurationMs;
  state.thoughtStartedAt = incomingStartedAt
    ?? (blockChanged
      ? Math.max(1, observedAt - (incomingElapsedMs ?? 0))
      : state.thoughtStartedAt);
  if (incomingElapsedMs !== undefined) state.thoughtElapsedMs = incomingElapsedMs;
  else if (blockChanged) delete state.thoughtElapsedMs;
  // thoughtDurationMs is a terminal cumulative fact. A new block explicitly reopens thinking.
  delete state.thoughtDurationMs;
}

function currentTransientThoughtDurationMs(
  state: ReliableKernelTransientState,
  observedAt: number
): number {
  const authoritativeElapsedMs = state.thoughtElapsedMs ?? 0;
  if (state.thoughtStartedAt === undefined || !Number.isFinite(observedAt)) return authoritativeElapsedMs;
  return Math.max(
    authoritativeElapsedMs,
    Math.max(0, Math.round(observedAt - state.thoughtStartedAt))
  );
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

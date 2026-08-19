import type {
  LlmInvocationSettingsSnapshotRecord,
  LlmRawErrorInfoRecord,
  LlmUsageMetadataRecord,
  MessageContent,
  ModelOutputItemReference
} from '../../../../shared/protocol';
import type { LlmCompactResult } from './contracts';

export const LlmEventType = {
  InvocationResolved: 'llm:invocationResolved',
  InvocationResolveError: 'llm:invocationResolveError',
  Started: 'llm:started',
  Delta: 'llm:delta',
  ThoughtDelta: 'llm:thoughtDelta',
  ThoughtProgress: 'llm:thoughtProgress',
  ThoughtDone: 'llm:thoughtDone',
  OutputItemDone: 'llm:outputItemDone',
  ToolCallDelta: 'llm:toolCallDelta',
  ToolCallPreviewDone: 'llm:toolCallPreviewDone',
  ToolCall: 'llm:toolcall',
  Done: 'llm:done',
  Error: 'llm:error',
  RetryScheduled: 'llm:retryScheduled',
  RetryStarted: 'llm:retryStarted',
  RetryCancelled: 'llm:retryCancelled',
  RetryRecovered: 'llm:retryRecovered',
  CompactDone: 'llm:compactDone',
  CompactError: 'llm:compactError'
} as const;

export interface LlmStreamEpochPayload {
  attemptId?: string;
  generation?: number;
  streamSeq?: number;
}

export interface LlmStartedPayload extends LlmStreamEpochPayload {
  requestId: string;
  invocationId?: string;
  model?: string;
  startedAt?: number;
}
export interface LlmInvocationResolvedPayload {
  invocationId: string;
  requestId: string;
  settings: LlmInvocationSettingsSnapshotRecord;
  resolvedAt: number;
}
export interface LlmInvocationResolveErrorPayload {
  invocationId: string;
  requestId: string;
  message: string;
  resolvedAt: number;
}
export interface LlmDeltaPayload extends LlmStreamEpochPayload {
  requestId: string;
  text: string;
  outputItem?: ModelOutputItemReference;
}
export interface LlmThoughtDeltaPayload extends LlmStreamEpochPayload {
  requestId: string;
  text: string;
  outputItem?: ModelOutputItemReference;
  thoughtSignature?: string;
  /** 当前思考块开始的权威墙钟时间；前端据此本地插值，不依赖高频后端 tick。 */
  thoughtStartedAt?: number;
  thoughtElapsedMs?: number;
}
export interface LlmThoughtProgressPayload extends LlmStreamEpochPayload {
  requestId: string;
  outputItem?: ModelOutputItemReference;
  /** 当前思考块开始的权威墙钟时间。 */
  thoughtStartedAt?: number;
  thoughtElapsedMs: number;
  thoughtSignature?: string;
}
export interface LlmThoughtDonePayload extends LlmStreamEpochPayload {
  requestId: string;
  outputItem?: ModelOutputItemReference;
  /** 本次完成的思考块开始时间，用于可靠层区分并累计多个块。 */
  thoughtStartedAt?: number;
  thoughtDurationMs: number;
  thoughtSignature?: string;
}
export interface LlmOutputItemDonePayload extends LlmStreamEpochPayload {
  requestId: string;
  outputItem: ModelOutputItemReference;
}
export interface LlmToolCallDeltaPayload extends LlmStreamEpochPayload {
  requestId: string;
  outputItem?: ModelOutputItemReference;
  calls: Array<{
    id: string;
    name?: string;
    argumentsDelta: string;
    replace?: boolean;
    streamIndex?: string;
  }>;
}
export interface LlmToolCallPreviewDonePayload extends LlmStreamEpochPayload {
  requestId: string;
  callIds?: string[];
  all?: boolean;
}
export interface LlmToolCallPayload extends LlmStreamEpochPayload {
  requestId: string;
  outputItem?: ModelOutputItemReference;
  calls: Array<{ id?: string; name: string; argsJson: string; thoughtSignature?: string }>;
}
export interface LlmStreamAggregationMetrics {
  intervalMs: number;
  rawDeltaEvents: number;
  emittedDeltaEvents: number;
  mergedDeltaEvents: number;
  flushCount: number;
  maxBatchEvents: number;
  maxBufferedChars: number;
  maxBufferDelayMs: number;
}

export interface LlmDonePayload extends LlmStreamEpochPayload {
  requestId: string;
  /** Exact ordered model content when the provider can prove a terminal projection. */
  content?: MessageContent;
  createdAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  streamAggregation?: LlmStreamAggregationMetrics;
}
export interface LlmErrorPayload extends LlmStreamEpochPayload {
  requestId: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  createdAt?: number;
  streamOutputDurationMs?: number;
  streamAggregation?: LlmStreamAggregationMetrics;
}
export interface LlmRetryPayload extends LlmStreamEpochPayload {
  requestId: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt: number;
  retryMaxAttempts: number;
  retryDelayMs?: number;
  createdAt: number;
}
export interface LlmCompactDonePayload {
  requestId: string;
  blockId: string;
  conversationId: string;
  result: LlmCompactResult;
  completedAt: number;
}
export interface LlmCompactErrorPayload {
  requestId: string;
  blockId: string;
  conversationId: string;
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  retryAttempt?: number;
  retryMaxAttempts?: number;
  completedAt: number;
}

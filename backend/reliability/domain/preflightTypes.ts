import type {
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord,
  CompressionModelContextProjectionLinkRecord,
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord,
  ConversationCheckpointRepositoryLinkRecord,
  ShadowRepositoryRecord,
  ToolSchedulingMode
} from '../../../shared/protocol';
import type { JsonValue, OperationRecord, PrimaryEffectDescriptor } from '../../../shared/conversationReliability';
import type {
  AttemptId,
  EffectIntentId,
  InvocationId,
  MessageId,
  OperationId,
  RequestId,
  RunId,
  ToolCallEventId,
  ToolCallId
} from '../../../shared/stableIds';
import type { ShadowCheckpointCreateRequest } from '../../capabilities/types';
import type { LlmCompactRequest, LlmCompactResult, LlmStartRequest } from '../../world/modules/llm/contracts';

export interface ReliableProgressIds {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface ReliablePlannedToolCall {
  toolCallId: ToolCallId;
  toolCallEventId: ToolCallEventId;
  functionCallId?: string;
  name: string;
  argsJson: string;
  thoughtSignature?: string;
  schedulingOrdinal: number;
  schedulingMode: ToolSchedulingMode;
  schedulingReason?: string;
  execution: 'runtime' | 'agentRun' | 'waiting_user' | 'waiting_plan_review' | 'waiting_approval';
  operationId?: OperationId;
  attemptId?: AttemptId;
  effectIntentId?: EffectIntentId;
  recoveryPolicy?: PrimaryEffectDescriptor['recoveryPolicy'];
  timeoutPolicy?: OperationRecord['timeoutPolicy'];
  deadlineMs?: number;
  effectPayload?: JsonValue;
  approval?: {
    kind: string;
    recoveryPolicy: PrimaryEffectDescriptor['recoveryPolicy'];
    timeoutPolicy: OperationRecord['timeoutPolicy'];
    deadlineMs: number;
    effectPayload: JsonValue;
  };
}

export interface ReliablePostLlmContinuation {
  kind: 'llm_success';
  modelMessageId: MessageId;
  toolCalls: ReliablePlannedToolCall[];
}

export interface ReliableContextBuildInput {
  runId: RunId;
  invocationId: InvocationId;
  requestId: RequestId;
  modelMessageId: MessageId;
  skipCompression?: boolean;
}

export interface ReliableCompressionBarrierPlan {
  block: CompressionBlockRecord;
  sourceLinks: CompressionBlockSourceLinkRecord[];
  variantId: string;
  compactRequest: LlmCompactRequest;
  contextProjection: {
    projection: Omit<ModelContextProjectionRecord, 'createdAt'>;
    sources: ModelContextProjectionSourceLinkRecord[];
    compressionLink: Omit<CompressionModelContextProjectionLinkRecord, 'createdAt'>;
  };
}

export interface ReliableCheckpointBarrierPlan {
  repository: ShadowRepositoryRecord;
  repositoryLink: ConversationCheckpointRepositoryLinkRecord;
  checkpoint: CheckpointRecord;
  anchor?: CheckpointTimelineAnchorRecord;
  createRequest: ShadowCheckpointCreateRequest;
}

export type ReliableBarrierContinuation =
  | {
      kind: 'context_rebuild';
      ids: ReliableProgressIds;
      input: ReliableContextBuildInput;
    }
  | {
      kind: 'llm_request';
      ids: ReliableProgressIds;
      request: LlmStartRequest;
    };

export type ReliableLlmPreflightStep =
  | {
      kind: 'compression';
      ids: ReliableProgressIds;
      plan: ReliableCompressionBarrierPlan;
      continuation: Extract<ReliableBarrierContinuation, { kind: 'context_rebuild' }>;
    }
  | {
      kind: 'checkpoint';
      ids: ReliableProgressIds;
      plan: ReliableCheckpointBarrierPlan;
      continuation: Extract<ReliableBarrierContinuation, { kind: 'llm_request' }>;
    }
  | {
      kind: 'llm_request';
      ids: ReliableProgressIds;
      request: LlmStartRequest;
    };

export type ReliableBarrierEffectPayload =
  | {
      barrier: 'compression.pre_llm';
      plan: ReliableCompressionBarrierPlan;
      continuation: Extract<ReliableBarrierContinuation, { kind: 'context_rebuild' }>;
    }
  | {
      barrier: 'compression.standalone';
      trigger: 'manual' | 'auto';
      plan: ReliableCompressionBarrierPlan;
    }
  | {
      barrier: 'checkpoint.before_llm';
      plan: ReliableCheckpointBarrierPlan;
      continuation: Extract<ReliableBarrierContinuation, { kind: 'llm_request' }>;
    }
  | {
      barrier: 'checkpoint.after_llm';
      plan: ReliableCheckpointBarrierPlan;
      continuation: ReliablePostLlmContinuation;
    };

export interface ReliableCompressionResult {
  outcome: 'succeeded' | 'failed';
  completedAt: number;
  result?: LlmCompactResult;
  error?: string;
}

export function isReliableBarrierEffectPayload(value: JsonValue): value is ReliableBarrierEffectPayload & JsonValue {
  return !!value
    && !Array.isArray(value)
    && typeof value === 'object'
    && (value.barrier === 'compression.pre_llm'
      || (value.barrier === 'compression.standalone' && (value.trigger === 'manual' || value.trigger === 'auto'))
      || value.barrier === 'checkpoint.before_llm'
      || value.barrier === 'checkpoint.after_llm');
}

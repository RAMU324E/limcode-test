import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  AgentRunSourceKind,
  ConversationBranchKind,
  ConversationOriginKind,
  LlmCompressionMethodKind,
  LlmUsageMetadataRecord,
  MessageContent,
  MessagePresentation,
  MessageRevisionReason,
  MessageMaterializationStatus,
  MsgRole
} from '../../../../shared/protocol';
import type { AttemptId } from '../../../../shared/stableIds';

export interface ConversationData {
  id: string;
  title?: string;
  visibility?: 'visible' | 'hidden' | 'collapsed';
}
export const Conversation = defineComponent<ConversationData>('Conversation');

/** Explicit conversation chronology; stable IDs never carry business time semantics. */
export interface ConversationTimelineData {
  createdAt: number;
  lastActivityAt: number;
}
export const ConversationTimeline = defineComponent<ConversationTimelineData>('ConversationTimeline');
export const ConversationFullContextPending = defineComponent<{ startedAt: number }>('ConversationFullContextPending');
export const ConversationFullContextLoaded = defineComponent<{ loadedAt: number }>('ConversationFullContextLoaded');

export interface ConversationReuseLinkData {
  id: string;
  key: string;
  conversation: Entity;
  agent?: Entity;
  createdAt: number;
  updatedAt: number;
}
export const ConversationReuseLink = defineComponent<ConversationReuseLinkData>('ConversationReuseLink');

export interface ConversationBranchLinkData {
  id: string;
  sourceConversation: Entity;
  targetConversation: Entity;
  /** 详情已加载时的实体引用；冷卸载后使用 sourceRevisionId。 */
  sourceRevision?: Entity;
  sourceRevisionId?: string;
  kind: ConversationBranchKind;
  createdAt: number;
  updatedAt: number;
}
export const ConversationBranchLink = defineComponent<ConversationBranchLinkData>('ConversationBranchLink');

export interface ConversationOriginLinkData {
  id: string;
  conversation: Entity;
  originKind: ConversationOriginKind;
  sourceKind?: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceAgentId?: string;
  sourceConversation?: Entity;
  sourceConversationId?: string;
  sourceMessage?: Entity;
  sourceMessageId?: string;
  sourceToolCall?: Entity;
  sourceToolCallId?: string;
  sourceRun?: Entity;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}
export const ConversationOriginLink = defineComponent<ConversationOriginLinkData>('ConversationOriginLink');

export interface MessageData {
  id: string;
  role: MsgRole;
  model?: string;
  presentation?: MessagePresentation;
  content: MessageContent;
  status: MessageMaterializationStatus;
  seq: number;
  createdAt: number;
  requestStartedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
}
export const Message = defineComponent<MessageData>('Message');
export const PartOf = defineComponent<{ parent: Entity }>('PartOf');
export const Streaming = defineComponent<true>('Streaming');

export interface MessageRevisionData {
  id: string;
  content: MessageContent;
  createdAt: number;
  reason: MessageRevisionReason;
}
export const MessageRevision = defineComponent<MessageRevisionData>('MessageRevision');
export const MessageCurrentRevisionLink = defineComponent<{ id: string; message: Entity; revision: Entity }>('MessageCurrentRevisionLink');

export interface LlmRequestData {
  id: string;
  run: Entity;
  conversation: Entity;
  modelMessage: Entity;
  invocation?: Entity;
  /** Process-local admission fence for transient events from one durable Attempt. */
  reliableStreamEpoch?: {
    attemptId: AttemptId;
    generation: number;
    streamSeq: number;
  };
}
export const LlmRequest = defineComponent<LlmRequestData>('LlmRequest');

export interface LlmRequestPreDispatchCompressionAttemptData {
  anchorMessageId: string;
  anchorSeq: number;
  methodKind: LlmCompressionMethodKind;
  requestedAt: number;
}
export const LlmRequestPreDispatchCompressionAttempt = defineComponent<LlmRequestPreDispatchCompressionAttemptData>('LlmRequestPreDispatchCompressionAttempt');

export interface InFlightData {
  kind: 'llm' | 'tool';
  startedAt: number;
}
export const InFlight = defineComponent<InFlightData>('InFlight');

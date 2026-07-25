import type {
  AnswerBridgeRecord,
  AnswerPayloadRecord,
  AnswerSubmissionRecord,
  AttemptRecord,
  AuthorityDerivationLinkRecord,
  AuthoritySnapshotRecord,
  ChildTurnLinkRecord,
  DurableEffectPayloadRecord,
  DurableInteractionRequestRecord,
  ExecutionLeaseRecord,
  InteractionOwnerLinkRecord,
  InteractionResponseRecord,
  MessageTurnLinkRecord,
  OperationRecord,
  PendingTurnInputRecord,
  PrimaryEffectDescriptor,
  RequestExecutionRecord,
  RuntimeDeliveryLinkRecord,
  RuntimeInboxItemRecord,
  StreamCheckpointHead,
  TerminalStreamFence,
  ToolExecutionRecord,
  TurnExecutionPresetRevisionRecord,
  TurnIntentRecord,
  TurnIntentRevisionRecord,
  TurnRecord
} from '../../../shared/conversationReliability';
import type {
  AgentRunSourceKind,
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ConversationCheckpointRepositoryLinkRecord,
  CompressionBlockLlmInvocationLinkRecord,
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord,
  ContentPart,
  LlmInvocationSettingsSnapshotRecord,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageCurrentRevisionLinkRecord,
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord,
  RequestModelContextProjectionLinkRecord,
  CompressionModelContextProjectionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ProjectContextRecord,
  RunCompressionBlockLinkRecord,
  RunContextPolicyLinkRecord,
  RunContextPolicyRecord,
  RunTerminationRecord,
  ShadowRepositoryRecord,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallResultLinkRecord
} from '../../../shared/protocol';
import type { DurableToolResultArtifactRecord } from '../toolResultTypes';
import type {
  ConversationId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  RunId,
  TurnIntentId
} from '../../../shared/stableIds';

export interface DurableConversationRecord {
  id: ConversationId;
  title?: string;
  visibility: 'visible' | 'hidden' | 'collapsed';
  createdAt: number;
  lastActivityAt: number;
}

export interface RunSourceFactRecord {
  id: string;
  runId: RunId;
  sourceKind: AgentRunSourceKind;
  sourceConversationId?: ConversationId;
  sourceMessageId?: MessageId;
  sourceToolCallId?: string;
  sourceRunId?: RunId;
  answerBridgeId?: string;
}

export interface RunTargetFactRecord {
  id: string;
  runId: RunId;
  agentId: string;
  conversationId: ConversationId;
  role: 'executor';
}

export interface ToolRunFactRecord {
  id: string;
  toolCallId: string;
  runId: RunId;
  role: 'produced_by';
}

export interface DurableRunContextPolicyRecord extends RunContextPolicyRecord {
  conversationId: ConversationId;
}

export interface RunInputRevisionFactRecord {
  id: string;
  runId: RunId;
  conversationId: ConversationId;
  messageId: MessageId;
  revisionId: MessageRevisionId;
  contentHash: string;
}

export interface ContextSnapshotRecord {
  id: string;
  runId: RunId;
  conversationId: ConversationId;
  inputRevisionId: MessageRevisionId;
  contentHash: string;
  createdAt: number;
}

export interface BackgroundProcessCompletionPayload {
  processId: string;
  toolName: 'shell' | 'bash';
  command: string;
  cwd: string;
  status: 'exited' | 'killed' | 'abnormal';
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  droppedChars?: number;
}

export interface DurableInvocationRecord {
  id: InvocationId;
  conversationId: ConversationId;
  runId: RunId;
  requestId: string;
  operationId: string;
  status: 'resolving' | 'ready' | 'streaming' | 'complete' | 'error' | 'cancelled' | 'interrupted';
  rowVersion: number;
  settings?: LlmInvocationSettingsSnapshotRecord;
  createdAt: number;
  resolvedAt?: number;
  startedAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  error?: string;
}

export interface OperationResolutionRecord {
  id: string;
  operationId: string;
  kind: 'proved_not_executed' | 'verified_completed' | 'abandoned';
  evidenceRef?: string;
  createdAt: number;
}

export interface DurablePauseRecord {
  id: string;
  conversationId: ConversationId;
  runId: RunId;
  operationId: string;
  reason: 'outcome_unknown' | 'manual';
  /** Exact phase restored by an explicit resume; only present for manual pauses. */
  resumePhase?: import('../../../shared/runLifecycle').RunExecutionPhase;
  allowedResolutions: Array<'restart_proved_not_executed' | 'submit_verified_result' | 'abandon'>;
  createdAt: number;
}

export interface DurableStreamCheckpointHead extends StreamCheckpointHead {
  /** Resolved from the immutable checkpoint file inside the committed read barrier; never persisted in runtime-authority.json. */
  resolvedContent?: MessageContent;
}

export interface DurableConversationFacts {
  conversation: DurableConversationRecord;
  messages: MessageRecord[];
  messageRevisions: MessageRevisionRecord[];
  messageCurrentRevisionLinks: MessageCurrentRevisionLinkRecord[];
  modelContextProjections: ModelContextProjectionRecord[];
  modelContextProjectionSourceLinks: ModelContextProjectionSourceLinkRecord[];
  requestModelContextProjectionLinks: RequestModelContextProjectionLinkRecord[];
  compressionModelContextProjectionLinks: CompressionModelContextProjectionLinkRecord[];
  turns: TurnRecord[];
  turnIntents: TurnIntentRecord[];
  turnIntentRevisions: TurnIntentRevisionRecord[];
  turnExecutionPresetRevisions: TurnExecutionPresetRevisionRecord[];
  pendingTurnInputs: PendingTurnInputRecord[];
  executionLeases: ExecutionLeaseRecord[];
  authoritySnapshots: AuthoritySnapshotRecord[];
  authorityDerivationLinks: AuthorityDerivationLinkRecord[];
  runtimeInboxItems: RuntimeInboxItemRecord[];
  runtimeDeliveryLinks: RuntimeDeliveryLinkRecord[];
  childTurnLinks: ChildTurnLinkRecord[];
  messageTurnLinks: MessageTurnLinkRecord[];
  interactionOwnerLinks: InteractionOwnerLinkRecord[];
  interactionResponses: InteractionResponseRecord[];
  runTerminations: RunTerminationRecord[];
  runContextPolicies: DurableRunContextPolicyRecord[];
  runContextPolicyLinks: RunContextPolicyLinkRecord[];
  runSources: RunSourceFactRecord[];
  runTargets: RunTargetFactRecord[];
  toolRunLinks: ToolRunFactRecord[];
  inputRevisions: RunInputRevisionFactRecord[];
  contextSnapshots: ContextSnapshotRecord[];
  invocations: DurableInvocationRecord[];
  requests: RequestExecutionRecord[];
  toolCalls: ToolCallRecord[];
  toolCallEvents: ToolCallEventRecord[];
  toolResultArtifacts: DurableToolResultArtifactRecord[];
  toolCallResultLinks: ToolCallResultLinkRecord[];
  toolExecutions: ToolExecutionRecord[];
  compressionBlocks: CompressionBlockRecord[];
  compressionBlockSourceLinks: CompressionBlockSourceLinkRecord[];
  compressionContextVariants: CompressionContextVariantRecord[];
  compressionBlockLlmInvocationLinks: CompressionBlockLlmInvocationLinkRecord[];
  runCompressionBlockLinks: RunCompressionBlockLinkRecord[];
  projectContexts: ProjectContextRecord[];
  shadowRepositories: ShadowRepositoryRecord[];
  conversationCheckpointRepositoryLinks: ConversationCheckpointRepositoryLinkRecord[];
  checkpoints: CheckpointRecord[];
  checkpointTimelineAnchors: CheckpointTimelineAnchorRecord[];
  operations: OperationRecord[];
  attempts: AttemptRecord[];
  primaryEffects: PrimaryEffectDescriptor[];
  effectPayloads: DurableEffectPayloadRecord[];
  interactionRequests: DurableInteractionRequestRecord[];
  pauses: DurablePauseRecord[];
  operationResolutions: OperationResolutionRecord[];
  answerBridges: AnswerBridgeRecord[];
  answerSubmissions: AnswerSubmissionRecord[];
  answerPayloads: AnswerPayloadRecord[];
  streamCheckpointHeads: DurableStreamCheckpointHead[];
  terminalStreamFences: TerminalStreamFence[];
}

export interface MultiConversationDurableFacts {
  kind: 'multi_conversation';
  byConversation: Record<string, DurableConversationFacts>;
}

export type DurableRecordFamily = Exclude<keyof DurableConversationFacts, 'conversation'> | 'conversation';

export interface StartTurnCommandPayload {
  conversationId: ConversationId;
  content: MessageContent;
  agentId: string;
}

export interface EnqueueTurnCommandPayload {
  conversationId: ConversationId;
  content: MessageContent;
  agentId: string;
}

export interface SteerTurnCommandPayload {
  conversationId: ConversationId;
  targetTurnId: RunId;
  targetLeaseEpoch: number;
  fallback: import('../../../shared/conversationReliability').PendingTurnInputFallback;
  content: MessageContent;
}

export interface InterruptTurnCommandPayload {
  conversationId: ConversationId;
  turnId: RunId;
  leaseEpoch: number;
  cascadeChildAgents: boolean;
}

export interface TurnIntentControlCommandPayload {
  conversationId: ConversationId;
  intentId?: TurnIntentId;
  intentRowVersion?: number;
  action: 'update' | 'cancel' | 'reorder' | 'pause' | 'resume' | 'resume_all';
  content?: MessageContent;
  orderedIntents?: Array<{ intentId: TurnIntentId; rowVersion: number }>;
}

export interface PromoteTurnIntentCommandPayload {
  conversationId: ConversationId;
  intentId: TurnIntentId;
  intentRowVersion: number;
  replaceActive: boolean;
  expectedActiveTurnId?: RunId;
  expectedLeaseEpoch?: number;
}

export interface DeleteCommandPayload {
  conversationId: ConversationId;
  messageId: MessageId;
}

export interface RenameConversationPayload {
  conversationId: ConversationId;
  title: string;
}

export interface DeleteConversationAggregatePayload {
  conversationId: ConversationId;
}

export interface EditCommandPayload {
  conversationId: ConversationId;
  messageId: MessageId;
  content: MessageContent;
  deleteFollowing: boolean;
  restartRun: boolean;
}

export interface RetryCommandPayload {
  conversationId: ConversationId;
  messageId: MessageId;
}

export interface MarkAttemptDispatchedPayload {
  conversationId: ConversationId;
  operationId: string;
  attemptId: string;
  generation: number;
}

export interface CompleteOperationPayload {
  conversationId: ConversationId;
  eventId: string;
  operationId: string;
  attemptId: string;
  generation: number;
  outcome: 'succeeded' | 'failed';
  result?: import('../../../shared/conversationReliability').JsonValue;
  error?: string;
}

export interface ResolveUnknownOutcomePayload {
  conversationId: ConversationId;
  operationId: string;
  resolution: 'restart_proved_not_executed' | 'submit_verified_result' | 'abandon';
  evidenceRef?: string;
  verifiedResult?: import('../../../shared/conversationReliability').JsonValue;
}

export function messageHasFunctionCall(message: MessageRecord): boolean {
  return message.content.parts.some(isFunctionCallPart);
}

export function functionCallId(part: ContentPart): string | undefined {
  return 'functionCall' in part ? part.id : undefined;
}

function isFunctionCallPart(part: ContentPart): boolean {
  return 'functionCall' in part;
}

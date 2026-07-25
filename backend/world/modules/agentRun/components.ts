import { defineComponent, type Entity } from '../../../ecs/types';
import type {
  AgentRunKind,
  AgentRunSourceKind,
  AgentRunStatus,
  AgentRunTargetRole,
  ContextHistoryMode,
  ConversationPolicyMode,
  ConversationVisibility,
  DeliveryMode,
  NewMessageWhileRunningBehavior,
  PolicyBindingRole,
  SourceEditBehavior,
  ToolCallRunRole,
  TranscriptInclusion,
  LlmUsageMetadataRecord,
  OutcomeUnknownOperationRecord,
  RunTerminationActor,
  RunTerminationKind,
  RunTerminationReasonCode
} from '../../../../shared/protocol';
import type { MessageTurnRole } from '../../../../shared/conversationReliability';
import type { RunExecutionPhase, RunLifecycleStatus } from '../../../../shared/runLifecycle';

export interface AgentRunData {
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  /** Committed durable state; status is the UI-compatible projection. */
  lifecycle?: RunLifecycleStatus;
  phase?: RunExecutionPhase;
  rowVersion?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  usageMetadata?: LlmUsageMetadataRecord;
  retryOfRunId?: string;
  attempt?: number;
  outcomeUnknownOperations?: OutcomeUnknownOperationRecord[];
}
export const AgentRun = defineComponent<AgentRunData>('AgentRun');

export interface RunTerminationData {
  id: string;
  run: Entity;
  kind: RunTerminationKind;
  actor: RunTerminationActor;
  interruptedPhase: Exclude<RunExecutionPhase, 'terminal'>;
  reasonCode: RunTerminationReasonCode;
  triggerRunId?: string;
  triggerRun?: Entity;
  createdAt: number;
}
export const RunTermination = defineComponent<RunTerminationData>('RunTermination');

export interface AgentRunSourceLinkData {
  id: string;
  run: Entity;
  sourceKind: AgentRunSourceKind;
  sourceAgent?: Entity;
  sourceConversation?: Entity;
  sourceMessage?: Entity;
  sourceToolCall?: Entity;
  sourceRun?: Entity;
  answerBridgeId?: string;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunSourceLink = defineComponent<AgentRunSourceLinkData>('AgentRunSourceLink');

export interface AgentRunTargetLinkData {
  id: string;
  run: Entity;
  agent: Entity;
  conversation: Entity;
  role: AgentRunTargetRole;
  createdAt: number;
  updatedAt: number;
}
export const AgentRunTargetLink = defineComponent<AgentRunTargetLinkData>('AgentRunTargetLink');

export interface MessageTurnLinkData {
  id: string;
  message: Entity;
  turn: Entity;
  role: MessageTurnRole;
  createdAt: number;
  updatedAt: number;
}
export const MessageTurnLink = defineComponent<MessageTurnLinkData>('MessageTurnLink');

export interface ToolCallRunLinkData {
  id: string;
  toolCall: Entity;
  run: Entity;
  role: ToolCallRunRole;
  createdAt: number;
  updatedAt: number;
}
export const ToolCallRunLink = defineComponent<ToolCallRunLinkData>('ToolCallRunLink');

export interface RunConversationPolicyData {
  id: string;
  mode: ConversationPolicyMode;
  conversationId?: string;
  reuseKey?: string;
  branchFromConversationId?: string;
  branchFromRevisionId?: string;
  visibility: ConversationVisibility;
}
export const RunConversationPolicy = defineComponent<RunConversationPolicyData>('RunConversationPolicy');

export interface RunContextPolicyData {
  id: string;
  historyMode: ContextHistoryMode;
  lastN?: number;
  sinceMessageId?: string;
  selectedMessageIds?: string[];
  includeSourceContext?: boolean;
  includeSourceToolResult?: boolean;
}
export const RunContextPolicy = defineComponent<RunContextPolicyData>('RunContextPolicy');

export interface RunDeliveryPolicyData {
  id: string;
  mode: DeliveryMode;
  includeTranscript: TranscriptInclusion;
  targetConversation?: Entity;
  targetToolCall?: Entity;
}
export const RunDeliveryPolicy = defineComponent<RunDeliveryPolicyData>('RunDeliveryPolicy');

export interface RunEditPolicyData {
  id: string;
  onSourceEdited: SourceEditBehavior;
  onNewUserMessageWhileRunning: NewMessageWhileRunningBehavior;
}
export const RunEditPolicy = defineComponent<RunEditPolicyData>('RunEditPolicy');

export interface RunWorkflowLinkData {
  id: string;
  run: Entity;
  workflow: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunWorkflowLink = defineComponent<RunWorkflowLinkData>('RunWorkflowLink');

export interface RunSystemPromptLinkData {
  id: string;
  run: Entity;
  systemPrompt: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunSystemPromptLink = defineComponent<RunSystemPromptLinkData>('RunSystemPromptLink');

export interface RunModelProfileLinkData {
  id: string;
  run: Entity;
  modelProfile: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunModelProfileLink = defineComponent<RunModelProfileLinkData>('RunModelProfileLink');

export interface RunToolPolicyLinkData {
  id: string;
  run: Entity;
  toolPolicy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunToolPolicyLink = defineComponent<RunToolPolicyLinkData>('RunToolPolicyLink');


export interface RunConversationPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunConversationPolicyLink = defineComponent<RunConversationPolicyLinkData>('RunConversationPolicyLink');

export interface RunContextPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunContextPolicyLink = defineComponent<RunContextPolicyLinkData>('RunContextPolicyLink');

export interface RunDeliveryPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunDeliveryPolicyLink = defineComponent<RunDeliveryPolicyLinkData>('RunDeliveryPolicyLink');

export interface RunEditPolicyLinkData {
  id: string;
  run: Entity;
  policy: Entity;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const RunEditPolicyLink = defineComponent<RunEditPolicyLinkData>('RunEditPolicyLink');

export interface AgentRunInputRevisionData {
  id: string;
  run: Entity;
  conversation: Entity;
  revision: Entity;
}
export const AgentRunInputRevision = defineComponent<AgentRunInputRevisionData>('AgentRunInputRevision');

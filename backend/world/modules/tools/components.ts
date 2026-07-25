import { defineComponent, type Entity } from '../../../ecs/types';
import type { InlineDataPart, PolicyBindingRole, ToolCallEventKind, ToolCallResultLinkRecord, ToolCallStatus, ToolPolicyScopeKind, ToolSchedulingMode } from '../../../../shared/protocol';
import type { DurableToolResultArtifactRecord } from '../../../reliability/toolResultTypes';

export interface ToolCallData {
  id: string;
  name: string;
  functionCallId?: string;
  argsJson: string;
  schedulingOrdinal?: number;
  schedulingMode?: ToolSchedulingMode;
  schedulingReason?: string;
  createdAt: number;
}
export const ToolCall = defineComponent<ToolCallData>('ToolCall');

export interface ToolStateData {
  status: ToolCallStatus;
  updatedAt: number;
  /** Process-local fence for transient progress emitted by a reliability-owned Attempt. */
  reliableExecutionEpoch?: { attemptId: string; generation: number };
  result?: unknown;
  responseParts?: InlineDataPart[];
  error?: string;
  progress?: unknown;
  durationMs?: number;
}
export const ToolState = defineComponent<ToolStateData>('ToolState');

export interface ToolCallPreviewData {
  id: string;
  callId: string;
  name?: string;
  streamIndex?: string;
  argumentsHead: string;
  argumentsTail: string;
  receivedChars: number;
  truncated: boolean;
  createdAt: number;
  updatedAt: number;
}
export const ToolCallPreview = defineComponent<ToolCallPreviewData>('ToolCallPreview');

export interface ToolCallPreviewTargetLinkData {
  id: string;
  preview: Entity;
  request: Entity;
  requestId: string;
  message: Entity;
  messageId: string;
  conversation: Entity;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
}
export const ToolCallPreviewTargetLink = defineComponent<ToolCallPreviewTargetLinkData>('ToolCallPreviewTargetLink');

export interface ToolCallEventData {
  id: string;
  toolCallId: string;
  seq: number;
  kind: ToolCallEventKind;
  at: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
}
export const ToolCallEvent = defineComponent<ToolCallEventData>('ToolCallEvent');

export const ToolResultArtifact = defineComponent<DurableToolResultArtifactRecord>('ToolResultArtifact');
export const ToolCallResultLink = defineComponent<ToolCallResultLinkRecord>('ToolCallResultLink');

export const ToolResultConsumed = defineComponent<true>('ToolResultConsumed');

export interface ToolPolicyScopeLinkData {
  id: string;
  scopeKind: ToolPolicyScopeKind;
  scopeId?: string;
  toolPolicy: Entity;
  conversation?: Entity;
  agent?: Entity;
  workflow?: Entity;
  run?: Entity;
  agentSystemId?: string;
  role: PolicyBindingRole;
  createdAt: number;
  updatedAt: number;
}
export const ToolPolicyScopeLink = defineComponent<ToolPolicyScopeLinkData>('ToolPolicyScopeLink');

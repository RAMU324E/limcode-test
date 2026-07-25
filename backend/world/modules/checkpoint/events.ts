import type { CommandSink } from '../../../ecs/types';
import { CHECKPOINT_FEATURE_ENABLED } from '../../../../shared/featureFlags';
import type {
  CheckpointFloorAnchorPosition,
  CheckpointPolicyScopeClearPayload,
  CheckpointPolicyScopeSetPayload,
  CheckpointSkipReason,
  CheckpointStatus,
  CheckpointTriggerKind
} from '../../../../shared/protocol';

export interface CheckpointRequestedPayload {
  checkpointId?: string;
  conversationId: string;
  trigger: CheckpointTriggerKind;
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
}

export interface CheckpointCompletedPayload {
  checkpointId: string;
  conversationId: string;
  projectContextId: string;
  shadowRepositoryId: string;
  trigger: CheckpointTriggerKind;
  status: CheckpointStatus;
  projectUri: string;
  projectDisplayPath: string;
  createdAt: number;
  updatedAt: number;
  commitSha?: string;
  skipReason?: CheckpointSkipReason;
  message?: string;
  fileCount?: number;
  byteCount?: number;
  emptyDirectoryCount?: number;
  floorMessageId?: string;
  anchorPosition?: CheckpointFloorAnchorPosition;
  sourceRunId?: string;
  sourceToolCallId?: string;
  sourceToolName?: string;
}

export interface CheckpointDismissRequestedPayload {
  checkpointId: string;
}

export const CheckpointEventType = {
  Requested: 'checkpoint:requested',
  Completed: 'checkpoint:completed',
  DismissRequested: 'checkpoint:dismissRequested',
  PolicyScopeSetRequested: 'checkpointPolicy:scopeSetRequested',
  PolicyScopeClearRequested: 'checkpointPolicy:scopeClearRequested'
} as const;

/** 产品闸门关闭时，调用方也应跳过 checkpoint barrier / ID 等临时领域数据。 */
export function checkpointRequestsEnabled(): boolean {
  return CHECKPOINT_FEATURE_ENABLED;
}

/**
 * Checkpoint 的唯一运行时请求入口。功能关闭时不创建事件，避免下游系统、barrier 和持久化
 * 即使最终会被 policy 拒绝，仍为每次消息/工具制造一次无意义状态推进。
 */
export function enqueueCheckpointRequest(cmd: CommandSink, payload: CheckpointRequestedPayload): boolean {
  if (!checkpointRequestsEnabled()) return false;
  cmd.enqueue({ type: CheckpointEventType.Requested, payload });
  return true;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'checkpoint:requested': CheckpointRequestedPayload;
    'checkpoint:completed': CheckpointCompletedPayload;
    'checkpoint:dismissRequested': CheckpointDismissRequestedPayload;
    'checkpointPolicy:scopeSetRequested': CheckpointPolicyScopeSetPayload;
    'checkpointPolicy:scopeClearRequested': CheckpointPolicyScopeClearPayload;
  }
}

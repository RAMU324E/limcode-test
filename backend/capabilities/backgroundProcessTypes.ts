import type {
  BackgroundProcessOriginLinkRecord,
  BackgroundProcessRecord,
  BackgroundProcessStatus
} from '../../shared/protocol';

/**
 * 启动工具在把进程交给 ProcessManager 时提供的纯数据来源快照。
 * 这些 ID 只描述关系，不把 ToolCall/Run/Conversation 嵌入 Process 主体。
 */
export interface BackgroundProcessOriginDescriptor {
  sourceToolCallId: string;
  sourceRunId: string;
  conversationId: string;
  sourceAttemptId: string;
  sourceGeneration: number;
}

/** stdout/stderr 的独立持久化记录；读取日志不会改变退出通知投递状态。 */
export interface BackgroundProcessOutputRecord {
  id: string;
  backgroundProcessId: string;
  processId: string;
  stdout: string;
  stderr: string;
  droppedStdoutChars: number;
  droppedStderrChars: number;
  updatedAt: number;
}

/**
 * 进程首次进入终态时写入的不可变事实。terminalRevision 与 processId 共同构成
 * completion 的稳定幂等身份；当前每个 Process 只允许 revision=1。
 */
export interface BackgroundProcessExitReceiptRecord {
  id: string;
  backgroundProcessId: string;
  processId: string;
  terminalRevision: number;
  status: Exclude<BackgroundProcessStatus, 'running'>;
  exitCode: number;
  killed: boolean;
  exitedAt: number;
  command: string;
  cwd: string;
  stdoutTail: string;
  stderrTail: string;
  droppedChars: number;
  outputRecordId: string;
  createdAt: number;
}

export type BackgroundProcessNotificationDeliveryStatus = 'pending' | 'delivered' | 'stale';
export type BackgroundProcessTerminalClaimOwner = 'auto_delivery' | 'model_poll';

/** completion 到 durable conversation inbox 的 outbox 投递状态；claim 与 model consumption 独立。 */
export interface BackgroundProcessNotificationDeliveryRecord {
  id: string;
  receiptId: string;
  backgroundProcessId: string;
  processId: string;
  terminalRevision: number;
  sourceKey: string;
  status: BackgroundProcessNotificationDeliveryStatus;
  claimOwner?: BackgroundProcessTerminalClaimOwner;
  claimedAt?: number;
  rowVersion: number;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  lastAttemptAt?: number;
  deliveredAt?: number;
  staleAt?: number;
  staleReason?: string;
  lastError?: string;
}

export interface BackgroundProcessDeliveryEnvelope {
  process: BackgroundProcessRecord;
  origin: BackgroundProcessOriginLinkRecord;
  receipt: BackgroundProcessExitReceiptRecord;
  delivery: BackgroundProcessNotificationDeliveryRecord;
}

export interface BackgroundProcessSnapshot {
  processes: BackgroundProcessRecord[];
  originLinks: BackgroundProcessOriginLinkRecord[];
}

export type BackgroundProcessDeliveryResolution =
  | { status: 'ready'; envelope: BackgroundProcessDeliveryEnvelope }
  | { status: 'stale'; delivery: BackgroundProcessNotificationDeliveryRecord; reason: string };

export function backgroundProcessOriginLinkId(processId: string): string {
  return `background-process-origin:${processId}`;
}

export function backgroundProcessOutputRecordId(processId: string): string {
  return `background-process-output:${processId}`;
}

export function backgroundProcessExitReceiptId(processId: string, terminalRevision: number): string {
  return `background-process-exit:${processId}:${terminalRevision}`;
}

export function backgroundProcessDeliveryId(processId: string, terminalRevision: number): string {
  return `background-process-delivery:${processId}:${terminalRevision}`;
}

export function backgroundProcessDeliverySourceKey(processId: string, terminalRevision: number): string {
  return `event:background-process-exit:${processId}:${terminalRevision}`;
}

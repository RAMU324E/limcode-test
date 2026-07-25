import type { ToolCallEventKind, ToolCallStatus, ToolPolicyScopeClearPayload, ToolPolicyScopeSetPayload } from '../../../../shared/protocol';

/** Tool 生命周期命令由可靠事务拥有；World Event 只承载已围栏的运行时投影与策略配置。 */
export const ToolEventType = {
  State: 'tool:state',
  PolicyScopeSetRequested: 'tool:policyScopeSetRequested',
  PolicyScopeClearRequested: 'tool:policyScopeClearRequested'
} as const;

export interface ToolStatePayload {
  toolCallId: string;
  status: ToolCallStatus;
  attemptId?: string;
  generation?: number;
  result?: unknown;
  error?: string;
  progress?: unknown;
  eventKind?: ToolCallEventKind;
  delta?: string;
  durationMs?: number;
}

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'tool:state': ToolStatePayload;
    'tool:policyScopeSetRequested': ToolPolicyScopeSetPayload;
    'tool:policyScopeClearRequested': ToolPolicyScopeClearPayload;
  }
}

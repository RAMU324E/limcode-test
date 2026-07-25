import type { AgentRunStatus, SidebarConversationHistoryEntry } from '../../shared/protocol';

export interface ConversationRunHistoryRuntimeSummary {
  status: AgentRunStatus;
  label: string;
  updatedAt: number;
}

/** 历史文件只保存展示摘要；运行状态始终以当前进程内的活跃 Run 为准。 */
export function historyEntryWithLiveRunState(
  entry: SidebarConversationHistoryEntry,
  summary: ConversationRunHistoryRuntimeSummary | undefined
): SidebarConversationHistoryEntry {
  if (summary) {
    return {
      ...entry,
      isRunning: true,
      runStatus: summary.status,
      runStatusLabel: summary.label,
      updatedAt: Math.max(entry.updatedAt ?? 0, summary.updatedAt)
    };
  }
  const normalized = { ...entry, isRunning: false };
  delete normalized.runStatus;
  delete normalized.runStatusLabel;
  return normalized;
}

/** hydration 完成后，缺失的历史 conversation 视为陈旧记录，不允许据此创建占位对象。 */
export function canPrepareConversationForSidebarOpen(input: {
  hydrated: boolean;
  deleted: boolean;
  exists: boolean;
}): boolean {
  if (input.deleted) return false;
  return input.exists || !input.hydrated;
}

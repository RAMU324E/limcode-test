import type { AgentRunRecord, AgentRunStatus, ToolCallStatus } from './protocol';

export type AgentRunActivityBlocker =
  | 'waiting_tool'
  | 'waiting_child_run'
  | 'waiting_user'
  | 'waiting_plan_review'
  | 'paused';

export type ForegroundAnswerReceiptState =
  | 'not_applicable'
  | 'waiting_notification'
  | 'waiting_child_completion'
  | 'waiting_parent_tool'
  | 'processed'
  | 'parent_failed';

type AgentRunActivityLike = Pick<AgentRunRecord, 'status' | 'lifecycle' | 'phase'>;

const TERMINAL_AGENT_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'stale',
  'interrupted'
]);

/** Resolve durable blocking phases before falling back to the compact legacy UI status. */
export function agentRunActivityBlocker(
  run: AgentRunActivityLike | undefined,
  toolStatuses: readonly ToolCallStatus[] = []
): AgentRunActivityBlocker | undefined {
  if (!run) return undefined;
  const waitingForUser = toolStatuses.includes('awaiting_user_input');
  switch (run.phase) {
    case 'waiting_tools': return waitingForUser ? 'waiting_user' : 'waiting_tool';
    case 'waiting_child_run': return 'waiting_child_run';
    case 'waiting_user': return 'waiting_user';
    case 'waiting_plan_review': return 'waiting_plan_review';
    case 'paused': return waitingForUser ? 'waiting_user' : 'paused';
  }
  switch (run.status) {
    case 'waiting_tool': return waitingForUser ? 'waiting_user' : 'waiting_tool';
    case 'waiting_child_run': return 'waiting_child_run';
    case 'paused': return waitingForUser ? 'waiting_user' : 'paused';
    default: return undefined;
  }
}

export function isAgentRunTerminal(run: AgentRunActivityLike | undefined): boolean {
  if (!run) return false;
  if (run.lifecycle) return run.lifecycle !== 'queued' && run.lifecycle !== 'active';
  return TERMINAL_AGENT_RUN_STATUSES.has(run.status);
}

/**
 * A foreground answer does not create a notification Run. The parent run_agent ToolCall is the
 * durable receipt: only its terminal success/warning proves that the answer has been consumed.
 * Backgrounded calls still require a notification Run even though that original ToolCall succeeded.
 */
export function foregroundAnswerReceiptState(input: {
  hasAnswer: boolean;
  notificationRunPresent: boolean;
  childRun?: AgentRunActivityLike;
  parentToolStatus: ToolCallStatus;
  payloadStatus?: string;
}): ForegroundAnswerReceiptState {
  if (!input.hasAnswer || input.notificationRunPresent) return 'not_applicable';
  if (input.payloadStatus === 'backgrounded') return 'waiting_notification';
  if (input.parentToolStatus === 'error') return 'parent_failed';
  if (input.parentToolStatus === 'success' || input.parentToolStatus === 'warning') return 'processed';
  return input.childRun && !isAgentRunTerminal(input.childRun)
    ? 'waiting_child_completion'
    : 'waiting_parent_tool';
}

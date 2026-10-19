/** Agent reports get three times the ordinary result allowance. */
export const AGENT_REPORT_MAX_TOKENS = 12_000;
export const AGENT_MESSAGE_MAX_TEXT_BYTES = 192_000;

export function agentReportTool(toolName: string): boolean {
  return ['run_agent', 'read_agent_answer', 'read_agent_messages', 'wait_agent_messages', 'read_conversation'].includes(toolName);
}

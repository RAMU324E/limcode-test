/** Maximum number of attachment reads materialized concurrently for one parent Turn. */
export const MAX_CONCURRENT_ATTACHMENT_READS_PER_TURN = 2;

/** Maximum number of ordinary ToolCalls executing concurrently for one parent Turn. */
export const MAX_CONCURRENT_ORDINARY_TOOLS_PER_TURN = 8;

/** Maximum number of process or MCP ToolCalls executing concurrently for one parent Turn. */
export const MAX_CONCURRENT_PROCESS_OR_MCP_TOOLS_PER_TURN = 4;

/**
 * Maximum number of child-agent durable intent admissions running concurrently for one parent Turn.
 * The slot is released after the intent is durable; foreground answer waiting never retains it.
 */
export const MAX_CONCURRENT_CHILD_AGENT_STARTS_PER_TURN = 8;

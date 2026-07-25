import { TERMINAL_TOOL_CALL_STATUSES, type ToolCallRecord, type ToolSchedulingMode } from '../../../shared/protocol';
import type { DurableConversationFacts } from './types';

export interface CompletingToolWork {
  runId: string;
  toolCallIds?: readonly string[];
  operationIds?: readonly string[];
}

/**
 * Returns the pending Tool Operations that may cross the dispatch barrier now. A serial call is a
 * barrier; a contiguous parallel group is admitted together. The decision depends only on durable
 * facts, so restart and live execution produce the same schedule.
 */
export function dispatchableToolOperationIds(facts: DurableConversationFacts): ReadonlySet<string> {
  const activeOperations = new Map<string, DurableConversationFacts['operations'][number]>(facts.operations
    .filter((operation) => operation.kind.startsWith('tool.') && (operation.state === 'pending' || operation.state === 'running'))
    .map((operation) => [operation.id, operation]));
  const executions = facts.toolExecutions.filter((execution) => activeOperations.has(execution.operationId));
  const executionsByRun = groupBy(executions, (execution) => execution.runId);
  const result = new Set<string>();

  for (const [runId, runExecutions] of executionsByRun) {
    const toolsById = new Map<string, ToolCallRecord>(facts.toolCalls.map((tool) => [tool.id, tool]));
    const batchIds = new Set(runExecutions.map((execution) => toolsById.get(execution.id)?.messageId).filter((id): id is string => !!id));
    if (batchIds.size !== 1) throw new Error(`Run ${runId} has active Tool Operations in ${batchIds.size} tool-call batches.`);
    const messageId = [...batchIds][0]!;
    const linkedToolIds = new Set<string>(facts.toolRunLinks.filter((link) => link.runId === runId).map((link) => link.toolCallId));
    const batch = facts.toolCalls
      .filter((tool) => linkedToolIds.has(tool.id) && tool.messageId === messageId)
      .sort(compareScheduledTools);
    const firstUnfinished = batch.findIndex((tool) => !TERMINAL_TOOL_CALL_STATUSES.has(tool.status));
    if (firstUnfinished < 0) continue;

    const executionsByTool = new Map<string, DurableConversationFacts['toolExecutions'][number]>(runExecutions.map((execution) => [execution.id, execution]));
    const first = batch[firstUnfinished]!;
    if (requireSchedulingMode(first) === 'serial') {
      const execution = executionsByTool.get(first.id);
      if (execution) result.add(execution.operationId);
      continue;
    }

    for (const tool of batch.slice(firstUnfinished)) {
      const execution = executionsByTool.get(tool.id);
      if (requireSchedulingMode(tool) !== 'parallel') break;
      if (!TERMINAL_TOOL_CALL_STATUSES.has(tool.status) && execution) result.add(execution.operationId);
    }
  }
  return result;
}

/**
 * True when completing one callback must not start the next LLM invocation yet.
 * Interaction/child blocking is represented by its non-terminal ToolCall; there is no second Wait
 * truth table to consult.
 */
export function hasRemainingToolWork(facts: DurableConversationFacts, completing: CompletingToolWork): boolean {
  const completedTools = new Set(completing.toolCallIds ?? []);
  const completedOperations = new Set(completing.operationIds ?? []);
  const runToolIds = new Set(facts.toolRunLinks.filter((link) => link.runId === completing.runId).map((link) => link.toolCallId));

  if (facts.toolCalls.some((tool) => runToolIds.has(tool.id)
    && !completedTools.has(tool.id)
    && !TERMINAL_TOOL_CALL_STATUSES.has(tool.status))) return true;

  return facts.operations.some((operation) => operation.ownerRunId === completing.runId
    && !completedOperations.has(operation.id)
    && operation.kind.startsWith('tool.')
    && (operation.state === 'pending' || operation.state === 'running'));
}

export function scheduledToolOrdinal(tool: ToolCallRecord): number {
  if (!Number.isInteger(tool.schedulingOrdinal) || tool.schedulingOrdinal! < 0) {
    throw new Error(`ToolCall ${tool.id} has no durable scheduling ordinal.`);
  }
  return tool.schedulingOrdinal!;
}

function compareScheduledTools(left: ToolCallRecord, right: ToolCallRecord): number {
  return scheduledToolOrdinal(left) - scheduledToolOrdinal(right)
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function requireSchedulingMode(tool: ToolCallRecord): ToolSchedulingMode {
  if (tool.schedulingMode !== 'parallel' && tool.schedulingMode !== 'serial') {
    throw new Error(`ToolCall ${tool.id} has no durable scheduling mode.`);
  }
  return tool.schedulingMode;
}

function groupBy<T>(values: readonly T[], keyOf: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = result.get(key);
    if (group) group.push(value);
    else result.set(key, [value]);
  }
  return result;
}

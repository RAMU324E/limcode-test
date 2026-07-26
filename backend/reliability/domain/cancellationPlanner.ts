import type { JsonValue } from '../../../shared/conversationReliability';
import type { ToolCallEventRecord, ToolCallRecord } from '../../../shared/protocol';
import type {
  AttemptId,
  EffectIntentId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  RequestId,
  RunId,
  ToolCallEventId
} from '../../../shared/stableIds';
import type { OwnedChildRun } from './childRunOwnership';
import { appendToolResponsesAndNextInvocation } from './internalHandlers';
import type { RunTerminationSpec } from './runTermination';
import { runGraphCascadeForPolicy, type CancellationPolicyName } from './cancellationIntent';
import { hasRemainingToolWork } from './toolSchedule';
import {
  appendTerminateRunGraphMutations,
  planTerminateRunGraph,
  type TerminateRunGraphPlan
} from './terminateRunGraph';
import type { ConversationTransitionBuilder } from './transitionBuilder';
import { replaceWithBoundedInlineToolResult, withoutEmbeddedToolResult } from './toolResultArtifacts';
import type { DurableConversationFacts } from './types';

export interface OwnedSourceToolContinuationIds {
  toolCallEventId: ToolCallEventId;
  responseMessageId: MessageId;
  responseRevisionId: MessageRevisionId;
  nextInvocationId: InvocationId;
  nextRequestId: RequestId;
  nextOperationId: OperationId;
  nextAttemptId: AttemptId;
  nextEffectIntentId: EffectIntentId;
}

export interface CancelOwnedChildWorkInput {
  ownership: OwnedChildRun;
  policy: Extract<CancellationPolicyName, 'foreground_child_tool' | 'explicit_child_interrupt'>;
  closureRunIds: readonly RunId[];
  termination: RunTerminationSpec;
  now: number;
}

/** Cancels one exact Bridge-owned ChildRun closure without terminating the caller/parent Run. */
export function appendCancelOwnedChildWork(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  input: CancelOwnedChildWorkInput
): TerminateRunGraphPlan {
  if (!input.closureRunIds.includes(input.ownership.childRunId)) {
    throw new Error(`Resolved cancellation closure does not contain owned ChildRun ${input.ownership.childRunId}.`);
  }
  const termination = planTerminateRunGraph(facts, {
    rootRunIds: [input.ownership.childRunId],
    termination: input.termination,
    ...runGraphCascadeForPolicy(input.policy),
    expectedClosureRunIds: input.closureRunIds
  });
  appendTerminateRunGraphMutations(builder, facts, termination, input.now);
  return termination;
}

export function appendSettleOwnedSourceToolCancellation(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  input: {
    ownership: OwnedChildRun;
    continuation: OwnedSourceToolContinuationIds;
    reason: string;
    affectedRunIds: readonly RunId[];
    now: number;
  }
): { settled: boolean; result: JsonValue } {
  const result = cancellationResult(input.reason, input.affectedRunIds);
  const run = uniqueMatch(
    facts.turns.filter((candidate) => candidate.id === input.ownership.parentRunId
      && candidate.conversationId === input.ownership.sourceConversationId),
    `source parent Run ${input.ownership.parentRunId}`
  );
  const tool = uniqueMatch(
    facts.toolCalls.filter((candidate) => candidate.id === input.ownership.sourceToolCallId),
    `source run_agent ToolCall ${input.ownership.sourceToolCallId}`
  );
  const execution = uniqueMatch(
    facts.toolExecutions.filter((candidate) => candidate.id === input.ownership.sourceToolCallId),
    `source run_agent ToolExecution ${input.ownership.sourceToolCallId}`
  );
  if (!run || !tool || !execution) {
    throw new Error(`Bridge ${input.ownership.bridge.id} has incomplete source Tool ownership.`);
  }
  if (terminalTool(tool)) return { settled: false, result };
  if (input.ownership.link.mode !== 'foreground'
    || run.lifecycle !== 'active'
    || (run.phase !== 'waiting_tools' && run.phase !== 'waiting_child_run')) {
    return { settled: false, result };
  }

  const materialized = replaceWithBoundedInlineToolResult(builder, facts.toolCallResultLinks, {
    conversationId: input.ownership.sourceConversationId,
    tool,
    status: 'error',
    result,
    now: input.now,
    error: input.reason
  });
  const completedTool: ToolCallRecord = {
    ...withoutEmbeddedToolResult(tool),
    status: 'error',
    error: input.reason,
    updatedAt: input.now
  };
  // The launch Operation/Attempt/ToolExecution already crossed its boundary successfully.
  // Cancelling the still-live ChildTurnLink must not rewrite that historical launch outcome.
  builder
    .generatedId(input.continuation.toolCallEventId)
    .upsert('toolCalls', completedTool)
    .upsert('toolCallEvents', toolEvent(facts, completedTool, input.continuation.toolCallEventId, input.now, input.reason));

  if (!hasRemainingToolWork(facts, {
    runId: run.id,
    toolCallIds: [tool.id],
    operationIds: [execution.operationId]
  })) {
    appendToolResponsesAndNextInvocation(builder, facts, run, {
      conversationId: input.ownership.sourceConversationId,
      toolCallId: input.ownership.sourceToolCallId,
      outcome: 'failed',
      modelResponse: materialized.modelResponse,
      error: input.reason,
      completedAt: input.now,
      ...input.continuation
    }, input.now);
  }
  return { settled: true, result };
}

export function cancellationResult(reason: string, affectedRunIds: readonly RunId[]): JsonValue {
  return {
    ok: false,
    interrupted: true,
    reason,
    affectedRunIds: [...affectedRunIds]
  };
}

function toolEvent(
  facts: DurableConversationFacts,
  tool: ToolCallRecord,
  id: ToolCallEventId,
  at: number,
  error: string
): ToolCallEventRecord {
  const durationMs = Math.max(0, at - tool.createdAt);
  return {
    id,
    toolCallId: tool.id,
    seq: facts.toolCallEvents.filter((event) => event.toolCallId === tool.id).reduce((max, event) => Math.max(max, event.seq), 0) + 1,
    kind: 'failed',
    at,
    status: tool.status,
    elapsedMs: durationMs,
    durationMs,
    error
  };
}

function terminalTool(tool: ToolCallRecord): boolean {
  return tool.status === 'success' || tool.status === 'warning' || tool.status === 'error';
}

function uniqueMatch<T>(values: readonly T[], label: string): T | undefined {
  if (values.length > 1) throw new Error(`${label} is ambiguous (${values.length} matches).`);
  return values[0];
}

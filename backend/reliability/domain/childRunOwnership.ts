import type { AnswerBridgeRecord, ChildTurnLinkRecord } from '../../../shared/conversationReliability';
import type { ConversationId, RunId, ToolCallId } from '../../../shared/stableIds';
import type { DurableConversationFacts, RunSourceFactRecord } from './types';

export type ChildOwnershipFailureReason =
  | 'source_run_missing'
  | 'answer_bridge_missing'
  | 'answer_bridge_not_open'
  | 'child_link_missing'
  | 'child_not_foreground'
  | 'child_run_missing'
  | 'child_run_source_missing'
  | 'source_tool_mismatch'
  | 'stale_bridge_generation'
  | 'target_moved';

export class ChildRunOwnershipIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ChildRunOwnershipIntegrityError';
  }
}

export interface OwnedChildRun {
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  parentRunId: RunId;
  childRunId: RunId;
  sourceToolCallId: ToolCallId;
  bridge: AnswerBridgeRecord;
  link: ChildTurnLinkRecord;
  runSource?: RunSourceFactRecord;
  childTerminal: boolean;
}

export type ChildOwnershipResolution =
  | { status: 'matched'; ownership: OwnedChildRun }
  | { status: 'missing'; reason: ChildOwnershipFailureReason }
  | { status: 'already_stopped'; reason: 'answer_bridge_terminal' | 'child_run_terminal' }
  | { status: 'target_moved'; reason: 'stale_bridge_generation' | 'current_child_changed' };

/** Resolves the canonical foreground ChildTurnLink owning one still-executing run_agent ToolCall. */
export function resolveForegroundChildToolOwnership(
  facts: DurableConversationFacts,
  sourceConversationId: ConversationId,
  sourceToolCallId: ToolCallId,
  options: { requireTargetFacts?: boolean } = {}
): ChildOwnershipResolution {
  const toolRunLink = uniqueMatch(
    facts.toolRunLinks.filter((candidate) => candidate.toolCallId === sourceToolCallId),
    `ToolCall Run ownership ${sourceToolCallId}`
  );
  const parentRunId = toolRunLink?.runId;
  if (!parentRunId || !facts.turns.some((run) => run.id === parentRunId && run.conversationId === sourceConversationId)) {
    return { status: 'missing', reason: 'source_run_missing' };
  }
  const link = uniqueMatch(
    facts.childTurnLinks.filter((candidate) => candidate.parentConversationId === sourceConversationId
      && candidate.parentTurnId === parentRunId
      && candidate.sourceToolCallId === sourceToolCallId
      && candidate.mode !== 'detached'),
    `foreground ChildTurnLink ${sourceToolCallId}`
  );
  if (!link) return { status: 'missing', reason: 'child_link_missing' };
  if (link.mode !== 'foreground') return { status: 'missing', reason: 'child_not_foreground' };
  return resolveAnswerBridgeChildOwnership(facts, link.answerBridgeId, {
    requireTargetFacts: options.requireTargetFacts,
    expectedParentRunId: parentRunId,
    expectedSourceToolCallId: sourceToolCallId
  });
}

/** Resolves the one current (non-detached) ChildTurnLink owned by an AnswerBridge generation. */
export function resolveAnswerBridgeChildOwnership(
  facts: DurableConversationFacts,
  bridgeId: string,
  options: {
    expectedOwnerGeneration?: number;
    expectedParentRunId?: RunId;
    expectedSourceToolCallId?: ToolCallId;
    requireTargetFacts?: boolean;
  } = {}
): ChildOwnershipResolution {
  const bridge = uniqueMatch(
    facts.answerBridges.filter((candidate) => candidate.id === bridgeId),
    `AnswerBridge ${bridgeId}`
  );
  if (!bridge) return { status: 'missing', reason: 'answer_bridge_missing' };
  if (options.expectedOwnerGeneration !== undefined && bridge.ownerGeneration !== options.expectedOwnerGeneration) {
    return { status: 'target_moved', reason: 'stale_bridge_generation' };
  }
  if (bridge.lifecycle !== 'open') return { status: 'already_stopped', reason: 'answer_bridge_terminal' };
  if (options.expectedParentRunId && bridge.ownerRunId !== options.expectedParentRunId) {
    return { status: 'target_moved', reason: 'current_child_changed' };
  }

  const link = uniqueMatch(
    facts.childTurnLinks.filter((candidate) => candidate.answerBridgeId === bridge.id && candidate.mode !== 'detached'),
    `current ChildTurnLink ownership for AnswerBridge ${bridge.id}`
  );
  if (!link) return { status: 'missing', reason: 'child_link_missing' };
  if (link.parentTurnId !== bridge.ownerRunId
    || link.parentConversationId !== bridge.sourceConversationId
    || link.childConversationId !== bridge.targetConversationId) {
    return { status: 'target_moved', reason: 'current_child_changed' };
  }
  if (!link.sourceToolCallId) return { status: 'missing', reason: 'source_tool_mismatch' };
  if (options.expectedSourceToolCallId && link.sourceToolCallId !== options.expectedSourceToolCallId) {
    return { status: 'target_moved', reason: 'current_child_changed' };
  }

  const childRun = uniqueMatch(
    facts.turns.filter((candidate) => candidate.id === link.childTurnId),
    `ChildTurn ${link.childTurnId}`
  );
  const runSource = uniqueMatch(
    facts.runSources.filter((candidate) => candidate.runId === link.childTurnId),
    `RunSource ${link.childTurnId}`
  );
  if (options.requireTargetFacts && !childRun) return { status: 'missing', reason: 'child_run_missing' };
  if (options.requireTargetFacts) {
    if (!runSource
      || runSource.answerBridgeId !== bridge.id
      || runSource.sourceConversationId !== bridge.sourceConversationId
      || runSource.sourceRunId !== link.parentTurnId
      || runSource.sourceToolCallId !== link.sourceToolCallId) {
      return { status: 'missing', reason: 'child_run_source_missing' };
    }
    if (childRun?.conversationId !== bridge.targetConversationId) {
      return { status: 'target_moved', reason: 'current_child_changed' };
    }
  }

  return {
    status: 'matched',
    ownership: {
      sourceConversationId: bridge.sourceConversationId,
      targetConversationId: bridge.targetConversationId,
      parentRunId: link.parentTurnId,
      childRunId: link.childTurnId,
      sourceToolCallId: link.sourceToolCallId,
      bridge,
      link,
      ...(runSource ? { runSource } : {}),
      childTerminal: childRun?.phase === 'terminal'
    }
  };
}

function uniqueMatch<T>(values: readonly T[], label: string): T | undefined {
  if (values.length > 1) throw new ChildRunOwnershipIntegrityError(`${label} is ambiguous (${values.length} matches).`);
  return values[0];
}

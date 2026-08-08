import type { Entity, WorldReader } from '../../../ecs/types';
import { ToolCallRunLink } from '../agentRun/components';
import {
  type ToolSchedulingDecision,
  type ToolSchedulingMode
} from './schedulingContract';
export {
  normalizeSchedulingHint,
  staticToolScheduling,
  type ToolSchedulingContext,
  type ToolSchedulingDecision,
  type ToolSchedulingMode,
  type ToolSchedulingResolver
} from './schedulingContract';
import { InFlight } from '../chat/components';
import { ToolCall, ToolResultConsumed, ToolState, type ToolStateData } from './components';
import { ToolDefinitionsKey, ToolRuntimeDefinitionsKey } from './resources';

export interface ActiveToolExecutionBatch {
  mode: ToolSchedulingMode;
  calls: Set<Entity>;
}

export function isInActiveExecutionBatch(world: WorldReader, run: Entity, toolCall: Entity): boolean {
  return activeExecutionBatchForRun(world, run)?.calls.has(toolCall) === true;
}

export function activeExecutionBatchForRun(world: WorldReader, run: Entity): ActiveToolExecutionBatch | undefined {
  const ordered = orderedToolCallsForRun(world, run);
  const startIndex = ordered.findIndex((entity) => isExecutionBlockingToolCall(world, entity));
  if (startIndex < 0) return undefined;

  const first = ordered[startIndex]!;
  const mode = toolSchedulingDecision(world, first).mode;
  if (mode === 'serial') return { mode, calls: new Set([first]) };

  const calls = new Set<Entity>();
  for (const entity of ordered.slice(startIndex)) {
    if (toolSchedulingDecision(world, entity).mode !== 'parallel') break;
    if (isExecutionBlockingToolCall(world, entity)) calls.add(entity);
  }
  return { mode, calls };
}

export function orderedToolCallsForRun(world: WorldReader, run: Entity): Entity[] {
  const toolCallEntitiesInRun = new Set(
    world
      .query(ToolCallRunLink)
      .filter((entity) => world.get(entity, ToolCallRunLink)?.run === run)
      .map((entity) => world.get(entity, ToolCallRunLink)?.toolCall)
      .filter((entity): entity is Entity => entity !== undefined)
  );
  return world
    .query(ToolCall, ToolState)
    .filter((entity) => toolCallEntitiesInRun.has(entity))
    .sort((left, right) => compareToolCallOrder(world, left, right));
}

export function compareToolCallOrder(world: WorldReader, left: Entity, right: Entity): number {
  const leftCall = world.get(left, ToolCall);
  const rightCall = world.get(right, ToolCall);
  return (leftCall?.createdAt ?? 0) - (rightCall?.createdAt ?? 0) || left - right;
}

export function isExecutionApproved(state: ToolStateData): boolean {
  const progress = state.progress;
  return !!progress
    && typeof progress === 'object'
    && !Array.isArray(progress)
    && (progress as { executionApproved?: unknown }).executionApproved === true;
}

export function progressRecord(progress: unknown): Record<string, unknown> {
  return progress && typeof progress === 'object' && !Array.isArray(progress)
    ? { ...(progress as Record<string, unknown>) }
    : {};
}

function isExecutionBlockingToolCall(world: WorldReader, entity: Entity): boolean {
  if (world.has(entity, InFlight)) return true;
  const state = world.get(entity, ToolState);
  if (!state) return false;
  if ((state.status === 'success' || state.status === 'warning' || state.status === 'error') && !world.has(entity, ToolResultConsumed)) {
    return true;
  }
  return state.status === 'streaming'
    || state.status === 'queued'
    || state.status === 'awaiting_approval'
    || state.status === 'awaiting_user_input'
    || state.status === 'awaiting_child'
    || state.status === 'executing'
    || state.status === 'awaiting_change_apply'
    || state.status === 'applying_change'
    || state.status === 'change_applied'
    || state.status === 'change_rejected'
    || state.status === 'awaiting_result_submit';
}

export function toolSchedulingDecision(world: WorldReader, entity: Entity): ToolSchedulingDecision {
  const call = world.get(entity, ToolCall);
  if (!call) return { mode: 'serial', reason: 'missing_tool_call' };
  if (call.schedulingMode) {
    return {
      mode: call.schedulingMode,
      ...(call.schedulingReason ? { reason: call.schedulingReason } : {})
    };
  }
  return toolSchedulingDecisionForCall(world, call.name, call.argsJson);
}

/** Resolves scheduling before a ToolCall entity exists so reliable execution can freeze the decision durably. */
export function toolSchedulingDecisionForCall(
  world: WorldReader,
  toolName: string,
  argsJson: string
): ToolSchedulingDecision {
  const runtimeDefinition = (world.tryGetResource(ToolRuntimeDefinitionsKey) ?? []).find((tool) => tool.declaration.name === toolName);
  const args = parseToolArgs(argsJson);
  const dynamic = runtimeDefinition?.scheduling?.(args, { toolName });
  if (dynamic?.mode === 'parallel' || dynamic?.mode === 'serial') return dynamic;

  const definition = (world.tryGetResource(ToolDefinitionsKey) ?? []).find((tool) => tool.name === toolName);
  if (
    definition?.metadata?.readonly === true
    || definition?.metadata?.riskLevel === 'read'
  ) return { mode: 'parallel', reason: 'readonly_metadata' };
  return { mode: 'serial', reason: 'default_serial_metadata' };
}

function parseToolArgs(argsJson: string): unknown {
  try {
    return argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return {};
  }
}

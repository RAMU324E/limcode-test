import { defineBundle, type CommandSink, type Entity } from '../../../ecs/types';
import { PartOf } from '../chat/components';
import { ToolCall, ToolCallEvent, ToolCallPreview, ToolCallPreviewTargetLink, ToolState } from './components';
import { createToolState } from './state';
import type { ToolCallEventKind, ToolCallStatus } from '../../../../shared/protocol';
import { stableIds } from '../../../reliability/stableIdFactory';

export const ToolCallBundle = defineBundle({ name: 'ToolCallBundle', writes: [ToolCall, PartOf, ToolState, ToolCallEvent], mutationMode: 'create', spawns: true });
export const ToolCallEventBundle = defineBundle({ name: 'ToolCallEventBundle', writes: [ToolCallEvent, PartOf], mutationMode: 'create', spawns: true });
export const ToolCallPreviewBundle = defineBundle({ name: 'ToolCallPreviewBundle', writes: [ToolCallPreview, ToolCallPreviewTargetLink], mutationMode: 'update', spawns: true, despawns: true });

export interface SpawnToolCallEventInput {
  toolCall: Entity;
  toolCallId: string;
  kind: ToolCallEventKind;
  at?: number;
  status?: ToolCallStatus;
  elapsedMs?: number;
  durationMs?: number;
  delta?: string;
  payload?: unknown;
  error?: string;
  id?: string;
  seq?: number;
}

export function spawnToolCall(cmd: CommandSink, input: { modelMessage: Entity; id?: string; functionCallId?: string; name: string; argsJson: string; initialStatus?: ToolCallStatus; createdAt?: number }): Entity {
  const entity = cmd.spawn();
  const now = input.createdAt ?? Date.now();
  const id = input.id ?? stableIds.nextToolCallId();
  const status = input.initialStatus ?? 'queued';
  cmd.add(entity, ToolCall, { id, functionCallId: input.functionCallId ?? id, name: input.name, argsJson: input.argsJson, createdAt: now });
  cmd.add(entity, PartOf, { parent: input.modelMessage });
  cmd.add(entity, ToolState, createToolState(status, now));
  spawnToolCallEvent(cmd, { toolCall: entity, toolCallId: id, kind: 'created', status, at: now, payload: { name: input.name, argsJson: input.argsJson } });
  return entity;
}

const maxToolCallEventSeq = new Map<string, number>();

export function rememberToolCallEventSeq(toolCallId: string, seq: number): void {
  const current = maxToolCallEventSeq.get(toolCallId) ?? 0;
  if (seq > current) maxToolCallEventSeq.set(toolCallId, seq);
}

function nextToolCallEventSeq(toolCallId: string): number {
  return (maxToolCallEventSeq.get(toolCallId) ?? 0) + 1;
}

export function spawnToolCallEvent(cmd: CommandSink, input: SpawnToolCallEventInput): Entity {
  const entity = cmd.spawn();
  const at = input.at ?? Date.now();
  const seq = input.seq ?? nextToolCallEventSeq(input.toolCallId);
  rememberToolCallEventSeq(input.toolCallId, seq);
  cmd.add(entity, ToolCallEvent, {
    id: input.id ?? stableIds.nextToolCallEventId(),
    toolCallId: input.toolCallId,
    seq,
    kind: input.kind,
    at,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.elapsedMs !== undefined ? { elapsedMs: input.elapsedMs } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.delta !== undefined ? { delta: input.delta } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.error !== undefined ? { error: input.error } : {})
  });
  cmd.add(entity, PartOf, { parent: input.toolCall });
  return entity;
}

import type { RunExecutionPhase } from '../../../../shared/runLifecycle';
import type {
  AgentRunStatus,
  RunTerminationActor,
  RunTerminationKind,
  RunTerminationReasonCode
} from '../../../../shared/protocol';
import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { AgentRun, RunTermination } from './components';
import { isTerminalRunStatus } from './queries';

export interface LegacyRunTerminationInput {
  status: Extract<AgentRunStatus, 'failed' | 'cancelled' | 'stale' | 'interrupted'>;
  kind: RunTerminationKind;
  actor: RunTerminationActor;
  reasonCode: RunTerminationReasonCode;
  triggerRun?: Entity;
}

/**
 * Legacy ECS writer for the same independent termination fact used by reliable Runs.
 * Message/AgentRun fields never duplicate the cause; this helper is the sole abnormal terminal write.
 */
export function terminateLegacyAgentRun(
  world: WorldReader,
  cmd: CommandSink,
  run: Entity,
  input: LegacyRunTerminationInput,
  now = Date.now()
): boolean {
  const data = world.get(run, AgentRun);
  if (!data || data.lifecycle !== undefined || isTerminalRunStatus(data.status)) return false;
  const existing = world.query(RunTermination).find((entity) => world.get(entity, RunTermination)?.run === run);
  if (existing !== undefined) throw new Error(`Legacy Run ${data.id} already has RunTermination before reaching a terminal status.`);

  cmd.add(run, AgentRun, {
    ...data,
    status: input.status,
    updatedAt: now,
    completedAt: now
  });
  const termination = cmd.spawn();
  const triggerRun = input.triggerRun;
  const triggerRunId = triggerRun === undefined ? undefined : world.get(triggerRun, AgentRun)?.id;
  cmd.add(termination, RunTermination, {
    id: `run-termination:${data.id}`,
    run,
    kind: input.kind,
    actor: input.actor,
    interruptedPhase: legacyInterruptedPhase(data.status),
    reasonCode: input.reasonCode,
    ...(triggerRunId ? { triggerRunId, triggerRun } : {}),
    createdAt: now
  });
  return true;
}

export function legacyInterruptedPhase(status: AgentRunStatus): Exclude<RunExecutionPhase, 'terminal'> {
  switch (status) {
    case 'queued': return 'queued';
    case 'preparing': return 'loading_context';
    case 'waiting_tool': return 'waiting_tools';
    case 'waiting_child_run': return 'waiting_child_run';
    case 'delivering': return 'delivering';
    case 'paused': return 'paused';
    case 'running': return 'llm_streaming';
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'stale':
    case 'interrupted':
      throw new Error(`Cannot derive an interrupted phase from terminal AgentRun status ${status}.`);
  }
}

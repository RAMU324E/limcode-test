import type { TurnRecord } from '../../../shared/conversationReliability';
import type {
  RunTerminationActor,
  RunTerminationKind,
  RunTerminationReasonCode,
  RunTerminationRecord
} from '../../../shared/protocol';
import type { RunId } from '../../../shared/stableIds';
import type { ConversationTransitionBuilder } from './transitionBuilder';

export interface RunTerminationSpec {
  kind: RunTerminationKind;
  actor: RunTerminationActor;
  reasonCode: RunTerminationReasonCode;
  triggerRunId?: RunId;
}

export interface TerminalRunRecords {
  run: TurnRecord;
  termination: RunTerminationRecord;
}

export function runTerminationId(runId: RunId): string {
  return `run-termination:${runId}`;
}

/** Builds the Run state and its independent termination fact as one domain transition. */
export function terminalRunRecords(run: TurnRecord, spec: RunTerminationSpec, now: number): TerminalRunRecords {
  if (run.phase === 'terminal') throw new Error(`Run ${run.id} is already terminal.`);
  if (spec.actor === 'parent_run' && !spec.triggerRunId) {
    throw new Error(`Run ${run.id} parent_run termination requires triggerRunId.`);
  }
  if (spec.triggerRunId === run.id) throw new Error(`Run ${run.id} cannot terminate itself through a parent relation.`);

  return {
    run: {
      ...run,
      lifecycle: spec.kind,
      phase: 'terminal',
      rowVersion: run.rowVersion + 1,
      updatedAt: now,
      completedAt: now
    },
    termination: {
      id: runTerminationId(run.id),
      runId: run.id,
      kind: spec.kind,
      actor: spec.actor,
      interruptedPhase: run.phase,
      reasonCode: spec.reasonCode,
      ...(spec.triggerRunId ? { triggerRunId: spec.triggerRunId } : {}),
      createdAt: now
    }
  };
}

export function appendTerminalRun(
  builder: ConversationTransitionBuilder,
  run: TurnRecord,
  spec: RunTerminationSpec,
  now: number
): TerminalRunRecords {
  const records = terminalRunRecords(run, spec, now);
  builder
    .upsert('turns', records.run)
    .upsert('runTerminations', records.termination);
  return records;
}

export function completedRunRecord(run: TurnRecord, now: number): TurnRecord {
  if (run.phase === 'terminal') throw new Error(`Run ${run.id} is already terminal.`);
  return {
    ...run,
    lifecycle: 'completed',
    phase: 'terminal',
    rowVersion: run.rowVersion + 1,
    updatedAt: now,
    completedAt: now
  };
}

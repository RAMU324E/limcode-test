import type { ReliableKernelBoundedClientState } from '@shared/reliableKernelClientFeed';

export type ReliableInterruptPhase = 'requesting' | 'stopping';

export type InterruptWatchdogDecision =
  | { kind: 'wait' }
  | { kind: 'settled' }
  | { kind: 'retry'; nextAutomaticRetryCount: number }
  | { kind: 'failed' };

export function decideInterruptWatchdog(input: {
  settled: boolean;
  phase: ReliableInterruptPhase;
  automaticRetryCount: number;
  maxAutomaticRetries: number;
}): InterruptWatchdogDecision {
  if (input.settled) return { kind: 'settled' };
  if (input.automaticRetryCount < input.maxAutomaticRetries) {
    return { kind: 'retry', nextAutomaticRetryCount: input.automaticRetryCount + 1 };
  }
  return { kind: 'failed' };
}

/** ACK only records intent; the exact Turn is stopped once it is terminal and no longer leased. */
export function interruptTargetHasSettled(
  records: ReliableKernelBoundedClientState['records'],
  turnId: string
): boolean {
  const turn = records.Turn?.[turnId]
    ?? Object.values(records.Turn ?? {}).find((candidate) => candidate.id === turnId);
  const terminated = turn?.status === 'terminated'
    || Object.values(records.TurnTermination ?? {}).some((candidate) => candidate.turn_id === turnId);
  if (!terminated) return false;
  return !Object.values(records.ExecutionLease ?? {}).some((candidate) => candidate.turn_id === turnId);
}

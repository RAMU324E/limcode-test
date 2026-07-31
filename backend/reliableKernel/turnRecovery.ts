export type TurnRecoveryStatus = 'active' | 'terminated';
export type TurnRecoveryJudgment = 'resume' | 'finalize' | 'needs_human';

export interface TurnRecoveryFacts {
  turnStatus: TurnRecoveryStatus;
  executionLeaseExists: boolean;
  pendingTurnInputExists: boolean;
  turnTerminationExists: boolean;
}

/** Pure implementation of identity.json#recoveryJudgment, in the frozen derivation order. */
export function judgeTurnRecovery(facts: TurnRecoveryFacts): TurnRecoveryJudgment {
  if (facts.turnStatus === 'terminated' && !facts.executionLeaseExists) return 'finalize';
  if (facts.turnStatus === 'terminated' && facts.executionLeaseExists) return 'needs_human';
  if (facts.turnStatus === 'active' && facts.turnTerminationExists) return 'needs_human';
  if (facts.turnStatus === 'active' && facts.executionLeaseExists) return 'resume';
  if (facts.turnStatus === 'active' && facts.pendingTurnInputExists) return 'resume';
  return 'finalize';
}

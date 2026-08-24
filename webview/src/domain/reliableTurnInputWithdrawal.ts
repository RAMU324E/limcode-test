export interface TurnInputWithdrawalResultLike {
  admitted: boolean;
  intentId?: string;
  turnId?: string;
}

export interface TurnInputWithdrawalIntentLike {
  state: string;
  currentRevisionSeq?: string;
}

export interface TurnInputWithdrawalDecisionInput {
  durableReceiptObserved: boolean;
  receiptReplayRequested: boolean;
  result?: TurnInputWithdrawalResultLike;
  intent?: TurnInputWithdrawalIntentLike;
  cancelRequested?: boolean;
}

export type TurnInputWithdrawalDecision =
  | { kind: 'wait' }
  | { kind: 'replay_receipt' }
  | { kind: 'cancel_intent'; intentId: string; expectedRevisionSeq: string }
  | { kind: 'settled' }
  | { kind: 'already_started'; turnId?: string };

/**
 * Determines the next safe action for an optimistic queued-input withdrawal.
 *
 * The original input is replayed only after its durable CommandReceipt is visible, proving replay
 * cannot create a command which had never committed. Once the stable TurnIntent is known, ordinary
 * guidance cancellation owns the durable queue mutation.
 */
export function decideTurnInputWithdrawal(
  input: TurnInputWithdrawalDecisionInput
): TurnInputWithdrawalDecision {
  const result = input.result;
  if (result?.admitted) {
    return { kind: 'already_started', ...(result.turnId ? { turnId: result.turnId } : {}) };
  }
  if (result?.intentId) {
    const intent = input.intent;
    if (!intent) return { kind: 'wait' };
    if (intent.state !== 'queued') return { kind: 'settled' };
    const expectedRevisionSeq = intent.currentRevisionSeq?.trim();
    if (!expectedRevisionSeq || input.cancelRequested) return { kind: 'wait' };
    return {
      kind: 'cancel_intent',
      intentId: result.intentId,
      expectedRevisionSeq
    };
  }
  if (input.durableReceiptObserved && !input.receiptReplayRequested) {
    return { kind: 'replay_receipt' };
  }
  return { kind: 'wait' };
}

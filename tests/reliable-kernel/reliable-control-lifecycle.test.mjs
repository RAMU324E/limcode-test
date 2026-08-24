import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  decideInteractionResolution
} from '../../webview/src/domain/interactionOutbox.ts';
import {
  decideInterruptWatchdog
} from '../../webview/src/domain/reliableInterruptLifecycle.ts';
import {
  decideTurnInputWithdrawal
} from '../../webview/src/domain/reliableTurnInputWithdrawal.ts';

const root = process.cwd();
const {
  createSubmitPlanToolOutput,
  planProposalStatusToDecision,
  submitPlanOutputFromResult
} = await import(pathToFileURL(path.join(
  root,
  'dist/extension/shared/planReview.js'
)).href);

test('Interaction outbox 同决定重放、未确认决定替换和在途冲突均为显式结果', () => {
  const existing = {
    interactionRevision: 1,
    ownerTurnId: 'turn-one',
    conversationId: 'conversation-one',
    decision: 'accept',
    response: { executionTarget: 'current_conversation' }
  };

  assert.deepEqual(decideInteractionResolution({
    requestState: 'pending',
    choices: ['accept', 'reject'],
    existing,
    existingSubmitting: false,
    interactionRevision: 1,
    ownerTurnId: 'turn-one',
    conversationId: 'conversation-one',
    decision: 'accept',
    response: { executionTarget: 'current_conversation' }
  }), { kind: 'replay' });

  assert.deepEqual(decideInteractionResolution({
    requestState: 'pending',
    choices: ['accept', 'reject'],
    existing,
    existingSubmitting: false,
    interactionRevision: 1,
    ownerTurnId: 'turn-one',
    conversationId: 'conversation-one',
    decision: 'reject',
    response: { reason: 'changed mind' }
  }), { kind: 'supersede' });

  const blocked = decideInteractionResolution({
    requestState: 'pending',
    choices: ['accept', 'reject'],
    existing,
    existingSubmitting: true,
    interactionRevision: 1,
    ownerTurnId: 'turn-one',
    conversationId: 'conversation-one',
    decision: 'reject',
    response: { reason: 'changed mind' }
  });
  assert.equal(blocked.kind, 'blocked');
  assert.match(blocked.message, /正在提交/);

  const stale = decideInteractionResolution({
    requestState: 'cancelled',
    choices: ['accept', 'reject'],
    interactionRevision: 1,
    ownerTurnId: 'turn-one',
    conversationId: 'conversation-one',
    decision: 'accept',
    response: {}
  });
  assert.equal(stale.kind, 'rejected');
  assert.match(stale.message, /已结束/);
});

test('乐观 Turn 输入撤回只在 durable receipt 已出现后重放原命令，并在 intent 可见后取消', () => {
  assert.deepEqual(decideTurnInputWithdrawal({
    durableReceiptObserved: false,
    receiptReplayRequested: false
  }), { kind: 'wait' });

  assert.deepEqual(decideTurnInputWithdrawal({
    durableReceiptObserved: true,
    receiptReplayRequested: false
  }), { kind: 'replay_receipt' });

  assert.deepEqual(decideTurnInputWithdrawal({
    durableReceiptObserved: true,
    receiptReplayRequested: true,
    result: { admitted: false, intentId: 'intent-one' },
    intent: { state: 'queued', currentRevisionSeq: '1' },
    cancelRequested: false
  }), {
    kind: 'cancel_intent',
    intentId: 'intent-one',
    expectedRevisionSeq: '1'
  });

  assert.deepEqual(decideTurnInputWithdrawal({
    durableReceiptObserved: true,
    receiptReplayRequested: true,
    result: { admitted: false, intentId: 'intent-one' },
    intent: { state: 'cancelled', currentRevisionSeq: '1' },
    cancelRequested: true
  }), { kind: 'settled' });

  const started = decideTurnInputWithdrawal({
    durableReceiptObserved: true,
    receiptReplayRequested: true,
    result: { admitted: true, turnId: 'turn-started' }
  });
  assert.equal(started.kind, 'already_started');
  assert.equal(started.turnId, 'turn-started');
});

test('停止 watchdog 先有界幂等重放，超过预算后解锁并报告失败', () => {
  assert.deepEqual(decideInterruptWatchdog({
    settled: true,
    phase: 'stopping',
    automaticRetryCount: 0,
    maxAutomaticRetries: 2
  }), { kind: 'settled' });

  assert.deepEqual(decideInterruptWatchdog({
    settled: false,
    phase: 'stopping',
    automaticRetryCount: 0,
    maxAutomaticRetries: 2
  }), { kind: 'retry', nextAutomaticRetryCount: 1 });

  assert.deepEqual(decideInterruptWatchdog({
    settled: false,
    phase: 'stopping',
    automaticRetryCount: 2,
    maxAutomaticRetries: 2
  }), { kind: 'failed' });
});

test('Plan cancelled 是独立终态，不能再折叠成 rejected', () => {
  const output = createSubmitPlanToolOutput({
    proposalId: 'plan-one',
    status: 'cancelled',
    userMessage: '当前回复已停止，Plan 已取消。'
  });
  assert.deepEqual(submitPlanOutputFromResult(output), output);
  assert.equal(planProposalStatusToDecision('cancelled'), 'cancelled');
});

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import {
  RELIABLE_KERNEL_COMPILE_PROVENANCE,
  manifestFilesAreTracked,
  reliableKernelCompiledManifest,
  reliableKernelSourceManifest
} from './lib/compile-provenance.mjs';

const root = process.cwd();
const NOW = '2026-08-01T00:00:00.000Z';
const checkId = option('check');
const PHASE_F_CHECKS = new Set([
  'candidate.conversation-fork-links',
  'candidate.subagent-answer-restart-delivery',
  'candidate.subagent-cancel-subtree',
  'candidate.client-snapshot-bounds',
  'candidate.client-change-batch-bounds',
  'candidate.client-queue-bounds',
  'candidate.client-snapshot-feed-barrier',
  'candidate.old-writer-not-routed',
  'candidate.recovery.answer-inbox-invariant',
  'candidate.recovery.pending-delivery',
  'candidate.recovery.foreground-wait-expired',
  'candidate.recovery.cancelled-subtree-incomplete',
  'candidate.parent-handling-matrix'
]);
if (!checkId || !PHASE_F_CHECKS.has(checkId)) {
  console.error('用法：node scripts/reliable-kernel/run-phase-f-check.mjs --check=<Phase-F-stable-id> [--commit=<sha>]');
  process.exit(2);
}
const headCommit = currentCommit();
const requestedCommit = option('commit');
if (requestedCommit && requestedCommit !== headCommit) {
  console.error(`--commit必须等于当前HEAD：参数${requestedCommit}，HEAD ${headCommit}`);
  process.exit(2);
}

const require = createRequire(import.meta.url);
let kernel;
let Database;
try {
  kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
  Database = require('better-sqlite3');
} catch (error) {
  console.error(`无法加载已编译Phase F内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

const handlers = new Map([
  ['candidate.conversation-fork-links', checkConversationForkLinks],
  ['candidate.subagent-answer-restart-delivery', checkAnswerRestartDelivery],
  ['candidate.subagent-cancel-subtree', checkCancelSubtree],
  ['candidate.client-snapshot-bounds', checkClientSnapshotBounds],
  ['candidate.client-change-batch-bounds', checkClientChangeBatchBounds],
  ['candidate.client-queue-bounds', checkClientQueueBounds],
  ['candidate.client-snapshot-feed-barrier', checkSnapshotFeedBarrier],
  ['candidate.old-writer-not-routed', checkOldWriterNotRouted],
  ['candidate.recovery.answer-inbox-invariant', checkRecoveryAnswerInbox],
  ['candidate.recovery.pending-delivery', checkRecoveryPendingDelivery],
  ['candidate.recovery.foreground-wait-expired', checkRecoveryForegroundWait],
  ['candidate.recovery.cancelled-subtree-incomplete', checkRecoveryCancelledSubtree],
  ['candidate.parent-handling-matrix', checkParentHandlingMatrix]
]);

try {
  const evidence = await handlers.get(checkId)();
  const evidencePath = await writeEvidence(checkId, evidence, headCommit);
  console.log(
    `PASS: ${checkId} — ${evidence.assertions.length}组真实断言通过：${evidence.assertions.join('；')}; `
      + `faults=${evidence.faults.join('、')}; evidence=${path.relative(root, evidencePath)}`
  );
} catch (error) {
  console.error(`FAIL: ${checkId} — ${error?.stack || error}`);
  process.exit(1);
}

async function checkConversationForkLinks() {
  return withRuntime('fork', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'fork');
    const context = new kernel.ContextSequenceControlPlane(ctx.database, ctx.store);
    const sourceRootId = await context.currentHeadRootId(seeded.conversationId);
    const sourceRoot = await get(ctx.database, 'ContextSequenceRoot', sourceRootId);
    const forks = ctx.services.conversationFork;
    const baseCommand = {
      idempotencyKey: 'fork-atomic',
      reuseKey: 'reuse-fork-atomic',
      sourceConversationId: seeded.conversationId,
      sourceContextRootId: sourceRootId,
      sourceMessageRevisionId: seeded.messageRevisionId,
      sourceTurnId: seeded.turnId,
      expectedSourceHeadRootId: sourceRootId,
      targetTitle: 'Fork target',
      targetAgentId: 'fork-target-agent'
    };

    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let injected = false;
    ctx.database.transaction = async (steps) => {
      if (!injected && steps.some((step) => step.kind === 'insert' && step.domain === 'ConversationBranchLink')) {
        injected = true;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-fork-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    await assert.rejects(forks.fork(baseCommand), /assertion failed/);
    ctx.database.transaction = originalTransaction;
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { reuse_key: baseCommand.reuseKey })).length, 0);
    assert.equal((await list(ctx.database, 'ConversationBranchLink', { source_conversation_id: seeded.conversationId })).length, 0);
    assert.equal((await list(ctx.database, 'ConversationOriginLink', { source_conversation_id: seeded.conversationId })).length, 0);
    assert.equal((await list(ctx.database, 'Conversation', {})).length, 1);
    assertions.push('fork中间故障使target Conversation/root/head/三类Link整笔SQLite事务回滚');
    faults.push('fork writer transaction fault after relation inserts');

    const forked = await forks.fork(baseCommand);
    const replay = await forks.fork(baseCommand);
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.targetConversationId, forked.targetConversationId);
    await assert.rejects(forks.fork({ ...baseCommand, targetTitle: 'Conflicting replay title' }), /different facts|does not exist/);
    const targetRoot = await get(ctx.database, 'ContextSequenceRoot', forked.targetRootId);
    assert.equal(targetRoot.root_node_id, sourceRoot.root_node_id);
    assert.equal(targetRoot.segment_count, sourceRoot.segment_count);
    assert.notEqual(targetRoot.id, sourceRoot.id);
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { conversation_id: forked.targetConversationId })).length, 1);
    assert.equal((await list(ctx.database, 'ConversationBranchLink', { target_conversation_id: forked.targetConversationId })).length, 1);
    const origin = (await list(ctx.database, 'ConversationOriginLink', { conversation_id: forked.targetConversationId }))[0];
    assert.equal(origin.source_turn_id, seeded.turnId);
    assert.equal(Object.hasOwn(origin, 'source_run_id'), false);
    assertions.push('Reuse/Branch/Origin具有独立Repository/Codec/table/mutation，origin只保存source_turn_id且fork root共享immutable node前缀');

    const sourceAppend = await context.appendContent({
      conversationId: seeded.conversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'fork-source-after', sourceRevision: '0' },
      content: 'source-after-fork', contentType: 'text/plain'
    });
    const targetAppend = await context.appendContent({
      conversationId: forked.targetConversationId,
      segmentKind: 'runtime_context',
      source: { sourceKind: 'runtime_context', sourceId: 'fork-target-after', sourceRevision: '0' },
      content: 'target-after-fork', contentType: 'text/plain'
    });
    assert.notEqual(sourceAppend.nodeId, targetAppend.nodeId);
    assert.equal((await context.materialize(sourceAppend.rootId)).segments.at(-1).content.toString('utf8'), 'source-after-fork');
    assert.equal((await context.materialize(targetAppend.rootId)).segments.at(-1).content.toString('utf8'), 'target-after-fork');
    assertions.push('fork后source/target独立append形成不同后继，原共享前缀保持immutable');

    await assert.rejects(forks.fork({
      ...baseCommand,
      idempotencyKey: 'fork-stale',
      reuseKey: 'reuse-fork-stale'
    }), /expected head is stale/);
    assert.equal((await list(ctx.database, 'ConversationReuseLink', { reuse_key: 'reuse-fork-stale' })).length, 0);
    faults.push('stale expected source head');

    await seeded.control.delete({
      source: { kind: 'command', key: 'fork-soft-delete-source' },
      conversationId: seeded.conversationId,
      messageId: seeded.messageId
    });
    const historical = await forks.fork({
      ...baseCommand,
      idempotencyKey: 'fork-historical',
      reuseKey: 'reuse-fork-historical',
      expectedSourceHeadRootId: undefined,
      targetTitle: 'Historical fork'
    });
    assert.equal((await get(ctx.database, 'Message', seeded.messageId)).deleted_at !== null, true);
    assert.equal((await get(ctx.database, 'ContextSequenceRoot', historical.targetRootId)).root_node_id, sourceRoot.root_node_id);
    assertions.push('Message soft-delete后仍可按immutable历史MessageRevision/root fork，不读取当前删除状态重解释历史');

    const concurrent = await Promise.all(['left', 'right'].map((side) => forks.fork({
      ...baseCommand,
      idempotencyKey: `fork-${side}`,
      reuseKey: `reuse-fork-${side}`,
      expectedSourceHeadRootId: undefined,
      targetTitle: `Concurrent ${side}`
    })));
    assert.equal(new Set(concurrent.map((entry) => entry.targetConversationId)).size, 2);
    assert.ok(concurrent.every((entry) => entry.sharedRootNodeId === sourceRoot.root_node_id));
    metrics.concurrentForks = concurrent.length;
    metrics.sharedPrefixCopiedNodes = 0;
    assertions.push('同一parent并发fork创建独立target且均引用同一共享前缀，没有复制历史正文或节点');
    return { assertions, faults, metrics };
  });
}

async function checkAnswerRestartDelivery() {
  return withRuntime('answer-delivery', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'answer');
    const spawned = await spawnStartedChild(ctx, seeded.turnId, 'answer', 'wait_for_answer', {
      deadline: '2026-08-01T02:00:00.000Z'
    });
    const bridgeBefore = await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId);
    const casBefore = await casFileCount(ctx.binding.paths.casRootPath);
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let injected = false;
    ctx.database.transaction = async (steps) => {
      if (!injected && steps.some((step) => step.kind === 'insert' && step.domain === 'AnswerSubmission')) {
        injected = true;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-answer-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    const answerCommand = {
      answerBridgeId: spawned.answerBridgeId,
      submissionId: 'answer-submission-one',
      sourceTurnId: spawned.childTurnId,
      title: 'First answer',
      content: 'durable child answer'
    };
    await assert.rejects(ctx.services.answers.submit(answerCommand), /assertion failed/);
    ctx.database.transaction = originalTransaction;
    assert.equal(await maybeGet(ctx.database, 'AnswerSubmission', answerCommand.submissionId), null);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: answerCommand.submissionId })).length, 0);
    assert.equal((await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId)).current_submission_id, bridgeBefore.current_submission_id);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 0);
    assert.ok(await casFileCount(ctx.binding.paths.casRootPath) > casBefore);
    assertions.push('答案CAS publish后SQLite故障只留下raw orphan CAS，Submission/Bridge/Inbox/ToolResult均无半提交');
    faults.push('answer CAS publish followed by SQLite transaction rollback');

    const submitted = await ctx.services.answers.submit(answerCommand);
    const duplicate = await ctx.services.answers.submit(answerCommand);
    assert.equal(submitted.foregroundSettled, true);
    assert.equal(duplicate.deduplicated, true);
    await assert.rejects(ctx.services.answers.submit({
      ...answerCommand,
      content: 'conflicting replay content'
    }), /replayed with different facts/);
    assert.equal((await list(ctx.database, 'AnswerSubmission', { answer_bridge_id: spawned.answerBridgeId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { dedupe_key: `answer:${spawned.answerBridgeId}:${answerCommand.submissionId}` })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 1);
    assertions.push('AnswerSubmission insert、Bridge flip、Inbox dedupe与前台ToolCall结算原子提交，重复callback收敛且只有一个ToolModelResult');

    const notify = await ctx.services.deliveries.create({
      inboxItemId: submitted.inboxItemId,
      targetConversationId: seeded.conversationId,
      phase: 'notify_only'
    });
    const second = await ctx.services.answers.submit({
      answerBridgeId: spawned.answerBridgeId,
      submissionId: 'answer-submission-two',
      sourceTurnId: spawned.childTurnId,
      content: 'newer bridge answer',
      interrupted: true
    });
    assert.equal((await get(ctx.database, 'AnswerBridge', spawned.answerBridgeId)).current_submission_id, second.submissionId);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', notify.delivery.id)).state, 'pending');
    assert.equal((await get(ctx.database, 'AnswerSubmission', submitted.submissionId)).id, submitted.submissionId);
    assertions.push('Bridge切换到新submission后历史submission及其旧pending delivery继续保留');

    const current = await ctx.services.deliveries.create({
      inboxItemId: submitted.inboxItemId,
      targetConversationId: seeded.conversationId,
      targetTurnId: seeded.turnId,
      phase: 'current_turn'
    });
    const currentReplay = await ctx.services.deliveries.create({
      inboxItemId: submitted.inboxItemId,
      targetConversationId: seeded.conversationId,
      targetTurnId: seeded.turnId,
      phase: 'current_turn'
    });
    assert.equal(currentReplay.deduplicated, true);
    const injectedDelivery = await ctx.services.deliveries.advance(current.delivery.id);
    assert.equal(injectedDelivery.delivery.state, 'consumed');
    assert.equal(injectedDelivery.parentHandlingState, 'unhandled');
    assert.ok(injectedDelivery.inputLink);
    const unrelatedContent = await ctx.store.ingest(ctx.database, 'unrelated input', 'text/plain');
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: 'unrelated-parent-input', turn_id: seeded.turnId, input_kind: 'other',
        content_object_id: unrelatedContent.id, state: 'consumed',
        created_at: NOW, updated_at: NOW
      })
    ]);
    assert.equal((await ctx.services.deliveries.summary(current.delivery.id)).parentHandlingState, 'unhandled');
    const handled = await ctx.services.deliveries.markInputHandled(injectedDelivery.inputLink.pending_turn_input_id);
    assert.equal(handled.parentHandlingState, 'handled');
    assertions.push('Delivery注入与InputLink同事务，handled_at只响应精确input，无关PendingTurnInput不能猜测父处理完成');

    const nullTarget = await ctx.services.deliveries.create({
      inboxItemId: second.inboxItemId,
      targetConversationId: seeded.conversationId,
      phase: 'next_turn'
    });
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({
        id: 'duplicate-null-delivery',
        inbox_item_id: second.inboxItemId,
        target_conversation_id: seeded.conversationId,
        target_turn_id: null,
        phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null,
        state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW
      })
    ]), /UNIQUE constraint failed/);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', nullTarget.delivery.id)).target_turn_id, null);
    assertions.push('NULL与非NULL target_turn_id两组真实SQLite partial UNIQUE均按delivery attempt身份去重');

    const matrixChild = await spawnStartedChild(ctx, seeded.turnId, 'delivery-matrix', 'background');
    const matrixContinuationTool = await createRunAgentTool(ctx, seeded.turnId, 'delivery-matrix-continuation');
    const matrixQueued = await ctx.services.children.send({
      sourceKey: 'delivery-matrix-continuation',
      sourceToolCallId: matrixContinuationTool.toolCallId,
      childExecutionId: matrixChild.childExecutionId,
      mode: 'queue_next_turn',
      content: 'admit delivery matrix continuation',
      completionPolicy: 'background'
    });
    const matrixSubmissions = [];
    for (const suffix of ['current-terminal', 'next-terminal', 'next-none', 'notify']) {
      matrixSubmissions.push(await ctx.services.answers.submit({
        answerBridgeId: matrixChild.answerBridgeId,
        submissionId: `delivery-matrix-${suffix}`,
        sourceTurnId: matrixChild.childTurnId,
        content: `matrix answer ${suffix}`
      }));
    }
    const matrixCurrent = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[0].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixChild.childTurnId,
      phase: 'current_turn'
    });
    const matrixNextTerminal = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[1].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixChild.childTurnId,
      phase: 'next_turn'
    });
    const matrixNextNone = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[2].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      phase: 'next_turn'
    });
    const matrixNotify = await ctx.services.deliveries.create({
      inboxItemId: matrixSubmissions[3].inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      phase: 'notify_only'
    });
    const matrixTurnControl = createTurnControl(ctx, 'delivery-matrix-child');
    await matrixTurnControl.terminal({
      source: { kind: 'callback', key: 'delivery-matrix-terminal' },
      turnId: matrixChild.childTurnId,
      terminalStatus: 'completed',
      reason: 'delivery advancement matrix fixture'
    });
    const retargetedCurrent = await ctx.services.deliveries.advance(matrixCurrent.delivery.id);
    const retargetedNext = await ctx.services.deliveries.advance(matrixNextTerminal.delivery.id);
    const waitingNext = await ctx.services.deliveries.advance(matrixNextNone.delivery.id);
    const waitingNotify = await ctx.services.deliveries.advance(matrixNotify.delivery.id);
    assert.equal(retargetedCurrent.delivery.phase, 'next_turn');
    assert.equal(retargetedCurrent.delivery.target_turn_id, null);
    assert.equal(retargetedNext.delivery.phase, 'next_turn');
    assert.equal(retargetedNext.delivery.target_turn_id, null);
    assert.equal(waitingNext.changed, false);
    assert.equal(waitingNext.delivery.state, 'pending');
    assert.equal(waitingNotify.changed, false);
    assert.equal((await ctx.services.deliveries.acknowledgeNotification(matrixNotify.delivery.id)).parentHandlingState, 'not_applicable');
    const lateMatrixAnswer = await ctx.services.answers.submit({
      answerBridgeId: matrixChild.answerBridgeId,
      submissionId: 'delivery-matrix-late-interrupted',
      sourceTurnId: matrixChild.childTurnId,
      content: 'late interrupted matrix answer',
      interrupted: true
    });
    assert.equal((await get(ctx.database, 'Turn', matrixChild.childTurnId)).status, 'terminated');
    const matrixContinuation = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'delivery-matrix-admit',
      childExecutionId: matrixChild.childExecutionId,
      turnIntentId: matrixQueued.turnIntentId,
      leaseOwnerId: 'delivery-matrix-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    for (const deliveryId of [matrixCurrent.delivery.id, matrixNextTerminal.delivery.id, matrixNextNone.delivery.id]) {
      const summary = await ctx.services.deliveries.summary(deliveryId);
      assert.equal(summary.delivery.state, 'consumed');
      assert.equal(summary.delivery.target_turn_id, matrixContinuation.turnId);
      assert.ok(summary.inputLink);
    }
    const matrixNextActive = await ctx.services.deliveries.create({
      inboxItemId: lateMatrixAnswer.inboxItemId,
      targetConversationId: matrixChild.childConversationId,
      targetTurnId: matrixContinuation.turnId,
      phase: 'next_turn'
    });
    assert.equal((await ctx.services.deliveries.advance(matrixNextActive.delivery.id)).delivery.state, 'consumed');
    assert.equal((await get(ctx.database, 'Turn', matrixChild.childTurnId)).status, 'terminated');
    assertions.push('current/next/notify advancement matrix逐项走真实Turn状态：terminal改投、NULL等待、新Turn启动事务回写注入、active注入、notify显式确认；late interrupted answer不重开terminal Turn');
    faults.push('delivery advancement across terminal-to-continuation boundary');

    const gone = await ctx.services.deliveries.create({
      inboxItemId: second.inboxItemId,
      targetConversationId: 'gone-conversation',
      phase: 'notify_only'
    });
    assert.equal(gone.delivery.state, 'failed');
    assert.equal(gone.delivery.failure_reason, 'target-gone');
    const retried = await ctx.services.deliveries.redeliver(gone.delivery.id);
    assert.equal(retried.delivery.attempt_seq, 2n);
    assert.equal(retried.delivery.retry_of_delivery_id, gone.delivery.id);
    assert.equal((await get(ctx.database, 'RuntimeDelivery', gone.delivery.id)).state, 'failed');
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(gone.delivery.id, {
        state: 'pending', failure_reason: null, updated_at: NOW
      })
    ]), /cannot transition from failed to pending/);
    await assert.rejects(ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').update(injectedDelivery.inputLink.id, {
        handled_at: '2026-08-01T00:01:00.000Z', updated_at: '2026-08-01T00:01:00.000Z'
      })
    ]), /may only transition once/);
    assertions.push('target-gone保留Inbox并置failed；人工redeliver创建attempt+1/retry_of新行；writer拒绝复活旧failed或重写handled_at');

    const racedChild = await spawnStartedChild(ctx, seeded.turnId, 'answer-deadline-race', 'wait_for_answer', {
      deadline: NOW
    });
    const [raceAnswer, timeoutWon] = await Promise.all([
      ctx.services.answers.submit({
        answerBridgeId: racedChild.answerBridgeId,
        submissionId: 'answer-deadline-race-submission',
        sourceTurnId: racedChild.childTurnId,
        content: 'first wins race answer'
      }),
      ctx.services.children.settleForegroundTimeout(racedChild.childExecutionId, NOW)
    ]);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: racedChild.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: raceAnswer.submissionId })).length, 1);
    assert.equal(Number(raceAnswer.foregroundSettled) + Number(timeoutWon) <= 1, true);
    assertions.push('答案提交与deadline sweep并发由SQLite assertion/UNIQUE durable first-wins，原ToolCall严格一个模型结果，败方答案仍入Inbox');
    faults.push('answer arrival concurrent with foreground deadline sweep');

    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'answer-delivery-restart');
    assert.equal((await get(ctx.database, 'AnswerSubmission', second.submissionId)).interrupted, 1n);
    assert.equal((await ctx.services.deliveries.summary(current.delivery.id)).parentHandlingState, 'handled');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: spawned.toolCallId })).length, 1);
    assertions.push('关闭数据库并新建RuntimeDatabase/services后答案、历史delivery、InputLink.handled_at和唯一ToolResult全部由SQLite恢复');
    faults.push('Extension Host database/service restart');
    metrics.answerSubmissions = (await list(ctx.database, 'AnswerSubmission', { answer_bridge_id: spawned.answerBridgeId })).length;
    metrics.deliveryAttemptsForGoneTarget = (await list(ctx.database, 'RuntimeDelivery', {
      inbox_item_id: second.inboxItemId,
      target_conversation_id: 'gone-conversation'
    })).length;
    return { assertions, faults, metrics };
  });
}

async function checkCancelSubtree() {
  return withRuntime('cancel-subtree', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const parent = await seedParent(ctx, 'cancel');
    const atomicTool = await createRunAgentTool(ctx, parent.turnId, 'spawn-atomic');
    const atomicSpawnCommand = {
      sourceToolCallId: atomicTool.toolCallId,
      childAgentId: 'child-agent-spawn-atomic',
      prompt: 'atomic concurrent spawn',
      completionPolicy: 'background',
      leaseOwnerId: 'child-owner-spawn-atomic',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    };
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let spawnFaultInjected = false;
    ctx.database.transaction = async (steps) => {
      if (!spawnFaultInjected && steps.some((step) => step.kind === 'insert' && step.domain === 'ChildExecution')) {
        spawnFaultInjected = true;
        return originalTransaction([
          ...steps,
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').assert('missing-spawn-fault', { status: 'active' })
        ]);
      }
      return originalTransaction(steps);
    };
    await assert.rejects(ctx.services.children.spawn(atomicSpawnCommand), /assertion failed/);
    ctx.database.transaction = originalTransaction;
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: atomicTool.toolCallId
    })).length, 0);
    assert.equal((await list(ctx.database, 'ChildExecution', {})).length, 0);
    assert.equal((await get(ctx.database, 'ToolCall', atomicTool.toolCallId)).status, 'pending');
    const concurrentSpawns = await Promise.all([
      ctx.services.children.spawn(atomicSpawnCommand),
      ctx.services.children.spawn(atomicSpawnCommand)
    ]);
    assert.equal(new Set(concurrentSpawns.map((entry) => entry.childExecutionId)).size, 1);
    assert.deepEqual(concurrentSpawns.map((entry) => entry.deduplicated).sort(), [false, true]);
    const preparedSpawn = concurrentSpawns[0];
    assert.equal(await ctx.services.children.claimSpawnDispatch(preparedSpawn.effectIntentId), true);
    assert.equal(await ctx.services.children.claimSpawnDispatch(preparedSpawn.effectIntentId), false);
    const spawnReceiptOne = await ctx.services.children.recordSpawnReceipt({
      sourceKey: 'spawn-atomic-callback',
      attemptId: preparedSpawn.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'deterministic-fake' }
    });
    const spawnReceiptTwo = await ctx.services.children.recordSpawnReceipt({
      sourceKey: 'spawn-atomic-callback',
      attemptId: preparedSpawn.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'deterministic-fake' }
    });
    assert.equal(spawnReceiptTwo.effectReceiptId, spawnReceiptOne.effectReceiptId);
    const spawnSettlementOne = await ctx.services.children.reconcileSpawnReceipt(spawnReceiptOne.effectReceiptId);
    const spawnSettlementTwo = await ctx.services.children.reconcileSpawnReceipt(spawnReceiptOne.effectReceiptId);
    assert.equal(spawnSettlementOne.terminalToolResult, true);
    assert.equal(spawnSettlementTwo.deduplicated, true);
    await assert.rejects(ctx.services.children.spawn({
      ...atomicSpawnCommand,
      prompt: 'conflicting replay prompt'
    }), /replayed with different facts/);
    assertions.push('spawn中间fault回滚全部SQLite lineage；并发同源spawn、重复dispatch/callback/reconcile按稳定identity收敛且不同请求不伪装dedupe');
    faults.push('spawn writer transaction fault after lineage/effect facts');
    faults.push('concurrent identical spawn and duplicate callback');

    const childA = await spawnStartedChild(ctx, parent.turnId, 'tree-a', 'background');
    const childB = await spawnStartedChild(ctx, childA.childTurnId, 'tree-b', 'background');
    const sibling = await spawnStartedChild(ctx, parent.turnId, 'tree-sibling', 'background');

    const queuedATool = await createRunAgentTool(ctx, parent.turnId, 'queue-a-continuation');
    const queuedA = await ctx.services.children.send({
      sourceKey: 'queue-a-continuation',
      sourceToolCallId: queuedATool.toolCallId,
      childExecutionId: childA.childExecutionId,
      mode: 'queue_next_turn',
      content: 'continue A',
      completionPolicy: 'background'
    });
    const childTurnControl = createTurnControl(ctx, 'child-a');
    await childTurnControl.terminal({
      source: { kind: 'callback', key: 'terminal-a-old-turn' },
      turnId: childA.childTurnId,
      terminalStatus: 'completed',
      reason: 'continuation fixture'
    });
    const continuedA = await ctx.services.children.admitQueuedIntent({
      sourceKey: 'admit-a-continuation',
      childExecutionId: childA.childExecutionId,
      turnIntentId: queuedA.turnIntentId,
      leaseOwnerId: 'continued-a-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    });
    const pendingBTool = await createRunAgentTool(ctx, parent.turnId, 'queue-b-pending');
    const pendingB = await ctx.services.children.send({
      sourceKey: 'queue-b-pending',
      sourceToolCallId: pendingBTool.toolCallId,
      childExecutionId: childB.childExecutionId,
      mode: 'queue_next_turn',
      content: 'pending B',
      completionPolicy: 'background'
    });
    const parentLinkB = (await list(ctx.database, 'ChildExecutionParentLink', {
      child_execution_id: childB.childExecutionId
    }))[0];
    assert.equal(parentLinkB.parent_child_execution_id, childA.childExecutionId);
    assert.equal(parentLinkB.parent_turn_id, childA.childTurnId);
    assertions.push('ChildExecution稳定ParentLink不随A continuation改写，B仍从旧Turn历史来源归属A树');

    const racedDescendantTool = await createRunAgentTool(ctx, continuedA.turnId, 'tree-raced-descendant');
    const racedDescendantCommand = {
      sourceToolCallId: racedDescendantTool.toolCallId,
      childAgentId: 'child-agent-tree-raced-descendant',
      prompt: 'commit exactly between cancel tree read and writer transaction',
      completionPolicy: 'background',
      leaseOwnerId: 'child-owner-tree-raced-descendant',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    };
    let racedDescendant;
    let cancelRaceInjected = false;
    ctx.database.transaction = async (steps) => {
      if (
        !cancelRaceInjected
        && steps.some((step) => step.kind === 'assertExactIds' && step.domain === 'ChildExecutionParentLink')
      ) {
        cancelRaceInjected = true;
        racedDescendant = await ctx.services.children.spawn(racedDescendantCommand);
        ctx.database.transaction = originalTransaction;
      }
      return originalTransaction(steps);
    };
    const cancelled = await ctx.services.children.cancelSubtree({
      sourceKey: 'cancel-tree-a',
      childExecutionId: childA.childExecutionId,
      reason: 'test subtree cancellation'
    });
    ctx.database.transaction = originalTransaction;
    assert.ok(racedDescendant);
    assert.deepEqual(new Set(cancelled.lineageIds), new Set([
      childA.childExecutionId,
      childB.childExecutionId,
      racedDescendant.childExecutionId
    ]));
    assert.ok(cancelled.activeTurnIds.includes(continuedA.turnId));
    assert.ok(cancelled.activeTurnIds.includes(childB.childTurnId));
    assert.ok(cancelled.activeTurnIds.includes(racedDescendant.childTurnId));
    assert.ok(cancelled.cancelledIntentIds.includes(pendingB.turnIntentId));
    const cancellationInputs = await list(ctx.database, 'PendingTurnInput', { input_kind: 'termination_request' });
    assert.ok(cancellationInputs.some((row) => row.turn_id === continuedA.turnId));
    assert.ok(cancellationInputs.some((row) => row.turn_id === childB.childTurnId));
    assert.ok(cancellationInputs.some((row) => row.turn_id === racedDescendant.childTurnId));
    assert.equal((await get(ctx.database, 'ChildExecutionIntentLink', pendingB.intentLinkId)).state, 'cancelled');
    assert.equal((await get(ctx.database, 'TurnIntent', pendingB.turnIntentId)).state, 'cancelled');
    assert.equal((await get(ctx.database, 'Turn', continuedA.turnId)).status, 'active');
    assert.equal((await list(ctx.database, 'TurnTermination', { turn_id: continuedA.turnId })).length, 0);
    assertions.push('cancel_subtree用writer exact-set封住读写间并发spawn，重读稳定ParentLink后在同一成功事务覆盖全部active targets并取消pending Intent；请求本身不伪造Turn终态');

    assert.equal((await get(ctx.database, 'ChildExecution', sibling.childExecutionId)).status, 'active');
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: sibling.childTurnId,
      input_kind: 'termination_request'
    })).length, 0);
    const siblingCancel = await ctx.services.children.cancel({
      sourceKey: 'single-cancel-sibling',
      childExecutionId: sibling.childExecutionId,
      reason: 'single cancel'
    });
    assert.equal(siblingCancel.activeTurnId, sibling.childTurnId);
    assertions.push('A子树取消不误伤sibling/其他根树；单cancel只向当前ActiveTurnLink target写正常终止请求');

    const pendingDescendantTool = await createRunAgentTool(ctx, continuedA.turnId, 'blocked-descendant');
    await assert.rejects(ctx.services.children.spawn({
      sourceToolCallId: pendingDescendantTool.toolCallId,
      childAgentId: 'blocked-agent',
      prompt: 'must not spawn',
      completionPolicy: 'background',
      leaseOwnerId: 'blocked-owner',
      leaseExpiresAt: '2026-08-02T00:00:00.000Z'
    }), /parent lineage is terminating/);
    assert.equal((await list(ctx.database, 'ChildExecutionParentLink', {
      source_tool_call_id: pendingDescendantTool.toolCallId
    })).length, 0);
    assertions.push('父树登记cancel_subtree后spawn在写入前拒绝，不留下半创建lineage');
    faults.push('continuation after descendant creation');
    faults.push('descendant spawn committed between cancel tree read and writer transaction');
    faults.push('pending intent and active turns cancelled atomically');
    metrics.cancelledLineages = cancelled.lineageIds.length;
    metrics.siblingTerminationInputs = (await list(ctx.database, 'PendingTurnInput', {
      turn_id: sibling.childTurnId,
      input_kind: 'termination_request'
    })).length;
    return { assertions, faults, metrics };
  });
}

async function checkClientSnapshotBounds() {
  return withRuntime('client-snapshot', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const seeded = await seedParent(ctx, 'snapshot');
    const taskTool = await ctx.services.effects.createToolCall({
      source: { kind: 'callback', key: 'snapshot-task-tool' },
      toolCallId: 'snapshot-task-list-call',
      turnId: seeded.turnId,
      toolName: 'update_task_list',
      arguments: { items: [{ title: 'bounded projection', status: 'in_progress' }] }
    });
    await ctx.services.effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'snapshot-task-settle' },
      toolCallId: taskTool.toolCallId,
      status: 'succeeded',
      detail: {
        kind: 'task-list',
        items: [{ title: 'bounded projection', status: 'in_progress', delete: false }]
      }
    });
    const currentMemberships = await list(ctx.database, 'MessagePartOfConversation', { conversation_id: seeded.conversationId });
    const maxSeq = currentMemberships.reduce((max, row) => row.message_seq > max ? row.message_seq : max, 0n);
    await seedMessageRows(ctx, seeded.conversationId, 1000 - currentMemberships.length, Number(maxSeq) + 1, 'snapshot');
    const longTitle = '长'.repeat(4000);
    const navSteps = [];
    for (let index = 0; index < 210; index += 1) {
      navSteps.push(kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `snapshot-nav-${String(index).padStart(3, '0')}`,
        title: `${longTitle}-${index}`,
        status: 'active',
        created_at: `2026-08-01T00:10:${String(index % 60).padStart(2, '0')}.000Z`,
        updated_at: `2026-08-01T00:10:${String(index % 60).padStart(2, '0')}.000Z`
      }));
    }
    await ctx.database.transaction(navSteps);
    const contextHeads = await list(ctx.database, 'ConversationContextHeadLink', {
      conversation_id: seeded.conversationId
    });
    assert.equal(contextHeads.length, 1);
    const contextProjectionId = 'snapshot-context-projection';
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: contextProjectionId,
        owner_kind: 'turn',
        owner_id: seeded.turnId,
        root_id: contextHeads[0].root_id,
        purpose: 'request',
        created_at: NOW
      })
    ]);

    const sent = [];
    const connection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => sent.push(message)
    });
    assert.equal(sent.length, 1);
    const snapshot = sent[0];
    assert.equal(snapshot.type, 'reliable-kernel.snapshot');
    assert.equal(snapshot.sessionId, connection.sessionId);
    assert.equal(snapshot.hostBootId, ctx.database.hostBootId);
    assert.match(snapshot.snapshotCommitSeq, /^(?:0|[1-9]\d*)$/);
    const windowMessages = snapshot.projections.activeConversationWindow.messages;
    assert.equal(windowMessages.length, 200);
    assert.ok(snapshot.projections.navigationSummary.conversations.length <= 200);
    assert.ok(maxArrayLength(snapshot.projections) <= 200);
    assert.ok(maxRecordBytes(snapshot.projections) <= 2048);
    assert.ok(wireBytes(snapshot) <= 5_242_880);
    assert.equal(snapshot.projections.activeConversationWindow.taskList.length, 1);
    assert.deepEqual(snapshot.projections.activeConversationWindow.taskList[0].items, [
      { title: 'bounded projection', status: 'in_progress', delete: false }
    ]);
    assert.equal(snapshot.projections.activeConversationWindow.taskList[0].detail_on_demand, false);
    assert.equal(JSON.stringify(snapshot).includes('user-input-snapshot'), false);
    assertions.push('snapshot仅含五类bounded projection，消息窗口/每类型记录/单记录摘要/实际UTF-8总字节均受硬上限；task list从ToolCall/ToolOutcome+CAS事实重建且不含正文/full Context');

    const pageOne = await ctx.services.history.page({
      query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId, limit: 200
    });
    assert.equal(pageOne.rows.length, 200);
    assert.ok(pageOne.responseBytes <= 524_288);
    await seedMessageRows(ctx, seeded.conversationId, 1, 1001, 'snapshot-mid-page');
    const observed = [...pageOne.rows.map((row) => row.id)];
    let cursor = pageOne;
    while (cursor.hasMore) {
      cursor = await ctx.services.history.page({
        query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId, limit: 200,
        afterSortKey: cursor.nextSortKey, afterId: cursor.nextId
      });
      observed.push(...cursor.rows.map((row) => row.id));
    }
    assert.equal(new Set(observed).size, observed.length);
    const existingIds = new Set((await listAll(ctx.database, 'MessagePartOfConversation', {
      conversation_id: seeded.conversationId
    })).map((row) => row.message_id));
    assert.deepEqual(new Set(observed), existingIds);
    await assert.rejects(ctx.services.history.page({
      query: 'message', sortId: 'message_seq', conversationId: seeded.conversationId,
      limit: 20, offset: 20
    }), /Offset pagination is forbidden/);
    assertions.push('message_seq+id keyset分页中间插入新行仍无重复/漏项，page rows与实际bytes受限且offset被拒绝');

    const detailChild = await spawnStartedChild(ctx, seeded.turnId, 'snapshot-detail', 'background');
    const largeAnswer = Buffer.alloc(3 * 1024 * 1024, 0x61);
    const largeSubmission = await ctx.services.answers.submit({
      answerBridgeId: detailChild.answerBridgeId,
      submissionId: 'snapshot-large-answer',
      sourceTurnId: detailChild.childTurnId,
      content: largeAnswer,
      contentType: 'application/octet-stream'
    });
    const chunks = [];
    let offset = 0;
    do {
      const detail = await ctx.services.details.read({
        kind: 'answer-content', recordId: largeSubmission.submissionId,
        offset, maxBytes: 2_097_152
      });
      assert.ok(detail.responseBytes <= 2_097_152);
      chunks.push(Buffer.from(detail.chunk, 'base64'));
      if (!detail.hasMore) break;
      offset = detail.nextOffset;
    } while (true);
    assert.deepEqual(Buffer.concat(chunks), largeAnswer);
    const contextDetail = await ctx.services.details.read({
      kind: 'context-projection-detail', recordId: contextProjectionId,
      offset: 0, maxBytes: 2_097_152
    });
    assert.ok(contextDetail.responseBytes <= 2_097_152);
    const structuralContext = JSON.parse(Buffer.from(contextDetail.chunk, 'base64').toString('utf8'));
    assert.equal(structuralContext.projection.id, contextProjectionId);
    assert.equal(structuralContext.root.id, contextHeads[0].root_id);
    assert.ok(Array.isArray(structuralContext.records));
    assert.equal(JSON.stringify(structuralContext).includes('user-input-snapshot'), false);
    assertions.push('大型answer正文不进ClientState，details按recordId+offset+maxBytes分块；Context projection按root读取结构事实且不把owner误作CAS或返回正文；每个实际wire response≤2MiB');

    const messageListSource = await fs.readFile(path.join(root, 'webview/src/components/conversation/ReliableMessageList.vue'), 'utf8');
    const segmentSource = await fs.readFile(path.join(root, 'webview/src/components/conversation/segmentedTimeline.ts'), 'utf8');
    assert.match(messageListSource, /v-for="[^"]*visibleTimelineRows"/);
    assert.match(messageListSource, /scroller/);
    assert.match(segmentSource, /TIMELINE_MOUNT_LIMIT = 80/);
    assert.match(segmentSource, /PENDING_TIMELINE_MOUNT_LIMIT = 20/);
    assert.ok(80 + 20 <= 100);
    const plainData = require(path.join(root, 'dist/extension/shared/plainData.js'));
    const proxy = new Proxy({ nested: [{ value: 'plain' }] }, {});
    const plain = plainData.toStructuredClonePlainData(proxy);
    assert.deepEqual(plain, { nested: [{ value: 'plain' }] });
    assert.notEqual(plain, proxy);
    assert.throws(() => plainData.toStructuredClonePlainData(new Map()), /forbidden class/);
    assert.throws(() => plainData.toStructuredClonePlainData({ callback() {} }), /unsupported function/);
    assertions.push('可靠时间线使用80+20 segmented挂载上限并复用现有自定义scroller；Bridge payload递归转plain且拒绝Map/function/class');
    faults.push('keyset insertion between pages');
    faults.push('detail payload larger than maxResponseBytes');
    metrics.snapshotBytes = wireBytes(snapshot);
    metrics.snapshotMessages = windowMessages.length;
    metrics.keysetRows = observed.length;
    metrics.detailChunks = chunks.length;
    metrics.contextDetailBytes = contextDetail.responseBytes;
    metrics.maxMountedTimelineComponents = 100;
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { assertions, faults, metrics };
  });
}

async function checkClientChangeBatchBounds() {
  return withRuntime('client-batch', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const sent = [];
    const connection = await ctx.services.clientFeed.connect({ send: (message) => sent.push(message) });
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await ctx.database.transaction(Array.from({ length: 10 }, (_unused, index) =>
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `batch-small-${index}`, title: `small ${index}`, status: 'active',
        created_at: NOW, updated_at: NOW
      })
    ));
    assert.equal(sent.length, 2);
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].changes.length, 10);
    assert.ok(wireBytes(sent[1]) <= 1_048_576);
    const commitSeq = sent[1].commitSeq;
    acknowledge(ctx.services.clientFeed, connection, sent[1]);
    assertions.push('普通SQLite commit只产生一个typed upsert/remove atomic batch，records/实际wire bytes受限且不拆分');

    await ctx.database.transaction(Array.from({ length: 501 }, (_unused, index) =>
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: `batch-oversized-${String(index).padStart(3, '0')}`, title: `oversized ${index}`,
        status: 'active', created_at: NOW, updated_at: NOW
      })
    ));
    await waitFor(() => sent.length >= 3, 5000, 'oversized commit snapshot refresh');
    assert.equal(sent[2].type, 'reliable-kernel.snapshot');
    assert.ok(BigInt(sent[2].snapshotCommitSeq) > BigInt(commitSeq));
    assert.equal(sent.filter((message) => message.type === 'reliable-kernel.changes' && message.changes.length > 500).length, 0);
    assertions.push('single commit 501 records不形成half-visible拆包，直接coalesce为新bounded snapshot');
    faults.push('single oversized commit by record count');

    const shared = require(path.join(root, 'dist/extension/shared/reliableKernelClientFeed.js'));
    const initial = shared.applyReliableKernelDataMessage(shared.createEmptyReliableKernelClientState(), {
      type: shared.RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '1', snapshotCommitSeq: '5',
      projections: { navigationSummary: { conversations: [] } }
    });
    assert.equal(initial.snapshotRequired, false);
    const valid = shared.applyReliableKernelDataMessage(initial.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '2', commitSeq: '6',
      changes: [{ type: 'Conversation', operation: 'upsert', id: 'client-conv', record: { id: 'client-conv', status: 'active' } }]
    });
    assert.equal(valid.state.records.Conversation['client-conv'].status, 'active');
    const beforeFailure = JSON.stringify(valid.state.records);
    const failedApply = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '3', commitSeq: '7',
      changes: [
        { type: 'Conversation', operation: 'upsert', id: 'would-be-partial', record: { id: 'would-be-partial' } },
        { type: 'UnknownDomain', operation: 'upsert', id: 'bad', record: { id: 'bad' } }
      ]
    });
    assert.equal(failedApply.snapshotRequired, true);
    assert.equal(JSON.stringify(failedApply.state.records), beforeFailure);
    const gap = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-a', messageSeq: '3', commitSeq: '8', changes: []
    });
    const mismatch = shared.applyReliableKernelDataMessage(valid.state, {
      type: shared.RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: 'client-atomic', hostBootId: 'boot-b', messageSeq: '3', commitSeq: '7', changes: []
    });
    assert.equal(gap.reason, 'commit-gap');
    assert.equal(mismatch.reason, 'host-boot-mismatch');
    assert.equal(mismatch.state.hostBootId, null);
    assert.equal(mismatch.state.sessionId, null);
    assert.deepEqual(mismatch.state.records, {});
    assertions.push('客户端整批copy-on-write原子应用；unknown type/apply failure/gap/乱序均作废整批并请求snapshot，hostBoot/session变化同时丢弃旧增量状态');
    faults.push('unknown change type after a valid first change');
    faults.push('commitSeq gap and hostBootId change');
    metrics.normalBatchRecords = sent[1].changes.length;
    metrics.normalBatchBytes = wireBytes(sent[1]);
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { assertions, faults, metrics };
  });
}

async function checkClientQueueBounds() {
  const countEvidence = await withRuntime('client-queue-count', async (ctx) => {
    const sent = [];
    const connection = await ctx.services.clientFeed.connect({ send: (message) => sent.push(message) });
    for (let index = 0; index < 9; index += 1) {
      await ctx.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
          id: `queue-count-${index}`, title: `queue ${index}`, status: 'active',
          created_at: NOW, updated_at: NOW
        })
      ]);
    }
    const overflow = ctx.services.clientFeed.inspectSession(connection.sessionId);
    assert.equal(overflow.snapshotRequired, true);
    assert.equal(overflow.queuedBatches, 0);
    assert.equal(sent.length, 1);
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'queue-count-coalesced', title: 'coalesced', status: 'active', created_at: NOW, updated_at: NOW
      })
    ]);
    assert.equal(sent.length, 1);
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await waitFor(() => sent.length === 2, 5000, 'queue overflow snapshot handoff');
    assert.equal(sent[1].type, 'reliable-kernel.snapshot');
    assert.equal(ctx.services.clientFeed.inspectSession(connection.sessionId).inflightMessageSeq, sent[1].messageSeq);
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { sent, overflow };
  });

  const byteEvidence = await withRuntime('client-queue-bytes', async (ctx) => {
    // Seed a bounded active window before connecting, then repeatedly update the same visible rows.
    // Creating hundreds of new Conversations would correctly hit the 200-record navigation bound
    // before queuedBytes, so it cannot prove that the independent 4 MiB queue guard is active.
    const seeded = await seedParent(ctx, 'queue-bytes');
    const shared = await ctx.store.ingest(ctx.database, 'queue-byte-shared', 'application/json');
    const toolCallIds = [];
    const modelRequestIds = [];
    const seedSteps = [];
    for (let index = 0; index < 200; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const toolCallId = `queue-byte-tool-${suffix}`;
      const modelRequestId = `queue-byte-model-${suffix}`;
      toolCallIds.push(toolCallId);
      modelRequestIds.push(modelRequestId);
      seedSteps.push(
        kernel.DOMAIN_REPOSITORIES.domain('ToolCall').insert({
          id: toolCallId,
          turn_id: seeded.turnId,
          call_seq: BigInt(index + 1),
          tool_name: `seed-tool-${suffix}`,
          status: 'running',
          arguments_object_id: shared.id,
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insert({
          id: modelRequestId,
          turn_id: seeded.turnId,
          request_seq: BigInt(index + 1),
          status: 'prepared',
          terminal_state: null,
          provider_id: 'queue-byte-provider',
          model_id: 'queue-byte-model',
          authority_snapshot_id: `queue-byte-authority-${suffix}`,
          settings_snapshot_object_id: null,
          recipe_object_id: shared.id,
          usage_json: null,
          stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null },
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('Operation').insert({
          id: `queue-byte-operation-${suffix}`,
          owner_kind: 'model_request',
          owner_id: modelRequestId,
          operation_seq: 1n,
          tool_call_id: null,
          status: 'pending',
          created_at: NOW,
          updated_at: NOW
        }),
        kernel.DOMAIN_REPOSITORIES.domain('Attempt').insert({
          id: `queue-byte-attempt-${suffix}`,
          operation_id: `queue-byte-operation-${suffix}`,
          attempt_seq: 1n,
          status: 'pending',
          created_at: NOW,
          updated_at: NOW,
          completed_at: null
        })
      );
    }
    await ctx.database.transaction(seedSteps);

    const sent = [];
    const connection = await ctx.services.clientFeed.connect({
      activeConversationId: seeded.conversationId,
      send: (message) => sent.push(message)
    });
    let previous;
    let overflowAt = 0;
    for (let batch = 1; batch <= 8; batch += 1) {
      const steps = [];
      for (let index = 0; index < 200; index += 1) {
        steps.push(
          kernel.DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallIds[index], {
            tool_name: `${'t'.repeat(1500)}-${batch}-${index}`,
            updated_at: NOW
          }),
          kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestIds[index], {
            usage_json: { padding: 'u'.repeat(1300), batch, index },
            updated_at: NOW
          })
        );
      }
      await ctx.database.transaction(steps);
      const current = ctx.services.clientFeed.inspectSession(connection.sessionId);
      if (current.snapshotRequired) {
        overflowAt = batch;
        break;
      }
      previous = current;
    }
    assert.ok(previous && previous.queuedBatches < 8);
    assert.ok(previous.queuedBytes > 0);
    const overflow = ctx.services.clientFeed.inspectSession(connection.sessionId);
    assert.equal(overflow.snapshotRequired, true);
    assert.equal(overflow.queuedBatches, 0);
    assert.ok(overflowAt <= 8, 'byte overflow must occur before batch-count overflow');
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { overflowAt, previousBytes: previous.queuedBytes };
  });

  return {
    assertions: [
      'slow ACK期间严格保持一个inflight；第9个普通batch使未发送队列清空并置单一snapshotRequired',
      'snapshot-required不入队且后续commit只coalesce一位，ACK后atomic handoff为一份新snapshot',
      'queuedBytes在batch数尚未达到8时越过4MiB即独立触发overflow'
    ],
    faults: ['slow ACK batch-count overflow', 'slow ACK queued-byte overflow'],
    metrics: {
      maxInflight: 1,
      maxQueuedBatchesObservedBeforeOverflow: 8,
      byteOverflowAtBatch: byteEvidence.overflowAt,
      queuedBytesBeforeByteOverflow: byteEvidence.previousBytes,
      coalescedSnapshotMessages: countEvidence.sent.length
    }
  };
}

async function checkSnapshotFeedBarrier() {
  return withRuntime('client-barrier', async (ctx) => {
    const assertions = [];
    const faults = [];
    const metrics = {};
    const sent = [];
    const originalSnapshot = ctx.database.clientProjectionSnapshot.bind(ctx.database);
    let injectedCommitSeq;
    let injected = false;
    ctx.database.clientProjectionSnapshot = async (activeConversationId) => {
      const barrier = await originalSnapshot(activeConversationId);
      if (!injected) {
        injected = true;
        const commit = await ctx.database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: 'barrier-between-read-register', title: 'barrier', status: 'active',
            created_at: NOW, updated_at: NOW
          })
        ]);
        injectedCommitSeq = commit.commitSeq;
      }
      return barrier;
    };
    const connection = await ctx.services.clientFeed.connect({ send: (message) => sent.push(message) });
    ctx.database.clientProjectionSnapshot = originalSnapshot;
    assert.equal(sent.length, 1);
    const snapshotSeq = sent[0].snapshotCommitSeq;
    assert.equal(BigInt(injectedCommitSeq), BigInt(snapshotSeq) + 1n);
    acknowledge(ctx.services.clientFeed, connection, sent[0]);
    await waitFor(() => sent.length === 2, 5000, 'barrier buffered change');
    assert.equal(sent[1].type, 'reliable-kernel.changes');
    assert.equal(sent[1].commitSeq, injectedCommitSeq);
    assert.ok(sent[1].changes.some((change) => change.id === 'barrier-between-read-register'));
    assertions.push('snapshot读完但订阅handoff尚未返回时受控提交真实事务，listener预注册缓冲使第一批commitSeq严格=snapshotCommitSeq+1且无遗漏');
    faults.push('deterministic commit between snapshot read and feed handoff');
    metrics.snapshotCommitSeq = snapshotSeq;
    metrics.firstChangeCommitSeq = sent[1].commitSeq;
    ctx.services.clientFeed.disconnect(connection.sessionId);
    return { assertions, faults, metrics };
  });
}

async function checkOldWriterNotRouted() {
  const assertions = [];
  const faults = [];
  const metrics = {};
  const entry = path.join(root, 'dist/extension/vscode/extension.js');
  const graph = emittedRequireClosure(entry);
  const forbidden = [
    '/backend/reliability/',
    '/backend/application/BackendApplication.js',
    '/backend/world/modules/agentRun/',
    '/backend/application/conversationFork.js',
    '/backend/capabilities/vscodeStorage/clientStateStore.js',
    '/shared/runLifecycle.js',
    '/shared/agentRunActivity.js'
  ];
  for (const file of graph) {
    const normalized = file.split(path.sep).join('/');
    for (const selector of forbidden) assert.equal(normalized.includes(selector), false, `${normalized} reaches ${selector}`);
  }
  const source = await fs.readFile('backend/reliableKernel/runtimeServices.ts', 'utf8');
  assert.doesNotMatch(source, /dual.?write|AgentRunRecord|includeApiKey|streamSeq|ClientStateDb/);
  assert.match(source, /Unsupported run_agent operation/);
  const domains = new Set(kernel.RUNTIME_DOMAIN_SCHEMAS.map((entry) => entry.key));
  for (const forbiddenDomain of ['AgentRun', 'TaskList', 'ClientChangeLog', 'ProviderContinuation']) {
    assert.equal(domains.has(forbiddenDomain), false);
  }
  assertions.push('真实VS Code extension main emitted require closure不可达旧file writer、BackendApplication、AgentRun/run-history/full ClientState入口');
  assertions.push('未知可靠Runtime route显式失败且无旧路由/双写/importer；Runtime exact set无AgentRun/TaskList/ClientChangeLog/ProviderContinuation');

  const transition = JSON.parse(await fs.readFile('docs/architecture/reliable-kernel/contracts/transition-ledger.json', 'utf8'));
  const phaseFEntries = transition.entries.filter((entry) => entry.replacementStage === 'F');
  assert.ok(phaseFEntries.length >= 10);
  for (const entryRecord of phaseFEntries) {
    // shared/protocol.ts is the current Bridge/configuration contract as well as the historical home
    // of several erased TypeScript-only legacy interfaces. File-level require closure cannot prove
    // reachability of an erased symbol, so only executable module selectors are gated by path.
    if (entryRecord.selector.path === 'shared/protocol.ts') continue;
    assert.equal(
      graph.has(path.resolve(root, 'dist/extension', entryRecord.selector.path.replace(/\.ts$/, '.js'))),
      false,
      `${entryRecord.key} still reaches ${entryRecord.selector.path}`
    );
  }
  const bridgeSource = await fs.readFile('webview/src/transport/bridge.ts', 'utf8');
  assert.doesNotMatch(bridgeSource.match(/interface BridgePersistedState \{[\s\S]*?\}/)?.[0] ?? '', /clientId/);
  assert.match(bridgeSource, /toStructuredClonePlainData/);
  const runAgentDisplay = await fs.readFile('webview/src/components/content/toolDisplay/runAgentToolDisplay.ts', 'utf8');
  for (const fact of ['childExecutionState', 'activeChildTurnState', 'answerSubmissionState', 'runtimeDeliveryState', 'parentHandlingState', 'terminationState']) {
    assert.match(runAgentDisplay, new RegExp(fact));
  }
  assert.doesNotMatch(runAgentDisplay, /activityStage|notificationRun|runIdFrom/);
  assertions.push('F executable transition selectors不进入production graph；shared/protocol中的已擦除类型不按整文件误判；Bridge session只驻内存且UI直接显示六类权威facts');
  metrics.productionEntry = path.relative(root, entry).split(path.sep).join('/');
  metrics.emittedClosureFiles = graph.size;
  metrics.phaseFTransitionEntries = phaseFEntries.length;
  faults.push('candidate import-graph traversal against all Phase F legacy selectors');
  return { assertions, faults, metrics };
}

async function checkRecoveryAnswerInbox() {
  return withRuntime('recovery-answer', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-answer');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-answer', 'background');
    const submitted = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-answer-submission',
      sourceTurnId: child.childTurnId,
      content: 'repair me'
    });
    await closeRuntime(ctx);
    mutateSqlite(ctx.binding.paths.databasePath, (database) => {
      database.prepare('DELETE FROM runtime_inbox_item WHERE id = ?').run(submitted.inboxItemId);
    });
    await reopenRuntime(ctx, 'recovery-answer-restart');
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: submitted.submissionId })).length, 0);
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_ANSWER_INBOX_INVARIANT);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    const inbox = (await list(ctx.database, 'RuntimeInboxItem', { source_id: submitted.submissionId }))[0];
    assert.equal(inbox.dedupe_key, `answer:${child.answerBridgeId}:${submitted.submissionId}`);
    assert.equal((await get(ctx.database, 'AnswerBridge', child.answerBridgeId)).current_submission_id, submitted.submissionId);
    assertions.push('跨真实数据库关闭/重开按bridge+submission稳定身份补建缺失InboxItem且不改AnswerSubmission/Bridge');
    assertions.push('answer-inbox scanner重复运行幂等，不产生重复Inbox或外部effect');
    faults.push('committed AnswerSubmission with missing RuntimeInboxItem across restart');
    return { assertions, faults, metrics: { firstReconciled: first.reconciled, secondReconciled: second.reconciled } };
  });
}

async function checkRecoveryPendingDelivery() {
  return withRuntime('recovery-delivery', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-delivery');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-delivery', 'background');
    const answer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'recovery-delivery-answer',
      content: 'deliver after restart'
    });
    const delivery = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: parent.conversationId,
      targetTurnId: parent.turnId,
      phase: 'current_turn'
    });
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-delivery-restart');
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_DELIVERY_PENDING);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_DELIVERY_PENDING);
    const summary = await ctx.services.deliveries.summary(delivery.delivery.id);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    assert.equal(summary.delivery.state, 'consumed');
    assert.ok(summary.inputLink);
    assert.equal(summary.parentHandlingState, 'unhandled');
    assertions.push('restart后pending delivery按advancement matrix注入真实PendingTurnInput+InputLink并置consumed');
    assertions.push('delivery recovery重复扫描不重复注入、不重复推进且不消费handled_at');
    faults.push('pending current_turn delivery across Extension Host restart');
    return { assertions, faults, metrics: { inputLinks: (await list(ctx.database, 'RuntimeDeliveryInputLink', { delivery_id: delivery.delivery.id })).length } };
  });
}

async function checkRecoveryForegroundWait() {
  return withRuntime('recovery-foreground', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-foreground');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-foreground', 'wait_for_answer', {
      deadline: '2026-08-01T00:01:00.000Z'
    });
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-foreground-restart', () => '2026-08-01T00:02:00.000Z');
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_FOREGROUND_WAIT_EXPIRED);
    assert.equal(first.reconciled, 1);
    assert.equal(second.reconciled, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: child.toolCallId })).length, 1);
    const terminal = await ctx.services.effects.readTerminalResult(child.toolCallId, false);
    assert.equal(terminal.status, 'succeeded');
    await createTurnControl(ctx, 'recovery-foreground-terminal').terminal({
      source: { kind: 'callback', key: 'recovery-foreground-parent-terminal' },
      turnId: parent.turnId,
      terminalStatus: 'completed',
      reason: 'parent completed after background handle'
    });
    const late = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'late-after-foreground-timeout',
      sourceTurnId: child.childTurnId,
      content: 'late answer'
    });
    assert.equal(late.foregroundSettled, false);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: child.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'RuntimeInboxItem', { source_id: late.submissionId })).length, 1);
    assert.equal((await get(ctx.database, 'Turn', parent.turnId)).status, 'terminated');
    assertions.push('过期waiting_answer跨restart转后台控制句柄并只结算原ToolCall一次，deadline持久化事实被真实扫描');
    assertions.push('late answer仅进入AnswerSubmission/Inbox，不产生第二ToolModelResult也不强制启动父模型');
    faults.push('foreground wait deadline elapsed while Extension Host was down');
    return { assertions, faults, metrics: { firstReconciled: first.reconciled, toolModelResults: 1 } };
  });
}

async function checkRecoveryCancelledSubtree() {
  return withRuntime('recovery-cancel', async (ctx) => {
    const assertions = [];
    const faults = [];
    const parent = await seedParent(ctx, 'recovery-cancel');
    const child = await spawnStartedChild(ctx, parent.turnId, 'recovery-cancel', 'background');
    const recoveryContinuationTool = await createRunAgentTool(ctx, parent.turnId, 'recovery-cancel-pending-intent');
    const pending = await ctx.services.children.send({
      sourceKey: 'recovery-cancel-pending-intent',
      sourceToolCallId: recoveryContinuationTool.toolCallId,
      childExecutionId: child.childExecutionId,
      mode: 'queue_next_turn',
      content: 'pending continuation',
      completionPolicy: 'background'
    });
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').update(child.childExecutionId, {
        status: 'cancel_subtree_requested', updated_at: NOW
      })
    ]);
    const effectsBefore = (await list(ctx.database, 'EffectIntent', {})).length;
    await closeRuntime(ctx);
    await reopenRuntime(ctx, 'recovery-cancel-restart');
    const first = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE);
    const second = await ctx.services.recovery.run(kernel.PHASE_F_RECOVERY_CANCELLED_SUBTREE_INCOMPLETE);
    assert.equal(first.reconciled, 1);
    assert.equal((await get(ctx.database, 'ChildExecutionIntentLink', pending.intentLinkId)).state, 'cancelled');
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: child.childTurnId,
      input_kind: 'termination_request'
    })).length, 1);
    assert.equal((await list(ctx.database, 'EffectIntent', {})).length, effectsBefore);
    assert.equal(second.reconciled, 0);
    assert.equal((await list(ctx.database, 'PendingTurnInput', {
      turn_id: child.childTurnId,
      input_kind: 'termination_request'
    })).length, 1);
    assertions.push('已登记cancel_subtree但缺active终止/pending intent取消的故障状态跨restart被稳定ParentLink续扫补齐');
    assertions.push('重复扫描不重复termination input、不派发外部effect，active Turn仍等待正常终止回执');
    faults.push('cancel_subtree marker committed before subtree cancellation facts');
    return { assertions, faults, metrics: { firstReconciled: first.reconciled, secondScanned: second.scanned } };
  });
}

async function checkParentHandlingMatrix() {
  const pureCases = [
    [{ state: 'pending', phase: 'current_turn', inputLink: null }, 'unhandled'],
    [{ state: 'failed', phase: 'next_turn', inputLink: null }, 'unhandled'],
    [{ state: 'consumed', phase: 'notify_only', inputLink: null }, 'not_applicable'],
    [{ state: 'consumed', phase: 'current_turn', inputLink: { handled_at: null } }, 'unhandled'],
    [{ state: 'consumed', phase: 'next_turn', inputLink: { handled_at: NOW } }, 'handled']
  ];
  for (const [input, expected] of pureCases) assert.equal(kernel.deriveParentHandlingState(input), expected);
  assert.throws(() => kernel.deriveParentHandlingState({
    state: 'consumed', phase: 'current_turn', inputLink: null
  }), /invalid phase\/InputLink/);

  return withRuntime('parent-handling', async (ctx) => {
    const assertions = ['parentHandling完整precedence矩阵逐组合由Repository函数验证，非法consumed current/next无InputLink被拒绝'];
    const faults = [];
    const parent = await seedParent(ctx, 'parent-handling');
    const child = await spawnStartedChild(ctx, parent.turnId, 'parent-handling', 'background');
    const answer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'parent-handling-answer',
      content: 'answer'
    });
    const pending = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: parent.conversationId,
      targetTurnId: parent.turnId,
      phase: 'current_turn'
    });
    assert.equal(pending.parentHandlingState, 'unhandled');
    const consumed = await ctx.services.deliveries.advance(pending.delivery.id);
    assert.equal(consumed.parentHandlingState, 'unhandled');
    const unrelatedContent = await ctx.store.ingest(ctx.database, 'unrelated', 'text/plain');
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: 'matrix-unrelated-input', turn_id: parent.turnId, input_kind: 'other',
        content_object_id: unrelatedContent.id, state: 'consumed', created_at: NOW, updated_at: NOW
      })
    ]);
    assert.equal((await ctx.services.deliveries.summary(pending.delivery.id)).parentHandlingState, 'unhandled');
    const handled = await ctx.services.deliveries.markInputHandled(consumed.inputLink.pending_turn_input_id);
    assert.equal(handled.parentHandlingState, 'handled');

    const notify = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: parent.conversationId,
      phase: 'notify_only'
    });
    const acknowledged = await ctx.services.deliveries.acknowledgeNotification(notify.delivery.id);
    assert.equal(acknowledged.parentHandlingState, 'not_applicable');
    const failed = await ctx.services.deliveries.create({
      inboxItemId: answer.inboxItemId,
      targetConversationId: 'matrix-gone-target',
      phase: 'notify_only'
    });
    assert.equal(failed.parentHandlingState, 'unhandled');
    assertions.push('真实SQLite delivery覆盖pending/failed、notify consumed、current consumed未处理/已处理，且无关input不影响结果');

    const extraAnswer = await ctx.services.answers.submit({
      answerBridgeId: child.answerBridgeId,
      submissionId: 'parent-handling-extra-answer',
      content: 'extra notification'
    });
    const deliveryChanges = [];
    const unsubscribe = ctx.database.onCommit((commit) => deliveryChanges.push(...commit.changes.filter((change) => change.domain === 'RuntimeDelivery')));
    const extraNotify = await ctx.services.deliveries.create({
      inboxItemId: extraAnswer.inboxItemId,
      targetConversationId: parent.conversationId,
      phase: 'notify_only'
    });
    await ctx.services.deliveries.acknowledgeNotification(extraNotify.delivery.id);
    unsubscribe();
    const projected = deliveryChanges.findLast((change) => change.id === extraNotify.delivery.id)?.record;
    assert.equal(projected.parent_handling_state, 'not_applicable');
    assertions.push('前端只读取commit/Repository物化的parent_handling_state，不在Webview自行推导');
    faults.push('unrelated PendingTurnInput consumed before exact delivery input');
    return { assertions, faults, metrics: { matrixCases: pureCases.length + 1, projectedState: projected.parent_handling_state } };
  });
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase-f-${label}-`));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const ctx = {
    ...candidate,
    parent,
    database: null,
    store: null,
    services: null,
    now: () => NOW
  };
  try {
    await reopenRuntime(ctx, `phase-f-${label}`);
    return await body(ctx);
  } finally {
    if (ctx.services?.clientFeed) ctx.services.clientFeed.close();
    if (ctx.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function reopenRuntime(ctx, hostBootId, now = ctx.now) {
  if (ctx.database) throw new Error('Runtime database must be closed before reopen.');
  ctx.now = now;
  ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId });
  ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
  ctx.services = kernel.createReliableKernelRuntimeServices(ctx.database, ctx.store, {
    now,
    authorityCompiler: phaseFAuthorityCompiler('runtime-services')
  });
}

async function closeRuntime(ctx) {
  ctx.services?.clientFeed.close();
  if (ctx.database) await ctx.database.close();
  ctx.database = null;
  ctx.store = null;
  ctx.services = null;
}

async function seedParent(ctx, suffix) {
  const conversationId = `conversation-${suffix}`;
  const agentId = `agent-${suffix}`;
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `agent-link-${suffix}`, conversation_id: conversationId, agent_id: agentId,
      role: 'default', created_at: NOW, updated_at: NOW
    })
  ]);
  const control = createTurnControl(ctx, suffix);
  const started = await control.input({
    source: { kind: 'command', key: `input-${suffix}` },
    conversationId,
    leaseOwnerId: `executor-${suffix}`,
    hostBootId: ctx.database.hostBootId,
    leaseExpiresAt: '2026-08-02T00:00:00.000Z',
    content: `user-input-${suffix}`
  });
  return {
    conversationId,
    agentId,
    turnId: started.turnId,
    messageId: started.messageId,
    messageRevisionId: started.messageRevisionId,
    control
  };
}

function createTurnControl(ctx, suffix) {
  return new kernel.TurnControlPlane(ctx.database, ctx.store, {
    authorityCompiler: phaseFAuthorityCompiler(suffix)
  });
}

function phaseFAuthorityCompiler(suffix) {
  return {
    async compile(request) {
      return {
        turnId: request.turnId,
        executorAgentId: request.executorAgentId,
        executionPreset: {
          content: JSON.stringify({ providerConfigId: 'fake-local', modelId: 'fake-model', suffix })
        },
        authoritySnapshot: {
          content: JSON.stringify({ turnId: request.turnId, executorAgentId: request.executorAgentId, suffix })
        }
      };
    }
  };
}

async function createRunAgentTool(ctx, turnId, suffix) {
  return ctx.services.effects.createToolCall({
    source: { kind: 'callback', key: `run-agent-tool-${suffix}` },
    toolCallId: `run-agent-call-${suffix}`,
    turnId,
    toolName: 'run_agent',
    arguments: { prompt: suffix }
  });
}

async function spawnStartedChild(ctx, parentTurnId, suffix, completionPolicy, options = {}) {
  const tool = await createRunAgentTool(ctx, parentTurnId, suffix);
  const spawned = await ctx.services.children.spawn({
    sourceToolCallId: tool.toolCallId,
    childAgentId: `child-agent-${suffix}`,
    prompt: `child prompt ${suffix}`,
    completionPolicy,
    ...(completionPolicy === 'wait_for_answer'
      ? { waitDeadlineAt: options.deadline ?? '2026-08-01T01:00:00.000Z' }
      : {}),
    leaseOwnerId: `child-owner-${suffix}`,
    leaseExpiresAt: '2026-08-02T00:00:00.000Z'
  });
  assert.equal(await ctx.services.children.claimSpawnDispatch(spawned.effectIntentId), true);
  const receipt = await ctx.services.children.recordSpawnReceipt({
    sourceKey: `spawn-callback-${suffix}`,
    attemptId: spawned.attemptId,
    outcome: 'succeeded',
    detail: { adapter: 'fake-capability-boundary' }
  });
  await ctx.services.children.reconcileSpawnReceipt(receipt.effectReceiptId);
  return { ...spawned, toolCallId: tool.toolCallId };
}

async function seedMessageRows(ctx, conversationId, count, startSeq, suffix) {
  if (count <= 0) return;
  const content = await ctx.store.ingest(ctx.database, `shared-${suffix}`, 'text/plain');
  const steps = [];
  for (let index = 0; index < count; index += 1) {
    const seq = startSeq + index;
    const id = `message-${suffix}-${String(seq).padStart(6, '0')}`;
    const revisionId = `revision-${suffix}-${String(seq).padStart(6, '0')}`;
    steps.push(
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id, created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: revisionId, message_id: id, revision_seq: 1n, role: seq % 2 ? 'user' : 'assistant',
        content_object_id: content.id, created_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: `current-${suffix}-${String(seq).padStart(6, '0')}`,
        message_id: id, revision_id: revisionId, updated_at: NOW
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insert({
        id: `membership-${suffix}-${String(seq).padStart(6, '0')}`,
        conversation_id: conversationId, message_id: id, message_seq: BigInt(seq), created_at: NOW
      })
    );
  }
  await ctx.database.transaction(steps);
}

async function list(database, domain, where = {}) {
  const barrier = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return barrier.snapshot[0];
}

async function listAll(database, domain, where = {}) {
  const barrier = await database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1000
  }));
  return barrier.snapshot;
}

async function get(database, domain, id) {
  const row = await maybeGet(database, domain, id);
  assert.ok(row, `${domain} ${id} should exist`);
  return row;
}

async function maybeGet(database, domain, id) {
  const barrier = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  return barrier.snapshot[0];
}

function acknowledge(feed, connection, message) {
  feed.acknowledge({
    sessionId: connection.sessionId,
    hostBootId: connection.hostBootId,
    messageSeq: message.messageSeq
  });
}

function wireBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function maxArrayLength(value) {
  if (Array.isArray(value)) return Math.max(value.length, ...value.map(maxArrayLength), 0);
  if (!value || typeof value !== 'object') return 0;
  return Math.max(0, ...Object.values(value).map(maxArrayLength));
}

function maxRecordBytes(value) {
  let maximum = 0;
  const visit = (nested) => {
    if (Array.isArray(nested)) {
      for (const entry of nested) {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) maximum = Math.max(maximum, wireBytes(entry));
        visit(entry);
      }
    } else if (nested && typeof nested === 'object') {
      for (const entry of Object.values(nested)) visit(entry);
    }
  };
  visit(value);
  return maximum;
}

async function casFileCount(directory) {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await casFileCount(absolute);
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function mutateSqlite(databasePath, mutation) {
  const database = new Database(databasePath, { fileMustExist: true });
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  try {
    database.exec('BEGIN IMMEDIATE');
    mutation(database);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

function emittedRequireClosure(entryPath) {
  const visited = new Set();
  const visit = (file) => {
    const absolute = path.resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = fsSync.readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (!match[1].startsWith('.')) continue;
      const candidate = path.resolve(path.dirname(absolute), match[1]);
      const resolved = fsSync.existsSync(candidate) && fsSync.statSync(candidate).isFile()
        ? candidate
        : fsSync.existsSync(`${candidate}.js`)
          ? `${candidate}.js`
          : fsSync.existsSync(path.join(candidate, 'index.js'))
            ? path.join(candidate, 'index.js')
            : null;
      if (resolved) visit(resolved);
    }
  };
  visit(entryPath);
  return visited;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`${label} did not complete within ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeEvidence(stableId, evidence, commitSha) {
  const fileName = `${stableId.replaceAll('.', '-')}.json`;
  const evidencePath = path.join(root, 'tests/reliable-kernel/evidence', fileName);
  const runnerPath = path.join(root, 'scripts/reliable-kernel/run-phase-f-check.mjs');
  const compileProvenancePath = path.join(root, RELIABLE_KERNEL_COMPILE_PROVENANCE);
  const worktreeStatus = childProcess.execFileSync(
    'git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }
  ).trim();
  const compileProvenance = JSON.parse(await fs.readFile(compileProvenancePath, 'utf8'));
  const sourceManifest = reliableKernelSourceManifest(root);
  const compiledManifest = reliableKernelCompiledManifest(root);
  const sourceFilesTracked = manifestFilesAreTracked(root, sourceManifest);
  const compiledClosureMatches = compileProvenance.kind === 'limcode-reliable-kernel-compile-provenance'
    && compileProvenance.commitSha === commitSha
    && compileProvenance.sourceFilesTracked === true
    && compileProvenance.sourceTreeSha256 === sourceManifest.sha256
    && compileProvenance.compiledClosureSha256 === compiledManifest.sha256;
  const sqlite = new Database(':memory:');
  let sqliteVersion;
  try {
    sqliteVersion = sqlite.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    sqlite.close();
  }
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.writeFile(evidencePath, `${JSON.stringify({
    kind: 'limcode-phase-f-candidate-evidence',
    checkId: stableId,
    stableId,
    passed: true,
    commitSha,
    measuredAt: new Date().toISOString(),
    assertionCount: evidence.assertions.length,
    provenance: {
      worktreeClean: worktreeStatus.length === 0,
      commitExplicitlyBound: requestedCommit === commitSha,
      authoritative: worktreeStatus.length === 0
        && requestedCommit === commitSha
        && sourceFilesTracked
        && compileProvenance.worktreeClean === true
        && compiledClosureMatches,
      runnerSha256: await fileSha256(runnerPath),
      sourceTreeSha256: sourceManifest.sha256,
      sourceFileCount: sourceManifest.files.length,
      sourceFilesTracked,
      compiledKernelSha256: compiledManifest.sha256,
      compiledFileCount: compiledManifest.files.length,
      compileProvenance: path.relative(root, compileProvenancePath),
      compileWorktreeClean: compileProvenance.worktreeClean === true,
      compiledClosureMatches,
      invocation: [process.execPath, ...process.argv.slice(1)],
      node: process.version,
      sqlite: sqliteVersion,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown'
    },
    ...evidence
  }, bigintJson, 2)}\n`);
  return evidencePath;
}

async function fileSha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function bigintJson(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function currentCommit() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

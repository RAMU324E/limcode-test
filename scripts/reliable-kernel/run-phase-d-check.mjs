import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const root = process.cwd();
const checkId = option('check');
const phaseDChecks = new Set([
  'candidate.tool-model-result-exactly-once',
  'candidate.file-proposal-result-separated',
  'candidate.effect-receipt-reconcile',
  'candidate.attachment-cas-ingest',
  'candidate.mcp-effect-recovery',
  'candidate.process-wrapper-recovery',
  'candidate.process-watchdog',
  'candidate.process-output-bounds',
  'candidate.recovery.effect-intent-hanging',
  'candidate.recovery.file-change-unresolved'
]);
if (!checkId || !phaseDChecks.has(checkId)) {
  console.error(`用法：node scripts/reliable-kernel/run-phase-d-check.mjs --check=<Phase-D-stable-id> [--commit=<sha>]`);
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
try {
  kernel = require(path.join(root, 'dist/extension/backend/reliableKernel/index.js'));
} catch (error) {
  console.error(`无法加载已编译Phase D内核；请先运行npm run compile：${error.message}`);
  process.exit(1);
}

const handlers = new Map([
  ['candidate.tool-model-result-exactly-once', checkToolModelResultExactlyOnce],
  ['candidate.file-proposal-result-separated', checkFileProposalResultSeparated],
  ['candidate.effect-receipt-reconcile', checkEffectReceiptReconcile],
  ['candidate.attachment-cas-ingest', checkAttachmentCasIngest],
  ['candidate.mcp-effect-recovery', checkMcpEffectRecovery],
  ['candidate.process-wrapper-recovery', checkProcessWrapperRecovery],
  ['candidate.process-watchdog', checkProcessWatchdog],
  ['candidate.process-output-bounds', checkProcessOutputBounds],
  ['candidate.recovery.effect-intent-hanging', checkHangingEffectRecovery],
  ['candidate.recovery.file-change-unresolved', checkUnresolvedFileRecovery]
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

async function checkToolModelResultExactlyOnce() {
  return withRuntime('tool-result', async (ctx) => {
    const assertions = [];
    const diagnostics = [];
    const effects = new kernel.EffectControlPlane(ctx.database, ctx.store, {
      onDiagnostic: (entry) => diagnostics.push(entry)
    });
    const tool = await createTool(ctx, effects, 'tool-one', 'effect-tool');
    const commits = [];
    const unsubscribe = ctx.database.onCommit((commit) => commits.push(commit));
    const prepared = await effects.prepareEffectIntent({
      source: source('internal', 'tool-one:prepare'),
      toolCallId: tool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'echo', arguments: {}, riskLevel: 'command' }
    });
    unsubscribe();
    const prepareCommit = commits.find((entry) => entry.commitSeq === prepared.commitSeq);
    assert.ok(prepareCommit);
    for (const domain of ['Operation', 'Attempt', 'EffectIntent']) {
      assert.ok(prepareCommit.changes.some((entry) => entry.domain === domain && entry.kind === 'upsert'));
    }
    assertions.push('Operation、Attempt、EffectIntent在一个真实SQLite commit建立');

    let externalCalls = 0;
    await assert.rejects(
      async () => {
        const dispatcher = new kernel.McpEffectDispatcher(ctx.database, effects, {
          async toolAnnotations() { return {}; },
          async callTool() { externalCalls += 1; return 'unexpected'; }
        }, allowMcpPolicy());
        await dispatcher.executeDispatched(prepared.effectIntentId);
      },
      /committed dispatched/
    );
    assert.equal(externalCalls, 0);
    assert.equal(await effects.claimEffectDispatch(prepared.effectIntentId), true);
    assert.equal((await get(ctx.database, 'EffectIntent', prepared.effectIntentId)).dispatch_state, 'dispatched');
    const dispatcher = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations() { return {}; },
      async callTool() { externalCalls += 1; return { echo: true }; }
    }, allowMcpPolicy());
    const observed = await dispatcher.executeDispatched(prepared.effectIntentId);
    assert.equal(externalCalls, 1);
    assertions.push('EffectIntent未提交/未标dispatched时外部调用为0，dispatch状态commit后才调用');

    const receipt = await effects.recordEffectReceipt({
      source: source('callback', 'tool-one:receipt'),
      attemptId: prepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: observed.outcome,
      detail: observed
    });
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId })).length, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: tool.toolCallId })).length, 0);
    assertions.push('EffectReceipt独立提交后尚无ToolOutcome/ToolModelResult');

    const results = await Promise.all([
      effects.completeOperation({
        source: source('internal', 'tool-one:reconcile-a'),
        effectReceiptId: receipt.effectReceiptId,
        outcome: 'succeeded'
      }),
      effects.completeOperation({
        source: source('recovery', 'tool-one:reconcile-b'),
        effectReceiptId: receipt.effectReceiptId,
        outcome: 'succeeded'
      })
    ]);
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: tool.toolCallId })).length, 1);
    const terminalIds = new Set(results.filter(Boolean).map((entry) => entry.toolModelResultId));
    assert.equal(terminalIds.size, 1);
    assertions.push('并发internal/recovery reconcile只形成一个ToolOutcome和一个稳定ToolModelResult');

    const beforeDuplicate = BigInt((await ctx.database.inspect()).currentCommitSeq);
    const duplicateReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'tool-one:receipt'),
      attemptId: prepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: observed.outcome,
      detail: observed
    });
    assert.equal(duplicateReceipt.effectReceiptId, receipt.effectReceiptId);
    assert.equal(BigInt((await ctx.database.inspect()).currentCommitSeq), beforeDuplicate);
    assert.ok(diagnostics.some((entry) => entry.kind === 'effect-receipt-deduplicated'
      && entry.attemptId === prepared.attemptId));
    assertions.push('重复callback source key重放首次EffectReceipt稳定ID、不增加commit并记录dedupe诊断');

    const receiptRaceTool = await createTool(ctx, effects, 'tool-receipt-race', 'effect-tool');
    const receiptRacePrepared = await effects.prepareEffectIntent({
      source: source('internal', 'tool-receipt-race:prepare'),
      toolCallId: receiptRaceTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'race', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(receiptRacePrepared.effectIntentId);
    const originalSnapshot = ctx.database.snapshot.bind(ctx.database);
    let receiptRaceArrivals = 0;
    let releaseReceiptRace;
    const receiptRaceGate = new Promise((resolve) => { releaseReceiptRace = resolve; });
    ctx.database.snapshot = async (reads) => {
      const value = await originalSnapshot(reads);
      const target = reads.some((read) => read.kind === 'list'
        && read.domain === 'EffectReceipt'
        && read.where?.attempt_id === receiptRacePrepared.attemptId);
      if (target && receiptRaceArrivals < 2) {
        receiptRaceArrivals += 1;
        if (receiptRaceArrivals === 2) releaseReceiptRace();
        else await receiptRaceGate;
      }
      return value;
    };
    let racedReceipts;
    try {
      racedReceipts = await Promise.all([
        effects.recordEffectReceipt({
          source: source('callback', 'tool-receipt-race:a'),
          attemptId: receiptRacePrepared.attemptId,
          effectKind: 'mcp_tool_call',
          outcome: 'succeeded'
        }),
        effects.recordEffectReceipt({
          source: source('recovery', 'tool-receipt-race:b'),
          attemptId: receiptRacePrepared.attemptId,
          effectKind: 'mcp_tool_call',
          outcome: 'outcome_unknown'
        })
      ]);
    } finally {
      ctx.database.snapshot = originalSnapshot;
    }
    assert.equal(new Set(racedReceipts.map((entry) => entry.effectReceiptId)).size, 1);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: receiptRacePrepared.attemptId })).length, 1);
    const persistedRaceReceipt = await get(ctx.database, 'EffectReceipt', racedReceipts[0].effectReceiptId);
    await effects.completeOperation({
      source: source('internal', 'tool-receipt-race:reconcile'),
      effectReceiptId: persistedRaceReceipt.id,
      outcome: persistedRaceReceipt.outcome
    });
    assertions.push('不同source并发写同一Attempt回执时，输家精确去重并稳定重放首次EffectReceipt而不抛UNIQUE');

    await assert.rejects(
      effects.createToolCall({
        source: source('command', 'forbidden-tool-create'),
        toolCallId: 'forbidden-tool',
        turnId: ctx.turnId,
        toolName: 'forbidden',
        arguments: {}
      }),
      /source kind must be one of: callback, internal/
    );
    await assert.rejects(
      effects.recordEffectReceipt({
        source: source('command', 'forbidden-receipt'),
        attemptId: prepared.attemptId,
        effectKind: 'mcp_tool_call',
        outcome: 'succeeded'
      }),
      /source kind must be one of: callback, recovery/
    );
    assertions.push('command/callback/internal/recovery按具体操作allowlist，不能互相冒充');

    const lateTool = await createTool(ctx, effects, 'tool-late', 'late-tool');
    const latePrepared = await effects.prepareEffectIntent({
      source: source('internal', 'tool-late:prepare'),
      toolCallId: lateTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'late', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(latePrepared.effectIntentId);
    const now = new Date().toISOString();
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').update(latePrepared.attemptId, {
        status: 'cancelled', updated_at: now, completed_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Operation').update(latePrepared.operationId, {
        status: 'cancelled', updated_at: now
      })
    ]);
    const cancelled = await effects.settleWithoutEffect({
      source: source('internal', 'tool-late:cancel'),
      toolCallId: lateTool.toolCallId,
      status: 'cancelled',
      detail: { reason: 'cancelled before callback' }
    });
    const lateReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'tool-late:late-receipt'),
      attemptId: latePrepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded',
      detail: { late: true }
    });
    assert.equal(lateReceipt.lateAfterTerminal, true);
    assert.equal((await get(ctx.database, 'ToolOutcome', cancelled.toolOutcomeId)).status, 'cancelled');
    assert.equal((await get(ctx.database, 'Attempt', latePrepared.attemptId)).status, 'cancelled');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: lateTool.toolCallId })).length, 1);
    assert.equal((await get(ctx.database, 'Turn', ctx.turnId)).status, 'active');
    assertions.push('terminal后late receipt保留证据但不改Outcome/Attempt、不新增ModelResult、不复活Turn');

    const constraintTool = await createTool(ctx, effects, 'tool-constraint', 'constraint-tool');
    const constraintPrepared = await effects.prepareEffectIntent({
      source: source('internal', 'tool-constraint:prepare'),
      toolCallId: constraintTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'constraint', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(constraintPrepared.effectIntentId);
    const constraintReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'tool-constraint:receipt'),
      attemptId: constraintPrepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded'
    });
    const badSource = source('internal', 'tool-constraint:reconcile');
    await assert.rejects(effects.completeOperation({
      source: badSource,
      effectReceiptId: constraintReceipt.effectReceiptId,
      outcome: 'succeeded',
      additionalSteps: [kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: ctx.conversationId,
        title: 'duplicate',
        status: 'active',
        created_at: now,
        updated_at: now
      })]
    }), /UNIQUE|constraint/i);
    assert.equal((await list(ctx.database, 'CommandReceipt', {
      source_kind: badSource.kind, source_key: badSource.key
    })).length, 0);
    await effects.completeOperation({
      source: badSource,
      effectReceiptId: constraintReceipt.effectReceiptId,
      outcome: 'succeeded'
    });
    assertions.push('非预期UNIQUE向外传播且整事务回滚；只处理合同列明的去重冲突');

    const crashTool = await createTool(ctx, effects, 'reconcile-finalize-crash', 'effect-tool');
    const crashPrepared = await effects.prepareEffectIntent({
      source: source('internal', 'reconcile-finalize-crash:prepare'),
      toolCallId: crashTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'crash', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(crashPrepared.effectIntentId);
    const crashReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'reconcile-finalize-crash:receipt'),
      attemptId: crashPrepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded'
    });
    const crashSource = source('internal', 'reconcile-finalize-crash:reconcile');
    const originalFinalize = effects.finalizeReadyInOrder.bind(effects);
    effects.finalizeReadyInOrder = async () => { throw new Error('fault-after-operation-commit'); };
    try {
      await assert.rejects(effects.completeOperation({
        source: crashSource,
        effectReceiptId: crashReceipt.effectReceiptId,
        outcome: 'succeeded'
      }), /fault-after-operation-commit/);
    } finally {
      effects.finalizeReadyInOrder = originalFinalize;
    }
    assert.equal((await get(ctx.database, 'Operation', crashPrepared.operationId)).status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashTool.toolCallId })).length, 0);
    const crashFiles = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    const crashProcesses = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );
    const crashMcp = new kernel.McpEffectDispatcher(
      ctx.database,
      effects,
      { async toolAnnotations() { return {}; }, async callTool() { throw new Error('terminal Operation recovery must not redispatch'); } },
      allowMcpPolicy()
    );
    const crashScanner = new kernel.PhaseDRecoveryScanner(
      ctx.database,
      effects,
      crashFiles,
      crashProcesses,
      crashMcp,
      () => undefined,
      recoveryTurns(ctx, crashFiles)
    );
    await crashScanner.reconcileCommittedFacts();
    const crashRecovered = await effects.readTerminalResult(crashTool.toolCallId, true);
    assert.equal(crashRecovered.status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashTool.toolCallId })).length, 1);
    assertions.push('Operation终态commit后、Tool finalizer前崩溃时，现有D恢复入口自动补齐唯一Outcome/ModelResult且不重派发');

    const interactions = new kernel.ToolInteractionControlPlane(ctx.database, ctx.store, effects);
    const askTool = await createTool(ctx, effects, 'ask-user', 'ask_user');
    const pause = await interactions.pauseForAskUser({
      source: source('internal', 'ask-user:pause'),
      toolCallId: askTool.toolCallId,
      prompt: { question: '选择一个结果', options: ['a', 'b'] }
    });
    assert.equal((await get(ctx.database, 'Operation', pause.operationId)).status, 'waiting_answer');
    assert.equal((await get(ctx.database, 'OutcomePause', pause.pauseId)).status, 'waiting');
    assert.equal((await list(ctx.database, 'InteractionRequest', { id: pause.requestId })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: askTool.toolCallId })).length, 0);
    const answers = [
      { source: source('command', 'ask-user:answer-a'), response: { selected: 'a' } },
      { source: source('command', 'ask-user:answer-b'), response: { selected: 'b' } }
    ];
    const answerResults = await Promise.all(answers.map((entry) => interactions.resolveAskUser({
      source: entry.source,
      requestId: pause.requestId,
      response: entry.response
    })));
    assert.equal(answerResults.filter((entry) => entry.won).length, 1);
    assert.equal((await list(ctx.database, 'InteractionResponse', { request_id: pause.requestId })).length, 1);
    assert.equal((await list(ctx.database, 'OperationResolution', { pause_id: pause.pauseId })).length, 1);
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: askTool.toolCallId })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: askTool.toolCallId })).length, 1);
    assert.equal(new Set(answerResults.map((entry) => entry.terminal?.toolModelResultId)).size, 1);
    const winnerIndex = answerResults.findIndex((entry) => entry.won);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    const winnerReplay = await interactions.resolveAskUser({
      source: answers[winnerIndex].source,
      requestId: pause.requestId,
      response: answers[winnerIndex].response
    });
    const loserReplay = await interactions.resolveAskUser({
      source: answers[loserIndex].source,
      requestId: pause.requestId,
      response: answers[loserIndex].response
    });
    assert.equal(winnerReplay.deduplicated, true);
    assert.equal(winnerReplay.won, true);
    assert.equal(loserReplay.deduplicated, true);
    assert.equal(loserReplay.won, false);
    assert.equal(winnerReplay.terminal.toolModelResultId, answerResults[winnerIndex].terminal.toolModelResultId);
    assert.equal(loserReplay.terminal.toolModelResultId, answerResults[winnerIndex].terminal.toolModelResultId);
    assertions.push('ask_user复用Operation/OutcomePause/Interaction/Resolution，等待态不是模型结果；winner/loser重放均保持first-response语义和唯一结果');

    const orderedBlocker = await createTool(ctx, effects, 'ask-order-blocker', 'internal');
    const orderedAsk = await createTool(ctx, effects, 'ask-order-later', 'ask_user');
    const orderedPause = await interactions.pauseForAskUser({
      source: source('internal', 'ask-order:pause'),
      toolCallId: orderedAsk.toolCallId,
      prompt: { question: 'persist first response' }
    });
    const orderedResponse = await interactions.resolveAskUser({
      source: source('command', 'ask-order:answer'),
      requestId: orderedPause.requestId,
      response: { selected: 'persisted' }
    });
    assert.equal(orderedResponse.won, true);
    assert.equal(orderedResponse.terminal, undefined);
    assert.equal((await list(ctx.database, 'InteractionResponse', { request_id: orderedPause.requestId })).length, 1);
    await effects.settleWithoutEffect({
      source: source('internal', 'ask-order:blocker-terminal'),
      toolCallId: orderedBlocker.toolCallId,
      status: 'succeeded',
      detail: { completed: true }
    });
    const orderedTerminal = await effects.readTerminalResult(orderedAsk.toolCallId, true);
    assert.equal(orderedTerminal.status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: orderedAsk.toolCallId })).length, 1);
    assertions.push('later call_seq的ask_user第一回答立即持久化；仅模型结果等待前序工具结束后按序唯一收口');

    const crashAskTool = await createTool(ctx, effects, 'ask-finalizer-crash', 'ask_user');
    const crashAskPause = await interactions.pauseForAskUser({
      source: source('internal', 'ask-finalizer-crash:pause'),
      toolCallId: crashAskTool.toolCallId,
      prompt: { question: 'persist before finalizer crash' }
    });
    const originalOrderedFinalize = effects.finalizeReadyInOrder.bind(effects);
    effects.finalizeReadyInOrder = async () => { throw new Error('fault-after-ask-response-commit'); };
    try {
      await assert.rejects(interactions.resolveAskUser({
        source: source('command', 'ask-finalizer-crash:answer'),
        requestId: crashAskPause.requestId,
        response: { selected: 'durable' }
      }), /fault-after-ask-response-commit/);
    } finally {
      effects.finalizeReadyInOrder = originalOrderedFinalize;
    }
    assert.equal((await list(ctx.database, 'InteractionResponse', { request_id: crashAskPause.requestId })).length, 1);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashAskTool.toolCallId })).length, 0);
    const crashAskReplay = await interactions.resolveAskUser({
      source: source('command', 'ask-finalizer-crash:answer'),
      requestId: crashAskPause.requestId,
      response: { selected: 'durable' }
    });
    assert.equal(crashAskReplay.deduplicated, true);
    assert.equal(crashAskReplay.terminal.status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashAskTool.toolCallId })).length, 1);
    assertions.push('ask_user响应commit后、ordered finalizer前崩溃时，同source重放只续做SQLite finalizer并补齐唯一模型结果');

    const taskTool = await createTool(ctx, effects, 'task-list', 'update_task_list');
    const taskResult = await interactions.settleTaskList({
      source: source('internal', 'task-list:settle'),
      toolCallId: taskTool.toolCallId,
      operation: { mode: 'rewrite', items: [{ title: 'Phase D', status: 'in_progress', delete: false }] }
    });
    const taskOutcome = await get(ctx.database, 'ToolOutcome', taskResult.toolOutcomeId);
    const taskContent = await get(ctx.database, 'ContentObject', taskOutcome.content_object_id);
    const taskDetail = JSON.parse((await ctx.store.read(taskContent)).toString('utf8'));
    assert.deepEqual(taskDetail, {
      detail: {
        kind: 'task-list',
        operation: {
          items: [{ status: 'in_progress', title: 'Phase D' }],
          kind: 'task_list.operation',
          mode: 'rewrite'
        }
      },
      status: 'succeeded',
      toolCallId: taskTool.toolCallId
    });
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: taskTool.toolCallId })).length, 1);
    const taskReplay = await interactions.settleTaskList({
      source: source('internal', 'task-list:settle'),
      toolCallId: taskTool.toolCallId,
      operation: { mode: 'rewrite', items: [{ title: 'Phase D', status: 'in_progress', delete: false }] }
    });
    assert.equal(taskReplay.receiptId, taskResult.receiptId);
    assert.ok(await get(ctx.database, 'CommandReceipt', taskReplay.receiptId));
    assertions.push('update_task_list只写结构化Tool结果事实；重放返回真实存在的CommandReceipt而不发明ID');

    const taskBlocker = await createTool(ctx, effects, 'task-order-blocker', 'internal');
    const laterTask = await createTool(ctx, effects, 'task-order-later', 'update_task_list');
    const deferredTask = await interactions.settleTaskList({
      source: source('internal', 'task-order-later:settle'),
      toolCallId: laterTask.toolCallId,
      operation: { mode: 'update', items: [{ title: 'Durable later result', status: 'completed', delete: false }] }
    });
    assert.equal(deferredTask.terminal, undefined);
    const deferredOperations = await list(ctx.database, 'Operation', { tool_call_id: laterTask.toolCallId });
    assert.equal(deferredOperations.length, 1);
    assert.equal(deferredOperations[0].status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolResultArtifact', { tool_call_id: laterTask.toolCallId })).length, 1);
    await effects.settleWithoutEffect({
      source: source('internal', 'task-order-blocker:settle'),
      toolCallId: taskBlocker.toolCallId,
      status: 'succeeded',
      detail: { done: true }
    });
    assert.equal((await effects.readTerminalResult(laterTask.toolCallId, true)).status, 'succeeded');
    assertions.push('later call_seq内部工具先持久化Operation/Artifact，前序完成后再按序生成唯一模型结果');

    const raceNoEffectTool = await createTool(ctx, effects, 'no-effect-race', 'internal');
    const racedNoEffect = await Promise.all([
      effects.settleWithoutEffect({
        source: source('internal', 'no-effect-race:a'),
        toolCallId: raceNoEffectTool.toolCallId,
        status: 'succeeded',
        detail: { winner: 'a' }
      }),
      effects.settleWithoutEffect({
        source: source('internal', 'no-effect-race:b'),
        toolCallId: raceNoEffectTool.toolCallId,
        status: 'succeeded',
        detail: { winner: 'b' }
      })
    ]);
    assert.equal(new Set(racedNoEffect.map((entry) => entry.toolModelResultId)).size, 1);
    for (const entry of racedNoEffect) assert.ok(await get(ctx.database, 'CommandReceipt', entry.receiptId));
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: raceNoEffectTool.toolCallId })).length, 1);
    assertions.push('不同source并发无effect收口精确first-wins；输家写真实receipt并稳定重放唯一结果');

    const monotonicTool = await createTool(ctx, effects, 'tool-monotonic', 'mcp');
    const monotonicEffect = await effects.prepareEffectIntent({
      source: source('internal', 'tool-monotonic:prepare'),
      toolCallId: monotonicTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'monotonic', arguments: {}, riskLevel: 'command' }
    });
    await assert.rejects(effects.settleWithoutEffect({
      source: source('internal', 'tool-monotonic:invalid-settle'),
      toolCallId: monotonicTool.toolCallId,
      status: 'cancelled',
      detail: { invalid: true }
    }), /non-terminal Operation/);
    assert.equal(await effects.claimEffectDispatch(monotonicEffect.effectIntentId), true);
    const monotonicReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'tool-monotonic:receipt'),
      attemptId: monotonicEffect.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded'
    });
    await effects.completeOperation({
      source: source('internal', 'tool-monotonic:reconcile'),
      effectReceiptId: monotonicReceipt.effectReceiptId,
      outcome: 'succeeded'
    });
    await assert.rejects(effects.prepareEffectIntent({
      source: source('internal', 'tool-monotonic:resurrect'),
      toolCallId: monotonicTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'resurrect', arguments: {}, riskLevel: 'command' }
    }), /cannot create an EffectIntent/);
    assert.equal(await effects.claimEffectDispatch(monotonicEffect.effectIntentId), false);
    assertions.push('Tool/Operation终态单调；no-effect不能旁路已有effect，terminal后不能prepare或重新claim外调');

    const individualTools = [];
    for (let index = 0; index < 8; index += 1) {
      individualTools.push(await createTool(ctx, effects, `readonly-individual-${index}`, 'read'));
    }
    const individualSettlements = individualTools.map((tool, index) => ({
      source: source('internal', `readonly-individual-${index}:settle`),
      toolCallId: tool.toolCallId,
      status: 'succeeded',
      detail: { path: `${index}.txt`, content: `content-${index}` }
    }));
    const originalBatchTransaction = ctx.database.transaction.bind(ctx.database);
    const originalBatchSnapshot = ctx.database.snapshot.bind(ctx.database);
    let individualTransactions = 0;
    let individualSnapshots = 0;
    ctx.database.transaction = async (steps) => {
      individualTransactions += 1;
      return originalBatchTransaction(steps);
    };
    ctx.database.snapshot = async (reads) => {
      individualSnapshots += 1;
      return originalBatchSnapshot(reads);
    };
    const individualStartedAt = performance.now();
    try {
      await Promise.all(individualSettlements.map((settlement) =>
        effects.settleWithoutEffect(settlement, { finalize: false })
      ));
      await effects.finalizeReadyInOrder(ctx.turnId);
    } finally {
      ctx.database.transaction = originalBatchTransaction;
      ctx.database.snapshot = originalBatchSnapshot;
    }
    const individualElapsedMs = performance.now() - individualStartedAt;
    assert.equal(individualTransactions, 9, 'eight individual settlements plus one batch finalizer require nine transactions');

    const batchTools = [];
    for (let index = 0; index < 8; index += 1) {
      batchTools.push(await createTool(ctx, effects, `readonly-batch-${index}`, 'read'));
    }
    const batchSettlements = batchTools.map((tool, index) => ({
      source: source('internal', `readonly-batch-${index}:settle`),
      toolCallId: tool.toolCallId,
      status: 'succeeded',
      detail: { path: `${index}.txt`, content: `content-${index}` }
    }));
    const originalBatchSnapshotAll = ctx.database.snapshot.bind(ctx.database);
    let settlementTransactions = 0;
    let batchSnapshots = 0;
    ctx.database.transaction = async (steps) => {
      settlementTransactions += 1;
      return originalBatchTransaction(steps);
    };
    ctx.database.snapshot = async (reads) => {
      batchSnapshots += 1;
      return originalBatchSnapshotAll(reads);
    };
    let batchResults;
    const batchStartedAt = performance.now();
    try {
      batchResults = await effects.settleWithoutEffectBatch({
        turnId: ctx.turnId,
        settlements: batchSettlements
      });
    } finally {
      ctx.database.transaction = originalBatchTransaction;
      ctx.database.snapshot = originalBatchSnapshotAll;
    }
    assert.equal(settlementTransactions, 1, 'fresh readonly batch must settle in one SQLite transaction');
    assert.equal(batchResults.length, 8);
    assert.ok(batchResults.every((entry) => entry.terminal === undefined));
    assert.equal((await list(ctx.database, 'Operation', {})).filter((row) =>
      batchTools.some((tool) => tool.toolCallId === row.tool_call_id)
    ).length, 8);
    let finalizerTransactions = 0;
    ctx.database.transaction = async (steps) => {
      finalizerTransactions += 1;
      return originalBatchTransaction(steps);
    };
    ctx.database.snapshot = async (reads) => {
      batchSnapshots += 1;
      return originalBatchSnapshotAll(reads);
    };
    try {
      await effects.finalizeReadyInOrder(ctx.turnId);
    } finally {
      ctx.database.transaction = originalBatchTransaction;
      ctx.database.snapshot = originalBatchSnapshotAll;
    }
    assert.equal(finalizerTransactions, 1, 'fresh readonly batch must finalize in one SQLite transaction');
    const batchElapsedMs = performance.now() - batchStartedAt;
    assert.equal((await list(ctx.database, 'ToolModelResult', {})).filter((row) =>
      batchTools.some((tool) => tool.toolCallId === row.tool_call_id)
    ).length, 8);
    const replayedBatch = await effects.settleWithoutEffectBatch({
      turnId: ctx.turnId,
      settlements: batchSettlements
    });
    assert.ok(replayedBatch.every((entry) => entry.deduplicated));
    assertions.push(
      `8个readonly结果从9个事务降为2个事务，snapshot调用${individualSnapshots}->${batchSnapshots}，`
      + `本机控制面耗时${individualElapsedMs.toFixed(1)}ms->${batchElapsedMs.toFixed(1)}ms；按call_seq生成唯一结果且整批重放不重复写入`
    );

    await attachWorkEnvironmentAuthority(ctx, ctx.turnId, 'readonly-dispatch-authority', true);
    const dispatchDefinition = phaseDRuntimeDefinition('read');
    let hostDefinitionReads = 0;
    let activeReadonly = 0;
    let maxActiveReadonly = 0;
    const reliableTools = new kernel.ReliableToolDispatcher({
      database: ctx.database,
      contentStore: ctx.store,
      effects,
      files: {},
      fileMutations: {},
      processes: {},
      mcp: {},
      interactions: {},
      host: {
        definitions() {
          hostDefinitionReads += 1;
          return [dispatchDefinition];
        },
        async executeNoEffect(_definition, input) {
          activeReadonly += 1;
          maxActiveReadonly = Math.max(maxActiveReadonly, activeReadonly);
          await delay(20);
          activeReadonly -= 1;
          return { ok: true, output: { path: input.arguments.path, content: `body:${input.arguments.path}` } };
        }
      }
    });
    const dispatchedTools = [];
    for (let index = 0; index < 8; index += 1) {
      dispatchedTools.push(await createTool(ctx, effects, `readonly-dispatch-${index}`, 'read'));
    }
    let dispatchTransactions = 0;
    let dispatchSnapshots = 0;
    ctx.database.transaction = async (steps) => {
      dispatchTransactions += 1;
      return originalBatchTransaction(steps);
    };
    ctx.database.snapshot = async (reads) => {
      dispatchSnapshots += 1;
      return originalBatchSnapshot(reads);
    };
    let dispatched;
    const dispatchStartedAt = performance.now();
    try {
      dispatched = await reliableTools.dispatchBatch(dispatchedTools.map((tool, index) => ({
        turnId: ctx.turnId,
        modelRequestId: 'readonly-dispatch-model',
        toolCallId: tool.toolCallId,
        toolName: 'read',
        arguments: { path: `${index}.txt` }
      })));
    } finally {
      ctx.database.transaction = originalBatchTransaction;
      ctx.database.snapshot = originalBatchSnapshot;
      await reliableTools.dispose();
    }
    const dispatchElapsedMs = performance.now() - dispatchStartedAt;
    assert.equal(maxActiveReadonly, 8);
    assert.equal(hostDefinitionReads, 1);
    assert.equal(dispatchTransactions, 2);
    assert.ok(dispatched.every((entry) => entry.toolModelResultId));

    const attachmentTools = [];
    for (let index = 0; index < 4; index += 1) {
      attachmentTools.push(await createTool(ctx, effects, `attachment-dispatch-${index}`, 'read'));
    }
    let activeAttachments = 0;
    let maxActiveAttachments = 0;
    let completedAttachments = 0;
    const settledAttachmentCounts = [];
    const originalAttachmentSettlement = effects.settleWithoutEffect.bind(effects);
    effects.settleWithoutEffect = async (...args) => {
      settledAttachmentCounts.push(completedAttachments);
      return originalAttachmentSettlement(...args);
    };
    const attachmentDispatcher = new kernel.ReliableToolDispatcher({
      database: ctx.database,
      contentStore: ctx.store,
      effects,
      files: {},
      fileMutations: {},
      processes: {},
      mcp: {},
      interactions: {},
      host: {
        definitions() { return [dispatchDefinition]; },
        async executeNoEffect(_definition, input) {
          activeAttachments += 1;
          maxActiveAttachments = Math.max(maxActiveAttachments, activeAttachments);
          await delay(20);
          activeAttachments -= 1;
          completedAttachments += 1;
          return { ok: true, output: { mimeType: 'image/png', sizeBytes: 1, path: input.arguments.path } };
        }
      }
    });
    try {
      const attachmentResults = await attachmentDispatcher.dispatchBatch(attachmentTools.map((tool, index) => ({
        turnId: ctx.turnId,
        modelRequestId: 'attachment-dispatch-model',
        toolCallId: tool.toolCallId,
        toolName: 'read',
        arguments: { path: `${index}.png`, mode: 'attachment' }
      })));
      assert.ok(attachmentResults.every((entry) => entry.toolModelResultId));
    } finally {
      effects.settleWithoutEffect = originalAttachmentSettlement;
      await attachmentDispatcher.dispose();
    }
    assert.equal(maxActiveAttachments, 2, 'attachment reads must use their dedicated two-slot lane');
    assert.deepEqual(settledAttachmentCounts, [1, 2, 3, 4], 'each attachment must settle before the next slot refill completes');
    assertions.push(
      `ReliableToolDispatcher保持普通文本read 8路并发/2事务，并将attachment read限制为${maxActiveAttachments}路且逐个结算；`
      + `text snapshot=${dispatchSnapshots}，含20ms I/O总耗时${dispatchElapsedMs.toFixed(1)}ms`
    );

    const invalidTaskTool = await createTool(ctx, effects, 'invalid-task-list', 'update_task_list');
    await assert.rejects(interactions.settleTaskList({
      source: source('internal', 'invalid-task-list:settle'),
      toolCallId: invalidTaskTool.toolCallId,
      operation: { mode: 'rewrite', items: [{ title: 'bad', status: 'done', delete: false }] }
    }), /status is invalid/);
    assert.throws(() => kernel.normalizePlainJson(new Date(), 'test date'), /plain objects/);
    assert.throws(() => kernel.normalizePlainJson({ value: undefined }, 'test undefined'), /JSON-compatible/);
    assertions.push('task list严格校验字段/status；Date与undefined不再静默变成空对象或被删除');

    return {
      assertions,
      faults: [
        'intent未提交禁止外调',
        'receipt-before-reconcile',
        'competing reconcile',
        'duplicate callback replay',
        'competing receipt source replay',
        'late receipt after terminal',
        'unexpected UNIQUE propagation',
        'automatic recovery after operation completion before tool finalization',
        'batched readonly settlement and replay',
        'real dispatcher shared preflight and concurrent readonly execution',
        'ask_user competing responses and loser replay',
        'ask_user response before ordered model result',
        'ask_user response commit before finalizer crash',
        'ordered no-effect completion',
        'competing no-effect settlement',
        'terminal state resurrection',
        'strict plain JSON and task-list validation'
      ]
    };
  });
}

async function checkFileProposalResultSeparated() {
  return withRuntime('file', async (ctx) => {
    const assertions = [];
    const workspace = path.join(ctx.parent, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    const boundary = (id) => id === 'workspace' ? { id, rootPath: workspace } : undefined;
    const effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);

    const mainTool = await createTool(ctx, effects, 'file-main', 'write');
    const targetPath = path.join(workspace, 'main.txt');
    await fs.writeFile(targetPath, 'base');
    const proposal = await files.propose({
      source: source('internal', 'file-main:proposal'),
      toolCallId: mainTool.toolCallId,
      members: [{
        operation: 'replace_file',
        workEnvironmentId: 'workspace',
        targetPath: 'main.txt',
        baseDigest: sha256('base'),
        baseContent: 'base',
        targetContent: 'target'
      }]
    });
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'base');
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: mainTool.toolCallId })).length, 0);
    assert.equal((await list(ctx.database, 'EffectIntent', {})).length, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: mainTool.toolCallId })).length, 0);
    assert.equal((await list(ctx.database, 'FileChangeSet', { tool_call_id: mainTool.toolCallId })).length, 1);
    assertions.push('FileChangeSet/CAS proposal已提交但审批前Workspace未改、无Operation/Intent/ModelResult');

    const approved = await files.decide({
      source: source('command', 'file-main:approve'),
      changeSetId: proposal.changeSetId,
      decision: 'approved'
    });
    assert.ok(approved.preparedEffect);
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'base');
    const dispatcher = new kernel.FileMutationDispatcher(ctx.database, ctx.store, effects, boundary);
    const applied = await dispatcher.dispatchRecordAndReconcile(approved.preparedEffect.effectIntentId);
    assert.equal(applied.observation.outcome, 'succeeded');
    assert.equal(await fs.readFile(targetPath, 'utf8'), 'target');
    assert.equal(applied.terminal.status, 'succeeded');
    assert.equal((await list(ctx.database, 'FileMutationReceipt', { change_set_id: proposal.changeSetId })).length, 1);
    assertions.push('批准后才建Effect并按base/target/actual摘要真实修改，Receipt后生成唯一模型结果');

    const nestedWriteTool = await createTool(ctx, effects, 'file-nested-parent-create', 'write');
    const planner = new kernel.LocalFileToolPlanner((inputPath) =>
      kernel.resolvePathInsideBoundary('workspace', workspace, inputPath)
    );
    const nestedMembers = await planner.plan(
      phaseDRuntimeDefinition('write'),
      {
        turnId: ctx.turnId,
        modelRequestId: 'model-file-nested-parent-create',
        toolCallId: nestedWriteTool.toolCallId,
        toolName: 'write',
        arguments: { path: 'nested/level/source.txt', content: 'nested-parent-body' }
      },
      { snapshotId: 'authority-file-nested-parent-create', document: {} }
    );
    assert.deepEqual(nestedMembers.map((member) => [member.operation, member.targetPath]), [
      ['create_directory', 'nested'],
      ['create_directory', 'nested/level'],
      ['create_file', 'nested/level/source.txt']
    ]);
    const nestedProposal = await files.propose({
      source: source('internal', 'file-nested-parent-create:proposal'),
      toolCallId: nestedWriteTool.toolCallId,
      members: nestedMembers
    });
    const nestedApproved = await files.decide({
      source: source('command', 'file-nested-parent-create:approve'),
      changeSetId: nestedProposal.changeSetId,
      decision: 'approved'
    });
    const nestedRequest = await effects.readEffectRequest(nestedApproved.preparedEffect.effectIntentId);
    await dispatcher.inspect(nestedRequest);
    assert.equal(await exists(path.join(workspace, 'nested')), false, 'recovery inspect must remain read-only');
    const nestedApplied = await dispatcher.dispatchRecordAndReconcile(
      nestedApproved.preparedEffect.effectIntentId
    );
    assert.equal(nestedApplied.observation.outcome, 'succeeded');
    assert.equal(nestedApplied.terminal.status, 'succeeded');
    assert.equal(await fs.readFile(path.join(workspace, 'nested/level/source.txt'), 'utf8'), 'nested-parent-body');
    const nestedDomainReceipt = (await list(ctx.database, 'FileMutationReceipt', {
      change_set_id: nestedProposal.changeSetId
    }))[0];
    const nestedReceiptMembers = await list(ctx.database, 'FileMutationReceiptMember', {
      receipt_id: nestedDomainReceipt.id
    });
    assert.equal(nestedReceiptMembers.length, 3);
    assert.ok(nestedReceiptMembers.every((member) => member.outcome === 'succeeded'));
    assertions.push('write缺失多层父目录时先提案显式create_directory成员；inspect不建目录，批准后逐级边界校验并由Receipt覆盖目录与文件');

    const outsideWriteRoot = path.join(ctx.parent, 'outside-write-parent');
    await fs.mkdir(outsideWriteRoot);
    await fs.symlink(outsideWriteRoot, path.join(workspace, 'linked-parent'), 'dir');
    await assert.rejects(planner.plan(
      phaseDRuntimeDefinition('write'),
      {
        turnId: ctx.turnId,
        modelRequestId: 'model-file-linked-parent',
        toolCallId: 'tool-call-file-linked-parent',
        toolName: 'write',
        arguments: { path: 'linked-parent/escape.txt', content: 'must-not-escape' }
      },
      { snapshotId: 'authority-file-linked-parent', document: {} }
    ), /Symbolic-link write parents are not allowed/);
    assert.equal(await exists(path.join(outsideWriteRoot, 'escape.txt')), false);
    assertions.push('缺失父目录规划逐级lstat，符号链接父级在提案前拒绝且不向边界外写入');

    const rejectTool = await createTool(ctx, effects, 'file-reject', 'write');
    const rejectProposal = await files.propose({
      source: source('internal', 'file-reject:proposal'),
      toolCallId: rejectTool.toolCallId,
      members: [{
        operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'rejected.txt', targetContent: 'no'
      }]
    });
    const rejected = await files.decide({
      source: source('command', 'file-reject:decision'),
      changeSetId: rejectProposal.changeSetId,
      decision: 'rejected'
    });
    assert.equal(rejected.terminal.status, 'rejected');
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: rejectTool.toolCallId })).length, 0);
    assert.equal(await exists(path.join(workspace, 'rejected.txt')), false);
    const rejectedLoser = await files.decide({
      source: source('command', 'file-reject:late-opposite'),
      changeSetId: rejectProposal.changeSetId,
      decision: 'approved'
    });
    const rejectedLoserReplay = await files.decide({
      source: source('command', 'file-reject:late-opposite'),
      changeSetId: rejectProposal.changeSetId,
      decision: 'approved'
    });
    assert.equal(rejectedLoser.won, false);
    assert.equal(rejectedLoserReplay.won, false);
    assert.equal(rejectedLoserReplay.deduplicated, true);
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: rejectTool.toolCallId })).length, 0);
    assertions.push('rejected旁路直接收口Outcome/ModelResult且无Effect；后到相反审批及其重放稳定保持loser');

    const orderedBlocker = await createTool(ctx, effects, 'file-order-blocker', 'internal');
    const orderedFile = await createTool(ctx, effects, 'file-order-later', 'write');
    const orderedProposal = await files.propose({
      source: source('internal', 'file-order:proposal'),
      toolCallId: orderedFile.toolCallId,
      members: [{
        operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'ordered-rejected.txt', targetContent: 'no'
      }]
    });
    const orderedRejected = await files.decide({
      source: source('command', 'file-order:reject'),
      changeSetId: orderedProposal.changeSetId,
      decision: 'rejected'
    });
    assert.equal(orderedRejected.won, true);
    assert.equal(orderedRejected.terminal, undefined);
    assert.equal((await list(ctx.database, 'FileChangeDecision', { change_set_id: orderedProposal.changeSetId }))[0].decision, 'rejected');
    await effects.settleWithoutEffect({
      source: source('internal', 'file-order:blocker-terminal'),
      toolCallId: orderedBlocker.toolCallId,
      status: 'succeeded',
      detail: { completed: true }
    });
    assert.equal((await effects.readTerminalResult(orderedFile.toolCallId, true)).status, 'rejected');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: orderedFile.toolCallId })).length, 1);
    assertions.push('later call_seq的文件拒绝先持久化first-response，模型结果只等待前序工具结束后按序收口');

    const crashDecisionTool = await createTool(ctx, effects, 'file-decision-finalizer-crash', 'write');
    const crashDecisionProposal = await files.propose({
      source: source('internal', 'file-decision-finalizer-crash:proposal'),
      toolCallId: crashDecisionTool.toolCallId,
      members: [{ operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'decision-crash' }]
    });
    const originalFileFinalize = effects.finalizeReadyInOrder.bind(effects);
    effects.finalizeReadyInOrder = async () => { throw new Error('fault-after-file-decision-commit'); };
    try {
      await assert.rejects(files.decide({
        source: source('command', 'file-decision-finalizer-crash:reject'),
        changeSetId: crashDecisionProposal.changeSetId,
        decision: 'rejected'
      }), /fault-after-file-decision-commit/);
    } finally {
      effects.finalizeReadyInOrder = originalFileFinalize;
    }
    assert.equal((await list(ctx.database, 'FileChangeDecision', {
      change_set_id: crashDecisionProposal.changeSetId
    }))[0].decision, 'rejected');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashDecisionTool.toolCallId })).length, 0);
    const crashDecisionReplay = await files.decide({
      source: source('command', 'file-decision-finalizer-crash:reject'),
      changeSetId: crashDecisionProposal.changeSetId,
      decision: 'rejected'
    });
    assert.equal(crashDecisionReplay.deduplicated, true);
    assert.equal(crashDecisionReplay.terminal.status, 'rejected');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: crashDecisionTool.toolCallId })).length, 1);
    assertions.push('文件Decision commit后、ordered finalizer前崩溃时，同source重放补齐唯一模型结果且不创建Effect');

    const raceTool = await createTool(ctx, effects, 'file-race', 'write');
    const raceProposal = await files.propose({
      source: source('internal', 'file-race:proposal'),
      toolCallId: raceTool.toolCallId,
      members: [{
        operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'race.txt', targetContent: 'race'
      }]
    });
    const race = await Promise.all([
      files.decide({ source: source('command', 'file-race:a'), changeSetId: raceProposal.changeSetId, decision: 'approved' }),
      files.decide({ source: source('command', 'file-race:b'), changeSetId: raceProposal.changeSetId, decision: 'rejected' })
    ]);
    const winner = (await list(ctx.database, 'FileChangeDecision', { change_set_id: raceProposal.changeSetId }))[0];
    assert.equal((await list(ctx.database, 'FileChangeDecision', { change_set_id: raceProposal.changeSetId })).length, 1);
    assert.equal(race.filter((entry) => entry.won).length, 1);
    if (winner.decision === 'approved') {
      assert.equal((await list(ctx.database, 'EffectIntent', {
        effect_kind: 'file_mutation'
      })).filter((entry) => entry.id === race.find((entry) => entry.won).preparedEffect.effectIntentId).length, 1);
    } else {
      assert.equal((await list(ctx.database, 'Operation', { tool_call_id: raceTool.toolCallId })).length, 0);
    }
    assertions.push('并发审批first-response-wins，失败响应只记录自身稳定receipt且不改写赢家');

    // If approval won, finish it so later call_seq results may converge.
    if (winner.decision === 'approved') {
      const winnerResult = race.find((entry) => entry.won);
      await dispatcher.dispatchRecordAndReconcile(winnerResult.preparedEffect.effectIntentId);
    }

    const partialTool = await createTool(ctx, effects, 'file-partial', 'write');
    await fs.writeFile(path.join(workspace, 'conflict.txt'), 'actual');
    const partialProposal = await files.propose({
      source: source('internal', 'file-partial:proposal'),
      toolCallId: partialTool.toolCallId,
      members: [
        { operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'first.txt', targetContent: 'first' },
        { operation: 'replace_file', workEnvironmentId: 'workspace', targetPath: 'conflict.txt', baseDigest: sha256('expected'), baseContent: 'expected', targetContent: 'second' },
        { operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'never.txt', targetContent: 'never' }
      ]
    });
    const partialApproved = await files.decide({
      source: source('command', 'file-partial:approve'),
      changeSetId: partialProposal.changeSetId,
      decision: 'approved'
    });
    const partial = await dispatcher.dispatchRecordAndReconcile(partialApproved.preparedEffect.effectIntentId);
    assert.equal(partial.observation.outcome, 'partial');
    assert.equal(partial.observation.members.length, 2);
    assert.equal(await fs.readFile(path.join(workspace, 'first.txt'), 'utf8'), 'first');
    assert.equal(await fs.readFile(path.join(workspace, 'conflict.txt'), 'utf8'), 'actual');
    assert.equal(await exists(path.join(workspace, 'never.txt')), false);
    assert.equal(partial.terminal.status, 'partial');
    assertions.push('memberSeq顺序执行，首个冲突停止后续；前序成功不回滚并形成真实partial');

    const existingTargetTool = await createTool(ctx, effects, 'file-existing-target', 'write');
    const existingTargetProposal = await files.propose({
      source: source('internal', 'file-existing-target:proposal'),
      toolCallId: existingTargetTool.toolCallId,
      members: [{
        operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'already-same.txt', targetContent: 'same'
      }]
    });
    const existingTargetApproved = await files.decide({
      source: source('command', 'file-existing-target:approve'),
      changeSetId: existingTargetProposal.changeSetId,
      decision: 'approved'
    });
    await fs.writeFile(path.join(workspace, 'already-same.txt'), 'same');
    const existingTarget = await dispatcher.dispatchRecordAndReconcile(
      existingTargetApproved.preparedEffect.effectIntentId
    );
    assert.equal(existingTarget.observation.outcome, 'conflict');
    assert.equal(existingTarget.terminal.status, 'conflict');

    const unavailableBoundaryTool = await createTool(ctx, effects, 'file-boundary-unavailable', 'write');
    const unavailableBoundaryProposal = await files.propose({
      source: source('internal', 'file-boundary-unavailable:proposal'),
      toolCallId: unavailableBoundaryTool.toolCallId,
      members: [{ operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'unavailable' }]
    });
    const unavailableBoundaryApproved = await files.decide({
      source: source('command', 'file-boundary-unavailable:approve'),
      changeSetId: unavailableBoundaryProposal.changeSetId,
      decision: 'approved'
    });
    const unavailableDispatcher = new kernel.FileMutationDispatcher(
      ctx.database,
      ctx.store,
      effects,
      async () => { throw new Error('work-environment authority temporarily unavailable'); }
    );
    const unavailableBoundary = await unavailableDispatcher.dispatchRecordAndReconcile(
      unavailableBoundaryApproved.preparedEffect.effectIntentId
    );
    assert.equal(unavailableBoundary.observation.outcome, 'outcome_unknown');
    assert.equal(unavailableBoundary.terminal.status, 'outcome_unknown');
    assertions.push('首次create要求目标不存在；authority/I-O不可用归为outcome_unknown而非伪装成路径conflict');

    const unappliedPath = path.join(workspace, 'unapplied.txt');
    await fs.writeFile(unappliedPath, 'still-base');
    const unappliedTool = await createTool(ctx, effects, 'file-unapplied', 'write');
    const unappliedProposal = await files.propose({
      source: source('internal', 'file-unapplied:proposal'),
      toolCallId: unappliedTool.toolCallId,
      members: [{
        operation: 'replace_file',
        workEnvironmentId: 'workspace',
        targetPath: 'unapplied.txt',
        baseDigest: sha256('still-base'),
        baseContent: 'still-base',
        targetContent: 'never-applied'
      }]
    });
    const unappliedApproved = await files.decide({
      source: source('command', 'file-unapplied:approve'),
      changeSetId: unappliedProposal.changeSetId,
      decision: 'approved'
    });
    await effects.claimEffectDispatch(unappliedApproved.preparedEffect.effectIntentId);
    const unapplied = await files.recoverDispatchedEffect({
      source: source('recovery', 'file-unapplied:recover'),
      effectIntentId: unappliedApproved.preparedEffect.effectIntentId,
      resolver: boundary
    });
    assert.equal(unapplied.status, 'failed');
    assert.equal(await fs.readFile(unappliedPath, 'utf8'), 'still-base');

    const unknownTool = await createTool(ctx, effects, 'file-unknown', 'write');
    const unknownProposal = await files.propose({
      source: source('internal', 'file-unknown:proposal'),
      toolCallId: unknownTool.toolCallId,
      members: [{
        operation: 'create_file',
        workEnvironmentId: 'workspace',
        targetPath: 'x'.repeat(5000),
        targetContent: 'unreadable-target'
      }]
    });
    const unknownApproved = await files.decide({
      source: source('command', 'file-unknown:approve'),
      changeSetId: unknownProposal.changeSetId,
      decision: 'approved'
    });
    await effects.claimEffectDispatch(unknownApproved.preparedEffect.effectIntentId);
    const unknown = await files.recoverDispatchedEffect({
      source: source('recovery', 'file-unknown:recover'),
      effectIntentId: unknownApproved.preparedEffect.effectIntentId,
      resolver: boundary
    });
    assert.equal(unknown.status, 'outcome_unknown');
    assertions.push('base/target/actual四分支真实覆盖：target成功、base未应用失败、二者皆非冲突、无法读取为outcome_unknown');

    const treePath = path.join(workspace, 'partial-tree');
    await fs.mkdir(path.join(treePath, 'removed'), { recursive: true });
    await fs.mkdir(path.join(treePath, 'retained'), { recursive: true });
    const treeTool = await createTool(ctx, effects, 'file-tree-partial', 'delete');
    const treeProposal = await files.propose({
      source: source('internal', 'file-tree-partial:proposal'),
      toolCallId: treeTool.toolCallId,
      members: [{
        operation: 'delete_directory_tree',
        workEnvironmentId: 'workspace',
        targetPath: 'partial-tree',
        baseDigest: 'directory'
      }]
    });
    const treeApproved = await files.decide({
      source: source('command', 'file-tree-partial:approve'),
      changeSetId: treeProposal.changeSetId,
      decision: 'approved'
    });
    const fsPromises = require('node:fs/promises');
    const originalRm = fsPromises.rm;
    fsPromises.rm = async (target, options) => {
      if (path.resolve(target) !== path.resolve(treePath)) return originalRm(target, options);
      await originalRm(path.join(target, 'removed'), options);
      throw new Error('injected-recursive-delete-after-partial-change');
    };
    let treeResult;
    try {
      treeResult = await dispatcher.dispatchRecordAndReconcile(treeApproved.preparedEffect.effectIntentId);
    } finally {
      fsPromises.rm = originalRm;
    }
    assert.equal(treeResult.observation.outcome, 'outcome_unknown');
    assert.equal(treeResult.terminal.status, 'outcome_unknown');
    assert.equal(await exists(path.join(treePath, 'removed')), false);
    assert.equal(await exists(path.join(treePath, 'retained')), true);
    assertions.push('递归删除发生真实部分变化后抛错时不伪装未应用，按无法证明收口outcome_unknown');

    const recoveryTreePath = path.join(workspace, 'recovery-partial-tree');
    await fs.mkdir(recoveryTreePath, { recursive: true });
    await fs.writeFile(path.join(recoveryTreePath, 'removed.txt'), 'removed');
    await fs.writeFile(path.join(recoveryTreePath, 'retained.txt'), 'retained');
    const recoveryTreeTool = await createTool(ctx, effects, 'file-tree-recovery-partial', 'delete');
    const recoveryTreeProposal = await files.propose({
      source: source('internal', 'file-tree-recovery-partial:proposal'),
      toolCallId: recoveryTreeTool.toolCallId,
      members: [{
        operation: 'delete_directory_tree',
        workEnvironmentId: 'workspace',
        targetPath: 'recovery-partial-tree',
        baseDigest: 'directory'
      }]
    });
    const recoveryTreeApproved = await files.decide({
      source: source('command', 'file-tree-recovery-partial:approve'),
      changeSetId: recoveryTreeProposal.changeSetId,
      decision: 'approved'
    });
    await effects.claimEffectDispatch(recoveryTreeApproved.preparedEffect.effectIntentId);
    await fs.unlink(path.join(recoveryTreePath, 'removed.txt'));
    const recoveredTree = await files.recoverDispatchedEffect({
      source: source('recovery', 'file-tree-recovery-partial:recover'),
      effectIntentId: recoveryTreeApproved.preparedEffect.effectIntentId,
      resolver: boundary
    });
    assert.equal(recoveredTree.status, 'outcome_unknown');
    assert.equal(await exists(path.join(recoveryTreePath, 'removed.txt')), false);
    assert.equal(await exists(path.join(recoveryTreePath, 'retained.txt')), true);
    assertions.push('递归目录部分删除后宿主崩溃，重启摘要无法证明完整base时收口outcome_unknown而非failed');

    const escapeTool = await createTool(ctx, effects, 'file-escape', 'write');
    const escapeProposal = await files.propose({
      source: source('internal', 'file-escape:proposal'),
      toolCallId: escapeTool.toolCallId,
      members: [{ operation: 'create_file', workEnvironmentId: 'workspace', targetPath: '../escape.txt', targetContent: 'escape' }]
    });
    const escapeApproved = await files.decide({
      source: source('command', 'file-escape:approve'),
      changeSetId: escapeProposal.changeSetId,
      decision: 'approved'
    });
    const escaped = await dispatcher.dispatchRecordAndReconcile(escapeApproved.preparedEffect.effectIntentId);
    assert.equal(escaped.observation.outcome, 'conflict');
    assert.equal(await exists(path.join(ctx.parent, 'escape.txt')), false);
    assertions.push('目标路径越出注册WorkEnvironment时明确conflict，不扩展为沙箱或权限系统');

    const unknownDetailTool = await createTool(ctx, effects, 'file-missing-member-detail', 'write');
    const unknownDetailProposal = await files.propose({
      source: source('internal', 'file-missing-member-detail:proposal'),
      toolCallId: unknownDetailTool.toolCallId,
      members: [
        { operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'unknown-member-a' },
        { operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'unknown-member-b' }
      ]
    });
    const unknownDetailApproved = await files.decide({
      source: source('command', 'file-missing-member-detail:approve'),
      changeSetId: unknownDetailProposal.changeSetId,
      decision: 'approved'
    });
    await effects.claimEffectDispatch(unknownDetailApproved.preparedEffect.effectIntentId);
    const unknownDetailReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'file-missing-member-detail:receipt'),
      attemptId: unknownDetailApproved.preparedEffect.attemptId,
      effectKind: 'file_mutation',
      outcome: 'outcome_unknown'
    });
    const unknownDetailTerminal = await files.reconcileEffectReceipt(unknownDetailReceipt.effectReceiptId);
    const unknownDomainReceipt = (await list(ctx.database, 'FileMutationReceipt', {
      effect_receipt_id: unknownDetailReceipt.effectReceiptId
    }))[0];
    const unknownMembers = await list(ctx.database, 'FileMutationReceiptMember', { receipt_id: unknownDomainReceipt.id });
    assert.equal(unknownDetailTerminal.status, 'outcome_unknown');
    assert.equal(unknownMembers.length, 2);
    assert.ok(unknownMembers.every((member) => member.outcome === 'outcome_unknown' && member.actual_digest === null));
    assertions.push('file EffectReceipt缺少detail时按已批准成员逐条写outcome_unknown，不留下空成员审计洞');

    const manyTool = await createTool(ctx, effects, 'file-many-members', 'write');
    const manyProposal = await files.propose({
      source: source('internal', 'file-many-members:proposal'),
      toolCallId: manyTool.toolCallId,
      members: Array.from({ length: 1001 }, (_, index) => ({
        operation: 'create_directory',
        workEnvironmentId: 'workspace',
        targetPath: `many-${String(index + 1).padStart(4, '0')}`
      }))
    });
    const manyApproved = await files.decide({
      source: source('command', 'file-many-members:approve'),
      changeSetId: manyProposal.changeSetId,
      decision: 'approved'
    });
    const manyRequest = await effects.readEffectRequest(manyApproved.preparedEffect.effectIntentId);
    assert.equal(manyRequest.members.length, 1001);
    assert.equal(manyRequest.members[1000].memberSeq, '1001');
    const originalManySnapshotAll = ctx.database.snapshotAll.bind(ctx.database);
    let manySnapshotCalls = 0;
    ctx.database.snapshotAll = async (read) => {
      if (read.domain === 'FileChangeSetMember') manySnapshotCalls += 1;
      return originalManySnapshotAll(read);
    };
    let manyRows;
    try {
      manyRows = await kernel.listAllDomainRows(ctx.database, 'FileChangeSetMember', {
        change_set_id: manyProposal.changeSetId
      });
    } finally {
      ctx.database.snapshotAll = originalManySnapshotAll;
    }
    assert.equal(manyRows.length, 1001);
    assert.equal(manySnapshotCalls, 1);
    assertions.push('1001个FileChangeSetMember通过CAS引用完整进入EffectIntent；分页由worker内单一SQLite snapshot读取，不跨页换快照');

    return {
      assertions,
      faults: [
        'approval-before-mutation',
        'write missing parent directories',
        'write parent symlink escape',
        'rejected-no-effect',
        'first-response-wins',
        'first response before ordered model result',
        'file decision commit before finalizer crash',
        'baseDigest-conflict',
        'create target already exists',
        'boundary authority unavailable',
        'actual-equals-base-unapplied',
        'actual-unreadable-outcome-unknown',
        'recursive-delete-partial-unknown',
        'recursive-delete crash recovery unknown',
        'partial-stop-no-rollback',
        'first-response loser replay',
        'missing file receipt member detail',
        '1001 file members',
        'workspace-boundary'
      ]
    };
  });
}

async function checkEffectReceiptReconcile() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-receipt-'));
  let ctx;
  try {
    ctx = await createRuntime(parent, 'receipt-before-reopen');
    const assertions = [];
    let effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const tool = await createTool(ctx, effects, 'receipt-tool', 'external');
    const prepared = await effects.prepareEffectIntent({
      source: source('internal', 'receipt:prepare'),
      toolCallId: tool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'echo', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(prepared.effectIntentId);
    const receipt = await effects.recordEffectReceipt({
      source: source('callback', 'receipt:callback'),
      attemptId: prepared.attemptId,
      effectKind: 'mcp_tool_call',
      outcome: 'succeeded',
      detail: { result: 'committed before restart' }
    });
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId })).length, 0);
    await ctx.database.close();
    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'phase-d-receipt-reopen' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    const processes = new kernel.ProcessControlPlane(ctx.database, ctx.store, effects, ctx.authority, ctx.binding);
    const mcp = new kernel.McpEffectDispatcher(
      ctx.database,
      effects,
      { async toolAnnotations() { return {}; }, async callTool() { throw new Error('receipt_written recovery must not redispatch MCP'); } },
      allowMcpPolicy()
    );
    const scanner = new kernel.PhaseDRecoveryScanner(
      ctx.database,
      effects,
      files,
      processes,
      mcp,
      () => undefined,
      recoveryTurns(ctx, files)
    );
    const resumed = await scanner.reconcileCommittedFacts();
    const terminal = await effects.readTerminalResult(tool.toolCallId, true);
    assert.equal(resumed.receipts, 1);
    assert.equal(terminal.status, 'succeeded');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: tool.toolCallId })).length, 1);
    assertions.push('Receipt提交后崩溃/重开数据库，现有D恢复入口自动发现receipt_written并续收口，不依赖内存回调或外部重派发');

    const replay = await effects.completeOperation({
      source: source('recovery', 'receipt:reconcile-after-reopen'),
      effectReceiptId: receipt.effectReceiptId,
      outcome: 'succeeded'
    });
    assert.equal(replay.toolModelResultId, terminal.toolModelResultId);
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId })).length, 1);
    assertions.push('重复recovery source key稳定重放首次ToolModelResult ID');

    const transitionTool = await createTool(ctx, effects, 'receipt-transition-gap', 'external');
    const transitionPrepared = await effects.prepareEffectIntent({
      source: source('internal', 'receipt-transition-gap:prepare'),
      toolCallId: transitionTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'transition', arguments: {}, riskLevel: 'command' }
    });
    await effects.claimEffectDispatch(transitionPrepared.effectIntentId);
    const originalReceiptCandidates = ctx.database.effectReceiptReconciliationCandidates.bind(ctx.database);
    let transitionInjected = false;
    ctx.database.effectReceiptReconciliationCandidates = async () => {
      if (!transitionInjected) {
        transitionInjected = true;
        await effects.recordEffectReceipt({
          source: source('callback', 'receipt-transition-gap:callback'),
          attemptId: transitionPrepared.attemptId,
          effectKind: 'mcp_tool_call',
          outcome: 'succeeded'
        });
      }
      return originalReceiptCandidates();
    };
    try {
      await scanner.runAll();
    } finally {
      ctx.database.effectReceiptReconciliationCandidates = originalReceiptCandidates;
    }
    assert.equal(transitionInjected, true);
    assert.equal((await effects.readTerminalResult(transitionTool.toolCallId, true)).status, 'succeeded');
    assertions.push('receipt在committed-facts扫描与hanging扫描之间提交时，runAll尾部barrier仍在同次启动收口');

    const pendingTool = await createTool(ctx, effects, 'pending-dispatch', 'external');
    const pending = await effects.prepareEffectIntent({
      source: source('internal', 'pending:prepare'),
      toolCallId: pendingTool.toolCallId,
      effectKind: 'mcp_tool_call',
      request: { serverId: 'local', toolName: 'pending', arguments: {}, riskLevel: 'command' }
    });
    assert.equal((await get(ctx.database, 'EffectIntent', pending.effectIntentId)).dispatch_state, 'pending');
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: pending.attemptId })).length, 0);
    assertions.push('Intent提交后、dispatch前崩溃只留下pending意图，不伪造Receipt或外部结果');

    return {
      assertions,
      faults: ['receipt-committed-before-reconcile-crash', 'automatic receipt_written startup reconcile', 'receipt transition between recovery passes', 'database-reopen', 'duplicate recovery replay', 'intent-before-dispatch crash']
    };
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkAttachmentCasIngest() {
  return withRuntime('attachment', async (ctx) => {
    const assertions = [];
    const messageContent = await ctx.store.ingest(ctx.database, 'message', 'text/plain');
    const now = new Date().toISOString();
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
        id: 'attachment-message', created_at: now, updated_at: now, deleted_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: 'attachment-revision', message_id: 'attachment-message', revision_seq: '1', role: 'user',
        content_object_id: messageContent.id, created_at: now
      })
    ]);
    const settingsAuthority = {
      calls: 0,
      async loadGlobalSettings(section) {
        this.calls += 1;
        assert.equal(section, 'attachments');
        return { section, settings: { maxStoredInlineFileMb: 1 }, filePath: 'settings/attachments.json' };
      }
    };
    const service = new kernel.AttachmentIngestService(ctx.database, ctx.store, settingsAuthority);
    const stored = await service.ingest({
      messageRevisionId: 'attachment-revision',
      position: '9007199254740993',
      name: 'note.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('attachment-body')
    });
    assert.equal((await service.read(stored.attachmentId)).toString('utf8'), 'attachment-body');
    assert.equal((await get(ctx.database, 'AttachmentLink', stored.attachmentLinkId)).message_revision_id, 'attachment-revision');
    assert.equal((await get(ctx.database, 'AttachmentLink', stored.attachmentLinkId)).position, 9007199254740993n);
    assert.equal((await get(ctx.database, 'Attachment', stored.attachmentId)).content_object_id, stored.contentObjectId);
    assert.ok(settingsAuthority.calls >= 1);
    assertions.push('附件限制从现有settings authority读取，正文进CAS，AttachmentLink精确指向MessageRevision');

    const beforeObjects = (await list(ctx.database, 'ContentObject', {})).length;
    const beforeLinks = (await list(ctx.database, 'AttachmentLink', {})).length;
    await assert.rejects(service.ingest({
      messageRevisionId: 'attachment-revision',
      position: '2',
      name: 'too-large.bin',
      mimeType: 'application/octet-stream',
      bytes: Buffer.alloc((1024 * 1024) + 1)
    }), (error) => error?.name === 'AttachmentSizeLimitError');
    assert.equal((await list(ctx.database, 'ContentObject', {})).length, beforeObjects);
    assert.equal((await list(ctx.database, 'AttachmentLink', {})).length, beforeLinks);
    assertions.push('超限附件在CAS发布和Runtime引用前拒绝');

    const duplicate = await service.ingest({
      messageRevisionId: 'attachment-revision',
      position: '9007199254740993',
      name: 'note.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('attachment-body')
    });
    assert.equal(duplicate.attachmentLinkId, stored.attachmentLinkId);
    assert.equal(duplicate.deduplicated, true);
    assertions.push('重复ingest稳定重放同一Attachment/Link且大INTEGER保持bigint/十进制字符串');

    const failingParent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-attachment-fail-'));
    let failingDatabase;
    try {
      const candidate = await kernel.resetCandidateRuntimeRoot(failingParent);
      failingDatabase = await kernel.RuntimeDatabase.open(candidate.authority);
      const failingStore = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
      const base = await failingStore.ingest(failingDatabase, 'base', 'text/plain');
      await failingDatabase.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Message').insert({ id: 'm', created_at: now, updated_at: now, deleted_at: null }),
        kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
          id: 'r', message_id: 'm', revision_seq: '1', role: 'user', content_object_id: base.id, created_at: now
        })
      ]);
      await fs.rm(candidate.binding.paths.casRootPath, { recursive: true, force: true });
      await fs.writeFile(candidate.binding.paths.casRootPath, 'blocked');
      const failingService = new kernel.AttachmentIngestService(failingDatabase, failingStore, settingsAuthority);
      await assert.rejects(failingService.ingest({
        messageRevisionId: 'r', position: '1', name: 'fail.bin', mimeType: 'application/octet-stream', bytes: Buffer.from('fail')
      }));
      assert.equal((await list(failingDatabase, 'Attachment', {})).length, 0);
      assert.equal((await list(failingDatabase, 'AttachmentLink', {})).length, 0);
    } finally {
      if (failingDatabase) await failingDatabase.close().catch(() => undefined);
      await fs.rm(failingParent, { recursive: true, force: true });
    }
    assertions.push('CAS发布失败时SQLite不保存Attachment或AttachmentLink引用');

    return {
      assertions,
      faults: ['size-limit-before-CAS', 'CAS-publish-failure-before-SQLite', 'duplicate ingest', 'large INTEGER wire']
    };
  });
}

async function checkMcpEffectRecovery() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-mcp-'));
  let ctx;
  try {
    ctx = await createRuntime(parent, 'mcp');
    const assertions = [];
    let effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    let calls = 0;
    const authorizedRisks = [];
    let mcp = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations(_serverId, toolName) {
        if (toolName === 'echo') return { readOnlyHint: true };
        if (toolName === 'fail') return { destructiveHint: true };
        return {};
      },
      async callTool(_serverId, toolName, args) {
        calls += 1;
        if (toolName === 'fail') return { isError: true, content: 'local fake MCP failure' };
        if (toolName === 'explicit') throw new kernel.McpInvocationError('explicit_failure', 'JSON-RPC invalid params');
        if (toolName === 'ambiguous') throw new Error('connection lost after dispatch');
        return { toolName, args };
      }
    }, {
      async authorize(request) {
        authorizedRisks.push([request.toolName, request.riskLevel, request.toolCallId]);
        return { toolPolicyAllowed: true, planReviewAllowed: true };
      }
    });
    assert.equal(kernel.mapMcpRisk({ readOnlyHint: true }), 'read');
    assert.equal(kernel.mapMcpRisk({ destructiveHint: true }), 'write');
    assert.equal(kernel.mapMcpRisk({}), 'command');
    assertions.push('MCP annotations只映射read/write/command，不建立MCP专用权限体系');

    const deniedTool = await createTool(ctx, effects, 'mcp-denied', 'mcp');
    const deniedMcp = new kernel.McpEffectDispatcher(
      ctx.database,
      effects,
      { async toolAnnotations() { return { readOnlyHint: true }; }, async callTool() { throw new Error('policy-denied call must not execute'); } },
      {
        async authorize() {
          return { toolPolicyAllowed: true, planReviewAllowed: false, reason: 'plan approval required' };
        }
      }
    );
    const denied = await deniedMcp.prepare({
      source: source('internal', 'mcp-denied:prepare'),
      toolCallId: deniedTool.toolCallId,
      serverId: 'fake-settings-id',
      toolName: 'echo',
      arguments: { value: 1 }
    });
    assert.equal(denied.disposition, 'rejected');
    assert.equal(denied.settlement.status, 'rejected');
    assert.equal((await list(ctx.database, 'Attempt', {
      operation_id: (await list(ctx.database, 'Operation', { tool_call_id: deniedTool.toolCallId }))[0].id
    })).length, 0);
    assert.equal((await list(ctx.database, 'EffectIntent', {})).length, 0);
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: deniedTool.toolCallId })).length, 1);

    const successTool = await createTool(ctx, effects, 'mcp-success', 'mcp');
    const success = await mcp.prepare({
      source: source('internal', 'mcp-success:prepare'), toolCallId: successTool.toolCallId,
      serverId: 'fake-settings-id', toolName: 'echo', arguments: { value: 1 }
    });
    const successResult = await mcp.dispatch(success.effectIntentId);
    assert.equal(successResult.terminal.status, 'succeeded');
    assert.equal(calls, 1);
    assert.deepEqual(authorizedRisks[0], ['echo', 'read', successTool.toolCallId]);
    assertions.push('MCP prepare复用既有ToolPolicy/PlanReviewPolicy gate；明确拒绝持久收口且不创建Attempt/Intent、不外调');

    const failureTool = await createTool(ctx, effects, 'mcp-failure', 'mcp');
    const failure = await mcp.prepare({
      source: source('internal', 'mcp-failure:prepare'), toolCallId: failureTool.toolCallId,
      serverId: 'fake-settings-id', toolName: 'fail', arguments: {}
    });
    const failed = await mcp.dispatch(failure.effectIntentId);
    assert.equal(failed.terminal.status, 'failed');
    assert.equal(calls, 2);

    const explicitTool = await createTool(ctx, effects, 'mcp-explicit-failure', 'mcp');
    const explicit = await mcp.prepare({
      source: source('internal', 'mcp-explicit-failure:prepare'),
      toolCallId: explicitTool.toolCallId,
      serverId: 'fake-settings-id',
      toolName: 'explicit',
      arguments: { invalid: true }
    });
    const explicitFailure = await mcp.dispatch(explicit.effectIntentId);
    assert.equal(explicitFailure.observation.outcome, 'failed');
    assert.equal(explicitFailure.terminal.status, 'failed');

    const ambiguousTool = await createTool(ctx, effects, 'mcp-ambiguous', 'mcp');
    const ambiguous = await mcp.prepare({
      source: source('internal', 'mcp-ambiguous:prepare'),
      toolCallId: ambiguousTool.toolCallId,
      serverId: 'fake-settings-id',
      toolName: 'ambiguous',
      arguments: {}
    });
    const unknown = await mcp.dispatch(ambiguous.effectIntentId);
    assert.equal(unknown.observation.outcome, 'outcome_unknown');
    assert.equal(unknown.terminal.status, 'outcome_unknown');
    assert.equal(calls, 4);
    assertions.push('MCP显式isError/adapter明确失败形成failed；只有dispatch后无法证明的连接异常形成outcome_unknown');

    const lostTool = await createTool(ctx, effects, 'mcp-lost-callback', 'mcp');
    const lost = await mcp.prepare({
      source: source('internal', 'mcp-lost:prepare'), toolCallId: lostTool.toolCallId,
      serverId: 'fake-settings-id', toolName: 'echo', arguments: { lost: true }
    });
    assert.equal(await effects.claimEffectDispatch(lost.effectIntentId), true);
    const external = await mcp.executeDispatched(lost.effectIntentId);
    assert.equal(external.outcome, 'succeeded');
    assert.equal(calls, 5);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: lost.attemptId })).length, 0);
    await ctx.database.close();

    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'mcp-restart' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    let rebuiltCalls = 0;
    mcp = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations() { return {}; },
      async callTool() { rebuiltCalls += 1; return { shouldNotRun: true }; }
    }, allowMcpPolicy());
    const recovered = await mcp.recoverDispatched({
      source: source('recovery', 'mcp-lost:recover'),
      effectIntentId: lost.effectIntentId
    });
    assert.equal(recovered.status, 'outcome_unknown');
    assert.equal(rebuiltCalls, 0);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: lost.attemptId })).length, 1);
    assertions.push('MCP callback丢失并重启后不自动重试；连接重建不冒充调用恢复，落outcome_unknown');

    const replay = await mcp.recoverDispatched({
      source: source('recovery', 'mcp-lost:recover'),
      effectIntentId: lost.effectIntentId
    });
    assert.equal(replay.toolModelResultId, recovered.toolModelResultId);
    assert.equal(rebuiltCalls, 0);
    assertions.push('重复MCP recovery稳定重放首次unknown结果且外部调用仍为0');

    const conflictingTool = await createTool(ctx, effects, 'mcp-conflicting-annotations', 'mcp');
    const conflictingMcp = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations() { return { readOnlyHint: true, destructiveHint: true }; },
      async callTool() { throw new Error('conflicting annotations must fail before dispatch'); }
    }, allowMcpPolicy());
    await assert.rejects(conflictingMcp.prepare({
      source: source('internal', 'mcp-conflicting-annotations:prepare'),
      toolCallId: conflictingTool.toolCallId,
      serverId: 'fake-settings-id',
      toolName: 'conflicting',
      arguments: {}
    }), /both read-only and destructive/);
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: conflictingTool.toolCallId })).length, 0);
    assertions.push('MCP风险只接受registry权威annotations；冲突提示在建Intent/外调前拒绝');

    return {
      assertions,
      faults: [
        'ToolPolicy/PlanReviewPolicy denial before intent',
        'MCP success',
        'observed MCP tool failure',
        'explicit adapter failure',
        'ambiguous transport failure',
        'authoritative conflicting annotations',
        'callback lost after dispatch',
        'host restart no query',
        'no automatic retry'
      ]
    };
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkProcessWrapperRecovery() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-process-'));
  let ctx;
  try {
    ctx = await createRuntime(parent, 'process');
    const assertions = [];
    let effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    let processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );
    const tool = await createTool(ctx, effects, 'process-restart', 'bash');
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>{process.stdout.write('restart-output\\n'+'\\0'.repeat(8000))},3000)")}`;
    const prepared = await processes.prepareStart({
      source: source('internal', 'process-restart:prepare'),
      toolCallId: tool.toolCallId,
      command,
      cwd: parent
    });
    const started = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(started.observation.outcome, 'succeeded');
    assert.equal(started.observation.state, 'background_started');
    assert.equal(started.observation.processId, prepared.request.processId);
    assert.equal(started.terminal.status, 'succeeded');
    const handoffOutcome = (await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId }))[0];
    const handoffOutcomeMetadata = await get(ctx.database, 'ContentObject', handoffOutcome.content_object_id);
    const handoffModelResult = JSON.parse((await ctx.store.read(handoffOutcomeMetadata)).toString('utf8'));
    assert.equal(handoffModelResult.detail.status, 'running');
    assert.equal(handoffModelResult.detail.processId, prepared.request.processId);
    assert.equal(handoffModelResult.detail.complete, false);
    const processId = prepared.request.processId;
    await ctx.database.close();

    let recoveryApp = await kernel.ReliableKernelApplication.open(
      ctx.authority,
      phaseDApplicationDependencies()
    );
    let lifecycleProcessId;
    try {
      const recovery = await recoveryApp.recover();
      assert.equal(recovery.phaseD.length, 2);
      assert.equal((await get(recoveryApp.database, 'Process', processId)).status, 'running');
      assert.equal((await list(recoveryApp.database, 'ProcessReceipt', { process_id: processId })).length, 0);
      assert.deepEqual(recoveryApp.processes.inspectExitObservers().activeProcessIds, [processId]);

      const exitedRow = await waitForPersistedProcessStatus(
        recoveryApp.database,
        processId,
        new Set(['exited']),
        10_000
      );
      assert.equal(exitedRow.status, 'exited');
      await waitForNoExitObservers(recoveryApp.processes, 2_000);
      const processReceipt = (await list(recoveryApp.database, 'ProcessReceipt', { process_id: processId }))[0];
      assert.ok(processReceipt);
      const completionInbox = await waitForSingleRow(
        recoveryApp.database,
        'RuntimeInboxItem',
        { source_kind: 'process_receipt', source_id: processReceipt.id },
        5_000
      );
      const completionPayloadLink = (await list(recoveryApp.database, 'RuntimeInboxPayloadLink', {
        inbox_item_id: completionInbox.id
      }))[0];
      assert.ok(completionPayloadLink);
      const completionPayloadMetadata = await get(
        recoveryApp.database,
        'ContentObject',
        completionPayloadLink.content_object_id
      );
      const completionPayload = JSON.parse((await recoveryApp.contentStore.read(completionPayloadMetadata)).toString('utf8'));
      assert.equal(completionPayload.kind, 'process_completion');
      assert.equal(completionPayload.processId, processId);
      assert.ok(completionPayload.output.stdoutTail.length > 0);
      assert.ok(completionPayload.output.stdoutTail.length < 8_000, 'escape-heavy output tail must shrink to the payload bound');
      assert.ok(Buffer.byteLength(JSON.stringify(completionPayload), 'utf8') <= kernel.PROCESS_COMPLETION_MAX_PAYLOAD_BYTES);
      const completionDelivery = await waitForSingleRow(
        recoveryApp.database,
        'RuntimeDelivery',
        { inbox_item_id: completionInbox.id },
        5_000
      );
      assert.equal(completionDelivery.phase, 'current_turn');
      assert.equal(completionDelivery.state, 'pending');
      const completionWake = await waitForSingleRow(
        recoveryApp.database,
        'RuntimeDeliveryWake',
        { delivery_id: completionDelivery.id },
        5_000
      );
      assert.ok(
        completionWake.state === 'pending' || completionWake.state === 'claimed',
        `delivery wake may be observed before or after the live dispatcher claim, got ${String(completionWake.state)}`
      );
      await Promise.all([
        recoveryApp.processDeliveries.scanNow(),
        recoveryApp.processDeliveries.scanNow(),
        recoveryApp.processDeliveries.scanNow()
      ]);
      assert.equal((await list(recoveryApp.database, 'RuntimeInboxItem', {
        source_kind: 'process_receipt', source_id: processReceipt.id
      })).length, 1);
      assert.equal((await list(recoveryApp.database, 'RuntimeDelivery', {
        inbox_item_id: completionInbox.id
      })).length, 1);
      assert.equal((await list(recoveryApp.database, 'RuntimeDeliveryWake', {
        delivery_id: completionDelivery.id
      })).length, 1);
      const firstRead = await recoveryApp.processes.readOutputPage(processId);
      const secondRead = await recoveryApp.processes.readOutputPage(processId);
      assert.equal(firstRead.stdout, secondRead.stdout);
      assert.match(firstRead.stdout, /restart-output/);
      const processReceiptRace = await Promise.all([
        recoveryApp.processes.reconcileProcessExit(processId),
        recoveryApp.processes.reconcileProcessExit(processId)
      ]);
      assert.ok(processReceiptRace.every((entry) => entry.state === 'exited'));
      assert.equal((await list(recoveryApp.database, 'ProcessReceipt', { process_id: processId })).length, 1);
      const exitOperations = await list(recoveryApp.database, 'Operation', { owner_kind: 'process', owner_id: processId });
      assert.equal(exitOperations.length, 1);
      assert.equal(exitOperations[0].tool_call_id, null);
      const exitAttempts = await list(recoveryApp.database, 'Attempt', { operation_id: exitOperations[0].id });
      const exitIntents = await list(recoveryApp.database, 'EffectIntent', { attempt_id: exitAttempts[0].id });
      const exitReceipts = await list(recoveryApp.database, 'EffectReceipt', { attempt_id: exitAttempts[0].id });
      assert.equal(exitIntents[0].effect_kind, 'process_exit');
      assert.equal(exitIntents[0].dispatch_state, 'receipt_written');
      assert.equal(exitReceipts.length, 1);
      const detachedCommandReceipts = await list(recoveryApp.database, 'CommandReceipt', { conversation_id: null });
      assert.ok(detachedCommandReceipts.length > 0);
      assert.ok(detachedCommandReceipts.every((entry) => entry.turn_id === null));
      assertions.push('foreground wait到期以background_started+processId终态化原ToolCall；ProcessReceipt自动有界reconcile输出并建立通用Inbox payload Link、Delivery和持久wake，竞争扫描保持各一份');

      const lifecycleTool = await createTool(ctx, recoveryApp.runtime.effects, 'process-observer-close', 'bash');
      const lifecyclePrepared = await recoveryApp.processes.prepareStart({
        source: source('internal', 'process-observer-close:prepare'),
        toolCallId: lifecycleTool.toolCallId,
        command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>process.stdout.write('observer-close\\n'),3000)")}`,
        cwd: parent
      });
      await recoveryApp.processes.dispatchStart(lifecyclePrepared.effect.effectIntentId, 0);
      lifecycleProcessId = lifecyclePrepared.request.processId;
      const lifecycleRow = await get(recoveryApp.database, 'Process', lifecycleProcessId);
      const lifecycleExitReceiptPath = path.join(
        kernel.processSpoolPath(ctx.binding, lifecycleRow.spool_locator),
        kernel.PROCESS_WRAPPER_EXIT_RECEIPT_FILE
      );
      assert.ok(recoveryApp.processes.inspectExitObservers().activeProcessIds.includes(lifecycleProcessId));
      const closeStarted = Date.now();
      await recoveryApp.close();
      assert.ok(Date.now() - closeStarted < 1_500, '关闭应用不得等待外部后台进程退出');
      assert.equal(await exists(lifecycleExitReceiptPath), false, '关闭完成时外部进程仍应运行且尚无exit receipt');
      assert.deepEqual(recoveryApp.processes.inspectExitObservers().activeProcessIds, []);
      recoveryApp = undefined;
    } finally {
      if (recoveryApp) await recoveryApp.close().catch(() => undefined);
    }

    const wakeRequests = [];
    let wakeRecoveryApp = await kernel.ReliableKernelApplication.open(
      ctx.authority,
      phaseDApplicationDependencies({
        processCompletionWakeHandler: async (request) => {
          wakeRequests.push(request);
          return { acknowledged: true };
        }
      })
    );
    try {
      await wakeRecoveryApp.recover();
      const lifecycleExited = await waitForPersistedProcessStatus(
        wakeRecoveryApp.database,
        lifecycleProcessId,
        new Set(['exited']),
        10_000
      );
      assert.equal(lifecycleExited.status, 'exited');
      const lifecycleReceipt = await waitForSingleRow(
        wakeRecoveryApp.database,
        'ProcessReceipt',
        { process_id: lifecycleProcessId },
        5_000
      );
      const lifecycleInbox = await waitForSingleRow(
        wakeRecoveryApp.database,
        'RuntimeInboxItem',
        { source_kind: 'process_receipt', source_id: lifecycleReceipt.id },
        5_000
      );
      const lifecycleDelivery = await waitForSingleRow(
        wakeRecoveryApp.database,
        'RuntimeDelivery',
        { inbox_item_id: lifecycleInbox.id },
        5_000
      );
      const lifecycleWake = await waitForRowState(
        wakeRecoveryApp.database,
        'RuntimeDeliveryWake',
        { delivery_id: lifecycleDelivery.id },
        'acknowledged',
        5_000
      );
      assert.ok(lifecycleWake.acknowledged_at);
      assert.ok(wakeRequests.some((request) =>
        request.processId === lifecycleProcessId && request.action === 'resume_current_turn'
      ));
      assert.ok(wakeRequests.some((request) =>
        request.processId === processId && request.action === 'resume_current_turn'
      ));
      assertions.push('detached wrapper跨完整应用重启后，启动level scan修复已提交但未投递/未唤醒窗口；迟到receipt自动生成唯一Delivery，持久wake由新宿主ACK并携带安全边界resume动作');
    } finally {
      await wakeRecoveryApp.close().catch(() => undefined);
      wakeRecoveryApp = undefined;
    }

    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'process-restart-host' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: lifecycleProcessId })).length, 1);
    assertions.push('应用关闭会唤醒并清空观察器而不等待外部进程；process_exit receipt保持nullable关系和first-wins，read_output重复读取不消费');

    const idleContext = await createAdditionalTurn(ctx, 'process-idle-delivery');
    const idleTool = await createTool({ ...ctx, turnId: idleContext.turnId }, effects, 'process-idle-delivery', 'bash');
    const idlePrepared = await processes.prepareStart({
      source: source('internal', 'process-idle-delivery:prepare'),
      toolCallId: idleTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>process.stdout.write('idle-complete\\n'),250)")}`,
      cwd: parent
    });
    const idleStarted = await processes.dispatchStart(idlePrepared.effect.effectIntentId, 0);
    assert.equal(idleStarted.observation.state, 'background_started');
    const idleNow = new Date().toISOString();
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').delete(idleContext.leaseId),
      kernel.DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
        id: 'termination-process-idle-delivery',
        turn_id: idleContext.turnId,
        terminal_status: 'completed',
        reason: 'fixture became idle after background handoff',
        created_at: idleNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').update(idleContext.turnId, {
        status: 'terminated',
        updated_at: idleNow,
        terminal_at: idleNow
      })
    ]);
    const idleWakeRequests = [];
    const idleDeliveries = new kernel.RuntimeDeliveryControlPlane(ctx.database);
    const idleDispatcher = new kernel.ProcessCompletionDeliveryControlPlane(
      ctx.database,
      ctx.store,
      processes,
      idleDeliveries,
      {
        scanIntervalMs: 25,
        wakeHandler: async (request) => {
          idleWakeRequests.push(request);
          return { acknowledged: true };
        }
      }
    );
    processes.setProcessReceiptObserver((completedProcessId) => {
      idleDispatcher.notifyProcessReceipt(completedProcessId);
    });
    await idleDispatcher.start();
    try {
      const idleExited = await waitUntilTerminal(processes, idlePrepared.request.processId, 5_000);
      assert.equal(idleExited.state, 'exited');
      await processes.reconcileProcessExit(idlePrepared.request.processId);
      const idleReceipt = await waitForSingleRow(
        ctx.database,
        'ProcessReceipt',
        { process_id: idlePrepared.request.processId },
        5_000
      );
      const idleInbox = await waitForSingleRow(
        ctx.database,
        'RuntimeInboxItem',
        { source_kind: 'process_receipt', source_id: idleReceipt.id },
        5_000
      );
      const idleDelivery = await waitForSingleRow(
        ctx.database,
        'RuntimeDelivery',
        { inbox_item_id: idleInbox.id },
        5_000
      );
      assert.equal(idleDelivery.phase, 'next_turn');
      assert.equal(idleDelivery.target_turn_id, null);
      const acknowledgedIdleWake = await waitForRowState(
        ctx.database,
        'RuntimeDeliveryWake',
        { delivery_id: idleDelivery.id },
        'acknowledged',
        5_000
      );
      await assert.rejects(ctx.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').update(acknowledgedIdleWake.id, {
          state: 'pending',
          acknowledged_at: null,
          updated_at: new Date().toISOString()
        })
      ]), /cannot transition/);
      assert.ok(idleWakeRequests.some((request) =>
        request.processId === idlePrepared.request.processId
          && request.action === 'start_continuation'
          && request.sourceTurnId === idleContext.turnId
      ));
      assertions.push('后台完成时Conversation空闲则Delivery保持next_turn，持久wake请求继承sourceTurn的内部continuation而不悬挂原ToolCall');
    } finally {
      processes.setProcessReceiptObserver(undefined);
      await idleDispatcher.dispose();
    }

    const quickTool = await createTool(ctx, effects, 'process-quick-failure', 'bash');
    const quickPrepared = await processes.prepareStart({
      source: source('internal', 'process-quick-failure:prepare'),
      toolCallId: quickTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('process.exit(7)')}`,
      cwd: parent
    });
    const quick = await processes.dispatchStart(quickPrepared.effect.effectIntentId, 5_000);
    assert.equal(quick.observation.foreground.state, 'exited');
    assert.equal(quick.observation.foreground.receipt.exitCode, '7');
    assert.equal(quick.terminal.status, 'failed');
    const quickProcessReceipt = (await list(ctx.database, 'ProcessReceipt', {
      process_id: quickPrepared.request.processId
    }))[0];
    assert.equal(quickProcessReceipt.outcome, 'failed');
    assert.equal(quickProcessReceipt.exit_code, 7n);
    const poisonNow = new Date().toISOString();
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ProcessCompletionDispatch').insert({
        id: 'process-completion-dispatch-poison-foreground',
        process_receipt_id: quickProcessReceipt.id,
        state: 'pending',
        claim_owner_host_boot_id: null,
        claim_generation: 0n,
        claim_expires_at: null,
        attempt_count: 0n,
        failure_count: 0n,
        next_attempt_at: null,
        last_error: null,
        completed_at: null,
        created_at: poisonNow,
        updated_at: poisonNow
      })
    ]);
    const poisonErrors = [];
    const poisonDispatcher = new kernel.ProcessCompletionDeliveryControlPlane(
      ctx.database,
      ctx.store,
      processes,
      new kernel.RuntimeDeliveryControlPlane(ctx.database),
      {
        scanIntervalMs: 10,
        claimTtlMs: 100,
        retryBaseMs: 10,
        maxFailureCount: 2,
        onError: (entry) => poisonErrors.push(entry)
      }
    );
    await poisonDispatcher.start();
    try {
      const deadLetter = await waitForRowState(ctx.database, 'ProcessCompletionDispatch', {
        process_receipt_id: quickProcessReceipt.id
      }, 'dead_letter', 5_000);
      assert.equal(deadLetter.failure_count, 2n);
      assert.match(deadLetter.last_error, /detached process_exit Operation/);
      // Other legitimate process completions may be pending in this shared fixture. Prove the
      // poison row itself is excluded from subsequent scans instead of asserting a global count.
      await poisonDispatcher.scanNow();
      const stableDeadLetter = await get(
        ctx.database,
        'ProcessCompletionDispatch',
        'process-completion-dispatch-poison-foreground'
      );
      assert.equal(stableDeadLetter.state, 'dead_letter');
      assert.equal(stableDeadLetter.failure_count, 2n);
      assert.equal(stableDeadLetter.updated_at, deadLetter.updated_at);
      assert.equal(poisonErrors.length, 2);
    } finally {
      await poisonDispatcher.dispose();
    }
    assertions.push('快速非零foreground退出不误建完成投递；注入的毒reconcile outbox按持久退避在上限后dead-letter，后续扫描不再遍历该Receipt');

    const receiptOnlyTool = await createTool(ctx, effects, 'process-exit-receipt-only', 'bash');
    const receiptOnlyPrepared = await processes.prepareStart({
      source: source('internal', 'process-exit-receipt-only:prepare'),
      toolCallId: receiptOnlyTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setTimeout(()=>process.exit(9),200)')}`,
      cwd: parent
    });
    await processes.dispatchStart(receiptOnlyPrepared.effect.effectIntentId, 0);
    const receiptOnlyId = receiptOnlyPrepared.request.processId;
    const receiptOnlyExited = await waitUntilTerminal(processes, receiptOnlyId, 10_000);
    assert.equal(receiptOnlyExited.state, 'exited');
    const receiptOnlyRow = await get(ctx.database, 'Process', receiptOnlyId);
    const receiptOnlySpool = kernel.processSpoolPath(ctx.binding, receiptOnlyRow.spool_locator);
    await fs.unlink(path.join(receiptOnlySpool, kernel.PROCESS_WRAPPER_IDENTITY_FILE));
    const withoutIdentity = await processes.wait(receiptOnlyId, 0);
    assert.equal(withoutIdentity.state, 'exited');
    assert.equal(withoutIdentity.receipt.exitCode, '9');
    const receiptOnlyReconciled = await processes.reconcileProcessExit(receiptOnlyId);
    assert.equal(receiptOnlyReconciled.state, 'exited');
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: receiptOnlyId }))[0].exit_code, 9n);
    assertions.push('有效atomic exit receipt可直接与SQLite Process证据核对；identity文件缺失不再把真实exitCode降级为unknown');

    const alreadyExitedTool = await createTool(ctx, effects, 'process-stop-already-exited-target', 'bash');
    const alreadyExitedStart = await processes.prepareStart({
      source: source('internal', 'process-stop-already-exited-target:prepare'),
      toolCallId: alreadyExitedTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setTimeout(()=>process.exit(0),120)')}`,
      cwd: parent
    });
    await processes.dispatchStart(alreadyExitedStart.effect.effectIntentId, 0);
    const alreadyExitedId = alreadyExitedStart.request.processId;
    const atomicAlreadyExited = await waitUntilTerminal(processes, alreadyExitedId, 10_000);
    assert.equal(atomicAlreadyExited.state, 'exited');
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: alreadyExitedId })).length, 0);
    const alreadyExitedStopTool = await createTool(ctx, effects, 'process-stop-already-exited', 'bash');
    const alreadyExitedStop = await processes.prepareStop({
      source: source('internal', 'process-stop-already-exited:prepare'),
      toolCallId: alreadyExitedStopTool.toolCallId,
      processId: alreadyExitedId
    });
    await effects.claimEffectDispatch(alreadyExitedStop.effectIntentId);
    const alreadyExitedResult = await processes.executeDispatchedStop(alreadyExitedStop.effectIntentId);
    assert.equal(alreadyExitedResult.outcome, 'succeeded');
    assert.equal(alreadyExitedResult.status, 'already_exited');
    assert.equal(alreadyExitedResult.receipt.exitCode, '0');
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: alreadyExitedId }))[0].outcome, 'succeeded');
    const alreadyExitedRecovered = await processes.recoverDispatchedStop({
      source: source('recovery', 'process-stop-already-exited:recover'),
      effectIntentId: alreadyExitedStop.effectIntentId
    });
    assert.equal(alreadyExitedRecovered.status, 'succeeded');
    assertions.push('stop先收敛SQLite/atomic exit receipt；目标已自然退出时稳定返回already_exited而非outcome_unknown');

    const corruptTool = await createTool(ctx, effects, 'process-corrupt', 'bash');
    const corruptPrepared = await processes.prepareStart({
      source: source('internal', 'process-corrupt:prepare'),
      toolCallId: corruptTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>process.stdout.write('done'),200)")}`,
      cwd: parent
    });
    await processes.dispatchStart(corruptPrepared.effect.effectIntentId);
    const corruptId = corruptPrepared.request.processId;
    const validExit = await waitUntilTerminal(processes, corruptId, 10_000);
    assert.equal(validExit.state, 'exited');
    const corruptRow = await get(ctx.database, 'Process', corruptId);
    const corruptSpool = kernel.processSpoolPath(ctx.binding, corruptRow.spool_locator);
    const receiptPath = path.join(corruptSpool, kernel.PROCESS_WRAPPER_EXIT_RECEIPT_FILE);
    const receiptJson = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const invalidTuple = { ...receiptJson, exitCode: null, signal: null };
    await fs.writeFile(receiptPath, `${JSON.stringify(invalidTuple)}\n`);
    const invalidTupleObservation = await processes.wait(corruptId, 0);
    assert.equal(invalidTupleObservation.state, 'outcome_unknown');
    receiptJson.startFingerprint = `${receiptJson.startFingerprint}-mismatch`;
    await fs.writeFile(receiptPath, `${JSON.stringify(receiptJson)}\n`);
    const unknown = await processes.wait(corruptId, 0);
    assert.equal(unknown.state, 'outcome_unknown');
    assertions.push('exitCode/signal非法终止元组及身份不匹配receipt都不得伪造退出结果，明确outcome_unknown');

    const stopRaceTool = await createTool(ctx, effects, 'process-stop-close-race', 'bash');
    const stopRaceCode = "const {spawn}=require('node:child_process');spawn('sleep',['1.2'],{stdio:['ignore','inherit','inherit']});setTimeout(()=>process.exit(0),250)";
    const stopRacePrepared = await processes.prepareStart({
      source: source('internal', 'process-stop-close-race:prepare'),
      toolCallId: stopRaceTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(stopRaceCode)}`,
      cwd: parent
    });
    await processes.dispatchStart(stopRacePrepared.effect.effectIntentId, 0);
    const stopRaceId = stopRacePrepared.request.processId;
    const stopRaceRow = await get(ctx.database, 'Process', stopRaceId);
    const stopRaceSpool = kernel.processSpoolPath(ctx.binding, stopRaceRow.spool_locator);
    await new Promise((resolve) => setTimeout(resolve, 210));
    await fs.writeFile(path.join(stopRaceSpool, kernel.PROCESS_WRAPPER_STOP_REQUEST_FILE), JSON.stringify({
      kind: kernel.PROCESS_WRAPPER_PROTOCOL,
      processId: stopRaceId,
      stableNonce: stopRaceRow.wrapper_nonce,
      startFingerprint: stopRaceRow.start_fingerprint,
      processGroupId: stopRaceRow.process_group_id.toString(),
      commandDigest: stopRaceRow.command_digest,
      requestedAt: new Date().toISOString()
    }));
    const stopRaceExited = await waitUntilTerminal(processes, stopRaceId, 10_000);
    assert.equal(stopRaceExited.state, 'exited');
    assert.equal(stopRaceExited.receipt.exitCode, '0');
    await processes.reconcileProcessExit(stopRaceId);
    assertions.push('stop请求与子进程自然退出竞争时，PID消失不再杀死wrapper，close路径仍原子写真实exit receipt');

    const recoverStopStartTool = await createTool(ctx, effects, 'process-stop-recovery-target', 'bash');
    const recoverStopStart = await processes.prepareStart({
      source: source('internal', 'process-stop-recovery-target:prepare'),
      toolCallId: recoverStopStartTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(()=>{},1000)')}`,
      cwd: parent
    });
    await processes.dispatchStart(recoverStopStart.effect.effectIntentId);
    const recoverStopTool = await createTool(ctx, effects, 'process-stop-recovery', 'bash');
    const recoverStop = await processes.prepareStop({
      source: source('internal', 'process-stop-recovery:prepare'),
      toolCallId: recoverStopTool.toolCallId,
      processId: recoverStopStart.request.processId
    });
    await effects.claimEffectDispatch(recoverStop.effectIntentId);
    const recoverStopObservation = await processes.executeDispatchedStop(recoverStop.effectIntentId);
    assert.equal(recoverStopObservation.outcome, 'succeeded');
    assert.equal(recoverStopObservation.status, 'stopped');
    assert.equal(recoverStopObservation.receipt.stopRequested, true);
    await waitUntilTerminal(processes, recoverStopStart.request.processId, 10_000);
    const recoveredStop = await processes.recoverDispatchedStop({
      source: source('recovery', 'process-stop-recovery:scan'),
      effectIntentId: recoverStop.effectIntentId
    });
    assert.equal(recoveredStop.status, 'succeeded');

    const winnerStopStartTool = await createTool(ctx, effects, 'process-stop-winner-target', 'bash');
    const winnerStopStart = await processes.prepareStart({
      source: source('internal', 'process-stop-winner-target:prepare'),
      toolCallId: winnerStopStartTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(()=>{},1000)')}`,
      cwd: parent
    });
    await processes.dispatchStart(winnerStopStart.effect.effectIntentId);
    const winnerStopTool = await createTool(ctx, effects, 'process-stop-winner', 'bash');
    const winnerStop = await processes.prepareStop({
      source: source('internal', 'process-stop-winner:prepare'),
      toolCallId: winnerStopTool.toolCallId,
      processId: winnerStopStart.request.processId
    });
    await effects.claimEffectDispatch(winnerStop.effectIntentId);
    const winnerStopObservation = await processes.executeDispatchedStop(winnerStop.effectIntentId);
    assert.equal(winnerStopObservation.outcome, 'succeeded');
    assert.equal(winnerStopObservation.status, 'stopped');
    await waitUntilTerminal(processes, winnerStopStart.request.processId, 10_000);
    const firstStopReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'process-stop-winner:callback'),
      attemptId: winnerStop.attemptId,
      effectKind: 'process_stop_request',
      outcome: 'succeeded',
      detail: { outcome: 'succeeded', reason: 'wrapper accepted matching stop request' }
    });
    const recoveredWinnerStop = await processes.recoverDispatchedStop({
      source: source('recovery', 'process-stop-winner:scan'),
      effectIntentId: winnerStop.effectIntentId
    });
    assert.equal(recoveredWinnerStop.status, 'succeeded');
    assert.equal((await get(ctx.database, 'EffectReceipt', firstStopReceipt.effectReceiptId)).outcome, 'succeeded');
    assert.equal((await get(ctx.database, 'Operation', winnerStop.operationId)).status, 'succeeded');
    assertions.push('stop恢复只读matching stop evidence；并发first-wins时从持久EffectReceipt派生，不让stale unknown覆盖succeeded');

    const longTool = await createTool(ctx, effects, 'process-stop-target', 'bash');
    const longPrepared = await processes.prepareStart({
      source: source('internal', 'process-stop-target:prepare'),
      toolCallId: longTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>process.stdout.write('tick\\n'),100)")}`,
      cwd: parent
    });
    await processes.dispatchStart(longPrepared.effect.effectIntentId);
    const longId = longPrepared.request.processId;

    const wrongStopTool = await createTool(ctx, effects, 'process-stop-wrong', 'bash');
    const longRow = await get(ctx.database, 'Process', longId);
    const wrongStop = await effects.prepareEffectIntent({
      source: source('internal', 'process-stop-wrong:prepare'),
      toolCallId: wrongStopTool.toolCallId,
      effectKind: 'process_stop_request',
      owner: { kind: 'process', id: longId },
      request: {
        processId: longId,
        stableNonce: '0'.repeat(32),
        startFingerprint: longRow.start_fingerprint,
        processGroupId: longRow.process_group_id.toString(),
        commandDigest: longRow.command_digest,
        spoolLocator: longRow.spool_locator
      }
    });
    await effects.claimEffectDispatch(wrongStop.effectIntentId);
    const refused = await processes.executeDispatchedStop(wrongStop.effectIntentId);
    assert.equal(refused.outcome, 'outcome_unknown');
    assert.equal((await processes.wait(longId, 0)).state, 'running');

    const stopTool = await createTool(ctx, effects, 'process-stop-correct', 'bash');
    const stop = await processes.prepareStop({
      source: source('internal', 'process-stop-correct:prepare'),
      toolCallId: stopTool.toolCallId,
      processId: longId
    });
    const stopResult = await processes.dispatchStop(stop.effectIntentId);
    assert.equal(stopResult.outcome, 'succeeded');
    const stopped = await waitUntilTerminal(processes, longId, 10_000);
    assert.equal(stopped.state, 'exited');
    assert.equal(stopped.receipt.stopRequested, true);
    await processes.reconcileProcessExit(longId);
    const stoppedWakeRequests = [];
    const stoppedDispatcher = new kernel.ProcessCompletionDeliveryControlPlane(
      ctx.database,
      ctx.store,
      processes,
      new kernel.RuntimeDeliveryControlPlane(ctx.database),
      {
        scanIntervalMs: 25,
        wakeHandler: async (request) => {
          stoppedWakeRequests.push(request);
          return { acknowledged: true };
        }
      }
    );
    await stoppedDispatcher.start();
    try {
      const stoppedReceipt = await waitForSingleRow(ctx.database, 'ProcessReceipt', { process_id: longId }, 5_000);
      const stoppedInbox = await waitForSingleRow(ctx.database, 'RuntimeInboxItem', {
        source_kind: 'process_receipt', source_id: stoppedReceipt.id
      }, 5_000);
      const stoppedDelivery = await waitForSingleRow(ctx.database, 'RuntimeDelivery', {
        inbox_item_id: stoppedInbox.id
      }, 5_000);
      await waitForRowState(ctx.database, 'RuntimeDeliveryWake', {
        delivery_id: stoppedDelivery.id
      }, 'acknowledged', 5_000);
      const stoppedOperations = await list(ctx.database, 'Operation', { owner_kind: 'process', owner_id: longId });
      assert.equal(stoppedOperations.filter((operation) => operation.tool_call_id === null).length, 1);
      assert.ok(stoppedOperations.filter((operation) => operation.tool_call_id !== null).length >= 2);
      assert.ok(stoppedWakeRequests.some((request) => request.processId === longId));
    } finally {
      await stoppedDispatcher.dispose();
    }
    assertions.push('错误nonce/fingerprint/group证据拒绝stop且进程仍运行；正确stop附带Operation不阻断独立process_exit完成投递和wake ACK');

    const wrapperCrashTool = await createTool(ctx, effects, 'process-wrapper-crash', 'bash');
    const wrapperCrashPrepared = await processes.prepareStart({
      source: source('internal', 'process-wrapper-crash:prepare'),
      toolCallId: wrapperCrashTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(()=>{},1000)')}`,
      cwd: parent
    });
    await processes.dispatchStart(wrapperCrashPrepared.effect.effectIntentId, 0);
    const wrapperCrashId = wrapperCrashPrepared.request.processId;
    const wrapperCrashRow = await get(ctx.database, 'Process', wrapperCrashId);
    process.kill(Number(wrapperCrashRow.wrapper_pid), 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const wrapperUnknown = await processes.wait(wrapperCrashId, 0);
    assert.equal(wrapperUnknown.state, 'outcome_unknown');
    const persistedUnknown = await processes.reconcileProcessExit(wrapperCrashId);
    assert.equal(persistedUnknown.state, 'outcome_unknown');
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: wrapperCrashId }))[0].outcome, 'outcome_unknown');
    try {
      process.kill(-Number(wrapperCrashRow.process_group_id), 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
    assertions.push('wrapper不可达而child仍存活时不靠裸child PID伪装running，明确并持久化outcome_unknown');

    const stalePointer = JSON.parse(await fs.readFile(ctx.binding.paths.rootPointerPath, 'utf8'));
    stalePointer.rootGeneration += 1;
    stalePointer.pointerRevision += 1;
    const epoch = JSON.parse(await fs.readFile(ctx.binding.paths.runtimeEpochPath, 'utf8'));
    epoch.rootGeneration = stalePointer.rootGeneration;
    await fs.writeFile(ctx.binding.paths.rootPointerPath, `${JSON.stringify(stalePointer)}\n`);
    await fs.writeFile(ctx.binding.paths.runtimeEpochPath, `${JSON.stringify(epoch)}\n`);
    // RootAuthority deliberately reuses a successful validation for one 25ms hot burst. Let that
    // bounded window expire before asserting that the next operation observes the offline switch.
    await delay(50);
    await assert.rejects(processes.readOutputPage(processId), (error) => error?.code === 'stale-root-binding');
    assertions.push('read/wait/stop在25ms热验证窗口过期后重验RootBinding generation，root switch后旧binding fail closed');

    return {
      assertions,
      faults: [
        'controller restart',
        'foreground wait handoff without terminal protocol result',
        'receipt committed before inbox delivery',
        'competing completion delivery scans',
        'wake callback lost across host restart',
        'background completion while conversation idle',
        'valid atomic exit receipt',
        'process_exit effect chain',
        'detached nullable command receipt relation',
        'competing ProcessReceipt reconcile',
        'quick non-zero exit',
        'valid exit receipt without identity file',
        'wrapper crash while child remains',
        'invalid exit tuple',
        'corrupt receipt',
        'stop request vs natural exit race',
        'stop request recovery evidence',
        'stop receipt first-wins',
        'wrong stop evidence',
        'safe process-group stop',
        'stale RootBinding'
      ]
    };
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkProcessWatchdog() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-process-watchdog-'));
  let ctx;
  let recoveryApp;
  try {
    ctx = await createRuntime(parent, 'process-watchdog');
    const assertions = [];
    const effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );

    const legacyReceipt = kernel.parseWrapperExitReceipt({
      kind: kernel.PROCESS_WRAPPER_PROTOCOL,
      processId: 'legacy-process',
      stableNonce: '0'.repeat(32),
      wrapperPid: '1',
      childPid: '2',
      processGroupId: '2',
      startFingerprint: 'legacy-fingerprint',
      commandDigest: '0'.repeat(64),
      exitCode: '0',
      signal: null,
      exitedAt: '2026-01-01T00:00:00.000Z',
      retainedBytes: '0',
      retainedChunks: '0',
      droppedBytes: '0',
      truncated: false,
      stopRequested: false
    });
    assert.equal(legacyReceipt.terminationReason, 'natural');
    assert.equal(legacyReceipt.executionDeadlineAt, null);
    assert.equal(legacyReceipt.maxOutputBytes, null);
    assert.throws(() => kernel.parseWrapperExitReceipt({
      ...legacyReceipt,
      terminationReason: 'timed_out',
      executionDeadlineAt: null,
      maxOutputBytes: 1024
    }), /requires executionDeadlineAt/);
    assertions.push('旧exit receipt合同继续可读；新watchdog receipt拒绝不完整或矛盾的终止证据');

    const timeoutTool = await createTool(ctx, effects, 'process-watchdog-timeout', 'bash');
    const timeoutPrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-timeout:prepare'),
      toolCallId: timeoutTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote('setInterval(()=>{},1000)')}`,
      cwd: parent,
      executionTimeoutMs: 1_000,
      maxOutputBytes: 64 * 1024
    });
    const persistedStartRequest = await effects.readEffectRequest(timeoutPrepared.effect.effectIntentId);
    assert.equal(persistedStartRequest.executionTimeoutMs, 1_000);
    assert.equal(persistedStartRequest.maxOutputBytes, 64 * 1024);
    const timeoutStarted = await processes.dispatchStart(timeoutPrepared.effect.effectIntentId, 5_000);
    assert.equal(timeoutStarted.observation.state, 'completed');
    assert.equal(timeoutStarted.observation.foreground.state, 'exited');
    assert.equal(timeoutStarted.observation.foreground.receipt.terminationReason, 'timed_out');
    assert.equal(timeoutStarted.observation.foreground.receipt.stopRequested, false);
    assert.equal(timeoutStarted.terminal.status, 'failed');
    const timeoutProcess = await get(ctx.database, 'Process', timeoutPrepared.request.processId);
    assert.equal(timeoutProcess.status, 'timed_out');
    const timeoutReceipt = (await list(ctx.database, 'ProcessReceipt', {
      process_id: timeoutPrepared.request.processId
    }))[0];
    assert.equal(timeoutReceipt.outcome, 'timed_out');
    const timeoutOutcome = (await list(ctx.database, 'ToolOutcome', { tool_call_id: timeoutTool.toolCallId }))[0];
    const timeoutOutcomeMetadata = await get(ctx.database, 'ContentObject', timeoutOutcome.content_object_id);
    const timeoutModelResult = JSON.parse((await ctx.store.read(timeoutOutcomeMetadata)).toString('utf8'));
    assert.equal(timeoutModelResult.detail.status, 'timed_out');
    assert.equal(timeoutModelResult.detail.terminationReason, 'timed_out');
    const timeoutExit = timeoutStarted.observation.foreground.receipt;
    assert.equal(timeoutExit.maxOutputBytes, 64 * 1024);
    assert.equal(typeof timeoutExit.executionDeadlineAt, 'string');
    assert.ok(Date.parse(timeoutExit.exitedAt) >= Date.parse(timeoutExit.executionDeadlineAt));
    await assert.rejects(
      fs.access(kernel.processSpoolPath(ctx.binding, timeoutPrepared.request.spoolLocator)),
      (error) => error?.code === 'ENOENT'
    );
    assertions.push('foregroundWaitMs仍只控制前台等待；独立execution deadline在前台命令上形成timed_out终态和直接模型结果');

    const outputTool = await createTool(ctx, effects, 'process-watchdog-output', 'bash');
    const outputPrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-output:prepare'),
      toolCallId: outputTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write(Buffer.alloc(1024*1024,120));setInterval(()=>{},1000)")}`,
      cwd: parent,
      executionTimeoutMs: 10_000,
      maxOutputBytes: 1_024
    });
    const outputStarted = await processes.dispatchStart(outputPrepared.effect.effectIntentId, 15_000);
    const outputExit = outputStarted.observation.foreground.receipt;
    assert.equal(outputExit.terminationReason, 'output_limit_exceeded');
    assert.equal(outputStarted.terminal.status, 'failed');
    assert.equal((await get(ctx.database, 'Process', outputPrepared.request.processId)).status, 'output_limit_exceeded');
    assert.equal((await list(ctx.database, 'ProcessReceipt', {
      process_id: outputPrepared.request.processId
    }))[0].outcome, 'output_limit_exceeded');
    assert.ok(BigInt(outputExit.retainedBytes) <= 1_024n);
    assert.ok(BigInt(outputExit.droppedBytes) > 0n);
    assert.equal(outputExit.truncated, true);
    const outputPage = await processes.readOutputPage(outputPrepared.request.processId);
    assert.ok(BigInt(outputPage.retainedBytes) <= 1_024n);
    assert.ok(BigInt(outputPage.droppedBytes) > 0n);
    assertions.push('stdout+stderr达到maxOutputBytes后只保留限额内字节、记录丢弃量并以output_limit_exceeded终止');

    const manualTool = await createTool(ctx, effects, 'process-watchdog-manual', 'bash');
    const manualPrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-manual:prepare'),
      toolCallId: manualTool.toolCallId,
      command: "trap '' TERM; while :; do sleep 1; done",
      cwd: parent,
      executionTimeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    });
    await processes.dispatchStart(manualPrepared.effect.effectIntentId, 0);
    await delay(100);
    const manualStop = await processes.stopOwnedProcess(manualPrepared.request.processId);
    assert.equal(manualStop.state, undefined);
    assert.equal(manualStop.receipt.terminationReason, 'manual');
    assert.equal(manualStop.receipt.signal, 'SIGKILL');
    await processes.reconcileProcessExit(manualPrepared.request.processId);
    assert.equal((await get(ctx.database, 'Process', manualPrepared.request.processId)).status, 'cancelled');
    assertions.push('手工kill复用TERM→宽限期→SIGKILL，忽略SIGTERM的进程组也能可靠收敛');

    const descendantPidPath = path.join(parent, 'watchdog-descendant.pid');
    const descendantCode = [
      "const fs=require('node:fs')",
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid))`,
      "process.on('SIGTERM',()=>process.exit(0))",
      'setInterval(()=>{},1000)'
    ].join(';');
    const descendantTool = await createTool(ctx, effects, 'process-watchdog-descendant', 'bash');
    const descendantPrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-descendant:prepare'),
      toolCallId: descendantTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(descendantCode)}`,
      cwd: parent,
      executionTimeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    });
    await processes.dispatchStart(descendantPrepared.effect.effectIntentId, 0);
    const descendantPid = await waitForPidFile(descendantPidPath, 2_000);
    const descendantFingerprint = kernel.readLinuxStartFingerprint(descendantPid);
    const descendantStop = await processes.stopOwnedProcess(descendantPrepared.request.processId);
    assert.equal(descendantStop.receipt.terminationReason, 'manual');
    await waitForFingerprintGone(descendantPid, descendantFingerprint, 3_000);
    await processes.reconcileProcessExit(descendantPrepared.request.processId);
    assertions.push('进程组leader在SIGTERM后先退出时，wrapper仍等待宽限期并以birth-witness围栏SIGKILL残留后代');

    const raceTool = await createTool(ctx, effects, 'process-watchdog-race', 'bash');
    const racePrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-race:prepare'),
      toolCallId: raceTool.toolCallId,
      command: "trap '' TERM; while :; do sleep 1; done",
      cwd: parent,
      executionTimeoutMs: 1_000,
      maxOutputBytes: 64 * 1024
    });
    await processes.dispatchStart(racePrepared.effect.effectIntentId, 0);
    await delay(1_200);
    const raceStop = await processes.stopOwnedProcess(racePrepared.request.processId);
    assert.equal(raceStop.receipt.terminationReason, 'timed_out');
    assert.equal(raceStop.receipt.stopRequested, false);
    assert.equal(raceStop.receipt.signal, 'SIGKILL');
    await processes.reconcileProcessExit(racePrepared.request.processId);
    assert.equal((await list(ctx.database, 'ProcessReceipt', {
      process_id: racePrepared.request.processId
    }))[0].outcome, 'timed_out');
    assertions.push('deadline与迟到手工stop竞争时第一个终止原因first-wins，迟到请求不能把timed_out改写为cancelled');

    const restartTool = await createTool(ctx, effects, 'process-watchdog-restart', 'bash');
    const restartPrepared = await processes.prepareStart({
      source: source('internal', 'process-watchdog-restart:prepare'),
      toolCallId: restartTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setInterval(()=>process.stdout.write('still-running\\n'),200)")}`,
      cwd: parent,
      executionTimeoutMs: 1_500,
      maxOutputBytes: 64 * 1024
    });
    const restartStarted = await processes.dispatchStart(restartPrepared.effect.effectIntentId, 0);
    assert.equal(restartStarted.observation.state, 'background_started');
    const restartProcessId = restartPrepared.request.processId;
    const restartSpoolPath = kernel.processSpoolPath(ctx.binding, restartPrepared.request.spoolLocator);
    await processes.dispose();
    await ctx.database.close();
    ctx.database = undefined;
    const atomicRestartReceipt = kernel.parseWrapperExitReceipt(JSON.parse(await waitForTextFile(
      path.join(restartSpoolPath, kernel.PROCESS_WRAPPER_EXIT_RECEIPT_FILE),
      5_000
    )));
    assert.equal(atomicRestartReceipt.terminationReason, 'timed_out');

    recoveryApp = await kernel.ReliableKernelApplication.open(
      ctx.authority,
      phaseDApplicationDependencies()
    );
    await recoveryApp.recover();
    const recoveredProcess = await waitForPersistedProcessStatus(
      recoveryApp.database,
      restartProcessId,
      new Set(['timed_out']),
      5_000
    );
    assert.equal(recoveredProcess.status, 'timed_out');
    const recoveredReceipt = await waitForSingleRow(
      recoveryApp.database,
      'ProcessReceipt',
      { process_id: restartProcessId },
      5_000
    );
    assert.equal(recoveredReceipt.outcome, 'timed_out');
    const completionInbox = await waitForSingleRow(
      recoveryApp.database,
      'RuntimeInboxItem',
      { source_kind: 'process_receipt', source_id: recoveredReceipt.id },
      5_000
    );
    const completionLink = (await list(recoveryApp.database, 'RuntimeInboxPayloadLink', {
      inbox_item_id: completionInbox.id
    }))[0];
    const completionMetadata = await get(
      recoveryApp.database,
      'ContentObject',
      completionLink.content_object_id
    );
    const completionPayload = JSON.parse((await recoveryApp.contentStore.read(completionMetadata)).toString('utf8'));
    assert.equal(completionPayload.kind, 'process_completion');
    assert.equal(completionPayload.outcome, 'timed_out');
    assert.equal(completionPayload.terminationReason, 'timed_out');
    assert.equal(completionPayload.processId, restartProcessId);
    await Promise.all([
      recoveryApp.processDeliveries.scanNow(),
      recoveryApp.processDeliveries.scanNow()
    ]);
    assert.equal((await list(recoveryApp.database, 'ProcessReceipt', { process_id: restartProcessId })).length, 1);
    assert.equal((await list(recoveryApp.database, 'RuntimeInboxItem', {
      source_kind: 'process_receipt', source_id: recoveredReceipt.id
    })).length, 1);
    assertions.push('Extension Host和数据库关闭期间wrapper仍按绝对deadline终止；恢复后唯一ProcessReceipt与process_completion主动通知补齐且不重跑命令');

    return {
      assertions,
      faults: [
        'legacy wrapper receipt replay',
        'foreground wait vs execution deadline',
        'output flood',
        'SIGTERM ignored',
        'manual stop escalation',
        'process-group leader exits before grace',
        'deadline vs manual stop race',
        'extension host restart before deadline',
        'receipt-before-completion recovery',
        'competing completion scans'
      ]
    };
  } finally {
    if (recoveryApp) await recoveryApp.close().catch(() => undefined);
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkProcessOutputBounds() {
  return withRuntime('process-output', async (ctx) => {
    const assertions = [];
    const effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );

    const inlineTool = await createTool(ctx, effects, 'process-inline-output', 'bash');
    const inlinePrepared = await processes.prepareStart({
      source: source('internal', 'process-inline-output:prepare'),
      toolCallId: inlineTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('inline-stdout');process.stderr.write('inline-stderr')")}`,
      cwd: ctx.parent
    });
    const inlineStarted = await processes.dispatchStart(inlinePrepared.effect.effectIntentId, 5_000);
    assert.ok(inlineStarted.terminal, 'foreground completion must finalize the originating Bash ToolCall');
    const inlineOutcome = (await list(ctx.database, 'ToolOutcome', { tool_call_id: inlineTool.toolCallId }))[0];
    const inlineContent = await get(ctx.database, 'ContentObject', inlineOutcome.content_object_id);
    const inlineBody = JSON.parse((await ctx.store.read(inlineContent)).toString('utf8'));
    assert.equal(inlineBody.detail.stdout, 'inline-stdout');
    assert.equal(inlineBody.detail.stderr, 'inline-stderr');
    assert.equal(inlineBody.detail.complete, true);
    assert.equal(Object.hasOwn(inlineBody.detail, 'nextOutputHandle'), false);
    assert.equal(Object.hasOwn(inlineBody.detail, 'operations'), false);
    assert.equal((await list(ctx.database, 'ToolResultArtifact', {
      tool_call_id: inlineTool.toolCallId,
      role: 'model_response'
    })).length, 1);
    assertions.push('前台Bash在原始execute ToolModelResult内直接返回stdout/stderr，无需第二次output调用');

    const modelDetailCrashTool = await createTool(ctx, effects, 'process-model-detail-crash', 'bash');
    const modelDetailCrashPrepared = await processes.prepareStart({
      source: source('internal', 'process-model-detail-crash:prepare'),
      toolCallId: modelDetailCrashTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('crash-recovered-output')")}`,
      cwd: ctx.parent
    });
    const originalRecordToolModelDetail = effects.recordToolModelDetail.bind(effects);
    effects.recordToolModelDetail = async () => { throw new Error('fault-before-process-model-detail'); };
    try {
      await assert.rejects(
        processes.dispatchStart(modelDetailCrashPrepared.effect.effectIntentId, 5_000),
        /fault-before-process-model-detail/
      );
    } finally {
      effects.recordToolModelDetail = originalRecordToolModelDetail;
    }
    const crashAttempts = await list(ctx.database, 'Attempt', {
      operation_id: modelDetailCrashPrepared.effect.operationId
    });
    const crashReceipts = await list(ctx.database, 'EffectReceipt', { attempt_id: crashAttempts[0].id });
    assert.equal(crashReceipts.length, 1);
    assert.equal((await get(ctx.database, 'Operation', modelDetailCrashPrepared.effect.operationId)).status, 'succeeded');
    await effects.finalizeReadyInOrder(ctx.turnId);
    assert.equal((await list(ctx.database, 'ToolModelResult', {
      tool_call_id: modelDetailCrashTool.toolCallId
    })).length, 0, 'process_start without model_response must not be finalized by a competing finalizer');
    const crashRecoveredTerminal = await processes.reconcileStartReceipt(crashReceipts[0].id);
    assert.ok(crashRecoveredTerminal);
    const crashOutcome = (await list(ctx.database, 'ToolOutcome', {
      tool_call_id: modelDetailCrashTool.toolCallId
    }))[0];
    const crashContent = await get(ctx.database, 'ContentObject', crashOutcome.content_object_id);
    const crashBody = JSON.parse((await ctx.store.read(crashContent)).toString('utf8'));
    assert.equal(crashBody.detail.stdout, 'crash-recovered-output');
    assertions.push('process Operation提交后、model_response前崩溃时普通finalizer保持阻塞，reconcile重放补齐内联输出且不重跑命令');

    const liveTailTool = await createTool(ctx, effects, 'process-live-tail', 'bash');
    const liveTailPrepared = await processes.prepareStart({
      source: source('internal', 'process-live-tail:prepare'),
      toolCallId: liveTailTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('abc');setTimeout(()=>process.exit(0),1200)")}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(liveTailPrepared.effect.effectIntentId);
    await delay(350);
    const liveTailRead = await processes.readOutputPage(liveTailPrepared.request.processId);
    assert.equal(liveTailRead.stdout, '');
    assert.equal(liveTailRead.liveStdout, 'abc');
    assert.equal(liveTailRead.livePreviewBytes, '3');
    assert.equal(liveTailRead.retainedBytes, '0');
    assert.equal(liveTailRead.retainedChunks, '0');
    assert.equal(liveTailRead.complete, false);
    await waitUntilTerminal(processes, liveTailPrepared.request.processId, 5_000);
    await processes.reconcileProcessExit(liveTailPrepared.request.processId);
    assertions.push('运行中live tail只进入不推进outputHandle的观察字段，正式retained前缀保持可重复遍历且读取不消费tail');

    const liveImportTool = await createTool(ctx, effects, 'process-live-import', 'bash');
    const liveImportCode = "let i=0;const t=setInterval(()=>{process.stdout.write('y'.repeat(70000));if(++i===30){clearInterval(t);}},15)";
    const liveImportPrepared = await processes.prepareStart({
      source: source('internal', 'process-live-import:prepare'),
      toolCallId: liveImportTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(liveImportCode)}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(liveImportPrepared.effect.effectIntentId);
    for (let index = 0; index < 8; index += 1) {
      await delay(60);
      await processes.reconcileOutput(liveImportPrepared.request.processId);
    }
    await waitUntilTerminal(processes, liveImportPrepared.request.processId, 10_000);
    await processes.reconcileProcessExit(liveImportPrepared.request.processId);
    await processes.reconcileOutput(liveImportPrepared.request.processId);
    assertions.push('wrapper持续追加输出时reconcile只导入manifest已发布稳定前缀，不把正常并发误报为完整性损坏');

    const staleTool = await createTool(ctx, effects, 'process-stale-output', 'bash');
    const staleCode = "process.stdout.write('a'.repeat(70000));setTimeout(()=>{process.stdout.write('b'.repeat(1000000));},900)";
    const stalePrepared = await processes.prepareStart({
      source: source('internal', 'process-stale-output:prepare'),
      toolCallId: staleTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(staleCode)}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(stalePrepared.effect.effectIntentId);
    await delay(350);
    const originalTransaction = ctx.database.transaction.bind(ctx.database);
    let injectedTerminal;
    let injectedStaleCommit = false;
    ctx.database.transaction = async (steps) => {
      const target = !injectedStaleCommit && steps.some((step) =>
        step.kind === 'assert' && step.domain === 'Process' && step.id === stalePrepared.request.processId
      );
      if (!target) return originalTransaction(steps);
      injectedStaleCommit = true;
      ctx.database.transaction = originalTransaction;
      injectedTerminal = await waitUntilTerminal(processes, stalePrepared.request.processId, 10_000);
      await processes.reconcileProcessExit(stalePrepared.request.processId);
      return originalTransaction(steps);
    };
    try {
      await processes.reconcileOutput(stalePrepared.request.processId);
    } finally {
      ctx.database.transaction = originalTransaction;
    }
    assert.equal(injectedTerminal.state, 'exited');
    const staleRow = await get(ctx.database, 'Process', stalePrepared.request.processId);
    assert.equal(staleRow.retained_bytes.toString(), injectedTerminal.receipt.retainedBytes);
    assert.equal(staleRow.dropped_bytes.toString(), injectedTerminal.receipt.droppedBytes);
    assert.equal(staleRow.truncated === 1n, injectedTerminal.receipt.truncated);
    await processes.reconcileOutput(stalePrepared.request.processId);
    assertions.push('旧manifest导入事务与exit并发时由Process状态/计数断言回滚，不能倒退终态计数');

    const missingSpoolTool = await createTool(ctx, effects, 'process-missing-spool', 'bash');
    const missingSpoolPrepared = await processes.prepareStart({
      source: source('internal', 'process-missing-spool:prepare'),
      toolCallId: missingSpoolTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>process.stdout.write('retained-body'),500)")}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(missingSpoolPrepared.effect.effectIntentId);
    await waitUntilTerminal(processes, missingSpoolPrepared.request.processId, 5_000);
    await processes.reconcileProcessExit(missingSpoolPrepared.request.processId);
    const missingProcessRow = await get(ctx.database, 'Process', missingSpoolPrepared.request.processId);
    const missingSpoolPath = kernel.processSpoolPath(ctx.binding, missingProcessRow.spool_locator);
    const missingChunkRoot = path.join(missingSpoolPath, kernel.PROCESS_WRAPPER_CHUNKS_DIRECTORY);
    for (const name of await fs.readdir(missingChunkRoot)) await fs.unlink(path.join(missingChunkRoot, name));
    await assert.rejects(processes.reconcileOutput(missingSpoolPrepared.request.processId), /exactly one stream file/);
    assertions.push('CAS尚未登记且spool chunk缺失时read_output明确报完整性错误，不返回空正文配完整计数');

    const tool = await createTool(ctx, effects, 'process-output', 'bash');
    const payloadBytes = 17 * 1024 * 1024;
    const terminalMarker = 'TERMINAL-TAIL-MARKER\n';
    const code = `process.stdout.write('x'.repeat(${payloadBytes}));process.stdout.write('TERMINAL-TAIL-MARKER\\n')`;
    const prepared = await processes.prepareStart({
      source: source('internal', 'process-output:prepare'),
      toolCallId: tool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`,
      cwd: ctx.parent
    });
    const started = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(started.observation.outcome, 'succeeded');
    const processId = prepared.request.processId;
    const exited = await waitUntilTerminal(processes, processId, 20_000);
    assert.equal(exited.state, 'exited', '大量输出必须持续drain并真实退出，不能因停止读取而阻塞');
    assert.equal(exited.receipt.truncated, false);
    assert.equal(exited.receipt.droppedBytes, '0');
    assert.equal(BigInt(exited.receipt.retainedBytes), BigInt(payloadBytes + Buffer.byteLength(terminalMarker)));
    assert.ok(BigInt(exited.receipt.retainedBytes) > 4n * 1024n * 1024n);
    assert.ok(BigInt(exited.receipt.retainedChunks) > 256n);
    assertions.push('超过4MiB且超过256 chunk后仍持续按序落spool，原始输出不再被丢弃');

    const originalOutputTransaction = ctx.database.transaction.bind(ctx.database);
    const outputTransactionWireBytes = [];
    ctx.database.transaction = async (steps) => {
      if (steps.some((step) => step.kind === 'insert' && step.domain === 'ProcessOutputChunk')) {
        outputTransactionWireBytes.push(Buffer.byteLength(JSON.stringify({ kind: 'transaction', steps }, (_key, value) => (
          typeof value === 'bigint' ? value.toString() : value
        )), 'utf8'));
      }
      return originalOutputTransaction(steps);
    };
    let concurrentOutput;
    try {
      concurrentOutput = await Promise.all([
        processes.reconcileOutput(processId),
        processes.reconcileOutput(processId)
      ]);
    } finally {
      ctx.database.transaction = originalOutputTransaction;
    }
    assert.ok(outputTransactionWireBytes.length > 0);
    assert.ok(outputTransactionWireBytes.every((bytes) => bytes <= kernel.PROCESS_OUTPUT_TRANSACTION_MAX_WIRE_BYTES));
    const reconciled = concurrentOutput[0];
    assert.ok(concurrentOutput.every((entry) => entry.retainedBytes === BigInt(exited.receipt.retainedBytes)));
    assert.ok(concurrentOutput.every((entry) => entry.retainedChunks === BigInt(exited.receipt.retainedChunks)));
    const chunks = await list(ctx.database, 'ProcessOutputChunk', { process_id: processId });
    assert.equal(BigInt(chunks.length), reconciled.retainedChunks);
    assert.ok(chunks.every((row) => row.byte_length <= BigInt(kernel.PROCESS_OUTPUT_MAX_CHUNK_BYTES)));
    assert.equal(
      (await ctx.database.processOutputRegistrationMismatches()).some((entry) => entry.processId === processId),
      false
    );
    assert.ok(chunks.every((row) => typeof row.chunk_seq === 'bigint'));
    const casBefore = (await list(ctx.database, 'ContentObject', {})).length;
    const secondReconcile = await processes.reconcileOutput(processId);
    assert.equal(secondReconcile.insertedChunks, 0);
    assert.equal((await list(ctx.database, 'ContentObject', {})).length, casBefore);
    assertions.push('并发ProcessOutput reconcile精确收敛；登记事务逐笔受wire bytes约束并持续到全部chunk metadata入SQLite、正文入CAS，重复reconcile不再增长');

    const processRow = await get(ctx.database, 'Process', processId);
    const spoolPath = kernel.processSpoolPath(ctx.binding, processRow.spool_locator);
    const chunkDirectory = path.join(spoolPath, kernel.PROCESS_WRAPPER_CHUNKS_DIRECTORY);
    for (const name of await fs.readdir(chunkDirectory)) {
      await fs.unlink(path.join(chunkDirectory, name));
    }
    const afterSpoolLoss = await processes.reconcileOutput(processId);
    assert.equal(afterSpoolLoss.retainedChunks, reconciled.retainedChunks);
    assert.equal((await list(ctx.database, 'ProcessOutputChunk', { process_id: processId })).length, chunks.length);
    await processes.reconcileProcessExit(processId);

    const firstPage = await processes.readOutputPage(processId);
    const replayedFirstPage = await processes.readOutputPage(processId);
    assert.deepEqual(firstPage, replayedFirstPage);
    assert.ok(firstPage.hasMore, 'large process output must expose a continuation handle');
    assert.ok(Number(firstPage.pageBytes) <= kernel.PROCESS_OUTPUT_READ_PAGE_MAX_BYTES);
    const strictInlinePage = await processes.readOutputPage(
      processId,
      undefined,
      kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES
    );
    assert.equal(Number(strictInlinePage.pageBytes), kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES);
    assert.equal(Buffer.byteLength(strictInlinePage.stdout, 'utf8'), kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES);
    assert.equal(strictInlinePage.hasMore, true);
    const strictInlineContinuation = await processes.readOutputPage(
      processId,
      strictInlinePage.nextOutputHandle,
      kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES
    );
    assert.equal(Number(strictInlineContinuation.pageBytes), kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES);
    assert.equal(Buffer.byteLength(strictInlineContinuation.stdout, 'utf8'), kernel.PROCESS_START_INLINE_OUTPUT_MAX_BYTES);
    assertions.push('初始Bash输出严格限制为16KiB且continuation可从chunk内字节偏移无重叠续读');
    let outputHandle;
    let totalStdoutBytes = 0;
    let totalStderrBytes = 0;
    let pageCount = 0;
    let stdoutTail = '';
    const originalReadReconcile = processes.reconcileOutput.bind(processes);
    let readReconcileCount = 0;
    processes.reconcileOutput = async (...args) => {
      readReconcileCount += 1;
      return originalReadReconcile(...args);
    };
    try {
      for (;;) {
        await processes.reconcileOutputForRead(processId, outputHandle);
        const page = await processes.readOutputPage(processId, outputHandle);
        pageCount += 1;
        totalStdoutBytes += Buffer.byteLength(page.stdout, 'utf8');
        totalStderrBytes += Buffer.byteLength(page.stderr, 'utf8');
        stdoutTail = `${stdoutTail}${page.stdout}`.slice(-128);
        outputHandle = page.nextOutputHandle;
        if (!page.hasMore) {
          assert.equal(page.complete, true);
          assert.equal(page.truncated, false);
          assert.equal(page.droppedBytes, '0');
          break;
        }
      }
    } finally {
      processes.reconcileOutput = originalReadReconcile;
    }
    assert.equal(readReconcileCount, 1, 'terminal continuation handles must not rescan immutable history');
    assert.ok(pageCount > 1);
    assert.match(stdoutTail, /TERMINAL-TAIL-MARKER/);
    assert.equal(totalStdoutBytes, payloadBytes + Buffer.byteLength(terminalMarker));
    assert.equal(totalStderrBytes, 0);
    const exhausted = await processes.readOutputPage(processId, outputHandle);
    assert.equal(exhausted.stdout, '');
    assert.equal(exhausted.stderr, '');
    assert.equal(exhausted.hasMore, false);
    assert.equal(exhausted.complete, true);
    const completionTail = await processes.readOutputTail(processId, 8_000);
    assert.ok(completionTail.stdout.byteLength <= 8_000);
    assert.ok(completionTail.stderr.byteLength <= 8_000);
    assert.match(completionTail.stdout.toString('utf8'), /TERMINAL-TAIL-MARKER/);
    assertions.push('read_output以opaque handle从SQLite/CAS分页面完整遍历；spool丢失后不消费历史、不缩小计数，也不一次Buffer.concat全历史；completion tail反向keyset读取且只驻留所需尾部');

    return {
      assertions,
      faults: ['single-call foreground output', 'model-response crash recovery', 'strict inline pagination', 'live tail accounting', 'live writer/import race', 'stale output commit after exit', 'spool loss before CAS import', 'sustained output beyond former retention bounds', 'continued drain', 'competing ProcessOutput reconcile', 'CAS/SQLite growth convergence', 'spool loss after CAS import', 'repeatable read_output', 'terminal tail']
    };
  });
}

async function checkHangingEffectRecovery() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-hanging-'));
  let ctx;
  try {
    ctx = await createRuntime(parent, 'hanging');
    const assertions = [];
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    // The dispatch fence must capture the actually live Host. Rewriting the lease only after the
    // dispatch would represent a successor owner and must no longer keep the old effect in-flight.
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').update('lease-hanging', {
        host_boot_id: ctx.database.hostBootId
      })
    ]);
    const boundary = (id) => id === 'workspace' ? { id, rootPath: workspace } : undefined;
    let effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    let files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    let mcpCalls = 0;
    let mcp = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations() { return {}; },
      async callTool() { mcpCalls += 1; return { executed: true }; }
    }, allowMcpPolicy());
    let processes = new kernel.ProcessControlPlane(ctx.database, ctx.store, effects, ctx.authority, ctx.binding);

    const fileTool = await createTool(ctx, effects, 'hanging-file', 'write');
    const proposal = await files.propose({
      source: source('internal', 'hanging-file:proposal'),
      toolCallId: fileTool.toolCallId,
      members: [{ operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'recovered.txt', targetContent: 'recovered' }]
    });
    const approval = await files.decide({
      source: source('command', 'hanging-file:approve'), changeSetId: proposal.changeSetId, decision: 'approved'
    });
    const fileDispatcher = new kernel.FileMutationDispatcher(ctx.database, ctx.store, effects, boundary);
    await effects.claimEffectDispatch(approval.preparedEffect.effectIntentId);
    const fileObservation = await fileDispatcher.executeDispatched(approval.preparedEffect.effectIntentId);
    assert.equal(fileObservation.outcome, 'succeeded');
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: approval.preparedEffect.attemptId })).length, 0);

    const mcpTool = await createTool(ctx, effects, 'hanging-mcp', 'mcp');
    const mcpPrepared = await mcp.prepare({
      source: source('internal', 'hanging-mcp:prepare'), toolCallId: mcpTool.toolCallId,
      serverId: 'fake', toolName: 'lost', arguments: {}
    });
    await effects.claimEffectDispatch(mcpPrepared.effectIntentId);
    await mcp.executeDispatched(mcpPrepared.effectIntentId);
    assert.equal(mcpCalls, 1);

    const transferTool = await createTool(ctx, effects, 'hanging-transfer', 'transfer');
    const transfers = new kernel.WorkEnvironmentTransferEffectDispatcher(ctx.database, effects);
    const transferPrepared = await transfers.prepare({
      source: source('internal', 'hanging-transfer:prepare'),
      toolCallId: transferTool.toolCallId,
      authoritySnapshotId: 'authority-hanging-transfer',
      arguments: {
        transfers: [{
          fromEnvironment: 'workspace', fromPath: 'source.txt',
          toEnvironment: 'workspace', toPath: 'transfer-recovered.txt'
        }]
      }
    });
    await effects.claimEffectDispatch(transferPrepared.effectIntentId);
    await fs.writeFile(path.join(workspace, 'transfer-recovered.txt'), 'already-written-before-crash', 'utf8');
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: transferPrepared.attemptId })).length, 0);

    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').update('lease-hanging', {
        host_boot_id: ctx.database.hostBootId
      })
    ]);
    const liveScanner = new kernel.PhaseDRecoveryScanner(
      ctx.database, effects, files, processes, mcp, boundary, recoveryTurns(ctx, files)
    );
    const liveResult = await liveScanner.run('recovery.effect-intent-hanging');
    assert.equal(liveResult.scanned, 3);
    assert.equal(liveResult.reconciled, 0);
    assert.equal(liveResult.unknown, 0);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: mcpPrepared.attemptId })).length, 0);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: approval.preparedEffect.attemptId })).length, 0);
    assert.equal((await list(ctx.database, 'EffectReceipt', { attempt_id: transferPrepared.attemptId })).length, 0);
    assertions.push('并发Host恢复扫描识别存活Turn租约，跳过其三种in-flight外部Effect且不伪造unknown');

    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').update('lease-hanging', {
        host_boot_id: 'host-hanging-dead'
      })
    ]);

    await ctx.database.close();
    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'hanging-reopen' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    let recoveredMcpCalls = 0;
    mcp = new kernel.McpEffectDispatcher(ctx.database, effects, {
      async toolAnnotations() { return {}; },
      async callTool() { recoveredMcpCalls += 1; return {}; }
    }, allowMcpPolicy());
    processes = new kernel.ProcessControlPlane(ctx.database, ctx.store, effects, ctx.authority, ctx.binding);
    const scanner = new kernel.PhaseDRecoveryScanner(
      ctx.database, effects, files, processes, mcp, boundary, recoveryTurns(ctx, files)
    );
    assert.deepEqual(scanner.ids(), [
      'recovery.effect-intent-hanging',
      'recovery.file-change-unresolved'
    ]);
    const result = await scanner.run('recovery.effect-intent-hanging');
    assert.equal(result.reconciled, 3);
    assert.equal(recoveredMcpCalls, 0);
    assert.equal((await effects.readTerminalResult(fileTool.toolCallId, true)).status, 'succeeded');
    assert.equal((await effects.readTerminalResult(mcpTool.toolCallId, true)).status, 'outcome_unknown');
    assert.equal((await effects.readTerminalResult(transferTool.toolCallId, true)).status, 'outcome_unknown');
    assert.equal(await fs.readFile(path.join(workspace, 'transfer-recovered.txt'), 'utf8'), 'already-written-before-crash');
    assertions.push('真实重开数据库扫描file摘要可证明成功；MCP与file_transfer不可查询均落unknown且不redispatch');

    const before = await counts(ctx.database, ['EffectReceipt', 'ToolOutcome', 'ToolModelResult']);
    const replay = await scanner.run('recovery.effect-intent-hanging');
    assert.equal(replay.reconciled, 0);
    assert.deepEqual(await counts(ctx.database, ['EffectReceipt', 'ToolOutcome', 'ToolModelResult']), before);
    assertions.push('重复恢复扫描不产生第二Receipt/Outcome/ModelResult');

    const workEnvironmentDefinitions = [
      phaseDRuntimeDefinition('transfer'),
      phaseDRuntimeDefinition('switch_work_environment'),
      phaseDRuntimeDefinition('read')
    ];
    await attachWorkEnvironmentAuthority(ctx, ctx.turnId, 'disabled-work-environment-authority', false);
    const interactions = new kernel.ToolInteractionControlPlane(ctx.database, ctx.store, effects);
    const reliableTools = new kernel.ReliableToolDispatcher({
      database: ctx.database,
      contentStore: ctx.store,
      effects,
      files,
      fileMutations: new kernel.FileMutationDispatcher(ctx.database, ctx.store, effects, boundary),
      processes,
      mcp,
      interactions,
      host: {
        definitions() { return workEnvironmentDefinitions; },
        async executeNoEffect() { return { ok: true, output: null }; }
      }
    });
    const disabledNames = new Set((await reliableTools.definitions(ctx.turnId)).map((entry) => entry.name));
    assert.equal(disabledNames.has('read'), true);
    assert.equal(disabledNames.has('transfer'), false);
    assert.equal(disabledNames.has('switch_work_environment'), false);
    const staleTransferCall = await effects.createToolCall({
      source: source('internal', 'disabled-work-environment:stale-transfer:create'),
      toolCallId: 'tool-call-disabled-work-environment-transfer',
      turnId: ctx.turnId,
      toolName: 'transfer',
      arguments: {
        transfers: [{
          fromEnvironment: 'workspace', fromPath: 'source.txt',
          toEnvironment: 'workspace', toPath: 'must-not-exist.txt'
        }]
      }
    });
    const staleTransfer = await reliableTools.dispatch({
      turnId: ctx.turnId,
      modelRequestId: 'model-disabled-work-environment',
      toolCallId: staleTransferCall.toolCallId,
      toolName: 'transfer',
      arguments: {
        transfers: [{
          fromEnvironment: 'workspace', fromPath: 'source.txt',
          toEnvironment: 'workspace', toPath: 'must-not-exist.txt'
        }]
      }
    });
    assert.equal(staleTransfer.status, 'rejected');
    assert.equal(await exists(path.join(workspace, 'must-not-exist.txt')), false);
    assertions.push('Turn冻结WorkEnvironmentPolicy.enabled=false时recipe隐藏transfer/switch，旧模型调用也持久rejected且无外部写入');

    const enabledTurn = await createAdditionalTurn(ctx, 'enabled-work-environment-boundary');
    await attachWorkEnvironmentAuthority(ctx, enabledTurn.turnId, 'enabled-work-environment-authority', true);
    const enabledNames = new Set((await reliableTools.definitions(enabledTurn.turnId)).map((entry) => entry.name));
    assert.equal(enabledNames.has('transfer'), true);
    assert.equal(enabledNames.has('switch_work_environment'), true);
    const sameSwitch = await createAndDispatchPhaseDTool(
      effects,
      reliableTools,
      enabledTurn.turnId,
      'switch-same',
      'switch_work_environment',
      { workEnvironmentId: 'workspace' }
    );
    assert.equal(sameSwitch.status, 'succeeded');
    const effectCountBeforeCrossSwitch = (await list(ctx.database, 'EffectIntent', {})).length;
    const crossSwitch = await createAndDispatchPhaseDTool(
      effects,
      reliableTools,
      enabledTurn.turnId,
      'switch-cross',
      'switch_work_environment',
      { workEnvironmentId: 'workspace-alternate' }
    );
    assert.equal(crossSwitch.status, 'rejected');
    assert.equal((await list(ctx.database, 'EffectIntent', {})).length, effectCountBeforeCrossSwitch);
    assertions.push('enabled Turn中同环境switch幂等成功；跨环境switch因authority不可变而明确rejected，不伪成功、不建外部Effect');

    return {
      assertions,
      faults: ['file action executed callback lost', 'MCP callback lost', 'file transfer callback lost', 'database reopen', 'no redispatch', 'repeat recovery scan']
    };
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function checkUnresolvedFileRecovery() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase-d-unresolved-'));
  let ctx;
  try {
    ctx = await createRuntime(parent, 'unresolved');
    const assertions = [];
    let effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    let files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    const tool = await createTool(ctx, effects, 'unresolved-file', 'write');
    const workspace = path.join(parent, 'workspace');
    await fs.mkdir(workspace);
    const proposal = await files.propose({
      source: source('internal', 'unresolved:proposal'),
      toolCallId: tool.toolCallId,
      members: [{ operation: 'create_file', workEnvironmentId: 'workspace', targetPath: 'never.txt', targetContent: 'never' }]
    });
    await ctx.database.close();

    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'unresolved-reopen' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    files = new kernel.FileChangeControlPlane(ctx.database, ctx.store, effects);
    const mcp = new kernel.McpEffectDispatcher(
      ctx.database,
      effects,
      { async toolAnnotations() { return {}; }, async callTool() { throw new Error('not used'); } },
      allowMcpPolicy()
    );
    const processes = new kernel.ProcessControlPlane(ctx.database, ctx.store, effects, ctx.authority, ctx.binding);
    const scanner = new kernel.PhaseDRecoveryScanner(
      ctx.database,
      effects,
      files,
      processes,
      mcp,
      (id) => id === 'workspace' ? { id, rootPath: workspace } : undefined,
      recoveryTurns(ctx, files)
    );
    const commits = [];
    const unsubscribe = ctx.database.onCommit((commit) => commits.push(commit));
    const result = await scanner.run('recovery.file-change-unresolved');
    unsubscribe();
    assert.equal(result.reconciled, 1);
    const decision = (await list(ctx.database, 'FileChangeDecision', { change_set_id: proposal.changeSetId }))[0];
    const outcome = (await list(ctx.database, 'ToolOutcome', { tool_call_id: tool.toolCallId }))[0];
    const model = (await list(ctx.database, 'ToolModelResult', { tool_call_id: tool.toolCallId }))[0];
    assert.equal(decision.decision, 'expired');
    assert.equal(outcome.status, 'cancelled');
    assert.ok(model);
    const atomic = commits.find((commit) =>
      commit.changes.some((entry) => entry.domain === 'FileChangeDecision' && entry.id === decision.id)
    );
    assert.ok(atomic);
    for (const domain of ['FileChangeDecision', 'ToolOutcome', 'ToolModelResult']) {
      assert.ok(atomic.changes.some((entry) => entry.domain === domain));
    }
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: tool.toolCallId })).length, 0);
    assert.equal(await exists(path.join(workspace, 'never.txt')), false);
    assertions.push('重开数据库后expired Decision、cancelled Outcome、唯一ModelResult在同一事务原子收口且无Effect');

    const before = await counts(ctx.database, ['FileChangeDecision', 'ToolOutcome', 'ToolModelResult', 'CommandReceipt']);
    const replay = await scanner.run('recovery.file-change-unresolved');
    assert.equal(replay.reconciled, 0);
    assert.deepEqual(await counts(ctx.database, ['FileChangeDecision', 'ToolOutcome', 'ToolModelResult', 'CommandReceipt']), before);
    assertions.push('重复unresolved扫描不重复决定或模型结果');

    const blockedTurn = await createAdditionalTurn(ctx, 'a-file-blocked');
    const readyTurn = await createAdditionalTurn(ctx, 'b-file-ready');
    const blockedContext = { ...ctx, conversationId: blockedTurn.conversationId, turnId: blockedTurn.turnId };
    const readyContext = { ...ctx, conversationId: readyTurn.conversationId, turnId: readyTurn.turnId };
    const blocker = await createTool(blockedContext, effects, 'file-scan-blocker', 'internal');
    const blockedFileTool = await createTool(blockedContext, effects, 'file-scan-blocked', 'write');
    const blockedProposal = await files.propose({
      source: source('internal', 'file-scan-blocked:proposal'),
      toolCallId: blockedFileTool.toolCallId,
      members: [{ operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'blocked-scan' }]
    });
    const readyFileTool = await createTool(readyContext, effects, 'file-scan-ready', 'write');
    const readyProposal = await files.propose({
      source: source('internal', 'file-scan-ready:proposal'),
      toolCallId: readyFileTool.toolCallId,
      members: [{ operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'ready-scan' }]
    });
    const partialScan = await scanner.run('recovery.file-change-unresolved');
    assert.equal((await get(ctx.database, 'FileChangeSet', blockedProposal.changeSetId)).status, 'pending');
    assert.equal((await get(ctx.database, 'FileChangeSet', readyProposal.changeSetId)).status, 'expired');
    assert.ok(partialScan.reconciled >= 1);
    await effects.settleWithoutEffect({
      source: source('internal', 'file-scan-blocker:settle'),
      toolCallId: blocker.toolCallId,
      status: 'succeeded',
      detail: { done: true }
    });
    await scanner.run('recovery.file-change-unresolved');
    assert.equal((await get(ctx.database, 'FileChangeSet', blockedProposal.changeSetId)).status, 'expired');
    assertions.push('一个Turn受前序call_seq阻塞时只defer该候选，继续收口其他Turn并在前序完成后重扫');

    const noLeaseTurn = await createAdditionalTurn(ctx, 'no-lease-finalize');
    const noLeaseContext = { ...ctx, conversationId: noLeaseTurn.conversationId, turnId: noLeaseTurn.turnId };
    const noLeaseTool = await createTool(noLeaseContext, effects, 'file-no-lease-finalize', 'write');
    const noLeaseProposal = await files.propose({
      source: source('internal', 'file-no-lease-finalize:proposal'),
      toolCallId: noLeaseTool.toolCallId,
      members: [{ operation: 'create_directory', workEnvironmentId: 'workspace', targetPath: 'no-lease-finalize' }]
    });
    await ctx.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').delete(noLeaseTurn.leaseId)
    ]);
    await scanner.run('recovery.file-change-unresolved');
    assert.equal((await get(ctx.database, 'FileChangeSet', noLeaseProposal.changeSetId)).status, 'expired');
    assert.equal((await get(ctx.database, 'Turn', noLeaseTurn.turnId)).status, 'terminated');
    assert.equal((await list(ctx.database, 'TurnTermination', { turn_id: noLeaseTurn.turnId })).length, 1);
    assert.equal((await effects.readTerminalResult(noLeaseTool.toolCallId, true)).status, 'cancelled');
    assertions.push('active且无Lease的唯一finalize组合由恢复事务收口文件Decision/结果/TurnTermination，不自造新lease');

    const turns = new kernel.TurnControlPlane(ctx.database, ctx.store, {
      authorityCompiler: { async compile() { throw new Error('not used by terminal'); } },
      unresolvedFileClosure: files
    });
    const inFlightTool = await createTool(ctx, effects, 'turn-terminal-inflight', 'write');
    const inFlightProposal = await files.propose({
      source: source('internal', 'turn-terminal-inflight:proposal'),
      toolCallId: inFlightTool.toolCallId,
      members: [{
        operation: 'create_file',
        workEnvironmentId: 'workspace',
        targetPath: 'turn-terminal-inflight.txt',
        targetContent: 'finished-before-terminal'
      }]
    });
    const inFlightApproved = await files.decide({
      source: source('command', 'turn-terminal-inflight:approve'),
      changeSetId: inFlightProposal.changeSetId,
      decision: 'approved'
    });
    await effects.claimEffectDispatch(inFlightApproved.preparedEffect.effectIntentId);
    await assert.rejects(turns.terminal({
      source: source('internal', 'turn-terminal-inflight:terminal'),
      turnId: ctx.turnId,
      terminalStatus: 'cancelled',
      reason: 'must preserve in-flight effect'
    }), /assertAll/);
    assert.equal((await get(ctx.database, 'Turn', ctx.turnId)).status, 'active');
    assert.equal((await list(ctx.database, 'ExecutionLease', { turn_id: ctx.turnId })).length, 1);
    const inFlightDispatcher = new kernel.FileMutationDispatcher(
      ctx.database,
      ctx.store,
      effects,
      (id) => id === 'workspace' ? { id, rootPath: workspace } : undefined
    );
    const inFlightObservation = await inFlightDispatcher.executeDispatched(
      inFlightApproved.preparedEffect.effectIntentId
    );
    const inFlightReceipt = await effects.recordEffectReceipt({
      source: source('callback', 'turn-terminal-inflight:receipt'),
      attemptId: inFlightApproved.preparedEffect.attemptId,
      effectKind: 'file_mutation',
      outcome: 'succeeded',
      detail: inFlightObservation
    });
    await files.reconcileEffectReceipt(inFlightReceipt.effectReceiptId);
    assert.equal((await effects.readTerminalResult(inFlightTool.toolCallId, true)).status, 'succeeded');
    assertions.push('approved/dispatched工具未收口时Turn terminal事务拒绝并保留Lease；真实Receipt完成后才允许终止');

    const originalSnapshotAll = ctx.database.snapshotAll.bind(ctx.database);
    let injectedTerminalProposal;
    let injected = false;
    ctx.database.snapshotAll = async (read) => {
      const value = await originalSnapshotAll(read);
      const target = !injected && read.domain === 'FileChangeSet' && read.where?.status === 'pending';
      if (target) {
        injected = true;
        const injectedTool = await createTool(ctx, effects, 'turn-terminal-race', 'write');
        injectedTerminalProposal = await files.propose({
          source: source('internal', 'turn-terminal-race:proposal'),
          toolCallId: injectedTool.toolCallId,
          members: [{
            operation: 'create_file',
            workEnvironmentId: 'workspace',
            targetPath: 'turn-terminal-race.txt',
            targetContent: 'never'
          }]
        });
      }
      return value;
    };
    try {
      await assert.rejects(turns.terminal({
        source: source('internal', 'turn-terminal-race:terminal'),
        turnId: ctx.turnId,
        terminalStatus: 'cancelled',
        reason: 'injected proposal after closure snapshot'
      }), /assertAll/);
    } finally {
      ctx.database.snapshotAll = originalSnapshotAll;
    }
    assert.ok(injectedTerminalProposal);
    assert.equal((await get(ctx.database, 'Turn', ctx.turnId)).status, 'active');
    assert.equal((await list(ctx.database, 'ExecutionLease', { turn_id: ctx.turnId })).length, 1);
    assert.equal((await get(ctx.database, 'FileChangeSet', injectedTerminalProposal.changeSetId)).status, 'pending');
    assertions.push('终止枚举后并发提交的新提案由同一writer事务assertAll捕获，terminal回滚且不会留下terminated+pending');

    const terminalTool = await createTool(ctx, effects, 'turn-terminal-file', 'write');
    const terminalProposal = await files.propose({
      source: source('internal', 'turn-terminal-file:proposal'),
      toolCallId: terminalTool.toolCallId,
      members: [{
        operation: 'create_file',
        workEnvironmentId: 'workspace',
        targetPath: 'turn-terminal-never.txt',
        targetContent: 'never'
      }]
    });
    const terminalCommits = [];
    const stopTerminalCommits = ctx.database.onCommit((commit) => terminalCommits.push(commit));
    const terminated = await turns.terminal({
      source: source('internal', 'turn-terminal-file:terminal'),
      turnId: ctx.turnId,
      terminalStatus: 'cancelled',
      reason: 'candidate turn terminal closure'
    });
    stopTerminalCommits();
    const terminalDecision = (await list(ctx.database, 'FileChangeDecision', {
      change_set_id: terminalProposal.changeSetId
    }))[0];
    assert.equal(terminalDecision.decision, 'expired');
    assert.equal((await list(ctx.database, 'Operation', { tool_call_id: terminalTool.toolCallId })).length, 0);
    assert.equal((await list(ctx.database, 'ToolOutcome', { tool_call_id: terminalTool.toolCallId }))[0].status, 'cancelled');
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: terminalTool.toolCallId })).length, 1);
    const terminalCommit = terminalCommits.find((commit) => commit.commitSeq === terminated.commitSeq);
    assert.ok(terminalCommit);
    for (const domain of ['FileChangeDecision', 'ToolOutcome', 'ToolModelResult', 'TurnTermination']) {
      assert.ok(terminalCommit.changes.some((entry) => entry.domain === domain));
    }
    assert.equal((await scanner.run('recovery.file-change-unresolved')).reconciled, 0);
    assertions.push('turn-terminal在删除lease前同事务原子写expired Decision、cancelled Outcome和唯一ModelResult；重启扫描无需补洞');

    return {
      assertions,
      faults: [
        'unresolved proposal across database reopen',
        'atomic expiry closure',
        'turn-terminal unresolved closure before lease release',
        'turn-terminal rejects in-flight effect',
        'turn-terminal snapshot race rollback',
        'blocked Turn does not abort global scan',
        'active no-lease finalize judgment',
        'no external effect',
        'repeat scan'
      ]
    };
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createRuntime(parent, label) {
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: `phase-d-${label}` });
  const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
  const now = new Date().toISOString();
  const conversationId = `conversation-${label}`;
  const turnId = `turn-${label}`;
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: label,
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: turnId,
      conversation_id: conversationId,
      status: 'active',
      created_at: now,
      updated_at: now,
      terminal_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: `lease-${label}`,
      conversation_id: conversationId,
      turn_id: turnId,
      owner_id: `owner-${label}`,
      host_boot_id: `host-${label}`,
      generation: 1n,
      acquired_at: now,
      expires_at: '2099-01-01T00:00:00.000Z'
    })
  ]);
  return {
    parent,
    authority: candidate.authority,
    binding: candidate.binding,
    database,
    store,
    conversationId,
    turnId
  };
}

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase-d-${label}-`));
  let ctx;
  try {
    ctx = await createRuntime(parent, label);
    return await body(ctx);
  } finally {
    if (ctx?.database) await ctx.database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createAdditionalTurn(ctx, label) {
  const now = new Date().toISOString();
  const conversationId = `conversation-${label}`;
  const turnId = `turn-${label}`;
  const leaseId = `lease-${label}`;
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: label,
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
      id: turnId,
      conversation_id: conversationId,
      status: 'active',
      created_at: now,
      updated_at: now,
      terminal_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: leaseId,
      conversation_id: conversationId,
      turn_id: turnId,
      owner_id: `owner-${label}`,
      host_boot_id: `host-${label}`,
      generation: 1n,
      acquired_at: now,
      expires_at: '2099-01-01T00:00:00.000Z'
    })
  ]);
  return { conversationId, turnId, leaseId };
}

async function createTool(ctx, effects, id, toolName) {
  return effects.createToolCall({
    source: source('callback', `tool-call:${id}`),
    toolCallId: `tool-call-${id}`,
    turnId: ctx.turnId,
    toolName,
    arguments: { id }
  });
}

async function attachWorkEnvironmentAuthority(ctx, turnId, id, enabled) {
  const content = await ctx.store.ingest(ctx.database, JSON.stringify({
    model: { providerConfigId: 'phase-d', provider: 'openai-compatible', modelId: 'phase-d' },
    toolPolicy: {
      id: 'phase-d-tools',
      allowedTools: ['read', 'transfer', 'switch_work_environment'],
      preset: 'yolo',
      toolConfigs: {},
      sourceConfigs: {}
    },
    planReviewPolicy: {
      id: null,
      mode: 'off',
      allowReadonlyBeforeApproval: true,
      requireForToolRiskLevels: []
    },
    workEnvironmentPolicy: {
      id: 'phase-d-work-environments',
      enabled,
      allowedWorkEnvironmentIds: ['workspace', 'workspace-alternate'],
      defaultWorkEnvironmentId: 'workspace'
    }
  }), 'application/vnd.limcode.turn-authority-snapshot+json');
  await ctx.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
      id,
      turn_id: turnId,
      content_object_id: content.id,
      created_at: new Date().toISOString()
    })
  ]);
}

function phaseDRuntimeDefinition(name) {
  return {
    execution: 'runtime',
    declaration: {
      name,
      description: `${name} Phase D fixture`,
      parameters: { type: 'object' },
      metadata: { defaultEnabled: true }
    },
    async execute() { throw new Error(`${name} fixture execution must remain unreachable.`); }
  };
}

async function createAndDispatchPhaseDTool(effects, dispatcher, turnId, id, toolName, args) {
  const toolCallId = `tool-call-${id}`;
  await effects.createToolCall({
    source: source('internal', `${id}:create`),
    toolCallId,
    turnId,
    toolName,
    arguments: args
  });
  return dispatcher.dispatch({
    turnId,
    modelRequestId: `model-${id}`,
    toolCallId,
    toolName,
    arguments: args
  });
}

async function get(database, domain, id) {
  const snapshot = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)]);
  return snapshot.snapshot[0];
}

async function list(database, domain, where, limit = 1000) {
  const snapshot = await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
  return snapshot.snapshot[0];
}

async function counts(database, domains) {
  return Object.fromEntries(await Promise.all(domains.map(async (domain) => [domain, (await list(database, domain, {})).length])));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPidFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = (await fs.readFile(filePath, 'utf8')).trim();
      if (/^[1-9]\d*$/.test(value)) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`PID file ${filePath} did not appear.`);
    await delay(25);
  }
}

async function waitForTextFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error(`File ${filePath} did not appear.`);
    await delay(25);
  }
}

async function waitForFingerprintGone(pid, fingerprint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (kernel.readLinuxStartFingerprint(pid) !== fingerprint) return;
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Process ${pid} remained alive after process-group escalation.`);
    await delay(25);
  }
}

async function waitUntilTerminal(processes, processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed;
  do {
    observed = await processes.wait(processId, Math.min(100, Math.max(0, deadline - Date.now())));
    if (observed.state === 'exited') return observed;
  } while (Date.now() < deadline);
  return observed;
}

async function waitForPersistedProcessStatus(database, processId, terminalStatuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await get(database, 'Process', processId);
    if (row && terminalStatuses.has(row.status)) return row;
    if (Date.now() >= deadline) throw new Error(`Process ${processId} did not reach a persisted terminal status.`);
    await delay(25);
  }
}

async function waitForSingleRow(database, domain, where, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await list(database, domain, where);
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new Error(`${domain} level-trigger identity produced multiple rows.`);
    if (Date.now() >= deadline) throw new Error(`${domain} did not produce its level-trigger row.`);
    await delay(25);
  }
}

async function waitForRowState(database, domain, where, expectedState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await waitForSingleRow(database, domain, where, Math.max(1, deadline - Date.now()));
    if (row.state === expectedState) return row;
    if (Date.now() >= deadline) throw new Error(`${domain} did not reach state ${expectedState}.`);
    await delay(25);
  }
}

async function waitForNoExitObservers(processes, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processes.inspectExitObservers().activeProcessIds.length > 0) {
    if (Date.now() >= deadline) throw new Error('Process exit observers did not drain after terminal receipt.');
    await delay(10);
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function source(kind, key) {
  return { kind, key };
}

function recoveryTurns(ctx, files) {
  return new kernel.TurnControlPlane(ctx.database, ctx.store, {
    authorityCompiler: { async compile() { throw new Error('Recovery terminal does not compile authority.'); } },
    unresolvedFileClosure: files
  });
}

function allowMcpPolicy() {
  return {
    async authorize() {
      return { toolPolicyAllowed: true, planReviewAllowed: true };
    }
  };
}

function phaseDApplicationDependencies(overrides = {}) {
  return {
    authorityCompiler: {
      async compile() { throw new Error('Process recovery fixture does not compile Turn authority.'); }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { throw new Error('Process recovery fixture does not dispatch MCP.'); }
    },
    mcpPolicyGate: allowMcpPolicy(),
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve() { throw new Error('Process recovery fixture does not dispatch a provider.'); }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('Process recovery fixture does not dispatch a tool.'); }
    },
    ...overrides
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function writeEvidence(id, evidence, commitSha) {
  const evidenceRoot = path.join(root, 'tests/reliable-kernel/evidence');
  await fs.mkdir(evidenceRoot, { recursive: true });
  const evidencePath = path.join(evidenceRoot, `${id.replaceAll('.', '-')}.json`);
  await fs.writeFile(evidencePath, `${JSON.stringify({
    kind: 'limcode-phase-d-candidate-evidence',
    stableId: id,
    passed: true,
    commitSha,
    measuredAt: new Date().toISOString(),
    assertionCount: evidence.assertions.length,
    assertions: evidence.assertions,
    faults: evidence.faults
  }, null, 2)}\n`);
  return evidencePath;
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

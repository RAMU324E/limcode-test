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
      items: [{ title: 'Phase D', status: 'in_progress', delete: false }]
    });
    const taskOutcome = await get(ctx.database, 'ToolOutcome', taskResult.toolOutcomeId);
    const taskContent = await get(ctx.database, 'ContentObject', taskOutcome.content_object_id);
    const taskDetail = JSON.parse((await ctx.store.read(taskContent)).toString('utf8'));
    assert.deepEqual(taskDetail, {
      detail: {
        items: [{ delete: false, status: 'in_progress', title: 'Phase D' }],
        kind: 'task-list'
      },
      status: 'succeeded',
      toolCallId: taskTool.toolCallId
    });
    assert.equal((await list(ctx.database, 'ToolModelResult', { tool_call_id: taskTool.toolCallId })).length, 1);
    const taskReplay = await interactions.settleTaskList({
      source: source('internal', 'task-list:settle'),
      toolCallId: taskTool.toolCallId,
      items: [{ title: 'Phase D', status: 'in_progress', delete: false }]
    });
    assert.equal(taskReplay.receiptId, taskResult.receiptId);
    assert.ok(await get(ctx.database, 'CommandReceipt', taskReplay.receiptId));
    assertions.push('update_task_list只写结构化Tool结果事实；重放返回真实存在的CommandReceipt而不发明ID');

    const taskBlocker = await createTool(ctx, effects, 'task-order-blocker', 'internal');
    const laterTask = await createTool(ctx, effects, 'task-order-later', 'update_task_list');
    const deferredTask = await interactions.settleTaskList({
      source: source('internal', 'task-order-later:settle'),
      toolCallId: laterTask.toolCallId,
      items: [{ title: 'Durable later result', status: 'completed', delete: false }]
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

    const invalidTaskTool = await createTool(ctx, effects, 'invalid-task-list', 'update_task_list');
    await assert.rejects(interactions.settleTaskList({
      source: source('internal', 'invalid-task-list:settle'),
      toolCallId: invalidTaskTool.toolCallId,
      items: [{ title: 'bad', status: 'done', delete: false }]
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
    const originalSnapshotAll = ctx.database.snapshotAll.bind(ctx.database);
    let transitionInjected = false;
    ctx.database.snapshotAll = async (read) => {
      const value = await originalSnapshotAll(read);
      if (!transitionInjected && read.domain === 'EffectIntent' && read.where?.dispatch_state === 'receipt_written') {
        transitionInjected = true;
        await effects.recordEffectReceipt({
          source: source('callback', 'receipt-transition-gap:callback'),
          attemptId: transitionPrepared.attemptId,
          effectKind: 'mcp_tool_call',
          outcome: 'succeeded'
        });
      }
      return value;
    };
    try {
      await scanner.runAll();
    } finally {
      ctx.database.snapshotAll = originalSnapshotAll;
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
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(()=>{process.stdout.write('restart-output\\n')},300)")}`;
    const prepared = await processes.prepareStart({
      source: source('internal', 'process-restart:prepare'),
      toolCallId: tool.toolCallId,
      command,
      cwd: parent
    });
    const started = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(started.observation.outcome, 'succeeded');
    const processId = prepared.request.processId;
    await ctx.database.close();

    ctx.database = await kernel.RuntimeDatabase.open(ctx.authority, { hostBootId: 'process-restart-host' });
    ctx.store = new kernel.ContentAddressedStore(ctx.authority, ctx.binding);
    effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );
    const exited = await waitUntilTerminal(processes, processId, 10_000);
    assert.equal(exited.state, 'exited');
    assert.equal(exited.receipt.exitCode, '0');
    await processes.reconcileOutput(processId);
    const firstRead = await processes.readOutput(processId);
    const secondRead = await processes.readOutput(processId);
    assert.equal(firstRead.stdout.toString('utf8'), secondRead.stdout.toString('utf8'));
    assert.match(firstRead.stdout.toString('utf8'), /restart-output/);
    const processReceiptRace = await Promise.all([
      processes.reconcileProcessExit(processId),
      processes.reconcileProcessExit(processId)
    ]);
    assert.ok(processReceiptRace.every((entry) => entry.state === 'exited'));
    assert.equal((await list(ctx.database, 'ProcessReceipt', { process_id: processId })).length, 1);
    const exitOperations = await list(ctx.database, 'Operation', { owner_kind: 'process', owner_id: processId });
    assert.equal(exitOperations.length, 1);
    assert.equal(exitOperations[0].tool_call_id, null);
    const exitAttempts = await list(ctx.database, 'Attempt', { operation_id: exitOperations[0].id });
    const exitIntents = await list(ctx.database, 'EffectIntent', { attempt_id: exitAttempts[0].id });
    const exitReceipts = await list(ctx.database, 'EffectReceipt', { attempt_id: exitAttempts[0].id });
    assert.equal(exitIntents[0].effect_kind, 'process_exit');
    assert.equal(exitIntents[0].dispatch_state, 'receipt_written');
    assert.equal(exitReceipts.length, 1);
    const detachedCommandReceipts = await list(ctx.database, 'CommandReceipt', { conversation_id: null });
    assert.ok(detachedCommandReceipts.length > 0);
    assert.ok(detachedCommandReceipts.every((entry) => entry.turn_id === null));
    assertions.push('detached wrapper跨数据库/控制对象重启保留spool和真实exitCode；process_exit receipt使用nullable关系而非伪Conversation；并发reconcile只写一个ProcessReceipt；read_output重复读取不消费');

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
    assertions.push('快速非零退出由wrapper原子receipt决定ToolOutcome=failed，不把仅启动成功伪装为执行成功');

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
    assert.equal((await processes.executeDispatchedStop(recoverStop.effectIntentId)).outcome, 'succeeded');
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
    assert.equal((await processes.executeDispatchedStop(winnerStop.effectIntentId)).outcome, 'succeeded');
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
    assertions.push('错误nonce/fingerprint/group证据拒绝stop且进程仍运行；正确证据只经stop EffectIntent请求wrapper停止');

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
    await assert.rejects(processes.readOutput(processId), (error) => error?.code === 'stale-root-binding');
    assertions.push('每次read/wait/stop重验RootBinding generation，root switch后旧binding fail closed');

    return {
      assertions,
      faults: [
        'controller restart',
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

async function checkProcessOutputBounds() {
  return withRuntime('process-output', async (ctx) => {
    const assertions = [];
    const effects = new kernel.EffectControlPlane(ctx.database, ctx.store);
    const processes = new kernel.ProcessControlPlane(
      ctx.database, ctx.store, effects, ctx.authority, ctx.binding
    );

    const liveTailTool = await createTool(ctx, effects, 'process-live-tail', 'bash');
    const liveTailPrepared = await processes.prepareStart({
      source: source('internal', 'process-live-tail:prepare'),
      toolCallId: liveTailTool.toolCallId,
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('abc');setTimeout(()=>process.exit(0),1200)")}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(liveTailPrepared.effect.effectIntentId);
    await delay(350);
    const liveTailRead = await processes.readOutput(liveTailPrepared.request.processId);
    assert.equal(liveTailRead.stdout.toString('utf8'), 'abc');
    assert.equal(liveTailRead.retainedBytes, '3');
    assert.equal(liveTailRead.retainedChunks, '1');
    await waitUntilTerminal(processes, liveTailPrepared.request.processId, 5_000);
    await processes.reconcileProcessExit(liveTailPrepared.request.processId);
    assertions.push('运行中live tail正文与有效retained bytes/chunks一致，读取不消费tail');

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
      command: `${shellQuote(process.execPath)} -e ${shellQuote("process.stdout.write('retained-body')")}`,
      cwd: ctx.parent
    });
    await processes.dispatchStart(missingSpoolPrepared.effect.effectIntentId);
    await waitUntilTerminal(processes, missingSpoolPrepared.request.processId, 5_000);
    await processes.reconcileProcessExit(missingSpoolPrepared.request.processId);
    const missingProcessRow = await get(ctx.database, 'Process', missingSpoolPrepared.request.processId);
    const missingSpoolPath = kernel.processSpoolPath(ctx.binding, missingProcessRow.spool_locator);
    const missingChunkRoot = path.join(missingSpoolPath, kernel.PROCESS_WRAPPER_CHUNKS_DIRECTORY);
    for (const name of await fs.readdir(missingChunkRoot)) await fs.unlink(path.join(missingChunkRoot, name));
    await assert.rejects(processes.readOutput(missingSpoolPrepared.request.processId), /integrity check failed/);
    assertions.push('CAS尚未登记且spool chunk缺失时read_output明确报完整性错误，不返回空正文配完整计数');

    const tool = await createTool(ctx, effects, 'process-output', 'bash');
    const payloadBytes = kernel.PROCESS_OUTPUT_MAX_RETAINED_BYTES + (1024 * 1024);
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
    assert.equal(exited.receipt.truncated, true);
    assert.ok(BigInt(exited.receipt.droppedBytes) > 0n);
    assert.ok(BigInt(exited.receipt.retainedBytes) <= BigInt(kernel.PROCESS_OUTPUT_MAX_RETAINED_BYTES));
    assert.ok(BigInt(exited.receipt.retainedChunks) <= BigInt(kernel.PROCESS_OUTPUT_MAX_RETAINED_CHUNKS));
    assertions.push('超过4MiB/256 chunk后仍持续drain至真实退出，只累计dropped/truncated');

    const concurrentOutput = await Promise.all([
      processes.reconcileOutput(processId),
      processes.reconcileOutput(processId)
    ]);
    const reconciled = concurrentOutput[0];
    assert.ok(concurrentOutput.every((entry) => entry.retainedBytes <= BigInt(kernel.PROCESS_OUTPUT_MAX_RETAINED_BYTES)));
    assert.ok(concurrentOutput.every((entry) => entry.retainedChunks <= BigInt(kernel.PROCESS_OUTPUT_MAX_RETAINED_CHUNKS)));
    const chunks = await list(ctx.database, 'ProcessOutputChunk', { process_id: processId });
    assert.equal(BigInt(chunks.length), reconciled.retainedChunks);
    assert.ok(chunks.every((row) => row.byte_length <= BigInt(kernel.PROCESS_OUTPUT_MAX_CHUNK_BYTES)));
    assert.ok(chunks.every((row) => typeof row.chunk_seq === 'bigint'));
    const casBefore = (await list(ctx.database, 'ContentObject', {})).length;
    const secondReconcile = await processes.reconcileOutput(processId);
    assert.equal(secondReconcile.insertedChunks, 0);
    assert.equal((await list(ctx.database, 'ContentObject', {})).length, casBefore);
    assertions.push('并发ProcessOutput reconcile精确收敛；chunk metadata入SQLite、正文入CAS，达到上限后重复reconcile不再增长');

    const processRow = await get(ctx.database, 'Process', processId);
    const spoolPath = kernel.processSpoolPath(ctx.binding, processRow.spool_locator);
    const chunkDirectory = path.join(spoolPath, kernel.PROCESS_WRAPPER_CHUNKS_DIRECTORY);
    for (const name of await fs.readdir(chunkDirectory)) {
      await fs.unlink(path.join(chunkDirectory, name));
    }
    const afterSpoolLoss = await processes.reconcileOutput(processId);
    assert.equal(afterSpoolLoss.retainedChunks, reconciled.retainedChunks);
    assert.equal((await list(ctx.database, 'ProcessOutputChunk', { process_id: processId })).length, chunks.length);

    const first = await processes.readOutput(processId);
    const second = await processes.readOutput(processId);
    assert.deepEqual(first.stdout, second.stdout);
    assert.deepEqual(first.stderr, second.stderr);
    assert.match(first.stdout.subarray(Math.max(0, first.stdout.length - 128)).toString('utf8'), /TERMINAL-TAIL-MARKER/);
    assert.ok(first.stdout.length <= kernel.PROCESS_OUTPUT_MAX_RETAINED_BYTES);
    assertions.push('read_output从已登记SQLite/CAS chunk稳定读取；spool chunk丢失后不消费历史、不缩小计数且terminal tail仍保留');

    return {
      assertions,
      faults: ['live tail accounting', 'live writer/import race', 'stale output commit after exit', 'spool loss before CAS import', 'sustained output overflow', 'continued drain', 'competing ProcessOutput reconcile', 'CAS/SQLite growth convergence', 'spool loss after CAS import', 'repeatable read_output', 'terminal tail']
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
    assert.equal(result.reconciled, 2);
    assert.equal(recoveredMcpCalls, 0);
    assert.equal((await effects.readTerminalResult(fileTool.toolCallId, true)).status, 'succeeded');
    assert.equal((await effects.readTerminalResult(mcpTool.toolCallId, true)).status, 'outcome_unknown');
    assertions.push('真实重开数据库扫描file摘要可证明成功、MCP不可查询落unknown且不redispatch');

    const before = await counts(ctx.database, ['EffectReceipt', 'ToolOutcome', 'ToolModelResult']);
    const replay = await scanner.run('recovery.effect-intent-hanging');
    assert.equal(replay.reconciled, 0);
    assert.deepEqual(await counts(ctx.database, ['EffectReceipt', 'ToolOutcome', 'ToolModelResult']), before);
    assertions.push('重复恢复扫描不产生第二Receipt/Outcome/ModelResult');

    return {
      assertions,
      faults: ['file action executed callback lost', 'MCP callback lost', 'database reopen', 'no redispatch', 'repeat recovery scan']
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

async function waitUntilTerminal(processes, processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let observed;
  do {
    observed = await processes.wait(processId, Math.min(100, Math.max(0, deadline - Date.now())));
    if (observed.state === 'exited') return observed;
  } while (Date.now() < deadline);
  return observed;
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

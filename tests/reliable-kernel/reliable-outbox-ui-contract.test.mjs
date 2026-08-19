import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Turn 输入 outbox 先持久化完整命令，再用同 command/request id 重放并双重收敛', () => {
  const chat = read('webview/src/composables/useChat.ts');
  const composer = read('webview/src/components/input/Composer.vue');
  const worker = read('backend/reliableKernel/databaseWorker.ts');
  const feed = read('backend/reliableKernel/clientFeed.ts');
  const sharedFeed = read('shared/reliableKernelClientFeed.ts');

  assert.match(chat, /command:\s*ConversationCommandMetadata/);
  assert.match(chat, /pendingTurnInputs:\s*pendingTurnInputSubmissions\.value/);
  assert.match(chat, /failedTurnInputs:\s*failedTurnInputSubmissions\.value/);
  assert.match(chat, /persistControls\(\);\s*postTurnInputSubmission/);
  assert.match(chat, /bridge\.request\(next\.requestType[\s\S]*?command:\s*\{ \.\.\.next\.command \}[\s\S]*?requestId:\s*next\.requestId/);
  const turnInputPost = chat.slice(
    chat.indexOf('function postTurnInputSubmission'),
    chat.indexOf('function armTurnInputRetry')
  );
  assert.doesNotMatch(turnInputPost, /structuredClone\(/);
  assert.match(turnInputPost, /content:\s*next\.content/);
  assert.match(turnInputPost, /model:\s*next\.authority\.model/);
  assert.match(chat, /replayTurnInputSubmissions\(clientId, sessionId/);
  assert.match(chat, /TURN_INPUT_RETRY_MS/);
  assert.match(chat, /TURN_INPUT_MAX_AUTOMATIC_RETRIES_PER_GENERATION\s*=\s*1/);
  assert.match(chat, /retryTurnInputSubmission/);
  assert.match(chat, /result\.intentId\s*&&\s*records\.TurnIntent/);
  assert.match(chat, /result\.turnId\s*&&\s*records\.Turn/);
  assert.match(chat, /records\.ConversationCommandReceipt/);
  assert.match(chat, /receipt\.command_id\s*===\s*pending\.commandId/);
  assert.match(chat, /confirmTurnInputFromDurableReceipt\(pending\)/);
  assert.match(chat, /function turnInputDurableObservation/);
  assert.match(chat, /currentPendingTurnInputs[\s\S]*?!turnInputDurableObservation\(reliableRecords\.value, submission\)\.observed/);
  assert.match(chat, /currentTurnInputAcknowledgements[\s\S]*?turnInputDurableObservation\(reliableRecords\.value, pending\)\.observed/);
  const turnInputReconciliation = chat.slice(
    chat.indexOf('function reconcileTurnInputSubmissions'),
    chat.indexOf('function replayTurnInputSubmissions')
  );
  assert.doesNotMatch(turnInputReconciliation, /turnInputAcknowledgements|nextAcknowledgements/);
  assert.match(chat, /function dismissTurnInputAcknowledgement[\s\S]*?delete next\[commandId\]/);
  assert.ok(
    chat.indexOf('reconcileTurnInputSubmissions(') < chat.indexOf('replayTurnInputSubmissions(clientId, sessionId'),
    'a restored durable receipt must retire the outbox before the same command is replayed'
  );

  assert.match(worker, /capture_conversation_command_receipt_insert/);
  assert.match(worker, /source_key AS command_id/);
  assert.match(worker, /commandReceipts/);
  assert.match(feed, /commandReceipts:\s*['"]ConversationCommandReceipt['"]/);
  assert.match(sharedFeed, /['"]ConversationCommandReceipt['"]/);

  assert.match(composer, /currentTurnInputAcknowledgements/);
  assert.match(composer, /if \(!commandId \|\| !acknowledgement\) return;[\s\S]*?ui\.clearChatDraft\(\)/);
  assert.match(composer, /currentTurnInputFailure/);
  assert.match(composer, /draft\.value\s*=\s*failure\.text/);
});

test('Interaction 决策 outbox 跨重启固定 request id，UI 超时不删除重放依据', () => {
  const interactions = read('webview/src/stores/useInteractionStore.ts');
  const bootstrap = read('webview/src/composables/useBridgeBootstrap.ts');
  const router = read('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.ts');
  const plan = read('webview/src/components/plan/PlanProposalContent.vue');
  const askUser = read('webview/src/components/askUser/AskUserContent.vue');

  assert.match(interactions, /PERSISTED_INTERACTION_OUTBOX_KEY/);
  assert.match(interactions, /response:\s*JsonValue/);
  assert.match(interactions, /requestId:\s*createMessageId\(\)/);
  assert.match(interactions, /persistOutbox\(pending\);\s*postResolution/);
  assert.match(interactions, /BridgeMessageType\.InteractionResolve[\s\S]*?requestId:\s*next\.requestId/);
  assert.match(interactions, /replayForClient/);
  assert.match(interactions, /OUTBOX_RETRY_MS/);
  assert.match(interactions, /OUTBOX_MAX_AUTOMATIC_RETRIES_PER_GENERATION\s*=\s*1/);
  const responseTimeout = interactions.slice(
    interactions.indexOf('function armResponseTimeout'),
    interactions.indexOf('function armRetry')
  );
  assert.match(responseTimeout, /delete submitting\[interactionRequestId\]/);
  assert.doesNotMatch(responseTimeout, /delete pending|clear\(interactionRequestId\)/);
  assert.match(bootstrap, /interactions\.replayForClient/);
  assert.match(bootstrap, /interactions\.reconcileReliableFacts/);
  assert.match(router, /this\.post\(webview,[\s\S]*?void this\.resumeInteractionOwner/);
  assert.match(plan, /提交暂未确认，可点击原操作重试/);
  assert.match(plan, /interactions\.resultFor\(requestId\)/);
  assert.match(askUser, /回答已提交，正在同步/);
});

test('Reliable Plan 审批保留当前对话与选择 Agent 新开对话两个入口', () => {
  const plan = read('webview/src/components/plan/PlanProposalContent.vue');
  const actionStart = plan.indexOf('<footer v-if="pending" class="plan-proposal-actions">');
  const actionEnd = plan.indexOf('</footer>', actionStart);
  const actions = plan.slice(actionStart, actionEnd);
  const dispatchPanelStart = plan.indexOf('<ConfirmPanel', actionEnd);
  const dispatchPanelEnd = plan.indexOf('</ConfirmPanel>', dispatchPanelStart);
  const dispatchPanel = plan.slice(dispatchPanelStart, dispatchPanelEnd);

  assert.ok(actionStart >= 0 && actionEnd > actionStart);
  assert.match(actions, /新开对话执行/);
  assert.match(actions, /在当前对话中执行/);
  assert.doesNotMatch(actions, /v-if="!interactionView"/);
  assert.match(dispatchPanel, /:open="dispatchPanelOpen"/);
  assert.doesNotMatch(dispatchPanel, /!interactionView/);
  assert.match(plan, /submitApproval\('new_conversation', agent\.id\)/);
  assert.match(plan, /executionTarget:\s*'new_conversation'/);
  assert.match(plan, /agentType:\s*normalizedAgentType/);
});

test('MainPanel 将 Ready/可见性作为 Reliable Feed 生命周期边界', () => {
  const feed = read('backend/reliableKernel/webviewFeedBridge.ts');
  const panel = read('vscode/panels/MainPanel.ts');

  const attach = feed.slice(feed.indexOf('public attach('), feed.indexOf('public reconnect('));
  assert.doesNotMatch(attach, /this\.connect\(/);
  assert.match(feed, /client\.ready\s*=\s*true/);
  assert.match(feed, /public setVisible/);
  assert.match(feed, /if \(!visible\) \{[\s\S]*?this\.pauseClient\(client\)/);
  assert.match(feed, /this\.cancelRecoveryTimer\(client\)[\s\S]*?client\.connection\s*=\s*undefined/);
  assert.match(feed, /client\.closed \|\| !client\.ready \|\| !client\.visible \|\| client\.recoveryTimer/);
  assert.match(panel, /setWebviewVisible\(this\.clientId, panel\.visible\)/);
  assert.match(panel, /onDidChangeViewState[\s\S]*?setWebviewVisible\(this\.clientId, this\.panel\.visible\)/);
});

test('保留的 Webview 在 Extension Host 换代后只补发一次 Ready', () => {
  const bootstrap = read('webview/src/composables/useBridgeBootstrap.ts');
  const helloHandler = bootstrap.slice(
    bootstrap.indexOf('bridge.on(BridgeMessageType.Hello'),
    bootstrap.indexOf('bridge.on(BridgeMessageType.ConfigurationSnapshot')
  );

  assert.match(bootstrap, /let announcedClientId:\s*string \| undefined/);
  assert.match(helloHandler, /const previousClientId = announcedClientId/);
  assert.match(helloHandler, /if \(message\.clientId\) announcedClientId = message\.clientId/);
  assert.match(
    helloHandler,
    /previousClientId && message\.clientId && previousClientId !== message\.clientId[\s\S]*?bridge\.ready\(\)/
  );
  assert.equal((helloHandler.match(/bridge\.ready\(\)/g) ?? []).length, 1);
});

test('旧任务 artifact 只省略可选任务卡，不阻断整个 Conversation Feed', () => {
  const worker = read('backend/reliableKernel/databaseWorker.ts');
  const projection = worker.slice(
    worker.indexOf('function projectCurrentTaskList('),
    worker.indexOf('function readTaskProjectionJson(')
  );

  assert.match(projection, /try \{[\s\S]*?taskListOperationFromSettledArtifact/);
  assert.match(projection, /catch \{\s*return null;\s*\}/);
  assert.doesNotMatch(projection, /detail\.items|preserveLatestMessages|reserveLatestUserMessageTokens/);
});

test('全局设置首轮和重复快照都收敛读取状态，失败 section 不被成功状态覆盖', () => {
  const store = read('webview/src/stores/useGlobalSettingsStore.ts');
  const settle = store.slice(
    store.indexOf('function settleSettingsStatus('),
    store.indexOf('function settingsErrorStatus(')
  );
  const requestAll = store.slice(
    store.indexOf('requestAll(): void'),
    store.indexOf('requestChannelSettings(): void')
  );
  const applySnapshot = store.slice(
    store.indexOf('applySnapshot(payload:'),
    store.indexOf('resolveExternalSnapshot(payload:')
  );
  const repeatedSnapshot = applySnapshot.slice(
    applySnapshot.indexOf('if (this.loadedSections[section] && this.revisions[section] === payload.revision)'),
    applySnapshot.indexOf('if (!this.loadedSections[section])')
  );
  const initialSnapshot = applySnapshot.slice(
    applySnapshot.indexOf('if (!this.loadedSections[section])'),
    applySnapshot.indexOf('if (coordinator.inFlight)')
  );

  assert.match(requestAll, /this\.status = '正在读取设置\.\.\.'/);
  assert.match(settle, /hasOutstandingSettingsWork\(state\)/);
  assert.match(settle, /Object\.keys\(state\.failedSettingsSections\)\.length > 0/);
  assert.match(repeatedSnapshot, /settleSettingsStatus\(this, '设置已同步'\);\s*return;/);
  assert.match(initialSnapshot, /this\.refreshPendingSettingSection\(section\);\s*settleSettingsStatus\(this, '设置已同步'\);\s*return;/);
});

test('Provider 新 Attempt 会清除旧 Attempt 的部分文本、思考和工具预览', () => {
  const store = read('webview/src/stores/useReliableKernelClientFeedStore.ts');
  const lifecycle = read('webview/src/domain/reliableTransientLifecycle.ts');
  const terminalBranch = store.slice(
    store.indexOf("} else if (message.event.kind === 'failed' || message.event.kind === 'cancelled')"),
    store.indexOf("} else if (content?.type === 'text_delta')")
  );
  const terminalBeforeRetryDiscard = terminalBranch.slice(
    0,
    terminalBranch.indexOf('if (content?.discardOutput === true)')
  );
  const attemptFence = lifecycle.slice(
    lifecycle.indexOf('const durableAttemptSeq = modelRequestAttemptSeq(request);'),
    lifecycle.indexOf("if (request.status !== 'terminal') continue;")
  );

  assert.match(terminalBeforeRetryDiscard, /next\.toolCalls = \[\];/);
  assert.match(terminalBeforeRetryDiscard, /next\.outputParts = next\.outputParts\.filter/);
  assert.match(terminalBranch, /content\?\.discardOutput === true/);
  assert.match(terminalBranch, /next\.text = '';[\s\S]*?next\.thought = '';[\s\S]*?next\.toolCalls = \[\];/);
  assert.match(attemptFence, /durableAttemptSeq > transientAttemptSeq/);
  assert.match(attemptFence, /delete requests\[entry\.modelRequestId\]/);
});

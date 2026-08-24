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

test('等待队列按 guidance/runtime continuation 分流，并展示真实后台来源', () => {
  const queue = read('webview/src/components/input/ReliableQueuePanel.vue');
  const sharedFeed = read('shared/reliableKernelClientFeed.ts');
  const feed = read('backend/reliableKernel/clientFeed.ts');
  const worker = read('backend/reliableKernel/databaseWorker.ts');

  assert.match(sharedFeed, /kind:\s*'runtime_continuation'/);
  assert.match(sharedFeed, /RuntimeDeliveryIntentLink/);
  assert.match(feed, /listRows\('RuntimeDeliveryIntentLink', \{ turn_intent_id: recordId \}, 2\)/);
  assert.match(feed, /inbox\.source_kind === 'process_receipt'/);
  assert.match(feed, /inbox\.source_kind !== 'answer_submission'/);
  assert.match(worker, /runtimeDeliveryIntentLinks/);
  assert.match(queue, /等待队列 · \{\{ queueItems\.length \}\}/);
  assert.match(queue, /preview\?\.kind === 'guidance'/);
  assert.match(queue, /preview\?\.kind === 'runtime_continuation'/);
  assert.match(queue, /IconTerminal2/);
  assert.match(queue, /IconRobot/);
  assert.match(queue, /subagentName\(preview\.source\.agentId\)/);
  assert.match(queue, /v-if="item\.committed && guidancePreview\(item\.preview\)"/);
  assert.match(queue, /runtimePreview\(item\.preview\)\?\.source\.kind === 'background_process'/);
  assert.match(queue, /ConfirmPanel/);
  assert.match(queue, /withdrawTurnInputSubmission/);
  assert.doesNotMatch(queue, /window\.confirm/);
  assert.match(queue, /item\.withdrawable && item\.commandId/);
  assert.match(queue, /reliable-queue-remove-confirm/);
});

test('乐观等待消息撤回在 receipt 可见前不重放，提交竞态收敛到 guidance cancel', () => {
  const chat = read('webview/src/composables/useChat.ts');
  assert.match(chat, /withdrawnAt\?: number/);
  assert.match(chat, /withdrawalReceiptReplayRequested\?: boolean/);
  assert.match(chat, /submission\.withdrawnAt/);
  assert.match(chat, /decideTurnInputWithdrawal/);
  assert.match(chat, /durableReceiptObserved[\s\S]*?replay_receipt/);
  assert.match(chat, /withdrawalReceiptReplay:\s*true/);
  assert.match(chat, /WITHDRAWAL_RECEIPT_REPLAY_MS/);
  assert.match(chat, /armWithdrawalReceiptReplay/);
  assert.match(chat, /replayWithdrawnTurnInputReceipt/);
  assert.match(chat, /withdrawalReceiptReplayRequested:\s*true[\s\S]*?撤回状态会自动重查/);
  assert.match(chat, /BridgeMessageType\.GuidanceCancel/);
  assert.match(chat, /withdrawTurnInputSubmission/);
});

test('停止 outbox 持久化后投递，超时重同步并以同一命令有限重放', () => {
  const chat = read('webview/src/composables/useChat.ts');
  const lifecycle = read('shared/reliableControlLifecycle.ts');
  const standaloneSend = chat.slice(
    chat.indexOf('function sendStandaloneInterrupt'),
    chat.indexOf('function sendForkRequest')
  );
  const actionSend = chat.slice(
    chat.indexOf('function requestActionInterrupt'),
    chat.indexOf('function submitConversationAction')
  );

  assert.match(chat, /INTERRUPT_WATCHDOG_MS\s*=\s*8_000/);
  assert.match(chat, /INTERRUPT_MAX_AUTOMATIC_RETRIES\s*=\s*2/);
  assert.match(chat, /startedAt:\s*number/);
  assert.match(chat, /automaticRetryCount:\s*number/);
  assert.match(chat, /BridgeMessageType\.ClientResync/);
  assert.match(chat, /leaseEpoch:\s*0[\s\S]*?command:\s*current\.command/);
  assert.match(chat, /hasInterruptWatchdog\('standalone'/);
  assert.match(chat, /hasInterruptWatchdog\('action'/);
  assert.match(chat, /validInterruptState/);
  assert.match(chat, /validConversationActionRecords/);
  assert.ok(
    standaloneSend.indexOf('setInterruptState(next)') < standaloneSend.indexOf('bridge.request(BridgeMessageType.TurnInterrupt'),
    'standalone stop must persist before transport dispatch'
  );
  assert.ok(
    actionSend.indexOf('setConversationAction(nextAction)') < actionSend.indexOf('bridge.request(BridgeMessageType.TurnInterrupt'),
    'history-action stop must persist before transport dispatch'
  );
  assert.match(lifecycle, /kind:\s*'retry';\s*nextAutomaticRetryCount/);
  assert.match(lifecycle, /return \{ kind: 'failed' \}/);
});

test('Interaction 决策 outbox 跨重启固定 request id，UI 超时不删除重放依据', () => {
  const interactions = read('webview/src/stores/useInteractionStore.ts');
  const bootstrap = read('webview/src/composables/useBridgeBootstrap.ts');
  const router = read('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.ts');
  const plan = read('webview/src/components/plan/PlanProposalContent.vue');
  const askUser = read('webview/src/components/askUser/AskUserContent.vue');
  const askUserStore = read('webview/src/stores/useAskUserStore.ts');

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
  assert.match(interactions, /decideInteractionResolution/);
  assert.match(interactions, /retireSupersededResolution/);
  assert.match(interactions, /phase:\s*'uncertain'/);
  assert.match(interactions, /current\.requestId === correlationId/);
  assert.match(interactions, /interactionResultSettlesRequest/);
  assert.match(interactions, /interactionResultConfirmsSubmittedDecision/);
  assert.match(interactions, /else if \(payload\.status === 'stale'\)/);
  assert.match(interactions, /markResolutionUncertain\(exact, interactionFailureMessage\(payload\)\)/);
  assert.match(interactions, /function markResolutionUncertain/);
  assert.match(plan, /提交暂未确认，可点击任一操作重试或改选/);
  assert.match(plan, /resolutionNotice/);
  assert.match(plan, /interactions\.resultFor\(requestId\)/);
  assert.match(askUser, /回答已提交，正在同步/);
  assert.match(askUser, /interactionIssue/);
  assert.match(askUser, /submissionIssue/);
  assert.match(askUserStore, /releaseSubmission/);
  assert.doesNotMatch(askUserStore, /SUBMIT_CONFIRM_TIMEOUT_MS|submitTimers/);
});

test('等待型工具全局停止使用 cancelled，显式审批拒绝仍走 rejected', () => {
  const dispatcher = read('backend/reliableKernel/toolDispatcher.ts');
  const router = read('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.ts');
  const fileEffects = read('backend/reliableKernel/fileEffects.ts');
  const cancelWaiting = dispatcher.slice(
    dispatcher.indexOf('public async cancelWaiting'),
    dispatcher.indexOf('public async cancelActive')
  );
  const interactionResolve = router.slice(
    router.indexOf('private async handleInteractionResolve'),
    router.indexOf('private async resumeInteractionOwner')
  );
  const toolCancel = router.slice(
    router.indexOf('private async handleToolCancel'),
    router.indexOf('private async handleToolExecution')
  );

  assert.match(cancelWaiting, /resolveAskUser[\s\S]*?cancelled:\s*true/);
  assert.match(cancelWaiting, /request_kind === 'file_change_approval'[\s\S]*?decision:\s*'cancelled'/);
  assert.match(cancelWaiting, /request_kind === 'plan_review'[\s\S]*?decision:\s*'cancel'/);
  assert.match(cancelWaiting, /request_kind === 'exec_approval'[\s\S]*?decision:\s*'cancel'/);
  assert.match(fileEffects, /FileChangeDecisionValue = 'approved' \| 'rejected' \| 'cancelled' \| 'expired'/);
  assert.match(interactionResolve, /payload\.decision === 'cancel'[\s\S]*?\? 'cancelled'[\s\S]*?: 'rejected'/);
  assert.match(interactionResolve, /payload\.decision === 'cancel'[\s\S]*?\? 'cancel'[\s\S]*?: 'reject'/);
  assert.match(toolCancel, /decision:\s*'cancel'/);
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

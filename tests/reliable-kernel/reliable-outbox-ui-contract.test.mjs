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

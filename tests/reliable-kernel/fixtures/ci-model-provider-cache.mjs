import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { load, settings, user, model, call, result, startRequest, fullRequest, fakeCapability, accepted, kernel, llm } from './ci-model-provider-support.mjs';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const session = load('backend/capabilities/openAIResponsesWebSocketSession.js');
const { projectTurnReminder } = load('backend/reliableKernel/turnReminderProjection.js');
const reminderLayout = load('backend/capabilities/turnReminderLayout.js');
const handles = load('backend/reliableKernel/modelHandleCatalog.js');
const environments = load('backend/world/modules/workEnvironment/toolDescription.js');
const { createLocalFolderWorkEnvironmentRecord } = load('shared/workEnvironmentCatalog.js');
const { switchWorkEnvironmentTool } = load('backend/world/modules/tools/definitions/switchWorkEnvironment/index.js');
const { transferFilesTool } = load('backend/world/modules/tools/definitions/transferFiles/index.js');

const snapshot = text => projectTurnReminder({ kind: 'reliable-agent-turn',
  turnReminderDelivery: 'user_history', runtimeStatusCard: { card: text } });
const markedTexts = body => body.input.flatMap(item =>
  (item.content ?? (Array.isArray(item.output) ? item.output : []))
    .filter(block => block.prompt_cache_breakpoint).map(block => block.text));
const wireText = body => JSON.stringify(body);
const occurrences = (text, needle) => text.split(needle).length - 1;
const outputRef = (id, responseId, ordinal) => ({ id, providerResponseId: responseId, ordinal });

async function projectedWire(config, request) {
  let projected;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    projected = input;
    emit({ type: 'llm:done', payload: { requestId: input.id } });
  }));
  await adapter.sendFullRequest(request, accepted);
  const wire = await llm.dryRunLlmProvider(projected, { settings: async () => config });
  return { projected, body: wire.body, budget: adapter.estimateFullRequestInput(request) };
}

function nativePair(segmentId, sourceModelRequestId, responseId, callId, ordinal, output) {
  return { segmentId, segmentKind: 'tool_pair', messageRole: null, sourceModelRequestId,
    contentType: 'application/json', content: JSON.stringify({ native: true,
      toolCall: { id: `tool-${callId}`, providerCallId: callId, toolName: 'lookup', arguments: '{}',
        outputItem: outputRef(`item-${callId}`, responseId, ordinal) },
      ...(output === undefined ? {} : { toolModelResult: { result: JSON.stringify({ output }) } })
    }) };
}


export function registerProviderCacheTest(test) {
  test('单工作环境工具前缀不随 W# 分配变化，current 严格解析到冻结环境', async () => {
    const environment = createLocalFolderWorkEnvironmentRecord({ id: 'work_environment_cache', name: 'cache',
      uri: 'file:///workspace', rootPath: '/workspace' }, 1);
    const tools = [switchWorkEnvironmentTool, transferFilesTool].map(({ declaration }) => {
      const transfer = declaration.name === 'transfer';
      const text = environments.workEnvironmentListText([environment], transfer
        ? environments.TRANSFER_WORK_ENVIRONMENTS_TITLE : environments.SWITCH_WORK_ENVIRONMENTS_TITLE);
      return { ...declaration, description: declaration.description + '\n\n' + text,
        parameters: transfer
          ? environments.withTransferEnvironmentParameterHints(declaration.parameters, text)
          : environments.withWorkEnvironmentIdParameterHints(declaration.parameters, text) };
    });
    const catalog = ref => ({ entries: [{ kind: 'workEnvironment', ref, target: environment.id }] });
    const config = settings('openai-responses');
    const request = fullRequest(config, [user('task')], tools);
    request.recipe.modelHandleCatalog = catalog('W1');
    const first = await projectedWire(config, request);
    const next = structuredClone(request);
    next.recipe.modelHandleCatalog = catalog('W9');
    const second = await projectedWire(config, next);
    assert.deepEqual(first.body.tools, second.body.tools);
    assert.match(JSON.stringify(first.body.tools), /current/);
    assert.doesNotMatch(JSON.stringify(first.body.tools), /W1|W9|W#|work_environment_cache/);
    assert.deepEqual(handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'current' }, catalog('W9')),
      { workEnvironmentId: environment.id });
    assert.deepEqual(handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'W9' }, catalog('W9')),
      { workEnvironmentId: environment.id });
    assert.throws(() => handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'W1' },
      { ...catalog('W9'), retiredRefs: ['W1'] }));
    assert.throws(() => handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: environment.id }, catalog('W9')));
    assert.throws(() => handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'current' }, { entries: [] }));
    assert.throws(() => handles.resolveModelToolArguments('read', { attachmentRef: 'current' }, catalog('W9')));
    const multiple = structuredClone(next);
    multiple.recipe.modelHandleCatalog.entries.push({ kind: 'workEnvironment', ref: 'W10', target: 'another_environment' });
    const multiWire = await projectedWire(config, multiple);
    assert.match(JSON.stringify(multiWire.body.tools), /W9/);
    assert.match(JSON.stringify(multiWire.body.tools), /W# reference/);
    assert.throws(() => handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'current' },
      multiple.recipe.modelHandleCatalog));
    assert.deepEqual(handles.resolveModelToolArguments('switch_work_environment', { workEnvironmentRef: 'W9' },
      multiple.recipe.modelHandleCatalog), { workEnvironmentId: environment.id });
    assert.deepEqual(request.recipe.modelHandleCatalog, catalog('W1'));
    assert.match(JSON.stringify(tools), /work_environment_cache/);
  });

  test('Responses 历史快照沿真实物理响应保留，文字和纯工具输出都读取上次输入终点', async () => {
    const config = settings('openai-responses', { id: 'ci-history-cache', model: 'gpt-6-astra',
      promptCache: { enabled: true, mode: 'explicit', ttl: '30m' } });
    const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} } }];
    const firstReminder = snapshot('first-runtime-snapshot');
    const secondReminder = snapshot('second-runtime-snapshot');
    const thirdReminder = snapshot('third-runtime-snapshot');
    const first = fullRequest(config, [user('task')], tools);
    first.recipe = { ...first.recipe, kind: 'reliable-agent-turn', turnReminderDelivery: 'user_history' };
    first.requestAddenda = { turnReminder: firstReminder };
    const firstWire = await projectedWire(config, first);

    const second = structuredClone(first);
    const commentary = fullRequest(config, [model([{ text: 'checking',
      outputItem: outputRef('commentary-a', 'physical-a', 0) }])]).context[0];
    commentary.segmentId = 'commentary-a';
    commentary.sourceModelRequestId = 'logical-a';
    second.context.push(commentary,
      nativePair('call-a', 'logical-a', 'physical-a', 'call_a', 1),
      nativePair('result-a', 'logical-a', 'physical-a', 'call_a', 1, 'first-result'));
    second.requestAddenda = { turnReminder: secondReminder, turnReminderHistory: [
      { segmentId: 'commentary-a', delivery: 'user_history', content: firstReminder.content }
    ] };
    const secondWire = await projectedWire(config, second);
    assert.deepEqual(secondWire.body.input.slice(0, firstWire.body.input.length), firstWire.body.input);
    assert.deepEqual(markedTexts(secondWire.body), ['system instruction', firstReminder.content, secondReminder.content]);
    assert.equal(occurrences(wireText(secondWire.body), 'first-runtime-snapshot'), 1);

    const third = structuredClone(second);
    third.context.push(nativePair('call-b', 'logical-b', 'physical-b', 'call_b', 0),
      nativePair('result-b', 'logical-b', 'physical-b', 'call_b', 0, 'second-result'));
    third.requestAddenda = { turnReminder: thirdReminder, turnReminderHistory: [
      ...second.requestAddenda.turnReminderHistory,
      { segmentId: 'call-b', delivery: 'user_history', content: secondReminder.content }
    ] };
    const thirdWire = await projectedWire(config, third);
    assert.deepEqual(markedTexts(thirdWire.body), ['system instruction', secondReminder.content, thirdReminder.content]);
    assert.equal(occurrences(wireText(thirdWire.body), 'first-runtime-snapshot'), 1);
    assert.equal(occurrences(wireText(thirdWire.body), 'second-runtime-snapshot'), 1);
    assert.equal(thirdWire.body.input.find(item => item.call_id === 'call_b').type, 'function_call');
    assert.equal('readBreakpointBeforeContentIndex' in thirdWire.body, false);
    assert.deepEqual(secondWire.projected.openAIResponsesContinuation.volatileTailContentKinds, []);
  });

  test('压缩后原文和附件目录只重注入一次，切 Claude 保持 user 快照与实际预算一致', async () => {
    const config = settings('openai-responses', { id: 'ci-reinjection-cache', model: 'gpt-6-astra',
      promptCache: { enabled: true, mode: 'explicit', ttl: '30m' } });
    const firstReminder = snapshot('after-compaction-snapshot');
    const current = { messageId: 'input-message', messageRevisionId: 'input-revision', contentObjectId: 'input-object',
      reinject: true, contentType: 'application/vnd.limcode.message+json', content: JSON.stringify(user('original-task-input')) };
    const attachment = { attachmentId: 'attachment-1', name: 'preserved-attachment.txt', mimeType: 'text/plain', sizeBytes: 12 };
    const first = fullRequest(config, []);
    first.recipe = { ...first.recipe, kind: 'reliable-agent-turn', turnReminderDelivery: 'user_history',
      modelHandleCatalog: { entries: [{ kind: 'attachment', ref: 'F1', target: attachment.attachmentId }] } };
    first.context = [{ segmentId: 'compressed', segmentKind: 'compression', messageRole: null,
      contentType: 'application/vnd.limcode.compression-contents+json',
      content: JSON.stringify({ kind: 'compression_contents', version: 1, contents: [user('compressed-history')] }) }];
    first.attachmentCatalogState = { catalog: [attachment], placements: [{ kind: 'current_turn_delta', entries: [attachment] }] };
    const followup = { ...current, messageId: 'followup-message', messageRevisionId: 'followup-revision',
      contentObjectId: 'followup-object', content: JSON.stringify(user('followup-task-input')) };
    const inputs = [current, followup];
    // The same ordered references are used by both ordinary and native-frozen replay.
    first.requestAddenda = { currentTurnInputs: inputs, turnReminder: firstReminder };
    const beforeCompression = fullRequest(config, inputs.map(input => JSON.parse(input.content)));
    beforeCompression.requestAddenda = { currentTurnInputs: inputs.map(input => ({ ...input, reinject: false })) };
    const ordinaryWire = await projectedWire(config, beforeCompression);
    assert.equal(occurrences(wireText(ordinaryWire.body), 'original-task-input'), 1);
    assert.equal(occurrences(wireText(ordinaryWire.body), 'followup-task-input'), 1);
    const single = structuredClone(beforeCompression);
    single.requestAddenda.currentTurnInputs.pop();
    const singleWire = await projectedWire(config, single);
    assert.equal(singleWire.budget.fullTokens, ordinaryWire.budget.fullTokens);
    assert.ok(ordinaryWire.budget.currentInputTokens > singleWire.budget.currentInputTokens);
    const firstWire = await projectedWire(config, first);
    const native = structuredClone(first);
    native.recipe.nativeResponses = { asyncTools: true, steering: true, reasoningUpdates: true };
    const nativeWire = await projectedWire(config, native);
    assert.deepEqual(nativeWire.projected.contents, firstWire.projected.contents);
    assert.deepEqual(nativeWire.budget, firstWire.budget);
    assert.equal(nativeWire.projected.nativeSessionCapabilities.asyncTools, true);
    const deliveredInput = firstWire.projected.contents.find(content => content.parts.some(part => part.text === 'followup-task-input'));
    assert.equal(occurrences(wireText(firstWire.body), 'original-task-input'), 1);
    assert.equal(occurrences(wireText(firstWire.body), 'followup-task-input'), 1);
    assert.ok(deliveredInput.parts.some(part => part.text?.includes('preserved-attachment.txt')));

    const second = structuredClone(first);
    const answer = fullRequest(config, [model([{ text: 'after compression', outputItem: outputRef('answer', 'physical-c', 0) }])]).context[0];
    answer.segmentId = 'answer';
    answer.sourceModelRequestId = 'logical-c';
    second.context.push(answer);
    second.requestAddenda = { currentTurnInputs: inputs, turnReminder: snapshot('new-runtime-snapshot'), turnReminderHistory: [
      { segmentId: 'answer', delivery: 'user_history', content: firstReminder.content,
        reinjectedInputs: inputs.map((input, index) => ({
          messageRevisionId: input.messageRevisionId, contentType: input.contentType, content: input.content,
          ...(index === inputs.length - 1
            ? { currentTurnAttachmentState: { role: 'user', parts: deliveredInput.parts.slice(2) } } : {})
        })) }
    ] };
    const secondWire = await projectedWire(config, second);
    assert.deepEqual(secondWire.body.input.slice(0, firstWire.body.input.length), firstWire.body.input);
    assert.equal(occurrences(wireText(secondWire.body), 'original-task-input'), 1);
    assert.equal(occurrences(wireText(secondWire.body), 'followup-task-input'), 1);
    assert.equal(occurrences(wireText(secondWire.body), 'preserved-attachment.txt'), 1);
    assert.equal(secondWire.budget.currentInputTokens, 0);
    assert.ok(firstWire.budget.currentInputTokens > 0);

    const claude = settings('claude', { id: config.id, claudeTurnScopedReminders: true });
    const switched = structuredClone(second);
    switched.modelId = claude.model;
    switched.authoritySnapshot.model = { providerConfigId: claude.id, provider: 'claude', modelId: claude.model,
      claudeTurnScopedReminders: true };
    delete switched.requestAddenda.turnReminder;
    const switchedWire = await projectedWire(claude, switched);
    assert.equal(switchedWire.body.messages.some(message => message.role === 'system'), false);
    assert.equal(occurrences(wireText(switchedWire.body), 'original-task-input'), 1);
    assert.equal(occurrences(wireText(switchedWire.body), 'followup-task-input'), 1);
    assert.equal(occurrences(wireText(switchedWire.body), 'preserved-attachment.txt'), 1);
    const plain = fullRequest(claude, reminderLayout.layoutTurnReminderContents(switchedWire.projected.contents, 'claude_turn_scoped'));
    const plainBudget = new kernel.LlmCapabilityFullRequestAdapter(claude.id, fakeCapability(() => {})).estimateFullRequestInput(plain);
    assert.equal(switchedWire.budget.fullTokens, plainBudget.fullTokens);
    assert.ok(switchedWire.budget.contextTokens > 0);
  });

  test('显式缓存工具结果使用数组，断点变化保持增量而内容变化发全量', async () => {
    const frames = [];
    const server = http.createServer();
    const sockets = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      sockets.handleUpgrade(request, socket, head, webSocket => {
        webSocket.on('message', raw => {
          const index = frames.length;
          frames.push(JSON.parse(String(raw)));
          const id = `cache-response-${index + 1}`;
          const item = index === 0
            ? { id: 'tool-item', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' }
            : { id: `message-${index}`, type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text: 'done', annotations: [] }] };
          webSocket.send(JSON.stringify({ type: 'response.created', response: { id } }));
          if (index === 0) webSocket.send(JSON.stringify({ type: 'response.output_item.added',
            response_id: id, output_index: 0, item: { ...item, arguments: '' } }));
          webSocket.send(JSON.stringify({ type: 'response.output_item.done', response_id: id, output_index: 0, item }));
          webSocket.send(JSON.stringify({ type: 'response.completed', response: {
            id, status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
          } }));
        });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = settings('openai-responses', { id: 'ci-cache-provider', model: 'gpt-5.6-sol',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, openaiResponsesTransport: 'websocket',
      promptCache: { enabled: true, mode: 'explicit', ttl: '30m' } });
    const tools = [{ name: 'read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
    const first = [user('task')];
    const second = [...first, model([call('call_1', 'read', { path: 'a' })]),
      { role: 'user', parts: [result('call_1', 'read', { text: 'A' })] }];
    const changed = [user('task changed'), ...second.slice(1), model([{ text: 'done' }]), user('next')];
    const decisions = [];
    const send = async (contents, id, readBreakpointBeforeContentIndex) => {
      const events = [];
      await llm.startLlmProvider(startRequest(contents, { id, invocationId: id,
        conversationId: 'cache-conversation', tools, systemInstruction: user('stable instructions'), readBreakpointBeforeContentIndex }),
      event => events.push(event), { settings: async () => config, onTransportTrace(trace) {
        if (trace.phase === 'continuation_decision') decisions.push(trace.mode);
      } });
      assert.equal(events.find(event => event.type === 'llm:error'), undefined);
    };
    session.resetOpenAIResponsesWebSocketSessions();
    try {
      await send(first, 'cache-first');
      await send(second, 'cache-tool-result', first.length);
      await send(changed, 'cache-changed');
      assert.deepEqual(decisions, ['full', 'incremental', 'full']);
      assert.equal(frames[1].previous_response_id, 'cache-response-1');
      assert.equal(frames[1].prompt_cache_key, 'cache-conversation');
      assert.equal('readBreakpointBeforeContentIndex' in frames[1], false);
      assert.deepEqual(frames[1].input, [{ type: 'function_call_output', call_id: 'call_1',
        output: [{ type: 'input_text', text: '{"text":"A"}', prompt_cache_breakpoint: { mode: 'explicit' } }] }]);
      assert.equal(frames[2].previous_response_id, undefined);
      assert.ok(frames[2].input.length > 1);
      assert.deepEqual(frames[1].prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    } finally {
      session.resetOpenAIResponsesWebSocketSessions();
      for (const client of sockets.clients) client.terminate();
      await new Promise(resolve => sockets.close(resolve));
      await new Promise(resolve => server.close(resolve));
    }
  });
}

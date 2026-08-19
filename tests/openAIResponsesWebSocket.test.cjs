const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const http = require('node:http');
const esbuild = require('esbuild');
const { WebSocketServer } = require('ws');

const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      Uri: { joinPath: (...parts) => ({ fsPath: parts.map((part) => part?.fsPath ?? String(part)).join('/') }) },
      workspace: { fs: {} }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { normalizeLlmProviderConfig } = require('../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
Module._load = originalLoad;

const {
  createOpenAIResponsesWebSocketSessionKey,
  dryRunCompactLlmProvider,
  dryRunLlmProvider,
  emitUnifiedChunk,
  startLlmProvider
} = require('../dist/extension/backend/capabilities/llmProvider.js');
const {
  createTerminalValidatedFetch
} = require('../dist/extension/backend/capabilities/terminalValidatedFetch.js');
const {
  geminiThinkingCapabilityForModel
} = require('../dist/extension/shared/geminiThinking.js');
const { LlmEventType } = require('../dist/extension/backend/world/modules/llm/events.js');

function loadLlmParameterDefinitions() {
  const root = path.resolve(__dirname, '..');
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'webview/src/components/settings/global/parameters/llmParameterDefinitions.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    logLevel: 'silent'
  });
  const filename = path.join(root, '.test-gemini-thinking-parameters.cjs');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

function loadTransientOutputModule() {
  const root = path.resolve(__dirname, '..');
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, 'webview/src/domain/reliableTransientOutput.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    tsconfig: path.join(root, 'tsconfig.webview.json'),
    logLevel: 'silent'
  });
  const filename = path.join(root, '.test-reliable-transient-output.cjs');
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

const { parameterDefinitionsForProvider } = loadLlmParameterDefinitions();
const {
  appendReliableTransientTextPart,
  applyReliableTransientOutputItem,
  syncReliableTransientFunctionCallParts
} = loadTransientOutputModule();

function providerConfig(overrides = {}) {
  return {
    id: 'provider-openai-responses',
    name: 'OpenAI Responses',
    provider: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
    apiKey: 'sk-test-secret-1234',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function chatRequest(id = 'request-websocket') {
  return {
    id,
    invocationId: `invocation-${id}`,
    conversationId: 'conversation-websocket',
    contents: [{ role: 'user', parts: [{ text: 'Hello over WebSocket' }] }],
    tools: []
  };
}

async function createTransportFallbackServer({
  sendCreatedBeforeClose = false,
  sendSemanticBeforeClose = false
} = {}) {
  let httpCalls = 0;
  let webSocketCalls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      httpCalls += 1;
      const responseId = `resp_http_${httpCalls}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      const events = [
        { type: 'response.created', response: { id: responseId } },
        {
          type: 'response.output_text.delta',
          response_id: responseId,
          item_id: `msg_http_${httpCalls}`,
          output_index: 0,
          content_index: 0,
          delta: `HTTP rescue ${httpCalls}`
        },
        {
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item: {
            id: `msg_http_${httpCalls}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `HTTP rescue ${httpCalls}`, annotations: [] }]
          }
        },
        {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            output: [],
            usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
          }
        }
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketCalls += 1;
      webSocket.once('message', () => {
        if (sendCreatedBeforeClose) {
          webSocket.send(JSON.stringify({
            type: 'response.created',
            response: { id: `resp_ws_${webSocketCalls}` }
          }), () => {
            if (!sendSemanticBeforeClose) {
              webSocket.terminate();
              return;
            }
            webSocket.send(JSON.stringify({
              type: 'response.output_text.delta',
              response_id: `resp_ws_${webSocketCalls}`,
              item_id: `msg_ws_${webSocketCalls}`,
              output_index: 0,
              content_index: 0,
              delta: 'partial semantic output'
            }), () => webSocket.terminate());
          });
        } else webSocket.terminate();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    counts: () => ({ httpCalls, webSocketCalls }),
    async close() {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runTransportFallbackRequest(
  server,
  id,
  traces,
  conversationId = 'conversation-http-fallback'
) {
  const events = [];
  await startLlmProvider({
    ...chatRequest(id),
    conversationId,
    reliableProviderAttempt: {
      attemptSeq: 5,
      maxAttempts: 5,
      requestCreatedAt: Date.now()
    }
  }, (event) => events.push(event), {
    settings: async () => providerConfig({
      baseUrl: server.baseUrl,
      openaiResponsesTransport: 'websocket',
      retryOnError: false,
      retryMaxAttempts: 0
    }),
    onTransportTrace: (trace) => traces.push(trace)
  });
  return events;
}

test('OpenAI Responses WS session key 按 conversation 隔离且拒绝 global fallback', () => {
  const settings = providerConfig({ openaiResponsesTransport: 'websocket' });
  const first = createOpenAIResponsesWebSocketSessionKey(settings, 'conversation-a');
  const same = createOpenAIResponsesWebSocketSessionKey(settings, ' conversation-a ');
  const second = createOpenAIResponsesWebSocketSessionKey(settings, 'conversation-b');

  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.equal(first.length, 32);
  assert.throws(
    () => createOpenAIResponsesWebSocketSessionKey(settings, ''),
    /require a non-empty conversationId/
  );
});

test('OpenAI Responses WS prompt cache key 按 conversation 隔离', async () => {
  const config = providerConfig({
    openaiResponsesTransport: 'websocket',
    promptCache: { enabled: true, mode: 'key', ttl: '30m' }
  });
  const firstRequest = chatRequest('request-cache-a');
  firstRequest.conversationId = 'conversation-cache-a';
  const sameRequest = chatRequest('request-cache-a-again');
  sameRequest.conversationId = 'conversation-cache-a';
  const secondRequest = chatRequest('request-cache-b');
  secondRequest.conversationId = 'conversation-cache-b';

  const [first, same, second] = await Promise.all([
    dryRunLlmProvider(firstRequest, { settings: async () => config }),
    dryRunLlmProvider(sameRequest, { settings: async () => config }),
    dryRunLlmProvider(secondRequest, { settings: async () => config })
  ]);

  assert.match(first.body.prompt_cache_key, /^[a-f0-9]{32}$/);
  assert.equal(first.body.prompt_cache_key, same.body.prompt_cache_key);
  assert.notEqual(first.body.prompt_cache_key, second.body.prompt_cache_key);
});

test('OpenAI Responses WS 请求缺少 conversationId 时在发送前失败', async () => {
  const request = chatRequest('request-missing-conversation');
  delete request.conversationId;
  await assert.rejects(
    dryRunLlmProvider(request, {
      settings: async () => providerConfig({ openaiResponsesTransport: 'websocket' })
    }),
    /require a non-empty conversationId/
  );
});

function compactRequest(methodConfigSnapshot) {
  return {
    id: 'compact-websocket-provider',
    blockId: 'block-websocket-provider',
    conversationId: 'conversation-websocket',
    methodKind: methodConfigSnapshot.kind,
    methodConfigSnapshot,
    contents: [
      { role: 'user', parts: [{ text: 'Question' }] },
      { role: 'model', parts: [{ text: 'Answer' }] }
    ],
    sourceHash: 'source-websocket-provider'
  };
}

test('provider config normalization defaults legacy/invalid transport to HTTP and preserves WebSocket overrides', () => {
  const legacy = normalizeLlmProviderConfig(providerConfig({ openaiResponsesTransport: undefined }));
  assert.equal(legacy.openaiResponsesTransport, 'http');

  const invalid = normalizeLlmProviderConfig(providerConfig({ openaiResponsesTransport: 'invalid-transport' }));
  assert.equal(invalid.openaiResponsesTransport, 'http');

  const websocket = normalizeLlmProviderConfig(providerConfig({
    openaiResponsesTransport: 'websocket',
    modelConfigs: [{
      id: 'model-config-websocket',
      modelId: 'gpt-test',
      toolCallFormat: 'function-call',
      openaiResponsesTransport: 'websocket'
    }]
  }));
  assert.equal(websocket.openaiResponsesTransport, 'websocket');
  assert.equal(websocket.modelConfigs.length, 1);
  assert.equal(websocket.modelConfigs[0].openaiResponsesTransport, 'websocket');
});

test('OpenAI Responses WebSocket dry-run is streaming, store=false, incremental-state-free, and masked', async () => {
  const rawApiKey = 'sk-test-secret-1234';
  const config = providerConfig({
    apiKey: rawApiKey,
    openaiResponsesTransport: 'websocket',
    stream: false,
    requestBody: {
      background: true,
      previous_response_id: 'stale-response-id',
      prompt_cache_options: { retention: '24h' },
      metadata: { nested: { prompt_cache_breakpoint: true, keep: 'yes' } },
      store: true
    }
  });

  const request = chatRequest();
  request.contents.push({ role: 'user', parts: [{ text: '[Current Turn Task Card] keep working' }] });
  request.openAIResponsesContinuation = { volatileTailContentKinds: ['turn_reminder'] };
  const result = await dryRunLlmProvider(request, { settings: async () => config });

  assert.match(result.url, /^wss:\/\//);
  assert.match(result.providerName, /WebSocket$/);
  assert.equal(result.stream, true);
  assert.equal(result.body.type, 'response.create');
  assert.equal(result.body.store, false);
  assert.equal('stream' in result.body, false);
  assert.equal('background' in result.body, false);
  assert.equal('previous_response_id' in result.body, false);
  assert.equal('prompt_cache_options' in result.body, false);
  assert.doesNotMatch(JSON.stringify(result.body), /openAIResponsesContinuation|volatileTailContentKinds/);
  assert.match(JSON.stringify(result.body.input.at(-1)), /Current Turn Task Card/);
  assert.equal(result.body.metadata?.nested?.prompt_cache_breakpoint, undefined);
  assert.equal(result.body.metadata?.nested?.keep, 'yes');
  assert.match(result.curl, /^# WebSocket mode/m);
  assert.match(result.curl, /^CONNECT wss:\/\//m);
  assert.match(result.curl, /"type": "response.create"/);
  assert.doesNotMatch(result.curl, new RegExp(rawApiKey));
  assert.doesNotMatch(result.maskedCurl, new RegExp(rawApiKey));
  assert.equal(result.maskedSecrets, true);
});

test('OpenAI Responses dry-run replays persisted assistant item boundaries and phases exactly', async () => {
  const request = chatRequest('request-message-phase-replay');
  request.contents = [
    { role: 'user', parts: [{ text: 'Inspect the workspace' }] },
    {
      role: 'model',
      parts: [
        {
          text: 'I will inspect it first.',
          outputItem: { id: 'persisted-commentary', ordinal: 0, phase: 'commentary' }
        },
        {
          text: 'Inspection complete.',
          outputItem: { id: 'persisted-final', ordinal: 1, phase: 'final_answer' }
        }
      ]
    },
    { role: 'user', parts: [{ text: 'Continue' }] }
  ];

  const result = await dryRunLlmProvider(request, {
    settings: async () => providerConfig({ openaiResponsesTransport: 'websocket' })
  });
  assert.deepEqual(result.body.input.slice(1, 3), [
    {
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'I will inspect it first.' }]
    },
    {
      type: 'message',
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Inspection complete.' }]
    }
  ]);
  assert.equal(result.body.input[3].role, 'user');
  assert.equal(JSON.stringify(result.body.input).includes('persisted-commentary'), false);
});

test('missing or invalid transport keeps the normal OpenAI Responses HTTP dry-run behavior', async () => {
  const result = await dryRunLlmProvider(chatRequest('request-http-fallback'), {
    settings: async () => providerConfig({ openaiResponsesTransport: 'invalid-transport', stream: false })
  });

  assert.match(result.url, /^https:\/\//);
  assert.doesNotMatch(result.providerName, /WebSocket$/);
  assert.equal(result.stream, false);
  assert.match(result.curl, /^curl /);
});

test('Gemini dry-run removes unsupported multipleOf from nested tool schemas', async () => {
  const request = chatRequest('request-gemini-multiple-of');
  request.tools = [{
    name: 'integer_value',
    description: 'Checks nested numeric schema compatibility.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            value: { type: 'number', minimum: 0, maximum: 100, multipleOf: 1 }
          },
          required: ['title']
        }
      }
    }
  }];
  const result = await dryRunLlmProvider(request, {
    settings: async () => providerConfig({
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-test',
      stream: true
    })
  });

  assert.doesNotMatch(result.bodyText, /multipleOf/i);
  assert.match(result.bodyText, /"minimum":\s*0/);
  assert.match(result.bodyText, /"maximum":\s*100/);
  const declaration = result.body.tools[0].functionDeclarations[0];
  assert.equal(declaration.parameters.properties.options.properties.title.type, 'string');
  assert.deepEqual(declaration.parameters.properties.options.required, ['title']);
});

function geminiProviderConfig(overrides = {}) {
  return providerConfig({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.7-flash',
    models: [],
    apiKey: '',
    ...overrides
  });
}

async function dryRunGeminiThinkingConfig(config, id) {
  const result = await dryRunLlmProvider(chatRequest(id), { settings: async () => config });
  return result.body.generationConfig?.thinkingConfig;
}

test('Gemini thinking capability follows model-specific official level sets', () => {
  assert.deepEqual(geminiThinkingCapabilityForModel('gemini-3.7-flash'), {
    kind: 'thinkingLevel',
    levels: ['low', 'medium', 'high'],
    defaultLevel: 'high'
  });
  assert.deepEqual(geminiThinkingCapabilityForModel('models/gemini-3-flash-preview').levels, [
    'minimal', 'low', 'medium', 'high'
  ]);
  assert.deepEqual(geminiThinkingCapabilityForModel('gemini-3.7-flash-lite').levels, [
    'minimal', 'low', 'medium', 'high'
  ]);
  assert.deepEqual(geminiThinkingCapabilityForModel('gemini-3.1-pro-preview').levels, [
    'low', 'medium', 'high'
  ]);
  assert.deepEqual(geminiThinkingCapabilityForModel('gemini-3-pro-preview').levels, ['low', 'high']);
  assert.deepEqual(geminiThinkingCapabilityForModel('gemini-3.1-flash-lite-image').levels, ['minimal', 'high']);
  assert.equal(geminiThinkingCapabilityForModel('gemini-2.5-pro').kind, 'thinkingBudget');
});

test('Gemini 3.7 parameter definitions expose only low, medium, high with high default', () => {
  const definitions = parameterDefinitionsForProvider('gemini', 'gemini-3.7-flash');
  const level = definitions.find((definition) => definition.key === 'thinkingLevel');
  assert.ok(level);
  assert.equal(level.defaultValue, 'high');
  assert.deepEqual(level.options.map((option) => option.value), ['low', 'medium', 'high']);
  assert.equal(definitions.some((definition) => definition.key === 'thinkingBudget'), false);
  assert.equal(level.options.some((option) => ['minimal', 'xhigh', 'max'].includes(option.value)), false);

  const gemini25 = parameterDefinitionsForProvider('gemini', 'gemini-2.5-flash');
  assert.equal(gemini25.some((definition) => definition.key === 'thinkingBudget'), true);
  assert.equal(gemini25.some((definition) => definition.key === 'thinkingLevel'), false);
});

test('Gemini explicit supported level survives provider config normalization', () => {
  const normalized = normalizeLlmProviderConfig(geminiProviderConfig({
    generationConfig: { thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } }
  }));
  assert.deepEqual(normalized.generationConfig?.thinkingConfig, {
    includeThoughts: true,
    thinkingLevel: 'medium'
  });
});

test('Gemini 3.7 dry-run defaults to high thinking and thought summaries', async () => {
  const thinkingConfig = await dryRunGeminiThinkingConfig(
    geminiProviderConfig(),
    'request-gemini-37-default-thinking'
  );
  assert.deepEqual(thinkingConfig, {
    thinkingLevel: 'high',
    includeThoughts: true
  });
});

test('Gemini 3.7 preserves every explicitly supported thinking level', async () => {
  for (const thinkingLevel of ['low', 'medium', 'high']) {
    const thinkingConfig = await dryRunGeminiThinkingConfig(geminiProviderConfig({
      generationConfig: { thinkingConfig: { thinkingLevel } }
    }), `request-gemini-37-${thinkingLevel}`);
    assert.equal(thinkingConfig.thinkingLevel, thinkingLevel);
    assert.equal(thinkingConfig.includeThoughts, true);
  }
});

test('Gemini 3.7 replaces unsupported levels and legacy numeric budgets with high', async () => {
  for (const [label, configured] of [
    ['minimal', { thinkingLevel: 'minimal' }],
    ['xhigh', { thinkingLevel: 'xhigh' }],
    ['max', { thinkingLevel: 'max' }],
    ['budget', { thinkingBudget: 10_000 }]
  ]) {
    const thinkingConfig = await dryRunGeminiThinkingConfig(geminiProviderConfig({
      generationConfig: { thinkingConfig: configured }
    }), `request-gemini-37-invalid-${label}`);
    assert.equal(thinkingConfig.thinkingLevel, 'high');
    assert.equal(thinkingConfig.includeThoughts, true);
    assert.equal('thinkingBudget' in thinkingConfig, false);
  }
});

test('Gemini 2.5 keeps numeric budget and omits thinkingLevel at the request boundary', async () => {
  const thinkingConfig = await dryRunGeminiThinkingConfig(geminiProviderConfig({
    model: 'gemini-2.5-pro',
    generationConfig: {
      thinkingConfig: {
        thinkingBudget: 4_096,
        thinkingLevel: 'high'
      }
    }
  }), 'request-gemini-25-budget');
  assert.deepEqual(thinkingConfig, {
    thinkingBudget: 4_096,
    includeThoughts: true
  });
});

test('Gemini raw requestBody keeps final override priority over normalized defaults', async () => {
  const thinkingConfig = await dryRunGeminiThinkingConfig(geminiProviderConfig({
    requestBody: {
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: 'low',
          includeThoughts: false
        }
      }
    }
  }), 'request-gemini-37-request-body-override');
  assert.deepEqual(thinkingConfig, {
    thinkingLevel: 'low',
    includeThoughts: false
  });
});

test('final recoverable WS failure falls back to HTTP once and applies a short conversation cooldown', async () => {
  const server = await createTransportFallbackServer();
  try {
    const firstTraces = [];
    const firstEvents = await runTransportFallbackRequest(server, 'request-http-rescue-1', firstTraces);
    assert.equal(firstEvents.some((event) => event.type === LlmEventType.Error), false);
    assert.equal(firstEvents.some((event) => event.type === LlmEventType.Done), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.ok(firstTraces.some((trace) => trace.phase === 'http_fallback'));

    const secondTraces = [];
    const secondEvents = await runTransportFallbackRequest(server, 'request-http-rescue-2', secondTraces);
    assert.equal(secondEvents.some((event) => event.type === LlmEventType.Error), false);
    assert.equal(secondEvents.some((event) => event.type === LlmEventType.Done), true);
    assert.deepEqual(server.counts(), { httpCalls: 2, webSocketCalls: 1 });
    assert.ok(secondTraces.some((trace) => trace.phase === 'http_cooldown'));
  } finally {
    await server.close();
  }
});

test('response.created before EOF remains replay-safe and falls back to HTTP after exhaustion', async () => {
  const server = await createTransportFallbackServer({ sendCreatedBeforeClose: true });
  try {
    const traces = [];
    const events = await runTransportFallbackRequest(
      server,
      'request-no-rescue-after-event',
      traces,
      'conversation-no-rescue-after-event'
    );
    assert.equal(events.some((event) => event.type === LlmEventType.Error), false);
    assert.equal(events.some((event) => event.type === LlmEventType.Done), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), true);
  } finally {
    await server.close();
  }
});

test('WS failure after semantic output never falls back to HTTP or replays the request', async () => {
  const server = await createTransportFallbackServer({
    sendCreatedBeforeClose: true,
    sendSemanticBeforeClose: true
  });
  try {
    const traces = [];
    const events = await runTransportFallbackRequest(
      server,
      'request-no-rescue-after-semantic-output',
      traces,
      'conversation-no-rescue-after-semantic-output'
    );
    assert.equal(events.some((event) => event.type === LlmEventType.Error), true);
    assert.equal(events.some((event) => event.type === LlmEventType.Done), false);
    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), false);
  } finally {
    await server.close();
  }
});

test('OpenAI Responses compact dry-run stays on the HTTP compact endpoint when chat transport is WebSocket', async () => {
  const method = {
    id: 'compression-openai-responses',
    name: 'Responses Compact',
    kind: 'openai_responses_compact',
    trigger: { mode: 'manual' },
    openaiResponsesCompact: { model: 'gpt-test' },
    createdAt: 1,
    updatedAt: 1
  };
  const result = await dryRunCompactLlmProvider(compactRequest(method), {
    settings: async () => providerConfig({ openaiResponsesTransport: 'websocket' }),
    compressionSettings: async () => undefined
  });

  assert.equal(result.kind, 'provider_requests');
  assert.equal(result.calls.length, 1);
  assert.match(result.calls[0].url, /^https:\/\//);
  assert.match(result.calls[0].url, /responses\/compact/);
  assert.doesNotMatch(result.calls[0].providerName, /WebSocket$/);
});


test('LimCode WS chunks expose argument previews before the completed tool call', () => {
  const events = [];
  emitUnifiedChunk('request-tool-preview', {
    toolCallArgumentDeltas: [{
      callId: 'call-preview',
      name: 'write',
      argumentsDelta: '{"path":"demo.ts"',
      streamIndex: '0'
    }]
  }, (event) => events.push(event));
  emitUnifiedChunk('request-tool-preview', {
    functionCalls: [{ functionCall: { callId: 'call-preview', name: 'write', args: { path: 'demo.ts', content: 'x' } } }]
  }, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), [
    LlmEventType.ToolCallDelta,
    LlmEventType.ToolCallPreviewDone,
    LlmEventType.ToolCall
  ]);
  assert.equal(events[0].payload.calls[0].argumentsDelta, '{"path":"demo.ts"');
  assert.deepEqual(events[1].payload.callIds, ['call-preview']);
  assert.equal(events[2].payload.calls[0].argsJson, '{"path":"demo.ts","content":"x"}');
});

test('LimCode chunks preserve output item identity and late assistant phase events', () => {
  const events = [];
  emitUnifiedChunk('request-output-item', {
    textDelta: 'checking',
    outputItem: { id: 'message-output-0', ordinal: 0 }
  }, (event) => events.push(event));
  emitUnifiedChunk('request-output-item', {
    outputItem: { id: 'message-output-0', ordinal: 0, phase: 'commentary' },
    outputItemDone: { id: 'message-output-0', ordinal: 0, phase: 'commentary' }
  }, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), [
    LlmEventType.Delta,
    LlmEventType.OutputItemDone
  ]);
  assert.deepEqual(events[0].payload.outputItem, { id: 'message-output-0', ordinal: 0 });
  assert.deepEqual(events[1].payload.outputItem, {
    id: 'message-output-0', ordinal: 0, phase: 'commentary'
  });
});

test('transient output parts preserve thought/text/tool/text/tool order and update tools in place', () => {
  const outputItem = (id, ordinal, phase) => ({ id, ordinal, ...(phase ? { phase } : {}) });
  const tool = (callId, name, item, argumentsText = '') => ({
    id: `preview:${callId}`,
    callId,
    name,
    argumentsText,
    receivedChars: argumentsText.length,
    final: false,
    outputItem: item,
    createdAt: 1,
    updatedAt: 1
  });

  let parts = [];
  parts = appendReliableTransientTextPart(parts, {
    text: '分析', thought: true, outputItem: outputItem('reasoning-0', 0)
  });
  parts = appendReliableTransientTextPart(parts, {
    text: '先读取文件。', thought: false, outputItem: outputItem('message-1', 1)
  });
  let calls = [tool('call-read', 'read', outputItem('tool-2', 2), '{"path":')];
  parts = syncReliableTransientFunctionCallParts(parts, calls);
  parts = appendReliableTransientTextPart(parts, {
    text: '再写入结果。', thought: false, outputItem: outputItem('message-3', 3)
  });
  calls = [...calls, tool('call-write', 'write', outputItem('tool-4', 4), '{"path":')];
  parts = syncReliableTransientFunctionCallParts(parts, calls);

  assert.deepEqual(parts.map((part) => {
    if ('text' in part) return part.thought === true ? `thought:${part.text}` : `text:${part.text}`;
    return `tool:${part.functionCall.name}`;
  }), [
    'thought:分析',
    'text:先读取文件。',
    'tool:read',
    'text:再写入结果。',
    'tool:write'
  ]);

  calls = [
    tool('call-read', 'read', outputItem('tool-2', 2), '{"path":"a.txt"}'),
    calls[1]
  ];
  parts = syncReliableTransientFunctionCallParts(parts, calls);
  assert.equal(parts[2].id, 'call-read');
  assert.equal(parts[3].text, '再写入结果。');
  parts = applyReliableTransientOutputItem(parts, outputItem('message-1', 1, 'commentary'));
  assert.equal(parts[1].outputItem.phase, 'commentary');
});

test('terminal validation passes through non-2xx event-stream JSON errors unchanged', async () => {
  const body = JSON.stringify({
    error: {
      code: 503,
      status: 'UNAVAILABLE',
      message: 'provider unavailable'
    }
  });
  const original = new Response(body, {
    status: 503,
    headers: { 'content-type': 'text/event-stream' }
  });
  const guarded = createTerminalValidatedFetch(async () => original, 'gemini');

  const response = await guarded('https://example.invalid');
  assert.equal(response, original);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 503,
      status: 'UNAVAILABLE',
      message: 'provider unavailable'
    }
  });
});

test('terminal validation still rejects a truncated 2xx event stream', async () => {
  const guarded = createTerminalValidatedFetch(async () => new Response(
    'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  ), 'gemini');

  const response = await guarded('https://example.invalid');
  assert.equal(response.status, 200);
  await assert.rejects(response.text(), (error) => error?.code === 'LLM_STREAM_TRUNCATED');
});

test('Gemini stream chunks merge complementary call representations with the same stable id', () => {
  const events = [];

  emitUnifiedChunk('request-gemini-tool', {
    functionCalls: [{
      functionCall: {
        callId: 'call-gemini-stable',
        name: 'get_weather',
        args: { city: 'Paris' }
      }
    }],
    partsDelta: [{
      functionCall: {
        callId: 'call-gemini-stable',
        name: 'get_weather',
        args: { city: 'Paris' }
      },
      thoughtSignature: 'gemini:signature'
    }]
  }, (event) => events.push(event));

  assert.deepEqual(events.map((event) => event.type), [
    LlmEventType.ToolCallPreviewDone,
    LlmEventType.ToolCall
  ]);
  assert.deepEqual(events[0].payload.callIds, ['call-gemini-stable']);
  assert.equal(events[1].payload.calls.length, 1);
  assert.deepEqual(events[1].payload.calls[0], {
    id: 'call-gemini-stable',
    name: 'get_weather',
    argsJson: '{"city":"Paris"}',
    thoughtSignature: 'gemini:signature'
  });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const http = require('node:http');
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
const { LlmEventType } = require('../dist/extension/backend/world/modules/llm/events.js');

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

async function createTransportFallbackServer({ sendCreatedBeforeClose = false } = {}) {
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
          }), () => webSocket.terminate());
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
      requestCreatedAt: Date.now() - 120_000
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

  const result = await dryRunLlmProvider(chatRequest(), { settings: async () => config });

  assert.match(result.url, /^wss:\/\//);
  assert.match(result.providerName, /WebSocket$/);
  assert.equal(result.stream, true);
  assert.equal(result.body.type, 'response.create');
  assert.equal(result.body.store, false);
  assert.equal('stream' in result.body, false);
  assert.equal('background' in result.body, false);
  assert.equal('previous_response_id' in result.body, false);
  assert.equal('prompt_cache_options' in result.body, false);
  assert.equal(result.body.metadata?.nested?.prompt_cache_breakpoint, undefined);
  assert.equal(result.body.metadata?.nested?.keep, 'yes');
  assert.match(result.curl, /^# WebSocket mode/m);
  assert.match(result.curl, /^CONNECT wss:\/\//m);
  assert.match(result.curl, /"type": "response.create"/);
  assert.doesNotMatch(result.curl, new RegExp(rawApiKey));
  assert.doesNotMatch(result.maskedCurl, new RegExp(rawApiKey));
  assert.equal(result.maskedSecrets, true);
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

test('WS failure after the first Provider event never falls back to HTTP or replays the request', async () => {
  const server = await createTransportFallbackServer({ sendCreatedBeforeClose: true });
  try {
    const traces = [];
    const events = await runTransportFallbackRequest(
      server,
      'request-no-rescue-after-event',
      traces,
      'conversation-no-rescue-after-event'
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

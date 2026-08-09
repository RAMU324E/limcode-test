import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const {
  startLlmProvider
} = require('../../dist/extension/backend/capabilities/llmProvider.js');
const {
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require('../../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js');

function providerConfig(baseUrl) {
  return {
    id: 'provider-ws-policy',
    name: 'WS Policy Fixture',
    provider: 'openai-responses',
    baseUrl,
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
    apiKey: 'sk-test',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'websocket',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function reliableRequest(id, conversationId, attemptOverrides = {}) {
  return {
    id,
    conversationId,
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools: [],
    reliableProviderAttempt: {
      attemptSeq: 5,
      maxAttempts: 5,
      requestCreatedAt: Date.now(),
      ...attemptOverrides
    }
  };
}

async function createFallbackServer({ sendCreatedBeforeClose = false } = {}) {
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
      for (const event of [
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
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketCalls += 1;
      webSocket.once('message', () => {
        if (!sendCreatedBeforeClose) {
          webSocket.terminate();
          return;
        }
        webSocket.send(JSON.stringify({
          type: 'response.created',
          response: { id: `resp_ws_${webSocketCalls}` }
        }), () => webSocket.terminate());
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

async function runFallbackRequest(server, id, conversationId, traces, attemptOverrides) {
  const events = [];
  await startLlmProvider(
    reliableRequest(id, conversationId, attemptOverrides),
    (event) => events.push(event),
    {
      settings: async () => providerConfig(server.baseUrl),
      onTransportTrace: (trace) => traces.push(trace)
    }
  );
  return events;
}

test('WS budget exhaustion falls back once to HTTP and applies a short conversation cooldown', async () => {
  const server = await createFallbackServer();
  try {
    const firstTraces = [];
    const first = await runFallbackRequest(server, 'fallback-1', 'conversation-fallback', firstTraces);
    assert.equal(first.some((event) => event.type === 'llm:error'), false);
    assert.equal(first.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.ok(firstTraces.some((trace) => trace.phase === 'http_fallback'));

    const secondTraces = [];
    const second = await runFallbackRequest(server, 'fallback-2', 'conversation-fallback', secondTraces);
    assert.equal(second.some((event) => event.type === 'llm:error'), false);
    assert.equal(second.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 2, webSocketCalls: 1 });
    assert.ok(secondTraces.some((trace) => trace.phase === 'http_cooldown'));
  } finally {
    await server.close();
  }
});

test('an exhausted 120s retry budget goes directly to HTTP instead of opening another WS', async () => {
  const server = await createFallbackServer();
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'time-budget-fallback',
      'conversation-time-budget-fallback',
      traces,
      { attemptSeq: 2, maxAttempts: 5, requestCreatedAt: Date.now() - 120_001 }
    );
    assert.equal(events.some((event) => event.type === 'llm:error'), false);
    assert.equal(events.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 0 });
    assert.ok(traces.some((trace) =>
      trace.phase === 'http_fallback' && trace.reason === 'ws_retry_time_budget_exhausted'
    ));
  } finally {
    await server.close();
  }
});

test('a WS failure after the first Provider event never falls back or replays', async () => {
  const server = await createFallbackServer({ sendCreatedBeforeClose: true });
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'no-fallback-after-event',
      'conversation-no-fallback-after-event',
      traces
    );
    assert.equal(events.some((event) => event.type === 'llm:error'), true);
    assert.equal(events.some((event) => event.type === 'llm:done'), false);
    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), false);
  } finally {
    await server.close();
  }
});

test('heartbeat invalidates an OPEN socket that stops answering pong', async () => {
  resetOpenAIResponsesWebSocketSessions();
  let connectionCount = 0;
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    autoPong: false
  });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    connectionCount += 1;
    socket.on('message', () => {
      const responseId = `resp_heartbeat_${connectionCount}`;
      socket.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: responseId, status: 'completed', output: [] }
      }));
    });
  });
  const address = server.address();
  const options = {
    sessionKey: 'tracked-heartbeat-policy',
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    headers: { Authorization: 'Bearer test' },
    body: { model: 'gpt-test', input: [{ role: 'user', content: 'hello' }] },
    format: {
      createStreamState: () => ({}),
      decodeStreamChunk: () => ({}),
      decodeResponse: () => ({ content: { role: 'model', parts: [] } }),
      encodeRequest: () => ({ input: [] })
    },
    timeouts: {
      handshakeMs: 100,
      sendMs: 100,
      firstEventMs: 100,
      eventIdleMs: 100,
      responseMs: 500,
      heartbeatIntervalMs: 10,
      pongTimeoutMs: 30,
      preSendProbeStaleMs: 20,
      preSendProbeTimeoutMs: 20
    }
  };
  try {
    for await (const _chunk of streamOpenAIResponsesWebSocketSession(options)) { /* drain */ }
    await new Promise((resolve) => setTimeout(resolve, 55));
    for await (const _chunk of streamOpenAIResponsesWebSocketSession(options)) { /* drain */ }
    assert.equal(connectionCount, 2);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});

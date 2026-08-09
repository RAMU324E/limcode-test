const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const {
  LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require('../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js');

async function formatForTest() {
  const unified = await import('unified-llm-provider');
  return new unified.OpenAIResponsesFormat('gpt-test');
}

function requestBody(format, contents, overrides = {}) {
  return {
    ...format.encodeRequest({ contents }, true),
    ...overrides
  };
}

function user(text) {
  return { role: 'user', parts: [{ text }] };
}

function model(text) {
  return { role: 'model', parts: [{ text }] };
}

function sendCompleted(socket, id, outputItems, options = {}) {
  socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
  for (const [outputIndex, item] of outputItems.entries()) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && block.text) {
          socket.send(JSON.stringify({
            type: 'response.output_text.delta',
            response_id: id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: block.text
          }));
        }
      }
    }
    socket.send(JSON.stringify({
      type: 'response.output_item.done',
      response_id: id,
      output_index: outputIndex,
      item
    }));
  }
  socket.send(JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      // The real compatibility endpoint behaves this way: output_item.done is complete,
      // while response.completed.response.output is empty.
      output: options.completedOutput ?? [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }), options.afterCompleted);
}

async function createServer(onRequest, serverOptions = {}) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    ...serverOptions
  });
  await once(server, 'listening');
  let connection = 0;
  server.on('connection', (socket, upgradeRequest) => {
    const connectionIndex = connection++;
    socket.on('message', (raw) => onRequest(socket, JSON.parse(raw.toString()), connectionIndex, upgradeRequest));
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function collect(options) {
  const chunks = [];
  for await (const chunk of streamOpenAIResponsesWebSocketSession(options)) chunks.push(chunk);
  return chunks;
}

function streamOptions(server, format, sessionKey, body, overrides = {}) {
  return {
    sessionKey,
    url: server.url,
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body,
    format,
    ...overrides
  };
}

test('Codex-style WS continuation uses output_item.done and never duplicates prior assistant output', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'assistant-1', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    const decisions = [];
    const firstChunks = await collect(streamOptions(
      server,
      format,
      'assistant-prefix',
      requestBody(format, [user('user-1')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));
    assert.equal(firstChunks.map((chunk) => chunk.textDelta ?? '').join(''), 'assistant-1');

    await collect(streamOptions(
      server,
      format,
      'assistant-prefix',
      requestBody(format, [user('user-1'), model('assistant-1'), user('user-2')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 2);
    assert.equal(requests[0].connection, requests[1].connection);
    assert.equal(requests[1].request.previous_response_id, 'resp_1');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].role, 'user');
    assert.match(JSON.stringify(requests[1].request.input[0]), /user-2/);
    assert.doesNotMatch(JSON.stringify(requests[1].request.input), /assistant-1/);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[1].mode, 'incremental');
    assert.equal(decisions[1].reason, 'matched_exact_prefix');
    assert.equal(LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION, 'codex-output-items-v1');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('changed handshake identity reconnects with fresh auth and clears connection-local continuation', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_handshake_identity',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'authenticated answer', annotations: [] }]
  };
  const server = await createServer((socket, request, connection, upgradeRequest) => {
    requests.push({
      request,
      connection,
      authorization: upgradeRequest.headers.authorization,
      tenant: upgradeRequest.headers['x-tenant']
    });
    sendCompleted(socket, `resp_handshake_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'handshake-identity',
      requestBody(format, [user('first')]),
      {
        headers: {
          Authorization: 'Bearer old-key',
          'X-Tenant': 'tenant-a',
          'Content-Type': 'application/json'
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));
    await collect(streamOptions(
      server,
      format,
      'handshake-identity',
      requestBody(format, [user('first'), model('authenticated answer'), user('second')]),
      {
        headers: {
          authorization: 'Bearer new-key',
          'x-tenant': 'tenant-b',
          'content-type': 'application/json'
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal(requests[0].authorization, 'Bearer old-key');
    assert.equal(requests[1].authorization, 'Bearer new-key');
    assert.equal(requests[0].tenant, 'tenant-a');
    assert.equal(requests[1].tenant, 'tenant-b');
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[1].connectionReused, false);
    assert.equal(decisions[1].connectionReason, 'handshake_identity_changed');
    assert.equal(decisions[1].reason, 'new_socket_generation');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a physical WS reconnect clears connection-local previous_response_id and full-replays context', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_reconnect',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'before reconnect', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_reconnect_${requests.length}`, requests.length === 1 ? [assistant] : [], {
      afterCompleted: requests.length === 1 ? () => socket.close() : undefined
    });
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'reconnect-full-replay',
      requestBody(format, [user('first')])
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'reconnect-full-replay',
      requestBody(format, [user('first'), model('before reconnect'), user('second')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[0].connectionReused, false);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[0].reason, 'new_socket_generation');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('aborting an in-flight response invalidates continuation before the next injected input', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  let resolveHeldRequest;
  const heldRequest = new Promise((resolve) => { resolveHeldRequest = resolve; });
  const assistant = {
    id: 'msg_abort_base',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'base answer', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      sendCompleted(socket, 'resp_abort_base', [assistant]);
      return;
    }
    if (requests.length === 2) {
      resolveHeldRequest();
      return;
    }
    sendCompleted(socket, 'resp_after_abort', []);
  });
  try {
    const format = await formatForTest();
    const context = [user('first'), model('base answer')];
    await collect(streamOptions(server, format, 'abort-invalidates', requestBody(format, [user('first')])));

    const abort = new AbortController();
    const interrupted = collect(streamOptions(
      server,
      format,
      'abort-invalidates',
      requestBody(format, [...context, user('interrupted input')]),
      { signal: abort.signal }
    ));
    await heldRequest;
    abort.abort(new Error('synthetic user steer'));
    await assert.rejects(interrupted, /synthetic user steer/);

    await collect(streamOptions(
      server,
      format,
      'abort-invalidates',
      requestBody(format, [...context, user('interrupted input'), user('injected follow-up')])
    ));

    assert.equal(requests.length, 3);
    assert.equal(requests[1].request.previous_response_id, 'resp_abort_base');
    assert.notEqual(requests[1].connection, requests[2].connection);
    assert.equal('previous_response_id' in requests[2].request, false);
    assert.equal(requests[2].request.input.length, 4);
    assert.match(JSON.stringify(requests[2].request.input), /injected follow-up/);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('tool argument deltas stream independently and completed function calls are not duplicated in the suffix', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const toolCall = {
    id: 'fc_item_1',
    type: 'function_call',
    call_id: 'call_write_1',
    name: 'write',
    arguments: '{"path":"a.txt","content":"hello"}'
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_tool_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        response_id: 'resp_tool_1',
        output_index: 0,
        item: { ...toolCall, arguments: '' }
      }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_tool_1',
        item_id: toolCall.id,
        output_index: 0,
        delta: '{"path":"a.txt",'
      }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_tool_1',
        item_id: toolCall.id,
        output_index: 0,
        delta: '"content":"hello"}'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_tool_1',
        output_index: 0,
        item: toolCall
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_tool_1', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }
      }));
      return;
    }
    sendCompleted(socket, 'resp_tool_2', []);
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'tool-prefix',
      requestBody(format, [user('write a file')])
    ));
    const streamedArgs = chunks
      .flatMap((chunk) => chunk.toolCallArgumentDeltas ?? [])
      .reduce((value, delta) => delta.replace ? delta.argumentsDelta : value + delta.argumentsDelta, '');
    assert.equal(streamedArgs, toolCall.arguments);

    const modelToolCall = {
      role: 'model',
      parts: [{
        functionCall: {
          name: toolCall.name,
          args: { path: 'a.txt', content: 'hello' },
          callId: toolCall.call_id
        }
      }]
    };
    const toolResult = {
      role: 'user',
      parts: [{
        functionResponse: {
          name: toolCall.name,
          response: { ok: true },
          callId: toolCall.call_id
        }
      }]
    };
    await collect(streamOptions(
      server,
      format,
      'tool-prefix',
      requestBody(format, [user('write a file'), modelToolCall, toolResult])
    ));

    assert.equal(requests[1].request.previous_response_id, 'resp_tool_1');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].type, 'function_call_output');
    assert.equal(requests[1].request.input[0].call_id, toolCall.call_id);
    assert.equal(requests[1].request.input.some((item) => item.type === 'function_call'), false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a first-event black hole emits transport phases, invalidates the socket, and releases the session lock', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) return;
    sendCompleted(socket, 'resp_after_first_event_timeout', [{
      id: 'msg_after_first_event_timeout',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'recovered', annotations: [] }]
    }]);
  });
  try {
    const format = await formatForTest();
    const firstPhases = [];
    await assert.rejects(
      collect(streamOptions(
        server,
        format,
        'first-event-black-hole',
        requestBody(format, [user('wait forever')]),
        {
          onPhase: (phase) => firstPhases.push(phase),
          timeouts: { firstEventMs: 40, eventIdleMs: 100, responseMs: 500, sendMs: 100, handshakeMs: 100 }
        }
      )),
      (error) => error?.code === 'LLM_TRANSPORT_TIMEOUT'
        && error?.phase === 'first_event'
        && error?.timeoutMs === 40
    );
    assert.deepEqual(firstPhases.map((phase) => phase.phase).slice(0, 6), [
      'lock_wait', 'lock_acquired', 'socket_opening', 'socket_opened', 'send_started', 'request_sent'
    ]);
    assert.equal(firstPhases.some((phase) => phase.phase === 'first_raw_event'), false);
    assert.equal(firstPhases.at(-1)?.phase, 'timeout');
    assert.equal(firstPhases.at(-1)?.timeoutPhase, 'first_event');

    const recoveryPhases = [];
    const chunks = await collect(streamOptions(
      server,
      format,
      'first-event-black-hole',
      requestBody(format, [user('wait forever'), user('retry safely')]),
      {
        onPhase: (phase) => recoveryPhases.push(phase),
        timeouts: { firstEventMs: 100, eventIdleMs: 100, responseMs: 500, sendMs: 100, handshakeMs: 100 }
      }
    ));
    assert.equal(chunks.map((chunk) => chunk.textDelta ?? '').join(''), 'recovered');
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.ok(recoveryPhases.some((phase) => phase.phase === 'first_raw_event'));
    assert.ok(recoveryPhases.some((phase) => phase.phase === 'first_semantic_event'));
    assert.equal(recoveryPhases.at(-1)?.phase, 'terminal');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a relay that stops after complete tool arguments fails on the event-idle deadline and releases the session lock', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_stalled_tool' } }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_stalled_tool',
        item_id: 'fc_stalled_tool',
        output_index: 0,
        delta: '{"command":"printf ok\\n"}'
      }));
      return;
    }
    sendCompleted(socket, 'resp_after_stall', []);
  });
  try {
    const format = await formatForTest();
    await assert.rejects(
      collect(streamOptions(
        server,
        format,
        'stalled-tool-call',
        requestBody(format, [user('run a command')]),
        { timeouts: { firstEventMs: 100, eventIdleMs: 40, responseMs: 500, sendMs: 100, handshakeMs: 100 } }
      )),
      (error) => error?.code === 'LLM_TRANSPORT_TIMEOUT'
        && error?.phase === 'event_idle'
        && error?.timeoutMs === 40
    );

    await collect(streamOptions(
      server,
      format,
      'stalled-tool-call',
      requestBody(format, [user('run a command'), user('retry safely')]),
      { timeouts: { firstEventMs: 100, eventIdleMs: 100, responseMs: 500, sendMs: 100, handshakeMs: 100 } }
    ));
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('OPEN WebSocket 空闲超过 55 分钟 age cap 后必须淘汰并以完整上下文重连', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  const requests = [];
  const assistant = {
    id: 'msg_idle_ttl',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'before idle ttl', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_idle_ttl_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-target',
      requestBody(format, [user('first')])
    ));

    fakeNow += 55 * 60 * 1_000 + 1;
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-eviction-trigger',
      requestBody(format, [user('trigger eviction')])
    ));
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-target',
      requestBody(format, [user('first'), model('before idle ttl'), user('after idle')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    assert.equal(requests.length, 3);
    assert.notEqual(requests[0].connection, requests[2].connection);
    assert.equal('previous_response_id' in requests[2].request, false);
    assert.equal(requests[2].request.input.length, 3);
    assert.equal(decisions[0].connectionReused, false);
    assert.equal(decisions[0].mode, 'full');
  } finally {
    Date.now = realDateNow;
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('WS reuse admission keeps a healthy OPEN socket across a 55s inter-turn pause', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  const requests = [];
  const decisions = [];
  const phases = [];
  const assistant = {
    id: 'msg_reuse_idle',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'reuse baseline', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_reuse_idle_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [user('first')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    fakeNow += 55_000;
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [user('first'), model('reuse baseline'), user('second')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    fakeNow += 55_000;
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [
        user('first'),
        model('reuse baseline'),
        user('second'),
        user('third')
      ]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 3);
    assert.equal(requests[0].connection, requests[1].connection);
    assert.equal(requests[1].request.previous_response_id, 'resp_reuse_idle_1');
    assert.equal(decisions[1].connectionReason, 'reused');
    assert.equal(decisions[1].mode, 'incremental');

    assert.equal(requests[1].connection, requests[2].connection);
    assert.equal(requests[2].request.previous_response_id, 'resp_reuse_idle_2');
    assert.equal(decisions[2].connectionReused, true);
    assert.equal(decisions[2].connectionReason, 'reused');
    assert.equal(decisions[2].mode, 'incremental');
    assert.ok(phases.some((phase) => phase.phase === 'socket_probe_started'));
    assert.ok(phases.some((phase) => phase.phase === 'socket_probe_succeeded'));
  } finally {
    Date.now = realDateNow;
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('heartbeat invalidates an OPEN socket that stops answering pong before the next request', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_heartbeat_${requests.length}`, []);
  }, { autoPong: false });
  const timeouts = {
    handshakeMs: 100,
    sendMs: 100,
    firstEventMs: 100,
    eventIdleMs: 100,
    responseMs: 500,
    heartbeatIntervalMs: 10,
    pongTimeoutMs: 30,
    preSendProbeStaleMs: 20,
    preSendProbeTimeoutMs: 20
  };
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'heartbeat-unresponsive',
      requestBody(format, [user('first')]),
      { timeouts }
    ));
    await new Promise((resolve) => setTimeout(resolve, 55));
    await collect(streamOptions(
      server,
      format,
      'heartbeat-unresponsive',
      requestBody(format, [user('first'), user('second')]),
      { timeouts }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a 1000 close before response terminal is retryable, while a policy close remains permanent', { concurrency: false }, async () => {
  for (const fixture of [
    { closeCode: 1000, reason: 'normal transport close', retryable: true },
    { closeCode: 1008, reason: 'policy violation', retryable: false }
  ]) {
    resetOpenAIResponsesWebSocketSessions();
    const server = await createServer((socket) => {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp_close_${fixture.closeCode}` } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: `resp_close_${fixture.closeCode}`,
        item_id: `msg_close_${fixture.closeCode}`,
        output_index: 0,
        content_index: 0,
        delta: 'partial output'
      }));
      socket.close(fixture.closeCode, fixture.reason);
    });
    try {
      const format = await formatForTest();
      await assert.rejects(
        collect(streamOptions(
          server,
          format,
          `pre-terminal-close-${fixture.closeCode}`,
          requestBody(format, [user('must reach a Responses terminal event')])
        )),
        (error) => error?.name === 'WebSocketCloseError'
          && error?.closeCode === fixture.closeCode
          && error?.phase === 'streaming'
          && error?.receivedServerEvent === true
          && error?.retryable === fixture.retryable
      );
    } finally {
      resetOpenAIResponsesWebSocketSessions();
      await server.close();
    }
  }
});

test('response.cancelled is surfaced as a provider error instead of a completed response', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const server = await createServer((socket) => {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_cancelled' } }));
    socket.send(JSON.stringify({ type: 'response.cancelled', response_id: 'resp_cancelled' }));
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'provider-cancelled',
      requestBody(format, [user('cancelled upstream')])
    ));
    assert.equal(chunks.some((chunk) => chunk.error), true);
    assert.match(JSON.stringify(chunks), /response\.cancelled/);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

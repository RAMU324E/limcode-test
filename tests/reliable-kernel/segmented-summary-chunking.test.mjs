import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createLlmProviderCapability,
  dryRunCompactLlmProvider
} from '../../dist/extension/backend/capabilities/llmProvider.js';

const PROVIDERS = [
  ['openai-compatible', 'https://example.test/v1'],
  ['openai-responses', 'https://example.test/v1'],
  ['claude', 'https://api.anthropic.com/v1'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta']
];

function providerConfig(provider, baseUrl) {
  return {
    id: `summary-${provider}`,
    name: `Summary ${provider}`,
    provider,
    baseUrl,
    model: provider === 'claude' ? 'claude-sonnet-test' : provider === 'gemini' ? 'gemini-test' : 'gpt-test',
    models: [],
    apiKey: 'offline-placeholder-key',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    contextWindowTokens: 65_536,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function compactRequest(provider) {
  const methodConfigSnapshot = {
    id: `segmented-${provider}`,
    name: `Segmented ${provider}`,
    kind: 'segmented_summary',
    trigger: { mode: 'manual' },
    llmSummary: {
      targetTokens: 1_000,
      generationConfig: { maxOutputTokens: 2_048 }
    },
    createdAt: 1,
    updatedAt: 1
  };
  const largeText = `TEXT-START-${'ordinary-history '.repeat(28_000)}-TEXT-END`;
  const oversizedToolResult = `TOOL-START-${'tool-output '.repeat(60_000)}-TOOL-END`;
  return {
    request: {
      id: `oversized-${provider}`,
      blockId: `block-${provider}`,
      conversationId: `conversation-${provider}`,
      methodKind: 'segmented_summary',
      methodConfigSnapshot,
      contents: [],
      segments: [[
        { role: 'user', parts: [{ text: largeText }] },
        {
          role: 'model',
          parts: [{ id: 'call-oversized', functionCall: { name: 'read', args: { path: '/fixture' } } }]
        },
        {
          role: 'user',
          parts: [{
            id: 'call-oversized',
            functionResponse: { name: 'read', response: { text: oversizedToolResult } }
          }]
        }
      ]],
      sourceHash: `source-${provider}`
    },
    largeText,
    oversizedToolResult
  };
}

test('segmented summary preserves overflow text across leaf chunks and hierarchy merge requests', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: `OVERFLOW-START-${'overflow-history '.repeat(12_000)}-OVERFLOW-END` }]
  }]];
  const result = await dryRunCompactLlmProvider(fixture.request, {
    settings: async () => ({
      ...providerConfig(provider, 'https://example.test/v1'),
      contextWindowTokens: 30_000
    }),
    compressionSettings: async () => undefined
  });
  assert.equal(result.kind, 'provider_requests');
  assert.ok(result.calls.length >= 2);
  assert.match(result.note, /leaf summary requests/);
  assert.equal(result.calls.some((call) => call.label === 'Summary replacement merge'), false);
  const wire = result.calls.map((call) => call.bodyText).join('\n');
  assert.match(wire, /OVERFLOW-START/);
  assert.match(wire, /OVERFLOW-END/);
  assert.doesNotMatch(wire, /hierarchical compression fallback/);
});

test('segmented summary executes leaf requests before a runtime hierarchy merge', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: `RUNTIME-START-${'runtime-history '.repeat(20_000)}-RUNTIME-END` }]
  }]];
  const requestBodies = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const structured = [
    '目标', '- 无', '',
    '重要约束、决定和准确标识', '- 无', '',
    '工作状态', '  - 已完成', '    - 无',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- 无'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requestBodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${requestBodies.length}`,
      object: 'chat.completion',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: structured }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
    activeRequests -= 1;
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const settings = {
    ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
    contextWindowTokens: 30_000,
    stream: false
  };
  const options = {
    settings: async () => settings,
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  try {
    const dryRun = await dryRunCompactLlmProvider(fixture.request, options);
    assert.equal(dryRun.kind, 'provider_requests');
    const terminal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('compact runtime test timed out')), 30_000);
      capability.compact(fixture.request, (event) => {
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          reject(new Error(event.payload.message));
        }
        if (event.type === 'llm:compactDone') {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });
    assert.ok(requestBodies.length > dryRun.calls.length, 'runtime must add at least one hierarchy merge call');
    assert.ok(requestBodies.length <= 64, 'leaf + hierarchy + prior merge calls must stay inside the hard budget');
    assert.ok(maxActiveRequests <= 3, 'summary Provider concurrency must remain bounded at three');
    const leafWire = requestBodies.slice(0, dryRun.calls.length).join('\n');
    assert.match(leafWire, /RUNTIME-START/);
    assert.match(leafWire, /RUNTIME-END/);
    assert.match(requestBodies.at(-1), /新增分段摘要/);
    const finalText = terminal.payload.result.contents[0].parts[0].text;
    assert.match(finalText, /RUNTIME-START/);
    assert.match(finalText, /RUNTIME-END/);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('segmented summary never retries a logical call or the whole operation after a Provider failure', async () => {
  let requestCount = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    requestCount += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: 'Unsupported parameter: max_output_tokens', type: 'invalid_request_error' }
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{ role: 'user', parts: [{ text: 'one bounded leaf' }] }]];
  const options = {
    settings: async () => ({
      ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
      stream: false,
      retryOnError: true,
      retryMaxAttempts: -1
    }),
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  const events = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('compact failure test timed out')), 10_000);
      capability.compact(fixture.request, (event) => {
        events.push(event);
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    assert.equal(requestCount, 1);
    assert.equal(events.some((event) => event.type === 'llm:retryScheduled'), false);
    const terminal = events.find((event) => event.type === 'llm:compactError');
    assert.equal(terminal.payload.retryMaxAttempts, 0);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});


test('deterministic fallback preserves first and last anchors beyond the per-field fact cap', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.methodConfigSnapshot.llmSummary.targetTokens = 4_000;
  const facts = [
    'ANCHOR-FIRST',
    ...Array.from({ length: 80 }, (_, index) => `MIDDLE-${String(index).padStart(2, '0')}`),
    'ANCHOR-LAST'
  ];
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: facts.map((fact) => `- ${fact}`).join('\n') }]
  }]];
  const emptyStructured = [
    '目标', '- 无', '',
    '重要约束、决定和准确标识', '- 无', '',
    '工作状态', '  - 已完成', '    - 无',
    '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
    '下一步', '- 无', '', '相关文件', '- 无'
  ].join('\n');
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-anchor', object: 'chat.completion', created: 1, model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: emptyStructured }, finish_reason: 'stop' }]
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const options = {
    settings: async () => ({
      ...providerConfig(provider, `http://127.0.0.1:${address.port}/v1`),
      stream: false
    }),
    compressionSettings: async () => undefined
  };
  const capability = createLlmProviderCapability(options);
  try {
    const terminal = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('anchor retention test timed out')), 10_000);
      capability.compact(fixture.request, (event) => {
        if (event.type === 'llm:compactError') {
          clearTimeout(timeout);
          reject(new Error(event.payload.message));
        }
        if (event.type === 'llm:compactDone') {
          clearTimeout(timeout);
          resolve(event);
        }
      });
    });
    const text = terminal.payload.result.contents[0].parts[0].text;
    assert.match(text, /ANCHOR-FIRST/);
    assert.match(text, /ANCHOR-LAST/);
  } finally {
    capability.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const [provider, baseUrl] of PROVIDERS) {
  test(`segmented summary splits one oversized source group safely for ${provider}`, async () => {
    const fixture = compactRequest(provider);
    const result = await dryRunCompactLlmProvider(fixture.request, {
      settings: async () => providerConfig(provider, baseUrl),
      compressionSettings: async () => undefined
    });

    assert.equal(result.kind, 'provider_requests');
    assert.ok(result.calls.length >= 2, 'one oversized source group must become multiple bounded calls');
    assert.match(result.note, /leaf summary requests/);
    assert.equal(result.calls.some((call) => call.label === 'Summary replacement merge'), false);
    const wire = result.calls.map((call) => call.bodyText).join('\n');
    assert.match(wire, /TEXT-START/);
    assert.match(wire, /TEXT-END/);
    assert.doesNotMatch(wire, /hierarchical compression fallback/);
    assert.match(wire, /TOOL-START/);
    assert.match(wire, /TOOL-END/);
    assert.ok(result.calls.every((call) => call.bodyText.length < fixture.oversizedToolResult.length));
  });
}

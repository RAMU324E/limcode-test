import assert from 'node:assert/strict';
import test from 'node:test';
import { dryRunCompactLlmProvider } from '../../dist/extension/backend/capabilities/llmProvider.js';

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

test('segmented summary collapses chunk overflow into one explicit hierarchical descriptor', async () => {
  const provider = 'openai-compatible';
  const fixture = compactRequest(provider);
  fixture.request.segments = [[{
    role: 'user',
    parts: [{ text: `OVERFLOW-START-${'overflow-history '.repeat(30_000)}-OVERFLOW-END` }]
  }]];
  const result = await dryRunCompactLlmProvider(fixture.request, {
    settings: async () => ({
      ...providerConfig(provider, 'https://example.test/v1'),
      contextWindowTokens: 30_000
    }),
    compressionSettings: async () => undefined
  });
  assert.equal(result.kind, 'provider_requests');
  assert.ok(result.calls.length <= 16);
  const wire = result.calls.map((call) => call.bodyText).join('\n');
  assert.match(wire, /type=chunk_overflow/);
  assert.match(wire, /collapsedChunkCount=\d+/);
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
    assert.ok(result.calls.length <= 16);
    const wire = result.calls.map((call) => call.bodyText).join('\n');
    assert.match(wire, /TEXT-START/);
    assert.match(wire, /TEXT-END/);
    assert.match(wire, /LimCode hierarchical compression fallback/);
    assert.match(wire, /type=tool_exchange/);
    assert.match(wire, /sha256=[a-f0-9]{64}/);
    assert.match(wire, /originalTokens=\d+/);
    assert.doesNotMatch(wire, /TOOL-START/);
    assert.doesNotMatch(wire, /TOOL-END/);
    assert.ok(result.calls.every((call) => call.bodyText.length < fixture.oversizedToolResult.length));
  });
}

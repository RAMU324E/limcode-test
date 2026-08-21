import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  createTerminalValidatedFetch
} = require(path.join(root, 'dist/extension/backend/capabilities/terminalValidatedFetch.js'));
const {
  summarizeLlmRawError
} = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
const unified = await import('unified-llm-provider');

const callId = 'super-secret-call-id';
const privateOutput = 'private-output-do-not-log';
const providers = ['openai-compatible', 'deepseek', 'openai-responses', 'claude', 'gemini'];

function unifiedToolExchange() {
  return {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'edit', args: { path: 'secret.txt' }, callId } }]
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'edit', response: { output: privateOutput }, callId } }]
      }
    ]
  };
}

async function captureProviderWire(providerKind) {
  let bodyText;
  let returnedResponse;
  const traces = [];
  const remoteField = providerKind === 'openai-compatible' || providerKind === 'deepseek'
    ? 'tool_call_id'
    : providerKind === 'openai-responses'
      ? 'call_id'
      : providerKind === 'claude'
        ? 'tool_use_id'
        : 'functionResponse.name';
  const baseFetch = async (_input, init) => {
    bodyText = String(init.body);
    returnedResponse = new Response(JSON.stringify({
      error: { message: `missing required field ${remoteField}` }
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' }
    });
    return returnedResponse;
  };
  const guardedFetch = createTerminalValidatedFetch(baseFetch, providerKind, {
    onWireInvariantTrace: (trace) => traces.push(trace)
  });
  const registry = unified.createBootstrapExtensionRegistry();
  const provider = unified.createLLMFromConfig({
    provider: providerKind,
    model: providerKind === 'gemini' ? 'gemini-2.5-flash' : 'test-model',
    apiKey: 'super-secret-api-key',
    baseUrl: 'https://provider.invalid/v1',
    fetch: guardedFetch
  }, registry.llmProviders);
  const result = await provider.chat(unifiedToolExchange(), {
    inputFormat: 'unified',
    outputFormat: 'unified'
  });
  return { bodyText, body: JSON.parse(bodyText), result, traces };
}

function assertWireToolResult(providerKind, body) {
  if (providerKind === 'openai-compatible' || providerKind === 'deepseek') {
    const item = body.messages.find((message) => message.role === 'tool');
    assert.equal(item.tool_call_id, callId);
    return;
  }
  if (providerKind === 'openai-responses') {
    const item = body.input.find((entry) => entry.type === 'function_call_output');
    assert.equal(item.call_id, callId);
    return;
  }
  if (providerKind === 'claude') {
    const item = body.messages.flatMap((message) => message.content)
      .find((entry) => entry.type === 'tool_result');
    assert.equal(item.tool_use_id, callId);
    return;
  }
  const item = body.contents.flatMap((content) => content.parts)
    .find((part) => part.functionResponse)?.functionResponse;
  assert.equal(item.id, callId);
  assert.equal(item.name, 'edit');
}

for (const providerKind of providers) {
  test(`${providerKind} final fetch validates its actual wire tool-result shape and emits only safe evidence`, async () => {
    const captured = await captureProviderWire(providerKind);
    assertWireToolResult(providerKind, captured.body);
    assert.equal(captured.traces.length, 1);
    const trace = captured.traces[0];
    assert.equal('provider' in trace, false);
    assert.equal(
      trace.bodySha256,
      createHash('sha256').update(Buffer.from(captured.bodyText, 'utf8')).digest('hex')
    );
    assert.equal(trace.messageCount, 2);
    assert.equal(trace.toolItems.length, 1);
    assert.match(trace.toolItems[0].index, /^(?:messages|input|contents)\[/);
    assert.equal(trace.toolItems[0].idSha256, createHash('sha256').update(callId).digest('hex'));

    const serializedTrace = JSON.stringify(trace);
    assert.doesNotMatch(serializedTrace, new RegExp(callId));
    assert.doesNotMatch(serializedTrace, new RegExp(privateOutput));
    assert.doesNotMatch(serializedTrace, /api.?key|authorization|headers/i);

    const error = captured.result.error;
    assert.ok(error, 'the synthetic 422 response must remain a provider error');
    const summary = summarizeLlmRawError(error);
    assert.match(summary, /local wire invariant passed/i);
    assert.match(summary, new RegExp(trace.bodySha256));
  });
}

test('required provider-specific IDs fail closed before fetch', async () => {
  const invalidBodies = [
    ['openai-compatible', { messages: [{ role: 'tool', content: 'x' }] }],
    ['deepseek', { messages: [{ role: 'tool', content: 'x' }] }],
    ['openai-responses', { input: [{ type: 'function_call_output', output: 'x' }] }],
    ['claude', { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }]
  ];
  for (const [providerKind, body] of invalidBodies) {
    let fetchCalls = 0;
    const guarded = createTerminalValidatedFetch(async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }, providerKind);
    await assert.rejects(
      guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(body) }),
      /wire invariant.*(?:tool_call_id|call_id|tool_use_id)/i
    );
    assert.equal(fetchCalls, 0, `${providerKind} malformed wire body reached fetch`);
  }
});

test('Gemini validates functionResponse protocol without inventing an OpenAI ID requirement', async () => {
  let fetchCalls = 0;
  const traces = [];
  const guarded = createTerminalValidatedFetch(async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 400 });
  }, 'gemini', { onWireInvariantTrace: (trace) => traces.push(trace) });
  const body = {
    contents: [{ role: 'user', parts: [{ functionResponse: { name: 'edit', response: { ok: true } } }] }]
  };
  await guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(fetchCalls, 1);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].toolItems[0].idSha256, undefined);

  const malformed = {
    contents: [{ role: 'user', parts: [{ functionResponse: { response: { ok: true } } }] }]
  };
  await assert.rejects(
    guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(malformed) }),
    /Gemini.*functionResponse\.name/i
  );
  assert.equal(fetchCalls, 1);
});

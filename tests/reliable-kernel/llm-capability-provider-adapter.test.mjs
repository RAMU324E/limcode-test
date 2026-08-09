import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(root, 'dist/extension/backend/reliableKernel/index.js')).href);

function request() {
  return {
    kind: 'full-model-request',
    modelRequestId: 'model-request-adapter',
    conversationId: 'conversation-adapter',
    attemptSeq: '1',
    socketGeneration: '1',
    providerId: 'provider-config',
    modelId: 'model-a',
    authoritySnapshot: {
      model: { providerConfigId: 'provider-config', provider: 'openai-compatible', modelId: 'model-a' },
      toolPolicy: {
        allowedTools: ['echo'],
        preset: 'custom',
        sourceConfigs: { 'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] } }
      },
      systemPrompt: { text: 'system instruction' }
    },
    recipe: {
      tools: [
        { name: 'echo', description: 'echo', parameters: { type: 'object' } },
        {
          name: 'exa_search', description: 'native MCP search', parameters: { type: 'object' },
          source: { kind: 'mcp', sourceId: 'mcp-exa', sourceName: 'EXA', originalToolName: 'search' }
        },
        {
          name: 'exa_hidden', description: 'disabled MCP tool', parameters: { type: 'object' },
          source: { kind: 'mcp', sourceId: 'mcp-exa', sourceName: 'EXA', originalToolName: 'hidden' }
        },
        { name: 'forbidden', description: 'not advertised', parameters: { type: 'object' } }
      ]
    },
    context: [{
      segmentId: 'segment-user', segmentKind: 'message', messageRole: 'user',
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'user', parts: [{ text: 'hello' }] })
    }]
  };
}

function fakeCapability(start) {
  return {
    start,
    abort() {},
    resolveInvocation() {},
    compact() {},
    dryRun() { throw new Error('unused'); },
    dryRunCompact() { throw new Error('unused'); },
    listModels() { return Promise.resolve([]); },
    cancelRetry() {},
    dispose() {}
  };
}

test('可靠 LLM adapter 拒绝缺失 conversationId 的请求', async () => {
  let started = false;
  const invalid = request();
  invalid.conversationId = '   ';
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability(() => {
    started = true;
  }));

  assert.throws(
    () => adapter.sendFullRequest(invalid, {
      onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false })
    }),
    /conversationId must be non-empty/
  );
  assert.equal(started, false);
});

test('LLM capability adapter 过滤未授权工具并提交一个完整终态事件', async () => {
  let captured;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    captured = llmRequest;
    emit({ type: 'llm:started', payload: { requestId: llmRequest.id, startedAt: 1_000 } });
    emit({ type: 'llm:delta', payload: { requestId: llmRequest.id, text: 'hello' } });
    emit({
      type: 'llm:toolcall',
      payload: {
        requestId: llmRequest.id,
        calls: [
          { id: 'call-1', name: 'echo', argsJson: '{"value":1}' },
          { id: 'call-1', name: 'echo', argsJson: '{"value":1}' }
        ]
      }
    });
    emit({
      type: 'llm:done',
      payload: {
        requestId: llmRequest.id,
        createdAt: 1_250,
        completedAt: 1_500,
        streamOutputDurationMs: 250,
        usageMetadata: { totalTokenCount: 3 }
      }
    });
  }));
  const events = [];
  await adapter.sendFullRequest(request(), {
    onEvent: async (event) => {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });
  assert.deepEqual(captured.tools.map((tool) => tool.name), ['echo', 'exa_search']);
  assert.equal(captured.conversationId, 'conversation-adapter');
  assert.equal(captured.model.providerConfigId, 'provider-config');
  assert.equal(captured.model.provider, 'openai-compatible');
  assert.equal(captured.systemInstruction.parts[0].text, 'system instruction');
  assert.deepEqual(events.map((event) => event.kind), ['output_delta', 'output_item_done', 'completed']);
  assert.equal(events.at(-1).content.text, 'hello');
  assert.equal(events.at(-1).content.toolCalls.length, 1);
  assert.equal(events.at(-1).content.toolCalls[0].name, 'echo');
  assert.deepEqual(events.at(-1).timing, {
    providerStartedAt: 1_000,
    firstOutputAt: 1_250,
    completedAt: 1_500,
    streamOutputDurationMs: 250
  });
});

test('LLM capability adapter 的 YOLO 不扩大 allowedTools 或重新启用被禁 MCP 来源', async () => {
  const fullRequest = request();
  fullRequest.authoritySnapshot.toolPolicy.preset = 'yolo';
  fullRequest.authoritySnapshot.toolPolicy.sourceConfigs['mcp-exa'] = {
    enabled: false,
    disabledTools: []
  };
  let captured;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    captured = llmRequest;
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  await adapter.sendFullRequest(fullRequest, {
    onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' })
  });
  assert.deepEqual(captured.tools.map((tool) => tool.name), ['echo']);
});

test('LLM capability adapter 在无可见思维文本时仍投影思考进度和完成耗时', async () => {
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({
      type: 'llm:thoughtProgress',
      payload: {
        requestId: llmRequest.id, thoughtStartedAt: 10_000,
        thoughtElapsedMs: 1250, thoughtSignature: 'reasoning-signature'
      }
    });
    emit({
      type: 'llm:thoughtDone',
      payload: {
        requestId: llmRequest.id, thoughtStartedAt: 10_000,
        thoughtDurationMs: 1800, thoughtSignature: 'reasoning-signature'
      }
    });
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  const events = [];
  await adapter.sendFullRequest(request(), {
    onEvent: async (event) => {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });
  assert.deepEqual(events.map((event) => event.content.type), [
    'thought_progress', 'thought_done', undefined
  ]);
  assert.equal(events[0].content.thoughtStartedAt, 10_000);
  assert.equal(events[0].content.thoughtCompletedDurationMs, 0);
  assert.equal(events[0].content.thoughtElapsedMs, 1250);
  assert.equal(events[1].content.thoughtCompletedDurationMs, 1800);
  assert.equal(events[1].content.thoughtDurationMs, 1800);
  assert.equal(events[2].content.thought, '');
  assert.equal(events[2].content.thoughtDurationMs, 1800);
});

test('LLM capability adapter 在多段思考后重新开放计时并提交累计总耗时', async () => {
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({
      type: 'llm:thoughtDelta',
      payload: { requestId: llmRequest.id, text: 'first', thoughtStartedAt: 10_000, thoughtElapsedMs: 400 }
    });
    emit({
      type: 'llm:thoughtDone',
      payload: { requestId: llmRequest.id, thoughtStartedAt: 10_000, thoughtDurationMs: 700 }
    });
    emit({
      type: 'llm:thoughtDelta',
      payload: { requestId: llmRequest.id, text: 'second', thoughtStartedAt: 20_000, thoughtElapsedMs: 100 }
    });
    emit({
      type: 'llm:thoughtProgress',
      payload: { requestId: llmRequest.id, thoughtStartedAt: 20_000, thoughtElapsedMs: 500 }
    });
    emit({
      type: 'llm:thoughtDone',
      payload: { requestId: llmRequest.id, thoughtStartedAt: 20_000, thoughtDurationMs: 900 }
    });
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  const events = [];
  await adapter.sendFullRequest(request(), {
    onEvent: async (event) => {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });

  assert.deepEqual(events.map((event) => event.content.type), [
    'thought_delta', 'thought_done', 'thought_delta', 'thought_progress', 'thought_done', undefined
  ]);
  assert.deepEqual(events[2].content, {
    type: 'thought_delta', text: 'second', thoughtStartedAt: 20_000,
    thoughtCompletedDurationMs: 700, thoughtElapsedMs: 100
  });
  assert.equal(events[3].content.thoughtCompletedDurationMs, 700);
  assert.equal(events[4].content.thoughtDurationMs, 1600);
  assert.equal(events[5].content.thought, 'firstsecond');
  assert.equal(events[5].content.thoughtDurationMs, 1600);
});

test('LLM capability adapter 只投影tool_pair响应并沿用原Provider call id', async () => {
  const fullRequest = request();
  fullRequest.context.push(
    {
      segmentId: 'segment-assistant-call', segmentKind: 'message', messageRole: 'model',
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({
        role: 'model',
        parts: [{ id: 'provider-call-1', functionCall: { name: 'echo', args: { value: 1 } } }]
      })
    },
    {
      segmentId: 'segment-tool-pair', segmentKind: 'tool_pair', messageRole: null,
      contentType: 'application/vnd.limcode.context-tool-pair+json',
      content: JSON.stringify({
        kind: 'tool_pair',
        toolCall: {
          id: 'internal-tool-call-1', providerCallId: 'provider-call-1', callSeq: '1',
          toolName: 'echo', argumentsContentType: 'application/json', arguments: '{"value":1}'
        },
        toolModelResult: {
          id: 'tool-model-result-1', messageRevisionId: 'revision-1',
          resultContentType: 'application/json', result: '{"ok":true}'
        }
      })
    }
  );
  let captured;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    captured = llmRequest;
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  await adapter.sendFullRequest(fullRequest, {
    onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' })
  });
  const calls = captured.contents.flatMap((content) => content.parts.filter((part) => part.functionCall));
  const responses = captured.contents.flatMap((content) => content.parts.filter((part) => part.functionResponse));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'provider-call-1');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 'provider-call-1');
  assert.equal(responses[0].functionResponse.name, 'echo');
  assert.deepEqual(responses[0].functionResponse.response, { ok: true });
});

test('LLM capability adapter 将可靠工具附件恢复为 FunctionResponse.parts', async () => {
  const fullRequest = request();
  fullRequest.context.push({
    segmentId: 'segment-tool-attachment', segmentKind: 'tool_pair', messageRole: null,
    contentType: 'application/vnd.limcode.context-tool-pair+json',
    content: JSON.stringify({
      kind: 'tool_pair',
      toolCall: {
        id: 'internal-read-call', providerCallId: 'provider-read-call', callSeq: '1',
        toolName: 'read', argumentsContentType: 'application/json', arguments: '{"path":"sample.png"}'
      },
      toolModelResult: {
        id: 'tool-model-result-attachment', messageRevisionId: 'revision-attachment',
        resultContentType: 'application/vnd.limcode.tool-model-result+json',
        result: JSON.stringify({
          toolCallId: 'internal-read-call',
          status: 'succeeded',
          detail: {
            ok: true,
            output: { mimeType: 'image/png', sizeBytes: 4 },
            parts: [{
              inlineData: {
                mimeType: 'image/png', name: 'sample.png',
                attachmentId: 'attachment-managed', sha256: 'a'.repeat(64),
                storage: 'managed', sizeBytes: 4
              }
            }]
          }
        })
      }
    })
  });
  let captured;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    captured = llmRequest;
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  await adapter.sendFullRequest(fullRequest, {
    onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' })
  });
  const response = captured.contents.flatMap((content) =>
    content.parts.filter((part) => part.functionResponse)
  ).at(-1);
  assert.equal(response.functionResponse.name, 'read');
  assert.equal(response.functionResponse.parts.length, 1);
  assert.equal(response.functionResponse.parts[0].inlineData.attachmentId, 'attachment-managed');
  assert.equal('parts' in response.functionResponse.response.detail, false);
});

test('LLM capability adapter 对新Provider-native压缩状态强制providerConfig/model绑定', async () => {
  const compressed = {
    segmentId: 'segment-native-compression', segmentKind: 'compression', messageRole: null,
    contentType: 'application/vnd.limcode.compression-contents+json',
    content: JSON.stringify({
      kind: 'compression_contents', version: 1, trigger: 'auto',
      methodKind: 'openai_responses_compact',
      nativeBinding: {
        providerConfigId: 'provider-config', provider: 'openai-compatible', modelId: 'model-a'
      },
      contents: [{
        role: 'model',
        parts: [{ providerContext: { format: 'openai-responses', itemType: 'compaction', rawItem: { type: 'compaction' } } }]
      }]
    })
  };
  let captured;
  const acceptedRequest = request();
  acceptedRequest.context = [compressed];
  const accepted = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    captured = llmRequest;
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  await accepted.sendFullRequest(acceptedRequest, {
    onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' })
  });
  assert.equal(captured.contents[0].parts[0].providerContext.itemType, 'compaction');

  const rejectedRequest = request();
  rejectedRequest.modelId = 'model-b';
  rejectedRequest.context = [compressed];
  await assert.rejects(
    async () => accepted.sendFullRequest(rejectedRequest, {
      onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false })
    }),
    /Provider-native compression state is incompatible/
  );
});

test('LLM capability adapter 拒绝同一Provider call id承载冲突内容', async () => {
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({
      type: 'llm:toolcall',
      payload: {
        requestId: llmRequest.id,
        calls: [
          { id: 'call-conflict', name: 'echo', argsJson: '{"value":1}' },
          { id: 'call-conflict', name: 'echo', argsJson: '{"value":2}' }
        ]
      }
    });
  }));
  await assert.rejects(
    adapter.sendFullRequest(request(), { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) }),
    /reused tool call id call-conflict with conflicting content/
  );
});

test('LLM capability adapter 跨十个独立ToolCall事件累积完整终态并保留逐调用thoughtSignature', async () => {
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    for (let index = 0; index < 10; index += 1) {
      emit({
        type: 'llm:toolcall',
        payload: {
          requestId: llmRequest.id,
          calls: [{
            id: `call-${index}`,
            name: 'echo',
            argsJson: JSON.stringify({ index }),
            thoughtSignature: `signature-${index}`
          }]
        }
      });
    }
    emit({
      type: 'llm:toolcall',
      payload: {
        requestId: llmRequest.id,
        calls: [{ id: 'call-4', name: 'echo', argsJson: '{"index":4}', thoughtSignature: 'signature-4' }]
      }
    });
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  const events = [];
  await adapter.sendFullRequest(request(), {
    onEvent: async (event) => {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });
  const upserts = events.filter((event) => event.kind === 'output_item_done');
  assert.equal(upserts.length, 10, '幂等重放不得制造第十一个完成调用');
  assert.ok(upserts.every((event) => event.content.semantics === 'upsert'));
  const terminal = events.at(-1).content;
  assert.equal(terminal.toolCallsSemantics, 'snapshot');
  assert.deepEqual(terminal.toolCalls.map((call) => call.id), Array.from({ length: 10 }, (_, index) => `call-${index}`));
  assert.deepEqual(terminal.toolCalls.map((call) => call.ordinal), Array.from({ length: 10 }, (_, index) => index));
  assert.deepEqual(terminal.toolCalls.map((call) => call.thoughtSignature), Array.from({ length: 10 }, (_, index) => `signature-${index}`));
});

test('LLM capability adapter 用显式ordinal稳定合并无Provider id调用并拒绝ordinal冲突', async () => {
  const accepted = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [{ ordinal: 0, name: 'echo', argsJson: '{"value":1}' }] } });
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [{ id: 'late-id', ordinal: 0, name: 'echo', argsJson: '{"value":1}' }] } });
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [{ ordinal: 1, name: 'echo', argsJson: '{"value":2}' }] } });
    emit({ type: 'llm:done', payload: { requestId: llmRequest.id } });
  }));
  const events = [];
  await accepted.sendFullRequest(request(), {
    onEvent: async (event) => {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });
  assert.deepEqual(events.at(-1).content.toolCalls.map((call) => call.arguments.value), [1, 2]);
  assert.equal(events.at(-1).content.toolCalls[0].id, 'late-id');

  const conflicting = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [{ ordinal: 7, name: 'echo', argsJson: '{"value":1}' }] } });
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [{ ordinal: 7, name: 'echo', argsJson: '{"value":2}' }] } });
  }));
  await assert.rejects(
    conflicting.sendFullRequest(request(), { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) }),
    /ordinal 7 with conflicting content/
  );

  const crossedIdentity = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [
      { id: 'call-a', ordinal: 0, name: 'echo', argsJson: '{"value":1}' },
      { id: 'call-b', ordinal: 1, name: 'echo', argsJson: '{"value":2}' }
    ] } });
    emit({ type: 'llm:toolcall', payload: { requestId: llmRequest.id, calls: [
      { id: 'call-a', ordinal: 1, name: 'echo', argsJson: '{"value":1}' }
    ] } });
  }));
  await assert.rejects(
    crossedIdentity.sendFullRequest(request(), { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) }),
    /id call-a and ordinal 1 identify different calls/
  );
});

test('LLM capability adapter 将 429/网络/文本网关错误映射为可靠 Provider transient reason', async () => {
  for (const [message, rawError, reason] of [
    ['temporary failure', { status: 429 }, 'rate_limited'],
    ['temporary failure', { code: 'ECONNRESET', message: 'socket hang up' }, 'connection_interrupted'],
    ['OpenAI Responses WebSocket closed before terminal event: 1000', undefined, 'connection_interrupted'],
    ['OpenAI Responses WebSocket first_event timed out after 60000ms.', {
      code: 'LLM_TRANSPORT_TIMEOUT', phase: 'first_event'
    }, 'connection_interrupted'],
    ['temporary failure', { status: 503 }, 'temporary_service_error'],
    ['Upstream request failed', undefined, 'temporary_service_error']
  ]) {
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', fakeCapability((llmRequest, emit) => {
      emit({ type: 'llm:error', payload: { requestId: llmRequest.id, message, rawError } });
    }));
    await assert.rejects(
      adapter.sendFullRequest(request(), { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) }),
      (error) => error instanceof kernel.ProviderTransientError && error.reason === reason
    );
  }
});

test('LLM capability adapter 在首个 Provider 事件或语义输出后拒绝盲重放', async () => {
  const afterRawEvent = new kernel.LlmCapabilityFullRequestAdapter(
    'provider-config',
    fakeCapability((llmRequest, emit) => {
      emit({
        type: 'llm:error',
        payload: {
          requestId: llmRequest.id,
          message: 'WebSocket closed after response.created',
          rawError: {
            transport: 'websocket',
            receivedServerEvent: true,
            retryable: true
          }
        }
      });
    })
  );
  await assert.rejects(
    afterRawEvent.sendFullRequest(request(), {
      onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false })
    }),
    (error) => !(error instanceof kernel.ProviderTransientError)
      && /不自动重放请求/.test(error.message)
  );

  const afterSemanticOutput = new kernel.LlmCapabilityFullRequestAdapter(
    'provider-config',
    fakeCapability((llmRequest, emit) => {
      emit({ type: 'llm:delta', payload: { requestId: llmRequest.id, text: 'partial' } });
      emit({
        type: 'llm:error',
        payload: {
          requestId: llmRequest.id,
          message: 'socket hang up',
          rawError: { code: 'ECONNRESET', retryable: true }
        }
      });
    })
  );
  await assert.rejects(
    afterSemanticOutput.sendFullRequest(request(), {
      onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false })
    }),
    (error) => !(error instanceof kernel.ProviderTransientError)
      && /不自动重放请求/.test(error.message)
  );
});

test('LLM capability adapter 把内部 retry 事件立即上交 durable Attempt 而不隐式等待', async () => {
  let cancelledRetries = 0;
  let aborted = 0;
  const capability = fakeCapability((llmRequest, emit) => {
    emit({
      type: 'llm:retryScheduled',
      payload: {
        requestId: llmRequest.id,
        message: 'upstream temporarily unavailable',
        rawError: { status: 503 },
        retryAttempt: 1,
        retryMaxAttempts: 3,
        retryDelayMs: 60_000
      }
    });
  });
  capability.cancelRetry = () => { cancelledRetries += 1; };
  capability.abort = () => { aborted += 1; };
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', capability);

  await assert.rejects(
    adapter.sendFullRequest(request(), {
      onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false })
    }),
    (error) => error instanceof kernel.ProviderTransientError
      && error.reason === 'temporary_service_error'
  );
  assert.equal(cancelledRetries, 1);
  assert.equal(aborted, 0, 'scheduled retry 尚未启动时只需取消 retry wait');
});

test('冻结模型配置完整覆盖模型级字段并关闭 capability 内部重试', () => {
  const base = {
    id: 'provider-config',
    name: 'Provider',
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model-a',
    models: [{ id: 'model-a', name: 'A' }],
    apiKey: 'secret',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: true,
    retryMaxAttempts: 9,
    enableMultimodalTools: false,
    contextWindowTokens: 1000,
    headers: { Base: 'yes' },
    generationConfig: { temperature: 0.8 },
    requestBody: { base: true },
    modelConfigs: [{
      id: 'model-config-a', modelId: 'model-a', toolCallFormat: 'function-call',
      openaiResponsesTransport: 'http', stream: false, retryOnError: true, retryMaxAttempts: 5,
      enableMultimodalTools: true, contextWindowTokens: 2000,
      headers: { Model: 'yes' }, generationConfig: { temperature: 0.1 }, requestBody: { model: true },
      createdAt: 1, updatedAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };
  const resolved = kernel.applyFrozenModelProviderConfig(base, 'model-a', 'deepseek');
  assert.equal(resolved.provider, 'deepseek');
  assert.equal(resolved.stream, false);
  assert.equal(resolved.enableMultimodalTools, true);
  assert.equal(resolved.contextWindowTokens, 2000);
  assert.deepEqual(resolved.headers, { Model: 'yes' });
  assert.equal(resolved.retryOnError, false);
  assert.equal(resolved.retryMaxAttempts, 0);
  assert.equal(base.retryOnError, true);
  assert.throws(() => kernel.applyFrozenModelProviderConfig(base, 'unknown-model'), /does not contain/);
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(root, 'dist/extension/backend/reliableKernel/index.js')).href);
const promptText = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/world/modules/chat/systemPromptText.js'
)).href);

test('只去掉内置全局提示词标题，并保留用户命名提示词标题', () => {
  const result = promptText.composeSystemInstruction([
    {
      id: 'system-prompt:global:integrated',
      name: 'Integrated Global System Prompt',
      text: 'You are LimCode Agent.'
    },
    { id: 'user-rules', name: '用户规则', text: '始终先验证结果。' }
  ]);

  assert.equal(result, 'You are LimCode Agent.\n\n[用户规则]\n始终先验证结果。');
  assert.equal(result.includes('[Integrated Global System Prompt]'), false);
});

test('可靠请求只使用 AuthoritySnapshot 中冻结的前置提示词，并放在最终系统提示词最前', async () => {
  const fullRequest = {
    kind: 'full-model-request',
    modelRequestId: 'model-request-prompt-prefix',
    conversationId: 'conversation-prompt-prefix',
    attemptSeq: '2',
    socketGeneration: '1',
    providerId: 'provider-config',
    modelId: 'model-a',
    authoritySnapshot: {
      model: {
        providerConfigId: 'provider-config',
        provider: 'openai-compatible',
        modelId: 'model-a',
        systemPromptPrefix: '本次冻结的模型要求'
      },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: '已组装的系统提示词' },
      runtimeContext: { template: '运行环境说明' }
    },
    settingsSnapshot: { systemPromptPrefix: '任务开始后才修改的设置' },
    recipe: { tools: [] },
    context: [{
      segmentId: 'system-segment',
      segmentKind: 'system',
      messageRole: null,
      contentType: 'text/plain',
      content: '本轮附加说明'
    }, {
      segmentId: 'user-segment',
      segmentKind: 'message',
      messageRole: 'user',
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'user', parts: [{ text: 'hello' }] })
    }],
    attachmentCatalogState: { catalog: [], placements: [] }
  };
  let captured;
  const capability = {
    start(request, emit) {
      captured = request;
      emit({ type: 'llm:done', payload: { requestId: request.id } });
    },
    abort() {},
    resolveInvocation() {},
    compact() {},
    dryRun() { throw new Error('unused'); },
    dryRunCompact() { throw new Error('unused'); },
    listModels() { return Promise.resolve([]); },
    cancelRetry() {},
    dispose() {}
  };
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-config', capability);

  await adapter.sendFullRequest(fullRequest, {
    onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' })
  });

  assert.equal(
    captured.systemInstruction.parts[0].text,
    '本次冻结的模型要求\n\n已组装的系统提示词\n\n运行环境说明\n\n本轮附加说明'
  );
  assert.equal(captured.settingsSnapshot.systemPromptPrefix, '本次冻结的模型要求');
  assert.equal(captured.systemInstruction.parts[0].text.includes('任务开始后才修改的设置'), false);
});

test('模型专属配置整体替代渠道默认前置提示词，冻结值可继续覆盖后来读取的配置', () => {
  const config = {
    id: 'provider-config',
    name: 'Provider',
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'model-a',
    models: [{ id: 'model-a', name: 'Model A' }],
    apiKey: '',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: true,
    retryMaxAttempts: 3,
    enableMultimodalTools: true,
    contextWindowTokens: 200_000,
    systemPromptPrefix: '渠道默认要求',
    modelConfigs: [{
      id: 'model-config-a',
      modelId: 'model-a',
      toolCallFormat: 'function-call',
      openaiResponsesTransport: 'http',
      stream: true,
      retryOnError: true,
      retryMaxAttempts: 3,
      enableMultimodalTools: true,
      contextWindowTokens: 180_000,
      systemPromptPrefix: '模型专属要求',
      createdAt: 1,
      updatedAt: 1
    }],
    createdAt: 1,
    updatedAt: 1
  };

  assert.equal(
    kernel.applyFrozenModelProviderConfig(config, 'model-a').systemPromptPrefix,
    '模型专属要求'
  );
  assert.equal(
    kernel.applyFrozenModelProviderConfig(config, 'model-a', undefined, '本次冻结要求').systemPromptPrefix,
    '本次冻结要求'
  );
  assert.equal(
    kernel.applyFrozenModelProviderConfig(config, 'model-a', undefined, '').systemPromptPrefix,
    ''
  );
});

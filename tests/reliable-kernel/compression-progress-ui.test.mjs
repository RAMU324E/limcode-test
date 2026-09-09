import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';

const card = fs.readFileSync(path.join(process.cwd(), 'webview/src/components/conversation/ReliableCompressionCard.vue'), 'utf8');
const subtitleBody = card.match(/const subtitle = computed\(\(\) => \{([\s\S]*?)\n\}\);/)[1];
const renderSubtitle = new Function(
  'props', 'status', 'methodLabel', 'triggerLabel', 'sourceCount', 'savedTokens',
  'nonNegativeInteger', 'stringValue', 'formatTokenNumber', subtitleBody
);

function subtitle(block) {
  return renderSubtitle(
    { block }, { value: block.status }, { value: 'LLM 总结' }, { value: '自动触发' }, {}, {},
    (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined,
    (value) => typeof value === 'string' ? value.trim() : '', String
  );
}

test('压缩卡片区分等待输出与已收到输出，正在重试时仍展示次数', () => {
  assert.equal(subtitle({ status: 'running' }), 'LLM 总结 · 自动触发 · 等待模型输出');
  const progressAt = Date.UTC(2026, 8, 7, 4, 5, 6);
  const progressTime = new Date(progressAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const running = subtitle({ status: 'running', last_stream_event_at: progressAt, retry_attempt: 2, retry_max_attempts: 4 });
  assert.ok(running.includes('已收到模型输出 · 最近进度 ' + progressTime));
  assert.ok(running.includes('第 2/4 次重试'));
  const waiting = subtitle({ status: 'running', last_stream_event_at: 0, retry_attempt: 2, retry_max_attempts: 4 });
  assert.ok(waiting.includes('等待模型输出'));
  assert.ok(waiting.includes('第 2/4 次重试'));
  assert.equal(subtitle({ status: 'retrying', retry_delay_seconds: 3, retry_attempt: 2, retry_max_attempts: 4 }),
    '压缩连接异常 · 3 秒后自动恢复（第 2/4 次重试）');
  assert.doesNotMatch(subtitle({ status: 'committing', last_stream_event_at: progressAt }), /等待模型输出|最近进度/);
});

test('压缩卡片进度来自现有 ModelRequest 活动字段', () => {
  const messages = fs.readFileSync(path.join(process.cwd(), 'webview/src/components/conversation/ReliableMessageList.vue'), 'utf8');
  assert.match(messages, /last_stream_event_at:\s*reliableInteger\(modelRequestStreamStats\(request\)\?\.lastStreamEventAt\)/);
});

test('压缩最长时间输入块位于阈值之后，手动压缩也可设置', async () => {
  const server = await createServer({
    configFile: path.join(process.cwd(), 'vite.config.ts'),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error'
  });
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/global/LlmCompressionSettingsEditor.vue');
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    for (const mode of ['manual', 'token_threshold']) {
      const html = await renderToString(createSSRApp(editor, {
        config: { id: 'duration', kind: 'llm_summary', trigger: { mode }, maxDurationMinutes: 37 },
        providerConfigs: [], contextWindowTokens: 250000
      }));
      const input = html.match(/<input[^>]*aria-label="单次压缩最长时间（分钟）"[^>]*>/)[0];
      assert.match(input, /value="37"/);
      assert.match(input, /min="1"/);
      assert.match(input, /max="1440"/);
      assert.ok(html.includes('每次重试单独计时'));
      if (mode === 'token_threshold') {
        assert.ok(html.indexOf('单次压缩最长时间') > html.indexOf('完整输入 Token 触发阈值'));
      }
    }
  } finally {
    await server.close();
  }
});

test('渠道和模型的压缩时长独立保存，序列化与重新加载不丢值', async (context) => {
  const server = await createServer({
    configFile: path.join(process.cwd(), 'vite.config.ts'),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error'
  });
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  };
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  try {
    const { useGlobalSettingsStore } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    pinia.setActivePinia(pinia.createPinia());
    const store = useGlobalSettingsStore();
    const updates = [];
    context.mock.method(store, 'enqueueSettingsUpdate', (payload) => updates.push(structuredClone(payload)));
    context.mock.method(store, 'queueLlmCompressionConfigsAutoSave', () => {});
    store.llmProviderConfigs = { configs: [{
      id: 'duration-provider', name: 'duration provider', provider: 'openai-compatible',
      model: 'duration-model', models: [{ id: 'duration-model', name: 'duration model' }],
      modelConfigs: [], contextWindowTokens: 250000
    }] };
    store.llm = { activeProviderConfigId: 'duration-provider' };
    store.llmCompressionConfigs = { configs: [{
      id: 'shared-duration', name: 'shared', kind: 'llm_summary', maxDurationMinutes: 20,
      trigger: { mode: 'manual' }, createdAt: 1, updatedAt: 1
    }] };
    store.llmCompression = { defaultConfigId: 'shared-duration', providerBindings: [], modelBindings: [] };
    store.setActiveCompressionMaxDurationMinutes(37);
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    assert.notEqual(store.activeCompressionConfig.id, 'shared-duration');
    assert.equal(store.llmCompressionConfigs.configs.find((config) => config.id === 'shared-duration').maxDurationMinutes, 20);
    const providerConfigId = store.activeCompressionConfig.id;
    store.setModelCompressionMaxDurationMinutes('duration-model', 45);
    const modelConfig = store.compressionConfigForActiveModel('duration-model');
    assert.equal(modelConfig.maxDurationMinutes, 45);
    assert.notEqual(modelConfig.id, providerConfigId);
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    store.saveLlmCompressionConfigs();
    const saved = updates.filter((update) => update.section === 'llmCompressionConfigs').at(-1).settings;
    assert.equal(saved.configs.find((config) => config.id === providerConfigId).maxDurationMinutes, 37);
    assert.equal(saved.configs.find((config) => config.id === modelConfig.id).maxDurationMinutes, 45);
    store.applySectionSettings('llmCompressionConfigs', JSON.parse(JSON.stringify(saved)));
    assert.equal(store.activeCompressionConfig.maxDurationMinutes, 37);
    assert.equal(store.compressionConfigForActiveModel('duration-model').maxDurationMinutes, 45);
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});

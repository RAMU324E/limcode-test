import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';

const entry = `
import { createApp, h, ref } from 'vue';
import { createPinia } from 'pinia';
import Composer from '/src/components/input/Composer.vue';
import MessageList from '/src/components/conversation/ReliableMessageList.vue';
import { useClientStateStore } from '/src/stores/useClientStateStore';
import { useGlobalSettingsStore } from '/src/stores/useGlobalSettingsStore';
import { useSessionStore } from '/src/stores/useSessionStore';
import { useWorkEnvironmentStore } from '/src/stores/useWorkEnvironmentStore';
import { useReliableKernelClientFeedStore } from '/src/stores/useReliableKernelClientFeedStore';
import { GLOBAL_SETTINGS_SECTIONS } from '@shared/protocol';
import '/src/theme/tokens.css'; import '/src/theme/base.css'; import '/src/theme/motion/dropdown.css';
const pinia = createPinia(), mode = ref('menus');
const app = createApp({ setup: () => () => mode.value === 'menus'
  ? h('div', { class: 'composer-fixture' }, [h(Composer)]) : h(MessageList) }).use(pinia);
const client = useClientStateStore(pinia), settings = useGlobalSettingsStore(pinia), feed = useReliableKernelClientFeedStore(pinia);
const session = useSessionStore(pinia), environments = useWorkEnvironmentStore(pinia);
client.configurationReady = true; client.currentConversationId = 'self';
session.applyHello({ kind: 'mainPanel', conversationId: 'self' });
client.agents = [{ id: 'main', name: '主助手', type: 'main', createdAt: 1, updatedAt: 1 }];
client.workflows = ['Plan', 'Research', 'Review'].map(id => ({ id, name: id, source: 'builtin', description: id + ' 工作流的完整说明', createdAt: 1, updatedAt: 1 }));
const provider = { id: 'provider', name: '默认渠道', provider: 'openai-compatible', model: 'model', stream: true,
  baseUrl: 'https://example.invalid/v1', apiKey: '', generationConfig: {}, requestBody: {}, headers: {}, modelConfigs: [],
  models: ['model', 'long-model-name-with-a-readable-description'].map(id => ({ id, name: id })) };
for (const section of GLOBAL_SETTINGS_SECTIONS) settings.applySnapshot({ section, settings:
  section === 'llmProviderConfigs' ? { configs: [provider] } : section === 'llm' ? { activeProviderConfigId: 'provider' }
  : JSON.parse(JSON.stringify(settings[section])), revision: 'fixture', filePath: 'memory' });
const allowed = Array.from({ length: 12 }, (_, i) => ({ id: 'env-' + i, kind: 'local', name: '工作目录 ' + i,
  rootPath: '/home/user/projects/readable-work-directory-' + i, available: true, index: i }));
environments.allowedEnvironmentsForConversation = () => allowed;
environments.environmentSelectionForConversation = () => ({ allowed, error: '工作环境未获当前策略允许：旧工作目录，请重新选择。' });
environments.workEnvironmentEnabledForConversation = () => true;
feed.projections = { activeConversationWindow: { conversationId: 'self' } };
feed.sessionId = 'feed'; feed.collaborationHistoryConversationId = 'self'; feed.collaborationHistoryHasMore = true;
feed.collaborationHistoryNextCursor = { kind: 'message' };
feed.collaborationHistoryLoadedPages = 1;
const posted = [];
window.fixture = { client, settings, feed, mode, posted, hold: false, pages: 0, errors: false,
  resetHistory() { feed.synchronizeCollaborationHistoryScope('self', true); feed.collaborationHistoryNextCursor = { kind: 'message' }; feed.collaborationHistoryLoadedPages = 1; this.pages = 0; },
  handle(message) {
    posted.push(message);
    if (message.type !== 'reliable-kernel.collaboration-history-request') return;
    const n = ++this.pages;
    if (this.hold) return;
    setTimeout(() => {
      if (this.errors) { feed.observeCollaborationHistoryError({ ...message, message: '测试读取失败' }); return; }
      feed.observeCollaborationHistoryResult({ ...message, page: { records: {}, hasMore: n < 4, scanProgress: n < 4,
        scannedRows: 4096, responseBytes: 0, ...(n < 4 ? { nextCursor: { kind: 'message', beforeMessageSeq: String(100 - n), beforeId: 'm' + n } } : {}) } });
    }, 20);
  }
};
app.mount('#app');
`;
const theme = `:root { --vscode-font-family: sans-serif; --vscode-editor-background: #1f1f1f; --vscode-foreground: #ccc;
--vscode-descriptionForeground: #aaa; --vscode-panel-border: #444; --vscode-input-background: #292929;
--vscode-input-foreground: #ddd; --vscode-list-hoverBackground: #333; --vscode-editorWarning-foreground: #d9b45b; }
body { margin: 8px; background: #1f1f1f; color: #ccc; } .composer-fixture { position: fixed; left: 8px; right: 8px; bottom: 8px; }`;
let server, browser;
const screenshotDir = process.env.LIMCODE_COMPOSER_SCREENSHOTS;
before(async () => {
  server = await createBrowserFixtureServer({ dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'], plugins: [{
    name: 'composer-fixture', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:composer-fixture') return '\0' + id; },
    load(id) { if (id === '\0virtual:composer-fixture') return entry; },
    configureServer(vite) { vite.middlewares.use('/composer-fixture', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end(await vite.transformIndexHtml('/composer-fixture', `<meta charset="utf-8"><link rel="icon" href="data:,"><style>${theme}</style><div id="app"></div><script type="module">import('virtual:composer-fixture').catch(error => { window.fixtureError = error.stack; console.error(error.stack); });</script>`));
    }); }
  }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function pageFor(t, width = 360) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() {}, setState() {},
    postMessage(message) { window.fixture?.handle(structuredClone(message)); } }); });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/composer-fixture`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!window.fixture || !!window.fixtureError);
  assert.equal(await page.evaluate(() => window.fixtureError), undefined);
  return page;
}
async function bounds(page, selector) {
  await page.locator(selector).waitFor();
  await page.waitForFunction(selector => {
    const el = document.querySelector(selector); if (!el || el.classList.contains('lc-dropdown-enter-active')) return false;
    const r = el.getBoundingClientRect(); return r.left >= 7 && r.right <= innerWidth - 7 && r.top >= 7 && r.bottom <= innerHeight - 7;
  }, selector);
  return page.locator(selector).boundingBox();
}

test('协作查找跨空页显示进度、查完结束、停止不继续请求、失败保留游标', async t => {
  const p = await pageFor(t);
  await p.evaluate(() => window.fixture.mode.value = 'history');
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByText('没有更早的协作记录', { exact: false }).waitFor();
  assert.equal(await p.evaluate(() => window.fixture.pages), 4);
  assert.match(await p.locator('.reliable-collaboration-progress').innerText(), /16,384/);
  await p.evaluate(() => { window.fixture.resetHistory(); window.fixture.hold = true; });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByRole('button', { name: '停止查找', exact: true }).click();
  await p.evaluate(() => {
    const f = window.fixture, message = f.posted.filter(m => m.type === 'reliable-kernel.collaboration-history-request').at(-1);
    f.feed.observeCollaborationHistoryResult({ ...message, page: { records: {}, hasMore: true, scanProgress: true,
      scannedRows: 4096, responseBytes: 0, nextCursor: { kind: 'message', beforeMessageSeq: '50', beforeId: 'stopped' } } });
  });
  await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await p.evaluate(() => window.fixture.pages), 1);
  await p.evaluate(() => { window.fixture.hold = false; window.fixture.errors = true; });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.getByText('测试读取失败', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => window.fixture.feed.collaborationHistoryNextCursor.beforeMessageSeq), '50');
});

test('协作查找跨过已展示卡片和空页，找到新卡片即停', async t => {
  const p = await pageFor(t);
  await p.evaluate(() => {
    const f = window.fixture;
    f.hold = true;
    f.card = (id, seq) => ({
      CollaborationMessage: [{ id, message_seq: String(seq), mode: 'message', text_preview: id === 'new' ? '历史新消息' : '已展示消息' }],
      CollaborationMessageSourceLink: [{ id: id + '-source', message_id: id, conversation_id: 'self', source_kind: 'tool' }],
      CollaborationMessageTargetLink: [{ id: id + '-target', message_id: id, conversation_id: 'peer', inbox_item_id: id + '-inbox' }],
      CollaborationPeerConversation: [{ id: 'peer', title: '协作方', status: 'active' }]
    });
    f.feed.records = Object.fromEntries(Object.entries(f.card('known', 90)).map(([domain, rows]) => [domain, Object.fromEntries(rows.map(row => [row.id, row]))]));
    f.reply = (records, sequence) => {
      const request = f.posted.filter(m => m.type === 'reliable-kernel.collaboration-history-request').at(-1);
      f.feed.observeCollaborationHistoryResult({ ...request, page: { records, hasMore: true, scanProgress: false, scannedRows: 10,
        responseBytes: 0, nextCursor: { kind: 'message', beforeMessageSeq: String(sequence), beforeId: 'cursor-' + sequence } } });
    };
    f.mode.value = 'history';
  });
  await p.getByRole('button', { name: '查找更早协作记录', exact: true }).click();
  await p.evaluate(() => window.fixture.reply(window.fixture.card('known', 90), 89));
  await p.waitForFunction(() => window.fixture.pages === 2);
  await p.evaluate(() => window.fixture.reply({}, 88));
  await p.waitForFunction(() => window.fixture.pages === 3);
  await p.evaluate(() => window.fixture.reply(window.fixture.card('new', 87), 87));
  await p.getByText('已找到更早的协作记录', { exact: false }).waitFor();
  await p.locator('[data-timeline-row-key="collaboration:new"]').waitFor();
  assert.equal(await p.getByRole('button', { name: '停止查找', exact: true }).count(), 0);
  assert.equal(await p.evaluate(() => window.fixture.pages), 3);
});

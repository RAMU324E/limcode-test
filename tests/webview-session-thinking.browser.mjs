import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { chromium } from 'playwright';
import { createBrowserFixtureServer } from './reliable-kernel/browser-fixture-server.mjs';

const require = createRequire(import.meta.url);
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { BridgeMessageType: T } = require('../dist/extension/shared/protocol.js');

// Exercise the packaged Vue application and real browser events. The host is synthetic:
// Backend persistence, CAS and wire bodies are covered by configuration-runtime-smoke.test.mjs.
test('built chat can read thinking, recover an expired save session, and send with inherited model', async () => {
  const root = path.resolve('dist/webview');
  const server = createServer(async (req, res) => {
    const file = path.resolve(root, '.' + (new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    try {
      res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[path.extname(file)] ?? 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  const errors = [];
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ T, state }) => {
      let host = 'host-a', seq = 0, session = 'edit-a';
      const model = { providerConfigId: 'provider', provider: 'openai-compatible', model: 'gpt-5.6-terra' };
      const provider = { id: 'provider', name: 'Test channel', provider: model.provider, model: model.model,
        baseUrl: 'https://example.invalid/v1', apiKey: '', systemPromptPrefix: '', stream: true, toolCallFormat: 'function-call',
        promptCache: { enabled: false },
        models: [{ id: model.model, name: model.model }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, createdAt: 1, updatedAt: 1 };
      let profile = { id: 'profile', name: 'thinking only', ...model, model: 'o3', inheritModel: true, thinkingOverride: { kind: 'openai-effort', value: 'low' } };
      const emit = (type, payload, correlationId) => window.postMessage({ id: crypto.randomUUID(), clientId: host, type, payload, correlationId }, '*');
      const observe = () => ({ scopeKind: 'conversation', scopeId: 'conversation', authorityId: 'root', sessionId: session,
        sequence: ++seq, revision: `r${seq}`, outcome: 'observed', effectiveModel: model, profile,
        link: { id: 'link', scopeKind: 'conversation', scopeId: 'conversation', modelProfileId: 'profile', role: 'active', createdAt: 1, updatedAt: 1 },
        profileState: profile.thinkingOverride ? 'overridden' : 'default' });
      window.requests = [];
      window.failSave = true;
      window.acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message) {
        window.requests.push(structuredClone(message));
        queueMicrotask(() => {
          const p = message.payload;
          if (message.type === T.Ready) {
            emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } });
            emit(T.ConfigurationSnapshot, { state, loadedAt: 1 });
            window.postMessage({ type: 'reliable-kernel.snapshot', sessionId: `feed-${host}`, hostBootId: host,
              messageSeq: '1', snapshotCommitSeq: '1', projections: { activeConversationWindow: { conversationId: 'conversation' },
                conversations: [{ id: 'conversation', title: 'Browser regression', status: 'active', created_at: 1, updated_at: 1 }] } }, '*');
          } else if (message.type === T.GlobalSettingsGet) {
            const settings = p.section === 'llm' ? { activeProviderConfigId: 'provider' }
              : p.section === 'llmProviderConfigs' ? { configs: [provider] }
              : p.section === 'llmCompressionConfigs' ? { configs: [] } : {};
            emit(T.GlobalSettingsSnapshot, { section: p.section, settings, revision: 'settings', loadedAt: 1 }, message.id);
          } else if (message.type === T.ModelProfileScopeRead) {
            if (p.afterRequestId) {
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'uncertain', revision: '', error: '编辑会话已失效' }, message.id);
            } else {
              if (p.renewSession) session = 'edit-renewed';
              emit(T.ModelProfileScopeSnapshot, observe(), message.id);
            }
          } else if (message.type === T.ModelProfileScopeSet) {
            if (window.failSave) {
              emit(T.Error, { requestType: message.type, message: '保存连接中断' }, message.id);
            } else {
              profile = { ...profile, ...model, thinkingOverride: p.thinkingOverride };
              emit(T.ModelProfileScopeSnapshot, { ...observe(), outcome: 'committed', operation: p.operation, expectedRevision: p.expectedRevision }, message.id);
            }
          }
        });
      } });
      window.replaceHost = (next = 'host-b') => { host = next; session = 'edit-b'; emit(T.Hello, { meta: { kind: 'mainPanel', conversationId: 'conversation' } }); };
    }, { T, state: createEmptyClientState() });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
    const thinking = page.locator('.session-thinking-dropdown');
    await thinking.getByRole('button').filter({ hasText: '思考：高' }).waitFor();
    await page.locator('textarea').fill('browser regression message');
    await thinking.getByRole('button').click();
    await page.getByRole('option', { name: '中（medium）', exact: true }).click();
    await page.getByText('保存连接中断', { exact: false }).waitFor();
    const send = page.locator('button.composer-send');
    await send.click();
    assert.equal(await page.evaluate(T => window.requests.filter(r => r.type === T.TurnStart).length, T), 0);
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText('编辑会话已失效', { exact: false }).waitFor();
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.payload.renewSession), T);
    await page.waitForFunction(() => !document.querySelector('.session-thinking-error'));
    await page.evaluate(() => window.replaceHost());
    await page.waitForFunction(T => window.requests.some(r => r.type === T.ModelProfileScopeRead && r.clientId === 'host-b'), T);
    await thinking.getByRole('button').filter({ hasText: '思考：高' }).waitFor();
    await send.click();
    await page.waitForFunction(T => window.requests.some(r => r.type === T.TurnStart), T);
    const requests = await page.evaluate(() => window.requests);
    const sent = requests.find(r => r.type === T.TurnStart);
    assert.equal(sent.payload.model, undefined, 'a thinking-only profile must not pin its old model');
    assert.equal(sent.clientId, 'host-b');
    assert.equal(requests.filter(r => r.type === T.ModelProfileScopeSet).length, 1, 'recovery must not silently replay failed writes');
    await page.setViewportSize({ width: 1200, height: 800 });
    const expanded = await page.evaluate(() => {
      const selectors = [...document.querySelectorAll('.composer-meta .composer-meta-dropdown, .composer-meta .session-thinking-dropdown')];
      return selectors.map((selector, index) => {
        const label = selector.querySelector('.settings-dropdown-label');
        const before = selector.getBoundingClientRect().width;
        label.textContent = `比较长的配置名称示例${index}继续显示完整名称`;
        return { before, after: selector.getBoundingClientRect().width, visible: label.clientWidth, content: label.scrollWidth };
      });
    });
    assert.ok(expanded.length >= 3, '工作流、渠道、思考强度下拉框必须在输入栏中');
    assert.ok(expanded.some(item => item.after > item.before + 20), '按钮宽度应随选中名称增长');
    assert.ok(expanded.every(item => item.visible + 1 >= item.content), '宽面板应完整显示选中名称');
    await page.setViewportSize({ width: 360, height: 800 });
    const narrow = await page.evaluate(() => {
      const meta = document.querySelector('.composer-meta').getBoundingClientRect();
      return [...document.querySelectorAll('.composer-meta .composer-meta-dropdown, .composer-meta .session-thinking-dropdown')]
        .map(selector => { const rect = selector.getBoundingClientRect(); return rect.left >= meta.left - 1 && rect.right <= meta.right + 1; });
    });
    assert.ok(narrow.every(Boolean), '窄窗口可换行，但下拉框不能越出输入栏');
    const keptDraft = await page.locator('textarea').inputValue();
    await page.evaluate(T => window.postMessage({ id: 'runtime-failure', clientId: 'host-b', type: T.Error,
      payload: { code: 'runtime_unavailable', message: '运行连接已停止：测试心跳失败，请重载窗口。' } }, '*'), T);
    await page.locator('.composer-runtime-error').waitFor();
    assert.equal(await send.isDisabled(), true);
    assert.equal(await page.locator('textarea').inputValue(), keptDraft);
    await page.evaluate(T => window.postMessage({ id: 'late-hello', clientId: 'host-b', type: T.Hello,
      payload: { meta: { kind: 'mainPanel', conversationId: 'conversation' } } }, '*'), T);
    assert.ok(await page.locator('.composer-runtime-error').isVisible(), '同一故障 Host 的迟到 Hello 不恢复可用状态');
    await page.evaluate(() => window.replaceHost('host-c'));
    await page.locator('.composer-runtime-error').waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Browser diagnostics:', errors, await page?.locator('body').innerText(), await page?.evaluate(() => window.requests));
    throw error;
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});

// Mount the production list and exercise its actual click handler/watch/DOM update.
// Host admission and card data are synthetic. MessageItem, body hydration, content rendering
// and the reading viewport use production components; bodies arrive after history metadata.
test('history click keeps the visible message anchored after the production Vue list updates', async () => {
  const fixture = `
    import { reactive, ref } from 'vue';
    import {createReliablePresentationIndex} from '/src/domain/reliablePresentationIndex.ts';
    const rows = (from, count) => Array.from({length:count}, (_, i) => ({id:'message-'+(from+i), seq:from+i, role:'user', content:{role:'user',parts:[{text:'message-'+(from+i)+' '+('delayed body ').repeat(120+i%3*20)}]}, createdAt:from+i, status:'completed', conversationId:'scroll-conversation'}));
    const initialRows=rows(101,29);
    const records=(messages,cards)=>({Message:Object.fromEntries(messages.map(row=>[row.id,{id:row.id,conversation_id:'scroll-conversation',message_seq:String(row.seq)}])),
      CollaborationMessage:Object.fromEntries(cards.map(seq=>['card-'+seq,{id:'card-'+seq,message_seq:String(seq),mode:'message',text_preview:'card-'+seq}])),
      CollaborationMessageSourceLink:Object.fromEntries(cards.map(seq=>['source-'+seq,{id:'source-'+seq,message_id:'card-'+seq,conversation_id:'scroll-conversation',source_kind:'tool'}])),
      CollaborationMessageTargetLink:Object.fromEntries(cards.map(seq=>['target-'+seq,{id:'target-'+seq,message_id:'card-'+seq,conversation_id:'peer'}])),
      CollaborationSendTimelineLink:Object.fromEntries(cards.map(seq=>['position-'+seq,{id:'position-'+seq,message_id:'card-'+seq,conversation_id:'scroll-conversation',predecessor_message_id:'message-'+seq,predecessor_message_seq:String(seq),exchange_seq:String(seq)}]))});
    export const projection = ref({messages:initialRows,index:createReliablePresentationIndex(initialRows,[]),contentWindowByMessageId:{},splitSourceMessageIdByMessageId:{},absoluteFloorByMessageId:Object.fromEntries(initialRows.map(row=>[row.id,row.seq])), terminationByMessageId:{}, turnIdByMessageId:{}, interactionByToolCallId:{}, messageRevisionIdByMessageId:{}, modelRequestIdByMessageId:{}, toolCalls:[]});
    export const conversationId = ref('scroll-conversation');
    export const feed = reactive({records:{}, committedRecords:records(initialRows,[105]), projections:{activeConversationWindow:{visibleMessageCount:'130'}}, details:{}, messageContentWindows:{}, transientModelRequests:{}, historyConversationId:'scroll-conversation', historyPages:[], historyCurrentPageId:null, historyHasMore:true, historyHasMoreAfter:false, historyLoading:false, historyLoadedPages:1,
      removedConversationIds:[],peerStateGeneration:0,acceptedAnswerPeerGenerations:{},collaborationHistoryConversationId:'scroll-conversation',collaborationHistoryHasMoreBefore:true,collaborationHistoryHasMoreAfter:false,collaborationHistoryLoading:false,collaborationHistoryLoadedPages:1,
      requestEarlierHistory(){this.historyLoading=true;return true;},requestCollaborationHistoryPage(){this.collaborationHistoryLoading=true;return true;},retainCollaborationReadingPage(){},retainReadingPage(){},retainMessageContentWindows(){},setPinnedDetailKeys(){},requestDetail(){},moveMessageContentWindow(){} });
    export const useReliableConversation = () => ({feed, conversationId, projection, ensureDetails(){},completeMessageContent:async id=>projection.value.index.messageById.get(id).content});
    export const useChat = () => ({conversationAction:ref(null), conversationActionPending:ref(false), conversationActionLabel:ref(null), conversationActionNotice:ref(null), forkPendingTargetIds:ref(new Set()), currentAuthoritySelection:()=>({}), currentTurnInputEchoes:ref([])});
    export const useGlobalSettingsStore = () => ({llmProviderConfigs:{configs:[]},llm:{}});
    export const useSessionStore = () => ({ runtimeError: null });
    export const useModelProfileStore = () => ({effectiveFor:()=>({})});
    export const useReliableTimelinePresentationStore = () => ({isSuppressed:()=>false});
    window.fulfillEarlier = () => {const messages=rows(81,50).map(row=>row.seq<101?{...row,content:{role:'user',parts:[]}}:row);projection.value={...projection.value,messages,index:createReliablePresentationIndex(messages,[],{},projection.value.index),absoluteFloorByMessageId:Object.fromEntries(messages.map(row=>[row.id,row.seq]))};feed.committedRecords=records(messages,[105]);feed.historyLoading=false;feed.historyLoadedPages++;};
    window.hydrateEarlier = () => {const messages=rows(81,50);projection.value={...projection.value,messages,index:createReliablePresentationIndex(messages,[],{},projection.value.index)};};
    window.fulfillCollaboration = () => {feed.committedRecords=records(projection.value.messages,[95,105]);feed.collaborationHistoryLoading=false;feed.collaborationHistoryHasMoreBefore=false;feed.collaborationHistoryLoadedPages++;};
  `;
  const stubs = ['useSessionStore', 'useReliableConversation', 'useChat', 'useGlobalSettingsStore', 'useModelProfileStore', 'useReliableTimelinePresentationStore'];
  const server = await createBrowserFixtureServer({
    dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'],
    plugins: [{
      name: 'history-scroll-browser-fixture', enforce: 'pre',
      resolveId(id) { if (id.startsWith('virtual:scroll-')) return '\0' + id; },
      load(id) {
        if (id === '\0virtual:scroll-fixture') return fixture;
        if (id === '\0virtual:scroll-body') return `import {h} from 'vue';export default {props:['card'],setup:p=>()=>p.card?h('div',{style:{height:'173px'}},p.card.messageId):null};`;
      },
      transform(code, id) {
        if (!id.endsWith('/ReliableMessageList.vue')) return;
        for (const hook of stubs) code = code.replace(new RegExp("from '(@webview/[^']+/" + hook + ")'", 'g'), "from 'virtual:scroll-fixture'");
        code = code.replace(/from '\.\/(?!MessageItem\.vue)[^']+\.vue'/g, "from 'virtual:scroll-body'");
        return code;
      },
      configureServer(vite) {
        vite.middlewares.use('/history-scroll-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/history-scroll-fixture', `<link rel="icon" href="data:,"><div id="app"></div><script type="module">
            import {createApp,h,ref} from 'vue'; import {createPinia} from 'pinia';
            import '/src/theme/tokens.css'; import '/src/theme/base.css';
            import '/src/theme/motion/message.css'; import '/src/theme/motion/content.css';
            import List from '/src/components/conversation/ReliableMessageList.vue';
            import {useBottomStickyScroller} from '/src/composables/useBottomStickyScroller.ts';
            createApp({setup(){const scroller=ref(null);const sticky=useBottomStickyScroller(scroller);window.fixtureSticky=sticky;return()=>h('div',{id:'scroll-fixture',ref:scroller,tabindex:0,style:'width:640px;height:400px;overflow:auto;overflow-anchor:none'},[h(List,{scroller:scroller.value,followLatest:sticky.stickyToBottom.value})]);}}).use(createPinia()).mount('#app');
          </script>`));
        });
      }
    }]
  });
  let browser;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => { errors.push(error.message); console.error('History fixture error:', error.message); });
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} }); });
    const url = `http://127.0.0.1:${server.httpServer.address().port}/history-scroll-fixture`;
    const scroller = page.locator('#scroll-fixture');
    const row = id => page.locator(`.reliable-message-row[data-timeline-row-key="${id}"]`);
    const offset = target => target.evaluate(element => element.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top);
    const openReadingHistory = async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await row('message-129').waitFor();
      await scroller.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); element.scrollTop = 0; });
      await page.waitForFunction(() => !window.fixtureSticky.stickyToBottom.value && document.querySelector('#scroll-fixture').scrollTop === 0);
      await row('message-101').waitFor();
    };
    await openReadingHistory();
    const before = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await page.evaluate(() => window.fulfillEarlier());
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await page.evaluate(() => window.fulfillCollaboration());
    // The new card occupies one of the twenty earlier timeline positions.
    await row('message-82').waitFor();
    await page.locator('[data-timeline-row-key="collaboration:card-95"]').waitFor();
    await page.waitForFunction(expected => {
      const row = document.querySelector('.reliable-message-row[data-timeline-row-key="message-101"]');
      return Math.abs(row.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top - expected) < 1;
    }, before);
    const metadataHeight = await scroller.evaluate(element => element.scrollHeight);
    await page.evaluate(() => window.hydrateEarlier());
    await page.locator('[data-message-id="message-82"] .rc-text').waitFor();
    await page.waitForFunction(expected => {
      const row = document.querySelector('.reliable-message-row[data-timeline-row-key="message-101"]');
      return Math.abs(row.getBoundingClientRect().top - document.querySelector('#scroll-fixture').getBoundingClientRect().top - expected) < 1;
    }, before);
    assert.ok((await scroller.evaluate(element => element.scrollHeight)) > metadataHeight + 500);
    // The other branch of showEarlierSegment uses already loaded rows, without a feed page.
    await page.getByRole('button', { name: '显示较新内容', exact: true }).click();
    await scroller.evaluate(element => { element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); element.scrollTop = 0; });
    const loadedBefore = await offset(row('message-101'));
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await row('message-82').waitFor();
    assert.ok(Math.abs(await offset(row('message-101')) - loadedBefore) < 1);

    await openReadingHistory();
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await scroller.hover();
    await page.mouse.wheel(0, 700);
    await page.waitForFunction(() => document.querySelector('#scroll-fixture').scrollTop >= 600);
    const moved = await scroller.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const target = [...element.querySelectorAll('[data-timeline-row-key]')].find(candidate => {
        const rect = candidate.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
      return { id: target.dataset.timelineRowKey, offset: target.getBoundingClientRect().top - bounds.top };
    });
    await page.evaluate(() => { window.fulfillEarlier(); window.fulfillCollaboration(); });
    await page.waitForFunction(expected => {
      const scroller = document.querySelector('#scroll-fixture');
      const target = [...scroller.querySelectorAll('[data-timeline-row-key]')].find(candidate => candidate.dataset.timelineRowKey === expected.id);
      return target && Math.abs(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected.offset) < 1;
    }, moved);
    await page.evaluate(() => window.hydrateEarlier());
    await page.waitForFunction(expected => {
      const scroller = document.querySelector('#scroll-fixture');
      const target = [...scroller.querySelectorAll('[data-timeline-row-key]')].find(candidate => candidate.dataset.timelineRowKey === expected.id);
      return target && Math.abs(target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expected.offset) < 1;
    }, moved);

    await openReadingHistory();
    await page.getByRole('button', { name: '显示更早内容', exact: true }).click();
    await page.getByRole('button', { name: '正在加载更早内容', exact: true }).waitFor();
    await scroller.focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => window.fixtureSticky.stickyToBottom.value);
    await page.evaluate(() => { window.fulfillEarlier(); window.fulfillCollaboration(); });
    await row('message-130').waitFor();
    await page.evaluate(() => window.hydrateEarlier());
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#scroll-fixture');
      return window.fixtureSticky.stickyToBottom.value && scroller.querySelector('[data-timeline-row-key="message-130"]')
        && Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) < 1;
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});


// The host supplies a body and an explicit full-read action; MessageItem, RichContentView,
// text/Markdown rendering, ResizeObserver and the scroll viewport are production components.
test('content blocks stay bounded, preserve a reading anchor, and copy the complete message', async () => {
  const server = await createBrowserFixtureServer({
    dependencies: ['vue', 'pinia', '@tabler/icons-vue', 'markdown-it', 'markdown-it-texmath', 'katex'],
    plugins: [{
      name: 'content-window-browser-fixture',
      configureServer(vite) {
        vite.middlewares.use('/content-window-fixture', async (_request, response) => {
          response.setHeader('Content-Type', 'text/html');
          response.end(await vite.transformIndexHtml('/content-window-fixture', `<link rel="icon" href="data:,"><style>
            body { margin:0; font:16px/22px monospace; } #block-scroller { width:640px; height:420px; overflow:auto; overflow-anchor:none; }
          </style><div id="app"></div><script type="module">
            import {createApp,h,ref} from 'vue'; import {createPinia} from 'pinia';
            import MessageItem from '/src/components/conversation/MessageItem.vue';
            import '/src/theme/tokens.css'; import '/src/theme/base.css';
            import '/src/theme/motion/message.css'; import '/src/theme/motion/content.css';
            const part = i => ({text:'Block '+i+' — '+('readable content '+i+' ').repeat(8+i%5),outputItem:{id:'block-'+i,ordinal:i+32,providerResponseId:'browser-response'}});
            const source=ref({id:'large-message',role:'model',status:'done',createdAt:1,seq:1,conversationId:'browser-content',content:{role:'model',parts:Array.from({length:120},(_,i)=>part(i))}});
            window.completeReads=0;
            window.appendBlockTail=()=>{const parts=source.value.content.parts;source.value={...source.value,content:{role:'model',parts:[...parts.slice(0,-1),{...parts.at(-1),text:parts.at(-1).text+' live extension'}]}};};
            window.prependBlocks=()=>{source.value={...source.value,content:{role:'model',parts:[...Array.from({length:32},(_,i)=>part(i-32)),...source.value.content.parts]}};};
            const thought = i => ({...part(i),thought:true,thoughtDurationMs:5});
            window.showThoughtPage=()=>{source.value={...source.value,content:{role:'model',parts:Array.from({length:32},(_,i)=>thought(i+32))}};};
            window.prependThoughtPage=()=>{source.value={...source.value,content:{role:'model',parts:[...Array.from({length:32},(_,i)=>thought(i)),...source.value.content.parts]}};};
            window.removeThoughtPrefix=()=>{source.value={...source.value,content:{role:'model',parts:source.value.content.parts.slice(48)}};};
            createApp({setup(){const scroller=ref(null);return()=>h('div',{id:'block-scroller',ref:scroller},[h(MessageItem,{message:source.value,scroller:scroller.value,
              loadCompleteContent:async()=>{window.completeReads++;return {role:'model',parts:Array.from({length:160},(_,i)=>part(i))};}})]);}}).use(createPinia()).mount('#app');
          </script>`));
        });
      }
    }]
  });
  let browser, page;
  const errors = [];
  try {
    await server.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.LIMCODE_TEST_BROWSER_PATH ? { executablePath: process.env.LIMCODE_TEST_BROWSER_PATH } : {}) });
    page = await browser.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => { errors.push(error.message); console.error('Content fixture error:', error.message); });
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedMessage = text; } } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/content-window-fixture`, { waitUntil: 'domcontentloaded' });
    const blocks = page.locator('[data-content-block-key]');
    await blocks.first().waitFor();
    assert.ok(await blocks.count() <= 32);
    assert.equal(await page.evaluate(() => window.completeReads), 0);
    await page.locator('#block-scroller').evaluate(element => { element.scrollTop = element.scrollHeight / 2; });
    await page.waitForFunction(() => Number(document.querySelector('[data-content-block-key]').textContent.match(/Block (\d+)/)?.[1]) > 20);
    const anchor = await page.evaluate(() => {
      const viewport=document.querySelector('#block-scroller').getBoundingClientRect();
      const block=[...document.querySelectorAll('[data-content-block-key]')].find(element=>element.getBoundingClientRect().bottom>viewport.top && element.getBoundingClientRect().top<viewport.bottom);
      window.heldBlock=block;
      return {key:block.dataset.contentBlockKey,offset:block.getBoundingClientRect().top-viewport.top};
    });
    await page.evaluate(() => window.appendBlockTail());
    await page.waitForFunction(() => document.querySelector('[data-content-block-key]'));
    assert.equal(await page.evaluate(key => [...document.querySelectorAll('[data-content-block-key]')].find(element=>element.dataset.contentBlockKey===key) === window.heldBlock, anchor.key), true);
    await page.evaluate(() => window.prependBlocks());
    await page.waitForFunction(anchor => {
      const block=[...document.querySelectorAll('[data-content-block-key]')].find(element=>element.dataset.contentBlockKey===anchor.key);
      return block && Math.abs(block.getBoundingClientRect().top-document.querySelector('#block-scroller').getBoundingClientRect().top-anchor.offset)<1;
    }, anchor);
    assert.ok(await blocks.count() <= 32);
    await page.locator('.floor-header').hover();
    await page.getByRole('button', { name: '复制消息', exact: true }).click();
    await page.waitForFunction(() => window.copiedMessage?.includes('Block 159'));
    assert.equal(await page.evaluate(() => window.completeReads), 1);
    assert.ok((await page.evaluate(() => window.copiedMessage)).startsWith('Block 0'));
    assert.ok(await blocks.count() <= 32);
    // The resident page can begin in the middle of one continuous reasoning group. Adding an
    // earlier page or releasing its prefix must keep the already expanded production card.
    await page.evaluate(() => window.showThoughtPage());
    await page.getByRole('button', { name: '展开思考内容', exact: true }).first().click();
    await page.locator('.thought-content').waitFor();
    await page.evaluate(() => { window.heldThought = document.querySelector('.thought-panel'); window.prependThoughtPage(); });
    await page.waitForFunction(() => document.querySelector('.thought-content')?.textContent.includes('Block 0'));
    assert.equal(await page.evaluate(() => document.querySelector('.thought-panel') === window.heldThought), true);
    await page.evaluate(() => window.removeThoughtPrefix());
    await page.waitForFunction(() => document.querySelector('.thought-content')?.textContent.startsWith('Block 48'));
    assert.equal(await page.evaluate(() => document.querySelector('.thought-panel') === window.heldThought), true);
    assert.ok(await blocks.count() <= 32);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error('Content fixture diagnostics:', errors, await page?.evaluate(() => {
      const button = document.querySelector('button[aria-label="复制消息"]');
      const actions = button?.closest('.message-actions'), floor = button?.closest('.message-floor');
      const rect = button?.getBoundingClientRect(), style = actions ? getComputedStyle(actions) : null;
      return { scrollTop: document.querySelector('#block-scroller')?.scrollTop, floorHovered: floor?.matches(':hover'),
        actions: style && { opacity: style.opacity, pointerEvents: style.pointerEvents, top: style.top, right: style.right },
        button: rect?.toJSON(), hit: rect ? document.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          .slice(0, 5).map(element => ({ tag: element.tagName, class: element.className, key: element.getAttribute('data-content-block-key') })) : [] };
    }));
    throw error;
  }
  finally { await browser?.close(); await server.close(); }
});

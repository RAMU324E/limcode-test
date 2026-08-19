const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function vueTemplates() {
  const root = path.join(ROOT, 'webview', 'src');
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.vue')) files.push(absolute);
    }
  };
  walk(root);
  return files.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const template = text.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
    return { file: path.relative(ROOT, file), template };
  });
}

test('front-end copy uses natural Agent and status wording', () => {
  const agentPanel = source('webview/src/components/input/ReliableAgentStatusPanel.vue');
  const composer = source('webview/src/components/input/Composer.vue');
  const tabHeader = source('webview/src/components/layout/TabHeader.vue');
  const plan = source('webview/src/components/plan/PlanProposalContent.vue');

  assert.match(agentPanel, /暂无子 Agent。/);
  assert.match(composer, /panel-title="连接状态"/);
  assert.match(composer, /label: '模型渠道'/);
  assert.match(composer, /label: 'LLM'/);
  assert.match(tabHeader, /panel-title="当前任务"/);
  assert.match(plan, /Plan/);

  const allSource = [
    source('webview/src/components/input/ReliableAgentStatusPanel.vue'),
    source('webview/src/domain/reliableAgentStatusProjection.ts'),
    source('webview/src/sidebar/SidebarApp.vue'),
    composer,
    tabHeader
  ].join('\n');
  for (const forbidden of [
    '暂无直接 child Agent',
    'child Agent',
    'Child Agent',
    '子代理',
    '子树执行中',
    '终止子树',
    '等待主 Agent 接收',
    '答案交付',
    '交付失败',
    '可靠 Turn 状态',
    '运行时与传输',
    'Turn authority 模板'
  ]) {
    assert.doesNotMatch(allSource, new RegExp(forbidden), `forbidden UI copy remains: ${forbidden}`);
  }
});

test('guidance queue uses a passive bolt and waits for the current response and tools', () => {
  const queue = source('webview/src/components/input/ReliableQueuePanel.vue');

  assert.match(queue, /IconBolt class="reliable-queue-guide-icon"/);
  assert.match(queue, /引导消息/);
  assert.match(queue, /等待当前回复和工具完成/);
  assert.match(queue, /IconPencil/);
  assert.match(queue, /IconTrash/);
  assert.match(queue, /IconGripVertical/);
  assert.match(queue, /IconPlayerPause/);
  assert.match(queue, /editGuidance/);
  assert.match(queue, /cancelGuidance/);
  assert.match(queue, /reorderGuidance/);
  assert.match(queue, /setGuidancePaused/);
  assert.doesNotMatch(queue, /force-send|promoteTurnIntent|立即执行/);
});

test('Vue templates call LLMs LLM while preserving OpenAI and 模型渠道', () => {
  for (const { file, template } of vueTemplates()) {
    const normalized = template.replaceAll('OpenAI', '').replaceAll('模型渠道', '');
    assert.doesNotMatch(normalized, /(?<![A-Za-z])AI(?![A-Za-z])|模型/, `${file} contains obsolete AI/model wording`);
  }
});

test('thought cards render Markdown and merge adjacent reasoning output items', async (context) => {
  const { createServer } = await import('vite');
  const server = await createServer({
    configFile: path.join(ROOT, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
  context.after(async () => server.close());

  const markdown = await server.ssrLoadModule('/src/components/content/markdown/markdownRenderer.ts');
  assert.equal(
    markdown.renderInlineMarkdown('**Assessing phase semantics**'),
    '<strong>Assessing phase semantics</strong>'
  );

  const softBreakSource = 'first reasoning line\nsecond reasoning line';
  const htmlFrom = (parts) => parts
    .filter((part) => part.kind === 'html')
    .map((part) => part.html)
    .join('');
  const commonmarkHtml = htmlFrom(markdown.renderMarkdownParts(softBreakSource));
  const thoughtHtml = htmlFrom(markdown.renderMarkdownParts(softBreakSource, { preserveSoftBreaks: true }));
  assert.equal(commonmarkHtml.includes('<br>'), false);
  assert.equal(thoughtHtml.includes('<br>'), true);
  assert.equal(htmlFrom(markdown.renderMarkdownParts(softBreakSource)), commonmarkHtml,
    'thought soft-break cache must not alter ordinary Markdown rendering');

  const streamingRenderer = markdown.createStreamingMarkdownPartsRenderer();
  const commonmarkStreamHtml = htmlFrom(streamingRenderer.render(softBreakSource, { streaming: true }));
  const thoughtStreamHtml = htmlFrom(streamingRenderer.render(softBreakSource, {
    streaming: true,
    preserveSoftBreaks: true
  }));
  assert.equal(commonmarkStreamHtml.includes('<br>'), false);
  assert.equal(thoughtStreamHtml.includes('<br>'), true,
    'switching one streaming renderer to thought mode must reset its prior CommonMark state');

  const thoughtView = source('webview/src/components/content/parts/ThoughtPartView.vue');
  assert.match(thoughtView, /v-html="previewHtml"/);
  assert.match(thoughtView, /<TextPartView[\s\S]*?\smarkdown(?:\s|\n)/);
  assert.match(thoughtView, /preserve-soft-breaks/);
  assert.doesNotMatch(thoughtView, /<pre>\{\{ displayedText \}\}<\/pre>/);

  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {}
  };
  context.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const { toRenderNodes } = await server.ssrLoadModule('/src/components/content/partRegistry.ts');
  const thought = (id, text) => ({
    text,
    thought: true,
    outputItem: { id, type: 'reasoning' }
  });
  const text = (id, value) => ({
    text: value,
    outputItem: { id, type: 'message' }
  });

  const merged = toRenderNodes([
    thought('reasoning-1', '**Analyzing context**'),
    thought('reasoning-2', '**Inspecting implementation**')
  ]);
  assert.deepEqual(merged.map((node) => node.kind), ['thought']);
  assert.equal(merged[0].props.text, '**Analyzing context**\n**Inspecting implementation**');

  const splitTextItems = toRenderNodes([text('message-1', 'first'), text('message-2', 'second')]);
  assert.deepEqual(splitTextItems.map((node) => node.kind), ['text', 'text']);

  const visibleTextBoundary = toRenderNodes([
    thought('reasoning-1', 'before text'),
    text('message-1', 'visible'),
    thought('reasoning-2', 'after text')
  ]);
  assert.deepEqual(visibleTextBoundary.map((node) => node.kind), ['thought', 'text', 'thought']);

  const toolBoundary = toRenderNodes([
    thought('reasoning-1', 'before tool'),
    { id: 'tool-1', functionCall: { name: 'read', args: {} } },
    thought('reasoning-2', 'after tool')
  ]);
  assert.deepEqual(toolBoundary.map((node) => node.kind), ['thought', 'functionCall', 'thought']);
});

test('长流积压达到阈值时直刷，terminal时立即显示完整文本', async (context) => {
  const server = await createViteServer(context);
  const vue = await import('vue');
  const { useSmoothStreamingText } = await server.ssrLoadModule(
    '/src/components/content/useSmoothStreamingText.ts'
  );

  const frames = new Map();
  let nextFrameId = 1;
  const previousWindow = globalThis.window;
  globalThis.window = {
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis)
  };

  const renderer = vue.createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement() { return {}; },
    createText() { return {}; },
    createComment() { return {}; },
    setText() {},
    setElementText() {},
    parentNode() { return null; },
    nextSibling() { return null; },
    querySelector() { return null; },
    setScopeId() {},
    cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  const source = vue.ref('a');
  const streaming = vue.ref(true);
  let smooth;
  const app = renderer.createApp(vue.defineComponent({
    setup() {
      smooth = useSmoothStreamingText(
        () => source.value,
        () => streaming.value,
        { animateReplace: true, flushLagChars: 2_048 }
      );
      return () => null;
    }
  }));
  app.mount({});
  context.after(() => {
    app.unmount();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  const runFrames = () => {
    let now = performance.now();
    while (frames.size > 0) {
      const batch = [...frames.values()];
      frames.clear();
      now += 16;
      for (const callback of batch) callback(now);
    }
  };

  await vue.nextTick();
  runFrames();
  assert.equal(smooth.displayedText.value, 'a');

  const burst = `a${'x'.repeat(2_048)}`;
  source.value = burst;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, burst, '大积压应在watch同步阶段直接刷新');
  assert.equal(frames.size, 0);

  const terminalTarget = `${burst}${'tail'.repeat(100)}`;
  source.value = terminalTarget;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, burst, '小积压在流中仍保留平滑输出');
  assert.ok(frames.size > 0);

  streaming.value = false;
  await vue.nextTick();
  assert.equal(smooth.displayedText.value, terminalTarget, 'terminal切换必须立即同步完整文本');
  assert.equal(frames.size, 0, 'terminal切换必须取消未执行的追赶帧');

  const textPartSource = fs.readFileSync(
    path.join(ROOT, 'webview/src/components/content/parts/TextPartView.vue'),
    'utf8'
  );
  assert.match(textPartSource, /\{ animateReplace: true, flushLagChars: 2_048 \}/);
});

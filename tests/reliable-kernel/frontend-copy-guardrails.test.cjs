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

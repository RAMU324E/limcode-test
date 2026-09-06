const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

class MockUri {
  constructor(uriPath) {
    this.path = String(uriPath).replace(/\/{2,}/g, '/');
  }

  static joinPath(base, ...segments) {
    return new MockUri([base.path.replace(/\/$/, ''), ...segments].join('/'));
  }

  toString() {
    return `file://${this.path}`;
  }
}

class MockRelativePattern {
  constructor(base, pattern) {
    this.baseUri = base;
    this.pattern = pattern;
  }
}

const createdPatterns = [];
const vscodeMock = {
  Uri: MockUri,
  RelativePattern: MockRelativePattern,
  workspace: {
    fs: {},
    createFileSystemWatcher(relativePattern) {
      createdPatterns.push(relativePattern);
      return {
        onDidCreate() {},
        onDidChange() {},
        onDidDelete() {},
        dispose() {}
      };
    }
  }
};

const previousTsLoader = require.extensions['.ts'];
const originalModuleLoad = Module._load;
require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { registerGlobalSettingsWatcher, sectionFromSettingsUri } = require('../vscode/watchers/GlobalSettingsWatcher.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

test('设置监听只从 settings 和三个配置小目录开始', () => {
  createdPatterns.length = 0;
  const subscriptions = [];
  registerGlobalSettingsWatcher({
    globalStorageUri: new MockUri('/canonical-storage'),
    subscriptions
  }, {
    getStorageRootUri() {
      return new MockUri('/custom-data');
    },
    async refreshGlobalSettings() {}
  });

  assert.equal(subscriptions.length, 1);
  assert.deepEqual(createdPatterns.map((entry) => ({
    base: entry.baseUri.path,
    pattern: entry.pattern
  })), [
    {
      base: '/custom-data/settings',
      pattern: '{llm,llm-compression,appearance,attachments,checkpoint-maintenance,debug-capture}.json'
    },
    { base: '/custom-data/settings/llm-provider-configs', pattern: '**/*.json' },
    { base: '/custom-data/settings/llm-compression-configs', pattern: '**/*.json' },
    { base: '/custom-data/settings/mcp-servers', pattern: '**/*.json' },
    { base: '/canonical-storage', pattern: '.limcode-global-status.json' }
  ]);
  assert.equal(createdPatterns.some((entry) => entry.baseUri.path === '/custom-data'), false,
    '不得再从整个插件数据目录递归监听');
});

test('侧栏不再创建旧的会话历史文件监听', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'vscode/views/SidebarEntryView.ts'), 'utf8');
  assert.doesNotMatch(source, /createFileSystemWatcher/);
  assert.doesNotMatch(source, /getConversationHistoryRootUri/);
});

test('调试默认设置复用设置监听，不把取证正文纳入监听', () => {
  assert.equal(sectionFromSettingsUri(new MockUri('/custom-data/settings/debug-capture.json')), 'debugCapture');
  assert.equal(sectionFromSettingsUri(new MockUri('/custom-data/diagnostics/debug-captures/record/events.jsonl')), undefined);
});

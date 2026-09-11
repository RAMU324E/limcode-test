import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class EventEmitter {
  listeners = new Set();
  event = (listener, receiver, disposables) => {
    const bound = receiver ? listener.bind(receiver) : listener;
    this.listeners.add(bound);
    const disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(disposable);
    return disposable;
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; this.authority = ''; }
  static file(fsPath) { return new Uri(fsPath); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}
let registeredSerializer;
const vscode = {
  Uri, EventEmitter, ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] },
  window: {
    registerWebviewPanelSerializer(_viewType, serializer) {
      registeredSerializer = serializer;
      return { dispose() {} };
    }
  }
};
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { MainPanel } = require(path.join(compiledRoot, 'vscode/panels/MainPanel.js'));
const { RootAuthority } = require(path.join(compiledRoot, 'backend/reliableKernel/rootAuthority.js'));
const { initializeEmptyRuntimeRoot } = require(path.join(compiledRoot, 'backend/reliableKernel/runtimeDatabase.js'));
const { ConversationRuntimeOwnerManager } = require(path.join(compiledRoot, 'backend/reliableKernel/ConversationRuntimeOwnerManager.js'));

for (const failureStage of ['attach', 'render']) {
  test(`恢复面板在 ${failureStage} 失败后释放空闲对话，其他宿主可以立即打开`, { timeout: 15000 }, async () => {
    const fixture = await createFixture();
    const panel = createPanel();
    const attachedClients = new Set();
    try {
      const injectedFailure = new Error(`Webview ${failureStage} failed`);
      const facade = {
        waitUntilHydrated: async () => {},
        conversationExists: async () => true,
        getConversationDisplayTitle: () => '恢复的对话',
        retainConversation: (id, referenceId) => fixture.owner.retain(id, referenceId),
        releaseConversation: (id, referenceId) => fixture.owner.release(id, referenceId),
        attachWebview() {
          if (failureStage === 'attach') throw injectedFailure;
          attachedClients.add('restored-client');
          panel.failNextHtml = injectedFailure;
          return 'restored-client';
        },
        setWebviewVisible() {},
        detachWebview(id) { attachedClients.delete(id); }
      };
      MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, {
        wait: async () => facade
      });
      await registeredSerializer.deserializeWebviewPanel(panel, { conversationId: 'restored-conversation' });
      await fixture.owner.sweepIdle();
      assert.equal(MainPanel.getOpenConversationPanelStates().some(entry => entry.conversationId === 'restored-conversation'), false);
      assert.equal(attachedClients.size, 0, '失败面板不得遗留订阅会话');
      assert.equal(await fixture.peer.tryClaim('restored-conversation'), true, '失败恢复不应永久占用空闲对话');
    } finally {
      panel.dispose();
      await fixture.close();
    }
  });
}

test('恢复面板在认领等待期间关闭不会遗留对话归属', { timeout: 15000 }, async () => {
  const fixture = await createFixture();
  const panel = createPanel();
  let resumeClaim;
  let signalClaimed;
  const claimed = new Promise(resolve => { signalClaimed = resolve; });
  const gate = new Promise(resolve => { resumeClaim = resolve; });
  try {
    const facade = {
      waitUntilHydrated: async () => {},
      conversationExists: async () => true,
      getConversationDisplayTitle: () => '恢复的对话',
      async retainConversation(id, referenceId) {
        await fixture.owner.retain(id, referenceId);
        signalClaimed();
        await gate;
      },
      releaseConversation: (id, referenceId) => fixture.owner.release(id, referenceId),
      attachWebview() { assert.fail('已关闭的面板不得建立 Feed'); }
    };
    MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, {
      wait: async () => facade
    });
    const restoration = registeredSerializer.deserializeWebviewPanel(panel, { conversationId: 'restored-conversation' });
    await claimed;
    assert.equal(await fixture.peer.tryClaim('restored-conversation'), false);
    panel.dispose();
    resumeClaim();
    await restoration;
    assert.equal(await fixture.peer.tryClaim('restored-conversation'), true);
  } finally {
    resumeClaim();
    panel.dispose();
    await fixture.close();
  }
});

function createPanel() {
  const disposed = new EventEmitter();
  const panel = {
    title: '恢复的对话', visible: true, viewColumn: 1, failNextHtml: undefined,
    onDidDispose: disposed.event,
    dispose() { disposed.fire(); disposed.dispose(); },
    webview: {
      options: {}, cspSource: 'vscode-webview:',
      asWebviewUri: uri => uri,
      set html(_value) {
        if (!panel.failNextHtml) return;
        const error = panel.failNextHtml;
        panel.failNextHtml = undefined;
        throw error;
      }
    }
  };
  return panel;
}

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-panel-owner-'));
  const authority = new RootAuthority(() => path.join(directory, 'control', 'active'));
  const binding = await initializeEmptyRuntimeRoot(authority);
  const owner = new ConversationRuntimeOwnerManager(binding, 'restoring-window');
  const peer = new ConversationRuntimeOwnerManager(binding, 'peer-window');
  owner.setPendingWorkProbe(async () => false);
  peer.setPendingWorkProbe(async () => false);
  return { directory, owner, peer, async close() {
    await Promise.all([owner.close(), peer.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  } };
}

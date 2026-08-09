const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

class MockUri {
  constructor(fsPath) {
    this.scheme = 'file';
    this.fsPath = path.resolve(fsPath);
    this.path = this.fsPath.replaceAll('\\', '/');
  }

  static file(fsPath) {
    return new MockUri(fsPath);
  }

  static joinPath(base, ...segments) {
    return new MockUri(path.join(base.fsPath, ...segments));
  }

  toString() {
    return `file://${this.path}`;
  }
}

const vscodeMock = {
  Uri: MockUri,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: (uri) => fsp.mkdir(uri.fsPath, { recursive: true }),
      readDirectory: async (uri) => (await fsp.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fsp.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fsp.writeFile(uri.fsPath, data);
      },
      delete: (uri) => fsp.rm(uri.fsPath, { recursive: true, force: false })
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

const revision = require('../backend/capabilities/vscodeStorage/storageRevision.ts');
const recordStore = require('../backend/capabilities/vscodeStorage/recordStore.ts');
const globalSettings = require('../backend/capabilities/vscodeStorage/globalSettings.ts');
const globalStatus = require('../backend/capabilities/vscodeStorage/globalStatus.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

test('内容指纹不受对象键插入顺序影响', () => {
  assert.equal(
    revision.createStorageRevision({ b: 2, a: { y: true, x: false } }),
    revision.createStorageRevision({ a: { x: false, y: true }, b: 2 })
  );
});

test('旧窗口不能覆盖 record 设置集合的新提交', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-cas-records-'));
  const root = MockUri.file(tempRoot);
  const index = MockUri.joinPath(root, 'index.json');
  try {
    const missingRevision = recordStore.missingRecordStoreRevision(index);
    const first = await recordStore.commitRecordStoreSnapshot(
      root,
      index,
      [{ id: 'provider-a', name: 'A' }],
      'record',
      (item) => item.name,
      { expectedRevision: missingRevision, section: 'providers', pruneMissing: true }
    );
    const second = await recordStore.commitRecordStoreSnapshot(
      root,
      index,
      [...first.records, { id: 'provider-b', name: 'B' }],
      'record',
      (item) => item.name,
      { expectedRevision: first.revision, section: 'providers', pruneMissing: true }
    );

    await assert.rejects(
      recordStore.commitRecordStoreSnapshot(
        root,
        index,
        [{ id: 'provider-a', name: 'A from stale window' }],
        'record',
        (item) => item.name,
        { expectedRevision: first.revision, section: 'providers', pruneMissing: true }
      ),
      (error) => error?.settingsRevisionConflict === true
    );

    const stored = await recordStore.loadRecordStoreSnapshot(root, index, 'record');
    assert.equal(stored.revision, second.revision);
    assert.deepEqual(stored.records.map((item) => item.id), ['provider-a', 'provider-b']);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Windows rename 返回 EPERM 时会按已有锁竞争等待并重试', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-record-store-win-contention-'));
  const transactionPath = path.join(tempRoot, 'authority');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  let injectedContentionErrors = 0;
  try {
    await fsp.mkdir(lockPath, { recursive: true });
    await fsp.writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      ownerToken: 'competing-owner',
      pid: process.pid,
      createdAt: Date.now(),
      indexPath: transactionPath
    }));

    fsp.rename = async (source, destination) => {
      const isCandidatePublication = destination === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      const lockExists = isCandidatePublication
        ? await fsp.stat(lockPath).then(() => true, () => false)
        : false;
      if (lockExists) {
        injectedContentionErrors += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path: source,
          dest: destination
        });
      }
      return originalRename(source, destination);
    };

    let actionRuns = 0;
    await Promise.all([
      recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => { actionRuns += 1; }),
      new Promise((resolve) => setTimeout(resolve, 100))
        .then(() => fsp.rm(lockPath, { recursive: true, force: true }))
    ]);

    assert.ok(injectedContentionErrors > 0);
    assert.equal(actionRuns, 1);
    assert.deepEqual(
      (await fsp.readdir(tempRoot)).filter((entry) => entry.startsWith('authority.lock')),
      []
    );
  } finally {
    fsp.rename = originalRename;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('旧窗口不能覆盖普通设置文件的新提交', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-cas-file-'));
  const root = MockUri.file(tempRoot);
  try {
    const initial = await globalSettings.loadGlobalSettingsFile(root, 'appearance');
    const first = await globalSettings.writeGlobalSettingsFile(root, 'appearance', {
      ...initial.settings,
      streamingTextWaiting: '窗口 A 已保存'
    }, initial.revision);

    await assert.rejects(
      globalSettings.writeGlobalSettingsFile(root, 'appearance', {
        ...initial.settings,
        streamingTextWaiting: '窗口 B 的旧内容'
      }, initial.revision),
      (error) => error?.settingsRevisionConflict === true
    );

    const stored = await globalSettings.loadGlobalSettingsFile(root, 'appearance');
    assert.equal(stored.revision, first.revision);
    assert.equal(stored.settings.streamingTextWaiting, '窗口 A 已保存');
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('两个 Extension Host 不能用旧 common 版本覆盖代理设置', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-common-cas-'));
  const createContext = () => {
    let projected;
    return {
      globalStorageUri: MockUri.file(tempRoot),
      globalState: {
        get: () => projected,
        update: async (_key, value) => { projected = value; }
      }
    };
  };
  const firstContext = createContext();
  const staleContext = createContext();
  try {
    const initial = await globalStatus.loadCommittedGlobalStatus(firstContext);
    const stale = await globalStatus.loadCommittedGlobalStatus(staleContext);
    assert.equal(globalStatus.globalStatusRevision(initial), globalStatus.globalStatusRevision(stale));

    const committed = await globalStatus.saveGlobalStatusExpected(
      firstContext,
      initial.dataRootPath,
      'http://proxy-a.example',
      globalStatus.globalStatusRevision(initial)
    );
    await assert.rejects(
      globalStatus.saveGlobalStatusExpected(
        staleContext,
        stale.dataRootPath,
        'http://stale-proxy.example',
        globalStatus.globalStatusRevision(stale)
      ),
      (error) => error?.settingsRevisionConflict === true
    );
    const reloaded = await globalStatus.loadCommittedGlobalStatus(staleContext);
    assert.equal(reloaded.proxy, 'http://proxy-a.example');
    assert.equal(globalStatus.globalStatusRevision(reloaded), globalStatus.globalStatusRevision(committed.current));
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('损坏设置会报错且不会被默认值覆盖', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-corrupt-'));
  const root = MockUri.file(tempRoot);
  const target = path.join(tempRoot, 'appearance.json');
  const damaged = '{ definitely-not-json';
  try {
    await fsp.writeFile(target, damaged, 'utf8');
    await assert.rejects(globalSettings.loadGlobalSettingsFile(root, 'appearance'));
    assert.equal(await fsp.readFile(target, 'utf8'), damaged);
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

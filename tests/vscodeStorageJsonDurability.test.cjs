const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const workspaceFs = {
  async readFile() {
    const error = new Error('workspace readFile was not configured');
    error.code = 'EIO';
    throw error;
  },
  async writeFile() {
    throw new Error('workspace writeFile was not configured');
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
  if (request === 'vscode') return { workspace: { fs: workspaceFs } };
  return originalModuleLoad.call(this, request, parent, isMain);
};

const durableWrite = require('../backend/capabilities/vscodeStorage/durableWrite.ts');
const json = require('../backend/capabilities/vscodeStorage/json.ts');
const syncJson = require('../backend/capabilities/vscodeStorage/syncJson.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-json-durable-'));
}

async function removeTempDir(target) {
  await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

function fileUri(filePath) {
  return { scheme: 'file', fsPath: filePath, toString: () => `file://${filePath}` };
}

function remoteUri(value = 'settings.json') {
  return { scheme: 'test-storage', fsPath: value, toString: () => `test-storage:/${value}` };
}

function userDataUri(filePath) {
  return { scheme: 'vscode-userdata', fsPath: filePath, toString: () => `vscode-userdata:${filePath}` };
}

test('持久化 JSON 在替换目标文件前先确认临时文件写进磁盘', async () => {
  const tempRoot = await makeTempDir();
  const originalOpen = fsp.open;
  const originalRename = fsp.rename;
  const events = [];
  try {
    fsp.open = async function trackedOpen(target, ...rest) {
      const handle = await originalOpen.call(this, target, ...rest);
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push({ kind: 'fsync', target: path.resolve(String(target)) });
        return originalSync();
      };
      return handle;
    };
    fsp.rename = async function trackedRename(source, target) {
      events.push({ kind: 'rename', source: path.resolve(String(source)), target: path.resolve(String(target)) });
      return originalRename.call(this, source, target);
    };

    const target = path.join(tempRoot, 'settings.json');
    await json.writeJson(fileUri(target), { current: true });

    const dataSyncIndex = events.findIndex((event) => event.kind === 'fsync' && event.target.endsWith('.tmp'));
    const renameIndex = events.findIndex(
      (event) => event.kind === 'rename' && event.target === path.resolve(target)
    );
    assert.notEqual(dataSyncIndex, -1);
    assert.notEqual(renameIndex, -1);
    assert.ok(dataSyncIndex < renameIndex, '必须先确认临时文件，再替换正式文件');
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { current: true });
  } finally {
    fsp.open = originalOpen;
    fsp.rename = originalRename;
    await removeTempDir(tempRoot);
  }
});

test('真实的 fsync I/O 错误会阻止发布并保留旧 JSON', async () => {
  const tempRoot = await makeTempDir();
  const originalOpen = fsp.open;
  try {
    const target = path.join(tempRoot, 'settings.json');
    await fsp.writeFile(target, JSON.stringify({ previous: true }), 'utf8');
    fsp.open = async function failingOpen(openTarget, ...rest) {
      const handle = await originalOpen.call(this, openTarget, ...rest);
      if (String(openTarget).endsWith('.tmp')) {
        handle.sync = async () => {
          const error = new Error('injected disk I/O failure');
          error.code = 'EIO';
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      json.writeJson(fileUri(target), { replacement: true }),
      (error) => error.code === 'EIO'
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { previous: true });
    assert.deepEqual((await fsp.readdir(tempRoot)).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    fsp.open = originalOpen;
    await removeTempDir(tempRoot);
  }
});

test('同步 JSON 同样在替换目标文件前先确认临时文件', async () => {
  const tempRoot = await makeTempDir();
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  const events = [];
  try {
    fs.fsyncSync = function trackedFsync(descriptor) {
      events.push({ kind: 'fsync' });
      return originalFsync.call(this, descriptor);
    };
    fs.renameSync = function trackedRename(source, target) {
      events.push({ kind: 'rename', source: path.resolve(String(source)), target: path.resolve(String(target)) });
      return originalRename.call(this, source, target);
    };

    const target = path.join(tempRoot, 'records.json');
    syncJson.writeJsonFileAtomicSync(target, { current: true });

    const dataSyncIndex = events.findIndex((event) => event.kind === 'fsync');
    const renameIndex = events.findIndex(
      (event) => event.kind === 'rename' && event.target === path.resolve(target)
    );
    assert.notEqual(dataSyncIndex, -1);
    assert.notEqual(renameIndex, -1);
    assert.ok(dataSyncIndex < renameIndex, '同步写也必须先确认临时文件，再替换正式文件');
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { current: true });
  } finally {
    fs.fsyncSync = originalFsync;
    fs.renameSync = originalRename;
    await removeTempDir(tempRoot);
  }
});

test('普通文件 fsync 即使报告不支持也会保持严格并阻止替换', async () => {
  const tempRoot = await makeTempDir();
  const originalOpen = fsp.open;
  try {
    const target = path.join(tempRoot, 'settings.json');
    await fsp.writeFile(target, JSON.stringify({ previous: true }));
    fsp.open = async function unsupportedOpen(openTarget, ...rest) {
      const handle = await originalOpen.call(this, openTarget, ...rest);
      if (String(openTarget).endsWith('.tmp')) {
        handle.sync = async () => {
          const error = new Error('fsync is not supported');
          error.code = 'ENOTSUP';
          throw error;
        };
      }
      return handle;
    };
    await assert.rejects(
      durableWrite.writeFileAtomicDurable(target, JSON.stringify({ replacement: true })),
      (error) => error.code === 'ENOTSUP'
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { previous: true });
  } finally {
    fsp.open = originalOpen;
    await removeTempDir(tempRoot);
  }
});

test('POSIX 目录确认写盘的真实错误会报告给调用方', { skip: process.platform === 'win32' }, async () => {
  const tempRoot = await makeTempDir();
  const originalOpen = fsp.open;
  try {
    const target = path.join(tempRoot, 'settings.json');
    fsp.open = async function directoryFailure(openTarget, ...rest) {
      const handle = await originalOpen.call(this, openTarget, ...rest);
      if (path.resolve(String(openTarget)) === path.resolve(tempRoot)) {
        handle.sync = async () => {
          const error = new Error('injected directory I/O failure');
          error.code = 'EIO';
          throw error;
        };
      }
      return handle;
    };

    await assert.rejects(
      json.writeJson(fileUri(target), { published: true }),
      (error) => error.code === 'EIO'
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { published: true });
  } finally {
    fsp.open = originalOpen;
    await removeTempDir(tempRoot);
  }
});

test('同步 JSON 写入遇到真实磁盘错误时也保留旧文件', async () => {
  const tempRoot = await makeTempDir();
  const originalFsync = fs.fsyncSync;
  try {
    const target = path.join(tempRoot, 'records.json');
    fs.writeFileSync(target, JSON.stringify({ previous: true }), 'utf8');
    fs.fsyncSync = () => {
      const error = new Error('injected synchronous disk I/O failure');
      error.code = 'EIO';
      throw error;
    };

    assert.throws(
      () => syncJson.writeJsonFileAtomicSync(target, { replacement: true }),
      (error) => error.code === 'EIO'
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { previous: true });
  } finally {
    fs.fsyncSync = originalFsync;
    await removeTempDir(tempRoot);
  }
});

test('读取 JSON 时仅真正缺失返回 undefined，损坏与 I/O 错误都会抛出', async () => {
  const tempRoot = await makeTempDir();
  const originalRemoteRead = workspaceFs.readFile;
  try {
    assert.equal(await json.readJson(fileUri(path.join(tempRoot, 'missing.json'))), undefined);

    const invalidPath = path.join(tempRoot, 'invalid.json');
    await fsp.writeFile(invalidPath, '{invalid', 'utf8');
    await assert.rejects(json.readJson(fileUri(invalidPath)), SyntaxError);

    const emptyPath = path.join(tempRoot, 'empty.json');
    await fsp.writeFile(emptyPath, '   \n', 'utf8');
    await assert.rejects(json.readJson(fileUri(emptyPath)), /JSON file is empty/);

    workspaceFs.readFile = async () => {
      const error = new Error('no such file appears in a misleading I/O message');
      error.code = 'EIO';
      throw error;
    };
    await assert.rejects(json.readJson(remoteUri()), (error) => error.code === 'EIO');

    workspaceFs.readFile = async () => {
      const error = new Error('provider-specific missing file');
      error.code = 'FileNotFound';
      throw error;
    };
    assert.equal(await json.readJson(remoteUri()), undefined);

    assert.equal(
      syncJson.isFileNotFoundError({ code: 'EIO', message: 'ENOENT: no such file' }),
      false,
      '错误消息里的字样不能把真实 I/O 故障伪装成缺失'
    );
  } finally {
    workspaceFs.readFile = originalRemoteRead;
    await removeTempDir(tempRoot);
  }
});

test('非 file URI 保留 VS Code 文件系统回退', async () => {
  const originalRemoteWrite = workspaceFs.writeFile;
  let received;
  try {
    workspaceFs.writeFile = async (uri, data) => {
      received = { uri, text: Buffer.from(data).toString('utf8') };
    };
    const uri = remoteUri('remote-settings.json');
    await json.writeJson(uri, { remote: true });
    assert.equal(received.uri, uri);
    assert.deepEqual(JSON.parse(received.text), { remote: true });
  } finally {
    workspaceFs.writeFile = originalRemoteWrite;
  }
});

test('有绝对本地路径的 vscode-userdata 使用真实文件锁与可靠写盘', async () => {
  const tempRoot = await makeTempDir();
  try {
    const target = path.join(tempRoot, 'settings.json');
    const uri = userDataUri(target);
    await json.writeJson(uri, { source: 'userdata' });
    assert.deepEqual(await json.readJson(uri), { source: 'userdata' });
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { source: 'userdata' });
  } finally {
    await removeTempDir(tempRoot);
  }
});

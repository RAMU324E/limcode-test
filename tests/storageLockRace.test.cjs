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

const recordStore = require('../backend/capabilities/vscodeStorage/recordStore.ts');
const syncStorageResourceLock = require('../backend/capabilities/vscodeStorage/syncStorageResourceLock.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

const windowsOnly = { skip: process.platform !== 'win32' };

function injectedPublicationError(source, destination) {
  return Object.assign(new Error(`EPERM: operation not permitted, rename '${source}' -> '${destination}'`), {
    code: 'EPERM',
    syscall: 'rename',
    path: String(source),
    dest: String(destination)
  });
}

function missingPathError(target) {
  return Object.assign(new Error(`ENOENT: no such file or directory, stat '${target}'`), {
    code: 'ENOENT',
    syscall: 'stat',
    path: String(target)
  });
}

test('sync lock publication classification is invariant when canonical state flips absent to present', windowsOnly, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-sync-lock-state-flip-'));
  const resourcePath = path.join(tempRoot, 'index.json');
  const lockPath = `${resourcePath}.lock`;
  const originalRenameSync = fs.renameSync;
  const originalStatSync = fs.statSync;
  let publicationAttempts = 0;
  let canonicalStats = 0;
  try {
    fs.renameSync = function injectedRenameSync(source, destination) {
      const isPublication = String(destination) === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      if (isPublication && publicationAttempts++ === 0) throw injectedPublicationError(source, destination);
      return originalRenameSync.call(this, source, destination);
    };
    fs.statSync = function injectedStatSync(target, ...rest) {
      if (String(target) === lockPath) {
        canonicalStats += 1;
        if (canonicalStats === 1) throw missingPathError(target);
        if (canonicalStats === 2) return { isDirectory: () => true };
      }
      return originalStatSync.call(this, target, ...rest);
    };

    let actionRuns = 0;
    syncStorageResourceLock.withSyncStorageResourceLock(resourcePath, () => { actionRuns += 1; }, {
      waitMs: 1_000,
      pollIntervalMs: 1,
      maxRetries: 6,
      retryDelayMs: 1
    });
    assert.equal(actionRuns, 1);
    assert.equal(publicationAttempts, 2);
  } finally {
    fs.renameSync = originalRenameSync;
    fs.statSync = originalStatSync;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('async record-store lock publication classification is invariant when canonical state flips absent to present', windowsOnly, async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'limcode-async-lock-state-flip-'));
  const transactionPath = path.join(tempRoot, 'index.json');
  const lockPath = `${transactionPath}.lock`;
  const originalRename = fsp.rename;
  const originalStat = fsp.stat;
  let publicationAttempts = 0;
  let canonicalStats = 0;
  try {
    fsp.rename = async (source, destination) => {
      const isPublication = String(destination) === lockPath
        && String(source).startsWith(`${lockPath}.candidate-`);
      if (isPublication && publicationAttempts++ === 0) throw injectedPublicationError(source, destination);
      return originalRename(source, destination);
    };
    fsp.stat = async (target, ...rest) => {
      if (String(target) === lockPath) {
        canonicalStats += 1;
        if (canonicalStats === 1) throw missingPathError(target);
        if (canonicalStats === 2) return { isDirectory: () => true };
      }
      return originalStat(target, ...rest);
    };

    let actionRuns = 0;
    await recordStore.withRecordStoreTransaction(MockUri.file(transactionPath), async () => {
      actionRuns += 1;
    });
    assert.equal(actionRuns, 1);
    assert.equal(publicationAttempts, 2);
  } finally {
    fsp.rename = originalRename;
    fsp.stat = originalStat;
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

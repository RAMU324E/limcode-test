import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateSqliteExtensionHostEvidence } from './lib/extension-host-evidence.mjs';

const root = process.cwd();
const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--cleanup') ? 'cleanup' : 'prepare';
const smokeRoot = path.join(root, 'tests/reliable-kernel/extension-host-smoke');
const artifactRoot = path.join(root, 'tests/reliable-kernel/artifacts');
const artifactPath = path.join(artifactRoot, 'limcode-phase-b-extension-host-smoke.vsix');
const evidencePath = path.join(root, 'tests/reliable-kernel/evidence/sqlite-extension-host.json');
const extensionIdPrefix = 'limcode.phase-b-sqlite-host-smoke-';
const remoteCli = '/usr/lib/code-server/lib/vscode/bin/remote-cli/code-server';

if (mode === 'verify') {
  const result = validateSqliteExtensionHostEvidence({ root, expectedCommit: currentCommit() });
  if (result.problems.length) {
    for (const problem of result.problems) console.error(`失败：${problem}`);
    process.exit(1);
  }
  console.log(`真实code-server Extension Host SQLite证据通过：${result.evidencePath}`);
  console.log(`- VS Code ${result.evidence.vscode.version}，Node ${result.evidence.host.node}，ABI ${result.evidence.host.modules}`);
  console.log(`- better-sqlite3 ${result.evidence.driver.version}，SQLite ${result.evidence.sqliteVersion}`);
  uninstallSmokeExtensions(result.evidence.smokeExtensionId);
  process.exit(0);
}

if (mode === 'cleanup') {
  uninstallSmokeExtensions();
  fs.rmSync(smokeRoot, { recursive: true, force: true });
  fs.rmSync(artifactPath, { force: true });
  console.log('已清理Phase B Extension Host smoke扩展；证据文件保留。');
  process.exit(0);
}

if (!fs.existsSync(remoteCli)) {
  console.error(`当前环境没有code-server remote CLI：${remoteCli}`);
  process.exit(1);
}
const driverRoot = path.join(root, 'node_modules/better-sqlite3');
const driverPackage = JSON.parse(fs.readFileSync(path.join(driverRoot, 'package.json'), 'utf8'));
const nativeSource = path.join(driverRoot, 'prebuilds/linux-x64.node');
if (!fs.existsSync(nativeSource)) {
  console.error(`缺少Linux x64 better-sqlite3 native addon：${nativeSource}`);
  process.exit(1);
}
const remoteCliProbe = childProcess.spawnSync(remoteCli, ['--list-extensions'], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024
});
const remoteCliProbeOutput = [remoteCliProbe.stdout, remoteCliProbe.stderr, remoteCliProbe.error?.message]
  .filter(Boolean)
  .join('\n');
if (
  remoteCliProbe.error
  || remoteCliProbe.status !== 0
  || /Command is only available in WSL or inside a Visual Studio Code terminal/i.test(remoteCliProbeOutput)
) {
  console.error(remoteCliProbeOutput || 'code-server remote CLI不可用。');
  console.error('未修改已有Extension Host证据。');
  process.exit(1);
}

uninstallSmokeExtensions();
fs.rmSync(smokeRoot, { recursive: true, force: true });
fs.rmSync(evidencePath, { force: true });
fs.mkdirSync(path.join(smokeRoot, 'vendor/better-sqlite3/prebuilds'), { recursive: true });
fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
fs.cpSync(path.join(driverRoot, 'lib'), path.join(smokeRoot, 'vendor/better-sqlite3/lib'), { recursive: true });
fs.copyFileSync(nativeSource, path.join(smokeRoot, 'vendor/better-sqlite3/prebuilds/linux-x64.node'));
fs.copyFileSync(path.join(driverRoot, 'package.json'), path.join(smokeRoot, 'vendor/better-sqlite3/package.json'));

const commitSha = currentCommit();
const nonce = crypto.randomUUID();
const packageName = `phase-b-sqlite-host-smoke-${nonce.slice(0, 8)}`;
const extensionId = `limcode.${packageName}`;
fs.writeFileSync(path.join(smokeRoot, 'package.json'), `${JSON.stringify({
  name: packageName,
  displayName: 'LimCode Phase B SQLite Host Smoke',
  version: '0.0.1',
  publisher: 'limcode',
  private: true,
  engines: { vscode: '^1.89.0' },
  main: './extension.js',
  activationEvents: ['*'],
  files: ['extension.js', 'README.md', 'vendor/**']
}, null, 2)}\n`);
fs.writeFileSync(path.join(smokeRoot, 'README.md'), '# LimCode Phase B SQLite Host Smoke\n');
fs.writeFileSync(path.join(smokeRoot, 'extension.js'), extensionSource({
  evidencePath,
  commitSha,
  nonce,
  extensionId,
  driverVersion: driverPackage.version
}));

const packaged = childProcess.spawnSync(
  path.join(root, 'node_modules/.bin/vsce'),
  ['package', '--allow-missing-repository', '--no-dependencies', '--out', artifactPath],
  { cwd: smokeRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
);
if (packaged.error || packaged.status !== 0) {
  console.error([packaged.stdout, packaged.stderr, packaged.error?.message].filter(Boolean).join('\n'));
  process.exit(1);
}
const install = childProcess.spawnSync(remoteCli, ['--install-extension', artifactPath, '--force'], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024
});
if (install.error || install.status !== 0) {
  console.error([install.stdout, install.stderr, install.error?.message].filter(Boolean).join('\n'));
  process.exit(1);
}
if (!installedSmokeExtensionIds().includes(extensionId)) {
  console.error([install.stdout, install.stderr].filter(Boolean).join('\n'));
  console.error(
    '当前code-server remote CLI未确认smoke扩展已安装；'
      + '请在目标VS Code/code-server的集成终端中执行，或使用隔离宿主生成证据。'
  );
  process.exit(1);
}
console.log(install.stdout.trim());
console.log(`已安装一次性smoke VSIX：${artifactPath}`);
console.log(`证据nonce：${nonce}`);
for (let attempt = 0; attempt < 20 && !fs.existsSync(evidencePath); attempt += 1) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
}
if (fs.existsSync(evidencePath)) {
  console.log('扩展已在当前真实Extension Host即时激活；现在可运行 --verify。');
} else {
  console.log('请在code-server执行一次“重新加载窗口”；smoke扩展会在新Extension Host自动激活并写入证据。');
}

function uninstallSmokeExtensions(singleExtensionId) {
  if (!fs.existsSync(remoteCli)) return;
  const ids = singleExtensionId ? [singleExtensionId] : installedSmokeExtensionIds();
  for (const extensionId of ids) {
    childProcess.spawnSync(remoteCli, ['--uninstall-extension', extensionId], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 8 * 1024 * 1024
    });
  }
}

function installedSmokeExtensionIds() {
  const listed = childProcess.spawnSync(remoteCli, ['--list-extensions'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024
  });
  if (listed.error || listed.status !== 0) return [];
  return listed.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.startsWith(extensionIdPrefix));
}

function currentCommit() {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function extensionSource({ evidencePath: targetEvidencePath, commitSha: targetCommit, nonce: targetNonce, extensionId: targetExtensionId, driverVersion }) {
  return `'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const evidencePath = ${JSON.stringify(targetEvidencePath)};
const commitSha = ${JSON.stringify(targetCommit)};
const nonce = ${JSON.stringify(targetNonce)};
const smokeExtensionId = ${JSON.stringify(targetExtensionId)};
const driverVersion = ${JSON.stringify(driverVersion)};

async function activate() {
  const host = {
    pid: process.pid,
    execPath: process.execPath,
    node: process.version,
    modules: process.versions.modules,
    napi: process.versions.napi,
    electron: process.versions.electron || null,
    entrypoint: process.env.VSCODE_ESM_ENTRYPOINT || ''
  };
  const vscodeInfo = {
    applicationName: vscode.env.appName,
    version: vscode.version,
    remoteName: vscode.env.remoteName || null,
    extensionHostKind: vscode.env.remoteName && !/^(?:127\\.0\\.0\\.1|localhost|\\[::1\\])(?::\\d+)?$/i.test(vscode.env.remoteName)
      ? 'remote'
      : 'local-process'
  };
  const nativePath = path.join(__dirname, 'vendor/better-sqlite3/prebuilds/linux-x64.node');
  const packagePath = path.join(__dirname, 'vendor/better-sqlite3/package.json');
  const databasePath = path.join(path.dirname(evidencePath), 'extension-host-smoke.sqlite');
  const base = {
    kind: 'limcode-phase-b-sqlite-extension-host',
    commitSha,
    nonce,
    smokeExtensionId,
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    vscode: vscodeInfo,
    host,
    driver: {
      name: 'better-sqlite3',
      version: driverVersion,
      nativeSha256: sha256File(nativePath),
      packageSha256: sha256File(packagePath)
    }
  };
  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
    const Database = require('./vendor/better-sqlite3/lib/linux-x64.js');
    let database = new Database(databasePath);
    const sqliteVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
    database.pragma('journal_mode = WAL');
    database.exec('CREATE TABLE smoke (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO smoke (id,value) VALUES (?,?)').run('committed', 'yes');
    database.exec('COMMIT');
    const committed = database.prepare('SELECT COUNT(*) AS count FROM smoke').get().count === 1;
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO smoke (id,value) VALUES (?,?)').run('rolled-back', 'no');
    database.exec('ROLLBACK');
    const rolledBack = database.prepare('SELECT COUNT(*) AS count FROM smoke').get().count === 1;
    database.close();
    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    const reopened = database.prepare('SELECT value FROM smoke WHERE id = ?').get('committed')?.value === 'yes';
    database.close();
    writeEvidence({
      ...base,
      passed: true,
      sqliteVersion,
      assertions: {
        loaded: true,
        create: true,
        commit: committed,
        rollback: rolledBack,
        reopen: reopened
      }
    });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databasePath + suffix, { force: true });
  } catch (error) {
    writeEvidence({
      ...base,
      passed: false,
      assertions: { loaded: false, create: false, commit: false, rollback: false, reopen: false },
      error: { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack }
    });
  }
}

function writeEvidence(value) {
  const temporary = evidencePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });
  fs.renameSync(temporary, evidencePath);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function deactivate() {}
module.exports = { activate, deactivate };
`;
}

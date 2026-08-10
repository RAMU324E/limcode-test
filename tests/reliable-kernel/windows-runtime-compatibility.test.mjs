import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const distRoot = path.join(root, 'dist/extension');
const require = createRequire(import.meta.url);
const kernel = require(path.join(distRoot, 'backend/reliableKernel/index.js'));
const processProtocol = require(path.join(distRoot, 'backend/reliableKernel/processProtocol.js'));
const durableDirectorySync = require(path.join(
  distRoot,
  'backend/capabilities/filesystem/durableDirectorySync.js'
));

const windowsOnly = { skip: process.platform !== 'win32' };

test('目录元数据同步保持普通文件严格语义并兼容当前平台', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-directory-sync-'));
  try {
    const result = await durableDirectorySync.syncDirectoryDurably(directory);
    assert.equal(typeof result, 'boolean');
    if (process.platform !== 'win32') assert.equal(result, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('跨平台进程指纹可稳定识别当前进程', () => {
  const first = processProtocol.readProcessStartFingerprint(process.pid);
  const second = processProtocol.readProcessStartFingerprint(process.pid);
  assert.equal(first, second);
  assert.match(first, process.platform === 'win32'
    ? new RegExp(`^win32-process:${process.pid}:\\d+$`)
    : new RegExp(`^linux-proc:${process.pid}:\\d+$`));
});

test('完整初始化后遗留 pending RootBinding 会被严格校验并原子提交', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-pending-root-recovery-'));
  let runtime;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    runtime = await kernel.RuntimeDatabase.open(candidate.authority);
    await runtime.close();
    runtime = undefined;
    await fs.rename(candidate.binding.paths.rootPointerPath, candidate.binding.paths.rootPendingPath);

    const competingAuthority = new kernel.RootAuthority(() => candidate.binding.paths.dataRootPath);
    const [recovered, competing] = await Promise.all([
      candidate.authority.current(),
      competingAuthority.current()
    ]);
    assert.equal(recovered.dataSetId, candidate.binding.dataSetId);
    assert.equal(recovered.rootInstanceId, candidate.binding.rootInstanceId);
    assert.equal(recovered.rootGeneration, candidate.binding.rootGeneration);
    assert.equal(recovered.runtimeKernelEpoch, candidate.binding.runtimeKernelEpoch);
    assert.equal(competing.dataSetId, recovered.dataSetId);
    await fs.access(candidate.binding.paths.rootPointerPath);
    await assert.rejects(fs.access(candidate.binding.paths.rootPendingPath), { code: 'ENOENT' });
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('身份不匹配的 pending RootBinding 继续 fail closed', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-pending-root-reject-'));
  let runtime;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    runtime = await kernel.RuntimeDatabase.open(candidate.authority);
    await runtime.close();
    runtime = undefined;
    await fs.rename(candidate.binding.paths.rootPointerPath, candidate.binding.paths.rootPendingPath);
    const epoch = JSON.parse(await fs.readFile(candidate.binding.paths.runtimeEpochPath, 'utf8'));
    epoch.rootGeneration += 1;
    await fs.writeFile(candidate.binding.paths.runtimeEpochPath, `${JSON.stringify(epoch, null, 2)}\n`);

    await assert.rejects(
      candidate.authority.current(),
      (error) => error?.code === 'root-binding-pending'
    );
    await fs.access(candidate.binding.paths.rootPendingPath);
    await assert.rejects(fs.access(candidate.binding.paths.rootPointerPath), { code: 'ENOENT' });
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('Windows PowerShell Wrapper 发布完整启动、输出和退出证据', windowsOnly, async () => {
  const result = await runWindowsWrapper({ command: "Write-Output 'wrapper-ok'", timeoutMs: 10_000 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.identity.startFingerprint.startsWith('win32-process:'), true);
    assert.equal(result.manifest.status, 'exited');
    assert.equal(result.receipt.exitCode, '0');
    assert.equal(result.receipt.terminationReason, 'natural');
    assert.match(result.output, /wrapper-ok/);
    assert.equal(result.run.stderr, '');
    await assert.rejects(fs.access(path.join(result.spoolPath, 'bootstrap.ready')), { code: 'ENOENT' });
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('Windows PowerShell Wrapper 超时会终止进程树并发布终态收据', windowsOnly, async () => {
  const startedAt = Date.now();
  const result = await runWindowsWrapper({ command: 'Start-Sleep -Seconds 30', timeoutMs: 1_200 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.terminationReason, 'timed_out');
    assert.equal(result.receipt.stopRequested, false);
    assert.ok(Date.now() - startedAt < 8_000, 'timeout termination exceeded its bounded grace period');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

async function runWindowsWrapper({ command, timeoutMs }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-win32-'));
  const spoolLocator = 'process_windows_test';
  const spoolPath = path.join(parent, spoolLocator);
  await fs.mkdir(spoolPath);
  const createdAt = new Date().toISOString();
  const request = {
    kind: processProtocol.PROCESS_WRAPPER_PROTOCOL,
    processId: 'process_windows_test',
    stableNonce: '0123456789abcdef0123456789abcdef',
    command,
    cwd: parent,
    commandDigest: createHash('sha256').update(command).digest('hex'),
    spoolLocator,
    executionTimeoutMs: timeoutMs,
    executionDeadlineAt: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
    maxOutputBytes: 1024 * 1024,
    createdAt
  };
  const launchPath = path.join(spoolPath, 'launch.json');
  await fs.writeFile(launchPath, `${JSON.stringify(request, null, 2)}\n`);
  const run = childProcess.spawnSync(process.execPath, [
    path.join(distRoot, 'backend/reliableKernel/processWrapper.js'),
    launchPath
  ], { cwd: root, encoding: 'utf8', timeout: 15_000, windowsHide: true });
  if (run.error) throw run.error;

  const identity = JSON.parse(await fs.readFile(path.join(spoolPath, 'identity.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(spoolPath, 'manifest.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(path.join(spoolPath, 'exit-receipt.json'), 'utf8'));
  const chunkRoot = path.join(spoolPath, 'chunks');
  const chunks = (await fs.readdir(chunkRoot)).sort();
  const output = Buffer.concat(await Promise.all(chunks.map((name) => fs.readFile(path.join(chunkRoot, name))))).toString('utf8');
  return { parent, spoolPath, run, identity, manifest, receipt, output };
}

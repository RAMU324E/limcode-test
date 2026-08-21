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
const darwinOnly = { skip: process.platform !== 'darwin' };

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
  const expected = process.platform === 'win32'
    ? new RegExp(`^win32-process:${process.pid}:\\d+$`)
    : process.platform === 'linux'
      ? new RegExp(`^linux-proc:${process.pid}:\\d+$`)
      : process.platform === 'darwin'
        ? new RegExp(`^darwin-ps:${process.pid}:[a-f0-9]{64}$`)
        : undefined;
  assert.ok(expected, `unsupported test platform: ${process.platform}/${process.arch}`);
  assert.match(first, expected);
});

test('macOS Wrapper核验要求PID存活且命令行包含精确launch路径', darwinOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-reachable-'));
  const launchPath = path.join(parent, 'launch path.json');
  await fs.writeFile(launchPath, '{}\n');
  const child = childProcess.spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1_000)', launchPath],
    { stdio: 'ignore' }
  );
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const deadline = Date.now() + 2_000;
    while (!processProtocol.isWrapperProcessReachable(String(child.pid), launchPath)) {
      if (Date.now() >= deadline) assert.fail('Darwin wrapper command line did not become observable.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      processProtocol.isWrapperProcessReachable(String(child.pid), path.join(parent, 'other.json')),
      false
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      });
    }
    await fs.rm(parent, { recursive: true, force: true });
  }
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
  const result = await runPlatformWrapper({ command: "Write-Output 'wrapper-ok'", timeoutMs: 10_000 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.bootstrap.childPid, result.identity.childPid);
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
  const result = await runPlatformWrapper({ command: 'Start-Sleep -Seconds 30', timeoutMs: 1_200 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.terminationReason, 'timed_out');
    assert.equal(result.receipt.stopRequested, false);
    assert.ok(Date.now() - startedAt < 8_000, 'timeout termination exceeded its bounded grace period');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('macOS Bash Wrapper发布完整启动、输出和退出证据', darwinOnly, async () => {
  const result = await runPlatformWrapper({ command: "printf 'wrapper-ok\\n'", timeoutMs: 10_000 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.bootstrap.phase, 'identity_ready');
    assert.equal(result.bootstrap.childPid, result.identity.childPid);
    assert.match(result.identity.startFingerprint, /^darwin-ps:\d+:[a-f0-9]{64}$/);
    assert.equal(result.manifest.status, 'exited');
    assert.equal(result.receipt.exitCode, '0');
    assert.equal(result.receipt.terminationReason, 'natural');
    assert.match(result.output, /wrapper-ok/);
    assert.equal(result.run.stderr, '');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('macOS Bash Wrapper超时会终止进程组并发布终态收据', darwinOnly, async () => {
  const startedAt = Date.now();
  const result = await runPlatformWrapper({ command: 'sleep 30', timeoutMs: 1_200 });
  try {
    assert.equal(result.run.status, 0, result.run.stderr);
    assert.equal(result.receipt.terminationReason, 'timed_out');
    assert.equal(result.receipt.stopRequested, false);
    assert.ok(Date.now() - startedAt < 8_000, 'timeout termination exceeded its bounded grace period');
  } finally {
    await fs.rm(result.parent, { recursive: true, force: true });
  }
});

test('concurrent Windows cold starts all publish durable bootstrap and identity evidence', windowsOnly, async () => {
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => runPlatformWrapper({
    command: `Write-Output 'cold-${index}'`,
    timeoutMs: 15_000,
    suffix: `cold_${index}`
  })));
  try {
    for (const [index, result] of results.entries()) {
      assert.equal(result.run.status, 0, result.run.stderr);
      assert.equal(result.bootstrap.phase, 'identity_ready');
      assert.equal(result.bootstrap.childPid, result.identity.childPid);
      assert.match(result.output, new RegExp(`cold-${index}`));
    }
  } finally {
    await Promise.all(results.map((result) => fs.rm(result.parent, { recursive: true, force: true })));
  }
});

test('a pre-identity Windows spawn failure leaves bounded durable failure evidence', windowsOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-failure-'));
  const spoolLocator = 'process_win32_failure';
  const spoolPath = path.join(parent, spoolLocator);
  await fs.mkdir(spoolPath);
  const command = "Write-Output 'must-not-run'";
  const createdAt = new Date().toISOString();
  const request = {
    kind: processProtocol.PROCESS_WRAPPER_PROTOCOL,
    processId: 'process_win32_failure',
    stableNonce: '0123456789abcdef0123456789abcdef',
    command,
    cwd: path.join(parent, 'missing-cwd'),
    commandDigest: createHash('sha256').update(command).digest('hex'),
    spoolLocator,
    executionTimeoutMs: 10_000,
    executionDeadlineAt: new Date(Date.parse(createdAt) + 10_000).toISOString(),
    maxOutputBytes: 1024 * 1024,
    createdAt
  };
  const launchPath = path.join(spoolPath, 'launch.json');
  await fs.writeFile(launchPath, `${JSON.stringify(request, null, 2)}\n`);
  try {
    const run = await runWrapperProcess(launchPath, 15_000);
    assert.notEqual(run.status, 0);
    const bootstrap = processProtocol.parseWrapperBootstrapReceipt(JSON.parse(
      await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_BOOTSTRAP_FILE), 'utf8')
    ));
    const failure = processProtocol.parseWrapperLaunchFailureReceipt(JSON.parse(
      await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_LAUNCH_FAILURE_FILE), 'utf8')
    ));
    assert.equal(bootstrap.phase, 'wrapper_spawned');
    assert.equal(failure.phase, 'wrapper_spawned');
    assert.equal(failure.commandReleased, false);
    assert.equal(failure.childPid, null);
    assert.ok(failure.errorMessage.length <= 2_048);
    assert.doesNotMatch(failure.errorMessage, /must-not-run/);
    await assert.rejects(fs.access(path.join(spoolPath, 'identity.json')), { code: 'ENOENT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('host consumes durable pre-identity failure instead of waiting for outcome_unknown', windowsOnly, async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-wrapper-host-failure-'));
  const candidate = await kernel.resetCandidateRuntimeRoot(parent);
  const database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: 'wrapper-host-failure' });
  const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
  const effects = new kernel.EffectControlPlane(database, store);
  const processes = new kernel.ProcessControlPlane(
    database,
    store,
    effects,
    candidate.authority,
    candidate.binding
  );
  try {
    const now = new Date().toISOString();
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'wrapper-host-failure', title: 'failure', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'wrapper-host-failure-turn', conversation_id: 'wrapper-host-failure', status: 'active',
        created_at: now, updated_at: now, terminal_at: null
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: 'wrapper-host-failure-lease', conversation_id: 'wrapper-host-failure',
        turn_id: 'wrapper-host-failure-turn', owner_id: 'wrapper-host-failure-owner',
        host_boot_id: database.hostBootId, generation: 1n, acquired_at: now,
        expires_at: '2099-01-01T00:00:00.000Z'
      })
    ]);
    const toolCallId = 'wrapper-host-failure-tool';
    await effects.createToolCall({
      source: { kind: 'callback', key: toolCallId },
      toolCallId,
      turnId: 'wrapper-host-failure-turn',
      toolName: 'shell',
      arguments: { command: "Write-Output 'must-not-run'" }
    });
    const prepared = await processes.prepareStart({
      source: { kind: 'internal', key: toolCallId },
      toolCallId,
      command: "Write-Output 'must-not-run'",
      cwd: path.join(parent, 'missing-cwd')
    });
    const startedAt = Date.now();
    const dispatched = await processes.dispatchStart(prepared.effect.effectIntentId);
    assert.equal(dispatched.observation.state, 'launch_failed');
    assert.match(dispatched.observation.launch.error, /Wrapper launch failed during wrapper_spawned/);
    assert.ok(Date.now() - startedAt < 5_000, 'durable failure should beat the old fixed wait window');
  } finally {
    await processes.dispose().catch(() => undefined);
    await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function runPlatformWrapper({ command, timeoutMs, suffix = 'test' }) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-wrapper-${process.platform}-`));
  const spoolLocator = `process_${process.platform}_${suffix}`;
  const spoolPath = path.join(parent, spoolLocator);
  await fs.mkdir(spoolPath);
  const createdAt = new Date().toISOString();
  const request = {
    kind: processProtocol.PROCESS_WRAPPER_PROTOCOL,
    processId: spoolLocator,
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
  const run = await runWrapperProcess(launchPath, 15_000);

  const bootstrap = processProtocol.parseWrapperBootstrapReceipt(JSON.parse(
    await fs.readFile(path.join(spoolPath, processProtocol.PROCESS_WRAPPER_BOOTSTRAP_FILE), 'utf8')
  ));
  const identity = JSON.parse(await fs.readFile(path.join(spoolPath, 'identity.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(spoolPath, 'manifest.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(path.join(spoolPath, 'exit-receipt.json'), 'utf8'));
  const chunkRoot = path.join(spoolPath, 'chunks');
  const chunks = (await fs.readdir(chunkRoot)).sort();
  const output = Buffer.concat(await Promise.all(chunks.map((name) => fs.readFile(path.join(chunkRoot, name))))).toString('utf8');
  return { parent, spoolPath, run, bootstrap, identity, manifest, receipt, output };
}

function runWrapperProcess(launchPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [
      path.join(distRoot, 'backend/reliableKernel/processWrapper.js'),
      launchPath
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`wrapper test timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, signal, stdout, stderr });
    });
  });
}

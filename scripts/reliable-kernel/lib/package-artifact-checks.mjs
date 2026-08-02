import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Executes the packaged SQLite/CAS foundation from an isolated empty root. The workspace source and
 * unpruned dist are not loaded: every LimCode module comes from the supplied VSIX Runtime closure.
 */
export function validatePackagedPhysicalCutover(options) {
  const root = path.resolve(options.root);
  const artifactPath = path.resolve(options.artifactPath);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-package-cutover-'));
  try {
    const extracted = childProcess.spawnSync(
      'unzip',
      ['-qq', artifactPath, 'extension/dist/extension/*', '-d', temporaryRoot],
      { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    if (extracted.error || extracted.status !== 0) {
      return { problem: `无法解压VSIX Runtime闭包：${extracted.error?.message ?? extracted.stderr?.trim() ?? `退出码${extracted.status}`}` };
    }
    const extensionRoot = path.join(temporaryRoot, 'extension', 'dist', 'extension');
    const fixtureRoot = path.join(temporaryRoot, 'physical-cutover-fixture');
    const executed = childProcess.spawnSync(
      process.execPath,
      ['-e', PHYSICAL_CUTOVER_ORACLE, extensionRoot, fixtureRoot],
      {
        cwd: temporaryRoot,
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
        }
      }
    );
    const diagnostic = [executed.stdout, executed.stderr].filter(Boolean).join('\n').trim();
    if (executed.error || executed.status !== 0) {
      return { problem: `VSIX physical cutover oracle失败：${(executed.error?.message ?? diagnostic) || `退出码${executed.status}`}` };
    }
    return { problem: null, output: diagnostic || 'PASS: packaged physical cutover oracle' };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function validatePackagedEmptyRoot(options) {
  const root = path.resolve(options.root);
  const artifactPath = path.resolve(options.artifactPath);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-package-empty-root-'));
  try {
    const extracted = childProcess.spawnSync(
      'unzip',
      ['-qq', artifactPath, 'extension/dist/extension/*', '-d', temporaryRoot],
      { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    if (extracted.error || extracted.status !== 0) {
      return {
        problem: `无法解压VSIX Runtime闭包：${extracted.error?.message ?? extracted.stderr?.trim() ?? `退出码${extracted.status}`}`
      };
    }

    const extensionRoot = path.join(temporaryRoot, 'extension', 'dist', 'extension');
    const runtimeRoot = path.join(temporaryRoot, 'runtime-control', 'active');
    const executed = childProcess.spawnSync(
      process.execPath,
      ['-e', EMPTY_ROOT_ORACLE, extensionRoot, runtimeRoot],
      {
        cwd: temporaryRoot,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          NODE_PATH: [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter)
        }
      }
    );
    const diagnostic = [executed.stdout, executed.stderr].filter(Boolean).join('\n').trim();
    if (executed.error || executed.status !== 0) {
      return {
        problem: `VSIX空根/epoch oracle失败：${(executed.error?.message ?? diagnostic) || `退出码${executed.status}`}`
      };
    }
    return {
      problem: null,
      output: diagnostic || 'PASS: packaged empty root and runtime epoch oracle'
    };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const PHYSICAL_CUTOVER_ORACLE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const extensionRoot = path.resolve(process.argv[1]);
const root = path.resolve(process.argv[2]);
const { PHYSICAL_CUTOVER_MANIFEST } = require(path.join(extensionRoot, 'backend/reliableKernel/generatedPhysicalCutoverManifest.js'));
const { RootAuthority } = require(path.join(extensionRoot, 'backend/reliableKernel/rootAuthority.js'));
const { initializeCutoverRuntimeBinding, RuntimeDatabase } = require(path.join(extensionRoot, 'backend/reliableKernel/runtimeDatabase.js'));
const {
  persistPhysicalCutoverRequest,
  performPhysicalCutover,
  treeDigest
} = require(path.join(extensionRoot, 'backend/reliableKernel/physicalCutover.js'));

const drained = {
  noActiveTurn: true,
  noBackgroundProcess: true,
  noPendingProviderStream: true,
  noPersistInflight: true
};
const secretApiKey = 'packaged-cutover-secret-api-key';
const secretMcpToken = 'packaged-cutover-secret-mcp-token';

(async () => {
  await createFixture(root);
  const unknownDigest = await treeDigest(path.join(root, 'unknown-user-file.txt'));
  const preserveEvidence = new Map();
  for (const entry of [...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve]) {
    const absolute = joined(root, entry.relativePath);
    if (await exists(absolute)) preserveEvidence.set(entry.id, await treeDigest(absolute));
  }
  const authority = new RootAuthority(() => path.join(root, '.limcode-runtime', 'active'));
  await persistPhysicalCutoverRequest(root, drained);
  const result = await performPhysicalCutover(root, authority, initializeCutoverRuntimeBinding);
  assert.equal(result.cutoverPerformed, true);
  assert.equal(await treeDigest(path.join(root, 'unknown-user-file.txt')), unknownDigest);

  const archiveRoot = path.join(root, '.limcode-runtime', 'backups', result.archiveDirectoryName);
  const journal = JSON.parse(await fs.readFile(path.join(archiveRoot, 'cutover-journal.completed.json'), 'utf8'));
  const expectedIds = new Set([
    ...PHYSICAL_CUTOVER_MANIFEST.preserveWhole,
    ...PHYSICAL_CUTOVER_MANIFEST.filterByScope,
    ...PHYSICAL_CUTOVER_MANIFEST.archiveReset,
    ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve
  ].map((entry) => entry.id));
  const actualIds = new Set(journal.results.map((entry) => entry.entryId));
  assert.deepEqual([...actualIds].sort(), [...expectedIds].sort());

  for (const entry of PHYSICAL_CUTOVER_MANIFEST.archiveReset) {
    assert.equal(await exists(joined(root, entry.relativePath)), false, entry.id);
    assert.equal(await exists(joined(archiveRoot, 'entries/' + entry.relativePath)), true, entry.id);
  }
  for (const entry of [...PHYSICAL_CUTOVER_MANIFEST.preserveWhole, ...PHYSICAL_CUTOVER_MANIFEST.externalPreserve]) {
    const digest = preserveEvidence.get(entry.id);
    if (digest) assert.equal(await treeDigest(joined(root, entry.relativePath)), digest, entry.id);
  }
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.filterByScope.filter((entry) => entry.relativePath !== 'settings')) {
    const records = await readStore(joined(root, entry.relativePath));
    assert.deepEqual(records.map((record) => record.scopeKind).sort(), ['agent', 'global', 'workflow'], entry.id);
  }
  assert.equal(await exists(path.join(root, 'settings', 'conversation-oracle-llm.json')), false);
  assert.equal(await exists(path.join(root, 'settings', '.conversation-settings-transactions')), false);
  assert.equal((await readStore(path.join(root, 'settings', 'llm-provider-configs')))[0].apiKey, secretApiKey);
  assert.equal((await readStore(path.join(root, 'settings', 'mcp-servers')))[0].transport.env.TOKEN, secretMcpToken);

  const receiptText = await fs.readFile(path.join(archiveRoot, 'cutover-completion.json'), 'utf8');
  assert.equal(receiptText.includes(secretApiKey), false);
  assert.equal(receiptText.includes(secretMcpToken), false);
  let database = await RuntimeDatabase.open(authority, { hostBootId: 'package-cutover-oracle' });
  assert.equal((await database.inspect()).currentCommitSeq, '0');
  await database.close();

  const rollbackRoot = root + '-rollback';
  await createFixture(rollbackRoot);
  const rollbackEvidence = await visibleEvidence(rollbackRoot);
  const rollbackAuthority = new RootAuthority(() => path.join(rollbackRoot, '.limcode-runtime', 'active'));
  await persistPhysicalCutoverRequest(rollbackRoot, drained);
  let injected = false;
  await assert.rejects(() => performPhysicalCutover(rollbackRoot, rollbackAuthority, initializeCutoverRuntimeBinding, {
    onFaultPoint(point) {
      if (!injected && point === 'after-filter-replacement-created') {
        injected = true;
        throw new Error('packaged-cutover-injected-failure');
      }
    }
  }), /packaged-cutover-injected-failure/);
  assert.deepEqual(await visibleEvidence(rollbackRoot), rollbackEvidence);
  console.log('PASS: packaged physical manifest archives every Runtime entry, preserves/filters configuration, keeps secrets out of receipts, rolls back pre-activation faults, and opens the new SQLite/CAS root.');
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});

async function createFixture(base) {
  await fs.mkdir(base, { recursive: true });
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.preserveWhole) {
    await writeStore(joined(base, entry.relativePath), 'record', [{ id: 'preserved-' + safeId(entry.id), name: entry.id, createdAt: 1, updatedAt: 1 }]);
  }
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.filterByScope) {
    if (entry.relativePath === 'settings') continue;
    await writeStore(joined(base, entry.relativePath), 'link', ['global', 'agent', 'workflow', 'conversation', 'run', 'agentSystem'].map((scopeKind, index) => ({
      id: safeId(entry.id) + '-' + scopeKind,
      scopeKind,
      ...(scopeKind === 'global' ? {} : { scopeId: scopeKind + '-' + index }),
      role: 'active',
      createdAt: index + 1,
      updatedAt: index + 1
    })));
  }
  for (const entry of PHYSICAL_CUTOVER_MANIFEST.archiveReset) {
    const absolute = joined(base, entry.relativePath);
    if (entry.relativePath.endsWith('.json')) await writeJson(absolute, { kind: entry.id, marker: true });
    else {
      await fs.mkdir(absolute, { recursive: true });
      await writeJson(path.join(absolute, 'oracle.json'), { entryId: entry.id });
    }
  }
  await writeStore(path.join(base, 'settings', 'llm-provider-configs'), 'config', [{
    id: 'provider-oracle', name: 'Oracle', provider: 'openai-compatible', baseUrl: 'https://example.invalid',
    model: 'model-oracle', models: [{ id: 'model-oracle', name: 'model-oracle' }], apiKey: secretApiKey,
    createdAt: 1, updatedAt: 1
  }]);
  await writeStore(path.join(base, 'settings', 'mcp-servers'), 'server', [{
    id: 'mcp-oracle', name: 'Oracle MCP', enabled: true,
    transport: { kind: 'stdio', command: 'printf', args: ['ok'], env: { TOKEN: secretMcpToken } },
    createdAt: 1, updatedAt: 1
  }]);
  await writeJson(path.join(base, 'settings', 'llm.json'), {
    schemaVersion: 1, savedAt: new Date(0).toISOString(), settings: { activeProviderConfigId: 'provider-oracle' }
  });
  await writeJson(path.join(base, 'settings', 'conversation-oracle-llm.json'), {
    schemaVersion: 1, savedAt: new Date(0).toISOString(), settings: { marker: 'conversation' }
  });
  await writeJson(path.join(base, 'settings', '.conversation-settings-transactions', 'pending.json'), { state: 'committed' });
  await fs.mkdir(path.join(base, 'skills'), { recursive: true });
  await fs.writeFile(path.join(base, 'skills', 'oracle.md'), '# Oracle skill\n');
  await fs.writeFile(path.join(base, 'AGENTS.md'), '# Oracle rules\n');
  await fs.writeFile(path.join(base, 'CLAUDE.md'), '# Oracle rules\n');
  await fs.mkdir(path.join(base, '.limcode-data-backups'), { recursive: true });
  await fs.writeFile(path.join(base, '.limcode-data-backups', 'old.txt'), 'old backup\n');
  await fs.writeFile(path.join(base, 'unknown-user-file.txt'), 'unknown byte-identical\n');
}

async function visibleEvidence(base) {
  const result = {};
  for (const name of (await fs.readdir(base)).sort()) {
    if (name === '.limcode-runtime') continue;
    result[name] = await treeDigest(path.join(base, name));
  }
  return result;
}

async function writeStore(storeRoot, recordKey, records) {
  const savedAt = new Date(0).toISOString();
  await fs.mkdir(path.join(storeRoot, 'records'), { recursive: true });
  const index = [];
  for (const record of records) {
    const file = 'records/' + record.id + '.json';
    await writeJson(path.join(storeRoot, file), { schemaVersion: 1, savedAt, [recordKey]: record });
    index.push({ id: record.id, file, updatedAt: savedAt });
  }
  await writeJson(path.join(storeRoot, 'index.json'), { schemaVersion: 1, savedAt, records: index });
}

async function readStore(storeRoot) {
  const index = JSON.parse(await fs.readFile(path.join(storeRoot, 'index.json'), 'utf8'));
  const records = [];
  for (const indexed of index.records) {
    const file = JSON.parse(await fs.readFile(path.join(storeRoot, indexed.file), 'utf8'));
    const key = Object.keys(file).find((candidate) => candidate !== 'schemaVersion' && candidate !== 'savedAt');
    records.push(file[key]);
  }
  return records;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function joined(base, relative) {
  return path.join(base, ...relative.split('/'));
}

function safeId(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}
`;

const EMPTY_ROOT_ORACLE = String.raw`
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const extensionRoot = path.resolve(process.argv[1]);
const runtimeRoot = path.resolve(process.argv[2]);
const { RUNTIME_KERNEL_EPOCH } = require(path.join(extensionRoot, 'backend/reliableKernel/contracts.js'));
const { RootAuthority, RootAuthorityError, sameBindingIdentity } = require(path.join(extensionRoot, 'backend/reliableKernel/rootAuthority.js'));
const { RuntimeDatabase, initializeEmptyRuntimeRoot } = require(path.join(extensionRoot, 'backend/reliableKernel/runtimeDatabase.js'));

(async () => {
  const authority = new RootAuthority(() => runtimeRoot);
  const expected = authority.expectedPaths();
  await assert.rejects(() => authority.current(), (error) =>
    error instanceof RootAuthorityError && error.code === 'root-binding-missing');

  const binding = await initializeEmptyRuntimeRoot(authority);
  const current = await authority.current();
  assert.equal(sameBindingIdentity(binding, current), true);
  assert.equal(binding.runtimeKernelEpoch, RUNTIME_KERNEL_EPOCH);
  assert.equal(await exists(expected.rootPendingPath), false);
  assert.equal(await exists(expected.rootPointerPath), true);
  assert.equal(await exists(expected.runtimeEpochPath), true);
  assert.equal(await exists(expected.databasePath), true);
  assert.equal(await exists(expected.casRootPath), true);

  const epoch = JSON.parse(await fs.readFile(expected.runtimeEpochPath, 'utf8'));
  assert.equal(epoch.kind, 'limcode-runtime-kernel-epoch');
  assert.equal(epoch.runtimeKernelEpoch, RUNTIME_KERNEL_EPOCH);
  assert.equal(epoch.dataSetId, binding.dataSetId);
  assert.equal(epoch.rootInstanceId, binding.rootInstanceId);
  assert.equal(epoch.rootGeneration, binding.rootGeneration);

  const heldEpochPath = expected.runtimeEpochPath + '.held';
  await fs.rename(expected.runtimeEpochPath, heldEpochPath);
  await assert.rejects(() => authority.current(), (error) =>
    error instanceof RootAuthorityError && error.code === 'runtime-epoch-missing-or-invalid');
  await fs.rename(heldEpochPath, expected.runtimeEpochPath);

  let database = await RuntimeDatabase.open(authority, { hostBootId: 'package-empty-root-oracle' });
  const inspection = await database.inspect();
  assert.equal(inspection.writerConnectionCount, 1);
  assert.equal(inspection.readerConnectionCount, 1);
  assert.equal(inspection.currentCommitSeq, '0');
  await database.close();

  await fs.copyFile(expected.rootPointerPath, expected.rootPendingPath);
  await assert.rejects(() => RuntimeDatabase.open(authority), (error) =>
    error instanceof RootAuthorityError && error.code === 'root-binding-pending');
  await fs.rm(expected.rootPendingPath, { force: true });

  database = await RuntimeDatabase.open(authority, { hostBootId: 'package-empty-root-reopen' });
  assert.equal((await database.inspect()).currentCommitSeq, '0');
  await database.close();
  console.log('PASS: packaged empty root creates SQLite/CAS, persists current epoch, fails closed on missing epoch/pending, and reopens the same fenced binding.');
})().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
`;

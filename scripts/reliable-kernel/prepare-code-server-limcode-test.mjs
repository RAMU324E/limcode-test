import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const distRoot = path.join(root, 'dist', 'extension');
const physicalPath = path.join(distRoot, 'backend/reliableKernel/physicalCutover.js');
const injectionPath = path.join(distRoot, 'backend/reliableKernel/configurationInjection.js');
if (!fs.existsSync(physicalPath) || !fs.existsSync(injectionPath)) {
  throw new Error('缺少已编译的cutover/configuration injection模块；请先运行npm run compile。');
}
const {
  CUTOVER_CONTROL_DIRECTORY,
  persistPhysicalCutoverRequest,
  treeDigest,
  verifyPhysicalConfigurationRoot
} = await import(pathToFileUrl(physicalPath));
const {
  injectPhysicalConfiguration,
  inspectConfigurationReadiness,
  recoverInterruptedConfigurationInjection
} = await import(pathToFileUrl(injectionPath));

const globalStorageParent = path.join(os.homedir(), '.local/share/code-server/User/globalStorage');
const sourceRoot = normalizedAbsolutePath(option('source') ?? path.join(globalStorageParent, 'your-publisher.limcode'), 'source root');
const targetRoot = normalizedAbsolutePath(option('target') ?? path.join(globalStorageParent, 'your-publisher.limcode-test'), 'target root');
const apply = process.argv.includes('--apply');
const expectedConfirmation = 'your-publisher.limcode-test';

if (sourceRoot === targetRoot) throw new Error('source与target不能相同。');
if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) throw new Error('LimCode源配置目录不存在。');
if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) throw new Error('limcode-test目标目录不存在。');
await recoverInterruptedConfigurationInjection(targetRoot);
await verifyPhysicalConfigurationRoot(sourceRoot);
const sourceReadiness = await inspectConfigurationReadiness(sourceRoot);
const targetReadiness = await inspectConfigurationReadiness(targetRoot);
const drain = await inspectLegacyDrain(targetRoot);
const targetStats = await treeStats(targetRoot);

if (!apply) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    source: safeReadiness(sourceReadiness),
    targetBefore: safeReadiness(targetReadiness),
    targetData: targetStats,
    drain,
    applyCommandRequires: `--apply --confirm=${expectedConfirmation}`
  }, null, 2));
  process.exit(0);
}
if (option('confirm') !== expectedConfirmation) throw new Error(`真实注入需要--confirm=${expectedConfirmation}。`);
if (!Object.values(drain).every((value) => value === true)) throw new Error('limcode-test仍有活动运行事实或锁；拒绝写入cutover request。');

const backupParent = path.join(globalStorageParent, '.limcode-install-backups', expectedConfirmation);
const backupDirectoryName = `${timestampSlug()}-${process.pid}`;
const backupRoot = path.join(backupParent, backupDirectoryName);
await fsp.mkdir(backupRoot, { recursive: true, mode: 0o700 });
await fsp.chmod(backupRoot, 0o700);
const targetDigestBefore = await treeDigest(targetRoot);
await fsp.cp(targetRoot, path.join(backupRoot, 'data-root'), {
  recursive: true,
  force: false,
  errorOnExist: true,
  preserveTimestamps: true,
  verbatimSymlinks: true
});
const backupDigest = await treeDigest(path.join(backupRoot, 'data-root'));
const targetDigestAfterCopy = await treeDigest(targetRoot);
if (backupDigest !== targetDigestBefore || targetDigestAfterCopy !== targetDigestBefore) {
  await fsp.rm(backupRoot, { recursive: true, force: true });
  throw new Error('备份期间limcode-test数据发生变化；已删除不一致备份并停止。');
}

try {
  const injection = await injectPhysicalConfiguration(sourceRoot, targetRoot);
  const request = await persistPhysicalCutoverRequest(targetRoot, {
    noActiveTurn: true,
    noBackgroundProcess: true,
    noPendingProviderStream: true,
    noPersistInflight: true
  });
  const targetAfter = await inspectConfigurationReadiness(targetRoot);
  const receipt = {
    kind: 'limcode-test-code-server-preparation',
    preparedAt: new Date().toISOString(),
    backupDirectoryName,
    backupTreeDigest: backupDigest,
    targetTreeBeforeDigest: targetDigestBefore,
    configurationSourceTreeDigest: injection.sourceTreeDigest,
    configurationInstalledTreeDigest: injection.installedTreeDigest,
    installedEntryCount: injection.installedEntryCount,
    cutoverRequestId: request.requestId,
    source: safeReadiness(sourceReadiness),
    targetAfter: safeReadiness(targetAfter),
    drain
  };
  await writeSecretFreeReceipt(path.join(backupRoot, 'preparation-receipt.json'), receipt);
  console.log(JSON.stringify({
    mode: 'applied',
    backupDirectoryName,
    backupTreeDigest: backupDigest,
    installedEntryCount: injection.installedEntryCount,
    cutoverRequestId: request.requestId,
    targetAfter: safeReadiness(targetAfter),
    drain
  }, null, 2));
} catch (error) {
  await fsp.rm(targetRoot, { recursive: true, force: true });
  await fsp.cp(path.join(backupRoot, 'data-root'), targetRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  if (await treeDigest(targetRoot) !== backupDigest) throw new Error('准备失败且完整目标备份恢复摘要不一致；停止后续安装。', { cause: error });
  throw error;
}

async function inspectLegacyDrain(dataRoot) {
  const locks = [];
  await walk(dataRoot, 0, async (absolute, entry) => {
    if (!entry.isFile()) return;
    if (entry.name.endsWith('.lock') || entry.name.includes('pending')) locks.push(path.relative(dataRoot, absolute));
  });
  const background = await readLegacyRecords(path.join(dataRoot, 'background-processes'));
  const terminalBackground = new Set(['exited', 'killed', 'failed', 'completed', 'cancelled', 'terminated']);
  const noBackgroundProcess = background.every((record) => {
    const status = typeof record.status === 'string' ? record.status : '';
    const pid = Number.isSafeInteger(record.pid) ? record.pid : undefined;
    return terminalBackground.has(status) && !isPidAlive(pid);
  });
  const turns = await readLegacyRecords(path.join(dataRoot, 'turns'));
  const terminalTurns = new Set(['completed', 'failed', 'cancelled', 'terminated', 'interrupted']);
  const noActiveTurn = turns.every((record) => {
    const status = [record.status, record.lifecycle, record.state].find((value) => typeof value === 'string');
    return typeof status === 'string' && terminalTurns.has(status);
  });
  const leases = await readLegacyRecords(path.join(dataRoot, 'execution-leases'));
  const noLease = leases.every((record) => ['released', 'expired', 'completed'].includes(String(record.status ?? record.state ?? '')));
  const providerRecords = [
    ...await readLegacyRecords(path.join(dataRoot, 'llm-invocations')),
    ...await readLegacyRecords(path.join(dataRoot, 'model-requests')),
    ...await readLegacyRecords(path.join(dataRoot, 'operations'))
  ];
  const providerTerminal = new Set(['completed', 'failed', 'cancelled', 'terminated', 'superseded']);
  const noPendingProviderStream = providerRecords.every((record) => providerTerminal.has(String(record.status ?? record.state ?? record.lifecycle ?? '')));
  return {
    noActiveTurn: noActiveTurn && noLease,
    noBackgroundProcess,
    noPendingProviderStream,
    noPersistInflight: locks.length === 0
  };
}

async function readLegacyRecords(storeRoot) {
  const indexPath = path.join(storeRoot, 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  const index = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
  if (!Array.isArray(index.records)) throw new Error(`旧运行index无效：${path.basename(storeRoot)}`);
  const records = [];
  for (const indexed of index.records) {
    if (typeof indexed.file !== 'string') throw new Error(`旧运行index file无效：${path.basename(storeRoot)}`);
    const candidates = [path.join(storeRoot, indexed.file), path.join(storeRoot, 'records', indexed.file)];
    const recordPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!recordPath) throw new Error(`旧运行index指向缺失文件：${path.basename(storeRoot)}`);
    const file = JSON.parse(await fsp.readFile(recordPath, 'utf8'));
    const nested = Object.values(file).find((value) => value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string');
    records.push(nested ?? file);
  }
  return records;
}

async function walk(directory, depth, visit) {
  if (depth > 8) throw new Error('数据目录嵌套超过安全扫描上限。');
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    if (depth === 0 && entry.name === CUTOVER_CONTROL_DIRECTORY) continue;
    const absolute = path.join(directory, entry.name);
    await visit(absolute, entry);
    if (entry.isDirectory()) await walk(absolute, depth + 1, visit);
  }
}

async function treeStats(rootPath) {
  let fileCount = 0;
  let bytes = 0;
  await walk(rootPath, 0, async (absolute, entry) => {
    if (!entry.isFile()) return;
    const stat = await fsp.stat(absolute);
    fileCount += 1;
    bytes += stat.size;
  });
  return { fileCount, bytes };
}

function safeReadiness(readiness) {
  return {
    providerConfigCount: readiness.providerConfigCount,
    hasActiveProvider: !!readiness.activeProviderConfigId,
    activeProviderHasModel: readiness.activeProviderHasModel,
    activeProviderHasCredential: readiness.activeProviderHasCredential,
    mcpServerCount: readiness.mcpServerCount,
    enabledMcpServerCount: readiness.enabledMcpServerCount
  };
}

function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function writeSecretFreeReceipt(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (/apiKey|authorization|password|secret|token|headers|\benv\b/i.test(text)) throw new Error('部署回执意外包含秘密字段名。');
  const handle = await fsp.open(file, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizedAbsolutePath(value, label) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new Error(`${label}必须是规范绝对路径。`);
  return value;
}

function timestampSlug() {
  const date = new Date();
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${pad(date.getUTCMilliseconds(), 3)}`;
}

function pathToFileUrl(file) {
  return new URL(`file://${file}`).href;
}

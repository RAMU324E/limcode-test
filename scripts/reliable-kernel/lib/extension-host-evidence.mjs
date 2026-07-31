import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SQLITE_EXTENSION_HOST_EVIDENCE = 'tests/reliable-kernel/evidence/sqlite-extension-host.json';

export function validateSqliteExtensionHostEvidence({ root, expectedCommit }) {
  const evidencePath = path.join(root, SQLITE_EXTENSION_HOST_EVIDENCE);
  const problems = [];
  let evidence;
  try {
    evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return { evidencePath, evidence: null, problems: [`无法读取真实Extension Host证据：${error.message}`] };
  }
  const commit = expectedCommit || currentCommit(root);
  if (evidence?.kind !== 'limcode-phase-b-sqlite-extension-host') problems.push('证据kind错误');
  if (evidence?.passed !== true) problems.push(`宿主smoke未通过：${evidence?.error?.message ?? 'unknown'}`);
  if (evidence?.commitSha !== commit) problems.push(`证据commit ${evidence?.commitSha ?? '<missing>'} != ${commit}`);
  if (evidence?.platform !== 'linux' || evidence?.arch !== 'x64') problems.push('证据不是Linux x64');
  if (evidence?.vscode?.applicationName !== 'code-server') problems.push('证据不是当前code-server宿主');
  if (typeof evidence?.vscode?.version !== 'string' || !evidence.vscode.version) problems.push('缺少VS Code版本');
  const remoteName = evidence?.vscode?.remoteName;
  if (remoteName !== null && !isLoopbackCodeServer(remoteName)) {
    problems.push(`目标必须在当前Linux主机执行；不接受外部remoteName=${remoteName}`);
  }
  if (!String(evidence?.host?.entrypoint ?? '').includes('extensionHostProcess')) problems.push('证据未在Extension Host入口内生成');
  if (typeof evidence?.host?.pid !== 'number' || evidence.host.pid <= 0) problems.push('缺少真实Extension Host PID');
  if (typeof evidence?.host?.node !== 'string' || !evidence.host.node) problems.push('缺少宿主Node版本');
  if (!/^\d+$/.test(String(evidence?.host?.modules ?? ''))) problems.push('缺少宿主NODE_MODULE_VERSION');
  if (evidence?.driver?.name !== 'better-sqlite3') problems.push('加载的SQLite driver不是better-sqlite3');
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.driver?.nativeSha256 ?? ''))) problems.push('缺少native addon摘要');
  if (!/^[a-f0-9]{64}$/.test(String(evidence?.driver?.packageSha256 ?? ''))) problems.push('缺少driver package摘要');
  validateCurrentDriver(root, evidence, problems);
  for (const assertion of ['loaded', 'create', 'commit', 'rollback', 'reopen']) {
    if (evidence?.assertions?.[assertion] !== true) problems.push(`宿主断言未通过：${assertion}`);
  }
  if (typeof evidence?.sqliteVersion !== 'string' || !evidence.sqliteVersion) problems.push('缺少SQLite版本');
  if (!Number.isFinite(Date.parse(evidence?.measuredAt ?? ''))) problems.push('measuredAt无效');
  return { evidencePath, evidence, problems };
}

function validateCurrentDriver(root, evidence, problems) {
  const packagePath = path.join(root, 'node_modules/better-sqlite3/package.json');
  const nativePath = path.join(root, 'node_modules/better-sqlite3/prebuilds/linux-x64.node');
  try {
    const driverPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    if (evidence?.driver?.version !== driverPackage.version) {
      problems.push(`driver版本${evidence?.driver?.version ?? '<missing>'} != ${driverPackage.version}`);
    }
    const packageSha256 = sha256File(packagePath);
    if (evidence?.driver?.packageSha256 !== packageSha256) problems.push('driver package摘要与当前依赖不一致');
    const nativeSha256 = sha256File(nativePath);
    if (evidence?.driver?.nativeSha256 !== nativeSha256) problems.push('native addon摘要与当前Linux x64依赖不一致');
  } catch (error) {
    problems.push(`无法核对当前better-sqlite3依赖：${error.message}`);
  }
  if (String(evidence?.host?.modules ?? '') !== String(process.versions.modules)) {
    problems.push(`宿主NODE_MODULE_VERSION ${evidence?.host?.modules ?? '<missing>'} != 当前目标ABI ${process.versions.modules}`);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function isLoopbackCodeServer(remoteName) {
  return typeof remoteName === 'string'
    && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(remoteName);
}

function currentCommit(root) {
  return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

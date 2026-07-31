import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// package 出口校验器：stable check.id -> handler。
// 只登记已有真实实现；其余 installed/migration/smoke checks 保持 PENDING。
const GROUP_ID = 'package';
const root = process.cwd();

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const commit = option('commit');
const artifact = option('artifact');
const registry = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/reliable-kernel/contracts/gate-registry.json'), 'utf8')
);
const group = (registry.validatorGroups ?? []).find((entry) => entry.id === GROUP_ID);
if (!group) {
  console.error(`gate-registry.json缺少校验器组：${GROUP_ID}`);
  process.exit(2);
}
const gate = (registry.gates ?? []).find((entry) => entry.id === group.introducedAt);
const stageLabel = (gate?.stages ?? []).join('-') || '未知';

function requireArtifact() {
  if (!artifact) throw new Error('缺少--artifact本机VSIX路径');
  const absolute = path.resolve(root, artifact);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`安装包不存在或不是普通文件：${artifact}`);
  return absolute;
}

function unzipEntry(absolute, entry, options = {}) {
  const result = childProcess.spawnSync('unzip', ['-p', absolute, entry], {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024
  });
  const empty = options.encoding ? !result.stdout?.trim() : !result.stdout || result.stdout.length === 0;
  if (result.error || result.status !== 0 || empty) {
    throw new Error(`无法从VSIX读取${entry}：${result.error?.message ?? String(result.stderr ?? '').trim() ?? `退出码${result.status}`}`);
  }
  return result.stdout;
}

function readVsixManifest(absolute) {
  const text = unzipEntry(absolute, 'extension/package.json', { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error('VSIX内package.json不是有效JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('VSIX内package.json必须是JSON对象');
  return manifest;
}

function readVsixMainEntry(absolute) {
  const manifest = readVsixManifest(absolute);
  const main = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
  if (!main || path.posix.isAbsolute(main) || main.includes('\\') || main.split('/').includes('..')) {
    throw new Error('VSIX package.json.main缺失或不是安全的包内相对路径');
  }
  return main;
}

function listVsixFiles(absolute) {
  const result = childProcess.spawnSync('unzip', ['-Z1', absolute], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`无法读取VSIX文件清单：${result.error?.message ?? result.stderr?.trim() ?? `退出码${result.status}`}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((file) => file.replace(/^extension\//, ''))
    .filter(Boolean)
    .sort();
}

const forbidden = [
  {
    id: '测试',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)(?:test|tests|spec|specs|__tests__)\//i.test(file)
        || /^(?:test|spec)-/i.test(base)
        || /^(?:tests?|specs?)\.(?:[cm]?js|tsx?|jsx?)$/i.test(base)
        || /\.(?:test|spec)\.[^/]+$/i.test(base);
    }
  },
  { id: '夹具', match: (file) => /(^|\/)fixtures?\//i.test(file) },
  {
    id: '基准',
    match: (file) => {
      const base = path.posix.basename(file);
      return /(^|\/)benchmarks?\//i.test(file)
        || /^benchmark-/i.test(base)
        || /\.benchmark\.[^/]+$/i.test(base);
    }
  },
  { id: '正式或基准脚本', match: (file) => /^scripts\//.test(file) },
  { id: '内部架构文档', match: (file) => /(^|\/)docs\/architecture\//.test(file) },
  { id: '内部工具报告', match: (file) => /(^|\/)\.ide-tool-test\//.test(file) },
  { id: 'TypeScript或Vue源码', match: (file) => /^(backend|shared|vscode|webview)\/.*\.(?:ts|tsx|vue)$/.test(file) },
  { id: '嵌套VSIX', match: (file) => file.endsWith('.vsix') },
  { id: '运行数据库', match: (file) => /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/.test(file) || /-(?:wal|shm)$/.test(file) },
  { id: '原始日志或环境文件', match: (file) => /(^|\/)(?:\.env(?:\..*)?|.*\.(?:log|trace))$/.test(file) }
];

function checkVsixFileListing() {
  const absolute = requireArtifact();
  const files = listVsixFiles(absolute);
  const problems = [];
  for (const rule of forbidden) {
    const matches = files.filter(rule.match);
    if (matches.length) problems.push(`${rule.id}: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ` (+${matches.length - 8})` : ''}`);
  }
  const required = ['package.json', 'README.md', 'LICENSE', readVsixMainEntry(absolute)];
  for (const file of required) if (!files.includes(file)) problems.push(`缺少必需文件：${file}`);
  if (!files.includes('dist/build-provenance.json')) problems.push('缺少构建来源文件：dist/build-provenance.json');
  if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.html'))) problems.push('缺少编译后的网页视图HTML');
  if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.css'))) problems.push('缺少编译后的网页视图CSS');
  return problems.length ? `${files.length}个文件中发现问题：${problems.join('；')}` : null;
}

function readBuildProvenance(absolute) {
  const text = unzipEntry(absolute, 'extension/dist/build-provenance.json', { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  let provenance;
  try {
    provenance = JSON.parse(text);
  } catch {
    throw new Error('dist/build-provenance.json不是有效JSON');
  }
  if (typeof provenance.commitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(provenance.commitSha)) throw new Error('build provenance.commitSha不是40位Git SHA');
  if (typeof provenance.mainEntrySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(provenance.mainEntrySha256)) throw new Error('build provenance.mainEntrySha256不是64位SHA-256');
  if (typeof provenance.worktreeClean !== 'boolean') throw new Error('build provenance.worktreeClean不是boolean');
  return provenance;
}

function checkBuildProvenanceCommit() {
  const provenance = readBuildProvenance(requireArtifact());
  const problems = [];
  if (provenance.worktreeClean !== true) problems.push('安装包构建时工作区不是干净状态');
  if (!commit) problems.push('缺少--commit，无法核对当前干净提交');
  else if (provenance.commitSha !== commit) problems.push(`安装包来自提交${provenance.commitSha}，与当前提交${commit}不一致`);
  return problems.length ? problems.join('；') : null;
}

function checkVsixMainEntryDigest() {
  const absolute = requireArtifact();
  const provenance = readBuildProvenance(absolute);
  let main;
  try {
    main = readVsixMainEntry(absolute);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  let bytes;
  try {
    bytes = unzipEntry(absolute, `extension/${main}`, { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  return actual === provenance.mainEntrySha256
    ? null
    : `VSIX真实入口${main}摘要${actual}与provenance.mainEntrySha256 ${provenance.mainEntrySha256}不一致`;
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['package.surface-forbidden-files', checkVsixFileListing],
  ['package.provenance-clean-commit', checkBuildProvenanceCommit],
  ['package.provenance-vsix-main-entry-digest', checkVsixMainEntryDigest]
]);

const failures = [];
const pending = [];
for (const check of group.checks ?? []) {
  const handler = implemented.get(check.id);
  if (!handler) {
    pending.push(check);
    continue;
  }
  try {
    const problem = handler();
    if (problem) failures.push(`${check.id}（${check.description}）：${problem}`);
  } catch (error) {
    failures.push(`${check.id}（${check.description}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const check of pending) console.error(`PENDING: ${check.id} — ${check.description}（归属阶段 ${check.ownerStage ?? stageLabel}）`);
for (const failure of failures) console.error(`失败：${failure}`);
if (pending.length || failures.length) {
  console.error(`${GROUP_ID}出口校验未通过：${pending.length}项待实现，${failures.length}项失败。`);
  process.exit(1);
}
console.log(`${GROUP_ID}出口校验通过：${(group.checks ?? []).length}项稳定ID检查全部实现并通过。`);

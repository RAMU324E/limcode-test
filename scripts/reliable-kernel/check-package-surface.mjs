import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const result = childProcess.spawnSync('npx', ['--no-install', 'vsce', 'ls'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
});
if (result.error || result.status !== 0) {
  console.error('VSIX内容检查失败：无法通过vsce ls取得候选文件清单。');
  if (result.error) console.error(result.error.message);
  if (result.stderr) console.error(result.stderr.trim());
  process.exit(1);
}

const files = result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort();
const failures = [];
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
  {
    id: '未批准的根级Markdown',
    match: (file) => !file.includes('/') && file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'readme.md'
  },
  { id: '内部架构文档', match: (file) => /(^|\/)docs\/architecture\//.test(file) },
  { id: '内部工具报告', match: (file) => /(^|\/)\.ide-tool-test\//.test(file) },
  { id: 'TypeScript或Vue源码', match: (file) => /^(backend|shared|vscode|webview)\/.*\.(?:ts|tsx|vue)$/.test(file) },
  { id: '嵌套VSIX', match: (file) => file.endsWith('.vsix') },
  { id: '运行数据库', match: (file) => /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/.test(file) || /-(?:wal|shm)$/.test(file) },
  { id: '原始日志或环境文件', match: (file) => /(^|\/)(?:\.env(?:\..*)?|.*\.(?:log|trace))$/.test(file) }
];
for (const rule of forbidden) {
  const matches = files.filter(rule.match);
  if (matches.length) failures.push(`${rule.id}: ${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ` (+${matches.length - 8})` : ''}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const required = ['package.json', String(manifest.main ?? '').replace(/^\.\//, '')];
for (const file of required) if (!files.includes(file)) failures.push(`安装包缺少必需文件：${file}`);
if (!files.some((file) => file.toLowerCase() === 'readme.md')) failures.push('安装包缺少README');
if (!files.some((file) => /^license(?:\.[^/]+)?$/i.test(file))) failures.push('安装包缺少LICENSE');
if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.html'))) failures.push('安装包缺少编译后的网页视图HTML');
if (!files.some((file) => file.startsWith('dist/webview/') && file.endsWith('.css'))) failures.push('安装包缺少编译后的网页视图CSS');

if (failures.length) {
  console.error(`VSIX内容检查失败：${files.length}个文件中发现${failures.length}项阻塞问题。`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const sourceMapCount = files.filter((file) => file.endsWith('.map')).length;
  console.log(`VSIX内容检查通过：共${files.length}个文件；测试、内部报告和源码数据库产物为0；源码映射文件${sourceMapCount}个，允许用于本机调试。`);
}

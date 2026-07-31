import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 构建后读取 package.json 的真实 main entry，写入供 installed gate 重算的 provenance。
const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainEntryRelative = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
if (!mainEntryRelative || path.isAbsolute(mainEntryRelative) || mainEntryRelative.split(/[\\/]/).includes('..')) {
  console.error('构建来源写入失败：package.json.main缺失或不是安全的项目内相对路径。');
  process.exit(1);
}
const mainEntry = path.join(root, mainEntryRelative);
if (!fs.existsSync(mainEntry) || !fs.statSync(mainEntry).isFile()) {
  console.error(`构建来源写入失败：缺少package.json.main指向的构建产物${mainEntryRelative}，请先运行npm run compile。`);
  process.exit(1);
}

let commitSha;
try {
  commitSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
} catch (error) {
  console.error(`构建来源写入失败：无法通过git rev-parse HEAD取得提交哈希：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
  console.error(`构建来源写入失败：Git提交哈希格式无效：${commitSha}`);
  process.exit(1);
}

let worktreeStatus;
try {
  worktreeStatus = childProcess.execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8' }
  );
} catch (error) {
  console.error(`构建来源写入失败：无法读取Git工作区状态：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const worktreeClean = worktreeStatus.trim() === '';
const mainEntrySha256 = crypto.createHash('sha256').update(fs.readFileSync(mainEntry)).digest('hex');
const outputRelative = 'dist/build-provenance.json';
fs.mkdirSync(path.dirname(path.join(root, outputRelative)), { recursive: true });
fs.writeFileSync(
  path.join(root, outputRelative),
  `${JSON.stringify({ commitSha, mainEntrySha256, worktreeClean }, null, 2)}\n`
);
console.log(`已写入构建来源：${outputRelative}（main=${mainEntryRelative}，commit=${commitSha}，worktreeClean=${worktreeClean}，mainEntrySha256=${mainEntrySha256}）。`);

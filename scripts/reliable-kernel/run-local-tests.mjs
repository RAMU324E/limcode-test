import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';

const root = process.cwd();
const testsRoot = path.join(root, 'tests');
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.test\.(?:cjs|mjs|js)$/.test(entry.name)) files.push(path.relative(root, absolute));
  }
}
walk(testsRoot);
files.sort();
if (files.length === 0) {
  console.error('在tests/**/*.test.{cjs,mjs,js}下没有找到本机测试。');
  process.exit(1);
}
console.log(`按稳定顺序运行${files.length}个被Git忽略的本机测试文件。`);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
const result = childProcess.spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', timeout: TEST_TIMEOUT_MS });
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`本机测试超过${Math.round(TEST_TIMEOUT_MS / 60000)}分钟上限，已强制终止。`);
    process.exit(1);
  }
  throw result.error;
}
process.exit(result.status ?? 1);

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';

const root = process.cwd();
// Physical cutover made tests/reliable-kernel the only executable local Runtime
// test surface. Tests outside this directory exercise the retired world/file
// Runtime and must not pull deleted modules back into the compiled closure.
const testsRoot = path.join(root, 'tests', 'reliable-kernel');
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
  console.error('在tests/reliable-kernel/**/*.test.{cjs,mjs,js}下没有找到当前可靠内核本机测试。');
  process.exit(1);
}
if (process.argv.includes('--list')) {
  for (const file of files) console.log(file);
  process.exit(0);
}
console.log(`按稳定顺序运行${files.length}个当前可靠内核本机测试文件。`);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
// Several gate tests intentionally read/write shared evidence files. Node's default per-file
// parallelism makes those durable fixtures race each other, so the advertised stable order must be
// real rather than merely sorting the argv list.
const result = childProcess.spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { cwd: root, stdio: 'inherit', timeout: TEST_TIMEOUT_MS }
);
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`本机测试超过${Math.round(TEST_TIMEOUT_MS / 60000)}分钟上限，已强制终止。`);
    process.exit(1);
  }
  throw result.error;
}
process.exit(result.status ?? 1);

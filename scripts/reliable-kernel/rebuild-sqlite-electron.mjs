import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const version = option('electron-version');
if (!version || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
  console.error('用法：node scripts/reliable-kernel/rebuild-sqlite-electron.mjs --electron-version=<VS Code Electron版本>');
  process.exit(2);
}
const supportedTargets = new Set(['linux/x64', 'win32/x64', 'darwin/x64', 'darwin/arm64']);
const currentTarget = `${process.platform}/${process.arch}`;
if (!supportedTargets.has(currentTarget)) {
  console.error(`当前目标只支持linux/x64、win32/x64、darwin/x64或darwin/arm64，实际为${currentTarget}`);
  process.exit(1);
}
const executable = path.join(
  root,
  `node_modules/.bin/electron-rebuild${process.platform === 'win32' ? '.cmd' : ''}`
);
const result = childProcess.spawnSync(
  executable,
  ['--version', version, '--arch', process.arch, '--which-module', 'better-sqlite3', '--force'],
  {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // better-sqlite3 13 ships host prebuilds and its binding.gyp otherwise emits a no-op target.
    // Force the real addon target so a successful electron-rebuild cannot silently leave no output.
    env: { ...process.env, npm_config_force_build: '1' }
  }
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const rebuilt = path.join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const packaged = path.join(
  root,
  `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`
);
if (!fs.existsSync(rebuilt)) {
  console.error(`Electron rebuild未生成预期native addon：${rebuilt}`);
  process.exit(1);
}
fs.copyFileSync(rebuilt, packaged);
console.log(`已将Electron ${version} ABI的better-sqlite3写入${currentTarget}打包入口：${packaged}`);

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

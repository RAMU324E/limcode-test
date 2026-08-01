import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  RELIABLE_KERNEL_COMPILE_PROVENANCE,
  manifestFilesAreTracked,
  reliableKernelCompiledManifest,
  reliableKernelSourceManifest
} from './lib/compile-provenance.mjs';

const root = process.cwd();
const commitSha = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8'
}).trim();
if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error(`Invalid Git commit: ${commitSha}`);
const worktreeClean = childProcess.execFileSync(
  'git',
  ['status', '--porcelain', '--untracked-files=all'],
  { cwd: root, encoding: 'utf8' }
).trim() === '';
const source = reliableKernelSourceManifest(root);
const compiled = reliableKernelCompiledManifest(root);
const sourceFilesTracked = manifestFilesAreTracked(root, source);
const outputPath = path.join(root, RELIABLE_KERNEL_COMPILE_PROVENANCE);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({
  kind: 'limcode-reliable-kernel-compile-provenance',
  commitSha,
  worktreeClean,
  sourceFilesTracked,
  sourceTreeSha256: source.sha256,
  compiledClosureSha256: compiled.sha256,
  sourceFiles: source.files,
  compiledFiles: compiled.files
}, null, 2)}\n`);
console.log(
  `已写入可靠内核编译来源：${RELIABLE_KERNEL_COMPILE_PROVENANCE}`
    + `（commit=${commitSha}，worktreeClean=${worktreeClean}，sourceFilesTracked=${sourceFilesTracked}`
    + `，source=${source.sha256}，compiled=${compiled.sha256}）。`
);

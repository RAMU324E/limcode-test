import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RELIABLE_KERNEL_COMPILE_PROVENANCE = 'dist/extension/reliable-kernel-compile-provenance.json';

export function reliableKernelSourceManifest(root) {
  const files = [
    ...['backend', 'shared', 'vscode'].flatMap((directory) => walkFiles(path.join(root, directory))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => relativePath(root, file))),
    'package.json',
    'package-lock.json',
    'tsconfig.json'
  ].sort();
  return digestFiles(root, files);
}

export function reliableKernelCompiledManifest(root) {
  const outputRoot = path.join(root, 'dist/extension');
  if (!fs.existsSync(outputRoot)) throw new Error(`Missing compiled extension directory: ${outputRoot}`);
  const files = walkFiles(outputRoot)
    .filter((file) => file.endsWith('.js'))
    .map((file) => relativePath(root, file))
    .sort();
  if (files.length === 0) throw new Error('Compiled extension closure is empty.');
  return digestFiles(root, files);
}

export function manifestFilesAreTracked(root, manifest) {
  const tracked = new Set(childProcess.execFileSync(
    'git',
    ['ls-files', '-z'],
    { cwd: root, encoding: 'utf8' }
  ).split('\0').filter(Boolean));
  return manifest.files.every((entry) => tracked.has(entry.path));
}

export function digestFiles(root, files) {
  const entries = files.map((file) => ({
    path: file,
    sha256: sha256(fs.readFileSync(path.join(root, file)))
  }));
  const aggregate = crypto.createHash('sha256');
  for (const entry of entries) {
    aggregate.update(entry.path);
    aggregate.update('\0');
    aggregate.update(entry.sha256);
    aggregate.update('\0');
  }
  return { sha256: aggregate.digest('hex'), files: entries };
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(absolute) : entry.isFile() ? [absolute] : [];
  });
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

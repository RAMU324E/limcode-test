import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const platforms = ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'];

export function sharpRuntimePackages(sharp) {
  const vips = sharp.config.libvips.match(/\d+\.\d+\.\d+/)[0];
  return platforms.flatMap((platform) => {
    const native = {
      platform, name: `@img/sharp-${platform}`,
      files: ['package.json', 'index.cjs', `lib/sharp-${platform}-${sharp.version}.node`]
    };
    if (platform === 'win32-x64') {
      native.files.push('versions.json', 'lib/libvips-42.dll', `lib/libvips-cpp-${vips}.dll`);
      return [native];
    }
    const library = {
      platform, name: `@img/sharp-libvips-${platform}`,
      files: ['package.json', 'versions.json', 'lib/index.js', platform.startsWith('darwin')
        ? `lib/libvips-cpp.${vips}.dylib` : `lib/libvips-cpp.so.${vips}`]
    };
    return [native, library];
  }).map((entry) => ({ ...entry, version: sharp.optionalDependencies[entry.name] }));
}

export function sharpRuntimeRequiredFiles(sharp) {
  return [
    'node_modules/sharp/package.json',
    `node_modules/sharp/${sharp.main.replace(/^\.\//, '')}`,
    'node_modules/@img/colour/package.json',
    'node_modules/@img/colour/index.cjs',
    ...sharpRuntimePackages(sharp).flatMap((entry) => entry.files.map((file) => `node_modules/${entry.name}/${file}`))
  ];
}

export function prepareSharpRuntime(root) {
  const sharp = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/sharp/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  if (sharp.version !== lock.packages['node_modules/sharp'].version) throw new Error('Installed sharp does not match package-lock.json.');
  const packages = sharpRuntimePackages(sharp);
  for (const entry of packages) {
    if (entry.version !== lock.packages[`node_modules/${entry.name}`]?.version) {
      throw new Error(`${entry.name} does not match package-lock.json.`);
    }
  }
  for (const platform of platforms) {
    const missing = packages.filter((entry) => entry.platform === platform && !packageReady(root, entry));
    if (!missing.length) continue;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-sharp-'));
    try {
      const [targetOs, cpu] = platform.split('-');
      const npmCli = process.env.npm_execpath;
      const args = ['install', '--prefix', temporary, '--no-save', '--package-lock=false', '--ignore-scripts',
        '--no-audit', '--no-fund', '--include=optional', `--os=${targetOs}`, `--cpu=${cpu}`];
      if (targetOs === 'linux') args.push('--libc=glibc');
      args.push(`sharp@${sharp.version}`);
      const result = childProcess.spawnSync(
        npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm',
        npmCli ? [npmCli, ...args] : args,
        { cwd: temporary, stdio: 'inherit', shell: !npmCli && process.platform === 'win32' }
      );
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Unable to prepare sharp for ${platform}.`);
      for (const entry of missing) {
        if (!packageReady(temporary, entry)) throw new Error(`Incomplete sharp runtime package: ${entry.name}`);
        const destination = path.join(root, 'node_modules', entry.name);
        fs.rmSync(destination, { recursive: true, force: true });
        fs.cpSync(path.join(temporary, 'node_modules', entry.name), destination, { recursive: true });
      }
      console.log(`Prepared sharp runtime for ${platform}.`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function packageReady(root, entry) {
  const directory = path.join(root, 'node_modules', entry.name);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return manifest.name === entry.name && manifest.version === entry.version
      && entry.files.every((file) => fs.statSync(path.join(directory, file)).isFile());
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

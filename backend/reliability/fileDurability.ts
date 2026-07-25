import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface FileDurabilityCapabilities {
  dataRoot: string;
  fileScheme: true;
  atomicReplace: true;
  fileFsync: true;
  parentDirectoryFsync: true | 'windows_atomic_replace_equivalent';
  stagingAndTargetSameDevice: true;
  verifiedAt: number;
}

export interface DataRootOwner {
  ownerId: string;
  pid: number;
  hostname: string;
  acquiredAt: number;
  fencingGeneration: number;
  fencingToken: string;
}

interface OwnerLockFile extends DataRootOwner {
  schemaVersion: 1;
  dataRoot: string;
}

interface FencingManifest {
  schemaVersion: 1;
  generation: number;
  lastOwnerId: string;
  updatedAt: number;
}

const OWNER_DIR = 'operations/conversation-transitions/owner';
const OWNER_LEASES_DIR = `${OWNER_DIR}/leases`;
const FENCING_FILE = 'fencing.json';

export class DataRootWriterBlockedError extends Error {
  public constructor(public readonly currentOwner: DataRootOwner) {
    super(`Data root already has an active writer (${currentOwner.ownerId}, pid ${currentOwner.pid}).`);
    this.name = 'DataRootWriterBlockedError';
  }
}

/** Durable primitives used by the file transaction backend. */
export class DurableFileSystem {
  public readonly dataRoot: string;

  public constructor(dataRoot: string) {
    this.dataRoot = path.resolve(dataRoot);
    if (!path.isAbsolute(this.dataRoot)) throw new Error('Durable data root must be absolute.');
  }

  public resolve(relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    const target = path.resolve(this.dataRoot, ...normalized.split('/'));
    if (target !== this.dataRoot && !target.startsWith(`${this.dataRoot}${path.sep}`)) {
      throw new Error(`Path escapes durable data root: ${relativePath}`);
    }
    return target;
  }

  public relative(absolutePath: string): string {
    const resolved = path.resolve(absolutePath);
    if (resolved !== this.dataRoot && !resolved.startsWith(`${this.dataRoot}${path.sep}`)) {
      throw new Error(`Path is outside durable data root: ${absolutePath}`);
    }
    return path.relative(this.dataRoot, resolved).split(path.sep).join('/');
  }

  public async probe(): Promise<FileDurabilityCapabilities> {
    const probeDir = this.resolve('operations/conversation-transitions/capability-probe');
    await fs.mkdir(probeDir, { recursive: true });
    const source = path.join(probeDir, `source-${process.pid}-${randomUUID()}.tmp`);
    const target = path.join(probeDir, `target-${process.pid}-${randomUUID()}.tmp`);
    const payload = Buffer.from(`limcode-file-durability:${randomUUID()}`, 'utf8');
    try {
      const handle = await fs.open(source, 'wx', 0o600);
      try {
        await handle.writeFile(payload);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const sourceStat = await fs.stat(source);
      const previousHandle = await fs.open(target, 'wx', 0o600);
      try {
        await previousHandle.writeFile('previous-target');
        await previousHandle.sync();
      } finally {
        await previousHandle.close();
      }
      await atomicReplace(source, target);
      await fsyncDirectory(probeDir);
      const targetStat = await fs.stat(target);
      if (sourceStat.dev !== targetStat.dev) throw new Error('Durable staging and target are not on the same device.');
      const actual = await fs.readFile(target);
      if (!actual.equals(payload)) throw new Error('Durability probe read-back mismatch.');
      return {
        dataRoot: this.dataRoot,
        fileScheme: true,
        atomicReplace: true,
        fileFsync: true,
        parentDirectoryFsync: process.platform === 'win32' ? 'windows_atomic_replace_equivalent' : true,
        stagingAndTargetSameDevice: true,
        verifiedAt: Date.now()
      };
    } finally {
      await Promise.all([fs.rm(source, { force: true }), fs.rm(target, { force: true })]);
      await fsyncDirectory(probeDir);
    }
  }

  public async atomicWrite(relativePath: string, bytes: Uint8Array, options: { createOnly?: boolean } = {}): Promise<void> {
    const target = this.resolve(relativePath);
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    if (options.createOnly) {
      const handle = await fs.open(target, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(parent);
      return;
    }

    const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temp, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await atomicReplace(temp, target);
      await fsyncDirectory(parent);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  public async installImmutable(stagingRelativePath: string, targetRelativePath: string, expectedHash: string): Promise<void> {
    const source = this.resolve(stagingRelativePath);
    const target = this.resolve(targetRelativePath);
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    const temp = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.install`);
    try {
      let hardLinked = false;
      try {
        // Staging postimages are immutable and share the data-root volume with their targets. A hard
        // link therefore publishes the already-fsynced bytes without writing them a second time.
        await fs.link(source, temp);
        hardLinked = true;
      } catch (error) {
        if (!allowsImmutableInstallCopyFallback(error)) throw error;
      }
      if (!hardLinked) {
        // COPYFILE_FICLONE opportunistically uses a same-volume clone and transparently falls back
        // to a normal copy. The normal copy remains the portable correctness fallback.
        await fs.copyFile(source, temp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        const handle = await fs.open(temp, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const hash = await sha256File(temp);
      if (hash !== expectedHash) throw new Error(`Staging install hash mismatch for ${targetRelativePath}.`);
      await atomicReplace(temp, target);
      await fsyncDirectory(parent);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  public async read(relativePath: string): Promise<Uint8Array | undefined> {
    try { return await fs.readFile(this.resolve(relativePath)); }
    catch (error) { if (isNotFound(error)) return undefined; throw error; }
  }

  public async readJson<T>(relativePath: string): Promise<T | undefined> {
    const bytes = await this.read(relativePath);
    if (!bytes) return undefined;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  }

  public async hash(relativePath: string): Promise<string | null> {
    try { return await sha256File(this.resolve(relativePath)); }
    catch (error) { if (isNotFound(error)) return null; throw error; }
  }

  public async list(relativeDirectory: string): Promise<string[]> {
    const directory = this.resolve(relativeDirectory);
    try {
      return (await fs.readdir(directory)).sort();
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  public async listFilesRecursive(relativeDirectory: string): Promise<string[]> {
    const root = this.resolve(relativeDirectory);
    const files: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (isNotFound(error)) return; throw error; }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) files.push(this.relative(absolute));
      }
    };
    await visit(root);
    return files.sort();
  }

  public async remove(relativePath: string, options: { recursive?: boolean } = {}): Promise<void> {
    const target = this.resolve(relativePath);
    await fs.rm(target, { force: true, recursive: options.recursive === true });
    await fsyncDirectory(path.dirname(target));
  }

  public async ensureDirectory(relativePath: string): Promise<void> {
    const directory = this.resolve(relativePath);
    await fs.mkdir(directory, { recursive: true });
    await fsyncDirectory(path.dirname(directory));
  }
}

export class DataRootOwnerManager {
  private owner: DataRootOwner | undefined;

  public constructor(private readonly files: DurableFileSystem) {}

  public current(): DataRootOwner | undefined { return this.owner; }

  public requireOwner(): DataRootOwner {
    if (!this.owner) throw new Error('Data-root writer ownership has not been acquired.');
    return this.owner;
  }

  public async acquire(): Promise<DataRootOwner> {
    if (this.owner) return this.owner;
    await this.files.ensureDirectory(OWNER_DIR);
    await this.files.ensureDirectory(OWNER_LEASES_DIR);

    const manifest = await this.files.readJson<FencingManifest>(`${OWNER_DIR}/${FENCING_FILE}`);
    validateFencingManifest(manifest);
    let generation = manifest?.generation ?? 0;
    if (manifest) {
      const incumbent = await this.readLease(manifest.generation);
      if (incumbent) {
        if (incumbent.ownerId !== manifest.lastOwnerId) throw new Error('Data-root owner lease and fencing manifest disagree.');
        if (!isStaleOwner(incumbent)) throw new DataRootWriterBlockedError(incumbent);
      }
    }

    const ownerId = randomUUID();
    const acquiredAt = Date.now();
    while (true) {
      generation += 1;
      const owner: DataRootOwner = {
        ownerId,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt,
        fencingGeneration: generation,
        fencingToken: `${generation}:${ownerId}`
      };
      const lease: OwnerLockFile = { schemaVersion: 1, dataRoot: this.files.dataRoot, ...owner };
      try {
        // The immutable generation path is the cross-process CAS. Concurrent stale-owner recovery
        // can only elect one writer for a generation; losers observe that winner instead of unlinking it.
        await this.files.atomicWrite(ownerLeasePath(generation), jsonBytes(lease), { createOnly: true });
      } catch (error) {
        const winner = await this.readLease(generation);
        if (!winner) throw error;
        if (!isStaleOwner(winner)) throw new DataRootWriterBlockedError(winner);
        continue;
      }

      const latest = await this.files.readJson<FencingManifest>(`${OWNER_DIR}/${FENCING_FILE}`);
      validateFencingManifest(latest);
      if (latest && latest.generation >= generation) {
        await this.removeLeaseIfOwned(owner);
        generation = latest.generation;
        const winner = await this.readLease(latest.generation);
        if (winner && !isStaleOwner(winner)) throw new DataRootWriterBlockedError(winner);
        continue;
      }
      await this.files.atomicWrite(`${OWNER_DIR}/${FENCING_FILE}`, jsonBytes({
        schemaVersion: 1,
        generation,
        lastOwnerId: ownerId,
        updatedAt: acquiredAt
      } satisfies FencingManifest));
      this.owner = owner;
      await this.verify();
      return owner;
    }
  }

  public async verify(): Promise<DataRootOwner> {
    const owner = this.requireOwner();
    const lease = await this.readLease(owner.fencingGeneration);
    const manifest = await this.files.readJson<FencingManifest>(`${OWNER_DIR}/${FENCING_FILE}`);
    validateFencingManifest(manifest);
    if (!lease || lease.ownerId !== owner.ownerId || lease.fencingToken !== owner.fencingToken) {
      throw new Error('Data-root writer lease was lost or replaced.');
    }
    if (!manifest || manifest.generation !== owner.fencingGeneration || manifest.lastOwnerId !== owner.ownerId) {
      throw new Error('Data-root fencing manifest no longer matches this writer.');
    }
    return owner;
  }

  public async release(): Promise<void> {
    const owner = this.owner;
    this.owner = undefined;
    if (owner) await this.removeLeaseIfOwned(owner);
  }

  private async readLease(generation: number): Promise<OwnerLockFile | undefined> {
    const lease = await this.files.readJson<OwnerLockFile>(ownerLeasePath(generation));
    if (lease) validateOwnerLease(lease, this.files.dataRoot, generation);
    return lease;
  }

  private async removeLeaseIfOwned(owner: DataRootOwner): Promise<void> {
    const lease = await this.readLease(owner.fencingGeneration);
    if (lease?.ownerId === owner.ownerId && lease.fencingToken === owner.fencingToken) {
      await this.files.remove(ownerLeasePath(owner.fencingGeneration));
    }
  }
}

export function jsonBytes(value: unknown): Uint8Array {
  // 事务 WAL/claim/receipt 可能携带大工具结果投影；紧凑 JSON 可直接降低两阶段写入、hash 与 GC 压力。
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) {
    throw new Error(`Expected a non-empty relative path: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return segments.join('/');
}

async function atomicReplace(source: string, target: string): Promise<void> {
  // Node maps this to the platform's same-volume atomic rename primitive. If a filesystem cannot
  // replace an existing target atomically, the capability probe fails and authoritative mutation
  // remains disabled; deleting the target first would create an unprovable crash window.
  await fs.rename(source, target);
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (process.platform === 'win32' && isWindowsDirectorySyncUnsupported(error)) return;
    throw error;
  }
}

function ownerLeasePath(generation: number): string {
  return `${OWNER_LEASES_DIR}/${generation}.json`;
}

function validateOwnerLease(lease: OwnerLockFile, dataRoot: string, generation = lease.fencingGeneration): void {
  if (lease.schemaVersion !== 1 || lease.dataRoot !== dataRoot || lease.fencingGeneration !== generation
    || !lease.ownerId || !Number.isInteger(lease.pid) || lease.pid <= 0 || !lease.hostname
    || lease.fencingToken !== `${generation}:${lease.ownerId}`) {
    throw new Error(`Invalid data-root owner lease for generation ${generation}.`);
  }
}

function validateFencingManifest(manifest: FencingManifest | undefined): void {
  if (!manifest) return;
  if (manifest.schemaVersion !== 1 || !Number.isInteger(manifest.generation) || manifest.generation < 1 || !manifest.lastOwnerId) {
    throw new Error('Invalid data-root fencing manifest.');
  }
}

function isStaleOwner(owner: OwnerLockFile): boolean {
  if (owner.hostname !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code !== 'EPERM';
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function allowsImmutableInstallCopyFallback(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EXDEV'
    || code === 'EPERM'
    || code === 'EACCES'
    || code === 'ENOTSUP'
    || code === 'EOPNOTSUPP'
    || code === 'EMLINK'
    || code === 'ENOSYS'
    || code === 'EINVAL';
}

function isWindowsDirectorySyncUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EISDIR' || code === 'EPERM' || code === 'EACCES' || code === 'EINVAL';
}

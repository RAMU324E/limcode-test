import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ROOT_BINDING_PENDING_FILE,
  ROOT_BINDING_POINTER_FILE,
  RUNTIME_KERNEL_EPOCH,
  createRuntimeRootPaths,
  freezeRootBinding,
  type RootBinding,
  type RuntimeEpochManifest,
  type RuntimeRootPaths
} from './contracts';

export class RootAuthorityError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RootAuthorityError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class StaleRootBindingError extends RootAuthorityError {
  public constructor(message = 'RootBinding generation is stale; close the Runtime and reopen with the current binding.') {
    super('stale-root-binding', message);
    this.name = 'StaleRootBindingError';
  }
}

export type RuntimeRootInitializer = (binding: RootBinding) => Promise<void>;

export interface CandidateRootActivation {
  authority: RootAuthority;
  binding: RootBinding;
}

/**
 * RootAuthority is the only component allowed to resolve and activate Runtime roots. Long-lived
 * services cache one immutable complete RootBinding, never a naked path. Root changes are offline:
 * callers must close the old service before opening one with the returned binding.
 */
export class RootAuthority {
  public constructor(private readonly getDataRootPath: () => string) {}

  public expectedPaths(): RuntimeRootPaths {
    return createRuntimeRootPaths(this.getDataRootPath());
  }

  public async current(): Promise<RootBinding> {
    const expected = this.expectedPaths();
    if (await exists(expected.rootPendingPath)) {
      throw new RootAuthorityError(
        'root-binding-pending',
        `RootBinding pending marker exists; Runtime open is refused: ${expected.rootPendingPath}`
      );
    }
    const binding = await readBindingFile(expected.rootPointerPath);
    if (!binding) {
      throw new RootAuthorityError('root-binding-missing', `RootBinding pointer is missing: ${expected.rootPointerPath}`);
    }
    if (!samePaths(binding.paths, expected)) {
      throw new StaleRootBindingError('The active RootBinding does not match the data root selected by getPaths(); restart is required.');
    }
    await validateEpoch(binding);
    return binding;
  }

  /** Revalidates the pointer and epoch at the beginning of every request or transaction. */
  public async validate(binding: RootBinding): Promise<RootBinding> {
    const current = await this.current();
    if (!sameBindingIdentity(binding, current)) throw new StaleRootBindingError();
    return current;
  }

  public async withValidatedBinding<T>(binding: RootBinding, operation: (current: RootBinding) => Promise<T>): Promise<T> {
    return operation(await this.validate(binding));
  }

  /** Initializes the selected root when no active pointer exists. No legacy data is inspected. */
  public async initializeEmptyRoot(initializer: RuntimeRootInitializer): Promise<RootBinding> {
    const paths = this.expectedPaths();
    if (await exists(paths.rootPendingPath)) {
      throw new RootAuthorityError('root-binding-pending', `Cannot initialize while pending exists: ${paths.rootPendingPath}`);
    }
    if (await exists(paths.rootPointerPath)) {
      throw new RootAuthorityError('root-binding-exists', `RootBinding pointer already exists: ${paths.rootPointerPath}`);
    }
    return this.activateOffline(paths, undefined, initializer);
  }

  /**
   * Creates and atomically activates a fresh isolated candidate root. Existing candidate data is not
   * imported or copied. This is a development foundation operation, not the production cutover.
   */
  public static async resetCandidateRoot(
    candidateParentPath: string,
    initializer: RuntimeRootInitializer
  ): Promise<CandidateRootActivation> {
    const parent = path.resolve(candidateParentPath);
    await fs.mkdir(parent, { recursive: true });
    const pointerPath = path.join(parent, ROOT_BINDING_POINTER_FILE);
    const pendingPath = path.join(parent, ROOT_BINDING_PENDING_FILE);
    const previous = await readBindingFile(pointerPath);
    const interrupted = await readBindingFile(pendingPath);
    if (interrupted) {
      const interruptedRoot = interrupted.paths.dataRootPath;
      if (
        path.dirname(interruptedRoot) !== parent
        || !path.basename(interruptedRoot).startsWith('candidate-runtime-')
        || interruptedRoot === previous?.paths.dataRootPath
      ) {
        throw new RootAuthorityError('root-binding-pending', `Pending binding is not an isolated candidate root: ${pendingPath}`);
      }
      await fs.rm(interruptedRoot, { recursive: true, force: true });
      await fs.rm(pendingPath, { force: true });
      await syncDirectory(parent);
    }
    const rootName = `candidate-runtime-${randomUUID()}`;
    const dataRootPath = path.join(parent, rootName);
    const authority = new RootAuthority(() => dataRootPath);
    const paths = authority.expectedPaths();
    const binding = await authority.activateOffline(paths, previous, initializer);
    return { authority, binding };
  }

  private async activateOffline(
    paths: RuntimeRootPaths,
    previous: RootBinding | undefined,
    initializer: RuntimeRootInitializer
  ): Promise<RootBinding> {
    await assertFreshRuntimeRoot(paths);
    const binding = freezeRootBinding({
      paths,
      dataSetId: randomUUID(),
      rootInstanceId: randomUUID(),
      rootGeneration: (previous?.rootGeneration ?? 0) + 1,
      pointerRevision: (previous?.pointerRevision ?? 0) + 1,
      runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH
    });

    await fs.mkdir(paths.dataRootPath, { recursive: true });
    await writeDurableJson(paths.rootPendingPath, binding);
    try {
      await initializer(binding);
      const epoch: RuntimeEpochManifest = {
        kind: 'limcode-runtime-kernel-epoch',
        runtimeKernelEpoch: RUNTIME_KERNEL_EPOCH,
        dataSetId: binding.dataSetId,
        rootInstanceId: binding.rootInstanceId,
        rootGeneration: binding.rootGeneration,
        initializedAt: new Date().toISOString()
      };
      await writeDurableJson(paths.runtimeEpochPath, epoch);
      await syncIfFile(paths.databasePath);
      await syncDirectory(paths.casRootPath);
      await syncDirectory(paths.dataRootPath);
      await fs.rename(paths.rootPendingPath, paths.rootPointerPath);
      await syncDirectory(path.dirname(paths.rootPointerPath));
    } catch (error) {
      // Pending intentionally remains. Startup must fail closed until an explicit candidate reset.
      throw new RootAuthorityError(
        'root-activation-failed',
        `Runtime root activation failed: ${paths.dataRootPath}`,
        error
      );
    }
    return this.current();
  }
}

export function parseRootBinding(value: unknown): RootBinding {
  const record = requireRecord(value, 'RootBinding');
  requireExactKeys(record, [
    'paths',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'pointerRevision',
    'runtimeKernelEpoch'
  ], 'RootBinding');
  const paths = parseRootPaths(record.paths);
  const binding: RootBinding = {
    paths,
    dataSetId: requireNonEmptyString(record.dataSetId, 'RootBinding.dataSetId'),
    rootInstanceId: requireNonEmptyString(record.rootInstanceId, 'RootBinding.rootInstanceId'),
    rootGeneration: requirePositiveInteger(record.rootGeneration, 'RootBinding.rootGeneration'),
    pointerRevision: requirePositiveInteger(record.pointerRevision, 'RootBinding.pointerRevision'),
    runtimeKernelEpoch: requireCurrentEpoch(record.runtimeKernelEpoch)
  };
  return freezeRootBinding(binding);
}

export function sameBindingIdentity(left: RootBinding, right: RootBinding): boolean {
  return left.dataSetId === right.dataSetId
    && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision
    && left.runtimeKernelEpoch === right.runtimeKernelEpoch
    && samePaths(left.paths, right.paths);
}

async function validateEpoch(binding: RootBinding): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
  } catch (error) {
    throw new RootAuthorityError(
      'runtime-epoch-missing-or-invalid',
      `Runtime epoch cannot be read: ${binding.paths.runtimeEpochPath}`,
      error
    );
  }
  const manifest = requireRecord(value, 'RuntimeEpochManifest');
  requireExactKeys(manifest, [
    'kind',
    'runtimeKernelEpoch',
    'dataSetId',
    'rootInstanceId',
    'rootGeneration',
    'initializedAt'
  ], 'RuntimeEpochManifest');
  if (
    manifest.kind !== 'limcode-runtime-kernel-epoch'
    || manifest.runtimeKernelEpoch !== binding.runtimeKernelEpoch
    || manifest.dataSetId !== binding.dataSetId
    || manifest.rootInstanceId !== binding.rootInstanceId
    || manifest.rootGeneration !== binding.rootGeneration
    || typeof manifest.initializedAt !== 'string'
    || !manifest.initializedAt
  ) {
    throw new RootAuthorityError('runtime-epoch-mismatch', 'Runtime epoch does not match the active RootBinding.');
  }
}

async function assertFreshRuntimeRoot(paths: RuntimeRootPaths): Promise<void> {
  const existing = await Promise.all([
    paths.databasePath,
    `${paths.databasePath}-wal`,
    `${paths.databasePath}-shm`,
    paths.casRootPath,
    paths.runtimeEpochPath
  ].map(async (entry) => await exists(entry) ? entry : undefined));
  const collisions = existing.filter((entry): entry is string => entry !== undefined);
  if (collisions.length > 0) {
    throw new RootAuthorityError('runtime-root-not-empty', `Fresh Runtime root required; found: ${collisions.join(', ')}`);
  }
}

async function readBindingFile(filePath: string): Promise<RootBinding | undefined> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return parseRootBinding(JSON.parse(text));
  } catch (error) {
    throw new RootAuthorityError('root-binding-invalid', `Invalid RootBinding pointer: ${filePath}`, error);
  }
}

async function writeDurableJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
  await syncDirectory(path.dirname(filePath));
}

async function syncIfFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function parseRootPaths(value: unknown): RuntimeRootPaths {
  const record = requireRecord(value, 'RootBinding.paths');
  requireExactKeys(record, [
    'dataRootPath',
    'databasePath',
    'casRootPath',
    'rootPointerPath',
    'rootPendingPath',
    'runtimeEpochPath'
  ], 'RootBinding.paths');
  return {
    dataRootPath: requireAbsolutePath(record.dataRootPath, 'RootBinding.paths.dataRootPath'),
    databasePath: requireAbsolutePath(record.databasePath, 'RootBinding.paths.databasePath'),
    casRootPath: requireAbsolutePath(record.casRootPath, 'RootBinding.paths.casRootPath'),
    rootPointerPath: requireAbsolutePath(record.rootPointerPath, 'RootBinding.paths.rootPointerPath'),
    rootPendingPath: requireAbsolutePath(record.rootPendingPath, 'RootBinding.paths.rootPendingPath'),
    runtimeEpochPath: requireAbsolutePath(record.runtimeEpochPath, 'RootBinding.paths.runtimeEpochPath')
  };
}

function samePaths(left: RuntimeRootPaths, right: RuntimeRootPaths): boolean {
  return left.dataRootPath === right.dataRootPath
    && left.databasePath === right.databasePath
    && left.casRootPath === right.casRootPath
    && left.rootPointerPath === right.rootPointerPath
    && left.rootPendingPath === right.rootPendingPath
    && left.runtimeEpochPath === right.runtimeEpochPath;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} fields do not match the current schema.`);
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value as number;
}

function requireCurrentEpoch(value: unknown): typeof RUNTIME_KERNEL_EPOCH {
  if (value !== RUNTIME_KERNEL_EPOCH) throw new TypeError('RootBinding.runtimeKernelEpoch is not current.');
  return RUNTIME_KERNEL_EPOCH;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be a normalized absolute path.`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

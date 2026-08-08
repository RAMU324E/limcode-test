import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

let atomicWriteSequence = 0;

const TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS = 4;
const TRANSIENT_FILE_OPERATION_BASE_DELAY_MS = 10;
const FSYNC_UNSUPPORTED_CODES = new Set([
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOTTY',
  'EPERM'
]);

/**
 * Write a file through a sibling temporary file, flush its contents, publish it
 * with rename, and finally flush the containing directory on POSIX.
 *
 * The target is not replaced until the temporary file has been flushed. A real
 * I/O failure therefore leaves the previous target intact. Only errors that
 * explicitly mean the filesystem does not support fsync are allowed to fall
 * back to the operating system's normal write-back behaviour.
 */
export async function writeFileAtomicDurable(filePath: string, data: Uint8Array | string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = createAtomicTempPath(filePath);
  try {
    await writeFileDurable(tempPath, data);
    await renameWithRetry(tempPath, filePath);
  } finally {
    await removeAtomicTempBestEffort(tempPath);
  }
  await syncDirectoryAfterRename(path.dirname(filePath));
}

/** Synchronous counterpart used by the synchronous JSON record store. */
export function writeFileAtomicDurableSync(filePath: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = createAtomicTempPath(filePath);
  try {
    writeFileDurableSync(tempPath, data);
    renameWithRetrySync(tempPath, filePath);
  } finally {
    removeAtomicTempBestEffortSync(tempPath);
  }
  syncDirectoryAfterRenameSync(path.dirname(filePath));
}

export function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function retryTransientFileOperationSync<T>(
  action: () => T,
  maxRetries = 6,
  retryDelayMs = 15
): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientFileBusyError(error)) throw error;
      sleepSync(retryDelayMs * attempt);
    }
  }
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, Math.floor(milliseconds)));
}

async function writeFileDurable(filePath: string, data: Uint8Array | string): Promise<void> {
  await fsp.writeFile(filePath, data);
  let handle: fsp.FileHandle;
  try {
    handle = await retryTransientFileOperation(() => fsp.open(filePath, 'r+'));
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(filePath, error);
    return;
  }

  let operationFailed = false;
  try {
    await syncFileHandle(handle, filePath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

function writeFileDurableSync(filePath: string, data: Uint8Array | string): void {
  fs.writeFileSync(filePath, data);
  let descriptor: number;
  try {
    descriptor = retryTransientFileOperationSync(() => fs.openSync(filePath, 'r+'));
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(filePath, error);
    return;
  }

  let operationFailed = false;
  try {
    syncFileDescriptor(descriptor, filePath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

async function syncFileHandle(handle: fsp.FileHandle, filePath: string): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(filePath, error);
  }
}

function syncFileDescriptor(descriptor: number, filePath: string): void {
  try {
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isFsyncUnsupportedError(error)) throw error;
    warnFsyncUnsupported(filePath, error);
  }
}

const DIRECTORY_FSYNC_SUPPORTED = process.platform !== 'win32';

async function syncDirectoryAfterRename(directoryPath: string): Promise<void> {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;

  let handle: fsp.FileHandle | undefined;
  let operationFailed = false;
  try {
    handle = await retryTransientFileOperation(() => fsp.open(directoryPath, 'r'));
    await syncFileHandle(handle, directoryPath);
  } catch (error) {
    if (isFsyncUnsupportedError(error)) {
      warnFsyncUnsupported(directoryPath, error);
      return;
    }
    operationFailed = true;
    throw error;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  }
}

function syncDirectoryAfterRenameSync(directoryPath: string): void {
  if (!DIRECTORY_FSYNC_SUPPORTED) return;

  let descriptor: number | undefined;
  let operationFailed = false;
  try {
    descriptor = retryTransientFileOperationSync(() => fs.openSync(directoryPath, 'r'));
    syncFileDescriptor(descriptor, directoryPath);
  } catch (error) {
    if (isFsyncUnsupportedError(error)) {
      warnFsyncUnsupported(directoryPath, error);
      return;
    }
    operationFailed = true;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        if (!operationFailed) throw error;
      }
    }
  }
}

function createAtomicTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  await retryTransientFileOperation(() => fsp.rename(source, target));
}

function renameWithRetrySync(source: string, target: string): void {
  retryTransientFileOperationSync(() => fs.renameSync(source, target));
}

async function retryTransientFileOperation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS || !isTransientFileBusyError(error)) throw error;
      await delay(TRANSIENT_FILE_OPERATION_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
}

async function removeAtomicTempBestEffort(tempPath: string): Promise<void> {
  await retryTransientFileOperation(() => fsp.rm(tempPath, { force: true })).catch(() => undefined);
}

function removeAtomicTempBestEffortSync(tempPath: string): void {
  try {
    retryTransientFileOperationSync(() => fs.rmSync(tempPath, { force: true }));
  } catch {
    // Cleanup must not replace the write/rename failure that explains why the
    // target was not published.
  }
}

function isFsyncUnsupportedError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && FSYNC_UNSUPPORTED_CODES.has(code);
}

let fsyncUnsupportedWarned = false;

function warnFsyncUnsupported(filePath: string, error: unknown): void {
  if (fsyncUnsupportedWarned) return;
  fsyncUnsupportedWarned = true;
  console.warn(
    `[LimCode] fsync is unsupported for storage write (${filePath}); `
      + 'data durability falls back to OS flushing and may be lost on power failure.',
    error
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

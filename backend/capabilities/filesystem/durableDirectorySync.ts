import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';

const WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EPERM', 'EINVAL', 'ENOTSUP']);

/**
 * Flushes directory metadata after an atomic publish.
 *
 * Windows does not reliably support fsync on directory handles. Only that platform-specific,
 * directory-only limitation is tolerated; ordinary file fsync remains the caller's strict duty.
 */
export async function syncDirectoryDurably(
  directoryPath: string,
  onSynced?: () => void
): Promise<boolean> {
  const handle = await fsp.open(directoryPath, 'r');
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (isUnsupportedWindowsDirectorySyncError(error)) return false;
      throw error;
    }
    onSynced?.();
    return true;
  } finally {
    await handle.close();
  }
}

/** Synchronous counterpart used by the detached process Wrapper and synchronous stores. */
export function syncDirectoryDurablySync(
  directoryPath: string,
  onSynced?: () => void
): boolean {
  const descriptor = fs.openSync(directoryPath, 'r');
  try {
    try {
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (isUnsupportedWindowsDirectorySyncError(error)) return false;
      throw error;
    }
    onSynced?.();
    return true;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function isUnsupportedWindowsDirectorySyncError(error: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && WINDOWS_UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code);
}

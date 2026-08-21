import * as path from 'node:path';

const RETRYABLE_WINDOWS_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

interface RenameErrorShape {
  code?: unknown;
  syscall?: unknown;
  path?: unknown;
  dest?: unknown;
}

/**
 * Classifies a failed candidate -> canonical publication using only immutable error fields.
 * Canonical lock existence is intentionally not consulted: that state can change between
 * observations and must never decide whether the original Windows rename error escapes.
 */
export function isRetryableWindowsLockPublicationRenameError(
  error: unknown,
  canonicalLockPath: string,
  platform: NodeJS.Platform
): boolean {
  const candidate = error as RenameErrorShape;
  return platform === 'win32'
    && RETRYABLE_WINDOWS_RENAME_CODES.has(String(candidate.code))
    && candidate.syscall === 'rename'
    && typeof candidate.dest === 'string'
    && sameWindowsPath(candidate.dest, canonicalLockPath);
}

/** Classifies transient Windows rename failures while fencing/releasing one known generation. */
export function isRetryableWindowsLockGenerationRenameError(
  error: unknown,
  sourcePath: string,
  destinationPath: string,
  platform: NodeJS.Platform
): boolean {
  const candidate = error as RenameErrorShape;
  return isRetryableWindowsLockPublicationRenameError(error, destinationPath, platform)
    && typeof candidate.path === 'string'
    && sameWindowsPath(candidate.path, sourcePath);
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

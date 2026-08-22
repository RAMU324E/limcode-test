import * as path from 'node:path';

/**
 * Converts one logical Runtime file path only at the SQLite native I/O boundary.
 * RootBinding, journals and persisted schema rows must continue to use the ordinary canonical path.
 */
export function toSqliteFilePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new TypeError('SQLite file path must be non-empty text.');
  }
  if (platform !== 'win32') return filePath;
  if (!path.win32.isAbsolute(filePath)) {
    throw new TypeError('SQLite file path must be absolute on Windows.');
  }
  return path.win32.toNamespacedPath(filePath);
}

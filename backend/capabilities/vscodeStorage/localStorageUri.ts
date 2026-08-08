import * as path from 'node:path';
import * as vscode from 'vscode';

const NODE_FS_STORAGE_SCHEMES = new Set(['file', 'vscode-userdata']);

/** 默认用户数据 URI 在部分桌面/远程宿主中仍对应扩展宿主可直接访问的本地路径。 */
export function isNodeFsStorageUri(uri: vscode.Uri): boolean {
  return NODE_FS_STORAGE_SCHEMES.has(uri.scheme) && !!normalizedFsPath(uri.fsPath);
}

export function nodeFsStoragePath(uri: vscode.Uri): string {
  const resolved = normalizedFsPath(uri.fsPath);
  if (!NODE_FS_STORAGE_SCHEMES.has(uri.scheme) || !resolved) {
    throw new Error(`Storage URI is not backed by local node fs: ${uri.toString()}`);
  }
  return resolved;
}

function normalizedFsPath(value: string): string {
  if (!value) return '';
  const candidate = process.platform === 'win32' && /^[\\/][a-zA-Z]:[\\/]/.test(value)
    ? value.slice(1)
    : value;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : '';
}

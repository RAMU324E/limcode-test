import * as path from 'node:path';
import type { createVscodeStoragePaths } from '../capabilities/vscodeStorage/paths';
import { RootAuthority } from './rootAuthority';

type VscodeStoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export const VSCODE_RUNTIME_CONTROL_DIRECTORY = '.limcode-runtime';
export const VSCODE_RUNTIME_ACTIVE_DIRECTORY = 'active';

/**
 * Runtime 数据根必须位于扩展自己的 settings/data root 内，不能把 RootBinding 指针写到
 * `globalStoragePath` 的共享父目录。配置 authority 仍留在 settings root，与 Runtime SQLite 解耦。
 */
export function resolveVscodeRuntimeDataRoot(paths: Pick<VscodeStoragePaths, 'globalStoragePath'>): string {
  return path.join(
    path.resolve(paths.globalStoragePath),
    VSCODE_RUNTIME_CONTROL_DIRECTORY,
    VSCODE_RUNTIME_ACTIVE_DIRECTORY
  );
}

/** Builds RootAuthority from a freshly resolved storage capability path on every validation. */
export function createVscodeRootAuthority(getPaths: () => VscodeStoragePaths): RootAuthority {
  return new RootAuthority(() => resolveVscodeRuntimeDataRoot(getPaths()));
}

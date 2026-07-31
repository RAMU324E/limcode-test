import type { createVscodeStoragePaths } from '../capabilities/vscodeStorage/paths';
import { RootAuthority } from './rootAuthority';

type VscodeStoragePaths = ReturnType<typeof createVscodeStoragePaths>;

/** Builds RootAuthority from the current storage capability getPaths() result on every validation. */
export function createVscodeRootAuthority(getPaths: () => VscodeStoragePaths): RootAuthority {
  return new RootAuthority(() => getPaths().globalStoragePath);
}

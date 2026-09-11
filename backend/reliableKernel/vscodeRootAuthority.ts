import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { createVscodeStoragePaths } from '../capabilities/vscodeStorage/paths';
import { ROOT_BINDING_POINTER_FILE, createRuntimeRootPaths } from './contracts';
import { RootAuthority } from './rootAuthority';
import { assertRuntimeHostsOffline } from './runtimeHostControl';

type VscodeStoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export const VSCODE_RUNTIME_CONTROL_DIRECTORY = '.limcode-runtime';
export const VSCODE_RUNTIME_ACTIVE_DIRECTORY = 'active';
export const VSCODE_WORKSPACE_RUNTIMES_DIRECTORY = '.limcode-workspace-runtimes';
export const VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY = 'scopes';
export const VSCODE_LEGACY_RUNTIME_OWNER_DIRECTORY = 'legacy-owner';
export const VSCODE_LEGACY_RUNTIME_OWNER_FILE = 'owner.json';

const WORKSPACE_RUNTIME_ID_DOMAIN = 'limcode-vscode-workspace-runtime\0';
const LEGACY_RUNTIME_OWNER_KIND = 'limcode-legacy-runtime-owner';

export type VscodeWorkspaceRuntimeScopeKind =
  | 'workspace-file'
  | 'folder'
  | 'folder-set'
  | 'empty';

export interface VscodeWorkspaceRuntimeScopeInput {
  workspaceFileUri?: string;
  workspaceFolderUris?: readonly string[];
}

export interface VscodeWorkspaceRuntimeScope {
  kind: VscodeWorkspaceRuntimeScopeKind;
  /** Stable directory/claim key derived only from the canonical workspace identity. */
  key: string;
  /** Human-inspectable hash input retained for the one-time legacy assignment record. */
  identity: string;
}

export interface VscodeWorkspaceRuntimePlacement {
  scope: VscodeWorkspaceRuntimeScope;
  /** Shared configuration root selected by globalStatus. */
  configurationRootPath: string;
  /** Root passed to the cutover/reset coordinator for this workspace only. */
  runtimeScopeRootPath: string;
  /** Immutable SQLite/CAS root consumed by RootAuthority. */
  runtimeDataRootPath: string;
  usesLegacyRuntime: boolean;
}

export interface VscodeLegacyRuntimeOwner {
  kind: typeof LEGACY_RUNTIME_OWNER_KIND;
  workspaceKey: string;
  workspaceKind: VscodeWorkspaceRuntimeScopeKind;
  workspaceIdentity: string;
  assignedAt: string;
}

/**
 * Resolves one immutable Runtime scope for the VS Code window. The workspace file wins for saved
 * and untitled multi-root workspaces; the sorted folder set is only a fallback for hosts without a
 * workspaceFile URI. Names and active editors never participate in identity.
 */
export function resolveVscodeWorkspaceRuntimeScope(
  input: VscodeWorkspaceRuntimeScopeInput
): VscodeWorkspaceRuntimeScope {
  const workspaceFileUri = normalizeUri(input.workspaceFileUri);
  const stableWorkspaceFileUri = /^untitled:/i.test(workspaceFileUri) ? '' : workspaceFileUri;
  const folderUris = [...new Set((input.workspaceFolderUris ?? []).map(normalizeUri).filter(isText))].sort();
  let kind: VscodeWorkspaceRuntimeScopeKind;
  let identity: string;
  if (stableWorkspaceFileUri) {
    kind = 'workspace-file';
    identity = stableWorkspaceFileUri;
  } else if (folderUris.length === 1) {
    kind = 'folder';
    identity = folderUris[0];
  } else if (folderUris.length > 1) {
    kind = 'folder-set';
    identity = JSON.stringify(folderUris);
  } else {
    kind = 'empty';
    identity = 'empty';
  }
  const digest = createHash('sha256')
    .update(WORKSPACE_RUNTIME_ID_DOMAIN)
    .update(kind)
    .update('\0')
    .update(identity)
    .digest('hex');
  return Object.freeze({ kind, key: `${kind}-${digest}`, identity });
}

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

/** Directory containing a complete per-workspace cutover/reset control plane. */
export function resolveVscodeWorkspaceRuntimeScopeRoot(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  scope: Pick<VscodeWorkspaceRuntimeScope, 'key'>
): string {
  return path.join(
    path.resolve(paths.globalStoragePath),
    VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
    VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY,
    scope.key
  );
}

export function resolveVscodeLegacyRuntimeOwnerPath(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>
): string {
  return path.join(
    path.resolve(paths.globalStoragePath),
    VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
    VSCODE_LEGACY_RUNTIME_OWNER_DIRECTORY,
    VSCODE_LEGACY_RUNTIME_OWNER_FILE
  );
}


/**
 * Selects the workspace Runtime without moving or rewriting an existing fenced root. The first
 * non-empty workspace that encounters the old root atomically records its ownership; subsequent
 * workspaces use the sibling scope tree and initialize independently.
 */
export async function resolveVscodeWorkspaceRuntimePlacement(
  paths: Pick<VscodeStoragePaths, 'globalStoragePath'>,
  scope: VscodeWorkspaceRuntimeScope
): Promise<VscodeWorkspaceRuntimePlacement> {
  const configurationRootPath = path.resolve(paths.globalStoragePath);
  let legacyOwner = await readLegacyRuntimeOwner(configurationRootPath);
  if (!legacyOwner && scope.kind !== 'empty' && await legacyRuntimeExists(configurationRootPath)) {
    legacyOwner = await assignLegacyRuntimeOwner(configurationRootPath, scope);
  }
  const usesLegacyRuntime = legacyOwner?.workspaceKey === scope.key;
  const runtimeScopeRootPath = usesLegacyRuntime
    ? configurationRootPath
    : resolveVscodeWorkspaceRuntimeScopeRoot({ globalStoragePath: configurationRootPath }, scope);
  return Object.freeze({
    scope,
    configurationRootPath,
    runtimeScopeRootPath,
    runtimeDataRootPath: resolveVscodeRuntimeDataRoot({ globalStoragePath: runtimeScopeRootPath }),
    usesLegacyRuntime
  });
}

/** Builds RootAuthority from the immutable placement captured for this Extension Host activation. */
export function createVscodeRootAuthority(
  placement: Pick<VscodeWorkspaceRuntimePlacement, 'runtimeDataRootPath' | 'configurationRootPath'>
): RootAuthority {
  const runtimeDataRootPath = path.resolve(placement.runtimeDataRootPath);
  const configurationRootPath = path.resolve(placement.configurationRootPath);
  return new RootAuthority(() => runtimeDataRootPath, undefined, () => configurationRootPath);
}

/**
 * Offline assertion spanning every Runtime root contained in one configuration data root: the
 * legacy root and each workspace scope root. The legacy physical cutover filters/deletes shared
 * configuration records outside its own Runtime control tree, so checking only its own Host
 * liveness is not enough. Call only while holding the configuration-root admission
 * (RootAuthority.withRuntimeHostAdmission); the admission serializes the enumeration against new
 * scope registration. A scoped (non-configuration) root simply enumerates itself.
 */
export async function assertConfigurationRootRuntimesOffline(
  configurationRootPath: string,
  exceptHostBootId?: string
): Promise<void> {
  const configurationRoot = path.resolve(configurationRootPath);
  await assertRuntimeHostsOffline(
    createRuntimeRootPaths(resolveVscodeRuntimeDataRoot({ globalStoragePath: configurationRoot })),
    exceptHostBootId
  );
  const scopesRoot = path.join(
    configurationRoot,
    VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
    VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY
  );
  for (const scopeKey of await directoryEntryNames(scopesRoot)) {
    await assertRuntimeHostsOffline(
      createRuntimeRootPaths(resolveVscodeRuntimeDataRoot({ globalStoragePath: path.join(scopesRoot, scopeKey) })),
      exceptHostBootId
    );
  }
}

async function readLegacyRuntimeOwner(configurationRootPath: string): Promise<VscodeLegacyRuntimeOwner | undefined> {
  const ownerPath = resolveVscodeLegacyRuntimeOwnerPath({ globalStoragePath: configurationRootPath });
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (
    record?.kind !== LEGACY_RUNTIME_OWNER_KIND
    || !isText(record.workspaceKey)
    || !isWorkspaceRuntimeScopeKind(record.workspaceKind)
    || !isText(record.workspaceIdentity)
    || !isText(record.assignedAt)
  ) throw new Error(`Legacy Runtime owner record is invalid: ${ownerPath}`);
  return {
    kind: LEGACY_RUNTIME_OWNER_KIND,
    workspaceKey: record.workspaceKey,
    workspaceKind: record.workspaceKind,
    workspaceIdentity: record.workspaceIdentity,
    assignedAt: record.assignedAt
  };
}

async function assignLegacyRuntimeOwner(
  configurationRootPath: string,
  scope: VscodeWorkspaceRuntimeScope
): Promise<VscodeLegacyRuntimeOwner> {
  const workspaceRuntimeRoot = path.join(configurationRootPath, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY);
  const ownerRoot = path.join(workspaceRuntimeRoot, VSCODE_LEGACY_RUNTIME_OWNER_DIRECTORY);
  const candidateRoot = path.join(workspaceRuntimeRoot, `.legacy-owner-${process.pid}-${randomUUID()}`);
  const owner: VscodeLegacyRuntimeOwner = {
    kind: LEGACY_RUNTIME_OWNER_KIND,
    workspaceKey: scope.key,
    workspaceKind: scope.kind,
    workspaceIdentity: scope.identity,
    assignedAt: new Date().toISOString()
  };
  await fs.mkdir(workspaceRuntimeRoot, { recursive: true });
  await fs.mkdir(candidateRoot);
  try {
    await fs.writeFile(
      path.join(candidateRoot, VSCODE_LEGACY_RUNTIME_OWNER_FILE),
      `${JSON.stringify(owner, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );
    try {
      await fs.rename(candidateRoot, ownerRoot);
      return owner;
    } catch (error) {
      if (!isExistingPathError(error)) throw error;
    }
  } finally {
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }
  const winner = await readLegacyRuntimeOwner(configurationRootPath);
  if (!winner) throw new Error(`Legacy Runtime owner publication did not produce ${ownerRoot}`);
  return winner;
}

async function legacyRuntimeExists(configurationRootPath: string): Promise<boolean> {
  const legacyRuntimeRoot = resolveVscodeRuntimeDataRoot({ globalStoragePath: configurationRootPath });
  try {
    await fs.access(path.join(path.dirname(legacyRuntimeRoot), ROOT_BINDING_POINTER_FILE));
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function normalizeUri(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isWorkspaceRuntimeScopeKind(value: unknown): value is VscodeWorkspaceRuntimeScopeKind {
  return value === 'workspace-file' || value === 'folder' || value === 'folder-set' || value === 'empty';
}

async function directoryEntryNames(directoryPath: string): Promise<string[]> {
  try {
    return await fs.readdir(directoryPath);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isExistingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

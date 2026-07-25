import * as vscode from 'vscode';
import {
  DATA_FORMAT_EPOCH,
  DATA_ROOT_MARKER_FILE,
  REGISTERED_STORAGE_ROOT_DIRS,
  REGISTERED_STORAGE_ROOT_FILES
} from './constants';
import { readJson, writeJson } from './json';
import type { createVscodeStoragePaths } from './paths';

type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;
type DataEpochPaths = Pick<StoragePaths,
  | 'globalStorageUri'
  | 'globalStoragePath'
  | 'dataEpochUri'
  | 'dataResetPendingUri'
  | 'dataBackupsRootUri'
>;

const DATA_ROOT_MARKER_KIND = 'limcode-data-root';
const RESET_ARCHIVE_MANIFEST_FILE = 'reset-archive.json';

export interface DataRootEpochManifest {
  kind: typeof DATA_ROOT_MARKER_KIND;
  epoch: typeof DATA_FORMAT_EPOCH;
  initializedAt: string;
}

interface DataRootResetPendingManifest {
  kind: 'limcode-data-reset';
  targetEpoch: typeof DATA_FORMAT_EPOCH;
  startedAt: string;
}

interface DataRootResetArchiveManifest {
  kind: 'limcode-data-reset-archive';
  targetEpoch: typeof DATA_FORMAT_EPOCH;
  archivedAt: string;
  sourceDataRootPath: string;
  archivedEntries: string[];
}

export type StorageDataEpochMismatchReason =
  | 'missing_marker'
  | 'epoch_mismatch'
  | 'invalid_marker'
  | 'reset_incomplete';

/**
 * 旧开发数据、损坏 marker 与未完成重置均是显式阻断状态。
 * 调用方只能让用户归档并重置，不能把它降级为“空数据”继续写入。
 */
export class StorageDataEpochMismatchError extends Error {
  public readonly code = 'migration_required' as const;

  public constructor(
    public readonly reason: StorageDataEpochMismatchReason,
    public readonly dataRootPath: string,
    public readonly expectedEpoch: number,
    public readonly actualEpoch: number | undefined,
    public readonly managedEntries: readonly string[],
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = 'StorageDataEpochMismatchError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export interface StorageDataResetResult {
  dataRootPath: string;
  epoch: number;
  archivedEntries: string[];
  backupPath?: string;
}

/** Ensures the active data root is either pristine or explicitly stamped with the current epoch. */
export async function ensureCurrentDataEpoch(paths: DataEpochPaths): Promise<DataRootEpochManifest> {
  await vscode.workspace.fs.createDirectory(paths.globalStorageUri);

  if (await entryExists(paths.dataResetPendingUri)) {
    throw mismatch(
      'reset_incomplete',
      paths,
      undefined,
      await existingManagedEntries(paths),
      '上次开发数据重置未完成。请再次执行“归档并重置开发数据”，然后重载窗口。'
    );
  }

  let marker: unknown;
  try {
    marker = await readJson<unknown>(paths.dataEpochUri, { throwOnError: true });
  } catch (error) {
    throw mismatch(
      'invalid_marker',
      paths,
      undefined,
      await existingManagedEntries(paths),
      '数据目录的 epoch 标记损坏，已拒绝加载以避免覆盖现有数据。',
      error
    );
  }

  if (marker === undefined) {
    const managedEntries = await existingManagedEntries(paths);
    if (managedEntries.length > 0) {
      throw mismatch(
        'missing_marker',
        paths,
        undefined,
        managedEntries,
        `检测到未标记的旧开发数据（${managedEntries.join('、')}），当前版本不会兼容或隐式迁移这些记录。`
      );
    }
    const initialized = currentManifest();
    await writeJson(paths.dataEpochUri, initialized);
    return initialized;
  }

  if (!isDataRootEpochManifest(marker)) {
    const actualEpoch = epochFromUnknown(marker);
    const reason: StorageDataEpochMismatchReason = actualEpoch === undefined ? 'invalid_marker' : 'epoch_mismatch';
    throw mismatch(
      reason,
      paths,
      actualEpoch,
      await existingManagedEntries(paths),
      actualEpoch === undefined
        ? '数据目录的 epoch 标记格式无效，已拒绝加载。'
        : `数据目录 epoch 为 ${actualEpoch}，当前需要 ${DATA_FORMAT_EPOCH}；旧记录不会被兼容加载。`
    );
  }

  return marker;
}

/**
 * Archives only LimCode-managed top-level entries, preserves unrelated user files, then stamps a
 * pristine current-epoch root. The pending marker makes interrupted resets fail closed on restart.
 */
export async function resetManagedDataRoot(
  paths: DataEpochPaths,
  options: { archive?: boolean } = {}
): Promise<StorageDataResetResult> {
  const archive = options.archive !== false;
  const startedAt = new Date().toISOString();
  await vscode.workspace.fs.createDirectory(paths.globalStorageUri);
  const pending: DataRootResetPendingManifest = {
    kind: 'limcode-data-reset',
    targetEpoch: DATA_FORMAT_EPOCH,
    startedAt
  };
  await writeJson(paths.dataResetPendingUri, pending);

  const entries = await existingManagedEntries(paths);
  let backupUri: vscode.Uri | undefined;
  try {
    if (archive && entries.length > 0) {
      await vscode.workspace.fs.createDirectory(paths.dataBackupsRootUri);
      backupUri = await nextBackupUri(paths.dataBackupsRootUri, startedAt);
      await vscode.workspace.fs.createDirectory(backupUri);
    }

    for (const name of entries) {
      const source = vscode.Uri.joinPath(paths.globalStorageUri, name);
      if (backupUri) {
        const target = vscode.Uri.joinPath(backupUri, name);
        await vscode.workspace.fs.rename(source, target, { overwrite: false });
      } else {
        await vscode.workspace.fs.delete(source, { recursive: true, useTrash: false });
      }
    }

    if (backupUri) {
      const archiveManifest: DataRootResetArchiveManifest = {
        kind: 'limcode-data-reset-archive',
        targetEpoch: DATA_FORMAT_EPOCH,
        archivedAt: new Date().toISOString(),
        sourceDataRootPath: paths.globalStoragePath,
        archivedEntries: [...entries]
      };
      await writeJson(vscode.Uri.joinPath(backupUri, RESET_ARCHIVE_MANIFEST_FILE), archiveManifest);
    }

    await writeJson(paths.dataEpochUri, currentManifest());
    await deleteIfExists(paths.dataResetPendingUri);
    return {
      dataRootPath: paths.globalStoragePath,
      epoch: DATA_FORMAT_EPOCH,
      archivedEntries: [...entries],
      ...(backupUri ? { backupPath: backupUri.fsPath } : {})
    };
  } catch (error) {
    // Keep the pending marker. Startup must fail closed until the operator retries the reset.
    throw error;
  }
}

function currentManifest(): DataRootEpochManifest {
  return {
    kind: DATA_ROOT_MARKER_KIND,
    epoch: DATA_FORMAT_EPOCH,
    initializedAt: new Date().toISOString()
  };
}

function isDataRootEpochManifest(value: unknown): value is DataRootEpochManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DataRootEpochManifest>;
  return candidate.kind === DATA_ROOT_MARKER_KIND
    && candidate.epoch === DATA_FORMAT_EPOCH
    && typeof candidate.initializedAt === 'string'
    && candidate.initializedAt.trim().length > 0;
}

function epochFromUnknown(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const epoch = (value as { epoch?: unknown }).epoch;
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : undefined;
}

async function existingManagedEntries(paths: DataEpochPaths): Promise<string[]> {
  const names = [...REGISTERED_STORAGE_ROOT_DIRS, ...REGISTERED_STORAGE_ROOT_FILES];
  const entries: string[] = [];
  for (const name of names) {
    if (await entryExists(vscode.Uri.joinPath(paths.globalStorageUri, name))) entries.push(name);
  }
  return entries;
}

async function entryExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

async function deleteIfExists(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

async function nextBackupUri(root: vscode.Uri, startedAt: string): Promise<vscode.Uri> {
  const stem = startedAt.replace(/[-:TZ.]/g, '').slice(0, 17);
  for (let ordinal = 0; ; ordinal += 1) {
    const suffix = ordinal === 0 ? '' : `-${ordinal}`;
    const candidate = vscode.Uri.joinPath(root, `${stem}${suffix}`);
    if (!await entryExists(candidate)) return candidate;
  }
}

function mismatch(
  reason: StorageDataEpochMismatchReason,
  paths: DataEpochPaths,
  actualEpoch: number | undefined,
  managedEntries: readonly string[],
  message: string,
  cause?: unknown
): StorageDataEpochMismatchError {
  return new StorageDataEpochMismatchError(
    reason,
    paths.globalStoragePath,
    DATA_FORMAT_EPOCH,
    actualEpoch,
    managedEntries,
    message,
    cause
  );
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const text = [candidate.name, candidate.code, candidate.message, candidate.stack, String(error)]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}

export { DATA_ROOT_MARKER_FILE };

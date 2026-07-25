import { STORAGE_VERSION } from '../capabilities/vscodeStorage/constants';
import type { DurableFileSystem } from './fileDurability';

interface CanonicalRecordIndexEntry {
  id: string;
  file: string;
}

interface CanonicalRecordIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: CanonicalRecordIndexEntry[];
}

export interface CanonicalRecordStoreSpec<TRecord extends { id: string }> {
  rootRelativePath: string;
  recordKey: string;
  validateRecord?: (record: TRecord) => void;
}

/** Strict canonical record-store read. It never repairs, filters, recovers, or rewrites data. */
export async function loadCanonicalRecordStore<TRecord extends { id: string }>(
  files: DurableFileSystem,
  spec: CanonicalRecordStoreSpec<TRecord>
): Promise<TRecord[]> {
  const root = normalizeRoot(spec.rootRelativePath);
  const indexPath = `${root}/index.json`;
  const recordsRoot = `${root}/records`;
  const [index, physicalRecordFiles] = await Promise.all([
    files.readJson<CanonicalRecordIndexFile>(indexPath),
    files.listFilesRecursive(recordsRoot)
  ]);
  if (!index) {
    if (physicalRecordFiles.length > 0) throw new Error(`Authoritative records exist without an index: ${root}`);
    return [];
  }
  validateTimestamp(index.savedAt, `${indexPath}:savedAt`);
  if (index.schemaVersion !== STORAGE_VERSION || !Array.isArray(index.records)) {
    throw new Error(`Invalid authoritative record-store index: ${indexPath}`);
  }

  const ids = new Set<string>();
  const indexedPaths = new Set<string>();
  let previousId: string | undefined;
  for (const entry of index.records) {
    if (!isIndexEntry(entry)) throw new Error(`Invalid authoritative record-store index entry: ${indexPath}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate authoritative record ID: ${root}:${entry.id}`);
    if (previousId !== undefined && previousId.localeCompare(entry.id) >= 0) {
      throw new Error(`Authoritative record-store index is not strictly sorted: ${root}:${entry.id}`);
    }
    if (indexedPaths.has(entry.file)) throw new Error(`Authoritative record file is reused: ${root}/${entry.file}`);
    previousId = entry.id;
    ids.add(entry.id);
    indexedPaths.add(entry.file);
  }

  const physicalPaths = new Set(physicalRecordFiles);
  const expectedPaths = new Set([...indexedPaths].map((relativePath) => `${root}/${relativePath}`));
  const missing = [...expectedPaths].filter((relativePath) => !physicalPaths.has(relativePath));
  const unindexed = physicalRecordFiles.filter((relativePath) => !expectedPaths.has(relativePath));
  if (missing.length > 0 || unindexed.length > 0) {
    throw new Error(`Authoritative record-store index and files disagree for ${root}; missing=[${missing.join(', ')}], unindexed=[${unindexed.join(', ')}].`);
  }

  const records = await Promise.all(index.records.map(async (entry): Promise<TRecord> => {
    const wrapper = await files.readJson<Record<string, unknown>>(`${root}/${entry.file}`);
    if (!wrapper || wrapper.schemaVersion !== STORAGE_VERSION) {
      throw new Error(`Authoritative record is missing or has the wrong schema: ${root}:${entry.id}`);
    }
    validateTimestamp(wrapper.savedAt, `${root}/${entry.file}:savedAt`);
    const record = wrapper[spec.recordKey] as TRecord | undefined;
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.id !== entry.id) {
      throw new Error(`Authoritative record payload is invalid: ${root}:${entry.id}`);
    }
    spec.validateRecord?.(record);
    return record;
  }));
  return records;
}

function isIndexEntry(value: unknown): value is CanonicalRecordIndexEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<CanonicalRecordIndexEntry>;
  return typeof entry.id === 'string' && !!entry.id
    && typeof entry.file === 'string' && /^records\/[^/]+\.json$/.test(entry.file);
}

function normalizeRoot(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid canonical record-store root: ${value}`);
  }
  return normalized;
}

function validateTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid canonical timestamp: ${label}`);
}

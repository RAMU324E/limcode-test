import { createHash } from 'node:crypto';
import { STORAGE_VERSION } from '../../capabilities/vscodeStorage/constants';
import type { DurablePostimage, JsonValue } from '../../../shared/conversationReliability';
import type { DurableFileSystem } from '../fileDurability';
import { sha256Bytes } from '../fileDurability';

interface RecordStoreIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: RecordStoreIndexEntry[];
}

interface RecordStoreIndexEntry {
  id: string;
  file: string;
}

export interface CompileRecordStoreInput<TRecord extends { id: string }> {
  files: DurableFileSystem;
  rootRelativePath: string;
  recordKey: string;
  currentRecords: readonly TRecord[];
  nextRecords: readonly TRecord[];
  touchedIds: ReadonlySet<string>;
  now: number;
  labelForRecord?: (record: TRecord) => string;
}

export interface CompiledRecordStore {
  postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>;
  index: RecordStoreIndexFile | undefined;
}

/**
 * Compiles explicit record mutations into record/index postimages. It never creates an empty store
 * merely because a sibling family changed, and it preserves stable record filenames and timestamps
 * for untouched records.
 */
export async function compileRecordStore<TRecord extends { id: string }>(
  input: CompileRecordStoreInput<TRecord>
): Promise<CompiledRecordStore> {
  assertFiniteTimestamp(input.now);
  const root = normalizeRoot(input.rootRelativePath);
  const indexPath = `${root}/index.json`;
  assertUniqueRecords(input.currentRecords, `${root}:current`);
  assertUniqueRecords(input.nextRecords, `${root}:next`);

  const currentById = new Map(input.currentRecords.map((record) => [record.id, record]));
  const nextById = new Map(input.nextRecords.map((record) => [record.id, record]));
  // Canonical no-op admission must happen before touching storage. This is particularly important for
  // high-frequency ToolCall status patches that often repeat an already committed terminal record.
  if ([...input.touchedIds].every((id) => {
    const current = currentById.get(id);
    const next = nextById.get(id);
    return !!current && !!next && canonicalJson(current) === canonicalJson(next);
  })) {
    return { postimages: [], index: undefined };
  }

  const previous = await input.files.readJson<RecordStoreIndexFile>(indexPath);
  validateIndex(previous, indexPath);
  const previousEntries = previous?.records ?? [];
  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]));

  if (!previous && currentById.size > 0) {
    throw new Error(`Authoritative record store has records but no index: ${indexPath}`);
  }
  for (const id of currentById.keys()) {
    if (!previousById.has(id)) throw new Error(`Authoritative record is absent from its index: ${root}:${id}`);
  }
  for (const id of previousById.keys()) {
    if (!currentById.has(id)) throw new Error(`Authoritative record index contains a fact absent from the loaded domain: ${root}:${id}`);
  }

  const savedAt = new Date(input.now).toISOString();
  const nextEntries = new Map(previousEntries.map((entry) => [entry.id, { ...entry }]));
  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  let indexChanged = false;

  for (const id of [...input.touchedIds].sort()) {
    const current = currentById.get(id);
    const next = nextById.get(id);
    const previousEntry = previousById.get(id);
    if (!next) {
      if (!current || !previousEntry) throw new Error(`Record removal does not name an existing authoritative record: ${root}:${id}`);
      postimages.push(deletePostimage(`${root}/${previousEntry.file}`));
      nextEntries.delete(id);
      indexChanged = true;
      continue;
    }

    if (current && canonicalJson(current) === canonicalJson(next)) continue;
    const file = previousEntry?.file
      ?? `records/${deterministicRecordFileStem(input.now, id, input.labelForRecord?.(next) ?? id)}.json`;
    assertRecordRelativePath(file, `${root}:${id}`);
    const recordBytes = compactJsonBytes({
      schemaVersion: STORAGE_VERSION,
      savedAt,
      [input.recordKey]: next as unknown as JsonValue
    });
    postimages.push(writePostimage(`${root}/${file}`, recordBytes));
    if (!previousEntry) {
      nextEntries.set(id, { id, file });
      indexChanged = true;
    }
  }

  const compiledIds = new Set(nextEntries.keys());
  if (compiledIds.size !== nextById.size || [...nextById.keys()].some((id) => !compiledIds.has(id))) {
    throw new Error(`Record mutations do not explain the complete post-state of ${root}.`);
  }
  if (!indexChanged) {
    return {
      postimages: postimages.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath)),
      index: previous
    };
  }

  const index: RecordStoreIndexFile = {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    records: [...nextEntries.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
  postimages.push(writePostimage(indexPath, prettyJsonBytes(index)));
  return {
    postimages: postimages.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath)),
    index
  };
}

export function writePostimage(
  targetRelativePath: string,
  bytes: Uint8Array
): Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'> {
  const copied = new Uint8Array(bytes);
  return {
    operation: 'write',
    targetRelativePath,
    postimageHash: sha256Bytes(copied),
    bytes: copied
  };
}

export function deletePostimage(
  targetRelativePath: string
): Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'> {
  return { operation: 'delete', targetRelativePath, postimageHash: null };
}

export function prettyJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function compactJsonBytes(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

function validateIndex(index: RecordStoreIndexFile | undefined, path: string): void {
  if (!index) return;
  if (index.schemaVersion !== STORAGE_VERSION || typeof index.savedAt !== 'string'
    || !Number.isFinite(Date.parse(index.savedAt)) || !Array.isArray(index.records)) {
    throw new Error(`Invalid authoritative record store index: ${path}`);
  }
  const seenIds = new Set<string>();
  const seenFiles = new Set<string>();
  let previousId: string | undefined;
  for (const entry of index.records) {
    if (!entry.id) throw new Error(`Incomplete authoritative record store index entry: ${path}`);
    assertRecordRelativePath(entry.file, `${path}:${entry.id}`);
    if (seenIds.has(entry.id)) throw new Error(`Duplicate authoritative record ID in index: ${path}:${entry.id}`);
    if (previousId !== undefined && previousId.localeCompare(entry.id) >= 0) {
      throw new Error(`Authoritative record store index is not strictly sorted: ${path}:${entry.id}`);
    }
    if (seenFiles.has(entry.file)) throw new Error(`Authoritative record file is reused by multiple IDs: ${path}:${entry.file}`);
    previousId = entry.id;
    seenIds.add(entry.id);
    seenFiles.add(entry.file);
  }
}

function assertUniqueRecords<TRecord extends { id: string }>(records: readonly TRecord[], label: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.id || ids.has(record.id)) throw new Error(`Duplicate or empty record ID in ${label}: ${record.id || '<empty>'}`);
    ids.add(record.id);
  }
}

function deterministicRecordFileStem(now: number, id: string, label: string): string {
  const timestamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'record';
  const hash = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);
  return `${timestamp}-${slug}-${hash}`;
}

function assertRecordRelativePath(value: string, label: string): void {
  if (!value.startsWith('records/') || !value.endsWith('.json')
    || value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid authoritative record path for ${label}: ${value}`);
  }
}

function normalizeRoot(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid record store root: ${value}`);
  }
  return normalized;
}

function assertFiniteTimestamp(value: number): void {
  if (!Number.isFinite(value)) throw new Error(`Record store compiler timestamp is invalid: ${value}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

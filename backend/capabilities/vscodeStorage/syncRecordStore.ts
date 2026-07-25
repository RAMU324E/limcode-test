import * as fs from 'node:fs';
import * as path from 'node:path';
import { sortableName } from './naming';
import { readJsonFileStrictSync, unlinkWithRetrySync, writeJsonFileAtomicSync } from './syncJson';
import { withSyncStorageResourceLock, type SyncStorageResourceLockOptions } from './syncStorageResourceLock';

const STORE_VERSION = 1;
const RECORDS_DIR = 'records';
const LOCK_OPTIONS: SyncStorageResourceLockOptions = {
  waitMs: 2_500,
  staleMs: 30_000,
  pollIntervalMs: 10,
  invalidMetadataWaitMs: 50,
  maxRetries: 8,
  retryDelayMs: 10
};

interface SyncRecordIndexEntry {
  id: string;
  file: string;
  updatedAt: number;
}

interface SyncRecordIndexFile {
  version: number;
  records: SyncRecordIndexEntry[];
}

export interface SyncRecordStoreLocations {
  rootPath: string;
  indexPath: string;
}

export interface SyncRecordStoreOptions<T extends { id: string }> {
  readonly name: string;
  readonly locations: () => SyncRecordStoreLocations | undefined;
  readonly isRecord: (value: unknown) => value is T;
  readonly updatedAt: (record: T) => number;
  readonly label?: (record: T) => string;
}

/**
 * Small synchronous record store for child-process callbacks. Index mutations are serialized across
 * extension instances and every file replacement is atomic. Invalid/corrupt indexes are rejected;
 * they are never interpreted as an empty index and overwritten.
 */
export class SyncRecordStore<T extends { id: string }> {
  public constructor(private readonly options: SyncRecordStoreOptions<T>) {}

  public available(): boolean {
    return this.options.locations() !== undefined;
  }

  public list(): T[] {
    const locations = this.options.locations();
    if (!locations) return [];
    return withSyncStorageResourceLock(locations.indexPath, () => {
      const index = this.readIndex(locations.indexPath, true);
      return index.records.map((entry) => this.readRecord(locations, entry));
    }, LOCK_OPTIONS);
  }

  public get(id: string): T | undefined {
    const locations = this.options.locations();
    if (!locations) return undefined;
    return withSyncStorageResourceLock(locations.indexPath, () => {
      const index = this.readIndex(locations.indexPath, true);
      const entry = index.records.find((candidate) => candidate.id === id);
      return entry ? this.readRecord(locations, entry) : undefined;
    }, LOCK_OPTIONS);
  }

  public upsert(record: T): void {
    this.compareAndSwap(record, () => true);
  }

  /** Compare and write under one cross-instance index lock. beforeWrite shares the same fence. */
  public compareAndSwap(
    record: T,
    accept: (current: T | undefined) => boolean,
    beforeWrite?: (current: T | undefined) => void
  ): { written: true; current?: T } | { written: false; current?: T } {
    const locations = this.requireLocations();
    return withSyncStorageResourceLock(locations.indexPath, () => {
      const index = this.readIndex(locations.indexPath, true);
      let entry = index.records.find((candidate) => candidate.id === record.id);
      const current = entry ? this.readRecord(locations, entry) : undefined;
      if (!accept(current)) return current ? { written: false, current } : { written: false };
      beforeWrite?.(current);
      if (!entry) {
        const label = this.options.label?.(record) ?? record.id;
        entry = { id: record.id, file: `${sortableName(record.id, label)}.json`, updatedAt: this.options.updatedAt(record) };
        index.records.push(entry);
      } else {
        entry.updatedAt = this.options.updatedAt(record);
      }
      writeJsonFileAtomicSync(path.join(locations.rootPath, RECORDS_DIR, entry.file), record);
      index.records.sort((a, b) => a.id.localeCompare(b.id));
      this.writeIndex(locations.indexPath, index);
      return current ? { written: true, current } : { written: true };
    }, LOCK_OPTIONS);
  }

  /** Create-once immutable record. A mismatching replay is rejected rather than overwritten. */
  public insertImmutable(record: T, equals: (current: T, proposed: T) => boolean): T {
    const result = this.compareAndSwap(record, (current) => current === undefined || equals(current, record));
    if (!result.written && result.current) throw new Error(`${this.options.name} immutable record conflict: ${record.id}`);
    return result.current ?? record;
  }

  public remove(id: string): void {
    const locations = this.options.locations();
    if (!locations) return;
    withSyncStorageResourceLock(locations.indexPath, () => {
      const index = this.readIndex(locations.indexPath, true);
      const entry = index.records.find((candidate) => candidate.id === id);
      if (!entry) return;
      unlinkWithRetrySync(path.join(locations.rootPath, RECORDS_DIR, entry.file), true);
      this.writeIndex(locations.indexPath, {
        version: STORE_VERSION,
        records: index.records.filter((candidate) => candidate.id !== id)
      });
    }, LOCK_OPTIONS);
  }

  public recordFileName(id: string): string | undefined {
    const locations = this.options.locations();
    if (!locations) return undefined;
    return withSyncStorageResourceLock(locations.indexPath, () => {
      const index = this.readIndex(locations.indexPath, true);
      return index.records.find((candidate) => candidate.id === id)?.file;
    }, LOCK_OPTIONS);
  }

  private requireLocations(): SyncRecordStoreLocations {
    const locations = this.options.locations();
    if (!locations) throw new Error(`${this.options.name} storage paths are unavailable.`);
    return locations;
  }

  private readIndex(indexPath: string, allowMissing: boolean): SyncRecordIndexFile {
    const result = readJsonFileStrictSync<unknown>(indexPath);
    if (result.status === 'missing' && allowMissing) return { version: STORE_VERSION, records: [] };
    if (result.status !== 'ok') {
      const error = new Error(`Refusing to read ${this.options.name} index (${result.status}); existing data is preserved: ${indexPath}`);
      (error as Error & { cause?: unknown }).cause = result.error;
      throw error;
    }
    if (!isIndex(result.value)) throw new Error(`Invalid ${this.options.name} index schema; existing data is preserved: ${indexPath}`);
    return { version: STORE_VERSION, records: result.value.records.map((entry) => ({ ...entry })) };
  }

  private readRecord(locations: SyncRecordStoreLocations, entry: SyncRecordIndexEntry): T {
    const filePath = path.join(locations.rootPath, RECORDS_DIR, entry.file);
    const result = readJsonFileStrictSync<unknown>(filePath);
    if (result.status !== 'ok' || !this.options.isRecord(result.value)) {
      const detail = result.status === 'ok' ? 'invalid schema' : result.status;
      throw new Error(`Refusing to load ${this.options.name} record ${entry.id} (${detail}): ${filePath}`);
    }
    return result.value;
  }

  private writeIndex(indexPath: string, index: SyncRecordIndexFile): void {
    writeJsonFileAtomicSync(indexPath, { version: STORE_VERSION, records: index.records });
  }
}

function isIndex(value: unknown): value is SyncRecordIndexFile {
  const record = asRecord(value);
  return !!record
    && record.version === STORE_VERSION
    && Array.isArray(record.records)
    && record.records.every((entry) => {
      const candidate = asRecord(entry);
      return !!candidate
        && typeof candidate.id === 'string'
        && !!candidate.id.trim()
        && typeof candidate.file === 'string'
        && !!candidate.file.trim()
        && !candidate.file.includes('/')
        && !candidate.file.includes('\\')
        && typeof candidate.updatedAt === 'number'
        && Number.isFinite(candidate.updatedAt);
    });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryInsertMutation
} from './repositories';
import { RootAuthority, sameBindingIdentity } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';

export interface PublishedContent {
  contentType: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  absolutePath: string;
}

export interface ContentObjectMetadata extends DomainRow {
  id: string;
  content_type: string;
  sha256: string;
  byte_length: bigint;
  storage_key: string;
  created_at: string;
}

export interface ContentObjectIdentity {
  id: string;
  content_type: string;
  sha256: string;
  byte_length: bigint;
  storage_key: string;
}

export interface PreparedContentObject {
  metadata: ContentObjectMetadata;
  insert?: RepositoryInsertMutation;
}

export class ContentAddressedStore {
  public constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding
  ) {}

  public identity(content: Uint8Array | string, contentType: string): ContentObjectIdentity {
    const normalizedType = requireContentType(contentType);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const published: PublishedContent = {
      contentType: normalizedType,
      sha256,
      byteLength: BigInt(bytes.length),
      storageKey: storageKeyForDigest(sha256),
      absolutePath: ''
    };
    return {
      id: contentObjectId(published),
      content_type: normalizedType,
      sha256,
      byte_length: published.byteLength,
      storage_key: published.storageKey
    };
  }

  public async publish(content: Uint8Array | string, contentType: string): Promise<PublishedContent> {
    await this.authority.validate(this.binding);
    const normalizedType = requireContentType(contentType);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = storageKeyForDigest(sha256);
    const absolutePath = absoluteCasPath(this.binding, storageKey);
    const casRoot = this.binding.paths.casRootPath;
    const temporaryRoot = path.join(casRoot, 'tmp');
    const digestRoot = path.join(casRoot, 'sha256');
    const digestPrefix = path.dirname(absolutePath);
    await ensureDurableChildDirectory(casRoot, temporaryRoot);
    await ensureDurableChildDirectory(casRoot, digestRoot);
    await ensureDurableChildDirectory(digestRoot, digestPrefix);
    const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await assertExistingObject(absolutePath, sha256, BigInt(bytes.length));
      }
      // Both the publisher and an EEXIST observer must durably publish the directory entry before
      // either is allowed to commit a SQLite reference.
      await syncDirectory(digestPrefix);
    } finally {
      await fs.rm(temporaryPath, { force: true });
      await syncDirectory(temporaryRoot);
    }

    return {
      contentType: normalizedType,
      sha256,
      byteLength: BigInt(bytes.length),
      storageKey,
      absolutePath
    };
  }

  /**
   * Publishes bytes first, then prepares (but does not commit) the ContentObject mutation. This lets
   * a domain command commit its receipt, ContentObject reference and state transition atomically.
   */
  public async prepare(
    database: RuntimeDatabase,
    content: Uint8Array | string,
    contentType: string
  ): Promise<PreparedContentObject> {
    if (!sameBindingIdentity(database.binding, this.binding)) {
      throw new Error('CAS and RuntimeDatabase must use the same RootBinding.');
    }
    const published = await this.publish(content, contentType);
    const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
    const where = contentObjectIdentity(published);
    const existing = await database.snapshot([repository.list({ where, limit: 1 })]);
    const row = (existing.snapshot[0] as DomainRow[])[0];
    if (row) return { metadata: asContentObjectMetadata(row) };
    const metadata = contentObjectMetadata(published);
    return { metadata, insert: repository.insert(metadata) };
  }

  /** CAS publish completes before the ContentObject Repository transaction starts. */
  public async ingest(
    database: RuntimeDatabase,
    content: Uint8Array | string,
    contentType: string
  ): Promise<ContentObjectMetadata> {
    const prepared = await this.prepare(database, content, contentType);
    if (!prepared.insert) return prepared.metadata;
    try {
      await database.transaction([prepared.insert]);
      return prepared.metadata;
    } catch (error) {
      const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
      const raced = await database.snapshot([repository.list({
        where: contentObjectIdentityFromMetadata(prepared.metadata),
        limit: 1
      })]);
      const racedRow = (raced.snapshot[0] as DomainRow[])[0];
      if (racedRow) return asContentObjectMetadata(racedRow);
      throw error;
    }
  }

  public async read(metadata: ContentObjectMetadata): Promise<Buffer> {
    await this.authority.validate(this.binding);
    return readPublishedObject(this.binding, metadata);
  }

  /** One fenced async operation; duplicate ContentObjects are read and verified once, then fanned out. */
  public async readMany(metadata: readonly ContentObjectMetadata[]): Promise<Buffer[]> {
    await this.authority.validate(this.binding);
    const unique = [...new Map(metadata.map((entry) => [entry.id, entry])).values()];
    const contents = new Map<string, Buffer>();
    const concurrency = Math.min(32, Math.max(1, unique.length));
    let nextIndex = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= unique.length) return;
        const entry = unique[index];
        contents.set(entry.id, await readPublishedObject(this.binding, entry));
      }
    }));
    return metadata.map((entry) => {
      const bytes = contents.get(entry.id);
      if (!bytes) throw new Error(`CAS batch read lost ContentObject ${entry.id}.`);
      return bytes;
    });
  }
}

export function storageKeyForDigest(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('CAS digest must be lowercase SHA-256.');
  return `sha256/${sha256.slice(0, 2)}/${sha256}`;
}

function contentObjectId(content: PublishedContent): string {
  const digest = createHash('sha256')
    .update('limcode-content-object\0')
    .update(content.contentType)
    .update('\0')
    .update(content.sha256)
    .update('\0')
    .update(content.byteLength.toString())
    .digest('hex');
  return `content_${digest}`;
}

function contentObjectIdentity(content: PublishedContent): DomainRow {
  return {
    content_type: content.contentType,
    sha256: content.sha256,
    byte_length: content.byteLength
  };
}

function contentObjectIdentityFromMetadata(metadata: ContentObjectMetadata): DomainRow {
  return {
    content_type: metadata.content_type,
    sha256: metadata.sha256,
    byte_length: metadata.byte_length
  };
}

function contentObjectMetadata(content: PublishedContent): ContentObjectMetadata {
  return {
    id: contentObjectId(content),
    content_type: content.contentType,
    sha256: content.sha256,
    byte_length: content.byteLength,
    storage_key: content.storageKey,
    created_at: new Date().toISOString()
  };
}

function absoluteCasPath(binding: RootBinding, storageKey: string): string {
  const root = path.resolve(binding.paths.casRootPath);
  const candidate = path.resolve(root, ...storageKey.split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('CAS storage key escapes its active root.');
  return candidate;
}

function validatePublishedBytes(metadata: ContentObjectMetadata, bytes: Buffer): Buffer {
  if (BigInt(bytes.length) !== metadata.byte_length) throw new Error('CAS object byte length mismatch.');
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('CAS object digest mismatch.');
  return bytes;
}

async function readPublishedObject(binding: RootBinding, metadata: ContentObjectMetadata): Promise<Buffer> {
  const expectedKey = storageKeyForDigest(metadata.sha256);
  if (metadata.storage_key !== expectedKey) throw new Error('ContentObject storage key does not match sha256.');
  const filePath = absoluteCasPath(binding, expectedKey);
  return validatePublishedBytes(metadata, await fs.readFile(filePath));
}

async function assertExistingObject(filePath: string, digest: string, byteLength: bigint): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('Existing CAS object has the wrong length.');
  const bytes = await fs.readFile(filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Existing CAS object has the wrong digest.');
}

async function ensureDurableChildDirectory(parentPath: string, childPath: string): Promise<void> {
  if (path.dirname(childPath) !== parentPath) {
    throw new Error(`CAS durable directory ${childPath} is not a direct child of ${parentPath}.`);
  }
  try {
    await fs.mkdir(childPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const stat = await fs.stat(childPath);
    if (!stat.isDirectory()) throw new Error(`CAS path ${childPath} exists but is not a directory.`);
  }
  // Sync both sides even after EEXIST: a competing creator may not yet have synced the parent.
  await syncDirectory(childPath);
  await syncDirectory(parentPath);
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireContentType(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('CAS contentType must be non-empty.');
  return value.trim();
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

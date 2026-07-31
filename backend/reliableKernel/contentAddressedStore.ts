import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
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

export class ContentAddressedStore {
  public constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding
  ) {}

  public async publish(content: Uint8Array | string, contentType: string): Promise<PublishedContent> {
    await this.authority.validate(this.binding);
    const normalizedType = requireContentType(contentType);
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = storageKeyForDigest(sha256);
    const absolutePath = absoluteCasPath(this.binding, storageKey);
    const temporaryRoot = path.join(this.binding.paths.casRootPath, 'tmp');
    await fs.mkdir(temporaryRoot, { recursive: true });
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.link(temporaryPath, absolutePath);
      await syncDirectory(path.dirname(absolutePath));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await assertExistingObject(absolutePath, sha256, BigInt(bytes.length));
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

  /** CAS publish completes before the ContentObject Repository transaction starts. */
  public async ingest(
    database: RuntimeDatabase,
    content: Uint8Array | string,
    contentType: string
  ): Promise<ContentObjectMetadata> {
    if (!sameBindingIdentity(database.binding, this.binding)) {
      throw new Error('CAS and RuntimeDatabase must use the same RootBinding.');
    }
    const published = await this.publish(content, contentType);
    const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
    const where = {
      content_type: published.contentType,
      sha256: published.sha256,
      byte_length: published.byteLength
    };
    const existing = await database.snapshot([repository.list({ where, limit: 1 })]);
    const row = (existing.snapshot[0] as DomainRow[])[0];
    if (row) return asContentObjectMetadata(row);

    const metadata: ContentObjectMetadata = {
      id: contentObjectId(published),
      content_type: published.contentType,
      sha256: published.sha256,
      byte_length: published.byteLength,
      storage_key: published.storageKey,
      created_at: new Date().toISOString()
    };
    try {
      await database.transaction([repository.insert(metadata)]);
      return metadata;
    } catch (error) {
      const raced = await database.snapshot([repository.list({ where, limit: 1 })]);
      const racedRow = (raced.snapshot[0] as DomainRow[])[0];
      if (racedRow) return asContentObjectMetadata(racedRow);
      throw error;
    }
  }

  public async read(metadata: ContentObjectMetadata): Promise<Buffer> {
    await this.authority.validate(this.binding);
    const expectedKey = storageKeyForDigest(metadata.sha256);
    if (metadata.storage_key !== expectedKey) throw new Error('ContentObject storage key does not match sha256.');
    const filePath = absoluteCasPath(this.binding, expectedKey);
    const bytes = await fs.readFile(filePath);
    if (BigInt(bytes.length) !== metadata.byte_length) throw new Error('CAS object byte length mismatch.');
    if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('CAS object digest mismatch.');
    return bytes;
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

function absoluteCasPath(binding: RootBinding, storageKey: string): string {
  const root = path.resolve(binding.paths.casRootPath);
  const candidate = path.resolve(root, ...storageKey.split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('CAS storage key escapes its active root.');
  return candidate;
}

async function assertExistingObject(filePath: string, digest: string, byteLength: bigint): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('Existing CAS object has the wrong length.');
  const bytes = await fs.readFile(filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Existing CAS object has the wrong digest.');
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

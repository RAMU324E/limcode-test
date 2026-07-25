import { createHash } from 'node:crypto';
import type { AttachmentRecord, InlineDataPart } from '../../shared/protocol';
import { STORAGE_VERSION } from '../capabilities/vscodeStorage/constants';
import type { DurableFileSystem } from './fileDurability';
import { canonicalAttachmentBase64 } from './attachmentBase64';
import { loadCanonicalRecordStore } from './canonicalRecordStore';

interface CanonicalAttachmentBlobFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

/** Reads the canonical attachment resource without repairing, filtering, or rewriting it. */
export async function loadCanonicalAttachmentRecords(files: DurableFileSystem): Promise<AttachmentRecord[]> {
  return loadCanonicalRecordStore(files, {
    rootRelativePath: 'attachments',
    recordKey: 'attachment',
    validateRecord: validateAttachmentRecord
  });
}

/** Requires one managed attachment through its strict canonical record and immutable blob. */
export async function requireCanonicalManagedAttachmentData(
  files: DurableFileSystem,
  attachmentId: string
): Promise<InlineDataPart> {
  const id = attachmentId.trim();
  if (!id) throw new Error('Managed attachment ID is empty.');
  const records = await loadCanonicalAttachmentRecords(files);
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Canonical attachment record does not exist: ${id}`);
  const path = `attachments/${record.blobFile}`;
  const blob = await files.readJson<CanonicalAttachmentBlobFile>(path);
  const blobCreatedAt = blob ? Date.parse(blob.savedAt) : Number.NaN;
  if (!blob || blob.schemaVersion !== STORAGE_VERSION || blob.attachmentId !== record.id
    || blob.mimeType !== record.mimeType || typeof blob.data !== 'string'
    || !Number.isFinite(blobCreatedAt) || blobCreatedAt !== record.createdAt) {
    throw new Error(`Canonical attachment blob is missing or invalid: ${path}`);
  }
  const data = canonicalAttachmentBase64(blob.data, `Canonical attachment blob ${path}`);
  if (blob.data !== data) throw new Error(`Canonical attachment blob is not canonical base64: ${path}`);
  const bytes = Buffer.from(data, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== record.sha256 || bytes.byteLength !== record.sizeBytes
    || Buffer.byteLength(data, 'utf8') !== record.base64Bytes) {
    throw new Error(`Canonical attachment blob disagrees with its record: ${path}`);
  }
  return {
    inlineData: {
      mimeType: record.mimeType,
      data,
      ...(record.name ? { name: record.name } : blob.name ? { name: blob.name } : {}),
      attachmentId: record.id,
      sha256: record.sha256,
      storage: 'managed',
      status: 'available',
      sizeBytes: record.sizeBytes
    }
  };
}

/**
 * Marks immutable blobs from canonical attachment records only. Every published record must retain
 * an existing blob; all other files beneath attachments/blobs are interrupted blob-first staging.
 */
export async function discoverOrphanedAttachmentBlobTargets(files: DurableFileSystem): Promise<string[]> {
  const records = await loadCanonicalAttachmentRecords(files);
  const retained = new Set(records.map((record) => `attachments/${record.blobFile}`));
  for (const target of retained) {
    if (await files.hash(target) === null) {
      throw new Error(`Canonical attachment record points to a missing blob: ${target}`);
    }
  }
  return (await files.listFilesRecursive('attachments/blobs'))
    .filter((relativePath) => !retained.has(relativePath));
}

function validateAttachmentRecord(record: AttachmentRecord): void {
  if (record.id !== `attachment-${record.sha256?.slice(0, 24)}`
    || typeof record.mimeType !== 'string' || !record.mimeType
    || record.name !== undefined && (typeof record.name !== 'string' || !record.name)
    || !isNonNegativeInteger(record.sizeBytes)
    || !isNonNegativeInteger(record.base64Bytes)
    || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)
    || record.blobFile !== `blobs/${record.sha256}.base64.json`
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0
    || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) {
    throw new Error(`Authoritative attachment record is invalid: ${record.id}`);
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

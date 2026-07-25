import { createHash } from 'node:crypto';
import { STORAGE_VERSION } from '../../capabilities/vscodeStorage/constants';
import type { AttachmentRecord, MessageContent } from '../../../shared/protocol';
import type { DurablePostimage } from '../../../shared/conversationReliability';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { loadCanonicalAttachmentRecords } from '../attachmentResource';
import { canonicalAttachmentBase64 } from '../attachmentBase64';
import { compileRecordStore } from './recordStoreCompiler';

interface AttachmentBlobFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

interface ManagedReference {
  id: string;
  sha256: string;
  sizeBytes?: number;
}

export async function compileAttachmentRecordPostimages(input: {
  files: DurableFileSystem;
  nextFacts: readonly DurableConversationFacts[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const references = new Map<string, ManagedReference>();
  for (const facts of input.nextFacts) {
    for (const content of durableAttachmentContents(facts)) collectManagedReferences(content, references);
  }
  if (references.size === 0) return [];

  const currentRecords = await loadCanonicalAttachmentRecords(input.files);
  const currentById = new Map(currentRecords.map((record) => [record.id, record]));
  const added: AttachmentRecord[] = [];
  for (const reference of references.values()) {
    const current = currentById.get(reference.id);
    if (current) {
      if (current.sha256 !== reference.sha256
        || reference.sizeBytes !== undefined && current.sizeBytes !== reference.sizeBytes) {
        throw new Error(`Managed attachment reference differs from authoritative record: ${reference.id}`);
      }
      continue;
    }
    added.push(await recordFromBlob(input.files, reference));
  }
  if (added.length === 0) return [];

  const nextRecords = [...currentRecords, ...added].sort((left, right) => left.id.localeCompare(right.id));
  return (await compileRecordStore({
    files: input.files,
    rootRelativePath: 'attachments',
    recordKey: 'attachment',
    currentRecords,
    nextRecords,
    touchedIds: new Set(added.map((record) => record.id)),
    now: input.now,
    labelForRecord: (record) => record.name ?? record.mimeType ?? record.id
  })).postimages;
}

async function recordFromBlob(files: DurableFileSystem, reference: ManagedReference): Promise<AttachmentRecord> {
  const blobFile = `blobs/${reference.sha256}.base64.json`;
  const blob = await files.readJson<AttachmentBlobFile>(`attachments/${blobFile}`);
  if (!blob || blob.schemaVersion !== STORAGE_VERSION || blob.attachmentId !== reference.id
    || typeof blob.mimeType !== 'string' || !blob.mimeType || typeof blob.data !== 'string') {
    throw new Error(`Staged managed attachment blob is missing or invalid: ${reference.id}`);
  }
  const data = canonicalAttachmentBase64(blob.data, `Staged managed attachment blob ${reference.id}`);
  if (blob.data !== data) throw new Error(`Staged managed attachment blob is not canonical base64: ${reference.id}`);
  const bytes = Buffer.from(data, 'base64');
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== reference.sha256) throw new Error(`Staged managed attachment blob hash is invalid: ${reference.id}`);
  if (reference.sizeBytes !== undefined && reference.sizeBytes !== bytes.byteLength) {
    throw new Error(`Managed attachment reference size differs from staged blob: ${reference.id}`);
  }
  const createdAt = Date.parse(blob.savedAt);
  if (!Number.isFinite(createdAt)) throw new Error(`Staged managed attachment blob timestamp is invalid: ${reference.id}`);
  return {
    id: reference.id,
    mimeType: blob.mimeType,
    ...(blob.name ? { name: blob.name } : {}),
    sizeBytes: bytes.byteLength,
    base64Bytes: Buffer.byteLength(data, 'utf8'),
    sha256: actualHash,
    blobFile,
    createdAt,
    updatedAt: createdAt
  };
}

function durableAttachmentContents(facts: DurableConversationFacts): MessageContent[] {
  return [
    ...facts.messages.map((record) => record.content),
    ...facts.messageRevisions.map((record) => record.content),
    ...facts.toolCalls.flatMap((tool) => tool.responseParts?.length
      ? [{ role: 'user' as const, parts: tool.responseParts }]
      : []),
    ...facts.streamCheckpointHeads.flatMap((head) => head.resolvedContent ? [head.resolvedContent] : [])
  ];
}

function collectManagedReferences(content: MessageContent, target: Map<string, ManagedReference>): void {
  visit(content.parts, target);
}

function visit(value: unknown, target: Map<string, ManagedReference>): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, target);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const attachmentId = typeof record.attachmentId === 'string' ? record.attachmentId : undefined;
  if (attachmentId?.startsWith('attachment-')) {
    const sha256 = typeof record.sha256 === 'string' ? record.sha256 : '';
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`Managed attachment reference is incomplete: ${attachmentId}`);
    }
    const reference: ManagedReference = {
      id: attachmentId,
      sha256,
      ...(typeof record.sizeBytes === 'number' && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 0
        ? { sizeBytes: record.sizeBytes }
        : {})
    };
    const existing = target.get(attachmentId);
    if (existing && (existing.sha256 !== reference.sha256
      || existing.sizeBytes !== undefined && reference.sizeBytes !== undefined && existing.sizeBytes !== reference.sizeBytes)) {
      throw new Error(`Managed attachment has conflicting durable references: ${attachmentId}`);
    }
    target.set(attachmentId, existing ?? reference);
  }
  for (const nested of Object.values(record)) visit(nested, target);
}

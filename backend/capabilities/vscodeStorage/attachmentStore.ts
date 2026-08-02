import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
  AttachmentRecord,
  AttachmentSettingsRecord,
  ClientState,
  ContentPart,
  FunctionResponsePart,
  InlineDataPart,
  MessageContent
} from '../../../shared/protocol';
import { isFunctionResponsePart, isInlineDataPart } from '../../../shared/protocol';
import { STORAGE_VERSION } from './constants';
import type { StoragePaths } from './paths';
import { loadGlobalSettingsFile } from './globalSettings';
import { DurableFileSystem, jsonBytes } from '../../reliability/fileDurability';
import { StoragePathAuthorityRegistry } from '../../reliability/storagePathAuthority';
import { canonicalAttachmentBase64 } from '../../reliability/attachmentBase64';

const ATTACHMENT_BLOBS_DIR = 'blobs';
const ATTACHMENT_OPENED_DIR = 'opened';
const DEFAULT_MAX_STORED_INLINE_FILE_MB = 20;

interface AttachmentBlobFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  attachmentId: string;
  mimeType: string;
  name?: string;
  data: string;
}

interface ExternalizeContext {
  maxStoredBytes: number;
  cache: Map<string, AttachmentRecord>;
}

export interface AttachmentInlineDataInput {
  mimeType: string;
  data: string;
  name?: string;
}

export interface AttachmentReferenceInput {
  attachmentId?: string;
  sourcePath?: string;
  mimeType?: string;
  name?: string;
}

export type ManagedAttachmentDataLoader = (attachmentId: string) => Promise<InlineDataPart>;

export interface ResolvedAttachmentInlineData {
  part: InlineDataPart;
  status: 'available' | 'missing';
  error?: string;
}

export async function loadAttachmentSettings(paths: StoragePaths): Promise<AttachmentSettingsRecord> {
  const stored = await loadGlobalSettingsFile(paths.settingsRootUri, 'attachments');
  const record = stored.settings as Partial<AttachmentSettingsRecord> | undefined;
  const number = Number(record?.maxStoredInlineFileMb);
  return {
    maxStoredInlineFileMb: Number.isFinite(number)
      ? Math.min(200, Math.max(1, Math.floor(number)))
      : DEFAULT_MAX_STORED_INLINE_FILE_MB
  };
}

/** Writes only the immutable/rebuildable blob. Its durable record is published by the conversation transaction. */
export async function stageManagedAttachmentBlob(paths: StoragePaths, input: AttachmentInlineDataInput): Promise<AttachmentRecord> {
  const data = canonicalAttachmentBase64(input.data);
  const bytes = Buffer.from(data, 'base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const id = `attachment-${sha256.slice(0, 24)}`;
  const now = Date.now();
  const blobFile = `${ATTACHMENT_BLOBS_DIR}/${sha256}.base64.json`;
  const relativePath = `attachments/${blobFile}`;
  new StoragePathAuthorityRegistry().assertLiveWriteAllowed(relativePath, 'immutable-content-writer');
  const files = new DurableFileSystem(paths.globalStoragePath);
  const candidate: AttachmentBlobFile = {
    schemaVersion: STORAGE_VERSION,
    savedAt: new Date(now).toISOString(),
    attachmentId: id,
    mimeType: input.mimeType,
    ...(input.name ? { name: input.name } : {}),
    data
  };
  try {
    await files.atomicWrite(relativePath, jsonBytes(candidate), { createOnly: true });
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
  }
  const blob = await files.readJson<AttachmentBlobFile>(relativePath);
  const createdAt = blob ? Date.parse(blob.savedAt) : Number.NaN;
  if (!blob || blob.schemaVersion !== STORAGE_VERSION || blob.attachmentId !== id
    || blob.data !== data || !blob.mimeType || !Number.isFinite(createdAt)) {
    throw new Error(`Immutable managed attachment blob is invalid: ${id}`);
  }
  return {
    id,
    mimeType: blob.mimeType,
    ...(blob.name ? { name: blob.name } : {}),
    sizeBytes: bytes.byteLength,
    base64Bytes: Buffer.byteLength(data, 'utf8'),
    sha256,
    blobFile,
    createdAt,
    updatedAt: createdAt
  };
}

/**
 * Persists inline bytes before a conversation command publishes their reference. A crash between
 * these two commits can only leave an unreferenced immutable blob, which attachment mark/sweep may
 * collect; it can never leave a durable Message pointing at bytes that were not written.
 */
export async function ingestMessageContentAttachments(paths: StoragePaths, content: MessageContent): Promise<MessageContent> {
  if (!hasInlineDataPart(content)) return content;
  const settings = await loadAttachmentSettings(paths);
  const normalized = await externalizeContentAttachments(paths, content, {
    maxStoredBytes: settings.maxStoredInlineFileMb * 1024 * 1024,
    cache: new Map()
  });
  assertCanonicalDurableMessageContentAttachments(normalized);
  return normalized;
}

export function markClientStateAttachmentsForClient(state: ClientState): ClientState {
  state.messages = state.messages.map((message) => ({ ...message, content: markContentAttachmentsForClient(message.content) }));
  state.messageRevisions = state.messageRevisions.map((revision) => ({ ...revision, content: markContentAttachmentsForClient(revision.content) }));
  return state;
}

export async function resolveAttachmentForClient(
  paths: StoragePaths,
  input: AttachmentReferenceInput,
  requireManagedAttachment: ManagedAttachmentDataLoader
): Promise<ResolvedAttachmentInlineData> {
  if (input.attachmentId?.trim()) {
    const part = await requireManagedAttachment(input.attachmentId.trim());
    return {
      part: {
        inlineData: {
          ...part.inlineData,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.name ? { name: input.name } : {})
        }
      },
      status: 'available'
    };
  }

  if (input.sourcePath?.trim()) {
    try {
      const uri = vscode.Uri.file(input.sourcePath.trim());
      const data = await vscode.workspace.fs.readFile(uri);
      return {
        part: {
          inlineData: {
            mimeType: input.mimeType || 'application/octet-stream',
            data: Buffer.from(data).toString('base64'),
            ...(input.name ? { name: input.name } : { name: path.basename(uri.fsPath) }),
            sourcePath: uri.fsPath,
            storage: 'localPath',
            status: 'available',
            sizeBytes: data.byteLength
          }
        },
        status: 'available'
      };
    } catch (error) {
      const message = errorMessage(error);
      return { part: unavailableInlineData(input, 'missing', message), status: 'missing', error: message };
    }
  }

  return { part: unavailableInlineData(input, 'missing', '缺少附件引用'), status: 'missing', error: '缺少附件引用' };
}

export async function materializeAttachmentFileUri(
  paths: StoragePaths,
  input: AttachmentReferenceInput,
  requireManagedAttachment: ManagedAttachmentDataLoader
): Promise<vscode.Uri | undefined> {
  if (input.sourcePath?.trim()) return vscode.Uri.file(input.sourcePath.trim());
  if (!input.attachmentId?.trim()) return undefined;
  const resolved = await resolveAttachmentForClient(paths, input, requireManagedAttachment);
  const data = resolved.part.inlineData.data;
  if (!data) throw new Error(`Canonical managed attachment has no bytes: ${input.attachmentId}`);
  const fileName = safeAttachmentFileName(input.attachmentId, resolved.part.inlineData.name ?? input.name, resolved.part.inlineData.mimeType);
  const relativePath = `attachments/${ATTACHMENT_OPENED_DIR}/${fileName}`;
  new StoragePathAuthorityRegistry().assertLiveWriteAllowed(relativePath, 'derived-projection-writer');
  await new DurableFileSystem(paths.globalStoragePath).atomicWrite(relativePath, Buffer.from(data, 'base64'));
  return vscode.Uri.joinPath(paths.attachmentsRootUri, ATTACHMENT_OPENED_DIR, fileName);
}

async function externalizeContentAttachments(paths: StoragePaths, content: MessageContent, context: ExternalizeContext): Promise<MessageContent> {
  const parts: ContentPart[] = [];
  for (const part of content.parts) parts.push(await externalizePartAttachments(paths, part, context));
  return { ...content, parts };
}

async function externalizePartAttachments(paths: StoragePaths, part: ContentPart, context: ExternalizeContext): Promise<ContentPart> {
  if (isInlineDataPart(part)) return externalizeInlineDataPart(paths, part, context);
  if (isFunctionResponsePart(part)) return externalizeFunctionResponsePart(paths, part, context);
  return part;
}

async function externalizeFunctionResponsePart(paths: StoragePaths, part: FunctionResponsePart, context: ExternalizeContext): Promise<FunctionResponsePart> {
  const parts = part.functionResponse.parts;
  if (!parts?.length) return part;
  const nextParts: InlineDataPart[] = [];
  for (const inlinePart of parts) nextParts.push(await externalizeInlineDataPart(paths, inlinePart, context));
  return {
    ...part,
    functionResponse: {
      ...part.functionResponse,
      parts: nextParts
    }
  };
}

async function externalizeInlineDataPart(paths: StoragePaths, part: InlineDataPart, context: ExternalizeContext): Promise<InlineDataPart> {
  const data = part.inlineData.data;
  if (!data) return canonicalizeExistingAttachmentReference(part);
  const sanitized = canonicalAttachmentBase64(data);
  const rawBytes = Buffer.from(sanitized, 'base64').byteLength;

  if (rawBytes > context.maxStoredBytes) {
    if (part.inlineData.sourcePath) return localPathReference(part, rawBytes);
    throw new Error(`附件超过托管阈值 ${Math.floor(context.maxStoredBytes / 1024 / 1024)}MB，且没有可恢复的本地路径。`);
  }

  const cacheKey = `${part.inlineData.mimeType}\n${part.inlineData.name ?? ''}\n${sanitized}`;
  const cached = context.cache.get(cacheKey);
  const record = cached ?? await stageManagedAttachmentBlob(paths, {
    mimeType: part.inlineData.mimeType,
    data: sanitized,
    name: part.inlineData.name
  });
  context.cache.set(cacheKey, record);
  return managedAttachmentReference(record, { mimeType: part.inlineData.mimeType, name: part.inlineData.name });
}

function markContentAttachmentsForClient(content: MessageContent): MessageContent {
  return { ...content, parts: content.parts.map(markPartAttachmentsForClient) };
}

function markPartAttachmentsForClient(part: ContentPart): ContentPart {
  if (isInlineDataPart(part)) return markInlineDataPartForClient(part);
  if (isFunctionResponsePart(part) && part.functionResponse.parts?.length) {
    return {
      ...part,
      functionResponse: {
        ...part.functionResponse,
        parts: part.functionResponse.parts.map(markInlineDataPartForClient)
      }
    };
  }
  return part;
}

function markInlineDataPartForClient(part: InlineDataPart): InlineDataPart {
  const inlineData = part.inlineData;
  if (inlineData.data) return { inlineData: { ...inlineData, status: inlineData.status ?? 'available' } };
  if (inlineData.attachmentId) return { inlineData: { ...inlineData, storage: inlineData.storage ?? 'managed', status: inlineData.status ?? 'loading' } };
  if (inlineData.sourcePath) return { inlineData: { ...inlineData, storage: inlineData.storage ?? 'localPath', status: inlineData.status ?? 'available' } };
  return { inlineData: { ...inlineData, status: inlineData.status ?? 'missing' } };
}

function canonicalizeExistingAttachmentReference(part: InlineDataPart): InlineDataPart {
  const inlineData = part.inlineData;
  if (inlineData.attachmentId?.trim()) {
    const attachmentId = inlineData.attachmentId.trim();
    if (inlineData.storage !== 'managed' || !attachmentId.startsWith('attachment-')
      || typeof inlineData.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(inlineData.sha256)
      || !Number.isInteger(inlineData.sizeBytes) || inlineData.sizeBytes! < 0) {
      throw new Error(`托管附件引用不完整：${attachmentId}`);
    }
    return {
      inlineData: {
        mimeType: inlineData.mimeType,
        ...(inlineData.name ? { name: inlineData.name } : {}),
        attachmentId,
        sha256: inlineData.sha256,
        storage: 'managed',
        sizeBytes: inlineData.sizeBytes
      }
    };
  }
  if (inlineData.sourcePath?.trim()) return localPathReference(part, inlineData.sizeBytes);
  throw new Error(`附件 ${inlineData.name ?? inlineData.mimeType} 没有 canonical durable reference。`);
}

function managedAttachmentReference(record: AttachmentRecord, input?: { mimeType?: string; name?: string }): InlineDataPart {
  return {
    inlineData: {
      mimeType: input?.mimeType || record.mimeType,
      ...(input?.name ? { name: input.name } : record.name ? { name: record.name } : {}),
      attachmentId: record.id,
      sha256: record.sha256,
      storage: 'managed',
      sizeBytes: record.sizeBytes
    }
  };
}

function localPathReference(part: InlineDataPart, sizeBytes?: number): InlineDataPart {
  const inlineData = part.inlineData;
  return {
    inlineData: {
      mimeType: inlineData.mimeType,
      ...(inlineData.name ? { name: inlineData.name } : {}),
      sourcePath: inlineData.sourcePath!,
      storage: 'localPath',
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    }
  };
}

function hasInlineDataPart(content: MessageContent): boolean {
  return content.parts.some((part) => isInlineDataPart(part)
    || isFunctionResponsePart(part) && (part.functionResponse.parts?.length ?? 0) > 0);
}

export function assertCanonicalDurableMessageContentAttachments(content: MessageContent): void {
  const inspect = (part: InlineDataPart): void => {
    const value = part.inlineData;
    if (value.data) throw new Error('Durable MessageContent cannot contain embedded attachment bytes.');
    const managed = !!value.attachmentId && value.storage === 'managed'
      && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
      && Number.isInteger(value.sizeBytes) && value.sizeBytes! >= 0;
    const local = !!value.sourcePath && value.storage === 'localPath';
    if (!!value.attachmentId && !!value.sourcePath) throw new Error('Durable attachment cannot have both managed and local references.');
    if (!managed && !local) throw new Error(`附件 ${value.name ?? value.mimeType} 没有 canonical durable reference。`);
  };
  for (const part of content.parts) {
    if (isInlineDataPart(part)) inspect(part);
    else if (isFunctionResponsePart(part)) for (const nested of part.functionResponse.parts ?? []) inspect(nested);
  }
}

function unavailableInlineData(input: AttachmentReferenceInput, status: 'missing', error: string): InlineDataPart {
  return {
    inlineData: {
      mimeType: input.mimeType || 'application/octet-stream',
      ...(input.name ? { name: input.name } : {}),
      ...(input.attachmentId ? { attachmentId: input.attachmentId } : {}),
      ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
      storage: input.attachmentId ? 'managed' : input.sourcePath ? 'localPath' : undefined,
      status,
      error
    }
  };
}

function safeAttachmentFileName(id: string, name: string | undefined, mimeType: string): string {
  const baseName = name?.trim() || `attachment${extensionForMimeType(mimeType)}`;
  const safe = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || `attachment${extensionForMimeType(mimeType)}`;
  return `${id.replace(/[^a-zA-Z0-9_.-]+/g, '-')}-${safe}`;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    default: return '';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

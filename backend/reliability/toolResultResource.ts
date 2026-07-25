import { createHash } from 'node:crypto';
import type { ToolCallResultLinkRecord, ToolResultArtifactRecord } from '../../shared/protocol';
import type { DurableToolResultArtifactRecord } from './toolResultTypes';
import type { ConversationId } from '../../shared/stableIds';
import { isStableId } from '../../shared/stableIds';
import { canonicalJson } from './canonicalJson';
import {
  TOOL_MODEL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_INLINE_THRESHOLD_BYTES,
  TOOL_RESULT_PREVIEW_MAX_BYTES
} from './toolResultPayload';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableFileSystem } from './fileDurability';
import {
  conversationToolCallResultLinksRootRelativePath,
  conversationToolResultArtifactsRootRelativePath
} from './storagePathAuthority';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const verifiedBlobHashes = new WeakMap<DurableFileSystem, Set<string>>();

export interface CanonicalToolResultState {
  artifacts: DurableToolResultArtifactRecord[];
  links: ToolCallResultLinkRecord[];
}

const TOOL_RESULT_BLOB_ROOT = 'tool-result-blobs/sha256';

export function toolResultBlobRelativePath(hash: string): string {
  if (!SHA256_PATTERN.test(hash)) throw new Error(`Tool result blob hash is invalid: ${hash}`);
  return `${TOOL_RESULT_BLOB_ROOT}/${hash}.json`;
}

/**
 * Derives blob retention only from strict canonical Artifact/Link stores. Missing referenced blobs are
 * integrity failures; only physically present, unreferenced immutable blobs are sweep candidates.
 */
export async function discoverOrphanedToolResultBlobTargets(
  files: DurableFileSystem,
  conversationIds: readonly ConversationId[]
): Promise<string[]> {
  const referenced = new Set<string>();
  for (const conversationId of [...new Set(conversationIds)].sort()) {
    const state = await loadCanonicalToolResultState(files, conversationId);
    for (const artifact of state.artifacts) {
      if (artifact.storageKind !== 'blob') continue;
      const target = toolResultBlobRelativePath(artifact.blobHash!);
      // Do not trust the process-level immutable verification cache at a destructive GC boundary.
      await requireCanonicalToolResultContent(files, artifact);
      referenced.add(target);
    }
  }
  const orphaned: string[] = [];
  for (const target of await files.listFilesRecursive(TOOL_RESULT_BLOB_ROOT)) {
    if (!referenced.has(target)) orphaned.push(target);
  }
  return orphaned.sort();
}

/** Strict canonical ToolResult read. Blob bytes are verified once per immutable hash and process. */
export async function loadCanonicalToolResultState(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<CanonicalToolResultState> {
  const [artifacts, links] = await Promise.all([
    loadCanonicalRecordStore<DurableToolResultArtifactRecord>(files, {
      rootRelativePath: conversationToolResultArtifactsRootRelativePath(conversationId),
      recordKey: 'artifact',
      validateRecord: validateDurableToolResultArtifactRecord
    }),
    loadCanonicalRecordStore<ToolCallResultLinkRecord>(files, {
      rootRelativePath: conversationToolCallResultLinksRootRelativePath(conversationId),
      recordKey: 'link',
      validateRecord: validateToolCallResultLinkRecord
    })
  ]);
  for (const artifact of artifacts) await verifyToolResultArtifactContent(files, artifact);
  validateToolResultRelationshipClosure(conversationId, artifacts, links);
  return { artifacts, links };
}

/** Reads one full artifact and rejects missing, non-canonical, or hash-mismatched content. */
export async function requireCanonicalToolResultContent(
  files: DurableFileSystem,
  artifact: ToolResultArtifactRecord
): Promise<import('../../shared/conversationReliability').JsonValue> {
  validateToolResultArtifactMetadata(artifact);
  if (artifact.storageKind === 'inline') {
    await verifyToolResultArtifactContent(files, artifact);
    return cloneJson(artifact.inlineContent!);
  }
  const hash = artifact.blobHash!;
  const bytes = await files.read(toolResultBlobRelativePath(hash));
  if (!bytes) throw new Error(`Canonical ToolResult blob is missing: ${hash}`);
  verifyCanonicalBlobBytes(bytes, artifact);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as import('../../shared/conversationReliability').JsonValue;
}

export async function verifyToolResultArtifactContent(
  files: DurableFileSystem,
  artifact: ToolResultArtifactRecord
): Promise<void> {
  validateToolResultArtifactMetadata(artifact);
  if (artifact.storageKind === 'inline') {
    const canonical = canonicalJson(artifact.inlineContent);
    if (Buffer.byteLength(canonical, 'utf8') !== artifact.byteLength
      || createHash('sha256').update(canonical, 'utf8').digest('hex') !== artifact.contentHash) {
      throw new Error(`Inline ToolResult Artifact content is invalid: ${artifact.id}`);
    }
    return;
  }
  const hash = artifact.blobHash!;
  const verified = verifiedBlobHashes.get(files) ?? new Set<string>();
  if (verified.has(hash)) return;
  const bytes = await files.read(toolResultBlobRelativePath(hash));
  if (!bytes) throw new Error(`Canonical ToolResult blob is missing: ${hash}`);
  verifyCanonicalBlobBytes(bytes, artifact);
  verified.add(hash);
  verifiedBlobHashes.set(files, verified);
}

export function validateToolResultArtifactMetadata(record: ToolResultArtifactRecord): void {
  const inline = record.storageKind === 'inline';
  const blob = record.storageKind === 'blob';
  if (!isStableId(record.id, 'toolResultArtifact')
    || typeof record.conversationId !== 'string' || !record.conversationId
    || !SHA256_PATTERN.test(record.contentHash)
    || record.mediaType !== 'application/json'
    || !Number.isInteger(record.byteLength) || record.byteLength < 0
    || (!inline && !blob)
    || inline !== (record.inlineContent !== undefined)
    || blob !== (typeof record.blobHash === 'string')
    || blob && record.blobHash !== record.contentHash
    || typeof record.preview !== 'string' || Buffer.byteLength(record.preview, 'utf8') > TOOL_RESULT_PREVIEW_MAX_BYTES
    || inline && Buffer.byteLength(canonicalJson(record.inlineContent), 'utf8') > TOOL_RESULT_INLINE_THRESHOLD_BYTES
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0) {
    throw new Error(`Authoritative ToolResult Artifact is invalid: ${record.id}`);
  }
}

export function validateDurableToolResultArtifactRecord(record: DurableToolResultArtifactRecord): void {
  validateToolResultArtifactMetadata(record);
  if (Buffer.byteLength(canonicalJson(record.modelResponse), 'utf8') > TOOL_MODEL_RESPONSE_MAX_BYTES) {
    throw new Error(`Authoritative ToolResult Artifact model response is oversized: ${record.id}`);
  }
}

export function validateToolResultRelationshipClosure(
  conversationId: ConversationId,
  artifacts: readonly DurableToolResultArtifactRecord[],
  links: readonly ToolCallResultLinkRecord[]
): void {
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const referenced = new Set<string>();
  const finalCounts = new Map<string, number>();
  for (const artifact of artifacts) {
    if (artifact.conversationId !== conversationId) {
      throw new Error(`ToolResult Artifact escaped its conversation: ${artifact.id}`);
    }
  }
  for (const link of links) {
    if (link.conversationId !== conversationId) {
      throw new Error(`ToolCallResultLink escaped its conversation: ${link.id}`);
    }
    const artifact = artifactsById.get(link.artifactId);
    if (!artifact) throw new Error(`ToolCallResultLink points to a missing Artifact: ${link.id}`);
    referenced.add(artifact.id);
    if (link.role === 'final') {
      const count = (finalCounts.get(link.toolCallId) ?? 0) + 1;
      finalCounts.set(link.toolCallId, count);
      if (count > 1) throw new Error(`ToolCall has multiple final result links: ${link.toolCallId}`);
    }
  }
  for (const artifact of artifacts) {
    if (!referenced.has(artifact.id)) throw new Error(`ToolResult Artifact has no canonical Link owner: ${artifact.id}`);
  }
}

export function validateToolCallResultLinkRecord(record: ToolCallResultLinkRecord): void {
  if (typeof record.id !== 'string' || !record.id
    || typeof record.conversationId !== 'string' || !record.conversationId
    || typeof record.toolCallId !== 'string' || !record.toolCallId
    || typeof record.artifactId !== 'string' || !record.artifactId
    || (record.role !== 'final' && record.role !== 'partial' && record.role !== 'audit')
    || typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) || record.createdAt < 0
    || typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) {
    throw new Error(`Authoritative ToolCallResultLink is invalid: ${record.id}`);
  }
}

function verifyCanonicalBlobBytes(bytes: Uint8Array, artifact: ToolResultArtifactRecord): void {
  if (bytes.byteLength !== artifact.byteLength) {
    throw new Error(`Canonical ToolResult blob byte length differs from Artifact ${artifact.id}.`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== artifact.contentHash || artifact.blobHash !== hash) {
    throw new Error(`Canonical ToolResult blob hash differs from Artifact ${artifact.id}.`);
  }
  const text = Buffer.from(bytes).toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`Canonical ToolResult blob is not JSON: ${artifact.id}`); }
  if (canonicalJson(parsed) !== text) {
    throw new Error(`Canonical ToolResult blob bytes are not canonical JSON: ${artifact.id}`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

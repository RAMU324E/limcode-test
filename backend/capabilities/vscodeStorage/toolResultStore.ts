import { createHash } from 'node:crypto';
import type { JsonValue } from '../../../shared/conversationReliability';
import type { StagedToolResultContent, ToolResultArtifactRecord } from '../../../shared/protocol';
import { canonicalJson } from '../../reliability/canonicalJson';
import { DurableFileSystem } from '../../reliability/fileDurability';
import { StoragePathAuthorityRegistry } from '../../reliability/storagePathAuthority';
import {
  prepareToolResultContent,
  type PreparedToolResultContent
} from '../../reliability/toolResultPayload';
import {
  requireCanonicalToolResultContent,
  toolResultBlobRelativePath
} from '../../reliability/toolResultResource';
import type { StoragePaths } from './paths';


/**
 * Canonicalizes once and durably stages a large immutable blob before any Artifact/Link transaction.
 * Small results remain inline in the Artifact record and perform no blob I/O.
 */
export async function stageToolResultContent(
  paths: StoragePaths,
  content: JsonValue
): Promise<StagedToolResultContent> {
  return stagePreparedToolResultContent(paths, prepareToolResultContent(content));
}

export async function stagePreparedToolResultContent(
  paths: StoragePaths,
  prepared: PreparedToolResultContent
): Promise<StagedToolResultContent> {
  const bytes = Buffer.from(prepared.canonicalBytes);
  const canonical = bytes.toString('utf8');
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== prepared.staged.byteLength
    || contentHash !== prepared.staged.contentHash
    || canonicalJson(JSON.parse(canonical)) !== canonical) {
    throw new Error(`Prepared ToolResult content is corrupt: ${prepared.staged.contentHash}`);
  }
  if (prepared.staged.storageKind === 'inline') {
    if (canonicalJson(prepared.staged.inlineContent) !== canonical) {
      throw new Error(`Prepared inline ToolResult differs from canonical bytes: ${contentHash}`);
    }
    return cloneJson(prepared.staged);
  }
  if (prepared.staged.blobHash !== contentHash) throw new Error(`Prepared ToolResult blob hash is invalid: ${contentHash}`);

  const relativePath = toolResultBlobRelativePath(contentHash);
  new StoragePathAuthorityRegistry().assertLiveWriteAllowed(relativePath, 'immutable-content-writer');
  const files = new DurableFileSystem(paths.globalStoragePath);
  try {
    await files.atomicWrite(relativePath, bytes, { createOnly: true });
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
  }
  const stored = await files.read(relativePath);
  if (!stored || stored.byteLength !== bytes.byteLength
    || createHash('sha256').update(stored).digest('hex') !== contentHash
    || Buffer.from(stored).toString('utf8') !== canonical) {
    throw new Error(`Immutable ToolResult blob is invalid: ${contentHash}`);
  }
  return cloneJson(prepared.staged);
}

export async function loadToolResultContent(
  paths: StoragePaths,
  artifact: ToolResultArtifactRecord
): Promise<JsonValue> {
  const files = new DurableFileSystem(paths.globalStoragePath);
  return requireCanonicalToolResultContent(files, artifact);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

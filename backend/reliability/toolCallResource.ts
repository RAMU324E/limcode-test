import type { ToolCallRecord } from '../../shared/protocol';
import type { ConversationId } from '../../shared/stableIds';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableFileSystem } from './fileDurability';
import { conversationToolCallsRootRelativePath } from './storagePathAuthority';

/** Strict canonical ToolCall read; message/run ownership is validated after all fact domains merge. */
export function loadCanonicalToolCalls(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<ToolCallRecord[]> {
  return loadCanonicalRecordStore<ToolCallRecord>(files, {
    rootRelativePath: conversationToolCallsRootRelativePath(conversationId),
    recordKey: 'toolCall'
  });
}

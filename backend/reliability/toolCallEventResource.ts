import type { ToolCallEventRecord } from '../../shared/protocol';
import type { ConversationId } from '../../shared/stableIds';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableFileSystem } from './fileDurability';
import { conversationToolCallEventsRootRelativePath } from './storagePathAuthority';

/** Strict canonical durable ToolCallEvent read; transient progress never enters this store. */
export function loadCanonicalToolCallEvents(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<ToolCallEventRecord[]> {
  return loadCanonicalRecordStore<ToolCallEventRecord>(files, {
    rootRelativePath: conversationToolCallEventsRootRelativePath(conversationId),
    recordKey: 'toolCallEvent'
  });
}

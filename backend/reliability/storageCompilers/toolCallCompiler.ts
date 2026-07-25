import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { conversationToolCallsRootRelativePath } from '../storagePathAuthority';
import { compileRecordStore } from './recordStoreCompiler';

/** One touched ToolCall produces at most its own record postimage; existing updates never rewrite index. */
export async function compileToolCallPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const touchedIds = touchedIdsForFamily(input.mutations, 'toolCalls');
  if (touchedIds.size === 0) return [];
  return (await compileRecordStore({
    files: input.files,
    rootRelativePath: conversationToolCallsRootRelativePath(input.conversationId),
    recordKey: 'toolCall',
    currentRecords: input.current.toolCalls,
    nextRecords: input.next.toolCalls,
    touchedIds,
    now: input.now,
    labelForRecord: (record) => record.name || record.id
  })).postimages;
}

function touchedIdsForFamily(mutations: readonly RecordMutation[], family: string): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.family !== family) continue;
    if (mutation.kind === 'remove_many') {
      for (const id of mutation.ids) ids.add(id);
    } else {
      ids.add(mutation.id);
    }
  }
  return ids;
}

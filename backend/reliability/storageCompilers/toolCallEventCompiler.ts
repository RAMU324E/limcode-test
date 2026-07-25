import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { conversationToolCallEventsRootRelativePath } from '../storagePathAuthority';
import { compileRecordStore } from './recordStoreCompiler';

/** Durable audit events are independent records and never rewrite timeline or sibling ToolCalls. */
export async function compileToolCallEventPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const touchedIds = touchedIdsForFamily(input.mutations, 'toolCallEvents');
  if (touchedIds.size === 0) return [];
  return (await compileRecordStore({
    files: input.files,
    rootRelativePath: conversationToolCallEventsRootRelativePath(input.conversationId),
    recordKey: 'toolCallEvent',
    currentRecords: input.current.toolCallEvents,
    nextRecords: input.next.toolCallEvents,
    touchedIds,
    now: input.now,
    labelForRecord: (record) => `${record.kind}-${record.toolCallId}-${record.seq}`
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

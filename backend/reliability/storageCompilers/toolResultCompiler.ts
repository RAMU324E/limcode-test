import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import {
  conversationToolCallResultLinksRootRelativePath,
  conversationToolResultArtifactsRootRelativePath
} from '../storagePathAuthority';
import { validateToolResultRelationshipClosure, verifyToolResultArtifactContent } from '../toolResultResource';
import { compileRecordStore } from './recordStoreCompiler';

/** Artifact and Link records share one ToolResult Storage HEAD but retain independent indexes. */
export async function compileToolResultPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const artifactIds = touchedIdsForFamily(input.mutations, 'toolResultArtifacts');
  const linkIds = touchedIdsForFamily(input.mutations, 'toolCallResultLinks');
  if (artifactIds.size === 0 && linkIds.size === 0) return [];

  validateToolResultRelationshipClosure(
    input.conversationId,
    input.next.toolResultArtifacts,
    input.next.toolCallResultLinks
  );
  for (const artifact of input.next.toolResultArtifacts) {
    if (artifactIds.has(artifact.id)) await verifyToolResultArtifactContent(input.files, artifact);
  }

  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  if (artifactIds.size > 0) {
    postimages.push(...(await compileRecordStore({
      files: input.files,
      rootRelativePath: conversationToolResultArtifactsRootRelativePath(input.conversationId),
      recordKey: 'artifact',
      currentRecords: input.current.toolResultArtifacts,
      nextRecords: input.next.toolResultArtifacts,
      touchedIds: artifactIds,
      now: input.now,
      labelForRecord: (record) => record.contentHash.slice(0, 12)
    })).postimages);
  }
  if (linkIds.size > 0) {
    postimages.push(...(await compileRecordStore({
      files: input.files,
      rootRelativePath: conversationToolCallResultLinksRootRelativePath(input.conversationId),
      recordKey: 'link',
      currentRecords: input.current.toolCallResultLinks,
      nextRecords: input.next.toolCallResultLinks,
      touchedIds: linkIds,
      now: input.now,
      labelForRecord: (record) => `${record.role}-${record.toolCallId}`
    })).postimages);
  }
  return postimages;
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

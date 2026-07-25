import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import {
  conversationControlFamilyRootRelativePath,
  conversationInteractionsRootRelativePath
} from '../storagePathAuthority';
import { compileRecordStore } from './recordStoreCompiler';

type CanonicalRecord = { id: string };

interface InteractionFamilySpec {
  family: 'interactionRequests' | 'interactionOwnerLinks' | 'interactionResponses';
  root(conversationId: ConversationId): string;
  recordKey: string;
  records(facts: DurableConversationFacts): readonly CanonicalRecord[];
  label(record: CanonicalRecord): string;
}

const INTERACTION_FAMILY_SPECS: readonly InteractionFamilySpec[] = [
  {
    family: 'interactionRequests',
    root: conversationInteractionsRootRelativePath,
    recordKey: 'interactionRequest',
    records: (facts) => facts.interactionRequests,
    label: (record) => record.id
  },
  {
    family: 'interactionOwnerLinks',
    root: (conversationId) => conversationControlFamilyRootRelativePath('interaction-owner-links', conversationId),
    recordKey: 'link',
    records: (facts) => facts.interactionOwnerLinks,
    label: (record) => record.id
  },
  {
    family: 'interactionResponses',
    root: (conversationId) => conversationControlFamilyRootRelativePath('interaction-responses', conversationId),
    recordKey: 'interactionResponse',
    records: (facts) => facts.interactionResponses,
    label: (record) => record.id
  }
];

/** Interaction requests, ownership links and responses are independent canonical record stores. */
export async function compileInteractionPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  for (const spec of INTERACTION_FAMILY_SPECS) {
    const touchedIds = touchedIdsForFamily(input.mutations, spec.family);
    if (touchedIds.size === 0) continue;
    const compiled = await compileRecordStore({
      files: input.files,
      rootRelativePath: spec.root(input.conversationId),
      recordKey: spec.recordKey,
      currentRecords: spec.records(input.current),
      nextRecords: spec.records(input.next),
      touchedIds,
      now: input.now,
      labelForRecord: spec.label
    });
    postimages.push(...compiled.postimages);
  }
  return postimages.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
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

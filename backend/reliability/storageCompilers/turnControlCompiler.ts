import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { conversationControlFamilyRootRelativePath } from '../storagePathAuthority';
import { compileRecordStore } from './recordStoreCompiler';

type CanonicalRecord = { id: string };

interface TurnControlFamilySpec {
  family: keyof DurableConversationFacts;
  root: string;
  recordKey: string;
  records(facts: DurableConversationFacts): readonly CanonicalRecord[];
  label(record: CanonicalRecord): string;
}

const TURN_CONTROL_FAMILY_SPECS: readonly TurnControlFamilySpec[] = [
  { family: 'turns', root: 'turns', recordKey: 'turn', records: (facts) => facts.turns, label: (record) => record.id },
  { family: 'childTurnLinks', root: 'child-turn-links', recordKey: 'link', records: (facts) => facts.childTurnLinks, label: (record) => record.id },
  { family: 'messageTurnLinks', root: 'message-turn-links', recordKey: 'link', records: (facts) => facts.messageTurnLinks, label: (record) => record.id },
  { family: 'turnIntents', root: 'turn-intents', recordKey: 'turnIntent', records: (facts) => facts.turnIntents, label: (record) => record.id },
  { family: 'turnIntentRevisions', root: 'turn-intent-revisions', recordKey: 'revision', records: (facts) => facts.turnIntentRevisions, label: (record) => record.id },
  { family: 'turnExecutionPresetRevisions', root: 'turn-execution-preset-revisions', recordKey: 'presetRevision', records: (facts) => facts.turnExecutionPresetRevisions, label: (record) => record.id },
  { family: 'pendingTurnInputs', root: 'pending-turn-inputs', recordKey: 'pendingInput', records: (facts) => facts.pendingTurnInputs, label: (record) => record.id },
  { family: 'executionLeases', root: 'execution-leases', recordKey: 'lease', records: (facts) => facts.executionLeases, label: (record) => record.id },
  { family: 'authoritySnapshots', root: 'authority-snapshots', recordKey: 'authoritySnapshot', records: (facts) => facts.authoritySnapshots, label: (record) => record.id },
  { family: 'authorityDerivationLinks', root: 'authority-derivation-links', recordKey: 'link', records: (facts) => facts.authorityDerivationLinks, label: (record) => record.id },
  { family: 'runtimeInboxItems', root: 'runtime-inbox-items', recordKey: 'inboxItem', records: (facts) => facts.runtimeInboxItems, label: (record) => record.id },
  { family: 'runtimeDeliveryLinks', root: 'runtime-delivery-links', recordKey: 'link', records: (facts) => facts.runtimeDeliveryLinks, label: (record) => record.id }
];

/** Compiles each Turn control fact into its own record/index store and exact Storage HEAD domain. */
export async function compileTurnControlPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  for (const spec of TURN_CONTROL_FAMILY_SPECS) {
    const touchedIds = touchedIdsForFamily(input.mutations, spec.family);
    if (touchedIds.size === 0) continue;
    const compiled = await compileRecordStore({
      files: input.files,
      rootRelativePath: conversationControlFamilyRootRelativePath(spec.root, input.conversationId),
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

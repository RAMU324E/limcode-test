import type {
  AuthorityDerivationLinkRecord,
  AuthoritySnapshotRecord,
  ChildTurnLinkRecord,
  ExecutionLeaseRecord,
  MessageTurnLinkRecord,
  PendingTurnInputRecord,
  RuntimeDeliveryLinkRecord,
  RuntimeInboxItemRecord,
  TurnExecutionPresetRevisionRecord,
  TurnIntentRecord,
  TurnIntentRevisionRecord,
  TurnRecord
} from '../../shared/conversationReliability';
import type { ConversationId } from '../../shared/stableIds';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableConversationFacts } from './domain/types';
import type { DurableFileSystem } from './fileDurability';
import { conversationControlFamilyRootRelativePath } from './storagePathAuthority';

export type CanonicalTurnControlState = Pick<DurableConversationFacts,
  | 'turns'
  | 'turnIntents'
  | 'turnIntentRevisions'
  | 'turnExecutionPresetRevisions'
  | 'pendingTurnInputs'
  | 'executionLeases'
  | 'authoritySnapshots'
  | 'authorityDerivationLinks'
  | 'runtimeInboxItems'
  | 'runtimeDeliveryLinks'
  | 'childTurnLinks'
  | 'messageTurnLinks'
>;

/** Strict canonical read of every independent Turn control record store. */
export async function loadCanonicalTurnControlState(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<CanonicalTurnControlState> {
  const [
    turns,
    turnIntents,
    turnIntentRevisions,
    turnExecutionPresetRevisions,
    pendingTurnInputs,
    executionLeases,
    authoritySnapshots,
    authorityDerivationLinks,
    runtimeInboxItems,
    runtimeDeliveryLinks,
    childTurnLinks,
    messageTurnLinks
  ] = await Promise.all([
    load<TurnRecord>(files, conversationId, 'turns', 'turn'),
    load<TurnIntentRecord>(files, conversationId, 'turn-intents', 'turnIntent'),
    load<TurnIntentRevisionRecord>(files, conversationId, 'turn-intent-revisions', 'revision'),
    load<TurnExecutionPresetRevisionRecord>(files, conversationId, 'turn-execution-preset-revisions', 'presetRevision'),
    load<PendingTurnInputRecord>(files, conversationId, 'pending-turn-inputs', 'pendingInput'),
    load<ExecutionLeaseRecord>(files, conversationId, 'execution-leases', 'lease'),
    load<AuthoritySnapshotRecord>(files, conversationId, 'authority-snapshots', 'authoritySnapshot'),
    load<AuthorityDerivationLinkRecord>(files, conversationId, 'authority-derivation-links', 'link'),
    load<RuntimeInboxItemRecord>(files, conversationId, 'runtime-inbox-items', 'inboxItem'),
    load<RuntimeDeliveryLinkRecord>(files, conversationId, 'runtime-delivery-links', 'link'),
    load<ChildTurnLinkRecord>(files, conversationId, 'child-turn-links', 'link'),
    load<MessageTurnLinkRecord>(files, conversationId, 'message-turn-links', 'link')
  ]);

  return {
    turns,
    turnIntents,
    turnIntentRevisions,
    turnExecutionPresetRevisions,
    pendingTurnInputs,
    executionLeases,
    authoritySnapshots,
    authorityDerivationLinks,
    runtimeInboxItems,
    runtimeDeliveryLinks,
    childTurnLinks,
    messageTurnLinks
  };
}

function load<TRecord extends { id: string }>(
  files: DurableFileSystem,
  conversationId: ConversationId,
  root: string,
  recordKey: string
): Promise<TRecord[]> {
  return loadCanonicalRecordStore<TRecord>(files, {
    rootRelativePath: conversationControlFamilyRootRelativePath(root, conversationId),
    recordKey
  });
}

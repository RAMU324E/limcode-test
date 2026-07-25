import type {
  DurableInteractionRequestRecord,
  InteractionOwnerLinkRecord,
  InteractionResponseRecord
} from '../../shared/conversationReliability';
import type { ConversationId } from '../../shared/stableIds';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableFileSystem } from './fileDurability';
import {
  conversationControlFamilyRootRelativePath,
  conversationInteractionsRootRelativePath
} from './storagePathAuthority';

export interface CanonicalInteractionState {
  interactionRequests: DurableInteractionRequestRecord[];
  interactionOwnerLinks: InteractionOwnerLinkRecord[];
  interactionResponses: InteractionResponseRecord[];
}

/** Strict canonical Interaction read; graph ownership is validated after every fact domain merges. */
export async function loadCanonicalInteractionState(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<CanonicalInteractionState> {
  const [interactionRequests, interactionOwnerLinks, interactionResponses] = await Promise.all([
    loadCanonicalRecordStore<DurableInteractionRequestRecord>(files, {
      rootRelativePath: conversationInteractionsRootRelativePath(conversationId),
      recordKey: 'interactionRequest'
    }),
    loadCanonicalRecordStore<InteractionOwnerLinkRecord>(files, {
      rootRelativePath: conversationControlFamilyRootRelativePath('interaction-owner-links', conversationId),
      recordKey: 'link'
    }),
    loadCanonicalRecordStore<InteractionResponseRecord>(files, {
      rootRelativePath: conversationControlFamilyRootRelativePath('interaction-responses', conversationId),
      recordKey: 'interactionResponse'
    })
  ]);
  return { interactionRequests, interactionOwnerLinks, interactionResponses };
}

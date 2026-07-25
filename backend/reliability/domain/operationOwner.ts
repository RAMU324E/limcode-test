import type { DurableOperationOwner } from '../../../shared/conversationReliability';
import type { RunId } from '../../../shared/stableIds';

export function isConversationOperationOwner(owner: DurableOperationOwner): owner is Extract<DurableOperationOwner, { ownerKind: 'conversation' }> {
  return owner.ownerKind === 'conversation';
}

export function requireRunOperationOwner(owner: DurableOperationOwner): RunId {
  if (isConversationOperationOwner(owner) || !owner.ownerRunId) {
    throw new Error('Operation is owned by the conversation aggregate, not a Run.');
  }
  return owner.ownerRunId;
}

export function copyOperationOwner(owner: DurableOperationOwner): DurableOperationOwner {
  return isConversationOperationOwner(owner)
    ? { ownerKind: 'conversation' }
    : { ...(owner.ownerKind ? { ownerKind: owner.ownerKind } : {}), ownerRunId: owner.ownerRunId };
}

export function sameOperationOwner(left: DurableOperationOwner, right: DurableOperationOwner): boolean {
  if (isConversationOperationOwner(left) || isConversationOperationOwner(right)) {
    return isConversationOperationOwner(left) && isConversationOperationOwner(right);
  }
  return left.ownerRunId === right.ownerRunId;
}

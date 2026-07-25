import type {
  DurableInteractionRequestKind,
  DurableInteractionRequestRecord,
  InteractionOwnerLinkRecord
} from '@shared/conversationReliability';

export interface InteractionProjectionState {
  interactionRequests: readonly DurableInteractionRequestRecord[];
  interactionOwnerLinks: readonly InteractionOwnerLinkRecord[];
}

export interface InteractionView {
  request: DurableInteractionRequestRecord;
  owner: InteractionOwnerLinkRecord;
}

export function interactionForTool(
  state: InteractionProjectionState,
  toolCallId: string | undefined,
  kind?: DurableInteractionRequestKind
): InteractionView | undefined {
  if (!toolCallId) return undefined;
  const requestById = new Map(state.interactionRequests.map((request) => [request.id, request]));
  const matches = state.interactionOwnerLinks.flatMap((owner) => {
    if (owner.sourceToolCallId !== toolCallId) return [];
    const request = requestById.get(owner.interactionRequestId);
    if (!request || (kind && request.kind !== kind)) return [];
    return [{ request, owner }];
  });
  return matches.sort((left, right) =>
    right.request.revision - left.request.revision
    || right.request.updatedAt - left.request.updatedAt
    || right.request.id.localeCompare(left.request.id))[0];
}

export function pendingInteractionsForConversation(
  state: InteractionProjectionState,
  conversationId: string,
  kind?: DurableInteractionRequestKind
): InteractionView[] {
  if (!conversationId) return [];
  const requestById = new Map(state.interactionRequests.map((request) => [request.id, request]));
  return state.interactionOwnerLinks.flatMap((owner) => {
    if (owner.conversationId !== conversationId) return [];
    const request = requestById.get(owner.interactionRequestId);
    if (!request || request.state !== 'pending' || (kind && request.kind !== kind)) return [];
    return [{ request, owner }];
  }).sort((left, right) =>
    left.request.createdAt - right.request.createdAt
    || left.request.id.localeCompare(right.request.id));
}

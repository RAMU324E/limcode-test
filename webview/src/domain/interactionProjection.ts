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

export interface ReliableInteractionFact {
  id: string;
  kind: string;
  status: string;
  turnId?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 把可靠 Runtime 的独立 Interaction/Owner/ToolCall Link 投影为旧通用交互组件需要的只读视图。
 * revision 固定为 1：当前可靠 InteractionRequest schema 是一次性、first-response-wins 记录，
 * 不存在可由客户端递增的 revision；后端仍会按 request/owner 身份重新校验。
 */
export function interactionViewFromReliableRuntime(input: {
  interaction: ReliableInteractionFact;
  conversationId: string;
  toolCallId: string;
  expectedKind?: DurableInteractionRequestKind;
}): InteractionView | undefined {
  const { interaction, conversationId, toolCallId } = input;
  const kind = reliableInteractionKind(interaction.kind);
  const turnId = interaction.turnId?.trim();
  if (!kind || !turnId || !conversationId.trim() || !toolCallId.trim()) return undefined;
  if (input.expectedKind && kind !== input.expectedKind) return undefined;
  return {
    request: {
      id: interaction.id,
      revision: 1,
      kind,
      state: reliableInteractionState(interaction.status),
      choices: kind === 'ask_user'
        ? ['submit', 'cancel']
        : kind === 'plan_review'
          ? ['accept', 'submit', 'reject', 'cancel']
          : ['accept', 'reject'],
      payload: {},
      payloadDigest: interaction.id,
      policySnapshot: { mode: 'manual', policyVersion: 'reliable-runtime' },
      createdAt: interaction.createdAt,
      updatedAt: interaction.updatedAt
    },
    owner: {
      id: `reliable-owner:${interaction.id}`,
      interactionRequestId: interaction.id,
      turnId,
      conversationId,
      sourceToolCallId: toolCallId,
      createdAt: interaction.createdAt
    }
  } as InteractionView;
}

function reliableInteractionKind(value: string): DurableInteractionRequestKind | undefined {
  if (value === 'file_change_approval') return 'patch_approval';
  if (
    value === 'exec_approval'
    || value === 'patch_approval'
    || value === 'result_review'
    || value === 'permission_request'
    || value === 'ask_user'
    || value === 'plan_review'
  ) return value;
  return undefined;
}

function reliableInteractionState(value: string): InteractionView['request']['state'] {
  if (value === 'pending') return 'pending';
  if (value === 'expired') return 'expired';
  if (value === 'cancelled' || value === 'rejected') return 'cancelled';
  return 'resolved';
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

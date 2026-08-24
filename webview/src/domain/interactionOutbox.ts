export type InteractionOutboxDecision = 'accept' | 'submit' | 'reject' | 'cancel';

export interface ExistingInteractionResolutionLike {
  interactionRevision: number;
  ownerTurnId: string;
  conversationId: string;
  decision: InteractionOutboxDecision;
  response: unknown;
}

export interface InteractionResolutionDecisionInput {
  requestState: string;
  choices: readonly string[];
  existing?: ExistingInteractionResolutionLike;
  existingSubmitting?: boolean;
  interactionRevision: number;
  ownerTurnId: string;
  conversationId: string;
  decision: InteractionOutboxDecision;
  response: unknown;
}

export type InteractionResolutionDecision =
  | { kind: 'create' }
  | { kind: 'replay' }
  | { kind: 'supersede' }
  | { kind: 'blocked'; message: string }
  | { kind: 'rejected'; message: string };

/**
 * Pure admission rule for the Webview Interaction outbox.
 *
 * Durable first-response-wins remains server authority. Supersede only retires a local retry record;
 * it never claims to replace a response which may already have committed.
 */
export function decideInteractionResolution(
  input: InteractionResolutionDecisionInput
): InteractionResolutionDecision {
  if (input.requestState !== 'pending') {
    return { kind: 'rejected', message: '该交互请求已结束，请等待服务端状态同步。' };
  }
  if (!input.choices.includes(input.decision)) {
    return { kind: 'rejected', message: '当前交互不允许这个决定。' };
  }
  const existing = input.existing;
  if (!existing) return { kind: 'create' };

  const same = existing.interactionRevision === input.interactionRevision
    && existing.ownerTurnId === input.ownerTurnId
    && existing.conversationId === input.conversationId
    && existing.decision === input.decision
    && samePlainJson(existing.response, input.response);
  if (same) return { kind: 'replay' };
  if (input.existingSubmitting) {
    return {
      kind: 'blocked',
      message: '原审批决定正在提交，请等待确认或超时后再更改。'
    };
  }
  return { kind: 'supersede' };
}

function samePlainJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => samePlainJson(value, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && samePlainJson(leftRecord[key], rightRecord[key])
    );
}

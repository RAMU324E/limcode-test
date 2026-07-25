import type {
  DurableInteractionDecision,
  DurableInteractionRequestKind,
  DurableInteractionRequestRecord,
  InteractionOwnerLinkRecord,
  JsonValue
} from '../../../shared/conversationReliability';
import type {
  ConversationId,
  InteractionRequestId,
  RunId,
  ToolCallId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import type { DurableConversationFacts } from './types';
import { asJson } from './transitionBuilder';

const CHOICES_BY_KIND: Readonly<Record<DurableInteractionRequestKind, readonly DurableInteractionDecision[]>> = {
  ask_user: ['submit', 'cancel'],
  plan_review: ['accept', 'submit', 'reject', 'cancel'],
  exec_approval: ['accept', 'reject', 'cancel'],
  patch_approval: ['accept', 'reject'],
  permission_request: ['accept', 'reject', 'cancel'],
  result_review: ['accept', 'reject']
};

export function interactionRequestIdForTool(
  kind: DurableInteractionRequestKind,
  toolCallId: ToolCallId
): InteractionRequestId {
  return stableIdFromSeed('interactionRequest', `tool-interaction:${kind}:${toolCallId}`);
}

export function interactionOwnerLinkId(interactionRequestId: InteractionRequestId): string {
  return stableIdFromSeed('relation', `interaction-owner:${interactionRequestId}`);
}

export function manualInteractionRequest(input: {
  id: InteractionRequestId;
  kind: DurableInteractionRequestKind;
  subject: JsonValue;
  subjectRef?: string;
  subjectDigest?: string;
  now: number;
}): DurableInteractionRequestRecord {
  const payloadDigest = canonicalSha256(input.subject);
  return {
    id: input.id,
    revision: 1,
    kind: input.kind,
    state: 'pending',
    choices: [...CHOICES_BY_KIND[input.kind]],
    payload: clone(input.subject),
    payloadDigest,
    ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
    ...(input.subjectDigest ? { subjectDigest: input.subjectDigest } : {}),
    policySnapshot: {
      mode: 'manual',
      policyVersion: canonicalSha256(asJson({
        kind: input.kind,
        mode: 'manual',
        choices: CHOICES_BY_KIND[input.kind]
      }))
    },
    createdAt: input.now,
    updatedAt: input.now
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function interactionOwnerLink(input: {
  interactionRequestId: InteractionRequestId;
  turnId: RunId;
  conversationId: ConversationId;
  sourceToolCallId?: ToolCallId;
  now: number;
}): InteractionOwnerLinkRecord {
  return {
    id: interactionOwnerLinkId(input.interactionRequestId),
    interactionRequestId: input.interactionRequestId,
    turnId: input.turnId,
    conversationId: input.conversationId,
    ...(input.sourceToolCallId ? { sourceToolCallId: input.sourceToolCallId } : {}),
    createdAt: input.now
  };
}

export function uniqueInteractionOwner(
  facts: Pick<DurableConversationFacts, 'interactionOwnerLinks'>,
  interactionRequestId: InteractionRequestId
): InteractionOwnerLinkRecord | undefined {
  const owners = facts.interactionOwnerLinks.filter((candidate) => candidate.interactionRequestId === interactionRequestId);
  if (owners.length > 1) throw new Error(`InteractionRequest ${interactionRequestId} has ambiguous ownership.`);
  return owners[0];
}

export function interactionRequestForTool(
  facts: Pick<DurableConversationFacts, 'interactionRequests' | 'interactionOwnerLinks'>,
  toolCallId: ToolCallId,
  kind?: DurableInteractionRequestKind,
  state: DurableInteractionRequestRecord['state'] = 'pending'
): { request: DurableInteractionRequestRecord; owner: InteractionOwnerLinkRecord } | undefined {
  const owners = facts.interactionOwnerLinks.filter((candidate) => candidate.sourceToolCallId === toolCallId);
  const matches = owners.flatMap((owner) => {
    const request = facts.interactionRequests.find((candidate) => candidate.id === owner.interactionRequestId);
    return request && request.state === state && (kind === undefined || request.kind === kind)
      ? [{ request, owner }]
      : [];
  });
  if (matches.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple matching InteractionRequests.`);
  return matches[0];
}

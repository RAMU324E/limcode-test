import type { DurableInteractionActor, DurableInteractionDecision, DurableInteractionRequestRecord, JsonValue } from '../../shared/conversationReliability';
import type { StorageCapability } from '../capabilities/types';
import type { DurableConversationFacts } from './domain/types';
import type { ConversationId, InteractionRequestId, ToolCallId } from '../../shared/stableIds';
import type { ApplyToolChangePayload } from './domain/toolControlHandlers';
import { stableIdFromSeed } from './stableIdFactory';

export function isAutomaticFileChangeInteractionDue(
  request: DurableInteractionRequestRecord,
  now: number
): boolean {
  return request.kind === 'patch_approval'
    && request.state === 'pending'
    && request.policySnapshot.autoDecision === 'accept'
    && (request.policySnapshot.mode === 'auto_at' || request.policySnapshot.mode === 'auto_immediate')
    && request.policySnapshot.notBeforeAt !== undefined
    && request.policySnapshot.notBeforeAt <= now;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Every actor resolving one Interaction revision derives the same side-effect/continuation identities.
 * Transport message IDs remain source-claim keys only and can never create a second business effect.
 */
export async function hydrateFileChangeResolutionPayload(
  payload: ApplyToolChangePayload,
  facts: DurableConversationFacts,
  storage: Pick<StorageCapability, 'loadToolResultContent'>
): Promise<ApplyToolChangePayload> {
  if (payload.decision !== 'accept') return payload;
  const request = facts.interactionRequests.find((candidate) => candidate.id === payload.interactionRequestId
    && candidate.revision === payload.interactionRevision);
  const owner = facts.interactionOwnerLinks.find((candidate) => candidate.interactionRequestId === payload.interactionRequestId);
  // A late response must still reach the resolver and converge to already_resolved without loading data.
  if (!request || request.state !== 'pending') return payload;
  if (!owner || owner.sourceToolCallId !== payload.toolCallId) {
    throw new Error(`InteractionRequest ${request.id} has no matching ToolCall owner link.`);
  }
  const artifact = request.subjectRef
    ? facts.toolResultArtifacts.find((candidate) => candidate.id === request.subjectRef)
    : undefined;
  if (!artifact || artifact.contentHash !== request.subjectDigest) {
    throw new Error(`InteractionRequest ${request.id} has no hash-bound proposal Artifact.`);
  }
  const proposal = await storage.loadToolResultContent(artifact);
  return {
    ...payload,
    proposalArtifactId: artifact.id,
    proposalContentHash: artifact.contentHash,
    proposal: cloneJson(proposal)
  };
}

export function fileChangeResolutionPayload(input: {
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  interactionRequestId: InteractionRequestId;
  interactionRevision: number;
  decision: Extract<DurableInteractionDecision, 'accept' | 'reject'>;
  actor: Extract<DurableInteractionActor, 'user' | 'policy'>;
  actorId?: string;
  commandId: string;
  reason?: string;
  completedAt: number;
}): ApplyToolChangePayload {
  if (!Number.isInteger(input.interactionRevision) || input.interactionRevision < 1) {
    throw new Error(`Invalid InteractionRequest revision: ${input.interactionRevision}`);
  }
  const seed = `interaction:${input.interactionRequestId}:${input.interactionRevision}`;
  return {
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    interactionRequestId: input.interactionRequestId,
    interactionRevision: input.interactionRevision,
    decision: input.decision,
    actor: input.actor,
    ...(input.actorId ? { actorId: input.actorId } : {}),
    commandId: input.commandId,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    completedAt: input.completedAt,
    operationId: stableIdFromSeed('operation', `${seed}:operation`),
    attemptId: stableIdFromSeed('attempt', `${seed}:attempt`),
    effectIntentId: stableIdFromSeed('effectIntent', `${seed}:effect`),
    toolCallEventId: stableIdFromSeed('toolCallEvent', `${seed}:tool-event`),
    responseMessageId: stableIdFromSeed('message', `${seed}:response-message`),
    responseRevisionId: stableIdFromSeed('messageRevision', `${seed}:response-revision`),
    nextInvocationId: stableIdFromSeed('invocation', `${seed}:next-invocation`),
    nextRequestId: stableIdFromSeed('request', `${seed}:next-request`),
    nextOperationId: stableIdFromSeed('operation', `${seed}:next-operation`),
    nextAttemptId: stableIdFromSeed('attempt', `${seed}:next-attempt`),
    nextEffectIntentId: stableIdFromSeed('effectIntent', `${seed}:next-effect`)
  };
}

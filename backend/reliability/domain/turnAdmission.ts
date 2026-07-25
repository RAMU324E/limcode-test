import type {
  AuthoritySnapshotRecord,
  EffectiveTurnAuthority,
  JsonValue,
  TurnRecord
} from '../../../shared/conversationReliability';
import type { MessageContent, MessageRecord, MessageRevisionRecord } from '../../../shared/protocol';
import type {
  AuthoritySnapshotId,
  ConversationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  AttemptId,
  EffectIntentId,
  RunId
} from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { assertCompleteEffectiveAuthority } from '../authorityCompiler';
import { acquireExecutionLease, replaceExecutionLease } from './executionLease';
import { appendInitialProgress, inputRevision, nextMessageSeq, relationId } from './handlers';
import { appendRunContextPolicy } from './runContextPolicy';
import { ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts } from './types';

export interface AdmitTurnIds {
  turnId: RunId;
  messageId: MessageId;
  revisionId: MessageRevisionId;
  authoritySnapshotId: AuthoritySnapshotId;
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export interface AdmitTurnInput {
  conversationId: ConversationId;
  agentId: string;
  content: MessageContent;
  now: number;
  ids: AdmitTurnIds;
  authority: EffectiveTurnAuthority;
  source:
    | { kind: 'direct'; sourceId: string }
    | { kind: 'turn_intent'; sourceId: string }
    | { kind: 'continuation'; sourceId: string };
  retryOfRunId?: RunId;
  replaceLeaseOwner?: RunId;
}

/**
 * The only user/new-continuation admission boundary. Message/seq, Turn, Lease, frozen authority and
 * initial external work are committed in one TransitionPlan.
 */
export function appendAdmittedTurn(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  input: AdmitTurnInput
): { turn: TurnRecord; message: MessageRecord; revision: MessageRevisionRecord; authority: AuthoritySnapshotRecord } {
  const currentLease = facts.executionLeases.find((candidate) => candidate.conversationId === input.conversationId);
  const lease = input.replaceLeaseOwner
    ? replaceExecutionLease(currentLease, {
        conversationId: input.conversationId,
        expectedTurnId: input.replaceLeaseOwner,
        nextTurnId: input.ids.turnId,
        now: input.now
      })
    : acquireExecutionLease(facts, {
        conversationId: input.conversationId,
        turnId: input.ids.turnId,
        now: input.now
      });
  const content = cloneContent(input.content);
  const message: MessageRecord = {
    id: input.ids.messageId,
    conversationId: input.conversationId,
    role: 'user',
    presentation: input.source.kind === 'continuation' ? 'internal' : 'visible',
    content,
    status: 'final',
    seq: nextMessageSeq(facts),
    createdAt: input.now
  };
  const revision: MessageRevisionRecord = {
    id: input.ids.revisionId,
    messageId: message.id,
    conversationId: input.conversationId,
    content: cloneContent(content),
    createdAt: input.now,
    reason: 'created'
  };
  const turn: TurnRecord = {
    id: input.ids.turnId,
    conversationId: input.conversationId,
    lifecycle: 'active',
    phase: 'loading_context',
    rowVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {})
  };
  const authorityValue = cloneJson(input.authority);
  assertCompleteEffectiveAuthority(authorityValue);
  const authorityAgentId = isObject(authorityValue.agent) ? authorityValue.agent.id : undefined;
  if (authorityAgentId !== input.agentId) {
    throw new Error(`Authority Agent ${String(authorityAgentId)} differs from Turn target ${input.agentId}.`);
  }
  const executionPolicy = cloneJson(authorityValue.executionPolicy);
  const authority: AuthoritySnapshotRecord = {
    id: input.ids.authoritySnapshotId,
    conversationId: input.conversationId,
    turnId: turn.id,
    authority: authorityValue,
    authorityHash: canonicalSha256(authorityValue),
    derivation: 'root',
    createdAt: input.now
  };
  const frozenInput = inputRevision(
    turn.id,
    input.conversationId,
    message.id as MessageId,
    revision.id as MessageRevisionId,
    content
  );
  const sourceKind = input.source.kind === 'turn_intent'
    ? 'user'
    : input.source.kind === 'continuation'
      ? 'system'
      : 'user';
  const messageTurnRole = input.source.kind === 'continuation' ? 'notification' as const : 'input' as const;

  builder
    .generatedId(
      input.ids.turnId,
      input.ids.messageId,
      input.ids.revisionId,
      input.ids.authoritySnapshotId,
      lease.id
    )
    .upsert('turns', turn)
    .upsert('messages', message)
    .upsert('messageRevisions', revision)
    .upsert('messageCurrentRevisionLinks', {
      id: relationId('message-current-revision', message.id),
      messageId: message.id,
      revisionId: revision.id
    })
    .upsert('runSources', {
      id: relationId('turn-source', turn.id),
      runId: turn.id,
      sourceKind,
      sourceConversationId: input.conversationId,
      sourceMessageId: message.id,
      ...(input.retryOfRunId ? { sourceRunId: input.retryOfRunId } : {})
    })
    .upsert('runTargets', {
      id: relationId('turn-target', turn.id, input.agentId, input.conversationId),
      runId: turn.id,
      agentId: input.agentId,
      conversationId: input.conversationId,
      role: 'executor'
    })
    .upsert('messageTurnLinks', {
      id: relationId('message-turn', message.id, turn.id, messageTurnRole),
      messageId: message.id,
      turnId: turn.id,
      role: messageTurnRole
    })
    .upsert('inputRevisions', frozenInput)
    .upsert('authoritySnapshots', authority)
    .upsert('executionLeases', lease);

  appendRunContextPolicy(builder, turn.id, input.conversationId);
  appendInitialProgress(
    builder,
    {
      operationId: input.ids.operationId,
      attemptId: input.ids.attemptId,
      effectIntentId: input.ids.effectIntentId
    },
    turn.id,
    input.conversationId,
    revision.id as MessageRevisionId,
    frozenInput.contentHash,
    input.now,
    executionPolicy
  );
  return { turn, message, revision, authority };
}

function cloneContent(content: MessageContent): MessageContent {
  return JSON.parse(JSON.stringify(content)) as MessageContent;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return !!value && !Array.isArray(value) && typeof value === 'object';
}

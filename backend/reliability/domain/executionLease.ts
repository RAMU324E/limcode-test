import type { ExecutionLeaseRecord } from '../../../shared/conversationReliability';
import type { ConversationId, RunId } from '../../../shared/stableIds';
import { stableIdFromSeed } from '../stableIdFactory';
import type { DurableConversationFacts } from './types';

export function conversationExecutionLease(
  facts: Pick<DurableConversationFacts, 'executionLeases'>,
  conversationId: ConversationId
): ExecutionLeaseRecord | undefined {
  const matches = facts.executionLeases.filter((lease) => lease.conversationId === conversationId);
  if (matches.length > 1) throw new Error(`Conversation ${conversationId} has multiple execution-lease records.`);
  return matches[0];
}

export function effectiveConversationExecutionLease(
  facts: Pick<DurableConversationFacts, 'executionLeases'>,
  conversationId: ConversationId
): ExecutionLeaseRecord | undefined {
  const lease = conversationExecutionLease(facts, conversationId);
  return lease?.state === 'released' ? undefined : lease;
}

export function acquireExecutionLease(
  facts: Pick<DurableConversationFacts, 'executionLeases'>,
  input: { conversationId: ConversationId; turnId: RunId; now: number }
): ExecutionLeaseRecord {
  const current = conversationExecutionLease(facts, input.conversationId);
  if (current && current.state !== 'released') {
    throw new Error(`Conversation ${input.conversationId} is already leased by Turn ${current.turnId}.`);
  }
  return {
    id: current?.id ?? stableIdFromSeed('executionLease', `conversation-execution-lease:${input.conversationId}`),
    conversationId: input.conversationId,
    turnId: input.turnId,
    epoch: (current?.epoch ?? 0) + 1,
    state: 'active',
    acquiredAt: input.now,
    rowVersion: (current?.rowVersion ?? 0) + 1
  };
}

export function replaceExecutionLease(
  lease: ExecutionLeaseRecord | undefined,
  input: { conversationId: ConversationId; expectedTurnId?: RunId; nextTurnId: RunId; now: number }
): ExecutionLeaseRecord {
  if (lease?.state !== 'released' && lease && lease.turnId !== input.expectedTurnId) {
    throw new Error(`Conversation ${input.conversationId} execution lease moved to Turn ${lease.turnId}.`);
  }
  return {
    id: lease?.id ?? stableIdFromSeed('executionLease', `conversation-execution-lease:${input.conversationId}`),
    conversationId: input.conversationId,
    turnId: input.nextTurnId,
    epoch: (lease?.epoch ?? 0) + 1,
    state: 'active',
    acquiredAt: input.now,
    rowVersion: (lease?.rowVersion ?? 0) + 1
  };
}

export function interruptExecutionLease(
  lease: ExecutionLeaseRecord,
  input: { turnId: RunId; epoch: number; now: number }
): ExecutionLeaseRecord {
  if (lease.turnId !== input.turnId || lease.epoch !== input.epoch || lease.state === 'released') {
    throw new Error(`Execution lease identity changed for Turn ${input.turnId}.`);
  }
  if (lease.state === 'interrupting') return lease;
  return {
    ...lease,
    state: 'interrupting',
    rowVersion: lease.rowVersion + 1
  };
}

export function releaseExecutionLease(
  lease: ExecutionLeaseRecord,
  input: { turnId: RunId; now: number }
): ExecutionLeaseRecord {
  if (lease.turnId !== input.turnId) throw new Error(`Turn ${input.turnId} does not own execution lease ${lease.id}.`);
  if (lease.state === 'released') return lease;
  return {
    ...lease,
    state: 'released',
    releasedAt: input.now,
    rowVersion: lease.rowVersion + 1
  };
}

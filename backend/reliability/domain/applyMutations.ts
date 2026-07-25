import type { JsonValue, RecordMutation, TransitionPlan } from '../../../shared/conversationReliability';
import { canonicalJson } from '../canonicalJson';
import type { DurableConversationFacts, DurableRecordFamily } from './types';

export function applyTransitionPlan(facts: DurableConversationFacts, plan: TransitionPlan): DurableConversationFacts {
  const next = cloneFacts(facts);
  for (const mutation of plan.recordMutations) applyRecordMutation(next, mutation);
  return next;
}

export function applyRecordMutation(facts: DurableConversationFacts, mutation: RecordMutation): void {
  assertSerializableMutation(mutation);
  const family = mutation.family as DurableRecordFamily;
  if (family === 'conversation') {
    if (mutation.kind !== 'upsert') throw new Error('Conversation root cannot be removed by a conversation transition.');
    facts.conversation = clone(mutation.record) as unknown as DurableConversationFacts['conversation'];
    return;
  }
  if (!(family in facts) || !Array.isArray(facts[family])) throw new Error(`Unknown durable record family: ${mutation.family}`);
  const records = facts[family] as unknown as Array<Record<string, unknown>>;
  if (mutation.kind === 'upsert') {
    const record = clone(mutation.record) as unknown as Record<string, unknown>;
    const index = records.findIndex((candidate) => durableRecordId(family, candidate) === mutation.id);
    if (index >= 0) records[index] = record; else records.push(record);
    return;
  }
  const ids = new Set(mutation.kind === 'remove' ? [mutation.id] : mutation.ids);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (ids.has(durableRecordId(family, records[index]))) records.splice(index, 1);
  }
}

export function durableRecordId(family: DurableRecordFamily, record: Record<string, unknown>): string {
  if (typeof record.id === 'string' && record.id) return record.id;
  switch (family) {
    case 'primaryEffects': return String(record.effectIntentId ?? '');
    case 'streamCheckpointHeads': return String(record.id ?? `${record.requestId}:${record.attemptId}:${record.generation}`);
    case 'terminalStreamFences': return String(record.id ?? `${record.requestId}:${record.attemptId}:${record.generation}`);
    default: throw new Error(`Record in ${family} has no durable identity.`);
  }
}

export function cloneFacts(facts: DurableConversationFacts): DurableConversationFacts {
  return clone(facts) as unknown as DurableConversationFacts;
}

function assertSerializableMutation(mutation: RecordMutation): void {
  canonicalJson(mutation as unknown as JsonValue);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

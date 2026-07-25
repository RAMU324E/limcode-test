import type {
  JsonValue,
  RuntimeDeliveryLinkRecord,
  RuntimeDeliveryPolicy,
  RuntimeInboxItemKind,
  RuntimeInboxItemRecord
} from '../../../shared/conversationReliability';
import type { MessageContent } from '../../../shared/protocol';
import type { ConversationId, RunId } from '../../../shared/stableIds';
import { stableIdFromSeed } from '../stableIdFactory';
import { canonicalSha256 } from '../canonicalJson';
import type { DurableConversationFacts } from './types';

export interface RuntimeInboxAppendInput {
  kind: RuntimeInboxItemKind;
  sourceKind: RuntimeInboxItemRecord['sourceKind'];
  sourceId: string;
  dedupeKey: string;
  payload: JsonValue;
  occurredAt: number;
  createdAt: number;
  destinationConversationId: ConversationId;
  ownerTurnId?: RunId;
  policy: RuntimeDeliveryPolicy;
}

export interface RuntimeInboxRecords {
  item: RuntimeInboxItemRecord;
  delivery: RuntimeDeliveryLinkRecord;
}

/**
 * Derives the only identities used for an asynchronous input and its direct destination. The item
 * identity includes the destination because canonical storage ownership is proven by the delivery
 * relation; fan-out must create one independently consumable item per destination.
 */
export function createRuntimeInboxRecords(input: RuntimeInboxAppendInput): RuntimeInboxRecords {
  if (!input.sourceId.trim() || !input.dedupeKey.trim()) throw new Error('RuntimeInbox source and dedupe identities cannot be empty.');
  const payload = clone(input.payload);
  const itemId = stableIdFromSeed(
    'runtimeInboxItem',
    `${input.destinationConversationId}:${input.kind}:${input.dedupeKey}`
  );
  const deliveryId = stableIdFromSeed(
    'relation',
    `runtime-delivery:${itemId}:${input.destinationConversationId}:${input.ownerTurnId ?? 'none'}`
  );
  return {
    item: {
      id: itemId,
      kind: input.kind,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      dedupeKey: input.dedupeKey,
      payload,
      payloadHash: canonicalSha256(payload),
      occurredAt: input.occurredAt,
      createdAt: input.createdAt
    },
    delivery: {
      id: deliveryId,
      inboxItemId: itemId,
      destinationConversationId: input.destinationConversationId,
      ...(input.ownerTurnId ? { ownerTurnId: input.ownerTurnId } : {}),
      policy: input.policy,
      state: 'pending',
      rowVersion: 1,
      createdAt: input.createdAt,
      updatedAt: input.createdAt
    }
  };
}

export function assertRuntimeInboxIdentity(
  facts: DurableConversationFacts,
  records: RuntimeInboxRecords
): 'new' | 'existing' {
  const item = facts.runtimeInboxItems.find((candidate) => candidate.id === records.item.id);
  const delivery = facts.runtimeDeliveryLinks.find((candidate) => candidate.id === records.delivery.id);
  if (!item && !delivery) return 'new';
  if (!item || !delivery
    || canonicalSha256(item) !== canonicalSha256(records.item)
    || canonicalSha256(delivery) !== canonicalSha256(records.delivery)) {
    throw new Error(`RuntimeInbox identity conflict: ${records.item.id}/${records.delivery.id}`);
  }
  return 'existing';
}

export interface PendingRuntimeDelivery {
  item: RuntimeInboxItemRecord;
  delivery: RuntimeDeliveryLinkRecord;
}

export function pendingRuntimeDeliveries(
  facts: DurableConversationFacts,
  policies?: readonly RuntimeDeliveryPolicy[]
): PendingRuntimeDelivery[] {
  const allowed = policies ? new Set(policies) : undefined;
  const itemById = new Map(facts.runtimeInboxItems.map((item) => [item.id, item]));
  return facts.runtimeDeliveryLinks
    .filter((delivery) => delivery.destinationConversationId === facts.conversation.id
      && delivery.state === 'pending'
      && (!allowed || allowed.has(delivery.policy)))
    .map((delivery) => {
      const item = itemById.get(delivery.inboxItemId);
      if (!item) throw new Error(`RuntimeDelivery ${delivery.id} references missing InboxItem ${delivery.inboxItemId}.`);
      if (canonicalSha256(item.payload) !== item.payloadHash) throw new Error(`RuntimeInboxItem ${item.id} payload hash is invalid.`);
      return { item, delivery };
    })
    .sort((left, right) => left.item.occurredAt - right.item.occurredAt
      || left.item.createdAt - right.item.createdAt
      || left.item.id.localeCompare(right.item.id)
      || left.delivery.id.localeCompare(right.delivery.id));
}

export function runtimeDeliveryMessageContent(batch: readonly PendingRuntimeDelivery[]): MessageContent {
  if (batch.length === 0) throw new Error('Cannot materialize an empty RuntimeDelivery batch.');
  const blocks = batch.map(({ item }) => renderRuntimeInboxItem(item));
  return {
    role: 'user',
    parts: [{ text: blocks.join('\n\n') }]
  };
}

export function runtimeDeliveryBatchDigest(batch: readonly PendingRuntimeDelivery[]): string {
  return canonicalSha256(batch.map(({ item, delivery }) => ({
    itemId: item.id,
    payloadHash: item.payloadHash,
    deliveryId: delivery.id,
    rowVersion: delivery.rowVersion
  })));
}

export function childTerminalPayload(value: JsonValue): {
  bridgeId: string;
  childTurnId: string;
  outcome: string;
  reason?: string;
  parentToolCallId?: string;
} | undefined {
  const record = object(value);
  if (record?.type !== 'child_terminal'
    || typeof record.bridgeId !== 'string'
    || typeof record.childTurnId !== 'string'
    || typeof record.outcome !== 'string') return undefined;
  return {
    bridgeId: record.bridgeId,
    childTurnId: record.childTurnId,
    outcome: record.outcome,
    ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
    ...(typeof record.parentToolCallId === 'string' ? { parentToolCallId: record.parentToolCallId } : {})
  };
}

export function childAnswerPayload(value: JsonValue): {
  bridgeId: string;
  submissionId: string;
  title: string;
  content: string;
  parentToolCallId?: string;
} | undefined {
  const record = object(value);
  if (record?.type !== 'child_answer'
    || typeof record.bridgeId !== 'string'
    || typeof record.submissionId !== 'string'
    || typeof record.title !== 'string'
    || typeof record.content !== 'string') return undefined;
  return {
    bridgeId: record.bridgeId,
    submissionId: record.submissionId,
    title: record.title,
    content: record.content,
    ...(typeof record.parentToolCallId === 'string' ? { parentToolCallId: record.parentToolCallId } : {})
  };
}

function renderRuntimeInboxItem(item: RuntimeInboxItemRecord): string {
  const payload = object(item.payload);
  if (item.kind === 'child_answer_submitted') {
    const answer = childAnswerPayload(item.payload);
    if (!answer) throw new Error(`RuntimeInboxItem ${item.id} has malformed child answer payload.`);
    return [
      '[Subagent answer delivered]',
      `answerBridgeId: ${answer.bridgeId}`,
      `submissionId: ${answer.submissionId}`,
      `title: ${answer.title}`,
      '',
      answer.content
    ].join('\n');
  }
  if (item.kind === 'background_process_exited') {
    const completion = object(payload?.completion);
    if (!completion) throw new Error(`RuntimeInboxItem ${item.id} has malformed background completion payload.`);
    const stdout = typeof completion.stdout === 'string' ? completion.stdout : '';
    const stderr = typeof completion.stderr === 'string' ? completion.stderr : '';
    return [
      '[Background command exited]',
      `processId: ${String(completion.processId ?? item.sourceId)}`,
      `status: ${String(completion.status ?? 'unknown')}`,
      `exitCode: ${String(completion.exitCode ?? 'unknown')}`,
      ...(stdout ? ['', 'stdout:', stdout] : []),
      ...(stderr ? ['', 'stderr:', stderr] : [])
    ].join('\n');
  }
  if (item.kind === 'child_terminal') {
    const terminal = childTerminalPayload(item.payload);
    if (!terminal) throw new Error(`RuntimeInboxItem ${item.id} has malformed child terminal payload.`);
    return [
      '[Subagent terminal event]',
      `answerBridgeId: ${terminal.bridgeId}`,
      `childTurnId: ${terminal.childTurnId}`,
      `outcome: ${terminal.outcome}`,
      ...(terminal.reason ? [`reason: ${terminal.reason}`] : [])
    ].join('\n');
  }
  return `[Runtime event: ${item.kind}]\n${JSON.stringify(item.payload)}`;
}

function object(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

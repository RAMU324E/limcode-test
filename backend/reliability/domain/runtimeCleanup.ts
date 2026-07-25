import type {
  AttemptRecord,
  DurableEffectPayloadRecord,
  JsonValue,
  OperationRecord,
  PrimaryEffectDescriptor
} from '../../../shared/conversationReliability';
import type { AttemptId, EffectIntentId, OperationId } from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import type { ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts } from './types';

export type RuntimeCleanupTargetKind = 'llm_abort' | 'tool_abort';

export interface RuntimeCleanupTarget {
  kind: RuntimeCleanupTargetKind;
  sourceOperationId: OperationId;
  sourceAttemptId: AttemptId;
  sourceGeneration: number;
  /** External request/process identities known at the cancellation commit boundary. */
  externalIds: string[];
}

export interface RuntimeCleanupEffectPayload {
  targets: RuntimeCleanupTarget[];
}

export interface RuntimeCleanupOutboxRecord {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
  target: RuntimeCleanupTarget;
}

/**
 * Persists idempotent external-abort work in the existing conversation-owned PrimaryEffect outbox.
 * Ephemeral cleanup hints may still lower latency, but correctness no longer depends on afterCommit.
 */
export function appendRuntimeCleanupOutbox(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  sourceAttemptIds: readonly string[],
  now: number
): RuntimeCleanupOutboxRecord[] {
  const records: RuntimeCleanupOutboxRecord[] = [];
  for (const sourceAttemptId of [...new Set(sourceAttemptIds)].sort()) {
    const sourceAttempt = unique(facts.attempts.filter((candidate) => candidate.id === sourceAttemptId), `cleanup source Attempt ${sourceAttemptId}`);
    if (!sourceAttempt || sourceAttempt.state !== 'dispatched') continue;
    const sourceOperation = unique(
      facts.operations.filter((candidate) => candidate.id === sourceAttempt.operationId),
      `cleanup source Operation ${sourceAttempt.operationId}`
    );
    const sourceEffect = unique(
      facts.primaryEffects.filter((candidate) => candidate.attemptId === sourceAttempt.id
        && candidate.operationId === sourceAttempt.operationId
        && candidate.generation === sourceAttempt.generation),
      `cleanup source PrimaryEffect ${sourceAttempt.id}:${sourceAttempt.generation}`
    );
    if (!sourceOperation || !sourceEffect) {
      throw new Error(`Dispatched Attempt ${sourceAttempt.id} has no complete cleanup ownership.`);
    }
    const kind = cleanupKind(sourceEffect.kind);
    if (!kind) continue;

    const seed = `runtime-cleanup:${sourceAttempt.id}:${sourceAttempt.generation}`;
    const operationId = stableIdFromSeed('operation', `${seed}:operation`);
    const attemptId = stableIdFromSeed('attempt', `${seed}:attempt`);
    const effectIntentId = stableIdFromSeed('effectIntent', `${seed}:effect`);
    const existing = facts.operations.find((candidate) => candidate.id === operationId);
    if (existing) {
      if (existing.kind !== 'runtime.cleanup' || existing.conversationId !== sourceAttempt.conversationId || existing.ownerKind !== 'conversation') {
        throw new Error(`Runtime cleanup Stable ID collision: ${operationId}`);
      }
      continue;
    }

    const target: RuntimeCleanupTarget = {
      kind,
      sourceOperationId: sourceOperation.id,
      sourceAttemptId: sourceAttempt.id,
      sourceGeneration: sourceAttempt.generation,
      externalIds: externalRuntimeIds(facts, sourceOperation, sourceEffect)
    };
    const payloadValue: RuntimeCleanupEffectPayload = { targets: [target] };
    const payload = payloadValue as unknown as JsonValue;
    const payloadHash = canonicalSha256(payload);
    const payloadId = `effect-payload:${operationId}:1`;
    const deadlineAt = now + 60_000;
    const operation: OperationRecord = {
      ownerKind: 'conversation',
      id: operationId,
      conversationId: sourceAttempt.conversationId,
      kind: 'runtime.cleanup',
      state: 'running',
      currentGeneration: 1,
      rowVersion: 1,
      timeoutPolicy: 'retry_if_safe',
      createdAt: now,
      updatedAt: now
    };
    const attempt: AttemptRecord = {
      ownerKind: 'conversation',
      id: attemptId,
      operationId,
      conversationId: sourceAttempt.conversationId,
      generation: 1,
      state: 'pending',
      deadlineAt,
      rowVersion: 1
    };
    const effectPayload: DurableEffectPayloadRecord = {
      ownerKind: 'conversation',
      id: payloadId,
      conversationId: sourceAttempt.conversationId,
      operationId,
      kind: 'runtime.cleanup',
      payload,
      payloadHash,
      createdAt: now
    };
    const effect: PrimaryEffectDescriptor = {
      ownerKind: 'conversation',
      effectIntentId,
      conversationId: sourceAttempt.conversationId,
      operationId,
      attemptId,
      generation: 1,
      kind: 'runtime.cleanup',
      idempotencyKey: seed,
      recoveryPolicy: 'resume_pending_if_safe',
      deadlineAt,
      payloadRef: { kind: 'record', id: payloadId, hash: payloadHash }
    };
    builder
      .generatedId(operationId, attemptId, effectIntentId)
      .upsert('operations', operation)
      .upsert('attempts', attempt)
      .upsert('primaryEffects', { id: effect.effectIntentId, ...effect })
      .upsert('effectPayloads', effectPayload)
      .primaryEffect(effect);
    records.push({ operationId, attemptId, effectIntentId, target });
  }
  return records;
}

export function normalizeRuntimeCleanupPayload(value: JsonValue): RuntimeCleanupEffectPayload {
  const record = object(value);
  if (!record || !Array.isArray(record.targets) || record.targets.length === 0) {
    throw new Error('runtime.cleanup has no targets.');
  }
  const targets = record.targets.map((raw, index): RuntimeCleanupTarget => {
    const target = object(raw);
    const kind = target?.kind;
    const sourceOperationId = text(target?.sourceOperationId);
    const sourceAttemptId = text(target?.sourceAttemptId);
    const sourceGeneration = target?.sourceGeneration;
    const externalIds = Array.isArray(target?.externalIds)
      ? [...new Set(target.externalIds.map(text).filter((item): item is string => !!item))].sort()
      : [];
    if ((kind !== 'llm_abort' && kind !== 'tool_abort')
      || !sourceOperationId
      || !sourceAttemptId
      || !Number.isInteger(sourceGeneration)
      || (sourceGeneration as number) < 1) {
      throw new Error(`runtime.cleanup target ${index} is invalid.`);
    }
    return {
      kind,
      sourceOperationId: sourceOperationId as OperationId,
      sourceAttemptId: sourceAttemptId as AttemptId,
      sourceGeneration: sourceGeneration as number,
      externalIds
    };
  });
  return { targets };
}

function cleanupKind(effectKind: string): RuntimeCleanupTargetKind | undefined {
  if (effectKind === 'llm.request' || effectKind.startsWith('compression.')) return 'llm_abort';
  if (effectKind.startsWith('tool.')) return 'tool_abort';
  return undefined;
}

function externalRuntimeIds(
  facts: DurableConversationFacts,
  operation: OperationRecord,
  effect: PrimaryEffectDescriptor
): string[] {
  const ids = new Set<string>();
  for (const request of facts.requests.filter((candidate) => candidate.operationId === operation.id)) ids.add(request.id);
  const payloadRecord = facts.effectPayloads.find((candidate) => candidate.id === effect.payloadRef.id
    && candidate.operationId === operation.id
    && candidate.payloadHash === effect.payloadRef.hash);
  collectKnownRequestIds(payloadRecord?.payload, ids);
  return [...ids].sort();
}

function collectKnownRequestIds(value: unknown, output: Set<string>): void {
  const record = object(value);
  if (!record) return;
  const requestId = text(record.requestId);
  if (requestId) output.add(requestId);
  const directId = text(record.id);
  if (directId && ('contents' in record || 'messages' in record || 'modelId' in record)) output.add(directId);
  for (const key of ['compactRequest', 'request']) {
    const nested = object(record[key]);
    const id = text(nested?.id);
    if (id) output.add(id);
  }
}

function unique<T>(values: readonly T[], label: string): T | undefined {
  if (values.length > 1) throw new Error(`${label} is ambiguous (${values.length} matches).`);
  return values[0];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

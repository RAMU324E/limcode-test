import { createHash } from 'node:crypto';
import type { DomainRow, RepositoryTransactionStep } from './repositories';
import type {
  ConversationForkSource,
  TurnCommandOperation,
  TurnCommandSource,
  TurnInitiatingSource,
  TurnTerminalSource
} from './turnControlPlane';

export const TURN_INTENT_STATE_QUEUED = 'queued';
export const TURN_INTENT_STATE_ADMITTED = 'admitted';
export const TURN_INTENT_STATE_CANCELLED = 'cancelled';

export interface CommandCommit {
  receipt: DomainRow;
  deduplicated: boolean;
  commitSeq?: string;
  changes: ReadonlyArray<{ domain: string; kind: 'upsert' | 'remove'; id: string }>;
  allocatedSequences: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>;
}

export interface TurnCommandCommitOptions {
  source: TurnCommandSource;
  receiptId: string;
  conversationId: string;
  turnId: string | null;
  requiresConversationIdle?: boolean;
  steps: RepositoryTransactionStep[];
}

export function commandEntityId(
  source: TurnCommandSource,
  operation: TurnCommandOperation,
  entityKind: string,
  commandScope: string
): string {
  const digest = createHash('sha256')
    .update('limcode-turn-command-entity\0')
    .update(JSON.stringify([source.kind, source.key, operation, commandScope, entityKind]))
    .digest('hex');
  return `${entityKind}_${digest}`;
}

export function allocatedValue(
  commit: CommandCommit,
  domain: string,
  id: string,
  column: string
): string {
  return allocatedRuntimeValue(commit.allocatedSequences, domain, id, column);
}

export function allocatedRuntimeValue(
  allocatedSequences: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>,
  domain: string,
  id: string,
  column: string
): string {
  const allocated = allocatedSequences.find((entry) =>
    entry.domain === domain && entry.id === id && entry.column === column
  );
  if (!allocated) throw new Error(`${domain} ${id} did not return writer-allocated ${column}.`);
  return requireDecimalIntegerString(allocated.value, `${domain}.${column}`);
}

export function assertReceiptIdentity(
  receipt: DomainRow,
  expectedReceiptId: string,
  operation: TurnCommandOperation
): void {
  if (receipt.id !== expectedReceiptId) throw sourceOperationMismatch(receipt, operation);
}

export function sourceOperationMismatch(receipt: DomainRow, operation: TurnCommandOperation): Error {
  return new Error(
    `CommandReceipt (${String(receipt.source_kind)},${String(receipt.source_key)}) does not contain ${operation} result facts.`
  );
}

export function normalizeInitiatingSource(source: TurnCommandSource, operation: Exclude<TurnCommandOperation, 'terminal'>): TurnInitiatingSource {
  if (!source || !['command', 'internal'].includes(source.kind)) {
    throw new TypeError(`${operation} source kind must be command or internal.`);
  }
  return { kind: source.kind as TurnInitiatingSource['kind'], key: requireText(source.key, 'source key') };
}

export function normalizeTerminalSource(source: TurnCommandSource): TurnTerminalSource {
  if (!source || !['callback', 'internal', 'recovery'].includes(source.kind)) {
    throw new TypeError('terminal source kind must be callback, internal or recovery.');
  }
  return { kind: source.kind as TurnTerminalSource['kind'], key: requireText(source.key, 'source key') };
}

export function normalizeForkSource(source: ConversationForkSource): ConversationForkSource {
  return {
    sourceConversationId: requireId(source.sourceConversationId, 'sourceConversationId'),
    sourceTurnId: requireId(source.sourceTurnId, 'sourceTurnId'),
    sourceMessageId: requireId(source.sourceMessageId, 'sourceMessageId'),
    sourceMessageRevisionId: requireId(source.sourceMessageRevisionId, 'sourceMessageRevisionId'),
    sourceContextRootId: requireId(source.sourceContextRootId, 'sourceContextRootId')
  };
}

export function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

export function requireContentType(value: unknown): string {
  return requireText(value, 'content type');
}

export function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return text;
}

export function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint inside JavaScript.`);
  return value;
}

export function requirePositiveInteger(value: unknown, label: string): bigint {
  const integer = requireBigInt(value, label);
  if (integer <= 0n) throw new TypeError(`${label} must be positive.`);
  return integer;
}

export function requireDecimalIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string on the wire.`);
  }
  return value;
}

export function isTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Immutable execution authority captured before an Agent loop starts.
 *
 * The row id alone is not a fence: recovery deliberately reuses the lease row while incrementing
 * generation. Every executor write therefore has to prove this complete tuple in the same SQLite
 * transaction as the write. AsyncLocalStorage carries the tuple across provider/tool callbacks
 * without allowing those callbacks to re-read a newer lease and accidentally adopt it.
 */
export interface ExecutionLeaseFence {
  id: string;
  conversationId: string;
  turnId: string;
  ownerId: string;
  hostBootId: string;
  generation: bigint;
}

const EXECUTION_LEASE_FENCE = new AsyncLocalStorage<ExecutionLeaseFence | null>();

export class ExecutionHandoffError extends Error {
  public readonly code = 'EXECUTION_HANDOFF';

  public constructor(message = 'Extension Host is handing the active Turn to recovery.') {
    super(message);
    this.name = 'ExecutionHandoffError';
  }
}

export function runWithExecutionLeaseFence<T>(
  fence: ExecutionLeaseFence,
  operation: () => T
): T {
  return EXECUTION_LEASE_FENCE.run(normalizeExecutionLeaseFence(fence), operation);
}

/** Receipt/recovery writers that deliberately survive their source Turn use this boundary. */
export function runWithoutExecutionLeaseFence<T>(operation: () => T): T {
  return EXECUTION_LEASE_FENCE.run(null, operation);
}

export function currentExecutionLeaseFence(): ExecutionLeaseFence | undefined {
  return EXECUTION_LEASE_FENCE.getStore() ?? undefined;
}

export function executionLeaseFenceAssertion(fence: ExecutionLeaseFence): Record<string, unknown> {
  const normalized = normalizeExecutionLeaseFence(fence);
  return {
    conversation_id: normalized.conversationId,
    turn_id: normalized.turnId,
    owner_id: normalized.ownerId,
    host_boot_id: normalized.hostBootId,
    generation: normalized.generation
  };
}

export function isExecutionHandoffError(error: unknown): error is ExecutionHandoffError {
  return error instanceof ExecutionHandoffError
    || (error instanceof Error && (error as Error & { code?: unknown }).code === 'EXECUTION_HANDOFF');
}

export function handoffReason(signal: AbortSignal | undefined): ExecutionHandoffError | undefined {
  if (!signal?.aborted) return undefined;
  return isExecutionHandoffError(signal.reason) ? signal.reason : undefined;
}

function normalizeExecutionLeaseFence(fence: ExecutionLeaseFence): ExecutionLeaseFence {
  if (!fence || typeof fence !== 'object') throw new TypeError('ExecutionLease fence must be an object.');
  return {
    id: requireId(fence.id, 'ExecutionLeaseFence.id'),
    conversationId: requireId(fence.conversationId, 'ExecutionLeaseFence.conversationId'),
    turnId: requireId(fence.turnId, 'ExecutionLeaseFence.turnId'),
    ownerId: requireId(fence.ownerId, 'ExecutionLeaseFence.ownerId'),
    hostBootId: requireId(fence.hostBootId, 'ExecutionLeaseFence.hostBootId'),
    generation: requirePositiveBigInt(fence.generation, 'ExecutionLeaseFence.generation')
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value.trim();
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

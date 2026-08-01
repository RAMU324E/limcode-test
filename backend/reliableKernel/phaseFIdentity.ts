import { createHash } from 'node:crypto';

export function stablePhaseFId(kind: string, ...identity: readonly unknown[]): string {
  const normalizedKind = requirePhaseFText(kind, 'Phase F identity kind').replace(/[^a-z0-9_]+/gi, '_').toLowerCase();
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-phase-f\0')
    .update(normalizedKind)
    .update('\0')
    .update(JSON.stringify(identity))
    .digest('hex');
  return `${normalizedKind}_${digest}`;
}

export function requirePhaseFId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty id.`);
  }
  return value.trim();
}

export function optionalPhaseFId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requirePhaseFId(value, label);
}

export function requirePhaseFText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text.`);
  }
  return value.trim();
}

export function requireIsoTimestamp(value: unknown, label: string): string {
  const text = requirePhaseFText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return text;
}

export function requirePositiveInteger(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be a positive SQLite INTEGER.`);
}

export function isTransactionAssertionFailure(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

export function sqliteUniqueFailureIncludes(error: unknown, identities: readonly string[]): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed:') && identities.some((identity) => message.includes(identity));
}

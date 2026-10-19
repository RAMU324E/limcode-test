import type { ReliableKernelCollaborationHistoryCursor } from '../../shared/reliableKernelClientFeed';
import { requireNonNegativeIntegerString, requireRuntimeId } from './runtimeSqlRows';

export function normalizeCollaborationHistoryCursor(value: unknown): ReliableKernelCollaborationHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid exchange history cursor.');
  const cursor = value as Record<string, unknown>;
  const sequence = (input: unknown) => {
    const result = requireNonNegativeIntegerString(input, 'exchange history sequence');
    if (result === '0') throw new TypeError('Exchange history sequence must be positive.');
    return result;
  };
  if (cursor.kind === 'exchange') {
    if (Object.keys(cursor).some(key => !['kind', 'beforeExchangeSeq', 'afterExchangeSeq'].includes(key))
      || cursor.beforeExchangeSeq !== undefined && cursor.afterExchangeSeq !== undefined) throw new TypeError('Invalid exchange cursor fields.');
    return { kind: 'exchange',
      ...(cursor.beforeExchangeSeq === undefined ? {} : { beforeExchangeSeq: sequence(cursor.beforeExchangeSeq) }),
      ...(cursor.afterExchangeSeq === undefined ? {} : { afterExchangeSeq: sequence(cursor.afterExchangeSeq) }) };
  }
  if (cursor.kind !== 'message' && cursor.kind !== 'answer') throw new TypeError('Invalid exchange history cursor kind.');
  const beforeKey = cursor.kind === 'message' ? 'beforeMessageSeq' : 'beforeCreatedAt';
  const afterKey = cursor.kind === 'message' ? 'afterMessageSeq' : 'afterCreatedAt';
  if (Object.keys(cursor).some(field => !['kind', beforeKey, afterKey, 'beforeId', 'afterId'].includes(field))
    || (cursor[beforeKey] === undefined) !== (cursor.beforeId === undefined)
    || (cursor[afterKey] === undefined) !== (cursor.afterId === undefined)
    || cursor.beforeId !== undefined && cursor.afterId !== undefined) throw new TypeError('Incomplete exchange history cursor.');
  const after = cursor.afterId !== undefined;
  const rawId = after ? cursor.afterId : cursor.beforeId;
  if (rawId === undefined) return { kind: cursor.kind };
  const id = requireRuntimeId(rawId);
  const position = cursor[after ? afterKey : beforeKey];
  if (cursor.kind === 'message') return { kind: 'message', ...(after
    ? { afterMessageSeq: sequence(position), afterId: id } : { beforeMessageSeq: sequence(position), beforeId: id }) };
  if (typeof position !== 'string' || !Number.isFinite(Date.parse(position))) throw new TypeError('Invalid answer inventory cursor.');
  return { kind: 'answer', ...(after ? { afterCreatedAt: position, afterId: id } : { beforeCreatedAt: position, beforeId: id }) };
}

export function normalizeCollaborationHistoryDirection(value: unknown,
  cursor?: ReliableKernelCollaborationHistoryCursor): 'before' | 'after' {
  const direction = value ?? 'before';
  if (direction !== 'before' && direction !== 'after') throw new TypeError('Invalid collaboration history direction.');
  const opposite = direction === 'before' ? 'after' : 'before';
  if (cursor && Object.keys(cursor).some(key => key.startsWith(opposite))) {
    throw new TypeError('Collaboration history cursor does not match its requested direction.');
  }
  return direction;
}

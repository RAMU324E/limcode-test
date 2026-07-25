import { canonicalJson } from '../canonicalJson';
import type { DurableRecordFamily } from './types';

/**
 * These records are independent shared domain objects. Conversation scopes may each persist the
 * same closed-over record, but a leased aggregate must expose one canonical value per stable ID.
 */
export const CANONICAL_SHARED_DURABLE_FAMILIES = ['projectContexts'] as const satisfies readonly DurableRecordFamily[];

export type CanonicalSharedDurableFamily = typeof CANONICAL_SHARED_DURABLE_FAMILIES[number];

const canonicalSharedDurableFamilies = new Set<DurableRecordFamily>(CANONICAL_SHARED_DURABLE_FAMILIES);

export function isCanonicalSharedDurableFamily(family: DurableRecordFamily): family is CanonicalSharedDurableFamily {
  return canonicalSharedDurableFamilies.has(family);
}

export function canonicalDurableRecordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

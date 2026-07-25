import type { JsonValue } from '../../../shared/conversationReliability';
import type { RunId } from '../../../shared/stableIds';
import { canonicalSha256 } from '../canonicalJson';
import type { DurableConversationFacts } from './types';

export const TURN_EXECUTION_POLICY_DEADLINE_KEYS = [
  'contextDeadlineMs',
  'resolveInvocationDeadlineMs',
  'requestDeadlineMs',
  'toolDeadlineMs',
  'checkpointDeadlineMs',
  'compressionDeadlineMs'
] as const;

export type TurnExecutionPolicyDeadlineKey = typeof TURN_EXECUTION_POLICY_DEADLINE_KEYS[number];
export type FrozenTurnExecutionPolicy = { [key: string]: JsonValue };

export const DEFAULT_TURN_EXECUTION_POLICY: FrozenTurnExecutionPolicy = {
  contextDeadlineMs: 120_000,
  contextTimeoutPolicy: 'retry_if_safe',
  resolveInvocationDeadlineMs: 60_000,
  requestDeadlineMs: 10 * 60_000,
  toolDeadlineMs: 30 * 60_000,
  checkpointDeadlineMs: 120_000,
  compressionDeadlineMs: 180_000
};

export function turnExecutionPolicyViolations(policy: JsonValue): string[] {
  if (!policy || Array.isArray(policy) || typeof policy !== 'object') return ['is not an object'];
  const violations: string[] = [];
  for (const key of TURN_EXECUTION_POLICY_DEADLINE_KEYS) {
    const value = policy[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) violations.push(`has no valid ${key}`);
  }
  const timeoutPolicy = policy.contextTimeoutPolicy;
  if (timeoutPolicy !== 'retry_if_safe' && timeoutPolicy !== 'fail_run' && timeoutPolicy !== 'interrupt_run') {
    violations.push('has no valid contextTimeoutPolicy');
  }
  return violations;
}

/** Returns the one complete policy inside the Turn's hash-bound AuthoritySnapshot; existing Turns never use live defaults. */
export function requireTurnExecutionPolicy(facts: DurableConversationFacts, turnId: RunId): FrozenTurnExecutionPolicy {
  const snapshots = facts.authoritySnapshots.filter((candidate) => candidate.turnId === turnId);
  if (snapshots.length !== 1) throw new Error(`Turn ${turnId} has ${snapshots.length} AuthoritySnapshots.`);
  const snapshot = snapshots[0]!;
  if (canonicalSha256(snapshot.authority) !== snapshot.authorityHash) {
    throw new Error(`Turn ${turnId} AuthoritySnapshot has an invalid authority hash.`);
  }
  const policy = snapshot.authority.executionPolicy;
  const violations = turnExecutionPolicyViolations(policy);
  if (violations.length > 0) throw new Error(`Turn ${turnId} frozen execution policy ${violations.join(', ')}.`);
  return policy as FrozenTurnExecutionPolicy;
}

export function requireTurnExecutionPolicyNumber(
  facts: DurableConversationFacts,
  turnId: RunId,
  key: TurnExecutionPolicyDeadlineKey
): number {
  const policy = requireTurnExecutionPolicy(facts, turnId);
  return policy[key] as number;
}

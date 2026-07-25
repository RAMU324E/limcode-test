import type { RunContextPolicyRecord } from '../../../shared/protocol';
import type { ConversationId, RunId } from '../../../shared/stableIds';
import type { ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts } from './types';

export function runContextPolicyId(runId: RunId): string {
  return `run-context-policy:${runId}`;
}

export function runContextPolicyLinkId(runId: RunId): string {
  return `run-context-policy-link:${runId}`;
}

export function contextPolicyForRun(
  facts: DurableConversationFacts,
  runId: RunId
): Omit<RunContextPolicyRecord, 'id'> | undefined {
  const links = facts.runContextPolicyLinks.filter((link) => link.runId === runId && link.role === 'active');
  if (links.length > 1) throw new Error(`Run ${runId} has multiple active ContextPolicy links.`);
  const policy = links[0] ? facts.runContextPolicies.find((candidate) => candidate.id === links[0].policyId) : undefined;
  if (!policy) return undefined;
  const { id: _id, conversationId: _conversationId, ...value } = policy;
  return value;
}

export function appendRunContextPolicy(
  builder: ConversationTransitionBuilder,
  runId: RunId,
  conversationId: ConversationId,
  policy: Omit<RunContextPolicyRecord, 'id'> = { historyMode: 'full' }
): void {
  const policyId = runContextPolicyId(runId);
  builder
    .upsert('runContextPolicies', { id: policyId, conversationId, ...policy })
    .upsert('runContextPolicyLinks', {
      id: runContextPolicyLinkId(runId),
      runId,
      policyId,
      role: 'active'
    });
}

import type { RuntimeContextSnapshotRecord, RunRuntimeContextSnapshotLinkRecord } from '../../shared/protocol';
import type { ModelContextFactView } from '../modelContext/types';
import type { DurableConversationFacts } from './domain/types';
import { withValidatedCompressionBlocks } from '../modelContext/compressionSourceGraph';

export interface DurableModelContextSupplement {
  runtimeContextSnapshots?: readonly RuntimeContextSnapshotRecord[];
  runRuntimeContextSnapshotLinks?: readonly RunRuntimeContextSnapshotLinkRecord[];
}

/** Converts one leased durable scope (or a closed multi-scope view) into projector facts. */
export function modelContextFactsFromDurable(
  scopes: readonly DurableConversationFacts[],
  supplement: DurableModelContextSupplement = {}
): ModelContextFactView {
  const facts: ModelContextFactView = {
    messages: scopes.flatMap((facts) => facts.messages),
    messageRevisions: scopes.flatMap((facts) => facts.messageRevisions),
    messageCurrentRevisionLinks: scopes.flatMap((facts) => facts.messageCurrentRevisionLinks),
    runs: scopes.flatMap((facts) => facts.turns.map((run) => ({
      id: run.id,
      conversationId: run.conversationId,
      lifecycle: run.lifecycle,
      phase: run.phase,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }))),
    runSources: scopes.flatMap((facts) => facts.runSources.map((source) => ({ ...source }))),
    messageTurnLinks: scopes.flatMap((facts) => facts.messageTurnLinks.map((link) => ({ ...link }))),
    inputRevisions: scopes.flatMap((facts) => facts.inputRevisions.map((input) => ({ ...input }))),
    runTerminations: scopes.flatMap((facts) => facts.runTerminations.map((termination) => ({ ...termination }))),
    toolCalls: scopes.flatMap((facts) => facts.toolCalls.map((tool) => ({ ...tool }))),
    toolResultArtifacts: scopes.flatMap((facts) => facts.toolResultArtifacts.map((artifact) => ({ ...artifact }))),
    toolCallResultLinks: scopes.flatMap((facts) => facts.toolCallResultLinks.map((link) => ({ ...link }))),
    compressionBlocks: scopes.flatMap((scope) => scope.compressionBlocks.map((block) => ({ ...block }))),
    compressionContextVariants: scopes.flatMap((facts) => facts.compressionContextVariants.map((variant) => ({ ...variant }))),
    runCompressionBlockLinks: scopes.flatMap((facts) => facts.runCompressionBlockLinks.map((link) => ({ ...link }))),
    runtimeContextSnapshots: supplement.runtimeContextSnapshots ?? [],
    runRuntimeContextSnapshotLinks: supplement.runRuntimeContextSnapshotLinks ?? []
  };
  return withValidatedCompressionBlocks({
    facts,
    projections: scopes.flatMap((scope) => scope.modelContextProjections),
    sourceLinks: scopes.flatMap((scope) => scope.modelContextProjectionSourceLinks),
    compressionLinks: scopes.flatMap((scope) => scope.compressionModelContextProjectionLinks)
  });
}

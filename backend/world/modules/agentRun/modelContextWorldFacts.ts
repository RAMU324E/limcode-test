import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { chatStateProjectionReads, projectChatState } from '../chat/stateProjection';
import { compressionStateProjectionReads, projectCompressionState } from '../compression/stateProjection';
import { projectRuntimeContextState, runtimeContextStateProjectionReads } from '../runtimeContext/stateProjection';
import { projectToolsRuntimeState, toolsRuntimeStateProjectionReads } from '../tools/stateProjection';
import { agentRunStateProjectionReads, projectAgentRunState } from './stateProjection';
import type { ModelContextFactView, ModelContextInputRevisionFact, ModelContextRunFact } from '../../../modelContext/types';
import { withValidatedCompressionBlocks } from '../../../modelContext/compressionSourceGraph';
import { modelContextStateProjectionReads, projectModelContextState } from '../modelContext/stateProjection';

const baseModelContextWorldFactsReads: AccessDeclaration = {
  components: [...new Set([
    ...(chatStateProjectionReads.components ?? []),
    ...(agentRunStateProjectionReads.components ?? []),
    ...(toolsRuntimeStateProjectionReads.components ?? []),
    ...(compressionStateProjectionReads.components ?? []),
    ...(modelContextStateProjectionReads.components ?? [])
  ])],
  resources: [...new Set([
    ...(chatStateProjectionReads.resources ?? []),
    ...(agentRunStateProjectionReads.resources ?? []),
    ...(toolsRuntimeStateProjectionReads.resources ?? []),
    ...(compressionStateProjectionReads.resources ?? []),
    ...(modelContextStateProjectionReads.resources ?? [])
  ])]
};

/** Turn projection needs frozen runtime context; compression deliberately does not. */
export const turnModelContextWorldFactsReads: AccessDeclaration = {
  components: [...new Set([
    ...(baseModelContextWorldFactsReads.components ?? []),
    ...(runtimeContextStateProjectionReads.components ?? [])
  ])],
  resources: [...new Set([
    ...(baseModelContextWorldFactsReads.resources ?? []),
    ...(runtimeContextStateProjectionReads.resources ?? [])
  ])]
};

/**
 * Compression only consumes durable conversation/tool/compression provenance.
 * Keeping runtime snapshots out of this declaration is semantically correct and avoids a false
 * RuntimeContextSnapshotSystem -> CompressionSystem topology edge.
 */
export const compressionModelContextWorldFactsReads: AccessDeclaration = baseModelContextWorldFactsReads;

/** Adapts loaded ECS facts into the stable-ID-only input consumed by a turn projection. */
export function modelContextTurnFactsFromWorld(world: WorldReader): ModelContextFactView {
  return modelContextFactsFromWorld(world, true);
}

/** Adapts loaded ECS facts into the stable-ID-only input consumed by a compression projection. */
export function modelContextCompressionFactsFromWorld(world: WorldReader): ModelContextFactView {
  return modelContextFactsFromWorld(world, false);
}

function modelContextFactsFromWorld(world: WorldReader, includeRuntimeContext: boolean): ModelContextFactView {
  const chat = projectChatState(world);
  const agentRuns = projectAgentRunState(world);
  const tools = projectToolsRuntimeState(world);
  const compression = projectCompressionState(world);
  const runtime = includeRuntimeContext ? projectRuntimeContextState(world) : undefined;
  const targetByRun = new Map((agentRuns.agentRunTargetLinks ?? []).map((target) => [target.runId, target]));
  const revisionById = new Map((chat.messageRevisions ?? []).map((revision) => [revision.id, revision]));

  const runs: ModelContextRunFact[] = (agentRuns.agentRuns ?? []).flatMap((run) => {
    const target = targetByRun.get(run.id);
    if (!target) return [];
    return [{
      id: run.id,
      conversationId: target.conversationId,
      lifecycle: run.lifecycle,
      phase: run.phase,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }];
  });
  const inputRevisions: ModelContextInputRevisionFact[] = (agentRuns.agentRunInputRevisions ?? []).flatMap((input) => {
    const revision = revisionById.get(input.revisionId);
    if (!revision) return [];
    return [{
      id: input.id,
      runId: input.runId,
      conversationId: input.conversationId,
      messageId: revision.messageId,
      revisionId: input.revisionId
    }];
  });

  const facts: ModelContextFactView = {
    messages: chat.messages ?? [],
    messageRevisions: chat.messageRevisions ?? [],
    messageCurrentRevisionLinks: chat.messageCurrentRevisionLinks ?? [],
    runs,
    runSources: agentRuns.agentRunSourceLinks ?? [],
    messageTurnLinks: agentRuns.messageTurnLinks ?? [],
    inputRevisions,
    runTerminations: agentRuns.runTerminations ?? [],
    toolCalls: tools.toolCalls ?? [],
    toolResultArtifacts: tools.toolResultArtifacts ?? [],
    toolCallResultLinks: tools.toolCallResultLinks ?? [],
    compressionBlocks: compression.compressionBlocks ?? [],
    compressionContextVariants: compression.compressionContextVariants ?? [],
    runCompressionBlockLinks: compression.runCompressionBlockLinks ?? [],
    runtimeContextSnapshots: runtime?.runtimeContextSnapshots ?? [],
    runRuntimeContextSnapshotLinks: runtime?.runRuntimeContextSnapshotLinks ?? []
  };
  const graph = projectModelContextState(world);
  return withValidatedCompressionBlocks({
    facts,
    projections: graph.modelContextProjections ?? [],
    sourceLinks: graph.modelContextProjectionSourceLinks ?? [],
    compressionLinks: graph.compressionModelContextProjectionLinks ?? []
  });
}

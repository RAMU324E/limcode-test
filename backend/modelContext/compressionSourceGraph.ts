import type {
  CompressionModelContextProjectionLinkRecord,
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord
} from '../../shared/protocol';
import { persistedModelContextProjectionFingerprint } from './projectionFingerprint';
import {
  compressionVariantSourceFingerprint,
  messageRevisionSourceFingerprint,
  runTerminationSourceFingerprint,
  runtimeContextSnapshotSourceFingerprint,
  toolCallSourceFingerprint
} from './sourceFingerprint';
import type { ModelContextFactView } from './types';

export interface ModelContextProjectionGraphView {
  facts: ModelContextFactView;
  projections: readonly ModelContextProjectionRecord[];
  sourceLinks: readonly ModelContextProjectionSourceLinkRecord[];
  compressionLinks: readonly CompressionModelContextProjectionLinkRecord[];
}

export interface CompressionSourceGraphValidity {
  valid: boolean;
  reason?: string;
  sourceId?: string;
}

export function compressionProjectionIdentity(
  view: ModelContextProjectionGraphView,
  blockId: string
): {
  link: CompressionModelContextProjectionLinkRecord;
  projection: ModelContextProjectionRecord;
  sources: ModelContextProjectionSourceLinkRecord[];
} | undefined {
  const links = view.compressionLinks.filter((link) => link.blockId === blockId && link.role === 'source');
  if (links.length !== 1) return undefined;
  const projection = view.projections.find((candidate) => candidate.id === links[0].projectionId);
  if (!projection) return undefined;
  const sources = view.sourceLinks
    .filter((source) => source.projectionId === projection.id)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  return { link: links[0], projection, sources };
}

/** Validates one block and every retained predecessor using exact immutable source fingerprints. */
export function validateCompressionSourceGraph(
  view: ModelContextProjectionGraphView,
  blockId: string
): CompressionSourceGraphValidity {
  return validateBlock(view, blockId, new Set<string>());
}

/** Marks unproven complete blocks as unavailable before the projector chooses a predecessor/variant. */
export function withValidatedCompressionBlocks(view: ModelContextProjectionGraphView): ModelContextFactView {
  const originalFacts = view.facts;
  return {
    ...originalFacts,
    compressionBlocks: originalFacts.compressionBlocks.map((block) => {
      if (block.status !== 'complete') return block;
      const validity = validateCompressionSourceGraph(view, block.id);
      return validity.valid
        ? block
        : { ...block, staleReason: `source_graph_invalid:${validity.reason ?? 'unknown'}` };
    })
  };
}

function validateBlock(
  view: ModelContextProjectionGraphView,
  blockId: string,
  visiting: Set<string>
): CompressionSourceGraphValidity {
  if (visiting.has(blockId)) return invalid('compression_source_cycle', blockId);
  const block = view.facts.compressionBlocks.find((candidate) => candidate.id === blockId);
  if (!block) return invalid('compression_block_missing', blockId);
  if (block.staleReason || block.status === 'stale' || block.status === 'disabled' || block.status === 'error') {
    return invalid('compression_block_not_reusable', blockId);
  }
  const identity = compressionProjectionIdentity(view, blockId);
  if (!identity) return invalid('compression_projection_missing_or_ambiguous', blockId);
  if (identity.projection.purposeKind !== 'compression') return invalid('compression_projection_wrong_purpose', identity.projection.id);
  if (!block.sourceHash || identity.projection.fingerprint !== block.sourceHash) {
    return invalid('compression_projection_hash_mismatch', identity.projection.id);
  }
  let persistedFingerprint: string;
  try {
    persistedFingerprint = persistedModelContextProjectionFingerprint(identity.projection.contents, identity.sources, {
      ...(identity.projection.segments ? { segments: identity.projection.segments } : {}),
      ...(identity.projection.priorSummaryContents ? { priorSummaryContents: identity.projection.priorSummaryContents } : {}),
      ...(identity.projection.resultAddenda ? { resultAddenda: identity.projection.resultAddenda } : {})
    });
  } catch {
    return invalid('compression_projection_source_metadata_invalid', identity.projection.id);
  }
  if (persistedFingerprint !== identity.projection.fingerprint) {
    return invalid('compression_projection_fingerprint_invalid', identity.projection.id);
  }

  visiting.add(blockId);
  try {
    for (const source of identity.sources) {
      const validity = validateSource(view, source, visiting);
      if (!validity.valid) return validity;
    }
  } finally {
    visiting.delete(blockId);
  }
  return { valid: true };
}

function validateSource(
  view: ModelContextProjectionGraphView,
  source: ModelContextProjectionSourceLinkRecord,
  visiting: Set<string>
): CompressionSourceGraphValidity {
  switch (source.sourceKind) {
    case 'messageRevision': {
      const revision = view.facts.messageRevisions.find((candidate) => candidate.id === source.sourceId);
      if (!revision || revision.messageId !== source.messageId || source.revisionId !== revision.id) {
        return invalid('compression_message_revision_missing', source.sourceId);
      }
      const message = view.facts.messages.find((candidate) => candidate.id === revision.messageId);
      if (!message) return invalid('compression_message_missing', revision.messageId);
      if (revision.conversationId !== source.sourceConversationId || message.conversationId !== source.sourceConversationId) {
        return invalid('compression_message_source_conversation_changed', revision.messageId);
      }
      const runIds = view.facts.messageTurnLinks
        .filter((link) => link.messageId === revision.messageId)
        .map((link) => link.turnId);
      const runIdSet = new Set<string>(runIds);
      if (messageRevisionSourceFingerprint({
        revision,
        message,
        runIds,
        terminations: view.facts.runTerminations.filter((termination) => runIdSet.has(termination.runId))
      }) !== source.fingerprint) {
        return invalid('compression_message_revision_changed', source.sourceId);
      }
      const current = view.facts.messageCurrentRevisionLinks.filter((link) => link.messageId === revision.messageId);
      if (current.length !== 1 || current[0].revisionId !== revision.id) {
        return invalid('compression_message_revision_superseded', source.sourceId);
      }
      return { valid: true };
    }
    case 'compressionVariant': {
      const variant = view.facts.compressionContextVariants.find((candidate) => candidate.id === source.sourceId);
      const block = source.blockId
        ? view.facts.compressionBlocks.find((candidate) => candidate.id === source.blockId)
        : undefined;
      if (!variant || variant.blockId !== source.blockId || !block) return invalid('compression_predecessor_variant_missing', source.sourceId);
      if (block.conversationId !== source.sourceConversationId) return invalid('compression_predecessor_source_conversation_changed', source.sourceId);
      if (compressionVariantSourceFingerprint(variant) !== source.fingerprint) {
        return invalid('compression_predecessor_variant_changed', source.sourceId);
      }
      return validateBlock(view, variant.blockId, visiting);
    }
    case 'runTermination': {
      const termination = view.facts.runTerminations.find((candidate) => candidate.id === source.sourceId);
      const run = source.runId ? view.facts.runs.find((candidate) => candidate.id === source.runId) : undefined;
      if (!termination || termination.runId !== source.runId || !run) return invalid('compression_termination_missing', source.sourceId);
      if (run.conversationId !== source.sourceConversationId) return invalid('compression_termination_source_conversation_changed', source.sourceId);
      return runTerminationSourceFingerprint(termination) === source.fingerprint
        ? { valid: true }
        : invalid('compression_termination_changed', source.sourceId);
    }
    case 'toolCall': {
      const tool = view.facts.toolCalls.find((candidate) => candidate.id === source.sourceId);
      const message = source.messageId ? view.facts.messages.find((candidate) => candidate.id === source.messageId) : undefined;
      if (!tool || tool.messageId !== source.messageId || !message) return invalid('compression_tool_call_missing', source.sourceId);
      if (message.conversationId !== source.sourceConversationId) return invalid('compression_tool_source_conversation_changed', source.sourceId);
      return toolCallSourceFingerprint(tool, finalToolModelResponse(view.facts, tool.id)) === source.fingerprint
        ? { valid: true }
        : invalid('compression_tool_call_changed', source.sourceId);
    }
    case 'runtimeContextSnapshot': {
      const snapshot = view.facts.runtimeContextSnapshots.find((candidate) => candidate.id === source.sourceId);
      const run = source.runId ? view.facts.runs.find((candidate) => candidate.id === source.runId) : undefined;
      if (!snapshot || !run) return invalid('compression_runtime_snapshot_missing', source.sourceId);
      if (run.conversationId !== source.sourceConversationId) return invalid('compression_runtime_source_conversation_changed', source.sourceId);
      return runtimeContextSnapshotSourceFingerprint(snapshot) === source.fingerprint
        ? { valid: true }
        : invalid('compression_runtime_snapshot_changed', source.sourceId);
    }
  }
}

function finalToolModelResponse(facts: ModelContextFactView, toolCallId: string) {
  const links = facts.toolCallResultLinks.filter((link) => link.toolCallId === toolCallId && link.role === 'final');
  if (links.length > 1) return undefined;
  const artifactId = links[0]?.artifactId;
  return artifactId ? facts.toolResultArtifacts.find((artifact) => artifact.id === artifactId)?.modelResponse : undefined;
}

function invalid(reason: string, sourceId: string): CompressionSourceGraphValidity {
  return { valid: false, reason, sourceId };
}

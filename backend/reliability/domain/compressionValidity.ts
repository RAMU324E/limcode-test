import {
  compressionProjectionIdentity as projectionIdentity,
  validateCompressionSourceGraph,
  type CompressionSourceGraphValidity,
  type ModelContextProjectionGraphView
} from '../../modelContext/compressionSourceGraph';
import { modelContextFactsFromDurable } from '../modelContextDurableFacts';
import type { DurableConversationFacts } from './types';

export type CompressionValidityResult = CompressionSourceGraphValidity;

export function validateCompressionContextProjection(
  facts: DurableConversationFacts,
  blockId: string
): CompressionValidityResult {
  return validateCompressionSourceGraph(graphView(facts), blockId);
}

export function compressionProjectionIdentity(facts: DurableConversationFacts, blockId: string) {
  return projectionIdentity(graphView(facts), blockId);
}

function graphView(facts: DurableConversationFacts): ModelContextProjectionGraphView {
  return {
    facts: modelContextFactsFromDurable([facts]),
    projections: facts.modelContextProjections,
    sourceLinks: facts.modelContextProjectionSourceLinks,
    compressionLinks: facts.compressionModelContextProjectionLinks
  };
}

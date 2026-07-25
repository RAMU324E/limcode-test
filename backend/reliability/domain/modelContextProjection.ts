import type { ModelContextProjectionCommitData, CompressionModelContextProjectionCommitData } from '../../modelContext/projectionRecords';
import type { ModelContextProjectionSourceLinkRecord } from '../../../shared/protocol';
import type { ConversationTransitionBuilder } from './transitionBuilder';
import type { DurableConversationFacts } from './types';

export function appendRequestModelContextProjection(
  builder: ConversationTransitionBuilder,
  payload: ModelContextProjectionCommitData,
  createdAt: number
): void {
  appendProjection(builder, payload, createdAt);
  builder
    .generatedId(payload.requestLink.id)
    .upsert('requestModelContextProjectionLinks', { ...payload.requestLink, createdAt });
}

export function appendCompressionModelContextProjection(
  builder: ConversationTransitionBuilder,
  payload: CompressionModelContextProjectionCommitData,
  createdAt: number
): void {
  appendProjection(builder, payload, createdAt);
  builder
    .generatedId(payload.compressionLink.id)
    .upsert('compressionModelContextProjectionLinks', { ...payload.compressionLink, createdAt });
}

export function collectCompressionBlockDependencyClosure(
  facts: DurableConversationFacts,
  seeds: ReadonlySet<string>
): Set<string> {
  const result = new Set(seeds);
  const queue = [...result];
  const compressionProjectionById = new Map(
    facts.compressionModelContextProjectionLinks.map((link) => [link.projectionId, link.blockId])
  );
  while (queue.length > 0) {
    const sourceBlockId = queue.shift()!;
    for (const link of facts.compressionBlockSourceLinks) {
      if (link.sourceKind !== 'compressionBlock' || link.sourceId !== sourceBlockId || result.has(link.blockId)) continue;
      result.add(link.blockId);
      queue.push(link.blockId);
    }
    for (const source of facts.modelContextProjectionSourceLinks) {
      if (source.sourceKind !== 'compressionVariant' || source.blockId !== sourceBlockId) continue;
      const dependentBlockId = compressionProjectionById.get(source.projectionId);
      if (!dependentBlockId || result.has(dependentBlockId)) continue;
      result.add(dependentBlockId);
      queue.push(dependentBlockId);
    }
  }
  return result;
}

export function projectionIdsDependingOnSources(
  facts: DurableConversationFacts,
  predicate: (source: ModelContextProjectionSourceLinkRecord) => boolean
): Set<string> {
  return new Set(facts.modelContextProjectionSourceLinks.filter(predicate).map((source) => source.projectionId));
}

export function appendRemoveModelContextProjections(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  projectionIds: ReadonlySet<string>
): void {
  if (projectionIds.size === 0) return;
  builder.removeMany('modelContextProjectionSourceLinks', facts.modelContextProjectionSourceLinks
    .filter((source) => projectionIds.has(source.projectionId))
    .map((source) => source.id));
  builder.removeMany('requestModelContextProjectionLinks', facts.requestModelContextProjectionLinks
    .filter((link) => projectionIds.has(link.projectionId))
    .map((link) => link.id));
  builder.removeMany('compressionModelContextProjectionLinks', facts.compressionModelContextProjectionLinks
    .filter((link) => projectionIds.has(link.projectionId))
    .map((link) => link.id));
  builder.removeMany('modelContextProjections', projectionIds);
}

export function appendRemoveCompressionModelContextGraph(
  builder: ConversationTransitionBuilder,
  facts: DurableConversationFacts,
  blockIds: ReadonlySet<string>,
  additionalProjectionIds: ReadonlySet<string> = new Set()
): void {
  const projectionIds = new Set(additionalProjectionIds);
  for (const link of facts.compressionModelContextProjectionLinks) {
    if (blockIds.has(link.blockId)) projectionIds.add(link.projectionId);
  }
  for (const source of facts.modelContextProjectionSourceLinks) {
    if (source.sourceKind === 'compressionVariant' && source.blockId && blockIds.has(source.blockId)) {
      projectionIds.add(source.projectionId);
    }
  }
  appendRemoveModelContextProjections(builder, facts, projectionIds);
}

function appendProjection(
  builder: ConversationTransitionBuilder,
  payload: Pick<ModelContextProjectionCommitData, 'projection' | 'sources'>,
  createdAt: number
): void {
  builder
    .generatedId(payload.projection.id, ...payload.sources.map((source) => source.id))
    .upsert('modelContextProjections', { ...clone(payload.projection), createdAt });
  for (const source of payload.sources) builder.upsert('modelContextProjectionSourceLinks', clone(source));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

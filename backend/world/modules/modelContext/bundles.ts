import { stableIdFromSeed } from '../../../reliability/stableIdFactory';
import { buildCompressionModelContextProjectionCommitData } from '../../../modelContext/projectionRecords';
import type { ModelContextProjection as ModelContextProjectionValue } from '../../../modelContext/types';
import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import { CompressionBlock } from '../compression/components';
import {
  CompressionModelContextProjectionLink,
  ModelContextProjection,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink
} from './components';

export function despawnModelContextProjectionsForCompressionBlocks(
  world: WorldReader,
  cmd: CommandSink,
  blocks: ReadonlySet<Entity>
): void {
  despawnModelContextProjections(world, cmd, modelContextProjectionsForCompressionBlocks(world, blocks));
}

export function modelContextProjectionsForCompressionBlocks(
  world: WorldReader,
  blocks: ReadonlySet<Entity>
): Set<Entity> {
  const blockIds = new Set([...blocks].flatMap((block) => {
    const data = world.get(block, CompressionBlock);
    return data ? [data.id] : [];
  }));
  const projections = new Set<Entity>();
  for (const entity of world.query(CompressionModelContextProjectionLink)) {
    const link = world.get(entity, CompressionModelContextProjectionLink);
    if (link && blocks.has(link.block)) projections.add(link.projection);
  }
  for (const entity of world.query(ModelContextProjectionSourceLink)) {
    const source = world.get(entity, ModelContextProjectionSourceLink);
    if (source?.sourceKind === 'compressionVariant' && source.blockId && blockIds.has(source.blockId)) {
      projections.add(source.projection);
    }
  }
  return projections;
}

export function despawnModelContextProjections(
  world: WorldReader,
  cmd: CommandSink,
  projections: ReadonlySet<Entity>
): void {
  for (const entity of world.query(ModelContextProjectionSourceLink)) {
    const projection = world.get(entity, ModelContextProjectionSourceLink)?.projection;
    if (projection !== undefined && projections.has(projection)) cmd.despawn(entity);
  }
  for (const entity of world.query(ModelContextProjectionConversationLink)) {
    const projection = world.get(entity, ModelContextProjectionConversationLink)?.projection;
    if (projection !== undefined && projections.has(projection)) cmd.despawn(entity);
  }
  for (const entity of world.query(RequestModelContextProjectionLink)) {
    const projection = world.get(entity, RequestModelContextProjectionLink)?.projection;
    if (projection !== undefined && projections.has(projection)) cmd.despawn(entity);
  }
  for (const entity of world.query(CompressionModelContextProjectionLink)) {
    const projection = world.get(entity, CompressionModelContextProjectionLink)?.projection;
    if (projection !== undefined && projections.has(projection)) cmd.despawn(entity);
  }
  for (const projection of projections) cmd.despawn(projection);
}

export function spawnCompressionModelContextProjection(
  world: WorldReader,
  cmd: CommandSink,
  input: {
    conversation: Entity;
    block: Entity;
    blockId: string;
    projection: ModelContextProjectionValue;
    now: number;
  }
): Entity {
  const conversation = world.get(input.conversation, Conversation);
  if (!conversation) throw new Error('Cannot persist compression context for a missing Conversation.');
  const records = buildCompressionModelContextProjectionCommitData(input.projection, input.blockId, conversation.id);
  const existingLinks = world.query(CompressionModelContextProjectionLink)
    .map((entity) => ({ entity, data: world.get(entity, CompressionModelContextProjectionLink) }))
    .filter((candidate) => candidate.data?.block === input.block && candidate.data.role === 'source');
  if (existingLinks.length > 1) throw new Error(`CompressionBlock ${input.blockId} has multiple ModelContext source projections.`);
  if (existingLinks[0]) {
    const existing = world.get(existingLinks[0].data!.projection, ModelContextProjection);
    if (existing?.fingerprint !== input.projection.fingerprint) {
      throw new Error(`CompressionBlock ${input.blockId} already has a different ModelContextProjection.`);
    }
    return existingLinks[0].data!.projection;
  }

  const projectionEntity = cmd.spawn();
  const { conversationId: _conversationId, ...projectionData } = records.projection;
  cmd.add(projectionEntity, ModelContextProjection, { ...projectionData, createdAt: input.now });

  const conversationLink = cmd.spawn();
  cmd.add(conversationLink, ModelContextProjectionConversationLink, {
    id: stableIdFromSeed('relation', `${records.projection.id}:conversation`),
    projection: projectionEntity,
    conversation: input.conversation
  });
  for (const source of records.sources) {
    const sourceEntity = cmd.spawn();
    const { projectionId: _projectionId, ...sourceData } = source;
    cmd.add(sourceEntity, ModelContextProjectionSourceLink, { ...sourceData, projection: projectionEntity });
  }
  const compressionLink = cmd.spawn();
  const { projectionId: _projectionId, blockId: _blockId, ...linkData } = records.compressionLink;
  cmd.add(compressionLink, CompressionModelContextProjectionLink, {
    ...linkData,
    projection: projectionEntity,
    block: input.block,
    createdAt: input.now
  });
  return projectionEntity;
}

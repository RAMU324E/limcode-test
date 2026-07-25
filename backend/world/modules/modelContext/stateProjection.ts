import type { ClientState } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Conversation } from '../chat/components';
import { CompressionBlock } from '../compression/components';
import {
  CompressionModelContextProjectionLink,
  ModelContextProjection,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink
} from './components';

export const modelContextStateProjectionReads: AccessDeclaration = {
  components: [
    Conversation,
    CompressionBlock,
    ModelContextProjection,
    ModelContextProjectionConversationLink,
    ModelContextProjectionSourceLink,
    RequestModelContextProjectionLink,
    CompressionModelContextProjectionLink
  ]
};

export function projectModelContextState(world: WorldReader): Partial<ClientState> {
  const conversationByProjection = new Map<number, string>();
  for (const entity of world.query(ModelContextProjectionConversationLink)) {
    const link = world.get(entity, ModelContextProjectionConversationLink);
    const conversation = link ? world.get(link.conversation, Conversation) : undefined;
    if (link && conversation) conversationByProjection.set(link.projection, conversation.id);
  }
  return {
    modelContextProjections: world.query(ModelContextProjection).flatMap((entity) => {
      const projection = world.get(entity, ModelContextProjection);
      const conversationId = conversationByProjection.get(entity);
      return projection && conversationId ? [{ ...projection, conversationId }] : [];
    }),
    modelContextProjectionSourceLinks: world.query(ModelContextProjectionSourceLink).flatMap((entity) => {
      const link = world.get(entity, ModelContextProjectionSourceLink);
      const projection = link ? world.get(link.projection, ModelContextProjection) : undefined;
      if (!link || !projection) return [];
      const { projection: _projection, ...rest } = link;
      return [{ ...rest, projectionId: projection.id }];
    }),
    requestModelContextProjectionLinks: world.query(RequestModelContextProjectionLink).flatMap((entity) => {
      const link = world.get(entity, RequestModelContextProjectionLink);
      const projection = link ? world.get(link.projection, ModelContextProjection) : undefined;
      if (!link || !projection) return [];
      const { projection: _projection, ...rest } = link;
      return [{ ...rest, projectionId: projection.id }];
    }),
    compressionModelContextProjectionLinks: world.query(CompressionModelContextProjectionLink).flatMap((entity) => {
      const link = world.get(entity, CompressionModelContextProjectionLink);
      const projection = link ? world.get(link.projection, ModelContextProjection) : undefined;
      const block = link ? world.get(link.block, CompressionBlock) : undefined;
      if (!link || !projection || !block) return [];
      const { projection: _projection, block: _block, ...rest } = link;
      return [{ ...rest, projectionId: projection.id, blockId: block.id }];
    })
  };
}

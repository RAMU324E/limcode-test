import type {
  CompressionModelContextProjectionLinkRecord,
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord,
  RequestModelContextProjectionLinkRecord
} from '../../../../shared/protocol';
import { defineComponent, type Entity } from '../../../ecs/types';

export type ModelContextProjectionData = Omit<ModelContextProjectionRecord, 'conversationId'>;
export const ModelContextProjection = defineComponent<ModelContextProjectionData>('ModelContextProjection');

export interface ModelContextProjectionConversationLinkData {
  id: string;
  projection: Entity;
  conversation: Entity;
}
export const ModelContextProjectionConversationLink = defineComponent<ModelContextProjectionConversationLinkData>('ModelContextProjectionConversationLink');

export type ModelContextProjectionSourceLinkData = Omit<ModelContextProjectionSourceLinkRecord, 'projectionId'> & { projection: Entity };
export const ModelContextProjectionSourceLink = defineComponent<ModelContextProjectionSourceLinkData>('ModelContextProjectionSourceLink');

export type RequestModelContextProjectionLinkData = Omit<RequestModelContextProjectionLinkRecord, 'projectionId'> & { projection: Entity };
export const RequestModelContextProjectionLink = defineComponent<RequestModelContextProjectionLinkData>('RequestModelContextProjectionLink');

export type CompressionModelContextProjectionLinkData = Omit<CompressionModelContextProjectionLinkRecord, 'projectionId' | 'blockId'> & {
  projection: Entity;
  block: Entity;
};
export const CompressionModelContextProjectionLink = defineComponent<CompressionModelContextProjectionLinkData>('CompressionModelContextProjectionLink');

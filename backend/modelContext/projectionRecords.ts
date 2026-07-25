import type {
  ModelContextProjectionRecord,
  ModelContextProjectionSourceLinkRecord,
  RequestModelContextProjectionLinkRecord,
  CompressionModelContextProjectionLinkRecord
} from '../../shared/protocol';
import { stableIdFromSeed } from '../reliability/stableIdFactory';
import type { ModelContextProjection, ModelContextSourceRef } from './types';

export interface ModelContextProjectionCommitData {
  projection: Omit<ModelContextProjectionRecord, 'createdAt'>;
  sources: ModelContextProjectionSourceLinkRecord[];
  requestLink: Omit<RequestModelContextProjectionLinkRecord, 'createdAt'>;
}

export interface CompressionModelContextProjectionCommitData {
  projection: Omit<ModelContextProjectionRecord, 'createdAt'>;
  sources: ModelContextProjectionSourceLinkRecord[];
  compressionLink: Omit<CompressionModelContextProjectionLinkRecord, 'createdAt'>;
}

export function buildModelContextProjectionCommitData(
  projection: ModelContextProjection,
  requestId: string,
  conversationId: string
): ModelContextProjectionCommitData {
  if (projection.purpose.kind !== 'turn') throw new Error('LLM Request context must use a turn projection.');
  const projectionId = stableIdFromSeed('contextProjection', `${requestId}:${projection.fingerprint}`);
  const sources = projectionSourceLinks(projection, projectionId, conversationId);
  return {
    projection: {
      id: projectionId,
      conversationId,
      purposeKind: 'turn',
      mode: projection.purpose.mode,
      contents: clone(projection.contents),
      fingerprint: projection.fingerprint,
      tokenCount: projection.tokenCount,
      modelMessageId: projection.purpose.turn.modelMessageId,
      runId: projection.purpose.turn.runId,
      diagnostics: projection.diagnostics.map(({ code, severity, sourceId }) => ({ code, severity, ...(sourceId ? { sourceId } : {}) }))
    },
    sources,
    requestLink: {
      id: stableIdFromSeed('relation', `${requestId}:model-context-input`),
      requestId,
      projectionId,
      role: 'input'
    }
  };
}

export function buildCompressionModelContextProjectionCommitData(
  projection: ModelContextProjection,
  blockId: string,
  conversationId: string
): CompressionModelContextProjectionCommitData {
  if (projection.purpose.kind !== 'compression') throw new Error('Compression source must use a compression projection.');
  const projectionId = stableIdFromSeed('contextProjection', `${blockId}:${projection.fingerprint}`);
  return {
    projection: {
      id: projectionId,
      conversationId,
      purposeKind: 'compression',
      mode: projection.purpose.mode,
      contents: clone(projection.contents),
      fingerprint: projection.fingerprint,
      tokenCount: projection.tokenCount,
      ...(projection.compression ? {
        segments: clone(projection.compression.segments),
        ...(projection.compression.priorSummaryContents ? { priorSummaryContents: clone(projection.compression.priorSummaryContents) } : {}),
        resultAddenda: clone(projection.compression.resultAddenda)
      } : {}),
      diagnostics: projection.diagnostics.map(({ code, severity, sourceId }) => ({ code, severity, ...(sourceId ? { sourceId } : {}) }))
    },
    sources: projectionSourceLinks(projection, projectionId, conversationId),
    compressionLink: {
      id: stableIdFromSeed('relation', `${blockId}:model-context-source`),
      blockId,
      projectionId,
      role: 'source'
    }
  };
}

function projectionSourceLinks(
  projection: ModelContextProjection,
  projectionId: string,
  conversationId: string
): ModelContextProjectionSourceLinkRecord[] {
  return projection.orderedSources.map((source, order): ModelContextProjectionSourceLinkRecord => ({
    id: stableIdFromSeed('relation', `${projectionId}:source:${order}:${source.id}`),
    conversationId,
    sourceConversationId: source.sourceConversationId,
    projectionId,
    sourceKind: source.kind,
    sourceId: modelContextSourceId(source),
    fingerprint: source.fingerprint,
    order,
    ...(source.kind === 'messageRevision'
      ? { messageId: source.messageId, revisionId: source.revisionId, seq: source.seq }
      : source.kind === 'compressionVariant'
        ? { blockId: source.blockId }
        : source.kind === 'runTermination'
          ? { runId: source.runId }
          : source.kind === 'toolCall'
            ? { messageId: source.messageId }
            : source.kind === 'runtimeContextSnapshot'
              ? { runId: source.runId }
              : {})
  }));
}

function modelContextSourceId(source: ModelContextSourceRef): string {
  switch (source.kind) {
    case 'messageRevision': return source.revisionId;
    case 'compressionVariant': return source.variantId;
    case 'runTermination': return source.terminationId;
    case 'toolCall': return source.toolCallId;
    case 'runtimeContextSnapshot': return source.snapshotId;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

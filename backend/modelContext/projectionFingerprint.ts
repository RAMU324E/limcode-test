import type {
  MessageContent,
  ModelContextProjectionSourceLinkRecord
} from '../../shared/protocol';
import type { JsonValue } from '../../shared/conversationReliability';
import { canonicalSha256 } from '../reliability/canonicalJson';
import type { ModelContextSourceRef } from './types';

export interface ModelContextProjectionFingerprintArtifacts {
  segments?: readonly (readonly MessageContent[])[];
  priorSummaryContents?: readonly MessageContent[];
  resultAddenda?: readonly MessageContent[];
}

export function modelContextProjectionFingerprint(
  contents: readonly MessageContent[],
  sources: readonly ModelContextSourceRef[],
  artifacts: ModelContextProjectionFingerprintArtifacts = {}
): string {
  return canonicalSha256(fingerprintPayload(contents, sources, artifacts) as unknown as JsonValue);
}

export function persistedModelContextProjectionFingerprint(
  contents: readonly MessageContent[],
  orderedSources: readonly ModelContextProjectionSourceLinkRecord[],
  artifacts: ModelContextProjectionFingerprintArtifacts = {}
): string {
  return canonicalSha256(fingerprintPayload(contents, orderedSources.map(modelContextSourceRefFromLink), artifacts) as unknown as JsonValue);
}

function fingerprintPayload(
  contents: readonly MessageContent[],
  sources: readonly ModelContextSourceRef[],
  artifacts: ModelContextProjectionFingerprintArtifacts
): Record<string, unknown> {
  return {
    contents,
    sources,
    ...(artifacts.segments ? { segments: artifacts.segments } : {}),
    ...(artifacts.priorSummaryContents ? { priorSummaryContents: artifacts.priorSummaryContents } : {}),
    ...(artifacts.resultAddenda ? { resultAddenda: artifacts.resultAddenda } : {})
  };
}

export function modelContextSourceRefFromLink(
  source: ModelContextProjectionSourceLinkRecord
): ModelContextSourceRef {
  const id = `${source.sourceKind}:${source.sourceId}`;
  switch (source.sourceKind) {
    case 'messageRevision':
      if (!source.messageId || !source.revisionId || source.seq === undefined) {
        throw new Error(`MessageRevision projection source is incomplete: ${source.id}`);
      }
      return {
        kind: source.sourceKind,
        id,
        sourceConversationId: source.sourceConversationId,
        messageId: source.messageId,
        revisionId: source.revisionId,
        seq: source.seq,
        fingerprint: source.fingerprint
      };
    case 'compressionVariant':
      if (!source.blockId) throw new Error(`CompressionVariant projection source is incomplete: ${source.id}`);
      return {
        kind: source.sourceKind,
        id,
        sourceConversationId: source.sourceConversationId,
        blockId: source.blockId,
        variantId: source.sourceId,
        fingerprint: source.fingerprint
      };
    case 'runTermination':
      if (!source.runId) throw new Error(`RunTermination projection source is incomplete: ${source.id}`);
      return {
        kind: source.sourceKind,
        id,
        sourceConversationId: source.sourceConversationId,
        runId: source.runId,
        terminationId: source.sourceId,
        fingerprint: source.fingerprint
      };
    case 'toolCall':
      if (!source.messageId) throw new Error(`ToolCall projection source is incomplete: ${source.id}`);
      return {
        kind: source.sourceKind,
        id,
        sourceConversationId: source.sourceConversationId,
        toolCallId: source.sourceId,
        messageId: source.messageId,
        fingerprint: source.fingerprint
      };
    case 'runtimeContextSnapshot':
      if (!source.runId) throw new Error(`RuntimeContextSnapshot projection source is incomplete: ${source.id}`);
      return {
        kind: source.sourceKind,
        id,
        sourceConversationId: source.sourceConversationId,
        snapshotId: source.sourceId,
        runId: source.runId,
        fingerprint: source.fingerprint
      };
  }
}

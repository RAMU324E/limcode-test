import type {
  CompressionContextVariantRecord,
  MessageRecord,
  MessageRevisionRecord,
  RunTerminationRecord,
  RuntimeContextSnapshotRecord,
  ToolCallRecord
} from '../../shared/protocol';
import type { JsonValue } from '../../shared/conversationReliability';
import { canonicalSha256 } from '../reliability/canonicalJson';

/**
 * Fingerprints the exact semantic fact consumed by a model-context projection.
 * These functions are shared by projection, durable validation, and late-completion CAS.
 */
export function messageRevisionSourceFingerprint(input: {
  revision: Pick<MessageRevisionRecord, 'id' | 'messageId' | 'content'>;
  message: Pick<MessageRecord, 'id' | 'role' | 'status' | 'seq'>;
  runIds: readonly string[];
  terminations: readonly RunTerminationRecord[];
}): string {
  const runIds = [...new Set(input.runIds)].sort();
  const terminationByRun = new Map(input.terminations.map((termination) => [termination.runId, termination]));
  return canonicalSha256({
    revisionId: input.revision.id,
    messageId: input.revision.messageId,
    content: input.revision.content,
    message: input.message,
    runs: runIds.map((runId) => ({ runId, termination: terminationByRun.get(runId) ?? null }))
  } as unknown as JsonValue);
}

export function compressionVariantSourceFingerprint(variant: CompressionContextVariantRecord): string {
  return canonicalSha256(variant as unknown as JsonValue);
}

export function runTerminationSourceFingerprint(termination: RunTerminationRecord): string {
  return canonicalSha256(termination as unknown as JsonValue);
}

export function toolCallSourceFingerprint(tool: ToolCallRecord, modelResponse?: JsonValue): string {
  return canonicalSha256({
    tool,
    modelResponse: modelResponse ?? null
  } as unknown as JsonValue);
}

export function runtimeContextSnapshotSourceFingerprint(snapshot: RuntimeContextSnapshotRecord): string {
  return canonicalSha256({
    text: snapshot.text,
    sourceHash: snapshot.sourceHash ?? null,
    refreshedAt: snapshot.refreshedAt
  } as unknown as JsonValue);
}

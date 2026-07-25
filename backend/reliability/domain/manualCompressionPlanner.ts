import type {
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  MessageRecord
} from '../../../shared/protocol';
import { projectModelContext } from '../../modelContext/modelContextProjector';
import { buildCompressionModelContextProjectionCommitData } from '../../modelContext/projectionRecords';
import { modelContextFactsFromDurable } from '../modelContextDurableFacts';
import { stableIdFromSeed } from '../stableIdFactory';
import type { ReliableCompressionBarrierPlan } from './preflightTypes';
import type { DurableConversationFacts } from './types';

export interface ReliableManualCompressionInput {
  startMessageId?: string;
  endMessageId?: string;
  methodConfigId?: string;
  methodKind?: CompressionBlockRecord['methodKind'];
  replaceBlockId?: string;
}

/** Pure manual-compression planner over a complete committed conversation view. */

export function planReliableManualCompression(
  facts: DurableConversationFacts,
  input: ReliableManualCompressionInput,
  seed: string,
  now: number
): ReliableCompressionBarrierPlan {
  const replacement = input.replaceBlockId
    ? unique(facts.compressionBlocks, input.replaceBlockId, 'CompressionBlock to regenerate')
    : undefined;
  if (input.replaceBlockId && !replacement) throw new Error(`CompressionBlock not found: ${input.replaceBlockId}`);
  if (replacement && (replacement.status === 'pending' || replacement.status === 'running')) {
    throw new Error(`Active CompressionBlock cannot be regenerated: ${replacement.id}`);
  }
  const methodKind = input.methodKind ?? replacement?.methodKind ?? 'llm_summary';
  const methodConfigId = input.methodConfigId ?? replacement?.methodConfigId;
  const endMessageId = replacement?.anchorMessageId ?? input.endMessageId;
  const projection = projectModelContext({
    facts: modelContextFactsFromDurable([facts]),
    purpose: {
      kind: 'compression',
      mode: 'manual',
      conversationId: facts.conversation.id,
      ...(replacement ? {} : input.startMessageId ? { startMessageId: input.startMessageId } : {}),
      ...(endMessageId ? { endMessageId } : {}),
      methodKind
    }
  });
  const errors = projection.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) throw new Error(`Compression context projection failed: ${errors.map((item) => item.code).join(', ')}`);
  const compression = projection.compression;
  if (!compression?.anchorMessageId || compression.anchorSeq === undefined || compression.selectedMessageIds.length === 0 || projection.contents.length === 0) {
    throw new Error('Compression selection has no closed, serializable context.');
  }
  const selected = compression.selectedMessageIds
    .map((messageId) => facts.messages.find((message) => message.id === messageId))
    .filter((message): message is MessageRecord => !!message)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  if (selected.length === 0) throw new Error('Compression selection has no source Messages.');
  const predecessor = compression.priorBlockId
    ? facts.compressionBlocks.find((block) => block.id === compression.priorBlockId)
    : undefined;
  const anchor = selected[selected.length - 1];
  const blockId = stableIdFromSeed('compression', `${seed}:block:${anchor.id}`);
  const compactRequestId = stableIdFromSeed('request', `${seed}:request:${anchor.id}`);
  const compactInvocationId = stableIdFromSeed('invocation', `${seed}:invocation:${anchor.id}`);
  const block: CompressionBlockRecord = {
    id: blockId,
    conversationId: facts.conversation.id,
    title: '上下文压缩',
    status: 'running',
    trigger: 'manual',
    methodKind,
    ...(methodConfigId ? { methodConfigId } : {}),
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    startSeq: predecessor?.startSeq ?? selected[0].seq,
    endSeq: anchor.seq,
    sourceMessageCount: (predecessor?.sourceMessageCount ?? 0) + selected.length,
    tokenCountBefore: projection.tokenCount,
    sourceHash: projection.fingerprint,
    createdAt: now,
    updatedAt: now
  };
  const sourceLinks: CompressionBlockSourceLinkRecord[] = [];
  if (predecessor) {
    sourceLinks.push({ id: stableIdFromSeed('relation', `${seed}:retained:${predecessor.id}`), blockId, sourceKind: 'compressionBlock', sourceId: predecessor.id, role: 'retained', order: 0, createdAt: now, updatedAt: now });
  }
  projection.messageSelections.forEach((selection, index) => {
    sourceLinks.push({
      id: stableIdFromSeed('relation', `${seed}:source:${selection.messageId}`),
      blockId,
      sourceKind: 'message',
      sourceId: selection.messageId,
      revisionId: selection.revisionId,
      role: selection.messageId === anchor.id ? 'anchor' : 'source',
      order: index + (predecessor ? 1 : 0),
      createdAt: now,
      updatedAt: now
    });
  });
  return {
    block,
    sourceLinks,
    variantId: stableIdFromSeed('relation', `${seed}:variant:${blockId}`),
    compactRequest: {
      id: compactRequestId,
      blockId,
      conversationId: facts.conversation.id,
      invocationId: compactInvocationId,
      ...(methodConfigId ? { methodConfigId } : {}),
      methodKind,
      contents: clone(projection.contents),
      ...(methodKind === 'segmented_summary' ? {
        segments: clone(compression.segments),
        ...(compression.priorSummaryContents ? { priorSummaryContents: clone(compression.priorSummaryContents) } : {})
      } : {}),
      sourceHash: projection.fingerprint
    },
    contextProjection: buildCompressionModelContextProjectionCommitData(projection, blockId, facts.conversation.id)
  };
}



function unique<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

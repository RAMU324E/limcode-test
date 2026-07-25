import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { isUserVisibleTimelineMessage } from '../../../shared/messagePresentation';
import type {
  ClientState,
  ConversationTimelineChunkSummaryRecord,
  ConversationTimelinePageRecord,
  ConversationTimelinePageRequest
} from '../../../shared/protocol';
import type { TimelineProjectionContextRecord } from '../../../shared/timelineProjection';
import { markClientStateAttachmentsForClient } from '../../capabilities/vscodeStorage/attachmentStore';
import { BUILTIN_TIMELINE_PROJECTIONS } from '../../capabilities/vscodeStorage/timelineProjections';
import type { DurableConversationFacts } from '../domain/types';
import { factsToClientState } from '../runtimeAuthorityStore';
import { conversationTimelineChunks } from '../storageCompilers/timelineCompiler';

const DEFAULT_PAGE_CHUNKS = 2;
const MAX_PAGE_CHUNKS = 5;

interface ProjectedChunk {
  id: string;
  index: number;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  messageOffsetStart: number;
  messageOffsetEnd: number;
  toolCallCount: number;
  toolCallEventCount: number;
  messageIds: string[];
  data: ReturnType<typeof conversationTimelineChunks>[number];
}

/** Pure timeline page/read-model projection from one committed conversation aggregate. */
export function projectConversationTimelinePage(
  facts: DurableConversationFacts,
  request: ConversationTimelinePageRequest,
  now = Date.now()
): ConversationTimelinePageRecord {
  if (facts.conversation.id !== request.conversationId) {
    throw new Error(`Timeline projection requested ${request.conversationId} from ${facts.conversation.id}.`);
  }
  if (!Number.isFinite(now)) throw new Error('Timeline projection timestamp is invalid.');
  const chunks = describeChunks(conversationTimelineChunks(facts));
  const selected = selectChunks(chunks, request);
  const state = projectPageState(facts, selected);
  const projections = projectRequestedContexts(facts.conversation.id, chunks, selected[0], request.includeProjections ?? []);
  return {
    conversationId: request.conversationId,
    applyMode: applyMode(request.direction),
    chunks: selected.map(toSummary),
    pageInfo: pageInfo(request.conversationId, chunks, selected, now),
    state,
    ...(Object.keys(projections).length > 0 ? { projections } : {})
  };
}

function describeChunks(data: ReturnType<typeof conversationTimelineChunks>): ProjectedChunk[] {
  let visibleOffset = 0;
  return data.map((chunk, index) => {
    const visible = chunk.messages.filter(isUserVisibleTimelineMessage);
    const seqs = (visible.length > 0 ? visible : chunk.messages).map((message) => message.seq);
    const record: ProjectedChunk = {
      id: index.toString().padStart(6, '0'),
      index,
      startSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
      endSeq: seqs.length > 0 ? Math.max(...seqs) : 0,
      messageCount: visible.length,
      messageOffsetStart: visibleOffset + 1,
      messageOffsetEnd: visibleOffset + visible.length,
      toolCallCount: chunk.toolCalls.length,
      toolCallEventCount: chunk.toolCallEvents.length,
      messageIds: chunk.messages.map((message) => message.id),
      data: chunk
    };
    visibleOffset += visible.length;
    return record;
  });
}

function selectChunks(chunks: readonly ProjectedChunk[], request: ConversationTimelinePageRequest): ProjectedChunk[] {
  const direction = request.direction ?? 'initial';
  const count = pageChunkCount(request.chunkCount);
  if (direction === 'initial') {
    if (request.cursor !== undefined || request.anchorMessageId !== undefined) {
      throw new Error('Initial timeline page must not carry a cursor or anchorMessageId.');
    }
    return chunks.slice(Math.max(0, chunks.length - count));
  }
  if (!request.cursor && !request.anchorMessageId) throw new Error(`${direction} timeline page requires a cursor or anchorMessageId.`);
  const matches = request.anchorMessageId
    ? chunks.filter((chunk) => chunk.messageIds.includes(request.anchorMessageId!))
    : chunks.filter((chunk) => chunk.id === request.cursor || String(chunk.index) === request.cursor);
  if (matches.length !== 1) {
    throw new Error(`Timeline page cursor resolves to ${matches.length} chunks for ${request.conversationId}.`);
  }
  const cursorIndex = matches[0].index;
  if (direction === 'older') return chunks.slice(Math.max(0, cursorIndex - count), cursorIndex);
  if (direction === 'newer') return chunks.slice(cursorIndex + 1, Math.min(chunks.length, cursorIndex + 1 + count));
  if (direction !== 'around') throw new Error(`Unsupported timeline page direction: ${direction}`);
  const before = Math.floor((count - 1) / 2);
  const start = Math.max(0, cursorIndex - before);
  return chunks.slice(start, Math.min(chunks.length, start + count));
}

function projectPageState(facts: DurableConversationFacts, selected: readonly ProjectedChunk[]): ClientState {
  const full = factsToClientState(facts);
  const state = createEmptyClientState();
  const messageIds = new Set(selected.flatMap((chunk) => chunk.data.messages.map((message) => message.id)));
  const revisionIds = new Set(selected.flatMap((chunk) => chunk.data.messageRevisions.map((record) => record.id)));
  const toolCallIds = new Set(selected.flatMap((chunk) => chunk.data.toolCalls.map((record) => record.id)));
  const projectContextIds = new Set(selected.flatMap((chunk) => chunk.data.projectContexts.map((record) => record.id)));
  const shadowRepositoryIds = new Set(selected.flatMap((chunk) => chunk.data.shadowRepositories.map((record) => record.id)));
  const conversationCheckpointLinkIds = new Set(selected.flatMap((chunk) => chunk.data.conversationCheckpointRepositoryLinks.map((record) => record.id)));
  const checkpointIds = new Set(selected.flatMap((chunk) => chunk.data.checkpoints.map((record) => record.id)));
  const checkpointAnchorIds = new Set(selected.flatMap((chunk) => chunk.data.checkpointTimelineAnchors.map((record) => record.id)));

  state.messages = full.messages.filter((record) => messageIds.has(record.id));
  state.messageRevisions = full.messageRevisions.filter((record) => revisionIds.has(record.id));
  state.messageCurrentRevisionLinks = full.messageCurrentRevisionLinks.filter((record) => messageIds.has(record.messageId) || revisionIds.has(record.revisionId));
  state.toolCalls = full.toolCalls.filter((record) => toolCallIds.has(record.id));
  state.toolCallEvents = full.toolCallEvents.filter((record) => toolCallIds.has(record.toolCallId));
  state.toolCallResultLinks = full.toolCallResultLinks.filter((record) => toolCallIds.has(record.toolCallId));
  const artifactIds = new Set(state.toolCallResultLinks.map((record) => record.artifactId));
  state.toolResultArtifacts = full.toolResultArtifacts.filter((record) => artifactIds.has(record.id));
  state.interactionOwnerLinks = full.interactionOwnerLinks.filter((record) =>
    record.sourceToolCallId !== undefined && toolCallIds.has(record.sourceToolCallId));
  const interactionRequestIds = new Set(state.interactionOwnerLinks.map((record) => record.interactionRequestId));
  state.interactionRequests = full.interactionRequests.filter((record) => interactionRequestIds.has(record.id));
  state.interactionResponses = full.interactionResponses.filter((record) => interactionRequestIds.has(record.interactionRequestId));
  state.projectContexts = full.projectContexts.filter((record) => projectContextIds.has(record.id));
  state.shadowRepositories = full.shadowRepositories.filter((record) => shadowRepositoryIds.has(record.id));
  state.conversationCheckpointRepositoryLinks = full.conversationCheckpointRepositoryLinks.filter((record) => conversationCheckpointLinkIds.has(record.id));
  state.checkpoints = full.checkpoints.filter((record) => checkpointIds.has(record.id));
  state.checkpointTimelineAnchors = full.checkpointTimelineAnchors.filter((record) => checkpointAnchorIds.has(record.id));
  projectCompressionTables(full, state, selected[0]?.startSeq, selected[selected.length - 1]?.endSeq);
  return markClientStateAttachmentsForClient(state);
}

function projectCompressionTables(full: ClientState, target: ClientState, startSeq: number | undefined, endSeq: number | undefined): void {
  if (startSeq === undefined || endSeq === undefined) return;
  const latestBefore = full.compressionBlocks
    .filter((block) => block.status === 'complete' && (block.anchorSeq ?? block.endSeq) !== undefined && (block.anchorSeq ?? block.endSeq)! < startSeq)
    .sort((left, right) => (right.anchorSeq ?? right.endSeq ?? 0) - (left.anchorSeq ?? left.endSeq ?? 0)
      || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
  const blocks = full.compressionBlocks.filter((block) => {
    const seq = block.anchorSeq ?? block.endSeq;
    return seq !== undefined && seq >= startSeq && seq <= endSeq;
  });
  if (latestBefore && !blocks.some((block) => block.id === latestBefore.id)) blocks.push(latestBefore);
  const blockIds = new Set(blocks.map((block) => block.id));
  target.compressionBlocks = blocks;
  target.compressionBlockSourceLinks = full.compressionBlockSourceLinks.filter((link) => blockIds.has(link.blockId));
  target.compressionContextVariants = full.compressionContextVariants.filter((variant) => blockIds.has(variant.blockId));
  target.compressionBlockLlmInvocationLinks = full.compressionBlockLlmInvocationLinks.filter((link) => blockIds.has(link.blockId));
  const invocationIds = new Set(target.compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  target.llmInvocations = full.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));
}

function projectRequestedContexts(
  conversationId: string,
  chunks: readonly ProjectedChunk[],
  current: ProjectedChunk | undefined,
  requestedKeys: readonly string[]
): Record<string, TimelineProjectionContextRecord> {
  if (requestedKeys.length === 0) return {};
  if (!current || chunks.length === 0) return {};
  if (new Set(requestedKeys).size !== requestedKeys.length) throw new Error('Timeline projection request contains duplicate keys.');
  const result: Record<string, TimelineProjectionContextRecord> = {};
  for (const key of requestedKeys) {
    const spec = BUILTIN_TIMELINE_PROJECTIONS.find((candidate) => candidate.key === key);
    if (!spec) throw new Error(`Unknown timeline projection: ${key}`);
    let snapshot = spec.emptySnapshot();
    let operationIndex = 0;
    let snapshotBeforeCurrent: unknown;
    let snapshotAfterCurrent: unknown;
    for (const chunk of chunks) {
      if (chunk.id === current.id) snapshotBeforeCurrent = snapshot;
      const reduced = spec.reduceChunk({
        conversationId,
        chunkId: chunk.id,
        chunk: chunk.data,
        previousSnapshot: snapshot,
        operationStartIndex: operationIndex
      });
      snapshot = reduced.snapshotAfterChunk;
      operationIndex = reduced.operationEndIndex;
      if (chunk.id === current.id) snapshotAfterCurrent = snapshot;
    }
    const latest = chunks[chunks.length - 1];
    result[key] = {
      conversationId,
      chunkId: current.id,
      currentChunkStartSeq: current.startSeq,
      currentChunkEndSeq: current.endSeq,
      latestChunkId: latest.id,
      latestChunkStartSeq: latest.startSeq,
      latestChunkEndSeq: latest.endSeq,
      projectionKey: key,
      snapshotBeforeChunk: snapshotBeforeCurrent ?? spec.emptySnapshot(),
      snapshotAfterChunk: snapshotAfterCurrent ?? spec.emptySnapshot(),
      latestSnapshot: snapshot
    };
  }
  return result;
}

function pageInfo(
  conversationId: string,
  all: readonly ProjectedChunk[],
  selected: readonly ProjectedChunk[],
  now: number
): ConversationTimelinePageRecord['pageInfo'] {
  const first = selected[0];
  const last = selected[selected.length - 1];
  return {
    conversationId,
    chunkIds: selected.map((chunk) => chunk.id),
    totalChunks: all.length,
    totalMessages: all.reduce((sum, chunk) => sum + chunk.messageCount, 0),
    ...(first ? { startSeq: first.startSeq, oldestChunkId: first.id, previousCursor: first.id } : {}),
    ...(last ? { endSeq: last.endSeq, newestChunkId: last.id, nextCursor: last.id } : {}),
    hasOlder: !!first && first.index > 0,
    hasNewer: !!last && last.index < all.length - 1,
    loadedAt: now
  };
}

function toSummary(chunk: ProjectedChunk): ConversationTimelineChunkSummaryRecord {
  return {
    id: chunk.id,
    index: chunk.index,
    startSeq: chunk.startSeq,
    endSeq: chunk.endSeq,
    messageCount: chunk.messageCount,
    messageOffsetStart: chunk.messageOffsetStart,
    messageOffsetEnd: chunk.messageOffsetEnd,
    toolCallCount: chunk.toolCallCount,
    toolCallEventCount: chunk.toolCallEventCount
  };
}

function pageChunkCount(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_CHUNKS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_CHUNKS) {
    throw new Error(`Timeline chunkCount must be an integer from 1 to ${MAX_PAGE_CHUNKS}.`);
  }
  return value;
}

function applyMode(direction: ConversationTimelinePageRequest['direction']): ConversationTimelinePageRecord['applyMode'] {
  if (direction === 'older') return 'prepend';
  if (direction === 'newer') return 'append';
  return 'replace';
}

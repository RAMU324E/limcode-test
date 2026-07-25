import { createHash } from 'node:crypto';
import { STORAGE_VERSION } from '../../capabilities/vscodeStorage/constants';
import type { ConversationTimelineChunkData, TimelineProjectionSpec } from '../../capabilities/vscodeStorage/timelineProjections';
import { isUserVisibleTimelineMessage } from '../../../shared/messagePresentation';
import type {
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ConversationCheckpointRepositoryLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ProjectContextRecord,
  ShadowRepositoryRecord,
  ToolCallEventRecord,
  ToolCallRecord
} from '../../../shared/protocol';
import type { TimelineProjectionRefRecord } from '../../../shared/timelineProjection';
import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import { conversationTimelineRootRelativePath } from '../storagePathAuthority';
import { CANONICAL_TIMELINE_CHUNK_SIZE } from '../timelineFormat';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { compactJsonBytes, deletePostimage, prettyJsonBytes, writePostimage } from './recordStoreCompiler';

// 未发布的新格式直接缩小活动 chunk，避免一条 Read/MCP/Bash 大结果反复带着近百条历史 sidecar 重写。
export const TIMELINE_CHUNK_SIZE = CANONICAL_TIMELINE_CHUNK_SIZE;
const CHUNKS_DIR = 'chunks';
const SIDECARS_DIR = 'sidecars';
const PROJECTIONS_DIR = 'projections';

const SIDECAR_KEYS = [
  'message-revisions',
  'message-current-revision-links',
  'project-contexts',
  'shadow-repositories',
  'conversation-checkpoint-repository-links',
  'checkpoints',
  'checkpoint-timeline-anchors'
] as const;

type TimelineSidecarKey = typeof SIDECAR_KEYS[number];

interface TimelineSidecarRef {
  file: string;
  sourceHash: string;
  count: number;
}

interface TimelineChunkIndexRecord {
  id: string;
  file: string;
  index: number;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  messageOffsetStart: number;
  messageOffsetEnd: number;
  messageIds: string[];
  messageHash: string;
  sourceHash: string;
  sidecars: Record<TimelineSidecarKey, TimelineSidecarRef>;
  projections: Record<string, TimelineProjectionRefRecord>;
}

interface TimelineIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: string;
  chunkSize: number;
  chunks: TimelineChunkIndexRecord[];
}

interface ProjectionRuntimeState<TSnapshot = unknown> {
  spec: TimelineProjectionSpec<TSnapshot>;
  snapshot: TSnapshot;
  operationIndex: number;
  previousCheckpointHash?: string;
}

export async function compileTimelinePostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  if (!input.mutations.some((mutation) => TIMELINE_FAMILIES.has(mutation.family))) return [];
  if (!timelineMutationsChangeFacts(input.current, input.next, input.mutations)) return [];
  if (!Number.isFinite(input.now)) throw new Error(`Timeline compiler timestamp is invalid: ${input.now}`);

  const root = conversationTimelineRootRelativePath(input.conversationId);
  const indexPath = `${root}/index.json`;
  const previous = await input.files.readJson<TimelineIndexFile>(indexPath);
  validateTimelineIndex(previous, input.conversationId, root);
  const previousById = new Map((previous?.chunks ?? []).map((chunk) => [chunk.id, chunk]));
  const savedAt = new Date(input.now).toISOString();
  const chunks = conversationTimelineChunks(input.next);
  // Tool-dependent projections are derived from merged committed facts. Persisting them under the
  // timeline HEAD would make every ToolCall status update rewrite timeline checkpoints again.
  const projectionStates = createProjectionRuntimeStates([]);
  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  const indexChunks: TimelineChunkIndexRecord[] = [];
  let visibleMessageOffset = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkId = index.toString().padStart(6, '0');
    const chunk = chunks[index];
    const previousChunk = previousById.get(chunkId);
    const visibleMessages = chunk.messages.filter(isUserVisibleTimelineMessage);
    const seq = chunkDisplaySeqRange(chunk.messages);
    const persistedChunk = timelineStorageChunk(chunk);
    const messageHash = sha256Canonical({ messages: persistedChunk.messages });
    const sourceHash = sha256Canonical(persistedChunk);
    const file = `${CHUNKS_DIR}/${chunkId}.json`;
    // The chunk file contains only Message records. Sidecar-only changes update sourceHash but must
    // not rewrite the identical Message payload (or stage/hash/install one redundant postimage).
    const messageChunkUnchanged = previousChunk?.messageHash === messageHash
      && previousChunk.file === file;
    if (!messageChunkUnchanged) {
      postimages.push(writePostimage(`${root}/${file}`, compactJsonBytes({
        schemaVersion: STORAGE_VERSION,
        savedAt,
        conversationId: input.conversationId,
        chunkId,
        startSeq: seq.startSeq,
        endSeq: seq.endSeq,
        messageHash,
        messages: persistedChunk.messages
      })));
    }

    const sidecars = compileSidecars({
      postimages,
      root,
      savedAt,
      conversationId: input.conversationId,
      chunkId,
      chunk: persistedChunk,
      previous: previousChunk
    });
    const projections = compileProjectionCheckpoints({
      postimages,
      root,
      savedAt,
      conversationId: input.conversationId,
      chunkId,
      chunk: persistedChunk,
      seq,
      sourceHash,
      states: projectionStates,
      previous: previousChunk
    });

    indexChunks.push({
      id: chunkId,
      file,
      index,
      startSeq: seq.startSeq,
      endSeq: seq.endSeq,
      messageCount: visibleMessages.length,
      messageOffsetStart: visibleMessageOffset + 1,
      messageOffsetEnd: visibleMessageOffset + visibleMessages.length,
      messageIds: persistedChunk.messages.map((message) => message.id),
      messageHash,
      sourceHash,
      sidecars,
      projections
    });
    visibleMessageOffset += visibleMessages.length;
  }

  const nextIndex: TimelineIndexFile = {
    schemaVersion: STORAGE_VERSION,
    savedAt,
    conversationId: input.conversationId,
    chunkSize: TIMELINE_CHUNK_SIZE,
    chunks: indexChunks
  };
  postimages.push(writePostimage(indexPath, prettyJsonBytes(nextIndex)));

  const currentFiles = new Set(filesReferencedByIndex(nextIndex).map((file) => `${root}/${file}`));
  for (const file of filesReferencedByIndex(previous)) {
    const target = `${root}/${file}`;
    if (!currentFiles.has(target)) postimages.push(deletePostimage(target));
  }
  return uniquePostimages(postimages);
}

const TIMELINE_FAMILIES = new Set([
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors'
]);

function compileSidecars(input: {
  postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>;
  root: string;
  savedAt: string;
  conversationId: ConversationId;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
  previous?: TimelineChunkIndexRecord;
}): Record<TimelineSidecarKey, TimelineSidecarRef> {
  const recordsByKey: Record<TimelineSidecarKey, readonly { id: string }[]> = {
    'message-revisions': input.chunk.messageRevisions,
    'message-current-revision-links': input.chunk.messageCurrentRevisionLinks,
    'project-contexts': input.chunk.projectContexts,
    'shadow-repositories': input.chunk.shadowRepositories,
    'conversation-checkpoint-repository-links': input.chunk.conversationCheckpointRepositoryLinks,
    checkpoints: input.chunk.checkpoints,
    'checkpoint-timeline-anchors': input.chunk.checkpointTimelineAnchors
  };
  const refs = {} as Record<TimelineSidecarKey, TimelineSidecarRef>;
  for (const sidecarKey of SIDECAR_KEYS) {
    const records = recordsByKey[sidecarKey];
    const sourceHash = sha256Canonical(records);
    const file = `${SIDECARS_DIR}/${sidecarKey}/${input.chunkId}.json`;
    const previous = input.previous?.sidecars?.[sidecarKey];
    if (!previous || previous.file !== file || previous.sourceHash !== sourceHash || previous.count !== records.length) {
      input.postimages.push(writePostimage(`${input.root}/${file}`, compactJsonBytes({
        schemaVersion: STORAGE_VERSION,
        savedAt: input.savedAt,
        conversationId: input.conversationId,
        chunkId: input.chunkId,
        sidecarKey,
        sourceHash,
        count: records.length,
        records
      })));
    }
    refs[sidecarKey] = { file, sourceHash, count: records.length };
  }
  return refs;
}

function compileProjectionCheckpoints(input: {
  postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>;
  root: string;
  savedAt: string;
  conversationId: ConversationId;
  chunkId: string;
  chunk: ConversationTimelineChunkData;
  seq: { startSeq: number; endSeq: number };
  sourceHash: string;
  states: ProjectionRuntimeState[];
  previous?: TimelineChunkIndexRecord;
}): Record<string, TimelineProjectionRefRecord> {
  const refs: Record<string, TimelineProjectionRefRecord> = {};
  for (const state of input.states) {
    const result = state.spec.reduceChunk({
      conversationId: input.conversationId,
      chunkId: input.chunkId,
      chunk: input.chunk,
      previousSnapshot: state.snapshot,
      operationStartIndex: state.operationIndex
    });
    const checkpointHash = sha256Canonical({
      projectionKey: state.spec.key,
      chunkId: input.chunkId,
      sourceHash: input.sourceHash,
      previousCheckpointHash: state.previousCheckpointHash,
      snapshotAfterChunk: result.snapshotAfterChunk
    });
    const file = `${PROJECTIONS_DIR}/${safeProjectionKey(state.spec.key)}/${input.chunkId}.json`;
    const ref: TimelineProjectionRefRecord = {
      file,
      checkpointHash,
      ...(state.previousCheckpointHash ? { previousCheckpointHash: state.previousCheckpointHash } : {}),
      ...(result.operationCount !== undefined ? { operationCount: result.operationCount } : {})
    };
    const previous = input.previous?.projections?.[state.spec.key];
    if (!previous || canonical(previous) !== canonical(ref)) {
      input.postimages.push(writePostimage(`${input.root}/${file}`, compactJsonBytes({
        schemaVersion: STORAGE_VERSION,
        savedAt: input.savedAt,
        conversationId: input.conversationId,
        chunkId: input.chunkId,
        projectionKey: state.spec.key,
        startSeq: input.seq.startSeq,
        endSeq: input.seq.endSeq,
        snapshotAfterChunk: result.snapshotAfterChunk,
        ...(result.operationCount !== undefined ? { operationCount: result.operationCount } : {}),
        sourceHash: input.sourceHash,
        checkpointHash,
        ...(state.previousCheckpointHash ? { previousCheckpointHash: state.previousCheckpointHash } : {})
      })));
    }
    refs[state.spec.key] = ref;
    state.snapshot = result.snapshotAfterChunk;
    state.operationIndex = result.operationEndIndex;
    state.previousCheckpointHash = checkpointHash;
  }
  return refs;
}

function createProjectionRuntimeStates(specs: readonly TimelineProjectionSpec[]): ProjectionRuntimeState[] {
  return specs.map((spec) => ({ spec, snapshot: spec.emptySnapshot(), operationIndex: 0 }));
}

export function conversationTimelineChunks(facts: DurableConversationFacts): ConversationTimelineChunkData[] {
  if (facts.messages.length === 0) return [];
  const chunks: ConversationTimelineChunkData[] = [];
  const orderedMessages = uniqueById(facts.messages).sort(compareMessages);
  const projectContexts = uniqueById(facts.projectContexts);
  const shadowRepositories = uniqueById(facts.shadowRepositories);
  const checkpointRepositoryLinks = uniqueById(facts.conversationCheckpointRepositoryLinks);
  const allCheckpoints = uniqueById(facts.checkpoints);
  const anchoredCheckpointIds = new Set(facts.checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  const initialCheckpoints = allCheckpoints.filter((checkpoint) => checkpoint.trigger === 'conversation_initial' && !anchoredCheckpointIds.has(checkpoint.id));
  const emittedProjectContextIds = new Set<string>();
  const emittedShadowRepositoryIds = new Set<string>();
  const emittedCheckpointRepositoryLinkIds = new Set<string>();
  const emittedCheckpointIds = new Set<string>();

  for (let offset = 0; offset < orderedMessages.length; offset += TIMELINE_CHUNK_SIZE) {
    const messages = orderedMessages.slice(offset, offset + TIMELINE_CHUNK_SIZE);
    const messageIds = new Set(messages.map((message) => message.id));
    const messageRevisions = uniqueById(facts.messageRevisions.filter((revision) => messageIds.has(revision.messageId)))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const revisionIds = new Set(messageRevisions.map((revision) => revision.id));
    const messageCurrentRevisionLinks = uniqueById(facts.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || revisionIds.has(link.revisionId)))
      .sort(byId);
    const toolCalls = uniqueById(facts.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId))).sort(compareToolCalls);
    const toolCallIds = new Set(toolCalls.map((toolCall) => toolCall.id));
    const toolCallEvents = uniqueById(facts.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId)))
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
    const checkpointTimelineAnchors = uniqueById(facts.checkpointTimelineAnchors.filter((anchor) => messageIds.has(anchor.floorMessageId)))
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
    const checkpointIds = new Set(checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
    const checkpointCandidates = allCheckpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id)
      || (offset === 0 && initialCheckpoints.some((candidate) => candidate.id === checkpoint.id)));
    for (const checkpoint of checkpointCandidates) checkpointIds.add(checkpoint.id);
    const shadowRepositoryIds = new Set(checkpointCandidates.map((checkpoint) => checkpoint.shadowRepositoryId));
    const projectContextIds = new Set(checkpointCandidates.map((checkpoint) => checkpoint.projectContextId));
    const checkpointRepositoryLinkCandidates = checkpointRepositoryLinks.filter((link) => {
      const matches = shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
      if (matches) {
        shadowRepositoryIds.add(link.shadowRepositoryId);
        projectContextIds.add(link.projectContextId);
      }
      return matches;
    });
    chunks.push({
      messages,
      messageRevisions,
      messageCurrentRevisionLinks,
      toolCalls,
      toolCallEvents,
      projectContexts: takeFirstCanonicalOccurrence(projectContexts.filter((record) => projectContextIds.has(record.id)), emittedProjectContextIds).sort(byId),
      shadowRepositories: takeFirstCanonicalOccurrence(shadowRepositories.filter((record) => shadowRepositoryIds.has(record.id)), emittedShadowRepositoryIds).sort(byId),
      conversationCheckpointRepositoryLinks: takeFirstCanonicalOccurrence(checkpointRepositoryLinkCandidates, emittedCheckpointRepositoryLinkIds).sort(byId),
      checkpoints: takeFirstCanonicalOccurrence(checkpointCandidates, emittedCheckpointIds)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      checkpointTimelineAnchors
    });
  }
  return chunks;
}

/** Physical timeline storage never owns ToolCall/Event records; in-memory page projection may still group them. */
function timelineStorageChunk(chunk: ConversationTimelineChunkData): ConversationTimelineChunkData {
  return { ...chunk, toolCalls: [], toolCallEvents: [] };
}

function timelineMutationsChangeFacts(
  current: DurableConversationFacts,
  next: DurableConversationFacts,
  mutations: readonly RecordMutation[]
): boolean {
  const recordsByFamily = new Map<string, {
    current: Map<string, { id: string }>;
    next: Map<string, { id: string }>;
  }>();
  const mapsFor = (family: string) => {
    let maps = recordsByFamily.get(family);
    if (maps) return maps;
    maps = {
      current: new Map(timelineRecordsForFamily(current, family).map((record) => [record.id, record])),
      next: new Map(timelineRecordsForFamily(next, family).map((record) => [record.id, record]))
    };
    recordsByFamily.set(family, maps);
    return maps;
  };

  for (const mutation of mutations) {
    if (!TIMELINE_FAMILIES.has(mutation.family)) continue;
    const maps = mapsFor(mutation.family);
    const ids = mutation.kind === 'remove_many' ? mutation.ids : [mutation.id];
    for (const id of ids) {
      if (canonical(maps.current.get(id)) !== canonical(maps.next.get(id))) return true;
    }
  }
  return false;
}

function timelineRecordsForFamily(facts: DurableConversationFacts, family: string): readonly { id: string }[] {
  switch (family) {
    case 'messages': return facts.messages;
    case 'messageRevisions': return facts.messageRevisions;
    case 'messageCurrentRevisionLinks': return facts.messageCurrentRevisionLinks;
    case 'projectContexts': return facts.projectContexts;
    case 'shadowRepositories': return facts.shadowRepositories;
    case 'conversationCheckpointRepositoryLinks': return facts.conversationCheckpointRepositoryLinks;
    case 'checkpoints': return facts.checkpoints;
    case 'checkpointTimelineAnchors': return facts.checkpointTimelineAnchors;
    default: return [];
  }
}

function validateTimelineIndex(index: TimelineIndexFile | undefined, conversationId: ConversationId, root: string): void {
  if (!index) return;
  if (index.schemaVersion !== STORAGE_VERSION || index.conversationId !== conversationId
    || index.chunkSize !== TIMELINE_CHUNK_SIZE || !Array.isArray(index.chunks)) {
    throw new Error(`Invalid authoritative timeline index: ${root}/index.json`);
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  for (let position = 0; position < index.chunks.length; position += 1) {
    const chunk = index.chunks[position];
    if (chunk.index !== position || chunk.id !== position.toString().padStart(6, '0')
      || !chunk.sourceHash || !chunk.messageHash || !chunk.sidecars || !chunk.projections) {
      throw new Error(`Invalid authoritative timeline chunk index: ${root}:${chunk.id ?? position}`);
    }
    if (ids.has(chunk.id)) throw new Error(`Duplicate authoritative timeline chunk: ${root}:${chunk.id}`);
    ids.add(chunk.id);
    for (const file of [chunk.file, ...Object.values(chunk.sidecars).map((entry) => entry.file), ...Object.values(chunk.projections).map((entry) => entry.file)]) {
      assertTimelineFile(file, root);
      if (files.has(file)) throw new Error(`Timeline index reuses one file: ${root}/${file}`);
      files.add(file);
    }
  }
}

function filesReferencedByIndex(index: TimelineIndexFile | undefined): string[] {
  if (!index) return [];
  return index.chunks.flatMap((chunk) => [
    chunk.file,
    ...Object.values(chunk.sidecars).map((entry) => entry.file),
    ...Object.values(chunk.projections).map((entry) => entry.file)
  ]);
}

function uniquePostimages(
  postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>
): Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> {
  const byTarget = new Map<string, Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>();
  for (const postimage of postimages) {
    if (byTarget.has(postimage.targetRelativePath)) throw new Error(`Timeline compiler produced duplicate target: ${postimage.targetRelativePath}`);
    byTarget.set(postimage.targetRelativePath, postimage);
  }
  return [...byTarget.values()].sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
}

function chunkDisplaySeqRange(messages: readonly MessageRecord[]): { startSeq: number; endSeq: number } {
  const visible = messages.filter(isUserVisibleTimelineMessage);
  const seqs = (visible.length > 0 ? visible : messages).map((message) => message.seq);
  return {
    startSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
    endSeq: seqs.length > 0 ? Math.max(...seqs) : 0
  };
}

function compareMessages(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function compareToolCalls(left: ToolCallRecord, right: ToolCallRecord): number {
  const scheduled = left.messageId === right.messageId
    && Number.isInteger(left.schedulingOrdinal) && Number.isInteger(right.schedulingOrdinal)
    ? left.schedulingOrdinal! - right.schedulingOrdinal!
    : 0;
  return scheduled || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function uniqueById<TRecord extends { id: string }>(records: readonly TRecord[]): TRecord[] {
  const byRecordId = new Map<string, TRecord>();
  for (const record of records) {
    if (!record.id || byRecordId.has(record.id)) throw new Error(`Timeline facts contain duplicate record ${record.id || '<empty>'}.`);
    byRecordId.set(record.id, record);
  }
  return [...byRecordId.values()];
}

function takeFirstCanonicalOccurrence<TRecord extends { id: string }>(
  records: readonly TRecord[],
  emittedIds: Set<string>
): TRecord[] {
  const result: TRecord[] = [];
  for (const record of records) {
    if (emittedIds.has(record.id)) continue;
    emittedIds.add(record.id);
    result.push(record);
  }
  return result;
}

function byId<TRecord extends { id: string }>(left: TRecord, right: TRecord): number {
  return left.id.localeCompare(right.id);
}

function safeProjectionKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'projection';
}

function assertTimelineFile(file: string, root: string): void {
  if (!file || file.startsWith('/') || file.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Timeline index contains an invalid file path: ${root}/${file}`);
  }
}

function sha256Canonical(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Timeline compiler cannot hash an undefined value.');
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// Compile-time checks keep the chunk grouping aligned with the persisted protocol families.
void (undefined as unknown as MessageRevisionRecord);
void (undefined as unknown as MessageCurrentRevisionLinkRecord);
void (undefined as unknown as ToolCallEventRecord);
void (undefined as unknown as ProjectContextRecord);
void (undefined as unknown as ShadowRepositoryRecord);
void (undefined as unknown as ConversationCheckpointRepositoryLinkRecord);
void (undefined as unknown as CheckpointRecord);
void (undefined as unknown as CheckpointTimelineAnchorRecord);

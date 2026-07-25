import { createHash } from 'node:crypto';
import { createEmptyClientState } from '../../shared/clientStateSchema';
import { isUserVisibleTimelineMessage } from '../../shared/messagePresentation';
import type {
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ClientState,
  ConversationCheckpointRepositoryLinkRecord,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  ProjectContextRecord,
  ShadowRepositoryRecord
} from '../../shared/protocol';
import type { TimelineProjectionRefRecord } from '../../shared/timelineProjection';
import type { ConversationId } from '../../shared/stableIds';
import { STORAGE_VERSION } from '../capabilities/vscodeStorage/constants';
import type { ConversationTimelineChunkData, TimelineProjectionSpec } from '../capabilities/vscodeStorage/timelineProjections';
import type { DurableFileSystem } from './fileDurability';
import { conversationTimelineRootRelativePath } from './storagePathAuthority';
import { CANONICAL_TIMELINE_CHUNK_SIZE } from './timelineFormat';

export { CANONICAL_TIMELINE_CHUNK_SIZE } from './timelineFormat';

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
  conversationId: ConversationId;
  chunkSize: number;
  chunks: TimelineChunkIndexRecord[];
}

interface TimelineChunkFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: ConversationId;
  chunkId: string;
  startSeq: number;
  endSeq: number;
  messageHash: string;
  messages: MessageRecord[];
}

interface TimelineSidecarFile<TRecord> {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: ConversationId;
  chunkId: string;
  sidecarKey: TimelineSidecarKey;
  sourceHash: string;
  count: number;
  records: TRecord[];
}

interface TimelineProjectionCheckpointFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  conversationId: ConversationId;
  chunkId: string;
  projectionKey: string;
  startSeq: number;
  endSeq: number;
  snapshotAfterChunk: unknown;
  operationCount?: number;
  sourceHash: string;
  checkpointHash: string;
  previousCheckpointHash?: string;
}

interface ProjectionRuntimeState {
  spec: TimelineProjectionSpec;
  snapshot: unknown;
  operationIndex: number;
  previousCheckpointHash?: string;
}

/** Strict canonical timeline read. Missing roots mean an empty timeline; malformed roots fail. */
export async function loadCanonicalTimelineState(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<ClientState> {
  const root = conversationTimelineRootRelativePath(conversationId);
  const indexPath = `${root}/index.json`;
  const [index, physicalFiles] = await Promise.all([
    files.readJson<TimelineIndexFile>(indexPath),
    files.listFilesRecursive(root)
  ]);
  if (!index) {
    if (physicalFiles.length > 0) throw new Error(`Authoritative timeline files exist without an index: ${root}`);
    return createEmptyClientState();
  }
  validateIndex(index, conversationId, indexPath);

  const state = createEmptyClientState();
  const expectedFiles = new Set<string>([indexPath]);
  const projections: ProjectionRuntimeState[] = [];
  let visibleMessageOffset = 0;

  for (let position = 0; position < index.chunks.length; position += 1) {
    const record = index.chunks[position];
    validateChunkIndexRecord(record, position, root);
    const chunkPath = `${root}/${record.file}`;
    expectedFiles.add(chunkPath);
    const chunkFile = await files.readJson<TimelineChunkFile>(chunkPath);
    if (!chunkFile || chunkFile.schemaVersion !== STORAGE_VERSION
      || chunkFile.conversationId !== conversationId || chunkFile.chunkId !== record.id
      || !Array.isArray(chunkFile.messages)) {
      throw new Error(`Authoritative timeline chunk is missing or invalid: ${chunkPath}`);
    }
    validateTimestamp(chunkFile.savedAt, `${chunkPath}:savedAt`);
    const seq = displaySeqRange(chunkFile.messages);
    const messageHash = sha256Json({ messages: chunkFile.messages });
    if (chunkFile.startSeq !== seq.startSeq || chunkFile.endSeq !== seq.endSeq
      || chunkFile.messageHash !== messageHash || record.messageHash !== messageHash) {
      throw new Error(`Authoritative timeline chunk metadata disagrees with its messages: ${chunkPath}`);
    }

    const sidecars = await loadSidecars(files, root, conversationId, record, expectedFiles);
    const chunk: ConversationTimelineChunkData = {
      messages: chunkFile.messages,
      messageRevisions: sidecars['message-revisions'],
      messageCurrentRevisionLinks: sidecars['message-current-revision-links'],
      toolCalls: [],
      toolCallEvents: [],
      projectContexts: sidecars['project-contexts'],
      shadowRepositories: sidecars['shadow-repositories'],
      conversationCheckpointRepositoryLinks: sidecars['conversation-checkpoint-repository-links'],
      checkpoints: sidecars.checkpoints,
      checkpointTimelineAnchors: sidecars['checkpoint-timeline-anchors']
    };
    const sourceHash = sha256Json(chunk);
    if (record.sourceHash !== sourceHash) throw new Error(`Authoritative timeline source hash is invalid: ${root}:${record.id}`);

    const visibleMessages = chunk.messages.filter(isUserVisibleTimelineMessage);
    const expectedMessageOffsetStart = visibleMessageOffset + 1;
    const expectedMessageOffsetEnd = visibleMessageOffset + visibleMessages.length;
    if (record.startSeq !== seq.startSeq || record.endSeq !== seq.endSeq
      || record.messageCount !== visibleMessages.length
      || record.messageOffsetStart !== expectedMessageOffsetStart
      || record.messageOffsetEnd !== expectedMessageOffsetEnd
      || !sameArray(record.messageIds, chunk.messages.map((message) => message.id))) {
      throw new Error(`Authoritative timeline index metadata is invalid: ${root}:${record.id}`);
    }
    visibleMessageOffset = expectedMessageOffsetEnd;

    await validateProjectionCheckpoints(files, root, conversationId, record, chunk, seq, sourceHash, projections, expectedFiles);
    appendChunk(state, chunk);
  }

  const actualFiles = new Set(physicalFiles);
  const missing = [...expectedFiles].filter((relativePath) => !actualFiles.has(relativePath));
  const unindexed = physicalFiles.filter((relativePath) => !expectedFiles.has(relativePath));
  if (missing.length > 0 || unindexed.length > 0) {
    throw new Error(`Authoritative timeline index and files disagree for ${root}; missing=[${missing.join(', ')}], unindexed=[${unindexed.join(', ')}].`);
  }
  return state;
}

async function loadSidecars(
  files: DurableFileSystem,
  root: string,
  conversationId: ConversationId,
  record: TimelineChunkIndexRecord,
  expectedFiles: Set<string>
): Promise<{
  'message-revisions': MessageRevisionRecord[];
  'message-current-revision-links': MessageCurrentRevisionLinkRecord[];
  'project-contexts': ProjectContextRecord[];
  'shadow-repositories': ShadowRepositoryRecord[];
  'conversation-checkpoint-repository-links': ConversationCheckpointRepositoryLinkRecord[];
  checkpoints: CheckpointRecord[];
  'checkpoint-timeline-anchors': CheckpointTimelineAnchorRecord[];
}> {
  const result: Partial<Record<TimelineSidecarKey, unknown[]>> = {};
  for (const key of SIDECAR_KEYS) {
    const ref = record.sidecars[key];
    const expectedFile = `sidecars/${key}/${record.id}.json`;
    if (!ref || ref.file !== expectedFile || !Number.isInteger(ref.count) || ref.count < 0 || !isSha256(ref.sourceHash)) {
      throw new Error(`Authoritative timeline sidecar reference is invalid: ${root}:${record.id}:${key}`);
    }
    const path = `${root}/${ref.file}`;
    expectedFiles.add(path);
    const sidecar = await files.readJson<TimelineSidecarFile<unknown>>(path);
    if (!sidecar || sidecar.schemaVersion !== STORAGE_VERSION || sidecar.conversationId !== conversationId
      || sidecar.chunkId !== record.id || sidecar.sidecarKey !== key || !Array.isArray(sidecar.records)) {
      throw new Error(`Authoritative timeline sidecar is missing or invalid: ${path}`);
    }
    validateTimestamp(sidecar.savedAt, `${path}:savedAt`);
    const sourceHash = sha256Json(sidecar.records);
    if (sidecar.count !== sidecar.records.length || ref.count !== sidecar.records.length
      || sidecar.sourceHash !== sourceHash || ref.sourceHash !== sourceHash) {
      throw new Error(`Authoritative timeline sidecar hash/count is invalid: ${path}`);
    }
    result[key] = sidecar.records;
  }
  return result as Awaited<ReturnType<typeof loadSidecars>>;
}

async function validateProjectionCheckpoints(
  files: DurableFileSystem,
  root: string,
  conversationId: ConversationId,
  record: TimelineChunkIndexRecord,
  chunk: ConversationTimelineChunkData,
  seq: { startSeq: number; endSeq: number },
  sourceHash: string,
  states: ProjectionRuntimeState[],
  expectedFiles: Set<string>
): Promise<void> {
  const actualKeys = Object.keys(record.projections).sort();
  const expectedKeys = states.map((state) => state.spec.key).sort();
  if (!sameArray(actualKeys, expectedKeys)) throw new Error(`Authoritative timeline projection set is invalid: ${root}:${record.id}`);

  for (const state of states) {
    const result = state.spec.reduceChunk({
      conversationId,
      chunkId: record.id,
      chunk,
      previousSnapshot: state.snapshot,
      operationStartIndex: state.operationIndex
    });
    const checkpointHash = sha256Json({
      projectionKey: state.spec.key,
      chunkId: record.id,
      sourceHash,
      previousCheckpointHash: state.previousCheckpointHash,
      snapshotAfterChunk: result.snapshotAfterChunk
    });
    const ref = record.projections[state.spec.key];
    const expectedFile = `projections/${safeProjectionKey(state.spec.key)}/${record.id}.json`;
    if (!ref || ref.file !== expectedFile || ref.checkpointHash !== checkpointHash
      || ref.previousCheckpointHash !== state.previousCheckpointHash
      || ref.operationCount !== result.operationCount) {
      throw new Error(`Authoritative timeline projection reference is invalid: ${root}:${record.id}:${state.spec.key}`);
    }
    const path = `${root}/${ref.file}`;
    expectedFiles.add(path);
    const checkpoint = await files.readJson<TimelineProjectionCheckpointFile>(path);
    if (!checkpoint || checkpoint.schemaVersion !== STORAGE_VERSION || checkpoint.conversationId !== conversationId
      || checkpoint.chunkId !== record.id || checkpoint.projectionKey !== state.spec.key
      || checkpoint.startSeq !== seq.startSeq || checkpoint.endSeq !== seq.endSeq
      || checkpoint.sourceHash !== sourceHash || checkpoint.checkpointHash !== checkpointHash
      || checkpoint.previousCheckpointHash !== state.previousCheckpointHash
      || checkpoint.operationCount !== result.operationCount
      || canonical(checkpoint.snapshotAfterChunk) !== canonical(result.snapshotAfterChunk)) {
      throw new Error(`Authoritative timeline projection checkpoint is missing or invalid: ${path}`);
    }
    validateTimestamp(checkpoint.savedAt, `${path}:savedAt`);
    state.snapshot = result.snapshotAfterChunk;
    state.operationIndex = result.operationEndIndex;
    state.previousCheckpointHash = checkpointHash;
  }
}

function validateIndex(index: TimelineIndexFile, conversationId: ConversationId, indexPath: string): void {
  validateTimestamp(index.savedAt, `${indexPath}:savedAt`);
  if (index.schemaVersion !== STORAGE_VERSION || index.conversationId !== conversationId
    || index.chunkSize !== CANONICAL_TIMELINE_CHUNK_SIZE || !Array.isArray(index.chunks)) {
    throw new Error(`Invalid authoritative timeline index: ${indexPath}`);
  }
}

function validateChunkIndexRecord(record: TimelineChunkIndexRecord, position: number, root: string): void {
  const id = position.toString().padStart(6, '0');
  if (!record || record.id !== id || record.index !== position || record.file !== `chunks/${id}.json`
    || !Number.isFinite(record.startSeq) || !Number.isFinite(record.endSeq)
    || !Number.isInteger(record.messageCount) || record.messageCount < 0
    || !Number.isInteger(record.messageOffsetStart) || !Number.isInteger(record.messageOffsetEnd)
    || !Array.isArray(record.messageIds)
    || !isSha256(record.messageHash) || !isSha256(record.sourceHash)
    || !record.sidecars || typeof record.sidecars !== 'object' || Array.isArray(record.sidecars)
    || !record.projections || typeof record.projections !== 'object' || Array.isArray(record.projections)) {
    throw new Error(`Invalid authoritative timeline chunk index: ${root}:${id}`);
  }
}

function appendChunk(state: ClientState, chunk: ConversationTimelineChunkData): void {
  appendUniqueRecords(state.messages, chunk.messages, 'messages');
  appendUniqueRecords(state.messageRevisions, chunk.messageRevisions, 'messageRevisions');
  appendUniqueRecords(state.messageCurrentRevisionLinks, chunk.messageCurrentRevisionLinks, 'messageCurrentRevisionLinks');
  appendUniqueRecords(state.toolCalls, chunk.toolCalls, 'toolCalls');
  appendUniqueRecords(state.projectContexts, chunk.projectContexts, 'projectContexts');
  appendUniqueRecords(state.shadowRepositories, chunk.shadowRepositories, 'shadowRepositories');
  appendUniqueRecords(state.conversationCheckpointRepositoryLinks, chunk.conversationCheckpointRepositoryLinks, 'conversationCheckpointRepositoryLinks');
  appendUniqueRecords(state.checkpoints, chunk.checkpoints, 'checkpoints');
  appendUniqueRecords(state.checkpointTimelineAnchors, chunk.checkpointTimelineAnchors, 'checkpointTimelineAnchors');
}

function appendUniqueRecords<TRecord extends { id: string }>(
  target: TRecord[],
  incoming: readonly TRecord[],
  family: string
): void {
  const existingIds = new Set(target.map((record) => record.id));
  for (const record of incoming) {
    if (!record.id || existingIds.has(record.id)) {
      throw new Error(`Authoritative timeline contains duplicate ${family} record: ${record.id || '<empty>'}`);
    }
    existingIds.add(record.id);
    target.push(record);
  }
}

function displaySeqRange(messages: readonly MessageRecord[]): { startSeq: number; endSeq: number } {
  const visible = messages.filter(isUserVisibleTimelineMessage);
  const seqs = (visible.length > 0 ? visible : messages).map((message) => message.seq);
  return {
    startSeq: seqs.length > 0 ? Math.min(...seqs) : 0,
    endSeq: seqs.length > 0 ? Math.max(...seqs) : 0
  };
}

function safeProjectionKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'projection';
}

function sha256Json(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('Cannot hash an undefined timeline value.');
  return createHash('sha256').update(json, 'utf8').digest('hex');
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

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function sameArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid canonical timestamp: ${label}`);
}

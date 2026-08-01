import type { RootBinding, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type {
  DomainRow,
  RepositoryInsertMutation,
  RepositoryListRead,
  RepositoryRead,
  RepositoryTransactionStep
} from './repositories';
import type { DatabaseFoundationInspection } from './databaseSchema';

export const MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT = 33;
export const MODEL_STREAM_TERMINAL_TAIL = 32;

export interface ContextMaterializationRecord {
  node: DomainRow;
  segment: DomainRow;
  contentObject: DomainRow;
  /** Immutable MessageRevision role resolved through ContextSegmentSource; NULL for non-message segments. */
  messageRole: string | null;
}

export interface ContextMaterializationSnapshot {
  root: DomainRow;
  records: ContextMaterializationRecord[];
}

export interface ContextContentMaterializationRecord extends ContextMaterializationRecord {
  content: Uint8Array;
}

export interface ContextContentMaterializationSnapshot {
  root: DomainRow;
  records: ContextContentMaterializationRecord[];
}

export interface ModelStreamEventCommitInput {
  modelRequestId: string;
  checkpointId: string;
  attemptSeq: bigint;
  socketGeneration: bigint;
  streamSeq: bigint;
  checkpointKind: 'output_delta' | 'output_item_done' | 'terminal_summary';
  terminalFenceId: string | null;
  contentObject: DomainRow;
  contentInsert?: RepositoryInsertMutation;
  usage: unknown | null;
  terminalStats: DomainRow | null;
  now: string;
}

export interface ModelStreamEventCommitResult {
  accepted: boolean;
  checkpointed: boolean;
  terminal: boolean;
  ignoredReason?: 'old-attempt' | 'old-socket-generation' | 'terminal' | 'checkpoint-capacity' | 'duplicate';
  commit?: RuntimeCommitResult;
}

export interface ModelRequestCancelInput {
  modelRequestId: string;
  terminalState: string;
  now: string;
}

export interface ModelRequestCancelResult {
  cancelled: boolean;
  terminalState: string | null;
  attemptSeq: string;
  socketGeneration: string;
  commit?: RuntimeCommitResult;
}

export interface ClientProjectionSnapshot {
  navigationSummary: Record<string, unknown>;
  activeConversationWindow: Record<string, unknown>;
  activeTurnSummary: Record<string, unknown>;
  activeToolAndInteractionSummary: Record<string, unknown>;
  subagentDeliverySummary: Record<string, unknown>;
}

export interface ClientKeysetPageInput {
  query: 'message' | 'conversation';
  sortId: 'message_seq' | 'created_at+id';
  conversationId?: string;
  limit: number;
  afterSortKey?: string;
  afterId?: string;
}

export interface ClientKeysetPageResult {
  rows: Array<Record<string, unknown>>;
  nextSortKey?: string;
  nextId?: string;
  hasMore: boolean;
  responseBytes: number;
}

export interface DatabaseWorkerData {
  mode: 'initialize' | 'runtime';
  binding: RootBinding;
  hostBootId: string;
}

export type DatabaseWorkerRequestPayload =
  | { kind: 'transaction'; steps: RepositoryTransactionStep[] }
  | { kind: 'snapshot'; reads: RepositoryRead[] }
  | { kind: 'snapshotAll'; read: RepositoryListRead }
  | { kind: 'contextMaterialization'; rootId: string }
  | { kind: 'contextContentMaterialization'; rootId: string }
  | { kind: 'modelStreamEvent'; input: ModelStreamEventCommitInput }
  | { kind: 'cancelCurrentModelRequest'; input: ModelRequestCancelInput }
  | { kind: 'clientProjectionSnapshot'; activeConversationId: string | null }
  | { kind: 'clientKeysetPage'; input: ClientKeysetPageInput }
  | { kind: 'inspect' }
  | { kind: 'close' };

export type DatabaseWorkerRequest = DatabaseWorkerRequestPayload & { id: number };

export interface DatabaseWorkerDiagnostics extends DatabaseFoundationInspection {
  workerThreadId: number;
  hostBootId: string;
  writerConnectionCount: 1;
  readerConnectionCount: 1;
  readerJournalMode: string;
  readerForeignKeys: bigint;
  readerBusyTimeoutMs: bigint;
  currentCommitSeq: string;
}

export type DatabaseWorkerResponse =
  | { type: 'ready'; workerThreadId: number; mode: DatabaseWorkerData['mode'] }
  | { type: 'response'; id: number; ok: true; result: RuntimeCommitResult | ModelStreamEventCommitResult | ModelRequestCancelResult | ClientKeysetPageResult | SnapshotBarrier<ClientProjectionSnapshot> | SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> | SnapshotBarrier<DomainRow[]> | SnapshotBarrier<ContextMaterializationSnapshot> | SnapshotBarrier<ContextContentMaterializationSnapshot> | DatabaseWorkerDiagnostics | null }
  | { type: 'response'; id: number; ok: false; error: SerializedWorkerError }
  | { type: 'commit'; result: RuntimeCommitResult }
  | { type: 'fatal'; error: SerializedWorkerError };

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}

import type {
  CommandAck,
  CommandEnvelope,
  CommandPlanningContext,
  CommandRejection,
  CommandServiceError,
  ConversationCommandHandler,
  InternalCommandEnvelope,
  InternalCommandHandler,
  InternalTransitionResult,
  DurableAggregateView,
  DurablePostimage,
  DurableViewSpec,
  JsonValue,
  PlannedPatchBatch,
  PreparedProjectionBatch,
  StorageHead,
  TransitionPlan
} from '../../shared/conversationReliability';
import type { CommandId, ConversationId, TransitionId } from '../../shared/stableIds';
import type { DataRootOwner, FileDurabilityCapabilities } from './fileDurability';

export interface DurableSourceClaim {
  schemaVersion: 1;
  sourceKey: string;
  payloadHash: string;
  transitionId: TransitionId;
  writerFencingToken: string;
  state: 'claimed' | 'committed' | 'rejected' | 'failed';
  resultRef?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileConversationWalFile {
  operation: 'write' | 'delete';
  targetRelativePath: string;
  stagingRelativePath?: string;
  preimageHash: string | null;
  postimageHash: string | null;
}

export interface FileConversationWalRecord<TResult extends JsonValue = JsonValue> {
  schemaVersion: 1;
  writerFencingToken: string;
  transitionId: TransitionId;
  sourceKey: string;
  source:
    | { kind: 'command'; commandId: CommandId; payloadHash: string }
    | { kind: 'callback'; eventId: string; payloadHash: string }
    | { kind: 'internal'; transitionKey: string; payloadHash: string }
    | { kind: 'recovery'; recoveryKey: string };
  kind: string;
  scopes: ConversationId[];
  baseVersions: Array<{ conversationId: ConversationId; version: number }>;
  nextVersions: Array<{ conversationId: ConversationId; version: number }>;
  expectedStorageHeads: StorageHead[];
  postStorageHeads: StorageHead[];
  state: 'prepared' | 'storage_committed';
  generatedIds: string[];
  files: FileConversationWalFile[];
  result: TResult;
  patches: PlannedPatchBatch[];
  patchHeads: Array<{
    conversationId: ConversationId;
    streamId: string;
    baseSeq: number;
    nextSeq: number;
  }>;
  createdAt: number;
  updatedAt: number;
}

export interface CommandReceipt<TResult extends JsonValue = JsonValue> {
  schemaVersion: 1;
  sourceKey: string;
  commandId: CommandId;
  payloadHash: string;
  transitionId: TransitionId;
  finalStatus: 'committed' | 'rejected' | 'failed';
  nextVersions: Array<{ conversationId: ConversationId; version: number }>;
  result?: TResult;
  rejection?: CommandRejection;
  failure?: Pick<CommandServiceError, 'code' | 'message'>;
  patchHeads: Array<{
    conversationId: ConversationId;
    streamId: string;
    baseSeq: number;
    nextSeq: number;
  }>;
  createdAt: number;
}

export interface InternalTransitionReceipt<TResult extends JsonValue = JsonValue> {
  schemaVersion: 1;
  sourceKey: string;
  payloadHash: string;
  transitionId: TransitionId;
  sourceKind: 'callback' | 'internal' | 'recovery';
  finalStatus: 'committed' | 'stale' | 'already_satisfied';
  nextVersions: Array<{ conversationId: ConversationId; version: number }>;
  result: TResult;
  patchHeads: Array<{
    conversationId: ConversationId;
    streamId: string;
    baseSeq: number;
    nextSeq: number;
  }>;
  createdAt: number;
}

export interface CompiledFileTransition<TResult extends JsonValue = JsonValue> {
  postimages: readonly Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>[];
  /** Every business postimage belongs to exactly one conversation/resource StorageHead. */
  postimageHeadKeys: Readonly<Record<string, string>>;
  /** Backend-authoritative ClientState diff; sequence metadata must match the domain plan. */
  patches?: readonly PlannedPatchBatch[];
  projection?: PreparedProjectionBatch;
  validate?(): void;
  afterCommit?(): void | Promise<void>;
}

export interface FileCompileContext {
  /** The planning clock captured before the pure Domain handler ran; compilers must not read clocks. */
  now: number;
}

export interface FileTransactionAdapter {
  load<TView>(spec: DurableViewSpec<TView>, heads: ReadonlyMap<string, StorageHead>): Promise<DurableAggregateView<TView>>;
  compile<TResult extends JsonValue>(
    view: DurableAggregateView<unknown>,
    plan: TransitionPlan<TResult>,
    context: FileCompileContext
  ): Promise<CompiledFileTransition<TResult>>;
}

export interface ExecuteCommandOptions<
  TPayload extends JsonValue,
  TView,
  TResult extends JsonValue,
  TIds extends Record<string, string>
> {
  command: CommandEnvelope<TPayload>;
  handler: ConversationCommandHandler<TPayload, TView, TResult, TIds>;
  /** Server-resolved execution scope; requested command scope remains part of the idempotency hash. */
  executionViewSpec?: DurableViewSpec<TView>;
  /** Runs after idempotency/version checks while all declared conversation/resource leases are held. */
  prepareCommand?(command: CommandEnvelope<TPayload>): Promise<CommandEnvelope<TPayload>>;
  /**
   * Optional identity/dynamic-scope fence under all declared locks and before a new command claim.
   * Throwing leaves the command unclaimed so callers may re-resolve the same frozen target safely.
   */
  preClaimValidate?(input: {
    command: CommandEnvelope<TPayload>;
    view: DurableAggregateView<TView>;
    executionViewSpec: DurableViewSpec<TView>;
  }): void | Promise<void>;
  createPlanningContext(input: {
    command: CommandEnvelope<TPayload>;
    transitionId: TransitionId;
    now: number;
  }): CommandPlanningContext<TIds>;
}

export interface ExecuteInternalOptions<
  TPayload extends JsonValue,
  TView,
  TResult extends JsonValue,
  TIds extends Record<string, string>
> {
  command: InternalCommandEnvelope<TPayload>;
  handler: InternalCommandHandler<TPayload, TView, TResult, TIds>;
  executionViewSpec?: DurableViewSpec<TView>;
  /** Runs after idempotency replay while all declared conversation/resource leases are held. */
  prepareCommand?(command: InternalCommandEnvelope<TPayload>): Promise<InternalCommandEnvelope<TPayload>>;
  /**
   * Optional identity/dynamic-scope fence executed under every declared conversation/resource lock,
   * but before a new durable source claim is written. Throwing leaves no claim, so the caller may
   * re-resolve the frozen object graph with the same source identity and retry safely.
   */
  preClaimValidate?(input: {
    command: InternalCommandEnvelope<TPayload>;
    view: DurableAggregateView<TView>;
    executionViewSpec: DurableViewSpec<TView>;
  }): void | Promise<void>;
  createPlanningContext(input: {
    command: InternalCommandEnvelope<TPayload>;
    transitionId: TransitionId;
    now: number;
  }): CommandPlanningContext<TIds>;
}

export interface FileTransactionResult<TResult extends JsonValue> {
  ack: CommandAck<TResult>;
  patches: readonly PlannedPatchBatch[];
  projection?: PreparedProjectionBatch;
}

export type FileInternalTransactionResult<TResult extends JsonValue> = InternalTransitionResult<TResult> & {
  projection?: PreparedProjectionBatch;
};

export type FileTransactionFaultPoint =
  | 'after_source_claim'
  | 'after_staging'
  | 'after_prepared'
  | 'after_each_install'
  | 'after_verify'
  | 'after_storage_committed'
  | 'after_receipt'
  | 'after_claim_committed'
  | 'after_compaction_pending_cleanup'
  | 'after_compaction_staging_cleanup'
  | 'after_compaction_committed_cleanup';

export interface FileTransactionFaultInjector {
  hit(point: FileTransactionFaultPoint, context: { transitionId: TransitionId; installedFiles?: number }): void | Promise<void>;
}

export interface ReliabilityDiagnostic {
  kind:
    | 'identity_conflict'
    | 'command_replayed'
    | 'command_id_reused'
    | 'data_root_writer_blocked'
    | 'source_claim_conflict'
    | 'wal_prepared'
    | 'wal_rollforward_completed'
    | 'wal_compacted'
    | 'wal_integrity_failed'
    | 'stale_callback'
    | 'operation_timed_out'
    | 'operation_outcome_unknown'
    | 'orphan_run_interrupted'
    | 'projection_rehydrated'
    | 'promote_committed'
    | 'patch_sequence_gap';
  timestamp: number;
  conversationId?: ConversationId;
  transitionId?: TransitionId;
  commandId?: CommandId;
  runId?: string;
  operationId?: string;
  attemptId?: string;
  phase?: string;
  reasonCode: string;
}

export interface ReliabilityDiagnosticSink {
  record(event: ReliabilityDiagnostic): void;
}

export interface FileWalInspectionRecord {
  transitionId: TransitionId;
  state: FileConversationWalRecord['state'];
  sourceKey: string;
  sourceKind: FileConversationWalRecord['source']['kind'];
  kind: string;
  scopes: ConversationId[];
  baseVersions: FileConversationWalRecord['baseVersions'];
  nextVersions: FileConversationWalRecord['nextVersions'];
  fileCount: number;
  patchHeads: FileConversationWalRecord['patchHeads'];
  createdAt: number;
  updatedAt: number;
}

export interface FileReceiptInspectionRecord {
  sourceKey: string;
  sourceKind: 'command' | 'callback' | 'internal' | 'recovery';
  transitionId: TransitionId;
  commandId?: CommandId;
  finalStatus: CommandReceipt['finalStatus'] | InternalTransitionReceipt['finalStatus'];
  nextVersions: Array<{ conversationId: ConversationId; version: number }>;
  patchHeads: Array<{ conversationId: ConversationId; streamId: string; baseSeq: number; nextSeq: number }>;
  createdAt: number;
}

export interface FileTransactionStorageInspection {
  capturedAt: number;
  dataRoot: string;
  capabilities: FileDurabilityCapabilities;
  writer: DataRootOwner;
  heads: StorageHead[];
  pendingWals: FileWalInspectionRecord[];
  committedWals: FileWalInspectionRecord[];
  sourceClaims: DurableSourceClaim[];
  receipts: FileReceiptInspectionRecord[];
  stagingTransitionIds: TransitionId[];
  currentHeadTransitionIds: TransitionId[];
  receiptOnlyTransitionIds: TransitionId[];
  blockedScopes: Array<{ conversationId: ConversationId; reason: string }>;
  blockedHeadKeys: Array<{ headKey: string; reason: string }>;
}

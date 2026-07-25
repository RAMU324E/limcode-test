import { createHash } from 'node:crypto';
import { TOOL_RESULT_BLOBS_RESOURCE_KEY } from '../../shared/conversationReliability';
import type {
  CommandAck,
  CommandEnvelope,
  CommandRejection,
  CommandServiceError,
  CommandStatus,
  CommittedConversationHead,
  DurableAggregateView,
  DurablePostimage,
  DurableViewSpec,
  InternalCommandEnvelope,
  InternalCommandNoop,
  JsonValue,
  StorageHead,
  TransitionPlan
} from '../../shared/conversationReliability';
import type { CommandId, ConversationId, TransitionId } from '../../shared/stableIds';
import { canonicalCommandScope, canonicalSha256, commandPayloadHash } from './canonicalJson';
import { DataRootOwnerManager, DataRootWriterBlockedError, DurableFileSystem, jsonBytes, normalizeRelativePath, sha256Bytes, type FileDurabilityCapabilities } from './fileDurability';
import {
  commandExecutionKey,
  conversationExecutionKey,
  LogicalScopeExecutor,
  sourceExecutionKey,
  storageExecutionKey
} from './logicalScopeExecutor';
import type {
  CommandReceipt,
  DurableSourceClaim,
  ExecuteCommandOptions,
  ExecuteInternalOptions,
  FileConversationWalRecord,
  FileInternalTransactionResult,
  FileReceiptInspectionRecord,
  FileTransactionAdapter,
  FileTransactionFaultInjector,
  FileTransactionResult,
  FileTransactionStorageInspection,
  FileWalInspectionRecord,
  InternalTransitionReceipt,
  ReliabilityDiagnosticSink
} from './fileTransactionTypes';
import { RuntimeStableIdFactory } from './stableIdFactory';
import { DurableFactsIntegrityError } from './domain/durableFactsValidator';
import {
  ANSWER_BRIDGE_LINKS_STORAGE_RESOURCE_KEY,
  ATTACHMENT_STORAGE_RESOURCE_KEY,
  StoragePathAuthorityRegistry,
  conversationControlHeadKey,
  conversationDomainHeadKey,
  storageHeadKey,
  storageResourceHeadKey,
  type ConversationStorageDomain,
  type StorageHeadOwner
} from './storagePathAuthority';

const ROOT = 'operations/conversation-transitions';
const PENDING_DIR = `${ROOT}/pending`;
const COMMITTED_DIR = `${ROOT}/committed`;
const STAGING_DIR = `${ROOT}/staging`;
const CLAIMS_DIR = `${ROOT}/source-claims`;
const RECEIPTS_DIR = `${ROOT}/receipts`;
const HEADS_DIR = `${ROOT}/heads`;
const MAINTENANCE_COMMIT_BATCH = 32;
const SLOW_TRANSACTION_LOG_THRESHOLD_MS = 250;

type TransactionPerformanceKind = 'command' | 'internal' | 'read';

interface TransactionPerformanceSample {
  kind: TransactionPerformanceKind;
  commandType: string;
  sourceKey: string;
  scopeCount: number;
  storageResourceCount: number;
  queueMs: number;
  startedAt: number;
  transitionId?: string;
  outcome?: string;
  postimageCount?: number;
  postimageBytes?: number;
  phases: Record<string, number>;
}

async function measureTransactionPhase<T>(sample: TransactionPerformanceSample, phase: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    sample.phases[phase] = (sample.phases[phase] ?? 0) + (Date.now() - startedAt);
  }
}

function measureTransactionPhaseSync<T>(sample: TransactionPerformanceSample, phase: string, action: () => T): T {
  const startedAt = Date.now();
  try {
    return action();
  } finally {
    sample.phases[phase] = (sample.phases[phase] ?? 0) + (Date.now() - startedAt);
  }
}

function logSlowTransaction(sample: TransactionPerformanceSample): void {
  const inScopeMs = Date.now() - sample.startedAt;
  const totalMs = sample.queueMs + inScopeMs;
  if (totalMs < SLOW_TRANSACTION_LOG_THRESHOLD_MS) return;
  console.info('[ReliabilityPerf] transaction phases', {
    kind: sample.kind,
    commandType: sample.commandType,
    sourceKey: sample.sourceKey,
    transitionId: sample.transitionId,
    outcome: sample.outcome,
    scopeCount: sample.scopeCount,
    storageResourceCount: sample.storageResourceCount,
    postimageCount: sample.postimageCount,
    postimageBytes: sample.postimageBytes,
    queueMs: sample.queueMs,
    inScopeMs,
    totalMs,
    phases: sample.phases
  });
}

export class PreparedTransitionPendingError extends Error {
  public constructor(public readonly transitionId: TransitionId, cause: unknown) {
    super(`Transition ${transitionId} is prepared and requires roll-forward recovery.`);
    this.name = 'PreparedTransitionPendingError';
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class FileTransactionIntegrityError extends Error {
  public constructor(message: string, public readonly transitionId?: TransitionId) {
    super(message);
    this.name = 'FileTransactionIntegrityError';
  }
}

/** A command-local pre-WAL failure that has already been durably finalized. */
export class DurableCommandFailureError extends Error {
  public constructor(
    public readonly commandId: CommandId,
    public readonly serviceCode: CommandServiceError['code'],
    message: string,
    public readonly transitionId: TransitionId
  ) {
    super(message);
    this.name = 'DurableCommandFailureError';
  }
}

/** An unfinished claim from another writer epoch cannot be mistaken for a missing command. */
export class SourceClaimRecoveryRequiredError extends Error {
  public constructor(public readonly commandId: string, public readonly transitionId: TransitionId) {
    super(`Source ${commandId} was claimed by an earlier writer epoch and requires explicit recovery.`);
    this.name = 'SourceClaimRecoveryRequiredError';
  }
}

export interface FileConversationTransactionBackendOptions {
  files: DurableFileSystem;
  owner: DataRootOwnerManager;
  adapter: FileTransactionAdapter;
  scopeExecutor?: LogicalScopeExecutor;
  idFactory?: RuntimeStableIdFactory;
  faultInjector?: FileTransactionFaultInjector;
  diagnostics?: ReliabilityDiagnosticSink;
}

/** File-backed command transaction engine with a single durable `storage_committed` commit point. */
export class FileConversationTransactionBackend {
  private readonly files: DurableFileSystem;
  private readonly owner: DataRootOwnerManager;
  private readonly adapter: FileTransactionAdapter;
  private readonly scopes: LogicalScopeExecutor;
  private readonly ids: RuntimeStableIdFactory;
  private readonly faultInjector?: FileTransactionFaultInjector;
  private readonly diagnostics?: ReliabilityDiagnosticSink;
  private readonly pending = new Map<TransitionId, FileConversationWalRecord>();
  private readonly blockedScopes = new Map<ConversationId, string>();
  private readonly blockedHeadKeys = new Map<string, string>();
  private maintenanceTail: Promise<void> = Promise.resolve();
  private commitsSinceMaintenance = 0;
  private capabilities: FileDurabilityCapabilities | undefined;
  private initialized = false;
  private acceptingMutations = false;

  public constructor(options: FileConversationTransactionBackendOptions) {
    this.files = options.files;
    this.owner = options.owner;
    this.adapter = options.adapter;
    this.scopes = options.scopeExecutor ?? new LogicalScopeExecutor();
    this.ids = options.idFactory ?? new RuntimeStableIdFactory();
    this.faultInjector = options.faultInjector;
    this.diagnostics = options.diagnostics;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.capabilities = await this.files.probe();
      try { await this.owner.acquire(); }
      catch (error) {
        if (error instanceof DataRootWriterBlockedError) {
          this.diagnostics?.record({
            kind: 'data_root_writer_blocked',
            timestamp: Date.now(),
            phase: 'initialize',
            reasonCode: 'active_writer_owner'
          });
        }
        throw error;
      }
      await Promise.all([
        this.files.ensureDirectory(PENDING_DIR),
        this.files.ensureDirectory(COMMITTED_DIR),
        this.files.ensureDirectory(STAGING_DIR),
        this.files.ensureDirectory(CLAIMS_DIR),
        this.files.ensureDirectory(RECEIPTS_DIR),
        this.files.ensureDirectory(HEADS_DIR)
      ]);
      await this.loadPendingIndex();
      await this.recoverPending();
      await this.cleanupStartupArtifacts();
      await this.verifyStorageAuthorityAtStartup();
      await this.compactAllCommitted();
      this.initialized = true;
      this.acceptingMutations = true;
    } catch (error) {
      this.acceptingMutations = false;
      this.capabilities = undefined;
      if (this.owner.current()) await this.owner.release();
      throw error;
    }
  }

  public async quiesce(): Promise<void> {
    this.acceptingMutations = false;
    await this.scopes.drain();
    this.scheduleMaintenance(true);
    await this.maintenanceTail;
  }

  public async dispose(): Promise<void> {
    await this.quiesce();
    await this.owner.release();
    this.capabilities = undefined;
    this.initialized = false;
  }

  public async execute<
    TPayload extends JsonValue,
    TView,
    TResult extends JsonValue,
    TIds extends Record<string, string>
  >(options: ExecuteCommandOptions<TPayload, TView, TResult, TIds>): Promise<FileTransactionResult<TResult>> {
    this.requireMutationAdmission();
    const { command, handler } = options;
    const declaredSpec = handler.requiredView(command);
    const requestedScopes = commandScopeIds(command);
    if (!sameIds(requestedScopes, declaredSpec.conversations)) {
      throw new FileTransactionIntegrityError('Handler DurableViewSpec conversations do not match the requested command scope.');
    }
    const spec = options.executionViewSpec ?? declaredSpec;
    assertResolvedViewExtendsDeclared(declaredSpec, spec);
    const executionScopes = [...new Set(spec.conversations)].sort();
    if (requestedScopes.some((scope) => !executionScopes.includes(scope))) {
      throw new FileTransactionIntegrityError('Resolved execution scope does not contain the requested command scope.');
    }
    const sourceKey = `command:${command.commandId}`;
    const payloadHash = commandPayloadHash(command as CommandEnvelope);
    const keys = [
      commandExecutionKey(command.commandId),
      ...executionScopes.map(conversationExecutionKey),
      ...spec.storageResourceKeys.map(storageExecutionKey)
    ];

    const performanceRequestedAt = Date.now();
    return this.scopes.run(keys, async () => {
      const performance: TransactionPerformanceSample = {
        kind: 'command',
        commandType: command.type,
        sourceKey,
        scopeCount: executionScopes.length,
        storageResourceCount: spec.storageResourceKeys.length,
        queueMs: Date.now() - performanceRequestedAt,
        startedAt: Date.now(),
        phases: {}
      };
      try {
        await measureTransactionPhase(performance, 'owner_verify', () => this.owner.verify());
        this.assertStorageHealthy(executionScopes, spec.storageResourceKeys);
        await measureTransactionPhase(performance, 'settle_pending', () => this.settlePendingForStorage(executionScopes, spec.storageResourceKeys));

        let heads: ReadonlyMap<string, StorageHead> | undefined;
        let planningCommand: CommandEnvelope<TPayload> | undefined;
        let view: DurableAggregateView<TView> | undefined;
        let claimed: { claim: DurableSourceClaim; created: boolean };

        if (options.preClaimValidate) {
          const existingClaim = await measureTransactionPhase(performance, 'read_source_claim', () => this.readClaim(sourceKey));
          if (!existingClaim) {
            heads = await measureTransactionPhase(performance, 'read_heads', () => this.readHeads(executionScopes, spec.storageResourceKeys));
            // A stale optimistic version is a normal durable rejection, so it does not need a graph
            // fence. A potentially mutating command validates the frozen graph before claiming.
            if (staleExpectedVersions(command, heads).length === 0) {
              planningCommand = options.prepareCommand
                ? await measureTransactionPhase(performance, 'prepare_command', () => options.prepareCommand!(command))
                : command;
              view = await measureTransactionPhase(performance, 'load_view', () => this.readViewConsistently<TView>(spec, heads!));
              await measureTransactionPhase(performance, 'validate_scope_preclaim', async () => {
                await options.preClaimValidate!({ command: planningCommand!, view: view!, executionViewSpec: spec });
              });
            }
          }
          claimed = existingClaim
            ? { claim: existingClaim, created: false }
            : await measureTransactionPhase(performance, 'claim_source', () => this.claimSource(sourceKey, payloadHash, () => this.ids.nextTransitionId()));
        } else {
          claimed = await measureTransactionPhase(performance, 'claim_source', () => this.claimSource(sourceKey, payloadHash, () => this.ids.nextTransitionId()));
        }

        const claim = claimed.claim;
        performance.transitionId = claim.transitionId;
        await this.hit('after_source_claim', claim.transitionId);
        if (claim.payloadHash !== payloadHash) {
          performance.outcome = 'rejected:command_id_reused';
          this.recordDiagnostic('command_id_reused', command, claim.transitionId, 'payload_hash_mismatch');
          return { ack: commandIdReusedAck(command.commandId), patches: [] };
        }

        const replay = claimed.created
          ? undefined
          : await measureTransactionPhase(performance, 'replay_source', () => this.replayCommand<TResult>(command.commandId, claim));
        if (replay) {
          performance.outcome = `replay:${replay.status}`;
          const replayWal = await measureTransactionPhase(performance, 'read_replay_wal', () => this.readCommittedWal(claim.transitionId));
          return { ack: replay, patches: replayWal?.patches ?? [] };
        }

        if (!claimed.created && claim.writerFencingToken !== this.owner.requireOwner().fencingToken) {
          throw new SourceClaimRecoveryRequiredError(command.commandId, claim.transitionId);
        }

        let compiled: Awaited<ReturnType<FileTransactionAdapter['compile']>> | undefined;
        let prepared = false;
        let storageCommitted = false;
        try {
          heads ??= await measureTransactionPhase(performance, 'read_heads', () => this.readHeads(executionScopes, spec.storageResourceKeys));
          const stale = staleExpectedVersions(command, heads);
          if (stale.length > 0) {
            const rejection: CommandRejection = { status: 'rejected', code: 'stale_version', message: 'Conversation version changed before the command committed.' };
            const ack = await measureTransactionPhase(performance, 'write_rejection_receipt', () => this.commitRejection(command, payloadHash, claim, rejection, heads!));
            performance.outcome = 'rejected:stale_version';
            return { ack, patches: [] };
          }

          planningCommand ??= options.prepareCommand
            ? await measureTransactionPhase(performance, 'prepare_command', () => options.prepareCommand!(command))
            : command;
          assertCommandAdmissionIdentity(command, planningCommand, claim.transitionId);
          view ??= await measureTransactionPhase(performance, 'load_view', () => this.readViewConsistently<TView>(spec, heads!));
          if (options.preClaimValidate && !claimed.created) {
            await measureTransactionPhase(performance, 'validate_scope_preclaim', async () => {
              await options.preClaimValidate!({ command: planningCommand!, view: view!, executionViewSpec: spec });
            });
          }
          if (!heads || !view || !planningCommand) throw new FileTransactionIntegrityError('Command planning view was not loaded under the claimed scope.', claim.transitionId);
          const planningHeads = heads;
          const planningView = view;
          const admittedCommand = planningCommand;
          const context = options.createPlanningContext({ command: admittedCommand, transitionId: claim.transitionId, now: Date.now() });
          if (context.transitionId !== claim.transitionId) throw new FileTransactionIntegrityError('Planning context changed the claimed transitionId.', claim.transitionId);
          const planned = measureTransactionPhaseSync(performance, 'plan', () => handler.plan(planningView, admittedCommand, context));
          if (isCommandRejection(planned)) {
            const ack = await measureTransactionPhase(performance, 'write_rejection_receipt', () => this.commitRejection(command, payloadHash, claim, planned, planningHeads));
            performance.outcome = `rejected:${planned.code}`;
            return { ack, patches: [] };
          }
          validateTransitionPlan(planned, claim.transitionId, executionScopes, planningHeads);

          compiled = await measureTransactionPhase(performance, 'compile', () => this.adapter.compile(planningView, planned, { now: context.now }));
          measureTransactionPhaseSync(performance, 'validate_compile', () => compiled!.validate?.());
          const committedPlan = withCompiledPatches(planned, compiled.patches);
          const physical = await measureTransactionPhase(performance, 'prepare_physical', () => this.preparePhysicalPlan(committedPlan, compiled!.postimages, compiled!.postimageHeadKeys, planningHeads, {
            sourceKey,
            source: { kind: 'command', commandId: command.commandId, payloadHash },
            kind: command.type
          }, context.now));
          performance.postimageCount = physical.postimages.length;
          performance.postimageBytes = physical.postimages.reduce((total, postimage) => total + (postimage.bytes?.byteLength ?? 0), 0);
          await measureTransactionPhase(performance, 'stage_postimages', () => this.stagePostimages(physical.postimages));
          await this.hit('after_staging', planned.transitionId);
          await measureTransactionPhase(performance, 'write_prepared_wal', () => this.writePreparedWal(physical.wal));
          prepared = true;
          this.pending.set(planned.transitionId, physical.wal);
          await this.hit('after_prepared', planned.transitionId);
          await measureTransactionPhase(performance, 'roll_forward', () => this.rollForward(physical.wal));
          storageCommitted = true;
          await this.hit('after_storage_committed', planned.transitionId);
          const receipt = await measureTransactionPhase(performance, 'write_receipt', () => this.writeCommittedReceipt(command.commandId, payloadHash, physical.wal));
          await this.hit('after_receipt', planned.transitionId);
          await measureTransactionPhase(performance, 'commit_claim', () => this.updateClaim(claim, 'committed', receiptPath(sourceKey)));
          await this.hit('after_claim_committed', planned.transitionId);

          await measureTransactionPhase(performance, 'commit_projection', () => this.commitProjectionAfterStorage(compiled!.projection, physical.wal));
          try { await measureTransactionPhase(performance, 'after_commit', async () => compiled!.afterCommit?.()); }
          catch (error) { console.error('[Reliability] post-commit wakeup/cleanup hint failed:', error); }
          performance.outcome = 'committed';
          this.recordCommittedCommandDiagnostics(command, physical.wal);
          this.scheduleMaintenance();
          const ack = committedAck(command.commandId, physical.wal, 'committed') as CommandAck<TResult>;
          return { ack, patches: physical.wal.patches, projection: compiled.projection };
        } catch (error) {
          performance.outcome ??= 'failed';
          if (storageCommitted) throw error;
          compiled?.projection?.discard();
          if (prepared) throw new PreparedTransitionPendingError(claim.transitionId, error);
          throw await measureTransactionPhase(performance, 'write_failure_receipt', () => this.commitCommandFailure(command.commandId, payloadHash, claim, error, heads ?? new Map()));
        }
      } finally {
        logSlowTransaction(performance);
      }
    });
  }

  public async executeInternal<
    TPayload extends JsonValue,
    TView,
    TResult extends JsonValue,
    TIds extends Record<string, string>
  >(options: ExecuteInternalOptions<TPayload, TView, TResult, TIds>): Promise<FileInternalTransactionResult<TResult>> {
    this.requireMutationAdmission();
    const { command, handler } = options;
    const declaredSpec = handler.requiredView(command);
    const requestedScopes = commandScopeIds(command);
    if (!sameIds(requestedScopes, declaredSpec.conversations)) {
      throw new FileTransactionIntegrityError('Internal handler DurableViewSpec conversations do not match the requested scope.');
    }
    const spec = options.executionViewSpec ?? declaredSpec;
    assertResolvedViewExtendsDeclared(declaredSpec, spec);
    const executionScopes = [...new Set(spec.conversations)].sort();
    if (requestedScopes.some((scope) => !executionScopes.includes(scope))) {
      throw new FileTransactionIntegrityError('Resolved internal execution scope does not contain the requested scope.');
    }
    validateInternalSourceKey(command.sourceKey);
    const payloadHash = internalPayloadHash(command);
    const keys = [
      sourceExecutionKey(command.sourceKey),
      ...executionScopes.map(conversationExecutionKey),
      ...spec.storageResourceKeys.map(storageExecutionKey)
    ];

    const performanceRequestedAt = Date.now();
    return this.scopes.run(keys, async () => {
      const performance: TransactionPerformanceSample = {
        kind: 'internal',
        commandType: command.type,
        sourceKey: command.sourceKey,
        scopeCount: executionScopes.length,
        storageResourceCount: spec.storageResourceKeys.length,
        queueMs: Date.now() - performanceRequestedAt,
        startedAt: Date.now(),
        phases: {}
      };
      try {
      await measureTransactionPhase(performance, 'owner_verify', () => this.owner.verify());
      this.assertStorageHealthy(executionScopes, spec.storageResourceKeys);
      await measureTransactionPhase(performance, 'settle_pending', () => this.settlePendingForStorage(executionScopes, spec.storageResourceKeys));

      let heads: ReadonlyMap<string, StorageHead> | undefined;
      let planningCommand: InternalCommandEnvelope<TPayload> | undefined;
      let view: DurableAggregateView<TView> | undefined;
      let claimed: { claim: DurableSourceClaim; created: boolean };

      if (options.preClaimValidate) {
        // Dynamic RunGraph control must validate under the exact mutation locks before creating its
        // idempotency claim. A changed closure can then be re-resolved without poisoning sourceKey.
        const existingClaim = await measureTransactionPhase(performance, 'read_source_claim', () => this.readClaim(command.sourceKey));
        if (!existingClaim) {
          heads = await measureTransactionPhase(performance, 'read_heads', () => this.readHeads(executionScopes, spec.storageResourceKeys));
          planningCommand = options.prepareCommand
            ? await measureTransactionPhase(performance, 'prepare_command', () => options.prepareCommand!(command))
            : command;
          view = await measureTransactionPhase(performance, 'load_view', () => this.readViewConsistently<TView>(spec, heads!));
          await measureTransactionPhase(performance, 'validate_scope_preclaim', async () => {
            await options.preClaimValidate!({
              command: planningCommand!,
              view: view!,
              executionViewSpec: spec
            });
          });
        }
        claimed = existingClaim
          ? { claim: existingClaim, created: false }
          : await measureTransactionPhase(performance, 'claim_source', () => this.claimSource(command.sourceKey, payloadHash, () => this.ids.nextTransitionId()));
      } else {
        claimed = await measureTransactionPhase(performance, 'claim_source', () => this.claimSource(command.sourceKey, payloadHash, () => this.ids.nextTransitionId()));
      }

      const claim = claimed.claim;
      performance.transitionId = claim.transitionId;
      await this.hit('after_source_claim', claim.transitionId);
      if (claim.payloadHash !== payloadHash) {
        this.recordInternalDiagnostic('source_claim_conflict', command, claim.transitionId, 'payload_hash_mismatch');
        throw new FileTransactionIntegrityError(`Internal source key was reused with a different payload: ${command.sourceKey}`, claim.transitionId);
      }

      const replay = claimed.created ? undefined : await measureTransactionPhase(performance, 'replay_source', () => this.replayInternal<TResult>(claim));
      if (replay) {
        performance.outcome = `replay:${replay.status}`;
        this.recordInternalTransitionDiagnostics(command, replay.transitionId, replay.status, replay.result);
        return replay;
      }
      if (!claimed.created && claim.writerFencingToken !== this.owner.requireOwner().fencingToken) {
        throw new SourceClaimRecoveryRequiredError(command.sourceKey, claim.transitionId);
      }

      heads ??= await measureTransactionPhase(performance, 'read_heads', () => this.readHeads(executionScopes, spec.storageResourceKeys));
      planningCommand ??= options.prepareCommand
        ? await measureTransactionPhase(performance, 'prepare_command', () => options.prepareCommand!(command))
        : command;
      assertInternalAdmissionIdentity(command, planningCommand, claim.transitionId);
      view ??= await measureTransactionPhase(performance, 'load_view', () => this.readViewConsistently<TView>(spec, heads!));
      if (options.preClaimValidate && !claimed.created) {
        // A pre-existing claim may come from recovery/older code. Validate before planning even though
        // it cannot be re-targeted; this still fails closed instead of applying a changed graph.
        await measureTransactionPhase(performance, 'validate_scope_preclaim', async () => {
          await options.preClaimValidate!({
            command: planningCommand!,
            view: view!,
            executionViewSpec: spec
          });
        });
      }
      const context = options.createPlanningContext({ command: planningCommand, transitionId: claim.transitionId, now: Date.now() });
      if (context.transitionId !== claim.transitionId) throw new FileTransactionIntegrityError('Internal planning context changed the claimed transitionId.', claim.transitionId);
      const planned = measureTransactionPhaseSync(performance, 'plan', () => handler.plan(view, planningCommand, context));
      if (isInternalNoop(planned)) {
        const receipt = await measureTransactionPhase(performance, 'write_noop_receipt', () => this.writeInternalNoopReceipt(command, payloadHash, claim, planned, heads));
        await measureTransactionPhase(performance, 'commit_claim', () => this.updateClaim(claim, 'committed', receiptPath(command.sourceKey)));
        const result = internalResultFromReceipt(receipt, planned.status);
        performance.outcome = `noop:${result.status}`;
        this.recordInternalTransitionDiagnostics(command, claim.transitionId, result.status, result.result);
        return result;
      }
      validateTransitionPlan(planned, claim.transitionId, executionScopes, heads);

      const compiled = await measureTransactionPhase(performance, 'compile', () => this.adapter.compile(view, planned, { now: context.now }));
      measureTransactionPhaseSync(performance, 'validate_compile', () => compiled.validate?.());
      const committedPlan = withCompiledPatches(planned, compiled.patches);
      const physical = await measureTransactionPhase(performance, 'prepare_physical', () => this.preparePhysicalPlan(committedPlan, compiled.postimages, compiled.postimageHeadKeys, heads, {
        sourceKey: command.sourceKey,
        source: walSourceForInternal(command, payloadHash),
        kind: command.type
      }, context.now));
      performance.postimageCount = physical.postimages.length;
      performance.postimageBytes = physical.postimages.reduce((total, postimage) => total + (postimage.bytes?.byteLength ?? 0), 0);
      let prepared = false;
      let storageCommitted = false;
      try {
        await measureTransactionPhase(performance, 'stage_postimages', () => this.stagePostimages(physical.postimages));
        await this.hit('after_staging', planned.transitionId);
        await measureTransactionPhase(performance, 'write_prepared_wal', () => this.writePreparedWal(physical.wal));
        prepared = true;
        this.pending.set(planned.transitionId, physical.wal);
        await this.hit('after_prepared', planned.transitionId);
        await measureTransactionPhase(performance, 'roll_forward', () => this.rollForward(physical.wal));
        storageCommitted = true;
        await this.hit('after_storage_committed', planned.transitionId);
        const receipt = await measureTransactionPhase(performance, 'write_receipt', () => this.writeInternalCommittedReceipt(command, payloadHash, physical.wal));
        await this.hit('after_receipt', planned.transitionId);
        await measureTransactionPhase(performance, 'commit_claim', () => this.updateClaim(claim, 'committed', receiptPath(command.sourceKey)));
        await this.hit('after_claim_committed', planned.transitionId);

        await measureTransactionPhase(performance, 'commit_projection', () => this.commitProjectionAfterStorage(compiled.projection, physical.wal));
        try { await measureTransactionPhase(performance, 'after_commit', async () => compiled.afterCommit?.()); }
        catch (error) { console.error('[Reliability] internal post-commit wakeup/cleanup hint failed:', error); }
        performance.outcome = 'committed';
        this.recordInternalTransitionDiagnostics(command, planned.transitionId, 'committed', planned.result);
        this.scheduleMaintenance();
        return {
          transitionId: planned.transitionId,
          status: 'committed',
          heads: headsFromWal(physical.wal),
          result: planned.result,
          patches: physical.wal.patches,
          projection: compiled.projection
        };
      } catch (error) {
        if (!storageCommitted) {
          compiled.projection?.discard();
          if (prepared) throw new PreparedTransitionPendingError(planned.transitionId, error);
        }
        performance.outcome ??= 'failed';
        throw error;
      }
      } finally {
        logSlowTransaction(performance);
      }
    });
  }

  /** Reads one typed durable view under the same scope/resource barrier used by mutations. */
  public async readCommittedView<TView>(spec: DurableViewSpec<TView>): Promise<DurableAggregateView<TView>> {
    this.requireInitialized();
    const scopes = [...new Set(spec.conversations)].sort();
    if (scopes.length === 0) throw new FileTransactionIntegrityError('A committed durable view requires at least one conversation.');
    const keys = [
      ...scopes.map(conversationExecutionKey),
      ...spec.storageResourceKeys.map(storageExecutionKey)
    ];
    const performanceRequestedAt = Date.now();
    return this.scopes.run(keys, async () => {
      const performance: TransactionPerformanceSample = {
        kind: 'read',
        commandType: spec.kind,
        sourceKey: `read:${spec.kind}:${scopes.join(',')}`,
        scopeCount: scopes.length,
        storageResourceCount: spec.storageResourceKeys.length,
        queueMs: Date.now() - performanceRequestedAt,
        startedAt: Date.now(),
        phases: {}
      };
      try {
        await measureTransactionPhase(performance, 'owner_verify', () => this.owner.verify());
        this.assertStorageHealthy(scopes, spec.storageResourceKeys);
        await measureTransactionPhase(performance, 'settle_pending', () => this.settlePendingForStorage(scopes, spec.storageResourceKeys));
        const heads = await measureTransactionPhase(performance, 'read_heads', () => this.readHeads(scopes, spec.storageResourceKeys));
        const view = await measureTransactionPhase(performance, 'load_view', () => this.readViewConsistently(spec, heads) as Promise<DurableAggregateView<TView>>);
        performance.outcome = 'read';
        return view;
      } catch (error) {
        performance.outcome = 'failed';
        throw error;
      } finally {
        logSlowTransaction(performance);
      }
    });
  }

  /**
   * Orders a transient callback with durable conversation transitions without turning each stream
   * delta into file I/O. The callback must not re-enter this backend or perform durable mutation.
   */
  public async withConversationExecutionBarrier<T>(conversationId: ConversationId, action: () => T | Promise<T>): Promise<T> {
    this.requireInitialized();
    return this.scopes.run([conversationExecutionKey(conversationId)], async () => action());
  }

  /** Discovers and removes rebuildable, explicitly untracked garbage under one storage-resource key. */
  public async sweepRebuildableGarbage(
    storageResourceKey: string,
    discoverTargets: () => Promise<readonly string[]>
  ): Promise<string[]> {
    this.requireMutationAdmission();
    return this.scopes.run([storageExecutionKey(storageResourceKey)], async () => {
      await this.owner.verify();
      this.assertStorageHealthy([], [storageResourceKey]);
      await this.settlePendingForStorage([], [storageResourceKey]);
      const targets = [...new Set((await discoverTargets()).map(normalizeRelativePath))].sort();
      for (const target of targets) {
        if (!isRebuildableGarbageTarget(target)) throw new FileTransactionIntegrityError(`Target is not rebuildable garbage: ${target}`);
      }
      const headKey = storageResourceHeadKey(storageResourceKey);
      const head = await this.readHead(headKey) ?? genesisResourceHead(storageResourceKey, this.owner.requireOwner().fencingToken);
      const removed: string[] = [];
      for (const target of targets) {
        if (head.targetHashes[target] !== undefined) continue;
        if (await this.files.hash(target) === null) continue;
        await this.files.remove(target);
        removed.push(target);
      }
      return removed;
    });
  }

  /** Protects a read of a shared physical index with its StorageHead and prepared-WAL digest. */
  public async readStorageResource<T>(storageResourceKeys: readonly string[], reader: () => Promise<T>): Promise<T> {
    this.requireInitialized();
    const resources = [...new Set(storageResourceKeys)].sort();
    if (resources.length === 0) throw new FileTransactionIntegrityError('A storage-resource read requires at least one resource key.');
    const performanceRequestedAt = Date.now();
    return this.scopes.run(resources.map(storageExecutionKey), async () => {
      const performance: TransactionPerformanceSample = {
        kind: 'read',
        commandType: 'storage_resource.read',
        sourceKey: `read:storage:${resources.join(',')}`,
        scopeCount: 0,
        storageResourceCount: resources.length,
        queueMs: Date.now() - performanceRequestedAt,
        startedAt: Date.now(),
        phases: {}
      };
      try {
        await measureTransactionPhase(performance, 'owner_verify', () => this.owner.verify());
        this.assertStorageHealthy([], resources);
        await measureTransactionPhase(performance, 'settle_pending', () => this.settlePendingForStorage([], resources));
        // The storage-resource scope and single-writer fence keep this HEAD lease stable for the read.
        await measureTransactionPhase(performance, 'read_heads', () => this.readHeads([], resources));
        const value = await measureTransactionPhase(performance, 'read_resource', reader);
        performance.outcome = 'read';
        return value;
      } catch (error) {
        performance.outcome = 'failed';
        throw error;
      } finally {
        logSlowTransaction(performance);
      }
    });
  }

  public writerEpoch(): string {
    this.requireInitialized();
    return this.owner.requireOwner().fencingToken;
  }

  public async conversationHead(conversationId: ConversationId): Promise<CommittedConversationHead> {
    this.requireInitialized();
    const head = await this.readHead(conversationControlHeadKey(conversationId))
      ?? genesisConversationControlHead(conversationId, this.owner.requireOwner().fencingToken);
    return {
      conversationId,
      version: head.controlVersion,
      streamId: `conversation:${conversationId}:state`,
      patchNextSeq: head.streamNextSeq
    };
  }

  public async status(commandId: CommandId): Promise<CommandStatus> {
    this.requireInitialized();
    const sourceKey = `command:${commandId}`;
    const claim = await this.readClaim(sourceKey);
    if (!claim) return { status: 'not_found' };
    const receipt = await this.readReceipt(sourceKey);
    if (receipt?.finalStatus === 'rejected') {
      return { status: 'rejected', ack: rejectionAckFromReceipt(receipt) };
    }
    if (receipt?.finalStatus === 'committed') {
      return { status: 'committed', ack: committedAckFromReceipt(receipt, 'already_applied') };
    }
    if (receipt?.finalStatus === 'failed') {
      return { status: 'failed', error: commandServiceErrorFromFailedReceipt(receipt) };
    }
    const committed = await this.readCommittedWal(claim.transitionId);
    if (committed) return { status: 'committed', ack: committedAck(commandId, committed, 'already_applied') as CommandAck<JsonValue> };
    const blockedScope = [...this.blockedScopes.entries()].find(([, reason]) => reason.includes(claim.transitionId));
    if (blockedScope) {
      return {
        status: 'blocked',
        error: { commandId, status: 'unavailable', code: 'recovery_required', message: blockedScope[1] }
      };
    }
    if (this.pending.has(claim.transitionId) || await this.readPendingWal(claim.transitionId)) {
      return { status: 'in_progress', transitionId: claim.transitionId };
    }
    if (claim.writerFencingToken === this.owner.requireOwner().fencingToken && claim.state === 'claimed') {
      // The live writer may still be planning/compiling before the prepared WAL exists.
      return { status: 'in_progress', transitionId: claim.transitionId };
    }
    return {
      status: 'blocked',
      error: {
        commandId,
        status: 'unavailable',
        code: 'recovery_required',
        message: `Command ${commandId} has an unfinished claim from another writer epoch.`
      }
    };
  }

  public async recoverPending(): Promise<void> {
    this.requireOwnerOnly();
    for (const wal of [...this.pending.values()].sort((left, right) => left.createdAt - right.createdAt || left.transitionId.localeCompare(right.transitionId))) {
      const keys = [
        sourceExecutionKey(wal.sourceKey),
        ...wal.scopes.map(conversationExecutionKey),
        ...wal.expectedStorageHeads.map((head) => storageExecutionKey(head.headKey))
      ];
      await this.scopes.run(keys, async () => {
        const committed = await this.readCommittedWal(wal.transitionId);
        if (committed) {
          await this.finalizeRecoveredSource(committed);
          this.pending.delete(wal.transitionId);
          await this.files.remove(pendingWalPath(wal.transitionId));
          return;
        }
        try {
          await this.rollForward(wal, true);
          await this.finalizeRecoveredSource(wal);
          this.pending.delete(wal.transitionId);
          await this.files.remove(pendingWalPath(wal.transitionId));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          const diagnostic = `Transition ${wal.transitionId}: ${reason}`;
          for (const scope of wal.scopes) this.blockedScopes.set(scope, diagnostic);
          for (const head of [...wal.expectedStorageHeads, ...wal.postStorageHeads]) this.blockedHeadKeys.set(head.headKey, diagnostic);
          this.diagnostics?.record({
            kind: 'wal_integrity_failed',
            timestamp: Date.now(),
            transitionId: wal.transitionId,
            conversationId: wal.scopes[0],
            reasonCode: 'rollforward_failed'
          });
        }
      });
    }
  }

  public async compactCommitted(transitionId: TransitionId): Promise<void> {
    this.requireInitialized();
    await this.compactOneCommitted(transitionId);
  }

  /** Runs deterministic WAL/staging maintenance; exposed for lifecycle hooks and fault tests. */
  public async maintain(): Promise<void> {
    this.requireInitialized();
    await this.owner.verify();
    await this.compactAllCommitted();
  }

  public blockedScopeDiagnostics(): Array<{ conversationId: ConversationId; reason: string }> {
    return [...this.blockedScopes].map(([conversationId, reason]) => ({ conversationId, reason }));
  }

  /** Returns a payload-free development snapshot of the file transaction control plane. */
  public async inspectStorage(): Promise<FileTransactionStorageInspection> {
    this.requireInitialized();
    await this.maintenanceTail;
    const [writer, heads, pendingWals, committedWals, sourceClaims, receipts, stagingFiles] = await Promise.all([
      this.owner.verify(),
      this.readInspectionRecords<StorageHead>(HEADS_DIR),
      this.readInspectionRecords<FileConversationWalRecord>(PENDING_DIR),
      this.readInspectionRecords<FileConversationWalRecord>(COMMITTED_DIR),
      this.readInspectionRecords<DurableSourceClaim>(CLAIMS_DIR),
      this.readInspectionRecords<CommandReceipt | InternalTransitionReceipt>(RECEIPTS_DIR),
      this.files.listFilesRecursive(STAGING_DIR)
    ]);
    const pending = pendingWals.map(walInspectionRecord);
    const committed = committedWals.map(walInspectionRecord);
    const walTransitionIds = new Set([...pending, ...committed].map((wal) => wal.transitionId));
    const inspectedReceipts = receipts.map(receiptInspectionRecord);
    const capabilities = this.capabilities;
    if (!capabilities) throw new FileTransactionIntegrityError('File durability capabilities are unavailable after initialization.');
    return {
      capturedAt: Date.now(),
      dataRoot: this.files.dataRoot,
      capabilities: { ...capabilities },
      writer: { ...writer },
      heads: heads.sort((left, right) => left.headKey.localeCompare(right.headKey)),
      pendingWals: pending.sort(compareWalInspection),
      committedWals: committed.sort(compareWalInspection),
      sourceClaims: sourceClaims.sort((left, right) => left.createdAt - right.createdAt || left.sourceKey.localeCompare(right.sourceKey)),
      receipts: inspectedReceipts.sort((left, right) => left.createdAt - right.createdAt || left.sourceKey.localeCompare(right.sourceKey)),
      stagingTransitionIds: [...new Set(stagingFiles.map(stagingTransitionId))].sort(),
      currentHeadTransitionIds: [...new Set(heads.map((head) => head.latestTransitionId).filter((id): id is TransitionId => !!id))].sort(),
      receiptOnlyTransitionIds: [...new Set(inspectedReceipts.map((receipt) => receipt.transitionId).filter((id) => !walTransitionIds.has(id)))].sort(),
      blockedScopes: this.blockedScopeDiagnostics().sort((left, right) => left.conversationId.localeCompare(right.conversationId)),
      blockedHeadKeys: [...this.blockedHeadKeys].map(([headKey, reason]) => ({ headKey, reason })).sort((left, right) => left.headKey.localeCompare(right.headKey))
    };
  }

  private async readInspectionRecords<T>(relativeDirectory: string): Promise<T[]> {
    const records: T[] = [];
    for (const relativePath of await this.files.listFilesRecursive(relativeDirectory)) {
      const record = await this.files.readJson<T>(relativePath);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  private async preparePhysicalPlan<TResult extends JsonValue>(
    plan: TransitionPlan<TResult>,
    postimages: readonly Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>[],
    postimageHeadKeys: Readonly<Record<string, string>>,
    heads: ReadonlyMap<string, StorageHead>,
    source: { sourceKey: string; source: FileConversationWalRecord['source']; kind: string },
    now: number
  ): Promise<{ postimages: DurablePostimage[]; wal: FileConversationWalRecord<TResult> }> {
    const registry = new StoragePathAuthorityRegistry(plan.scopes);
    const targetSet = new Set<string>();
    const normalizedPostimages = postimages.map((postimage, index) => {
      const targetRelativePath = normalizeRelativePath(postimage.targetRelativePath);
      assertBusinessTarget(targetRelativePath);
      if (targetSet.has(targetRelativePath)) throw new FileTransactionIntegrityError(`Duplicate file mutation target: ${targetRelativePath}`, plan.transitionId);
      targetSet.add(targetRelativePath);
      let authority;
      try { authority = registry.requireClassified(targetRelativePath); }
      catch (error) { throw new FileTransactionIntegrityError(error instanceof Error ? error.message : String(error), plan.transitionId); }
      if (authority.durabilityClass !== 'authoritative-mutable' || !authority.owner) {
        throw new FileTransactionIntegrityError(`Durable transition may publish only authoritative mutable files: ${targetRelativePath} (${authority.durabilityClass})`, plan.transitionId);
      }
      const registeredHeadKey = storageHeadKey(authority.owner);
      const compiledHeadKey = postimageHeadKeys[targetRelativePath];
      if (compiledHeadKey !== registeredHeadKey) {
        throw new FileTransactionIntegrityError(`Compiled Storage HEAD owner disagrees with the authority registry: ${targetRelativePath}`, plan.transitionId);
      }
      const ownerHead = heads.get(registeredHeadKey);
      if (!ownerHead) throw new FileTransactionIntegrityError(`File mutation has no leased StorageHead owner: ${targetRelativePath}`, plan.transitionId);
      return { postimage, index, targetRelativePath, ownerHead, ownerHeadKey: registeredHeadKey };
    });
    const prepared: DurablePostimage[] = await Promise.all(normalizedPostimages.map(async ({ postimage, index, targetRelativePath, ownerHead }) => {
      const preimageHash = await this.files.hash(targetRelativePath);
      const trackedHash = ownerHead.targetHashes[targetRelativePath];
      if (trackedHash !== undefined && trackedHash !== preimageHash) {
        throw new FileTransactionIntegrityError(`Storage HEAD hash drift detected before planning: ${targetRelativePath}`, plan.transitionId);
      }
      if (trackedHash === undefined && preimageHash !== null) {
        throw new FileTransactionIntegrityError(`Unowned authoritative file appeared beneath Storage HEAD ${ownerHead.headKey}: ${targetRelativePath}`, plan.transitionId);
      }
      if (postimage.operation === 'delete') {
        if (postimage.postimageHash !== null || postimage.bytes !== undefined) {
          throw new FileTransactionIntegrityError(`Compiled delete has write content: ${targetRelativePath}`, plan.transitionId);
        }
        return { operation: 'delete', targetRelativePath, preimageHash, postimageHash: null };
      }
      if (!postimage.bytes) throw new FileTransactionIntegrityError(`Compiled write has no bytes: ${targetRelativePath}`, plan.transitionId);
      const bytes = new Uint8Array(postimage.bytes);
      const postimageHash = sha256Bytes(bytes);
      if (postimage.postimageHash !== postimageHash) throw new FileTransactionIntegrityError(`Compiled postimage hash mismatch: ${targetRelativePath}`, plan.transitionId);
      return {
        operation: 'write',
        targetRelativePath,
        stagingRelativePath: `${STAGING_DIR}/${plan.transitionId}/${index.toString().padStart(6, '0')}-${postimageHash}.bin`,
        preimageHash,
        postimageHash,
        bytes
      };
    }));

    const ownerByTarget = new Map(normalizedPostimages.map((entry) => [entry.targetRelativePath, entry.ownerHeadKey]));
    const nextVersions = new Map(plan.nextVersions.map((version) => [version.conversationId, version.version]));
    const postHeads: StorageHead[] = [];
    for (const previous of [...heads.values()].sort((left, right) => left.headKey.localeCompare(right.headKey))) {
      const ownedPostimages = prepared.filter((postimage) => ownerByTarget.get(postimage.targetRelativePath) === previous.headKey);
      if (previous.headKind !== 'conversation-control' && ownedPostimages.length === 0) continue;
      const nextVersion = previous.headKind === 'conversation-control' && previous.conversationId
        ? nextVersions.get(previous.conversationId)
        : undefined;
      if (previous.headKind === 'conversation-control' && nextVersion === undefined) {
        throw new FileTransactionIntegrityError(`Transition omitted nextVersion for ${previous.conversationId ?? previous.headKey}.`, plan.transitionId);
      }
      const patches = previous.headKind === 'conversation-control' && previous.conversationId
        ? plan.patches.filter((patch) => patch.conversationId === previous.conversationId)
        : [];
      const targetHashes = { ...previous.targetHashes };
      for (const postimage of ownedPostimages) {
        if (postimage.operation === 'delete') delete targetHashes[postimage.targetRelativePath];
        else targetHashes[postimage.targetRelativePath] = postimage.postimageHash!;
      }
      const head: StorageHead = {
        ...previous,
        generation: previous.generation + 1,
        latestTransitionId: plan.transitionId,
        writerFencingToken: this.owner.requireOwner().fencingToken,
        controlVersion: nextVersion ?? 0,
        streamNextSeq: previous.headKind === 'conversation-control'
          ? patches.reduce((value, patch) => Math.max(value, patch.nextSeq), previous.streamNextSeq)
          : 0,
        targetHashes
      };
      validateStorageHead(head, head.headKey);
      postHeads.push(head);
      const bytes = jsonBytes(head);
      const hash = sha256Bytes(bytes);
      const targetRelativePath = headPath(head.headKey);
      prepared.push({
        operation: 'write',
        targetRelativePath,
        stagingRelativePath: `${STAGING_DIR}/${plan.transitionId}/head-${sha256Text(head.headKey).slice(0, 12)}-${hash}.bin`,
        preimageHash: await this.files.hash(targetRelativePath),
        postimageHash: hash,
        bytes
      });
    }

    const wal: FileConversationWalRecord<TResult> = {
      schemaVersion: 1,
      writerFencingToken: this.owner.requireOwner().fencingToken,
      transitionId: plan.transitionId,
      sourceKey: source.sourceKey,
      source: source.source,
      kind: source.kind,
      scopes: [...plan.scopes],
      baseVersions: plan.baseVersions,
      nextVersions: plan.nextVersions,
      expectedStorageHeads: [...heads.values()],
      postStorageHeads: postHeads,
      state: 'prepared',
      generatedIds: [...plan.generatedIds],
      files: prepared.map(({ operation, targetRelativePath, stagingRelativePath, preimageHash, postimageHash }) => ({ operation, targetRelativePath, stagingRelativePath, preimageHash, postimageHash })),
      result: plan.result,
      patches: plan.patches.map((patch) => ({ ...patch, operations: [...patch.operations] })),
      patchHeads: plan.patches.map((patch) => ({ conversationId: patch.conversationId, streamId: patch.streamId, baseSeq: patch.baseSeq, nextSeq: patch.nextSeq })),
      createdAt: now,
      updatedAt: now
    };
    return { postimages: prepared, wal };
  }

  private async stagePostimages(postimages: readonly DurablePostimage[]): Promise<void> {
    await Promise.all(postimages.map(async (postimage) => {
      if (postimage.operation === 'delete') return;
      if (!postimage.stagingRelativePath || !postimage.bytes || !postimage.postimageHash) {
        throw new FileTransactionIntegrityError(`Write postimage is incomplete: ${postimage.targetRelativePath}`);
      }
      const existing = await this.files.hash(postimage.stagingRelativePath);
      if (existing === postimage.postimageHash) return;
      if (existing !== null) throw new FileTransactionIntegrityError(`Immutable staging path already has different content: ${postimage.stagingRelativePath}`);
      await this.files.atomicWrite(postimage.stagingRelativePath, postimage.bytes, { createOnly: true });
    }));
  }

  private async writePreparedWal(wal: FileConversationWalRecord): Promise<void> {
    if (!wal.sourceKey || !wal.kind || !wal.source.kind) throw new FileTransactionIntegrityError('Prepared WAL source metadata was not initialized.', wal.transitionId);
    await this.files.atomicWrite(pendingWalPath(wal.transitionId), jsonBytes(wal), { createOnly: true });
    this.diagnostics?.record({
      kind: 'wal_prepared',
      timestamp: Date.now(),
      transitionId: wal.transitionId,
      conversationId: wal.scopes[0],
      ...(wal.source.kind === 'command' ? { commandId: wal.source.commandId } : {}),
      reasonCode: 'all_staging_durable'
    });
  }

  private async rollForward(wal: FileConversationWalRecord, recovery = false): Promise<void> {
    await this.owner.verify();
    if (recovery) {
      const committed = await this.readCommittedWal(wal.transitionId);
      if (committed) {
        this.pending.delete(wal.transitionId);
        return;
      }
    }
    validateWal(wal);
    const currentHashes = new Map((await Promise.all(wal.files.map(async (file) => {
      if (file.operation === 'write') {
        if (!file.stagingRelativePath || !file.postimageHash) throw new FileTransactionIntegrityError(`Write WAL entry is incomplete: ${file.targetRelativePath}`, wal.transitionId);
        const stagingHash = await this.files.hash(file.stagingRelativePath);
        if (stagingHash !== file.postimageHash) throw new FileTransactionIntegrityError(`Missing or corrupt staging postimage: ${file.stagingRelativePath}`, wal.transitionId);
      }
      const current = await this.files.hash(file.targetRelativePath);
      if (current !== file.preimageHash && current !== file.postimageHash) {
        throw new FileTransactionIntegrityError(`Target hash is neither preimage nor postimage: ${file.targetRelativePath}`, wal.transitionId);
      }
      return [file.targetRelativePath, current] as const;
    }))));
    let installedFiles = 0;
    const installGroup = async (files: readonly FileConversationWalRecord['files'][number][]): Promise<void> => {
      const results = await Promise.allSettled(files.map(async (file) => {
        if (currentHashes.get(file.targetRelativePath) !== file.postimageHash) {
          if (file.operation === 'delete') await this.files.remove(file.targetRelativePath);
          else await this.files.installImmutable(file.stagingRelativePath!, file.targetRelativePath, file.postimageHash!);
        }
        installedFiles += 1;
        await this.hit('after_each_install', wal.transitionId, installedFiles);
      }));
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    const businessFiles = wal.files.filter((file) => !file.targetRelativePath.startsWith(`${HEADS_DIR}/`));
    const headFiles = wal.files.filter((file) => file.targetRelativePath.startsWith(`${HEADS_DIR}/`));
    await installGroup(businessFiles);
    // Storage HEADs are commit pointers: publish them only after every business postimage is durable.
    await installGroup(headFiles);
    await Promise.all(wal.files.map(async (file) => {
      if (await this.files.hash(file.targetRelativePath) !== file.postimageHash) {
        throw new FileTransactionIntegrityError(`Installed postimage failed verification: ${file.targetRelativePath}`, wal.transitionId);
      }
    }));
    for (const head of wal.postStorageHeads) {
      const current = await this.readHead(head.headKey);
      if (!current || current.latestTransitionId !== wal.transitionId || current.generation !== head.generation) {
        throw new FileTransactionIntegrityError(`Storage HEAD was not installed: ${head.headKey}`, wal.transitionId);
      }
    }
    await this.hit('after_verify', wal.transitionId);
    const committedWal: FileConversationWalRecord = { ...wal, state: 'storage_committed', updatedAt: Date.now() };
    await this.files.atomicWrite(committedWalPath(wal.transitionId), jsonBytes(committedWal), { createOnly: true });
    this.pending.delete(wal.transitionId);
    if (recovery) {
      this.diagnostics?.record({
        kind: 'wal_rollforward_completed',
        timestamp: Date.now(),
        transitionId: wal.transitionId,
        conversationId: wal.scopes[0],
        reasonCode: 'startup_recovery'
      });
    }
  }

  private async commitRejection<TPayload extends JsonValue>(
    command: CommandEnvelope<TPayload>,
    payloadHash: string,
    claim: DurableSourceClaim,
    rejection: CommandRejection,
    heads: ReadonlyMap<string, StorageHead>
  ): Promise<CommandAck<never>> {
    const receipt: CommandReceipt = {
      schemaVersion: 1,
      sourceKey: claim.sourceKey,
      commandId: command.commandId,
      payloadHash,
      transitionId: claim.transitionId,
      finalStatus: 'rejected',
      nextVersions: versionsFromHeads(heads),
      rejection,
      patchHeads: [],
      createdAt: Date.now()
    };
    const path = receiptPath(claim.sourceKey);
    await this.files.atomicWrite(path, jsonBytes(receipt), { createOnly: true });
    await this.updateClaim(claim, 'rejected', path);
    return {
      commandId: command.commandId,
      status: 'rejected',
      code: rejection.code,
      currentVersions: receipt.nextVersions,
      message: rejection.message
    };
  }

  private async commitCommandFailure(
    commandId: CommandId,
    payloadHash: string,
    claim: DurableSourceClaim,
    error: unknown,
    heads: ReadonlyMap<string, StorageHead>
  ): Promise<DurableCommandFailureError> {
    const failure = commandFailureFromError(error);
    const receipt: CommandReceipt = {
      schemaVersion: 1,
      sourceKey: claim.sourceKey,
      commandId,
      payloadHash,
      transitionId: claim.transitionId,
      finalStatus: 'failed',
      nextVersions: versionsFromHeads(heads),
      failure,
      patchHeads: [],
      createdAt: Date.now()
    };
    const path = receiptPath(claim.sourceKey);
    let durable = receipt;
    try {
      await this.files.atomicWrite(path, jsonBytes(receipt), { createOnly: true });
    } catch (writeError) {
      if ((writeError as { code?: unknown }).code !== 'EEXIST') throw writeError;
      const existing = await this.readReceipt(claim.sourceKey);
      if (!existing || existing.transitionId !== claim.transitionId || existing.payloadHash !== payloadHash || existing.finalStatus !== 'failed' || !existing.failure) {
        throw new FileTransactionIntegrityError(`Failed receipt conflicts for ${claim.sourceKey}.`, claim.transitionId);
      }
      durable = existing;
    }
    if (claim.state === 'claimed') await this.updateClaim(claim, 'failed', path);
    return durableCommandFailureFromReceipt(durable);
  }

  private async writeCommittedReceipt(commandId: CommandId, payloadHash: string, wal: FileConversationWalRecord): Promise<CommandReceipt> {
    const receipt: CommandReceipt = {
      schemaVersion: 1,
      sourceKey: wal.sourceKey,
      commandId,
      payloadHash,
      transitionId: wal.transitionId,
      finalStatus: 'committed',
      nextVersions: wal.nextVersions,
      result: wal.result,
      patchHeads: wal.patchHeads,
      createdAt: Date.now()
    };
    const path = receiptPath(wal.sourceKey);
    try {
      await this.files.atomicWrite(path, jsonBytes(receipt), { createOnly: true });
      return receipt;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      const existing = await this.files.readJson<CommandReceipt>(path);
      if (!existing || existing.transitionId !== wal.transitionId || existing.payloadHash !== payloadHash) {
        throw new FileTransactionIntegrityError(`Committed receipt conflicts for ${wal.sourceKey}.`, wal.transitionId);
      }
      return existing;
    }
  }

  private async finalizeRecoveredSource(wal: FileConversationWalRecord): Promise<void> {
    const claim = await this.readClaim(wal.sourceKey);
    if (!claim || claim.transitionId !== wal.transitionId) {
      throw new FileTransactionIntegrityError(`Recovered WAL has no matching source claim: ${wal.sourceKey}`, wal.transitionId);
    }
    if (wal.source.kind === 'command') {
      await this.writeCommittedReceipt(wal.source.commandId, wal.source.payloadHash, wal);
    } else {
      await this.writeInternalCommittedReceipt({ sourceKey: wal.sourceKey }, claim.payloadHash, wal);
    }
    if (claim.state === 'claimed') await this.updateClaim(claim, 'committed', receiptPath(wal.sourceKey));
  }

  private async writeInternalNoopReceipt<TResult extends JsonValue>(
    command: InternalCommandEnvelope,
    payloadHash: string,
    claim: DurableSourceClaim,
    noop: InternalCommandNoop<TResult>,
    heads: ReadonlyMap<string, StorageHead>
  ): Promise<InternalTransitionReceipt<TResult>> {
    const receipt: InternalTransitionReceipt<TResult> = {
      schemaVersion: 1,
      sourceKey: command.sourceKey,
      payloadHash,
      transitionId: claim.transitionId,
      sourceKind: internalSourceKind(command.sourceKey),
      finalStatus: noop.status,
      nextVersions: versionsFromHeads(heads),
      result: noop.result,
      patchHeads: [],
      createdAt: Date.now()
    };
    return this.writeInternalReceipt(receipt);
  }

  private async writeInternalCommittedReceipt<TResult extends JsonValue>(
    command: Pick<InternalCommandEnvelope, 'sourceKey'>,
    payloadHash: string,
    wal: FileConversationWalRecord<TResult>
  ): Promise<InternalTransitionReceipt<TResult>> {
    const receipt: InternalTransitionReceipt<TResult> = {
      schemaVersion: 1,
      sourceKey: command.sourceKey,
      payloadHash,
      transitionId: wal.transitionId,
      sourceKind: internalSourceKind(command.sourceKey),
      finalStatus: 'committed',
      nextVersions: wal.nextVersions,
      result: wal.result,
      patchHeads: wal.patchHeads,
      createdAt: Date.now()
    };
    return this.writeInternalReceipt(receipt);
  }

  private async writeInternalReceipt<TResult extends JsonValue>(receipt: InternalTransitionReceipt<TResult>): Promise<InternalTransitionReceipt<TResult>> {
    const path = receiptPath(receipt.sourceKey);
    try {
      await this.files.atomicWrite(path, jsonBytes(receipt), { createOnly: true });
      return receipt;
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      const existing = await this.files.readJson<InternalTransitionReceipt<TResult>>(path);
      if (!existing || existing.transitionId !== receipt.transitionId || existing.payloadHash !== receipt.payloadHash || existing.sourceKey !== receipt.sourceKey) {
        throw new FileTransactionIntegrityError(`Internal receipt conflicts for ${receipt.sourceKey}.`, receipt.transitionId);
      }
      return existing;
    }
  }

  private async replayInternal<TResult extends JsonValue>(claim: DurableSourceClaim): Promise<FileInternalTransactionResult<TResult> | undefined> {
    const receipt = await this.readInternalReceipt<TResult>(claim.sourceKey);
    if (receipt) {
      if (claim.state === 'claimed') await this.updateClaim(claim, 'committed', receiptPath(claim.sourceKey));
      return internalResultFromReceipt(receipt, receipt.finalStatus === 'committed' ? 'already_applied' : receipt.finalStatus);
    }

    const committed = await this.readCommittedWal(claim.transitionId) as FileConversationWalRecord<TResult> | undefined;
    if (committed) {
      const envelope = internalEnvelopeFromWal(committed);
      const written = await this.writeInternalCommittedReceipt(envelope, claim.payloadHash, committed);
      await this.updateClaim(claim, 'committed', receiptPath(claim.sourceKey));
      return { ...internalResultFromReceipt(written, 'already_applied'), patches: committed.patches };
    }
    const pending = this.pending.get(claim.transitionId) ?? await this.readPendingWal(claim.transitionId);
    if (pending) {
      await this.rollForward(pending, true);
      const typed = pending as FileConversationWalRecord<TResult>;
      const envelope = internalEnvelopeFromWal(typed);
      const written = await this.writeInternalCommittedReceipt(envelope, claim.payloadHash, typed);
      await this.updateClaim(claim, 'committed', receiptPath(claim.sourceKey));
      return { ...internalResultFromReceipt(written, 'already_applied'), patches: typed.patches };
    }
    return undefined;
  }

  private async claimSource(sourceKey: string, payloadHash: string, transitionId: () => TransitionId): Promise<{ claim: DurableSourceClaim; created: boolean }> {
    const existing = await this.readClaim(sourceKey);
    if (existing) return { claim: existing, created: false };
    const owner = this.owner.requireOwner();
    const now = Date.now();
    const claim: DurableSourceClaim = {
      schemaVersion: 1,
      sourceKey,
      payloadHash,
      transitionId: transitionId(),
      writerFencingToken: owner.fencingToken,
      state: 'claimed',
      createdAt: now,
      updatedAt: now
    };
    try {
      await this.files.atomicWrite(claimPath(sourceKey), jsonBytes(claim), { createOnly: true });
      return { claim, created: true };
    } catch (error) {
      const winner = await this.readClaim(sourceKey);
      if (winner) return { claim: winner, created: false };
      throw error;
    }
  }

  private async updateClaim(claim: DurableSourceClaim, state: 'committed' | 'rejected' | 'failed', resultRef: string): Promise<void> {
    if (claim.state === state && claim.resultRef === resultRef) return;
    if (claim.state !== 'claimed') throw new FileTransactionIntegrityError(`Source claim already finalized as ${claim.state}.`, claim.transitionId);
    await this.files.atomicWrite(claimPath(claim.sourceKey), jsonBytes({ ...claim, state, resultRef, updatedAt: Date.now() } satisfies DurableSourceClaim));
  }

  private async replayCommand<TResult extends JsonValue>(commandId: CommandId, claim: DurableSourceClaim): Promise<CommandAck<TResult> | undefined> {
    const receipt = await this.readReceipt(claim.sourceKey);
    if (receipt) {
      if (claim.state === 'claimed') await this.updateClaim(claim, receipt.finalStatus, receiptPath(claim.sourceKey));
      this.diagnostics?.record({
        kind: 'command_replayed',
        timestamp: Date.now(),
        commandId,
        transitionId: claim.transitionId,
        conversationId: receipt.nextVersions[0]?.conversationId,
        phase: 'command_replay',
        reasonCode: receipt.finalStatus
      });
      if (receipt.finalStatus === 'failed') throw durableCommandFailureFromReceipt(receipt);
      return (receipt.finalStatus === 'committed'
        ? committedAckFromReceipt(receipt, 'already_applied')
        : rejectionAckFromReceipt(receipt)) as CommandAck<TResult>;
    }
    const committed = await this.readCommittedWal(claim.transitionId);
    if (committed) {
      await this.writeCommittedReceipt(commandId, claim.payloadHash, committed);
      await this.updateClaim(claim, 'committed', receiptPath(claim.sourceKey));
      this.recordCommandReplay(commandId, committed, 'committed_wal');
      return committedAck(commandId, committed, 'already_applied') as CommandAck<TResult>;
    }
    const pending = this.pending.get(claim.transitionId) ?? await this.readPendingWal(claim.transitionId);
    if (pending) {
      await this.rollForward(pending, true);
      await this.writeCommittedReceipt(commandId, claim.payloadHash, pending);
      await this.updateClaim(claim, 'committed', receiptPath(claim.sourceKey));
      this.recordCommandReplay(commandId, pending, 'prepared_rollforward');
      return committedAck(commandId, pending, 'already_applied') as CommandAck<TResult>;
    }
    return undefined;
  }

  private async readViewConsistently<TView>(spec: Parameters<FileTransactionAdapter['load']>[0], initialHeads: ReadonlyMap<string, StorageHead>) {
    // The conversation/resource scopes are held for this entire callback and all writers use the
    // same single-writer executor, so the initial committed HEAD lease cannot change underneath it.
    return this.adapter.load(spec as never, initialHeads) as Promise<DurableAggregateView<TView>>;
  }

  private async readHeads(conversationIds: readonly ConversationId[], storageResourceKeys: readonly string[] = []): Promise<Map<string, StorageHead>> {
    const token = this.owner.requireOwner().fencingToken;
    const conversationEntries = (await Promise.all([...new Set(conversationIds)].sort().map(async (conversationId) => {
      const controlKey = conversationControlHeadKey(conversationId);
      const domains: readonly ConversationStorageDomain[] = [
        'runtime',
        'timeline',
        'compression',
        'tool_calls',
        'tool_events',
        'tool_results',
        'interactions',
        'turns',
        'turn_intents',
        'execution_leases',
        'authority',
        'runtime_inbox'
      ];
      const control = await this.readHead(controlKey) ?? genesisConversationControlHead(conversationId, token);
      const domainHeads = await Promise.all(domains.map(async (domain) => {
        const key = conversationDomainHeadKey(conversationId, domain);
        return [key, await this.readHead(key) ?? genesisConversationDomainHead(conversationId, domain, token)] as const;
      }));
      return [[controlKey, control] as const, ...domainHeads];
    }))).flat();
    const resourceEntries = await Promise.all(sharedStorageResourceKeys(storageResourceKeys, conversationIds).map(async (resourceKey) => {
      const key = storageResourceHeadKey(resourceKey);
      return [key, await this.readHead(key) ?? genesisResourceHead(resourceKey, token)] as const;
    }));
    return new Map([...conversationEntries, ...resourceEntries]);
  }

  private async readHeadsByKeys(headKeys: readonly string[]): Promise<Map<string, StorageHead>> {
    const entries = await Promise.all([...new Set(headKeys)].sort().map(async (headKey) => {
      const head = await this.readHead(headKey);
      return head ? [headKey, head] as const : undefined;
    }));
    return new Map(entries.filter((entry): entry is readonly [string, StorageHead] => entry !== undefined));
  }

  private async readHead(headKey: string): Promise<StorageHead | undefined> {
    const head = await this.files.readJson<StorageHead>(headPath(headKey));
    if (!head) return undefined;
    validateStorageHead(head, headKey);
    return head;
  }

  private async loadPendingIndex(): Promise<void> {
    this.pending.clear();
    for (const file of await this.files.list(PENDING_DIR)) {
      if (!file.endsWith('.json')) throw new FileTransactionIntegrityError(`Unexpected file in pending WAL directory: ${file}`);
      const relativePath = `${PENDING_DIR}/${file}`;
      const wal = await this.files.readJson<FileConversationWalRecord>(relativePath);
      if (!wal) throw new FileTransactionIntegrityError(`Pending WAL file is empty: ${relativePath}`);
      validateWal(wal);
      if (pendingWalPath(wal.transitionId) !== relativePath) {
        throw new FileTransactionIntegrityError(`Pending WAL is stored under the wrong transition path: ${relativePath}`, wal.transitionId);
      }
      if (this.pending.has(wal.transitionId)) throw new FileTransactionIntegrityError(`Duplicate pending WAL: ${wal.transitionId}`, wal.transitionId);
      this.pending.set(wal.transitionId, wal);
    }
  }

  private async settlePendingForStorage(scopes: readonly ConversationId[], storageResourceKeys: readonly string[]): Promise<void> {
    const wantedScopes = new Set(scopes);
    const wantedHeads = new Set(sharedStorageResourceKeys(storageResourceKeys, scopes).map(storageResourceHeadKey));
    const pending = [...this.pending.values()].filter((wal) =>
      wal.scopes.some((scope) => wantedScopes.has(scope))
      || wal.expectedStorageHeads.some((head) => wantedHeads.has(head.headKey))
      || wal.postStorageHeads.some((head) => wantedHeads.has(head.headKey))
    );
    for (const wal of pending) await this.rollForward(wal, true);
  }

  private async readClaim(sourceKey: string): Promise<DurableSourceClaim | undefined> {
    const claim = await this.files.readJson<DurableSourceClaim>(claimPath(sourceKey));
    if (!claim) return undefined;
    if (claim.schemaVersion !== 1 || claim.sourceKey !== sourceKey || !claim.transitionId
      || !/^[0-9a-f]{64}$/.test(claim.payloadHash) || !claim.writerFencingToken
      || !['claimed', 'committed', 'rejected', 'failed'].includes(claim.state)
      || (claim.state !== 'claimed' && claim.resultRef !== receiptPath(sourceKey))) {
      throw new FileTransactionIntegrityError(`Invalid source claim: ${sourceKey}`, claim.transitionId);
    }
    return claim;
  }

  private async readAnyReceipt(sourceKey: string): Promise<CommandReceipt | InternalTransitionReceipt | undefined> {
    const receipt = await this.files.readJson<CommandReceipt | InternalTransitionReceipt>(receiptPath(sourceKey));
    if (!receipt) return undefined;
    validateReceiptIdentity(receipt, sourceKey);
    return receipt;
  }

  private async readReceipt(sourceKey: string): Promise<CommandReceipt | undefined> {
    const receipt = await this.readAnyReceipt(sourceKey);
    if (!receipt) return undefined;
    if (!('commandId' in receipt) || sourceKey !== `command:${receipt.commandId}`) {
      throw new FileTransactionIntegrityError(`Command receipt kind does not match ${sourceKey}.`, receipt.transitionId);
    }
    return receipt;
  }

  private async readInternalReceipt<TResult extends JsonValue>(sourceKey: string): Promise<InternalTransitionReceipt<TResult> | undefined> {
    const receipt = await this.readAnyReceipt(sourceKey);
    if (!receipt) return undefined;
    if (!('sourceKind' in receipt)) throw new FileTransactionIntegrityError(`Internal receipt kind does not match ${sourceKey}.`, receipt.transitionId);
    return receipt as InternalTransitionReceipt<TResult>;
  }

  private readPendingWal(transitionId: TransitionId): Promise<FileConversationWalRecord | undefined> {
    return this.files.readJson<FileConversationWalRecord>(pendingWalPath(transitionId));
  }

  private readCommittedWal(transitionId: TransitionId): Promise<FileConversationWalRecord | undefined> {
    return this.files.readJson<FileConversationWalRecord>(committedWalPath(transitionId));
  }

  private assertStorageHealthy(scopes: readonly ConversationId[], storageResourceKeys: readonly string[]): void {
    const blockedScope = scopes.map((scope) => [scope, this.blockedScopes.get(scope)] as const).find(([, reason]) => reason);
    if (blockedScope) throw new FileTransactionIntegrityError(`Conversation ${blockedScope[0]} is blocked: ${blockedScope[1]}`);
    const blockedHead = sharedStorageResourceKeys(storageResourceKeys, scopes)
      .map(storageResourceHeadKey)
      .map((headKey) => [headKey, this.blockedHeadKeys.get(headKey)] as const)
      .find(([, reason]) => reason);
    if (blockedHead) throw new FileTransactionIntegrityError(`Storage resource ${blockedHead[0]} is blocked: ${blockedHead[1]}`);
  }

  private scheduleMaintenance(force = false): void {
    this.commitsSinceMaintenance += 1;
    if (!force && this.commitsSinceMaintenance < MAINTENANCE_COMMIT_BATCH) return;
    this.commitsSinceMaintenance = 0;
    this.maintenanceTail = this.maintenanceTail
      .then(async () => {
        if (!this.initialized) return;
        await this.owner.verify();
        await this.compactAllCommitted();
      })
      .catch((error) => {
        // Maintenance is rebuildable and never changes a committed business result.
        console.error('[Reliability] WAL maintenance failed:', error);
      });
  }

  private async cleanupStartupArtifacts(): Promise<void> {
    const retained = new Set(this.pending.keys());
    for (const entry of await this.files.list(STAGING_DIR)) {
      if (!retained.has(entry as TransitionId)) await this.files.remove(`${STAGING_DIR}/${entry}`, { recursive: true });
    }
  }

  private async verifyStorageAuthorityAtStartup(): Promise<void> {
    const heads = new Map<string, StorageHead>();
    for (const relativePath of await this.files.listFilesRecursive(HEADS_DIR)) {
      const head = await this.files.readJson<StorageHead>(relativePath);
      if (!head) throw new FileTransactionIntegrityError(`Storage HEAD file is empty: ${relativePath}`);
      validateStorageHead(head, head.headKey);
      if (headPath(head.headKey) !== relativePath) throw new FileTransactionIntegrityError(`Storage HEAD is stored at the wrong control path: ${relativePath}`);
      if (heads.has(head.headKey)) throw new FileTransactionIntegrityError(`Duplicate Storage HEAD: ${head.headKey}`);
      heads.set(head.headKey, head);
    }

    const conversationIds = [...new Set([...heads.values()]
      .map((head) => head.conversationId)
      .filter((conversationId): conversationId is ConversationId => !!conversationId))].sort();
    const registry = new StoragePathAuthorityRegistry(conversationIds);
    const targetOwner = new Map<string, string>();

    for (const head of heads.values()) {
      if (head.headKind === 'conversation-domain' && head.conversationId
        && !heads.has(conversationControlHeadKey(head.conversationId))) {
        throw new FileTransactionIntegrityError(`Conversation domain HEAD has no control HEAD: ${head.headKey}`);
      }
      if (head.headKind === 'conversation-control') continue;
      const owner = storageHeadOwnerFromHead(head);
      if (!owner) throw new FileTransactionIntegrityError(`Storage HEAD has no authority owner: ${head.headKey}`);
      const namespaces = registry.authoritativeNamespacesFor(owner);
      if (namespaces.length === 0) throw new FileTransactionIntegrityError(`Storage HEAD owner has no registered namespace: ${head.headKey}`);
      for (const [target, expectedHash] of Object.entries(head.targetHashes)) {
        let authority;
        try { authority = registry.requireAuthoritativeOwner(target, owner); }
        catch (error) { throw new FileTransactionIntegrityError(error instanceof Error ? error.message : String(error)); }
        void authority;
        const existingOwner = targetOwner.get(target);
        if (existingOwner && existingOwner !== head.headKey) {
          throw new FileTransactionIntegrityError(`Authoritative target is owned by multiple Storage HEADs: ${target}`);
        }
        targetOwner.set(target, head.headKey);
        if (await this.files.hash(target) !== expectedHash) {
          throw new FileTransactionIntegrityError(`Current Storage HEAD target is corrupt: ${target}`);
        }
      }
      const physicalTargets = await registry.enumerateAuthoritativeTargets(this.files, owner);
      const trackedTargets = Object.keys(head.targetHashes).sort();
      if (!sameIds(physicalTargets, trackedTargets)) {
        const unowned = physicalTargets.filter((target) => head.targetHashes[target] === undefined);
        const missing = trackedTargets.filter((target) => !physicalTargets.includes(target));
        throw new FileTransactionIntegrityError(`Storage namespace and HEAD disagree for ${head.headKey}; unowned=[${unowned.join(', ')}], missing=[${missing.join(', ')}].`);
      }
    }

    const physicalCandidates = new Set<string>();
    for (const entry of registry.authoritativeInspectionEntries()) {
      if (entry.kind === 'file') {
        if (await this.files.hash(entry.path) !== null) physicalCandidates.add(entry.path);
        continue;
      }
      for (const target of await this.files.listFilesRecursive(entry.path)) physicalCandidates.add(target);
    }
    for (const target of [...physicalCandidates].sort()) {
      const authority = registry.classify(target);
      if (!authority) throw new FileTransactionIntegrityError(`Unregistered file appeared in a reliable storage namespace: ${target}`);
      if (authority.durabilityClass !== 'authoritative-mutable' || !authority.owner) continue;
      const ownerKey = storageHeadKey(authority.owner);
      const head = heads.get(ownerKey);
      if (!head || head.targetHashes[target] === undefined) {
        throw new FileTransactionIntegrityError(`Unowned authoritative file appeared beneath Storage HEAD ${ownerKey}: ${target}`);
      }
    }
  }

  private async compactAllCommitted(): Promise<void> {
    for (const file of await this.files.list(COMMITTED_DIR)) {
      if (!file.endsWith('.json')) continue;
      await this.compactOneCommitted(file.slice(0, -'.json'.length) as TransitionId);
    }
  }

  private async compactOneCommitted(transitionId: TransitionId): Promise<void> {
    const wal = await this.readCommittedWal(transitionId);
    if (!wal) return;
    validateWal(wal);
    const claim = await this.readClaim(wal.sourceKey);
    const walPayloadHash = sourcePayloadHash(wal.source);
    if (!claim || claim.transitionId !== transitionId || (walPayloadHash !== undefined && claim.payloadHash !== walPayloadHash)) {
      throw new FileTransactionIntegrityError(`Committed WAL has no matching source claim: ${wal.sourceKey}`, transitionId);
    }
    await this.verifyCurrentCommittedHeads(wal);
    if (claim.state === 'claimed' || !await this.readAnyReceipt(wal.sourceKey)) await this.finalizeRecoveredSource(wal);
    const finalizedClaim = await this.readClaim(wal.sourceKey);
    const receipt = await this.readAnyReceipt(wal.sourceKey);
    if (!finalizedClaim || finalizedClaim.state !== 'committed' || !receipt
      || receipt.transitionId !== transitionId || receipt.payloadHash !== claim.payloadHash || receipt.sourceKey !== wal.sourceKey) {
      throw new FileTransactionIntegrityError(`Committed WAL receipt/claim is inconsistent: ${wal.sourceKey}`, transitionId);
    }
    // Pending marker and staging are unnecessary once committed WAL + receipt can recreate the final result.
    await this.files.remove(pendingWalPath(transitionId));
    await this.hit('after_compaction_pending_cleanup', transitionId);
    await this.files.remove(`${STAGING_DIR}/${transitionId}`, { recursive: true });
    await this.hit('after_compaction_staging_cleanup', transitionId);
    const heads = await this.readHeadsByKeys(wal.postStorageHeads.map((head) => head.headKey));
    if ([...heads.values()].some((head) => head.latestTransitionId === transitionId)) return;
    await this.files.remove(committedWalPath(transitionId));
    await this.hit('after_compaction_committed_cleanup', transitionId);
    this.diagnostics?.record({
      kind: 'wal_compacted',
      timestamp: Date.now(),
      transitionId,
      conversationId: wal.scopes[0],
      reasonCode: 'receipt_and_newer_head_durable'
    });
  }

  private async verifyCurrentCommittedHeads(wal: FileConversationWalRecord): Promise<void> {
    let everyHeadStillCurrent = true;
    for (const committedHead of wal.postStorageHeads) {
      const current = await this.readHead(committedHead.headKey);
      if (!current) throw new FileTransactionIntegrityError(`Committed Storage HEAD is missing: ${committedHead.headKey}`, wal.transitionId);
      if (current.latestTransitionId !== wal.transitionId) {
        everyHeadStillCurrent = false;
        if (current.generation <= committedHead.generation) {
          throw new FileTransactionIntegrityError(`Committed Storage HEAD history is not monotonic: ${committedHead.headKey}`, wal.transitionId);
        }
        continue;
      }
      if (canonicalSha256(current) !== canonicalSha256(committedHead)) {
        throw new FileTransactionIntegrityError(`Current Storage HEAD differs from its committed WAL: ${committedHead.headKey}`, wal.transitionId);
      }
      for (const [target, expectedHash] of Object.entries(current.targetHashes)) {
        if (await this.files.hash(target) !== expectedHash) {
          throw new FileTransactionIntegrityError(`Current Storage HEAD target is corrupt: ${target}`, wal.transitionId);
        }
      }
    }
    if (!everyHeadStillCurrent) return;
    for (const file of wal.files.filter((candidate) => candidate.operation === 'delete')) {
      if (await this.files.hash(file.targetRelativePath) !== null) {
        throw new FileTransactionIntegrityError(`Committed deletion target reappeared: ${file.targetRelativePath}`, wal.transitionId);
      }
    }
  }

  private async commitProjectionAfterStorage(
    projection: import('../../shared/conversationReliability').PreparedProjectionBatch | undefined,
    wal: FileConversationWalRecord
  ): Promise<void> {
    if (!projection) return;
    try {
      await projection.commitAtSchedulerSafePoint();
    } catch (error) {
      // storage_committed is final. Repair the process-local projection from the exact committed
      // post-state instead of surfacing a false command failure or writing World state back to files.
      try {
        await projection.rehydrateCommittedState();
        this.diagnostics?.record({
          kind: 'projection_rehydrated',
          timestamp: Date.now(),
          transitionId: wal.transitionId,
          conversationId: wal.scopes[0],
          reasonCode: 'committed_projection_rebuilt'
        });
      } catch (rehydrationError) {
        console.error(`[Reliability] Durable transition ${wal.transitionId} committed but its World projection could not be rebuilt.`, {
          projectionError: error,
          rehydrationError
        });
      }
    }
  }

  private async hit(point: Parameters<NonNullable<FileTransactionFaultInjector>['hit']>[0], transitionId: TransitionId, installedFiles?: number): Promise<void> {
    await this.faultInjector?.hit(point, { transitionId, installedFiles });
  }

  private recordDiagnostic(kind: 'command_id_reused', command: CommandEnvelope, transitionId: TransitionId, reasonCode: string): void {
    this.diagnostics?.record({ kind, timestamp: Date.now(), commandId: command.commandId, transitionId, conversationId: commandScopeIds(command)[0], phase: command.type, reasonCode });
  }

  private recordCommandReplay(commandId: CommandId, wal: FileConversationWalRecord, reasonCode: string): void {
    this.diagnostics?.record({
      kind: 'command_replayed',
      timestamp: Date.now(),
      commandId,
      transitionId: wal.transitionId,
      conversationId: wal.scopes[0],
      phase: wal.kind,
      reasonCode
    });
  }

  private recordCommittedCommandDiagnostics(command: CommandEnvelope, wal: FileConversationWalRecord): void {
    if (command.type !== 'conversation.promote') return;
    this.diagnostics?.record({
      kind: 'promote_committed',
      timestamp: Date.now(),
      commandId: command.commandId,
      transitionId: wal.transitionId,
      conversationId: wal.scopes[0],
      phase: command.type,
      reasonCode: 'storage_committed'
    });
  }

  private recordInternalDiagnostic(
    kind: 'source_claim_conflict' | 'stale_callback' | 'operation_timed_out' | 'operation_outcome_unknown' | 'orphan_run_interrupted',
    command: InternalCommandEnvelope,
    transitionId: TransitionId,
    reasonCode: string,
    overrides: { runId?: string; operationId?: string; attemptId?: string } = {}
  ): void {
    const payload = jsonObject(command.payload);
    this.diagnostics?.record({
      kind,
      timestamp: Date.now(),
      transitionId,
      conversationId: commandScopeIds(command)[0],
      runId: overrides.runId ?? stringValue(payload?.runId),
      operationId: overrides.operationId ?? stringValue(payload?.operationId),
      attemptId: overrides.attemptId ?? stringValue(payload?.attemptId),
      phase: command.type,
      reasonCode
    });
  }

  private recordInternalTransitionDiagnostics(
    command: InternalCommandEnvelope,
    transitionId: TransitionId,
    status: FileInternalTransactionResult<JsonValue>['status'],
    result: JsonValue
  ): void {
    const value = jsonObject(result);
    if (command.sourceKey.startsWith('event:') && status === 'stale') {
      this.recordInternalDiagnostic('stale_callback', command, transitionId, stringValue(value?.reason) ?? 'attempt_cas_stale');
    }
    if (command.type === 'operation.watchdog' && status === 'committed') {
      const outcome = stringValue(value?.status) ?? 'timed_out';
      this.recordInternalDiagnostic('operation_timed_out', command, transitionId, outcome);
      if (outcome === 'outcome_unknown') this.recordInternalDiagnostic('operation_outcome_unknown', command, transitionId, 'watchdog_requires_resolution');
    }
    if (command.type !== 'restart.reconcile') return;
    const diagnostics = Array.isArray(value?.diagnostics) ? value.diagnostics : [];
    for (const raw of diagnostics) {
      const diagnostic = jsonObject(raw as JsonValue);
      const kind = stringValue(diagnostic?.kind);
      const runId = stringValue(diagnostic?.runId);
      const operationId = stringValue(diagnostic?.operationId);
      const reason = stringValue(diagnostic?.reason) ?? 'restart_reconciliation';
      if (kind === 'outcome_unknown') {
        this.recordInternalDiagnostic('operation_outcome_unknown', command, transitionId, reason, { runId, operationId });
      } else if (kind === 'interrupted' && runId) {
        this.recordInternalDiagnostic('orphan_run_interrupted', command, transitionId, reason, { runId, operationId });
      }
    }
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('FileConversationTransactionBackend is not initialized.');
  }

  private requireMutationAdmission(): void {
    this.requireInitialized();
    if (!this.acceptingMutations) throw new Error('FileConversationTransactionBackend is quiescing and no longer accepts mutations.');
  }

  private requireOwnerOnly(): void {
    this.owner.requireOwner();
  }
}

function jsonObject(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value as Record<string, JsonValue>
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function withCompiledPatches<TResult extends JsonValue>(
  plan: TransitionPlan<TResult>,
  compiled: readonly import('../../shared/conversationReliability').PlannedPatchBatch[] | undefined
): TransitionPlan<TResult> {
  if (!compiled) return plan;
  const byConversation = new Map(compiled.map((batch) => [batch.conversationId, batch]));
  if (byConversation.size !== compiled.length || compiled.length !== plan.patches.length) {
    throw new FileTransactionIntegrityError('Compiled authoritative patches do not match the planned conversation set.', plan.transitionId);
  }
  const patches = plan.patches.map((planned) => {
    const authoritative = byConversation.get(planned.conversationId);
    if (!authoritative
      || authoritative.streamId !== planned.streamId
      || authoritative.baseSeq !== planned.baseSeq
      || authoritative.nextSeq !== planned.nextSeq
      || !Array.isArray(authoritative.operations)) {
      throw new FileTransactionIntegrityError(`Compiled patch metadata changed for ${planned.conversationId}.`, plan.transitionId);
    }
    return {
      ...planned,
      ...(authoritative.terminalStreamFences?.length
        ? { terminalStreamFences: authoritative.terminalStreamFences.map((fence) => ({ ...fence })) }
        : {}),
      operations: [...authoritative.operations]
    };
  });
  return { ...plan, patches };
}

function isInternalNoop<TResult extends JsonValue>(value: TransitionPlan<TResult> | InternalCommandNoop<TResult>): value is InternalCommandNoop<TResult> {
  return 'status' in value && (value.status === 'stale' || value.status === 'already_satisfied');
}

function internalPayloadHash(command: InternalCommandEnvelope): string {
  return canonicalSha256({
    type: command.type,
    requestedScope: canonicalCommandScope(command.scope),
    payload: command.payload
  });
}

function validateInternalSourceKey(sourceKey: string): void {
  if (!/^(event|internal|recovery):[^\s]+$/.test(sourceKey)) {
    throw new FileTransactionIntegrityError(`Invalid internal source key: ${sourceKey}`);
  }
}

function internalSourceKind(sourceKey: string): InternalTransitionReceipt['sourceKind'] {
  if (sourceKey.startsWith('event:')) return 'callback';
  if (sourceKey.startsWith('recovery:')) return 'recovery';
  return 'internal';
}

function walSourceForInternal(command: InternalCommandEnvelope, payloadHash: string): FileConversationWalRecord['source'] {
  const value = command.sourceKey.slice(command.sourceKey.indexOf(':') + 1);
  switch (internalSourceKind(command.sourceKey)) {
    case 'callback': return { kind: 'callback', eventId: value, payloadHash };
    case 'recovery': return { kind: 'recovery', recoveryKey: value };
    case 'internal': return { kind: 'internal', transitionKey: value, payloadHash };
  }
}

function validateReceiptIdentity(receipt: CommandReceipt | InternalTransitionReceipt, sourceKey: string): void {
  const finalStatuses = 'commandId' in receipt
    ? ['committed', 'rejected', 'failed']
    : ['committed', 'stale', 'already_satisfied'];
  if (receipt.schemaVersion !== 1 || receipt.sourceKey !== sourceKey || !receipt.transitionId
    || !/^[0-9a-f]{64}$/.test(receipt.payloadHash) || !finalStatuses.includes(receipt.finalStatus)
    || !Array.isArray(receipt.nextVersions) || !Array.isArray(receipt.patchHeads)) {
    throw new FileTransactionIntegrityError(`Invalid durable receipt: ${sourceKey}`, receipt.transitionId);
  }
  if ('commandId' in receipt && receipt.finalStatus === 'failed'
    && (!receipt.failure || !isCommandServiceErrorCode(receipt.failure.code) || typeof receipt.failure.message !== 'string' || !receipt.failure.message)) {
    throw new FileTransactionIntegrityError(`Failed command receipt has no valid failure: ${sourceKey}`, receipt.transitionId);
  }
}

function sourcePayloadHash(source: FileConversationWalRecord['source']): string | undefined {
  return source.kind === 'recovery' ? undefined : source.payloadHash;
}

function versionsFromHeads(heads: ReadonlyMap<string, StorageHead>): Array<{ conversationId: ConversationId; version: number }> {
  return [...heads.values()]
    .filter((head): head is StorageHead & { conversationId: ConversationId } => head.headKind === 'conversation-control' && !!head.conversationId)
    .map((head) => ({ conversationId: head.conversationId, version: head.controlVersion }));
}

function internalResultFromReceipt<TResult extends JsonValue>(
  receipt: InternalTransitionReceipt<TResult>,
  status: FileInternalTransactionResult<TResult>['status']
): FileInternalTransactionResult<TResult> {
  return {
    transitionId: receipt.transitionId,
    status,
    heads: receipt.nextVersions.map((version) => ({
      ...version,
      streamId: receipt.patchHeads.find((patch) => patch.conversationId === version.conversationId)?.streamId ?? `conversation:${version.conversationId}:state`,
      patchNextSeq: receipt.patchHeads.find((patch) => patch.conversationId === version.conversationId)?.nextSeq ?? 0
    })),
    result: receipt.result,
    patches: []
  };
}

function walInspectionRecord(wal: FileConversationWalRecord): FileWalInspectionRecord {
  return {
    transitionId: wal.transitionId,
    state: wal.state,
    sourceKey: wal.sourceKey,
    sourceKind: wal.source.kind,
    kind: wal.kind,
    scopes: [...wal.scopes],
    baseVersions: wal.baseVersions.map((version) => ({ ...version })),
    nextVersions: wal.nextVersions.map((version) => ({ ...version })),
    fileCount: wal.files.length,
    patchHeads: wal.patchHeads.map((head) => ({ ...head })),
    createdAt: wal.createdAt,
    updatedAt: wal.updatedAt
  };
}

function receiptInspectionRecord(receipt: CommandReceipt | InternalTransitionReceipt): FileReceiptInspectionRecord {
  const command = 'commandId' in receipt;
  return {
    sourceKey: receipt.sourceKey,
    sourceKind: command ? 'command' : receipt.sourceKind,
    transitionId: receipt.transitionId,
    ...(command ? { commandId: receipt.commandId } : {}),
    finalStatus: receipt.finalStatus,
    nextVersions: receipt.nextVersions.map((version) => ({ ...version })),
    patchHeads: receipt.patchHeads.map((head) => ({ ...head })),
    createdAt: receipt.createdAt
  };
}

function compareWalInspection(left: FileWalInspectionRecord, right: FileWalInspectionRecord): number {
  return left.createdAt - right.createdAt || left.transitionId.localeCompare(right.transitionId);
}

function stagingTransitionId(relativePath: string): TransitionId {
  const prefix = `${STAGING_DIR}/`;
  const transitionId = relativePath.startsWith(prefix) ? relativePath.slice(prefix.length).split('/')[0] : '';
  if (!transitionId) throw new FileTransactionIntegrityError(`Invalid staging inspection path: ${relativePath}`);
  return transitionId as TransitionId;
}

function internalEnvelopeFromWal(wal: FileConversationWalRecord): Pick<InternalCommandEnvelope, 'sourceKey'> {
  return { sourceKey: wal.sourceKey };
}

function isCommandRejection(value: CommandRejection | TransitionPlan): value is CommandRejection {
  return (value as CommandRejection).status === 'rejected';
}

function assertCommandAdmissionIdentity(
  original: CommandEnvelope,
  prepared: CommandEnvelope,
  transitionId: TransitionId
): void {
  const { payload: _originalPayload, ...originalEnvelope } = original;
  const { payload: _preparedPayload, ...preparedEnvelope } = prepared;
  if (canonicalSha256(originalEnvelope) !== canonicalSha256(preparedEnvelope)) {
    throw new FileTransactionIntegrityError('Command admission may normalize only payload content.', transitionId);
  }
}

function assertInternalAdmissionIdentity(
  original: InternalCommandEnvelope,
  prepared: InternalCommandEnvelope,
  transitionId: TransitionId
): void {
  const { payload: _originalPayload, ...originalEnvelope } = original;
  const { payload: _preparedPayload, ...preparedEnvelope } = prepared;
  if (canonicalSha256(originalEnvelope) !== canonicalSha256(preparedEnvelope)) {
    throw new FileTransactionIntegrityError('Internal command admission may normalize only payload content.', transitionId);
  }
}

function validateTransitionPlan(plan: TransitionPlan, transitionId: TransitionId, scopes: readonly ConversationId[], heads: ReadonlyMap<string, StorageHead>): void {
  if (plan.transitionId !== transitionId) throw new FileTransactionIntegrityError('TransitionPlan changed the claimed transitionId.', transitionId);
  if (!sameIds(plan.scopes, scopes)) throw new FileTransactionIntegrityError('TransitionPlan scopes differ from the leased execution scope.', transitionId);
  const bases = new Map(plan.baseVersions.map((item) => [item.conversationId, item.version]));
  const next = new Map(plan.nextVersions.map((item) => [item.conversationId, item.version]));
  for (const scope of scopes) {
    const head = heads.get(conversationControlHeadKey(scope));
    if (!head || bases.get(scope) !== head.controlVersion) throw new FileTransactionIntegrityError(`TransitionPlan baseVersion is stale for ${scope}.`, transitionId);
    if (next.get(scope) !== head.controlVersion + 1) throw new FileTransactionIntegrityError(`TransitionPlan must advance ${scope} by exactly one controlVersion.`, transitionId);
  }
  const generated = new Set(plan.generatedIds);
  if (generated.size !== plan.generatedIds.length) throw new FileTransactionIntegrityError('TransitionPlan generatedIds contains duplicates.', transitionId);
}

function validateWal(wal: FileConversationWalRecord): void {
  if (wal.schemaVersion !== 1) throw new FileTransactionIntegrityError('Unsupported conversation WAL schema.', wal.transitionId);
  if (!wal.transitionId || !wal.sourceKey || !Array.isArray(wal.scopes) || wal.scopes.length === 0 || !Array.isArray(wal.patches)) throw new FileTransactionIntegrityError('Conversation WAL identity/scope/patches are incomplete.', wal.transitionId);
  const targets = new Set<string>();
  for (const file of wal.files) {
    normalizeRelativePath(file.targetRelativePath);
    if (targets.has(file.targetRelativePath)) throw new FileTransactionIntegrityError(`Duplicate WAL target: ${file.targetRelativePath}`, wal.transitionId);
    targets.add(file.targetRelativePath);
    if (file.operation === 'delete') {
      if (file.stagingRelativePath !== undefined || file.postimageHash !== null) {
        throw new FileTransactionIntegrityError(`Invalid WAL delete entry: ${file.targetRelativePath}`, wal.transitionId);
      }
      continue;
    }
    if (!file.stagingRelativePath) throw new FileTransactionIntegrityError(`WAL write has no staging path: ${file.targetRelativePath}`, wal.transitionId);
    normalizeRelativePath(file.stagingRelativePath);
    if (!file.postimageHash || !/^[0-9a-f]{64}$/.test(file.postimageHash)) throw new FileTransactionIntegrityError(`Invalid WAL postimage hash: ${file.targetRelativePath}`, wal.transitionId);
  }
}

function commandScopeIds(command: Pick<CommandEnvelope | InternalCommandEnvelope, 'scope'>): ConversationId[] {
  return command.scope.kind === 'conversation'
    ? [command.scope.id]
    : [...new Set(command.scope.ids)].sort();
}

function staleExpectedVersions(command: CommandEnvelope, heads: ReadonlyMap<string, StorageHead>): ConversationId[] {
  const expected = new Map(command.expectedVersions.map((item) => [item.conversationId, item.version]));
  return commandScopeIds(command).filter((scope) => expected.get(scope) !== heads.get(conversationControlHeadKey(scope))?.controlVersion);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sharedStorageResourceKeys(storageResourceKeys: readonly string[], _conversations: readonly ConversationId[]): string[] {
  const known = new Set<string>([
    ATTACHMENT_STORAGE_RESOURCE_KEY,
    ANSWER_BRIDGE_LINKS_STORAGE_RESOURCE_KEY,
    TOOL_RESULT_BLOBS_RESOURCE_KEY
  ]);
  const resources = [...new Set(storageResourceKeys)].sort();
  const unknown = resources.find((key) => !known.has(key));
  if (unknown) throw new FileTransactionIntegrityError(`Unknown shared storage resource key: ${unknown}`);
  return resources;
}

function genesisConversationControlHead(conversationId: ConversationId, fencingToken: string): StorageHead {
  return {
    schemaVersion: 1,
    headKind: 'conversation-control',
    headKey: conversationControlHeadKey(conversationId),
    conversationId,
    generation: 0,
    writerFencingToken: fencingToken,
    controlVersion: 0,
    streamNextSeq: 0,
    targetHashes: {}
  };
}

function genesisConversationDomainHead(
  conversationId: ConversationId,
  domain: ConversationStorageDomain,
  fencingToken: string
): StorageHead {
  return {
    schemaVersion: 1,
    headKind: 'conversation-domain',
    headKey: conversationDomainHeadKey(conversationId, domain),
    conversationId,
    domain,
    generation: 0,
    writerFencingToken: fencingToken,
    controlVersion: 0,
    streamNextSeq: 0,
    targetHashes: {}
  };
}

function genesisResourceHead(resourceKey: string, fencingToken: string): StorageHead {
  return {
    schemaVersion: 1,
    headKind: 'resource',
    headKey: storageResourceHeadKey(resourceKey),
    resourceKey,
    generation: 0,
    writerFencingToken: fencingToken,
    controlVersion: 0,
    streamNextSeq: 0,
    targetHashes: {}
  };
}

function validateStorageHead(head: StorageHead, expectedHeadKey: string): void {
  if (head.schemaVersion !== 1 || head.headKey !== expectedHeadKey
    || !Number.isInteger(head.generation) || head.generation < 0
    || !head.writerFencingToken
    || !Number.isInteger(head.controlVersion) || head.controlVersion < 0
    || !Number.isInteger(head.streamNextSeq) || head.streamNextSeq < 0
    || !head.targetHashes || typeof head.targetHashes !== 'object' || Array.isArray(head.targetHashes)) {
    throw new FileTransactionIntegrityError(`Invalid Storage HEAD: ${expectedHeadKey}`);
  }
  for (const [target, hash] of Object.entries(head.targetHashes)) {
    normalizeRelativePath(target);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new FileTransactionIntegrityError(`Storage HEAD has an invalid target hash: ${expectedHeadKey} -> ${target}`);
  }
  if (head.headKind === 'conversation-control') {
    if (!head.conversationId || head.domain !== undefined || head.resourceKey !== undefined
      || head.headKey !== conversationControlHeadKey(head.conversationId)
      || Object.keys(head.targetHashes).length !== 0) {
      throw new FileTransactionIntegrityError(`Invalid conversation control HEAD: ${expectedHeadKey}`);
    }
    return;
  }
  if (head.headKind === 'conversation-domain') {
    if (!head.conversationId || !head.domain || head.resourceKey !== undefined
      || head.headKey !== conversationDomainHeadKey(head.conversationId, head.domain)
      || head.controlVersion !== 0 || head.streamNextSeq !== 0) {
      throw new FileTransactionIntegrityError(`Invalid conversation domain HEAD: ${expectedHeadKey}`);
    }
    return;
  }
  if (head.headKind === 'resource') {
    if (!head.resourceKey || head.conversationId !== undefined || head.domain !== undefined
      || head.headKey !== storageResourceHeadKey(head.resourceKey)
      || head.controlVersion !== 0 || head.streamNextSeq !== 0) {
      throw new FileTransactionIntegrityError(`Invalid shared resource HEAD: ${expectedHeadKey}`);
    }
    return;
  }
  throw new FileTransactionIntegrityError(`Unknown Storage HEAD kind: ${expectedHeadKey}`);
}

function storageHeadOwnerFromHead(head: StorageHead): StorageHeadOwner | undefined {
  if (head.headKind === 'conversation-domain' && head.conversationId && head.domain) {
    return { kind: 'conversation', conversationId: head.conversationId, domain: head.domain };
  }
  if (head.headKind === 'resource' && head.resourceKey) return { kind: 'resource', resourceKey: head.resourceKey } as StorageHeadOwner;
  return undefined;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function committedAck<TResult extends JsonValue>(commandId: CommandId, wal: FileConversationWalRecord<TResult>, status: 'committed' | 'already_applied'): CommandAck<TResult> {
  return {
    commandId,
    transitionId: wal.transitionId,
    status,
    controlHeads: headsFromWal(wal),
    projectionHeads: projectionHeadsFromWal(wal),
    result: wal.result
  };
}

function headsFromWal(wal: FileConversationWalRecord): CommittedConversationHead[] {
  return wal.postStorageHeads
    .filter((head): head is StorageHead & { conversationId: ConversationId } => head.headKind === 'conversation-control' && !!head.conversationId)
    .map((head) => ({
      conversationId: head.conversationId,
      version: head.controlVersion,
      streamId: wal.patchHeads.find((patch) => patch.conversationId === head.conversationId)?.streamId ?? `conversation:${head.conversationId}:state`,
      patchNextSeq: head.streamNextSeq
    }));
}

function committedAckFromReceipt(receipt: CommandReceipt, status: 'already_applied'): CommandAck<JsonValue> {
  const controlHeads = receipt.nextVersions.map((item) => ({
    conversationId: item.conversationId,
    version: item.version,
    streamId: receipt.patchHeads.find((patch) => patch.conversationId === item.conversationId)?.streamId ?? `conversation:${item.conversationId}:state`,
    patchNextSeq: receipt.patchHeads.find((patch) => patch.conversationId === item.conversationId)?.nextSeq ?? 0
  }));
  return {
    commandId: receipt.commandId,
    transitionId: receipt.transitionId,
    status,
    controlHeads,
    projectionHeads: receipt.patchHeads.map((patch) => projectionHeadForPatch(controlHeads, patch)),
    result: receipt.result ?? null
  };
}

function projectionHeadsFromWal(wal: FileConversationWalRecord): CommittedConversationHead[] {
  const controls = headsFromWal(wal);
  return wal.patchHeads.map((patch) => projectionHeadForPatch(controls, patch));
}

function projectionHeadForPatch(
  controls: readonly CommittedConversationHead[],
  patch: { conversationId: ConversationId; streamId: string; nextSeq: number }
): CommittedConversationHead {
  const control = controls.find((head) => head.conversationId === patch.conversationId);
  if (!control) throw new FileTransactionIntegrityError(`Projection patch has no committed control HEAD: ${patch.conversationId}`);
  return {
    conversationId: patch.conversationId,
    version: control.version,
    streamId: patch.streamId,
    patchNextSeq: patch.nextSeq
  };
}

function rejectionAckFromReceipt(receipt: CommandReceipt): CommandAck<never> {
  if (!receipt.rejection) throw new FileTransactionIntegrityError(`Rejected receipt has no rejection: ${receipt.sourceKey}`, receipt.transitionId);
  return {
    commandId: receipt.commandId,
    status: 'rejected',
    code: receipt.rejection.code,
    currentVersions: receipt.nextVersions,
    message: receipt.rejection.message
  };
}

function commandIdReusedAck(commandId: CommandId): CommandAck<never> {
  return { commandId, status: 'rejected', code: 'command_id_reused', message: 'The commandId was already claimed by a different payload.' };
}

function commandFailureFromError(error: unknown): Pick<CommandServiceError, 'code' | 'message'> {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const code: CommandServiceError['code'] = error instanceof DurableFactsIntegrityError || error instanceof FileTransactionIntegrityError
    ? 'integrity_violation'
    : rawCode === 'migration_required'
      ? 'migration_required'
      : rawCode === 'scheduler_compile_failed'
        ? 'runtime_unavailable'
        : 'storage_unavailable';
  return { code, message };
}

function durableCommandFailureFromReceipt(receipt: CommandReceipt): DurableCommandFailureError {
  if (receipt.finalStatus !== 'failed' || !receipt.failure) {
    throw new FileTransactionIntegrityError(`Command receipt is not a durable failure: ${receipt.sourceKey}.`, receipt.transitionId);
  }
  return new DurableCommandFailureError(receipt.commandId, receipt.failure.code, receipt.failure.message, receipt.transitionId);
}

function commandServiceErrorFromFailedReceipt(receipt: CommandReceipt): CommandServiceError {
  const failure = durableCommandFailureFromReceipt(receipt);
  return {
    commandId: failure.commandId,
    status: 'unavailable',
    code: failure.serviceCode,
    message: failure.message,
    durable: true
  };
}

function isCommandServiceErrorCode(value: unknown): value is CommandServiceError['code'] {
  return value === 'storage_unavailable'
    || value === 'runtime_unavailable'
    || value === 'integrity_violation'
    || value === 'recovery_required'
    || value === 'migration_required';
}

function assertResolvedViewExtendsDeclared(declared: DurableViewSpec, resolved: DurableViewSpec): void {
  const requireIncluded = (label: string, required: readonly string[], actual: readonly string[]): void => {
    const available = new Set(actual);
    const missing = [...new Set(required)].filter((value) => !available.has(value));
    if (missing.length > 0) throw new FileTransactionIntegrityError(`Resolved DurableViewSpec drops ${label}: ${missing.join(', ')}.`);
  };

  requireIncluded('conversation scopes', declared.conversations, resolved.conversations);
  requireIncluded('relation families', declared.relationFamilies, resolved.relationFamilies);
  requireIncluded('storage resource keys', declared.storageResourceKeys, resolved.storageResourceKeys);
  requireIncluded('closed Run graph roots', declared.closedRunGraphRoots ?? [], resolved.closedRunGraphRoots ?? []);
  requireIncluded(
    'closed Run graph modes',
    declared.closedRunGraphModes ?? (declared.closedRunGraphRoots?.length ? ['foreground'] : []),
    resolved.closedRunGraphModes ?? (resolved.closedRunGraphRoots?.length ? ['foreground'] : [])
  );
  requireIncluded('creatable conversations', declared.createMissingConversations ?? [], resolved.createMissingConversations ?? []);
  if (declared.mergeConversationFacts && !resolved.mergeConversationFacts) {
    throw new FileTransactionIntegrityError('Resolved DurableViewSpec drops merged conversation facts.');
  }
  if (declared.aggregateRootConversationId && resolved.aggregateRootConversationId !== declared.aggregateRootConversationId) {
    throw new FileTransactionIntegrityError('Resolved DurableViewSpec changes the aggregate root conversation.');
  }

  for (const required of declared.timeline ?? []) {
    const coverage = (resolved.timeline ?? []).find((candidate) => candidate.conversationId === required.conversationId);
    if (!coverage
      || (required.throughTail && !coverage.throughTail)
      || (!required.fromMessageId && !!coverage.fromMessageId)
      || (required.fromMessageId && coverage.fromMessageId && coverage.fromMessageId !== required.fromMessageId)) {
      throw new FileTransactionIntegrityError(`Resolved DurableViewSpec narrows timeline coverage for ${required.conversationId}.`);
    }
  }
}

function pendingWalPath(transitionId: TransitionId): string { return `${PENDING_DIR}/${transitionId}.json`; }
function committedWalPath(transitionId: TransitionId): string { return `${COMMITTED_DIR}/${transitionId}.json`; }
function claimPath(sourceKey: string): string { return shardedPath(CLAIMS_DIR, sourceKey); }
function receiptPath(sourceKey: string): string { return shardedPath(RECEIPTS_DIR, sourceKey); }
function headPath(headKey: string): string { return shardedPath(HEADS_DIR, headKey); }

function shardedPath(root: string, key: string): string {
  const hash = createHash('sha256').update(key, 'utf8').digest('hex');
  return `${root}/${hash.slice(0, 2)}/${hash}.json`;
}

function isStorageHeadTrackedTarget(relativePath: string): boolean {
  return !isRebuildableGarbageTarget(relativePath);
}

function isRebuildableGarbageTarget(relativePath: string): boolean {
  return relativePath.startsWith('attachments/blobs/')
    || relativePath.startsWith('tool-result-blobs/sha256/');
}

function assertBusinessTarget(relativePath: string): void {
  const forbidden = [PENDING_DIR, COMMITTED_DIR, STAGING_DIR, CLAIMS_DIR, RECEIPTS_DIR, `${ROOT}/owner`];
  if (forbidden.some((root) => relativePath === root || relativePath.startsWith(`${root}/`))) {
    throw new FileTransactionIntegrityError(`Compiled transition targets transaction metadata: ${relativePath}`);
  }
}

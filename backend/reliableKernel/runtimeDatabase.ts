import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import {
  ROOT_BINDING_POINTER_FILE,
  type RootBinding,
  type RuntimeCommitResult,
  type SnapshotBarrier
} from './contracts';
import type {
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientVisibleMessageHistoryPageInput,
  ClientVisibleMessageHistoryPageResult,
  ConversationHistoryProjectionInput,
  ConversationHistoryProjectionResult,
  ClientProjectionSnapshot,
  ContextContentMaterializationSnapshot,
  ContextMaterializationSnapshot,
  ChildConversationOriginCandidate,
  ChildProcessCleanupMaterializationCandidate,
  DatabaseWorkerData,
  DatabaseWorkerDiagnostics,
  DatabaseWorkerRequest,
  ModelStreamActivityInput,
  ModelStreamActivityResult,
  ModelStreamEventCommitInput,
  ModelStreamEventCommitResult,
  ModelRequestCancelInput,
  ModelRequestCancelResult,
  EffectReceiptReconciliationCandidate,
  ProcessOutputRegistrationMismatch,
  DatabaseWorkerRequestPayload,
  DatabaseWorkerResponse,
  SerializedWorkerError,
  ToolFactsSnapshot
} from './databaseWorkerProtocol';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryListRead,
  type RepositoryRead,
  type RepositoryTransactionStep
} from './repositories';
import { RootAuthority } from './rootAuthority';
import {
  currentExecutionLeaseFence,
  ExecutionHandoffError,
  executionLeaseFenceAssertion,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import {
  recordRuntimePerformanceMetric,
  type RuntimeDatabaseMetricRequestKind,
  type RuntimePerformanceMetricEvent,
  type RuntimePerformanceMetricsSink
} from './runtimePerformanceMetrics';
import { readProcessStartFingerprint } from './processProtocol';

export interface SnapshotSubscription<T> {
  barrier: SnapshotBarrier<T>;
  unsubscribe(): void;
}

export class RuntimeDatabaseWorkerError extends Error {
  public constructor(error: SerializedWorkerError) {
    super(error.message);
    this.name = error.name || 'RuntimeDatabaseWorkerError';
    if (error.stack) this.stack = error.stack;
    if (error.code) (this as Error & { code?: string }).code = error.code;
  }
}

const OPEN_ROOT_POINTERS = new Set<string>();
const HOST_LIVENESS_DIRECTORY = 'host-liveness';
const HOST_HEARTBEAT_INTERVAL_MS = 5_000;
// This does not shorten ExecutionLease ownership. A verifiably live process remains authoritative
// regardless of heartbeat age; the grace is only a conservative fallback where the OS cannot
// determine process identity/liveness.
const HOST_HEARTBEAT_STALE_MS = 2 * 60_000;

interface RuntimeHostLivenessRecord {
  kind: 'limcode-runtime-host-liveness';
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  hostBootId: string;
  livenessId: string;
  processId: number;
  processStartIdentity?: string;
  startedAt: string;
  heartbeatAt: string;
}

export class RuntimeDatabase {
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    requestKind: RuntimeDatabaseMetricRequestKind;
    startedAtMs?: number;
  }>();
  private readonly commitListeners = new Set<(result: RuntimeCommitResult) => void>();
  private readonly performanceMetricSinks = new Set<RuntimePerformanceMetricsSink>();
  private readonly performanceMetricFanout: RuntimePerformanceMetricsSink = {
    record: (event) => {
      for (const sink of this.performanceMetricSinks) recordRuntimePerformanceMetric(sink, event);
    }
  };
  private nextRequestId = 1;
  private closed = false;
  private readonly livenessId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly processStartIdentity = readProcessStartIdentity(process.pid);
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatTask: Promise<void> = Promise.resolve();
  private heartbeatFailure: unknown;

  private constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding,
    public readonly hostBootId: string,
    private readonly worker: Worker,
    public readonly workerThreadId: number,
    private readonly registryKey: string,
    initialPerformanceMetrics?: RuntimePerformanceMetricsSink
  ) {
    if (initialPerformanceMetrics) this.performanceMetricSinks.add(initialPerformanceMetrics);
    worker.on('message', (message: DatabaseWorkerResponse) => this.onMessage(message));
    worker.on('error', (error) => this.failPending(error));
    worker.on('exit', (code) => {
      OPEN_ROOT_POINTERS.delete(this.registryKey);
      this.stopHeartbeatTimer();
      void this.unregisterHostLiveness().catch(() => undefined);
      if (!this.closed && code !== 0) this.failPending(new Error(`SQLite database worker exited with code ${code}.`));
    });
  }

  public static async open(
    authority: RootAuthority,
    options: { hostBootId?: string; performanceMetrics?: RuntimePerformanceMetricsSink } = {}
  ): Promise<RuntimeDatabase> {
    const binding = await authority.current();
    const hostBootId = options.hostBootId ?? randomUUID();
    const registryKey = binding.paths.rootPointerPath;
    if (OPEN_ROOT_POINTERS.has(registryKey)) {
      throw new Error(`A Runtime database worker is already open for ${registryKey}.`);
    }
    OPEN_ROOT_POINTERS.add(registryKey);
    const worker = createWorker({ mode: 'runtime', binding, hostBootId });
    try {
      const ready = await waitForReady(worker, 'runtime');
      const database = new RuntimeDatabase(
        authority,
        binding,
        hostBootId,
        worker,
        ready.workerThreadId,
        registryKey,
        options.performanceMetrics
      );
      await database.registerHostLiveness();
      return database;
    } catch (error) {
      OPEN_ROOT_POINTERS.delete(registryKey);
      await worker.terminate();
      throw error;
    }
  }

  public async transaction(steps: RepositoryTransactionStep[]): Promise<RuntimeCommitResult> {
    const fence = currentExecutionLeaseFence();
    const fencedSteps = fence
      ? [
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
            fence.id,
            executionLeaseFenceAssertion(fence)
          ),
          ...steps
        ]
      : steps;
    return this.requestWithExecutionFence(
      fence,
      { kind: 'transaction', steps: fencedSteps }
    );
  }

  public async snapshot(
    reads: RepositoryRead[]
  ): Promise<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>> {
    return this.request<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>>({ kind: 'snapshot', reads });
  }

  /** Reads every page of one repository list inside one SQLite read transaction. */
  public async snapshotAll(read: RepositoryListRead): Promise<SnapshotBarrier<DomainRow[]>> {
    return this.request<SnapshotBarrier<DomainRow[]>>({ kind: 'snapshotAll', read });
  }

  /** Fixed dependent Tool facts resolved inside one worker read transaction. */
  public async toolFactsSnapshot(toolCallId: string): Promise<SnapshotBarrier<ToolFactsSnapshot>> {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw new TypeError('toolCallId must be non-empty.');
    }
    return this.request<SnapshotBarrier<ToolFactsSnapshot>>({ kind: 'toolFactsSnapshot', toolCallId });
  }

  /** DB-side aggregate: returns only terminal processes whose registered chunk facts are incomplete. */
  public async processOutputRegistrationMismatches(): Promise<ProcessOutputRegistrationMismatch[]> {
    return this.request<ProcessOutputRegistrationMismatch[]>({ kind: 'processOutputRegistrationMismatches' });
  }

  /** DB-side anti-join: only receipt-written effects whose terminal projection is incomplete. */
  public async effectReceiptReconciliationCandidates(): Promise<EffectReceiptReconciliationCandidate[]> {
    return this.request<EffectReceiptReconciliationCandidate[]>({ kind: 'effectReceiptReconciliationCandidates' });
  }

  /** DB-side anti-join: only Child Conversations missing their immutable origin fact. */
  public async childConversationOriginCandidates(): Promise<ChildConversationOriginCandidate[]> {
    return this.request<ChildConversationOriginCandidate[]>({ kind: 'childConversationOriginCandidates' });
  }

  /** DB-side anti-join: only interruption/process pairs missing their cleanup outbox row. */
  public async childProcessCleanupMaterializationCandidates(): Promise<ChildProcessCleanupMaterializationCandidate[]> {
    return this.request<ChildProcessCleanupMaterializationCandidate[]>({
      kind: 'childProcessCleanupMaterializationCandidates'
    });
  }

  /**
   * Registers before requesting the writer barrier, buffers concurrent commits, discards those
   * already visible in the snapshot, then switches to live delivery without a gap.
   */
  public async snapshotAndSubscribe(
    reads: RepositoryRead[],
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<Array<DomainRow | DomainRow[] | null>>> {
    return this.barrierAndSubscribe(() => this.snapshot(reads), onCommit);
  }

  public async clientProjectionSnapshot(
    activeConversationId: string | null
  ): Promise<SnapshotBarrier<ClientProjectionSnapshot>> {
    if (activeConversationId !== null && (typeof activeConversationId !== 'string' || activeConversationId.length === 0)) {
      throw new TypeError('activeConversationId must be a non-empty id or null.');
    }
    return this.request<SnapshotBarrier<ClientProjectionSnapshot>>({
      kind: 'clientProjectionSnapshot',
      activeConversationId
    });
  }

  public async clientProjectionSnapshotAndSubscribe(
    activeConversationId: string | null,
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<ClientProjectionSnapshot>> {
    return this.barrierAndSubscribe(
      () => this.clientProjectionSnapshot(activeConversationId),
      onCommit
    );
  }

  public async clientKeysetPage(input: ClientKeysetPageInput): Promise<ClientKeysetPageResult> {
    return this.request<ClientKeysetPageResult>({ kind: 'clientKeysetPage', input });
  }

  public async clientVisibleMessageHistoryPage(
    input: ClientVisibleMessageHistoryPageInput
  ): Promise<ClientVisibleMessageHistoryPageResult> {
    return this.request<ClientVisibleMessageHistoryPageResult>({
      kind: 'clientVisibleMessageHistoryPage',
      input
    });
  }

  public async conversationHistoryProjection(
    input: ConversationHistoryProjectionInput
  ): Promise<ConversationHistoryProjectionResult> {
    return this.request<ConversationHistoryProjectionResult>({ kind: 'conversationHistoryProjection', input });
  }

  /**
   * Connection-local SQLite data version observed by this worker's writer connection. It changes
   * only after another SQLite connection commits, so client feeds can discover commits produced by
   * a different Extension Host without turning local streaming commits into snapshot churn.
   */
  public async externalDataVersion(): Promise<string> {
    const version = await this.request<string>({ kind: 'externalDataVersion' });
    if (!/^\d+$/.test(version)) throw new TypeError('SQLite external data version must be decimal.');
    return version;
  }

  /**
   * Cross-Extension-Host liveness used before rebinding an ExecutionLease. The file identity is
   * bound to this immutable Runtime root and Host boot; a definitely dead/reused pid is rejected
   * immediately. A verifiably live process is never displaced merely because its event loop was
   * delayed; heartbeat age is consulted only when the OS process result is inconclusive.
   */
  public async isHostAlive(hostBootIdInput: string): Promise<boolean> {
    const hostBootId = requireNonEmptyText(hostBootIdInput, 'hostBootId');
    if (hostBootId === this.hostBootId) return !this.closed && this.heartbeatFailure === undefined;
    await this.validateBinding('host_liveness');
    const record = await readHostLiveness(this.hostLivenessPath(hostBootId));
    if (!record || !sameLivenessRoot(record, this.binding) || record.hostBootId !== hostBootId) return false;
    const processState = inspectRecordedProcess(record);
    if (processState === 'dead') return false;
    if (processState === 'alive') return true;
    const heartbeatAt = Date.parse(record.heartbeatAt);
    return Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= HOST_HEARTBEAT_STALE_MS;
  }

  public onCommit(listener: (result: RuntimeCommitResult) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /** Present only while an explicitly attached development observer exists. */
  public get performanceMetrics(): RuntimePerformanceMetricsSink | undefined {
    return this.performanceMetricSinks.size > 0 ? this.performanceMetricFanout : undefined;
  }

  /** Allows a focused benchmark to observe an Application-owned database after it has opened. */
  public attachPerformanceMetrics(sink: RuntimePerformanceMetricsSink): () => void {
    this.performanceMetricSinks.add(sink);
    return () => this.performanceMetricSinks.delete(sink);
  }

  /** Metadata-only hook shared by control planes that already receive this database instance. */
  public recordPerformanceMetric(event: RuntimePerformanceMetricEvent): void {
    recordRuntimePerformanceMetric(this.performanceMetrics, event);
  }

  private async barrierAndSubscribe<T>(
    readBarrier: () => Promise<SnapshotBarrier<T>>,
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<T>> {
    const buffered: RuntimeCommitResult[] = [];
    let live = false;
    const listener = (result: RuntimeCommitResult) => {
      if (live) onCommit(result);
      else buffered.push(result);
    };
    this.commitListeners.add(listener);
    try {
      const barrier = await readBarrier();
      const visible = BigInt(barrier.snapshotCommitSeq);
      for (const result of buffered) {
        if (BigInt(result.commitSeq) > visible) onCommit(result);
      }
      live = true;
      return {
        barrier,
        unsubscribe: () => this.commitListeners.delete(listener)
      };
    } catch (error) {
      this.commitListeners.delete(listener);
      throw error;
    }
  }

  /** Fixed domain read; no caller-supplied SQL or closure-table state. */
  public async materializeContext(rootId: string): Promise<SnapshotBarrier<ContextMaterializationSnapshot>> {
    if (typeof rootId !== 'string' || rootId.length === 0) throw new TypeError('Context rootId must be non-empty.');
    return this.request<SnapshotBarrier<ContextMaterializationSnapshot>>({ kind: 'contextMaterialization', rootId });
  }

  /** Fixed Context + CAS read executed off the Extension Host event loop. */
  public async materializeContextContent(
    rootId: string
  ): Promise<SnapshotBarrier<ContextContentMaterializationSnapshot>> {
    if (typeof rootId !== 'string' || rootId.length === 0) throw new TypeError('Context rootId must be non-empty.');
    return this.request<SnapshotBarrier<ContextContentMaterializationSnapshot>>({
      kind: 'contextContentMaterialization', rootId
    });
  }

  public async commitModelStreamEvent(
    input: ModelStreamEventCommitInput
  ): Promise<ModelStreamEventCommitResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'modelStreamEvent',
      input: executionFence ? { ...input, executionFence } : input
    });
  }

  public async recordModelStreamActivity(
    input: ModelStreamActivityInput
  ): Promise<ModelStreamActivityResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'modelStreamActivity',
      input: executionFence ? { ...input, executionFence } : input
    });
  }

  public async cancelCurrentModelRequest(
    input: ModelRequestCancelInput
  ): Promise<ModelRequestCancelResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'cancelCurrentModelRequest',
      input: executionFence ? { ...input, executionFence } : input
    });
  }

  /**
   * An executor CAS and an ownership handoff can race. Ordinary assertion failures retain their
   * original meaning while the captured lease still exists; once its immutable tuple is gone,
   * however, the executor must stand down rather than terminalizing the Turn as a tool/model
   * failure. The verification read is deliberately unfenced and never adopts a newer generation.
   */
  private async requestWithExecutionFence<T>(
    fence: ExecutionLeaseFence | undefined,
    request: DatabaseWorkerRequestPayload
  ): Promise<T> {
    try {
      return await this.request<T>(request);
    } catch (error) {
      if (!fence || !isRuntimeTransactionAssertionError(error)) throw error;
      const stillCurrent = await this.executionFenceStillCurrent(fence).catch(() => false);
      if (stillCurrent) throw error;
      const handoff = new ExecutionHandoffError(
        `ExecutionLease generation ${fence.generation} no longer authorizes Turn ${fence.turnId}.`
      );
      (handoff as ExecutionHandoffError & { cause?: unknown }).cause = error;
      throw handoff;
    }
  }

  private async executionFenceStillCurrent(fence: ExecutionLeaseFence): Promise<boolean> {
    const result = await this.request<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>>({
      kind: 'snapshot',
      reads: [DOMAIN_REPOSITORIES.domain('ExecutionLease').get(fence.id)]
    });
    const row = result.snapshot[0];
    return !!row
      && !Array.isArray(row)
      && row.conversation_id === fence.conversationId
      && row.turn_id === fence.turnId
      && row.owner_id === fence.ownerId
      && row.host_boot_id === fence.hostBootId
      && row.generation === fence.generation;
  }

  public async inspect(): Promise<DatabaseWorkerDiagnostics> {
    return this.request<DatabaseWorkerDiagnostics>({ kind: 'inspect' });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.stopHeartbeatTimer();
    try {
      await this.heartbeatTask.catch(() => undefined);
      await this.sendRequest<null>({ kind: 'close' });
    } finally {
      this.closed = true;
      OPEN_ROOT_POINTERS.delete(this.registryKey);
      this.commitListeners.clear();
      await this.worker.terminate();
      await this.unregisterHostLiveness().catch(() => undefined);
      this.performanceMetricSinks.clear();
    }
  }

  private async request<T>(request: DatabaseWorkerRequestPayload): Promise<T> {
    if (this.closed) throw new Error('RuntimeDatabase is closed.');
    if (this.heartbeatFailure !== undefined) {
      const error = new Error('RuntimeDatabase Host liveness heartbeat failed; requests are fenced until restart.') as Error & {
        cause?: unknown;
      };
      error.cause = this.heartbeatFailure;
      throw error;
    }
    await this.validateBinding(databaseMetricRequestKind(request.kind));
    return this.sendRequest<T>(request);
  }

  private async validateBinding(
    requestKind: RuntimeDatabaseMetricRequestKind | 'host_liveness'
  ): Promise<RootBinding> {
    const metrics = this.performanceMetrics;
    const startedAtMs = metrics ? performance.now() : undefined;
    try {
      const binding = await this.authority.validate(this.binding);
      if (metrics && startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.root_validate',
          requestKind,
          durationMs: performance.now() - startedAtMs,
          outcome: 'ok'
        });
      }
      return binding;
    } catch (error) {
      if (metrics && startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.root_validate',
          requestKind,
          durationMs: performance.now() - startedAtMs,
          outcome: 'error'
        });
      }
      throw error;
    }
  }

  private async registerHostLiveness(): Promise<void> {
    await this.writeHostHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatTask = this.heartbeatTask
        .then(() => this.writeHostHeartbeat())
        .catch((error) => {
          this.heartbeatFailure = error;
          this.stopHeartbeatTimer();
          this.failPending(error);
          this.closed = true;
          this.commitListeners.clear();
          void this.worker.terminate()
            .finally(() => this.unregisterHostLiveness().catch(() => undefined));
        });
    }, HOST_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async writeHostHeartbeat(): Promise<void> {
    if (this.closed) return;
    const record: RuntimeHostLivenessRecord = {
      kind: 'limcode-runtime-host-liveness',
      dataSetId: this.binding.dataSetId,
      rootInstanceId: this.binding.rootInstanceId,
      rootGeneration: this.binding.rootGeneration,
      hostBootId: this.hostBootId,
      livenessId: this.livenessId,
      processId: process.pid,
      ...(this.processStartIdentity ? { processStartIdentity: this.processStartIdentity } : {}),
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString()
    };
    const target = this.hostLivenessPath(this.hostBootId);
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${this.livenessId}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  }

  private async unregisterHostLiveness(): Promise<void> {
    const target = this.hostLivenessPath(this.hostBootId);
    const record = await readHostLiveness(target);
    if (record?.livenessId !== this.livenessId) return;
    await fs.rm(target, { force: true });
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private hostLivenessPath(hostBootId: string): string {
    const digest = createHash('sha256')
      .update('limcode-runtime-host-liveness\0')
      .update(hostBootId)
      .digest('hex');
    return path.join(this.binding.paths.dataRootPath, HOST_LIVENESS_DIRECTORY, `${digest}.json`);
  }

  private sendRequest<T>(request: DatabaseWorkerRequestPayload): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RuntimeDatabase is closed.'));
    const id = this.nextRequestId++;
    const metrics = this.performanceMetrics;
    const startedAtMs = metrics ? performance.now() : undefined;
    const requestKind = databaseMetricRequestKind(request.kind);
    if (metrics) {
      recordRuntimePerformanceMetric(metrics, {
        kind: 'database.request',
        phase: 'started',
        requestKind
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        requestKind,
        ...(startedAtMs !== undefined ? { startedAtMs } : {})
      });
      this.worker.postMessage({
        ...request,
        id,
        ...(startedAtMs !== undefined ? { metricEnqueuedAtMs: performance.now() } : {})
      } as DatabaseWorkerRequest);
    });
  }

  private onMessage(message: DatabaseWorkerResponse): void {
    if (message.type === 'commit') {
      const metrics = this.performanceMetrics;
      const startedAtMs = metrics ? performance.now() : undefined;
      const listenerCount = this.commitListeners.size;
      try {
        for (const listener of this.commitListeners) listener(message.result);
      } finally {
        if (metrics && startedAtMs !== undefined) {
          recordRuntimePerformanceMetric(metrics, {
            kind: 'database.commit_listeners',
            listenerCount,
            durationMs: performance.now() - startedAtMs
          });
        }
      }
      return;
    }
    if (message.type === 'fatal') {
      this.failPending(new RuntimeDatabaseWorkerError(message.error));
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const metrics = this.performanceMetrics;
    if (metrics && pending.startedAtMs !== undefined) {
      recordRuntimePerformanceMetric(metrics, {
        kind: 'database.request',
        phase: 'finished',
        requestKind: pending.requestKind,
        outcome: message.ok ? 'ok' : 'error',
        roundTripDurationMs: performance.now() - pending.startedAtMs,
        ...(message.timing ? {
          workerQueueWaitMs: message.timing.queueWaitMs,
          workerExecuteDurationMs: message.timing.executeDurationMs
        } : {})
      });
    }
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new RuntimeDatabaseWorkerError(message.error));
  }

  private failPending(error: unknown): void {
    const metrics = this.performanceMetrics;
    for (const pending of this.pending.values()) {
      if (metrics && pending.startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.request',
          phase: 'finished',
          requestKind: pending.requestKind,
          outcome: 'error',
          roundTripDurationMs: performance.now() - pending.startedAtMs
        });
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function initializeEmptyRuntimeRoot(authority: RootAuthority): Promise<RootBinding> {
  return authority.initializeEmptyRoot(initializeBindingStorage);
}

/** Fixed SQLite/CAS initializer used only by RootAuthority's offline cutover activation. */
export async function initializeCutoverRuntimeBinding(binding: RootBinding): Promise<void> {
  return initializeBindingStorage(binding);
}

export async function resetCandidateRuntimeRoot(candidateParentPath: string): Promise<{
  authority: RootAuthority;
  binding: RootBinding;
}> {
  const pointerPath = path.join(path.resolve(candidateParentPath), ROOT_BINDING_POINTER_FILE);
  if (OPEN_ROOT_POINTERS.has(pointerPath)) {
    throw new Error('Candidate root reset requires the current Runtime database worker to be closed first.');
  }
  return RootAuthority.resetCandidateRoot(candidateParentPath, initializeBindingStorage);
}

async function initializeBindingStorage(binding: RootBinding): Promise<void> {
  const worker = createWorker({ mode: 'initialize', binding, hostBootId: randomUUID() });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    worker.on('message', (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') reject(new RuntimeDatabaseWorkerError(message.error));
      else if (message.type === 'ready') ready = message.mode === 'initialize';
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && ready) resolve();
      else reject(new Error(`SQLite initialization worker exited with code ${code}${ready ? '' : ' before ready'}.`));
    });
  });
}

function createWorker(data: DatabaseWorkerData): Worker {
  return new Worker(path.join(__dirname, 'databaseWorker.js'), { workerData: data });
}

function waitForReady(
  worker: Worker,
  expectedMode: DatabaseWorkerData['mode']
): Promise<{ workerThreadId: number }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') {
        cleanup();
        reject(new RuntimeDatabaseWorkerError(message.error));
      } else if (message.type === 'ready') {
        cleanup();
        if (message.mode !== expectedMode) reject(new Error(`Unexpected database worker mode: ${message.mode}`));
        else resolve({ workerThreadId: message.workerThreadId });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`SQLite database worker exited before ready with code ${code}.`));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function isRuntimeTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function databaseMetricRequestKind(
  kind: DatabaseWorkerRequestPayload['kind']
): RuntimeDatabaseMetricRequestKind {
  // Historical Message pages are the backwards/keyset form of the existing bounded page metric.
  return kind === 'clientVisibleMessageHistoryPage' ? 'clientKeysetPage' : kind;
}

async function readHostLiveness(filePath: string): Promise<RuntimeHostLivenessRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    // A torn/corrupt liveness record must never be interpreted as proof that another Host is alive.
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'limcode-runtime-host-liveness'
    || typeof record.dataSetId !== 'string'
    || typeof record.rootInstanceId !== 'string'
    || !Number.isSafeInteger(record.rootGeneration)
    || typeof record.hostBootId !== 'string'
    || typeof record.livenessId !== 'string'
    || !Number.isSafeInteger(record.processId)
    || typeof record.startedAt !== 'string'
    || typeof record.heartbeatAt !== 'string'
    || (record.processStartIdentity !== undefined && typeof record.processStartIdentity !== 'string')
  ) return undefined;
  return record as unknown as RuntimeHostLivenessRecord;
}

function sameLivenessRoot(record: RuntimeHostLivenessRecord, binding: RootBinding): boolean {
  return record.dataSetId === binding.dataSetId
    && record.rootInstanceId === binding.rootInstanceId
    && record.rootGeneration === binding.rootGeneration;
}

function inspectRecordedProcess(record: RuntimeHostLivenessRecord): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(record.processId) || record.processId <= 0) return 'unknown';
  try {
    process.kill(record.processId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
  if (!record.processStartIdentity) return 'alive';
  const currentIdentity = readProcessStartIdentity(record.processId);
  if (currentIdentity === undefined) return 'unknown';
  return currentIdentity === record.processStartIdentity ? 'alive' : 'dead';
}

/** Supported hosts fence PID reuse with the same platform-specific identity as process wrappers. */
function readProcessStartIdentity(processId: number): string | undefined {
  try {
    return readProcessStartFingerprint(processId);
  } catch {
    return undefined;
  }
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

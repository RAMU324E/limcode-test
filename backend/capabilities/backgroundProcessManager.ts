import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type {
  BackgroundProcessOriginLinkRecord,
  BackgroundProcessRecord,
  BackgroundProcessStatus
} from '../../shared/protocol';
import type { CommandOutputLimits, CommandRunResult, RuntimePaths } from './types';
import {
  backgroundProcessDeliveryId,
  backgroundProcessDeliverySourceKey,
  backgroundProcessExitReceiptId,
  backgroundProcessOriginLinkId,
  backgroundProcessOutputRecordId,
  type BackgroundProcessDeliveryResolution,
  type BackgroundProcessExitReceiptRecord,
  type BackgroundProcessNotificationDeliveryRecord,
  type BackgroundProcessOriginDescriptor,
  type BackgroundProcessOutputRecord,
  type BackgroundProcessSnapshot
} from './backgroundProcessTypes';
import { sortableName } from './vscodeStorage/naming';
import { readJsonFileStrictSync, unlinkWithRetrySync, writeJsonFileAtomicSync } from './vscodeStorage/syncJson';
import { SyncRecordStore, type SyncRecordStoreLocations } from './vscodeStorage/syncRecordStore';

const STORAGE_VERSION = 1;
const OUTPUTS_DIR = 'outputs';
const PERSIST_DEBOUNCE_MS = 250;
const PERSIST_RETRY_MS = 500;
const OWNER_HEARTBEAT_INTERVAL_MS = 1_000;
const OWNER_HEARTBEAT_TIMEOUT_MS = 5_000;
const EXIT_NOTIFICATION_TAIL_CHARS = 12_000;
const CONSUMED_PROCESS_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DELIVERY_CAS_MAX_RETRIES = 16;
const DEFAULT_OUTPUT_LIMITS: CommandOutputLimits = { maxOutputLines: 100, maxOutputChars: 10_000 };

export type BackgroundProcessPaths = Pick<RuntimePaths,
  | 'backgroundProcessesRootPath'
  | 'backgroundProcessesIndexPath'
  | 'backgroundProcessOriginLinksRootPath'
  | 'backgroundProcessOriginLinksIndexPath'
  | 'backgroundProcessExitReceiptsRootPath'
  | 'backgroundProcessExitReceiptsIndexPath'
  | 'backgroundProcessNotificationDeliveriesRootPath'
  | 'backgroundProcessNotificationDeliveriesIndexPath'
>;

export type BackgroundProcessPathsProvider = () => BackgroundProcessPaths | undefined;

interface OutputBufferSnapshot {
  text: string;
  dropped: number;
}

type ModelPollTerminalClaim = 'model_poll' | 'auto_delivery' | 'unavailable';

export interface BackgroundProcessOutputBuffer {
  snapshot(): OutputBufferSnapshot;
  append(value: string): void;
}

export interface AdoptBackgroundProcessInput {
  toolName: 'shell' | 'bash';
  command: string;
  cwd: string;
  pid?: number;
  startedAt: number;
  stdout: BackgroundProcessOutputBuffer;
  stderr: BackgroundProcessOutputBuffer;
  origin?: BackgroundProcessOriginDescriptor;
  kill(): void;
}

interface PersistedBackgroundProcessRecord extends BackgroundProcessRecord {
  version: number;
  storageRevision: number;
  ownerInstanceId: string;
  ownerPid: number;
  heartbeatAt: number;
  outputFile: string;
}

interface ManagedBackgroundProcessHandle {
  process: PersistedBackgroundProcessRecord;
  stdout: BackgroundProcessOutputBuffer;
  stderr: BackgroundProcessOutputBuffer;
  kill: () => void;
  persistedRevision: number;
  persistTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  dirty: boolean;
}

export interface BackgroundProcessManagerOptions {
  paths?: BackgroundProcessPathsProvider;
  now?: () => number;
}

/**
 * Long-lived owner of local background-process state. Tool Attempts merely create/adopt a process;
 * delayed exit facts are persisted and delivered independently of the Tool controller lifetime.
 */
export class BackgroundProcessManager {
  private readonly ownerInstanceId = `background-owner:${process.pid}:${randomBytes(8).toString('hex')}`;
  private readonly now: () => number;
  private readonly handles = new Map<string, ManagedBackgroundProcessHandle>();
  private readonly processes = new Map<string, PersistedBackgroundProcessRecord>();
  private readonly origins = new Map<string, BackgroundProcessOriginLinkRecord>();
  private readonly receipts = new Map<string, BackgroundProcessExitReceiptRecord>();
  private readonly deliveries = new Map<string, BackgroundProcessNotificationDeliveryRecord>();
  private readonly outputs = new Map<string, BackgroundProcessOutputRecord>();
  private readonly snapshotListeners = new Set<(snapshot: BackgroundProcessSnapshot) => void>();
  private readonly deliveryListeners = new Set<() => void>();
  private readonly emittedDeliveryWakeIds = new Set<string>();
  private loadedStorageIdentity: string | undefined;
  private disposed = false;

  private readonly processStore: SyncRecordStore<PersistedBackgroundProcessRecord>;
  private readonly originStore: SyncRecordStore<BackgroundProcessOriginLinkRecord>;
  private readonly receiptStore: SyncRecordStore<BackgroundProcessExitReceiptRecord>;
  private readonly deliveryStore: SyncRecordStore<BackgroundProcessNotificationDeliveryRecord>;

  public constructor(private readonly options: BackgroundProcessManagerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.processStore = new SyncRecordStore({
      name: 'BackgroundProcess',
      locations: () => locationsFor(options.paths, 'process'),
      isRecord: isPersistedBackgroundProcessRecord,
      updatedAt: (record) => record.updatedAt,
      label: (record) => record.command
    });
    this.originStore = new SyncRecordStore({
      name: 'BackgroundProcessOriginLink',
      locations: () => locationsFor(options.paths, 'origin'),
      isRecord: isBackgroundProcessOriginLinkRecord,
      updatedAt: (record) => record.updatedAt,
      label: (record) => record.processId
    });
    this.receiptStore = new SyncRecordStore({
      name: 'BackgroundProcessExitReceipt',
      locations: () => locationsFor(options.paths, 'receipt'),
      isRecord: isBackgroundProcessExitReceiptRecord,
      updatedAt: (record) => record.createdAt,
      label: (record) => record.processId
    });
    this.deliveryStore = new SyncRecordStore({
      name: 'BackgroundProcessNotificationDelivery',
      locations: () => locationsFor(options.paths, 'delivery'),
      isRecord: isBackgroundProcessNotificationDeliveryRecord,
      updatedAt: (record) => record.updatedAt,
      label: (record) => record.processId
    });
  }

  public adopt(input: AdoptBackgroundProcessInput): BackgroundProcessRecord {
    this.assertActive();
    this.ensureLoaded();
    const processId = this.generateProcessId();
    const now = this.now();
    const outputFile = `${sortableName(processId, input.command)}.json`;
    const stdout = input.stdout.snapshot();
    const stderr = input.stderr.snapshot();
    const processRecord: PersistedBackgroundProcessRecord = {
      version: STORAGE_VERSION,
      storageRevision: 1,
      id: processId,
      processId,
      ...(input.pid !== undefined ? { pid: input.pid } : {}),
      toolName: input.toolName,
      command: input.command,
      cwd: input.cwd,
      status: 'running',
      exitCode: null,
      killed: false,
      startedAt: input.startedAt,
      backgroundedAt: now,
      updatedAt: now,
      terminalRevision: 0,
      stdoutChars: stdout.text.length,
      stderrChars: stderr.text.length,
      droppedChars: stdout.dropped + stderr.dropped,
      outputAvailable: true,
      ownerInstanceId: this.ownerInstanceId,
      ownerPid: process.pid,
      heartbeatAt: now,
      outputFile
    };
    const handle: ManagedBackgroundProcessHandle = {
      process: processRecord,
      stdout: input.stdout,
      stderr: input.stderr,
      kill: input.kill,
      persistedRevision: 0,
      dirty: true
    };
    this.handles.set(processId, handle);
    this.processes.set(processId, processRecord);
    this.outputs.set(processId, outputRecordFromSnapshots(processRecord, stdout, stderr, now));
    if (input.origin) {
      const origin: BackgroundProcessOriginLinkRecord = {
        id: backgroundProcessOriginLinkId(processId),
        backgroundProcessId: processId,
        processId,
        sourceToolCallId: input.origin.sourceToolCallId,
        sourceRunId: input.origin.sourceRunId,
        conversationId: input.origin.conversationId,
        sourceAttemptId: input.origin.sourceAttemptId,
        sourceGeneration: input.origin.sourceGeneration,
        createdAt: now,
        updatedAt: now
      };
      this.origins.set(processId, origin);
    }
    this.startHeartbeat(handle);
    try {
      this.persistHandle(handle, true);
    } catch (error) {
      this.stopTimers(handle);
      try { input.kill(); } catch { /* adoption still fails closed */ }
      this.handles.delete(processId);
      this.processes.delete(processId);
      this.origins.delete(processId);
      this.outputs.delete(processId);
      try { this.originStore.remove(backgroundProcessOriginLinkId(processId)); } catch { /* preserve original persistence error */ }
      try { this.processStore.remove(processId); } catch { /* preserve original persistence error */ }
      const outputPath = this.outputPath(processRecord);
      if (outputPath) {
        try { unlinkWithRetrySync(outputPath, true); } catch { /* preserve original persistence error */ }
      }
      throw error;
    }
    this.emitSnapshot();
    return publicProcessRecord(processRecord);
  }

  public noteOutput(processId: string): void {
    const handle = this.handles.get(processId);
    if (!handle || handle.process.status !== 'running' || this.disposed) return;
    this.refreshOutputMetadata(handle);
    handle.dirty = true;
    this.schedulePersist(handle, PERSIST_DEBOUNCE_MS);
  }

  public finalizeNaturalExit(processId: string, exitCode: number): void {
    this.finalize(processId, exitCode, 'exited');
  }

  public finalizeAbnormalExit(processId: string, reason: string, exitCode = 1): void {
    const handle = this.handles.get(processId);
    if (!handle || handle.process.status !== 'running') return;
    appendDiagnostic(handle.stderr, reason);
    this.finalize(processId, exitCode, 'abnormal', reason);
  }

  public readOutput(
    processId: string,
    limits: CommandOutputLimits = DEFAULT_OUTPUT_LIMITS,
    options: { consume?: boolean; claimTerminal?: boolean } = {}
  ): CommandRunResult {
    this.ensureLoaded();
    const handle = this.handles.get(processId);
    if (handle) {
      this.refreshOutputMetadata(handle);
      this.persistHandle(handle, false);
    } else {
      this.refreshPersistedProcess(processId);
    }
    const processRecord = this.processes.get(processId);
    if (!processRecord || !processRecord.outputAvailable) return notFoundResult(processId);
    const output = handle ? outputRecordFromHandle(handle, this.now()) : this.loadOutput(processRecord);
    // A terminal log cannot be consumed before its immutable receipt/outbox have been materialized.
    // This closes the crash window between the terminal Process CAS and ensureTerminalFacts().
    let terminalClaim: ModelPollTerminalClaim = 'unavailable';
    if (processRecord.status !== 'running') {
      this.ensureTerminalFacts(processRecord, output);
      if (options.claimTerminal === true) terminalClaim = this.resolveTerminalRevisionClaimForModelPoll(processRecord.processId);
    }
    const result = commandResultFromRecords(processRecord, output, limits);
    const claimedResult: CommandRunResult = terminalClaim === 'auto_delivery'
      ? {
          ...result,
          stdout: '',
          stderr: '[LimCode] 该终态 revision 已由自动 completion 投递接管；本次 output 不重复返回终态日志，请处理随后到达的内部通知。',
          terminalRevisionClaim: 'auto_delivery'
        }
      : terminalClaim === 'model_poll'
        ? { ...result, terminalRevisionClaim: 'model_poll' }
        : result;
    if (processRecord.status !== 'running' && options.consume === true) this.consumeOutput(processRecord);
    return claimedResult;
  }

  public kill(processId: string): CommandRunResult {
    this.ensureLoaded();
    const handle = this.handles.get(processId);
    if (handle?.process.status === 'running') {
      try {
        handle.kill();
      } finally {
        this.finalize(processId, handle.process.exitCode ?? 1, 'killed');
      }
      return this.readOutput(processId, DEFAULT_OUTPUT_LIMITS, { consume: false });
    }

    const processRecord = this.refreshPersistedProcess(processId);
    if (!processRecord) return notFoundResult(processId);
    if (processRecord.status === 'running' && this.isActiveExternalOwner(processRecord)) {
      const output = processRecord.outputAvailable ? this.loadOutput(processRecord) : emptyOutput(processRecord, this.now());
      return {
        ...commandResultFromRecords(processRecord, output, DEFAULT_OUTPUT_LIMITS),
        stderr: appendLine(output.stderr, '[LimCode] 后台进程由另一个活跃扩展实例持有，当前实例拒绝终止或消费它。')
      };
    }
    if (processRecord.status === 'running') this.reconcileOrphanedProcess(processRecord);
    const current = this.processes.get(processId);
    if (!current || !current.outputAvailable) return notFoundResult(processId);
    return commandResultFromRecords(current, this.loadOutput(current), DEFAULT_OUTPUT_LIMITS);
  }

  public snapshot(): BackgroundProcessSnapshot {
    this.ensureLoaded();
    this.refreshProjectionRecords();
    return {
      processes: [...this.processes.values()].map(publicProcessRecord).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)),
      originLinks: [...this.origins.values()].map((record) => ({ ...record })).sort((a, b) => a.id.localeCompare(b.id))
    };
  }

  public onSnapshotChanged(listener: (snapshot: BackgroundProcessSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  /** Wake-up hint only. Correctness comes from scanning persisted pending deliveries. */
  public onDeliveryAvailable(listener: () => void): () => void {
    this.deliveryListeners.add(listener);
    return () => this.deliveryListeners.delete(listener);
  }

  public listPendingDeliveryIds(): string[] {
    this.ensureLoaded();
    this.refreshDeliveryRecords();
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((delivery) => delivery.id);
  }

  /**
   * Claims one terminal revision for automatic inbox delivery. The claim is durable and retryable;
   * a model mode=output poll that won first makes this return undefined.
   */
  public claimDeliveryForAuto(deliveryId: string): BackgroundProcessNotificationDeliveryRecord | undefined {
    this.ensureLoaded();
    const current = this.deliveryStore.get(deliveryId) ?? this.deliveries.get(deliveryId);
    if (!current || current.status !== 'pending') return undefined;
    if (current.claimOwner === 'auto_delivery') return { ...current };
    if (current.claimOwner !== undefined) return undefined;
    const claimed = this.updateDelivery(
      deliveryId,
      (delivery) => delivery.status === 'pending' && delivery.claimOwner === undefined,
      (delivery, now) => ({ ...delivery, claimOwner: 'auto_delivery', claimedAt: now, updatedAt: now })
    );
    return claimed?.status === 'pending' && claimed.claimOwner === 'auto_delivery' ? claimed : undefined;
  }

  /**
   * Model polling and automatic wake share the same terminal-revision CAS. Passive Webview reads do
   * not call this method. A poll claim closes the outbox as stale because the tool response itself
   * is now the model-visible completion path.
   */
  public claimTerminalRevisionForModelPoll(processId: string): boolean {
    return this.resolveTerminalRevisionClaimForModelPoll(processId) === 'model_poll';
  }

  private resolveTerminalRevisionClaimForModelPoll(processId: string): ModelPollTerminalClaim {
    this.ensureLoaded();
    const processRecord = this.processStore.get(processId) ?? this.processes.get(processId);
    if (!processRecord || processRecord.status === 'running') return 'unavailable';
    const revision = Math.max(1, processRecord.terminalRevision);
    const deliveryId = backgroundProcessDeliveryId(processId, revision);
    const current = this.deliveryStore.get(deliveryId) ?? this.deliveries.get(deliveryId);
    if (!current) return 'unavailable';
    if (current.claimOwner === 'model_poll') return 'model_poll';
    if (current.claimOwner === 'auto_delivery' && (current.status === 'pending' || current.status === 'delivered')) return 'auto_delivery';
    if (current.status !== 'pending' || current.claimOwner !== undefined) return 'unavailable';
    const claimed = this.updateDelivery(
      deliveryId,
      (delivery) => delivery.status === 'pending' && delivery.claimOwner === undefined,
      (delivery, now) => ({
        ...delivery,
        status: 'stale',
        claimOwner: 'model_poll',
        claimedAt: now,
        staleAt: now,
        staleReason: 'terminal_revision_claimed_by_model_poll',
        updatedAt: now,
        lastError: undefined
      })
    );
    if (claimed?.claimOwner === 'model_poll') return 'model_poll';
    if (claimed?.claimOwner === 'auto_delivery' && (claimed.status === 'pending' || claimed.status === 'delivered')) return 'auto_delivery';
    return 'unavailable';
  }

  public resolveDelivery(deliveryId: string): BackgroundProcessDeliveryResolution | undefined {
    this.ensureLoaded();
    const delivery = this.deliveryStore.get(deliveryId) ?? this.deliveries.get(deliveryId);
    if (!delivery) return undefined;
    this.deliveries.set(delivery.id, delivery);
    if (delivery.status !== 'pending') return undefined;
    const processRecord = this.processStore.get(delivery.backgroundProcessId) ?? this.processes.get(delivery.backgroundProcessId);
    const origin = this.originStore.get(backgroundProcessOriginLinkId(delivery.processId)) ?? this.origins.get(delivery.processId);
    const receipt = this.receiptStore.get(delivery.receiptId) ?? this.receipts.get(delivery.receiptId);
    if (!processRecord) return { status: 'stale', delivery: { ...delivery }, reason: 'background_process_missing' };
    if (!origin) return { status: 'stale', delivery: { ...delivery }, reason: 'background_process_origin_missing' };
    if (!receipt) return { status: 'stale', delivery: { ...delivery }, reason: 'background_process_exit_receipt_missing' };
    const projectionChanged = !samePublicProcessRecord(this.processes.get(processRecord.id), processRecord)
      || !sameOriginLinkOptional(this.origins.get(origin.processId), origin);
    this.processes.set(processRecord.id, processRecord);
    this.origins.set(origin.processId, origin);
    this.receipts.set(receipt.id, receipt);
    if (projectionChanged) this.emitSnapshot();
    return {
      status: 'ready',
      envelope: {
        process: publicProcessRecord(processRecord),
        origin: { ...origin },
        receipt: { ...receipt },
        delivery: { ...delivery }
      }
    };
  }

  public recordDeliveryAttempt(deliveryId: string): BackgroundProcessNotificationDeliveryRecord | undefined {
    const next = this.updateDelivery(
      deliveryId,
      (delivery) => delivery.status === 'pending' && delivery.claimOwner === 'auto_delivery',
      (delivery, now) => ({
        ...delivery,
        attemptCount: delivery.attemptCount + 1,
        lastAttemptAt: now,
        updatedAt: now,
        lastError: undefined
      })
    );
    return next?.status === 'pending' ? { ...next } : undefined;
  }

  public markDeliveryDelivered(deliveryId: string): void {
    // A durable sink receipt is stronger evidence than a concurrent stale decision. Delivered is
    // therefore allowed to correct stale, while stale can never overwrite delivered.
    this.updateDelivery(
      deliveryId,
      (delivery) => (delivery.status === 'pending' || delivery.status === 'stale') && delivery.claimOwner === 'auto_delivery',
      (delivery, now) => ({
        ...delivery,
        status: 'delivered',
        deliveredAt: now,
        staleAt: undefined,
        staleReason: undefined,
        updatedAt: now,
        lastError: undefined
      })
    );
    this.collectGarbage();
  }

  public markDeliveryStale(deliveryId: string, reason: string): void {
    this.updateDelivery(
      deliveryId,
      (delivery) => delivery.status === 'pending',
      (delivery, now) => ({
        ...delivery,
        status: 'stale',
        deliveredAt: undefined,
        staleAt: now,
        staleReason: reason,
        updatedAt: now,
        lastError: undefined
      })
    );
    this.collectGarbage();
  }

  public recordDeliveryFailure(deliveryId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.updateDelivery(
      deliveryId,
      (delivery) => delivery.status === 'pending',
      (delivery, now) => ({ ...delivery, lastError: message, updatedAt: now })
    );
  }

  /**
   * 仅清理由用户显式消费、且 notification 已 delivered/stale 超过保留期的审计记录。
   * 未消费日志和 pending delivery 永不由 GC 隐式删除。
   */
  public collectGarbage(retentionMs = CONSUMED_PROCESS_RETENTION_MS): number {
    this.ensureLoaded();
    const cutoff = this.now() - Math.max(0, retentionMs);
    let removed = 0;
    for (const processRecord of [...this.processes.values()]) {
      if (processRecord.status === 'running'
        || processRecord.outputAvailable
        || processRecord.outputConsumedAt === undefined
        || processRecord.outputConsumedAt > cutoff) continue;
      const revision = Math.max(1, processRecord.terminalRevision);
      const deliveryId = backgroundProcessDeliveryId(processRecord.processId, revision);
      const delivery = this.deliveryStore.get(deliveryId) ?? this.deliveries.get(deliveryId);
      if (!delivery || delivery.status === 'pending') continue;
      const receiptId = backgroundProcessExitReceiptId(processRecord.processId, revision);
      const outputPath = this.outputPath(processRecord);
      if (outputPath) unlinkWithRetrySync(outputPath, true);
      this.deliveryStore.remove(deliveryId);
      this.receiptStore.remove(receiptId);
      this.originStore.remove(backgroundProcessOriginLinkId(processRecord.processId));
      this.processStore.remove(processRecord.id);
      this.deliveries.delete(deliveryId);
      this.receipts.delete(receiptId);
      this.origins.delete(processRecord.processId);
      this.processes.delete(processRecord.id);
      this.outputs.delete(processRecord.id);
      removed += 1;
    }
    if (removed > 0) this.emitSnapshot();
    return removed;
  }

  /** 在 data-root 切换前终止并持久化当前实例拥有的进程，但保留 capability 可恢复使用。 */
  public quiesce(): void {
    if (this.disposed) return;
    this.quiesceOwnedProcesses('数据根切换前已停止后台进程。', true);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.quiesceOwnedProcesses('扩展关闭或重启后无法继续持有后台进程，已标记为异常终止。', false);
    this.snapshotListeners.clear();
    this.deliveryListeners.clear();
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('BackgroundProcessManager is disposed.');
  }

  private generateProcessId(): string {
    for (;;) {
      const id = `bg_${this.now().toString(36)}_${randomBytes(4).toString('hex')}`;
      if (!this.processes.has(id) && !this.processStore.get(id)) return id;
    }
  }

  private ensureLoaded(): void {
    const paths = this.options.paths?.();
    if (!paths) return;
    const storageIdentity = backgroundProcessStorageIdentity(paths);
    if (this.loadedStorageIdentity === storageIdentity) {
      this.flushDirtyHandles();
      return;
    }
    if (this.handles.size > 0) {
      throw new Error('Cannot switch background-process storage roots while local processes are still owned.');
    }

    // A storage-root handoff is a hard projection boundary. Persisted rows from the previous root
    // must never be overlaid onto the new root, even when the same manager object is reused.
    this.processes.clear();
    this.origins.clear();
    this.receipts.clear();
    this.deliveries.clear();
    this.outputs.clear();
    this.emittedDeliveryWakeIds.clear();
    for (const record of this.processStore.list()) this.processes.set(record.id, record);
    for (const record of this.originStore.list()) this.origins.set(record.processId, record);
    for (const record of this.receiptStore.list()) this.receipts.set(record.id, record);
    for (const record of this.deliveryStore.list()) this.deliveries.set(record.id, record);
    this.loadedStorageIdentity = storageIdentity;

    for (const record of [...this.processes.values()]) {
      if (record.status === 'running' && !this.isActiveExternalOwner(record) && !this.handles.has(record.id)) this.reconcileOrphanedProcess(record);
      else if (record.status !== 'running') this.ensureTerminalFacts(record, this.outputForTerminalFacts(record));
    }
    this.flushDirtyHandles();
    this.collectLoadedGarbage();
  }

  private refreshPersistedProcess(processId: string): PersistedBackgroundProcessRecord | undefined {
    const refreshed = this.processStore.get(processId);
    if (!refreshed) return this.processes.get(processId);
    this.processes.set(processId, refreshed);
    if (refreshed.status === 'running' && !this.isActiveExternalOwner(refreshed) && !this.handles.has(processId)) this.reconcileOrphanedProcess(refreshed);
    return this.processes.get(processId);
  }

  private reconcileOrphanedProcess(record: PersistedBackgroundProcessRecord, emitSnapshot = true): void {
    if (record.status !== 'running') return;
    const now = this.now();
    const revision = Math.max(1, record.terminalRevision);
    const recoveredReceipt = this.receiptStore.get(backgroundProcessExitReceiptId(record.processId, revision));
    const reason = recoveredReceipt
      ? undefined
      : '后台进程持有者已停止、心跳超时或进程不可达，已标记为异常终止。';
    const output = this.outputForTerminalFacts(record);
    const nextOutput = reason
      ? { ...output, stderr: appendLine(output.stderr, `[LimCode] ${reason}`), updatedAt: now }
      : output;
    const next: PersistedBackgroundProcessRecord = {
      ...record,
      storageRevision: record.storageRevision + 1,
      ownerInstanceId: this.ownerInstanceId,
      ownerPid: process.pid,
      heartbeatAt: now,
      status: recoveredReceipt?.status ?? 'abnormal',
      exitCode: recoveredReceipt?.exitCode ?? 1,
      killed: recoveredReceipt?.killed ?? false,
      exitedAt: recoveredReceipt?.exitedAt ?? now,
      updatedAt: now,
      terminalRevision: revision,
      stderrChars: nextOutput.stderr.length,
      droppedChars: nextOutput.droppedStdoutChars + nextOutput.droppedStderrChars,
      ...(reason ? { abnormalReason: reason } : {})
    };
    const committed = this.processStore.compareAndSwap(
      next,
      (current) => current?.status === 'running'
        && current.ownerInstanceId === record.ownerInstanceId
        && current.storageRevision === record.storageRevision,
      () => {
        if (next.outputAvailable) this.writeOutput(next, nextOutput);
      }
    );
    if (!committed.written) {
      if (committed.current) this.processes.set(committed.current.id, committed.current);
      return;
    }
    this.processes.set(next.id, next);
    this.outputs.set(next.id, nextOutput);
    this.ensureTerminalFacts(next, nextOutput);
    if (emitSnapshot) this.emitSnapshot();
  }

  private finalize(processId: string, exitCode: number, status: Exclude<BackgroundProcessStatus, 'running'>, abnormalReason?: string): void {
    const handle = this.handles.get(processId);
    if (!handle || handle.process.status !== 'running') return;
    this.finalizeHandle(handle, exitCode, status, abnormalReason, true, false);
  }

  private finalizeHandle(
    handle: ManagedBackgroundProcessHandle,
    exitCode: number,
    status: Exclude<BackgroundProcessStatus, 'running'>,
    abnormalReason: string | undefined,
    emitWake: boolean,
    throwOnPersistenceFailure: boolean
  ): void {
    if (handle.process.status !== 'running') return;
    this.stopTimers(handle);
    const now = this.now();
    this.refreshOutputMetadata(handle);
    handle.process = {
      ...handle.process,
      status,
      exitCode,
      killed: status === 'killed',
      exitedAt: now,
      updatedAt: now,
      heartbeatAt: now,
      terminalRevision: 1,
      ...(abnormalReason ? { abnormalReason } : {})
    };
    handle.dirty = true;
    this.processes.set(handle.process.id, handle.process);
    const persisted = this.persistHandle(handle, throwOnPersistenceFailure);
    if (persisted && emitWake) this.emitDeliveryWakeForProcess(handle.process.id);
    this.emitSnapshot();
  }

  private refreshOutputMetadata(handle: ManagedBackgroundProcessHandle): void {
    const stdout = handle.stdout.snapshot();
    const stderr = handle.stderr.snapshot();
    const now = this.now();
    handle.process = {
      ...handle.process,
      stdoutChars: stdout.text.length,
      stderrChars: stderr.text.length,
      droppedChars: stdout.dropped + stderr.dropped,
      updatedAt: now,
      heartbeatAt: handle.process.status === 'running' ? now : handle.process.heartbeatAt
    };
    this.processes.set(handle.process.id, handle.process);
    this.outputs.set(handle.process.id, outputRecordFromSnapshots(handle.process, stdout, stderr, now));
  }

  private persistHandle(handle: ManagedBackgroundProcessHandle, throwOnFailure: boolean): boolean {
    try {
      if (!this.options.paths?.()) throw new Error('Background-process storage paths are unavailable.');
      const expectedRevision = handle.persistedRevision;
      this.refreshOutputMetadata(handle);
      const nextProcess: PersistedBackgroundProcessRecord = {
        ...handle.process,
        storageRevision: expectedRevision + 1
      };
      const output = this.outputs.get(handle.process.id) ?? outputRecordFromHandle(handle, this.now());
      const committed = this.processStore.compareAndSwap(
        nextProcess,
        (current) => expectedRevision === 0
          ? current === undefined
          : current?.ownerInstanceId === this.ownerInstanceId && current.storageRevision === expectedRevision,
        () => {
          if (nextProcess.outputAvailable) this.writeOutput(nextProcess, output);
        }
      );
      if (!committed.written) {
        if (!committed.current) throw new Error(`BackgroundProcess record disappeared during fenced update: ${handle.process.id}`);
        this.fenceLostHandle(handle, committed.current);
        return false;
      }

      handle.process = nextProcess;
      handle.persistedRevision = nextProcess.storageRevision;
      this.processes.set(nextProcess.id, nextProcess);
      const origin = this.origins.get(nextProcess.id);
      if (origin) this.originStore.insertImmutable(origin, sameOriginLink);
      if (nextProcess.status !== 'running') this.ensureTerminalFacts(nextProcess, output);
      handle.dirty = false;
      if (handle.persistTimer) clearTimeout(handle.persistTimer);
      handle.persistTimer = undefined;
      return true;
    } catch (error) {
      handle.dirty = true;
      this.schedulePersist(handle, PERSIST_RETRY_MS);
      if (throwOnFailure) throw error;
      console.warn(`[LimCode] Failed to persist BackgroundProcess ${handle.process.id}; retry scheduled.`, error);
      return false;
    }
  }

  private fenceLostHandle(handle: ManagedBackgroundProcessHandle, current: PersistedBackgroundProcessRecord): void {
    this.stopTimers(handle);
    if (handle.process.status === 'running') {
      try { handle.kill(); } catch { /* the newer persisted owner/state remains authoritative */ }
    }
    this.handles.delete(handle.process.id);
    this.processes.set(current.id, current);
    this.outputs.delete(current.id);
  }

  private hasTerminalFacts(processRecord: PersistedBackgroundProcessRecord): boolean {
    if (processRecord.status === 'running') return false;
    const revision = Math.max(1, processRecord.terminalRevision);
    return this.receipts.has(backgroundProcessExitReceiptId(processRecord.processId, revision))
      && this.deliveries.has(backgroundProcessDeliveryId(processRecord.processId, revision));
  }

  private ensureTerminalFacts(processRecord: PersistedBackgroundProcessRecord, output: BackgroundProcessOutputRecord): void {
    if (processRecord.status === 'running') return;
    const revision = Math.max(1, processRecord.terminalRevision);
    const receiptId = backgroundProcessExitReceiptId(processRecord.processId, revision);
    let receipt = this.receipts.get(receiptId) ?? this.receiptStore.get(receiptId);
    if (!receipt) {
      const createdAt = processRecord.exitedAt ?? processRecord.updatedAt;
      const proposed: BackgroundProcessExitReceiptRecord = {
        id: receiptId,
        backgroundProcessId: processRecord.id,
        processId: processRecord.processId,
        terminalRevision: revision,
        status: processRecord.status,
        exitCode: processRecord.exitCode ?? 1,
        killed: processRecord.killed,
        exitedAt: processRecord.exitedAt ?? createdAt,
        command: processRecord.command,
        cwd: processRecord.cwd,
        stdoutTail: tail(output.stdout, EXIT_NOTIFICATION_TAIL_CHARS),
        stderrTail: tail(output.stderr, EXIT_NOTIFICATION_TAIL_CHARS),
        droppedChars: output.droppedStdoutChars + output.droppedStderrChars,
        outputRecordId: output.id,
        createdAt
      };
      receipt = this.receiptStore.insertImmutable(proposed, sameExitReceipt);
    }
    assertReceiptMatchesProcess(receipt, processRecord, revision);
    this.receipts.set(receipt.id, receipt);

    const deliveryId = backgroundProcessDeliveryId(processRecord.processId, revision);
    let delivery = this.deliveries.get(deliveryId) ?? this.deliveryStore.get(deliveryId);
    if (!delivery) {
      const createdAt = receipt.createdAt;
      const proposed: BackgroundProcessNotificationDeliveryRecord = {
        id: deliveryId,
        receiptId: receipt.id,
        backgroundProcessId: processRecord.id,
        processId: processRecord.processId,
        terminalRevision: revision,
        sourceKey: backgroundProcessDeliverySourceKey(processRecord.processId, revision),
        status: processRecord.status === 'killed' ? 'stale' : 'pending',
        rowVersion: 1,
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt,
        ...(processRecord.status === 'killed' ? { staleAt: createdAt, staleReason: 'background_process_killed_explicitly' } : {})
      };
      const inserted = this.deliveryStore.compareAndSwap(proposed, (current) => current === undefined);
      delivery = inserted.written ? proposed : inserted.current;
      if (!delivery) throw new Error(`BackgroundProcess delivery insert lost its current record: ${deliveryId}`);
    }
    if (delivery.receiptId !== receipt.id
      || delivery.processId !== processRecord.processId
      || delivery.terminalRevision !== revision
      || delivery.sourceKey !== backgroundProcessDeliverySourceKey(processRecord.processId, revision)) {
      throw new Error(`BackgroundProcess delivery identity conflict: ${delivery.id}`);
    }
    this.deliveries.set(delivery.id, delivery);
    if (delivery.status === 'pending' && !this.disposed) this.emitDeliveryWakeForProcess(processRecord.id);
  }

  private schedulePersist(handle: ManagedBackgroundProcessHandle, delayMs: number): void {
    if (handle.persistTimer || this.disposed) return;
    handle.persistTimer = setTimeout(() => {
      handle.persistTimer = undefined;
      const persisted = this.persistHandle(handle, false);
      if (persisted && handle.process.status !== 'running') this.emitDeliveryWakeForProcess(handle.process.id);
      this.emitSnapshot();
    }, delayMs);
    handle.persistTimer.unref?.();
  }

  private startHeartbeat(handle: ManagedBackgroundProcessHandle): void {
    handle.heartbeatTimer = setInterval(() => {
      if (handle.process.status !== 'running' || this.disposed) return;
      handle.process = { ...handle.process, heartbeatAt: this.now(), updatedAt: this.now() };
      handle.dirty = true;
      this.persistHandle(handle, false);
    }, OWNER_HEARTBEAT_INTERVAL_MS);
    handle.heartbeatTimer.unref?.();
  }

  private stopTimers(handle: ManagedBackgroundProcessHandle): void {
    if (handle.persistTimer) clearTimeout(handle.persistTimer);
    if (handle.heartbeatTimer) clearInterval(handle.heartbeatTimer);
    handle.persistTimer = undefined;
    handle.heartbeatTimer = undefined;
  }

  private flushDirtyHandles(): void {
    for (const handle of this.handles.values()) if (handle.dirty) this.persistHandle(handle, false);
  }

  private consumeOutput(processRecord: PersistedBackgroundProcessRecord): void {
    const now = this.now();
    const next = {
      ...processRecord,
      storageRevision: processRecord.storageRevision + 1,
      outputAvailable: false,
      outputConsumedAt: now,
      updatedAt: now
    };
    const committed = this.processStore.compareAndSwap(next, (current) => !!current
      && current.status !== 'running'
      && current.ownerInstanceId === processRecord.ownerInstanceId
      && current.storageRevision === processRecord.storageRevision
      && current.outputAvailable);
    if (!committed.written) {
      if (committed.current) this.processes.set(committed.current.id, committed.current);
      return;
    }
    const outputPath = this.outputPath(processRecord);
    if (outputPath) unlinkWithRetrySync(outputPath, true);
    this.processes.set(next.id, next);
    this.outputs.delete(next.id);
    const handle = this.handles.get(next.id);
    if (handle) {
      this.stopTimers(handle);
      this.handles.delete(next.id);
    }
    this.emitSnapshot();
  }

  private outputForTerminalFacts(processRecord: PersistedBackgroundProcessRecord): BackgroundProcessOutputRecord {
    return processRecord.outputAvailable
      ? this.loadOutput(processRecord)
      : emptyOutput(processRecord, processRecord.updatedAt);
  }

  private quiesceOwnedProcesses(reason: string, throwOnPersistenceFailure: boolean): void {
    for (const handle of this.handles.values()) {
      this.stopTimers(handle);
      if (handle.process.status === 'running') {
        appendDiagnostic(handle.stderr, reason);
        try { handle.kill(); } catch { /* terminal fact still wins */ }
        this.finalizeHandle(handle, 1, 'abnormal', reason, false, throwOnPersistenceFailure);
      } else {
        this.persistHandle(handle, throwOnPersistenceFailure);
      }
    }
    this.handles.clear();
    this.emitSnapshot();
  }

  private loadOutput(processRecord: PersistedBackgroundProcessRecord): BackgroundProcessOutputRecord {
    const cached = this.outputs.get(processRecord.id);
    if (cached) return cached;
    const filePath = this.outputPath(processRecord);
    if (!filePath) throw new Error('Background-process output storage paths are unavailable.');
    const result = readJsonFileStrictSync<unknown>(filePath);
    if (result.status !== 'ok'
      || !isBackgroundProcessOutputRecord(result.value)
      || result.value.id !== backgroundProcessOutputRecordId(processRecord.processId)
      || result.value.backgroundProcessId !== processRecord.id
      || result.value.processId !== processRecord.processId) {
      throw new Error(`Invalid or unavailable BackgroundProcess output ${processRecord.id}: ${filePath}`);
    }
    this.outputs.set(processRecord.id, result.value);
    return result.value;
  }

  private writeOutput(processRecord: PersistedBackgroundProcessRecord, output: BackgroundProcessOutputRecord): void {
    const filePath = this.outputPath(processRecord);
    if (!filePath) throw new Error('Background-process output storage paths are unavailable.');
    writeJsonFileAtomicSync(filePath, output);
    this.outputs.set(processRecord.id, output);
  }

  private outputPath(processRecord: PersistedBackgroundProcessRecord): string | undefined {
    const paths = this.options.paths?.();
    return paths ? path.join(paths.backgroundProcessesRootPath, OUTPUTS_DIR, processRecord.outputFile) : undefined;
  }

  private collectLoadedGarbage(): void {
    const cutoff = this.now() - CONSUMED_PROCESS_RETENTION_MS;
    for (const processRecord of [...this.processes.values()]) {
      if (processRecord.status === 'running'
        || processRecord.outputAvailable
        || processRecord.outputConsumedAt === undefined
        || processRecord.outputConsumedAt > cutoff) continue;
      const revision = Math.max(1, processRecord.terminalRevision);
      const deliveryId = backgroundProcessDeliveryId(processRecord.processId, revision);
      const delivery = this.deliveries.get(deliveryId);
      if (!delivery || delivery.status === 'pending') continue;
      const outputPath = this.outputPath(processRecord);
      if (outputPath) unlinkWithRetrySync(outputPath, true);
      this.deliveryStore.remove(deliveryId);
      this.receiptStore.remove(backgroundProcessExitReceiptId(processRecord.processId, revision));
      this.originStore.remove(backgroundProcessOriginLinkId(processRecord.processId));
      this.processStore.remove(processRecord.id);
      this.deliveries.delete(deliveryId);
      this.receipts.delete(backgroundProcessExitReceiptId(processRecord.processId, revision));
      this.origins.delete(processRecord.processId);
      this.processes.delete(processRecord.id);
      this.outputs.delete(processRecord.id);
    }
  }

  private refreshProjectionRecords(): boolean {
    if (!this.loadedStorageIdentity) return false;
    const before = projectionSignature(this.processes, this.origins);
    const persistedProcesses = this.processStore.list();
    const persistedOrigins = this.originStore.list();
    const nextProcesses = new Map(persistedProcesses.map((record) => [record.id, record]));

    // Local handles may contain output metadata newer than their debounced persisted projection.
    for (const [processId, handle] of this.handles) nextProcesses.set(processId, handle.process);
    this.processes.clear();
    for (const [processId, record] of nextProcesses) this.processes.set(processId, record);
    this.origins.clear();
    for (const record of persistedOrigins) this.origins.set(record.processId, record);

    for (const cachedProcessId of [...this.outputs.keys()]) {
      if (!this.processes.has(cachedProcessId)) this.outputs.delete(cachedProcessId);
    }
    for (const record of [...this.processes.values()]) {
      if (record.status === 'running' && !this.handles.has(record.id) && !this.isActiveExternalOwner(record)) {
        this.reconcileOrphanedProcess(record, false);
      } else if (record.status !== 'running' && !this.hasTerminalFacts(record)) {
        this.ensureTerminalFacts(record, this.outputForTerminalFacts(record));
      }
    }
    return before !== projectionSignature(this.processes, this.origins);
  }

  private refreshDeliveryRecords(): void {
    const records = this.deliveryStore.list();
    this.deliveries.clear();
    for (const record of records) this.deliveries.set(record.id, record);
  }

  private updateDelivery(
    deliveryId: string,
    accept: (delivery: BackgroundProcessNotificationDeliveryRecord) => boolean,
    update: (delivery: BackgroundProcessNotificationDeliveryRecord, now: number) => BackgroundProcessNotificationDeliveryRecord
  ): BackgroundProcessNotificationDeliveryRecord | undefined {
    for (let retry = 0; retry < DELIVERY_CAS_MAX_RETRIES; retry += 1) {
      const current = this.deliveryStore.get(deliveryId);
      if (!current) {
        this.deliveries.delete(deliveryId);
        return undefined;
      }
      this.deliveries.set(current.id, current);
      if (!accept(current)) return { ...current };

      const proposed = update(current, this.now());
      const next: BackgroundProcessNotificationDeliveryRecord = {
        ...proposed,
        id: current.id,
        receiptId: current.receiptId,
        backgroundProcessId: current.backgroundProcessId,
        processId: current.processId,
        terminalRevision: current.terminalRevision,
        sourceKey: current.sourceKey,
        createdAt: current.createdAt,
        rowVersion: current.rowVersion + 1
      };
      const committed = this.deliveryStore.compareAndSwap(
        next,
        (candidate) => !!candidate
          && candidate.rowVersion === current.rowVersion
          && accept(candidate)
      );
      if (committed.written) {
        this.deliveries.set(next.id, next);
        return { ...next };
      }
      if (committed.current) this.deliveries.set(committed.current.id, committed.current);
    }
    throw new Error(`BackgroundProcess delivery CAS contention exceeded ${DELIVERY_CAS_MAX_RETRIES} retries: ${deliveryId}`);
  }

  private emitSnapshot(): void {
    if (this.disposed || this.snapshotListeners.size === 0) return;
    const snapshot: BackgroundProcessSnapshot = {
      processes: [...this.processes.values()].map(publicProcessRecord).sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id)),
      originLinks: [...this.origins.values()].map((record) => ({ ...record })).sort((a, b) => a.id.localeCompare(b.id))
    };
    for (const listener of this.snapshotListeners) {
      try { listener(snapshot); } catch (error) { console.warn('[LimCode] BackgroundProcess snapshot listener failed.', error); }
    }
  }

  private emitDeliveryWakeForProcess(processId: string): void {
    const processRecord = this.processes.get(processId);
    if (!processRecord || processRecord.status === 'running') return;
    const deliveryId = backgroundProcessDeliveryId(processId, Math.max(1, processRecord.terminalRevision));
    const delivery = this.deliveries.get(deliveryId);
    if (!delivery || delivery.status !== 'pending' || this.emittedDeliveryWakeIds.has(deliveryId) || this.disposed) return;
    this.emittedDeliveryWakeIds.add(deliveryId);
    for (const listener of this.deliveryListeners) {
      try { listener(); } catch (error) { console.warn('[LimCode] BackgroundProcess delivery listener failed.', error); }
    }
  }

  private isActiveExternalOwner(record: PersistedBackgroundProcessRecord): boolean {
    if (record.status !== 'running' || record.ownerInstanceId === this.ownerInstanceId) return false;
    if (this.now() - record.heartbeatAt > OWNER_HEARTBEAT_TIMEOUT_MS) return false;
    return isProcessAlive(record.ownerPid);
  }
}

function locationsFor(provider: BackgroundProcessPathsProvider | undefined, kind: 'process' | 'origin' | 'receipt' | 'delivery'): SyncRecordStoreLocations | undefined {
  const paths = provider?.();
  if (!paths) return undefined;
  switch (kind) {
    case 'process': return { rootPath: paths.backgroundProcessesRootPath, indexPath: paths.backgroundProcessesIndexPath };
    case 'origin': return { rootPath: paths.backgroundProcessOriginLinksRootPath, indexPath: paths.backgroundProcessOriginLinksIndexPath };
    case 'receipt': return { rootPath: paths.backgroundProcessExitReceiptsRootPath, indexPath: paths.backgroundProcessExitReceiptsIndexPath };
    case 'delivery': return { rootPath: paths.backgroundProcessNotificationDeliveriesRootPath, indexPath: paths.backgroundProcessNotificationDeliveriesIndexPath };
  }
}

function backgroundProcessStorageIdentity(paths: BackgroundProcessPaths): string {
  return [
    paths.backgroundProcessesRootPath,
    paths.backgroundProcessesIndexPath,
    paths.backgroundProcessOriginLinksRootPath,
    paths.backgroundProcessOriginLinksIndexPath,
    paths.backgroundProcessExitReceiptsRootPath,
    paths.backgroundProcessExitReceiptsIndexPath,
    paths.backgroundProcessNotificationDeliveriesRootPath,
    paths.backgroundProcessNotificationDeliveriesIndexPath
  ].join('\u0000');
}

function publicProcessRecord(record: PersistedBackgroundProcessRecord): BackgroundProcessRecord {
  const { version: _version, storageRevision: _storageRevision, ownerInstanceId: _ownerInstanceId, ownerPid: _ownerPid, heartbeatAt: _heartbeatAt, outputFile: _outputFile, ...publicRecord } = record;
  return { ...publicRecord };
}

function projectionSignature(
  processes: ReadonlyMap<string, PersistedBackgroundProcessRecord>,
  origins: ReadonlyMap<string, BackgroundProcessOriginLinkRecord>
): string {
  return JSON.stringify({
    processes: [...processes.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => {
        const { updatedAt: _heartbeatOnlyUpdatedAt, ...projection } = publicProcessRecord(record);
        return projection;
      }),
    origins: [...origins.values()].sort((a, b) => a.id.localeCompare(b.id))
  });
}

function outputRecordFromHandle(handle: ManagedBackgroundProcessHandle, now: number): BackgroundProcessOutputRecord {
  return outputRecordFromSnapshots(handle.process, handle.stdout.snapshot(), handle.stderr.snapshot(), now);
}

function outputRecordFromSnapshots(
  processRecord: PersistedBackgroundProcessRecord,
  stdout: OutputBufferSnapshot,
  stderr: OutputBufferSnapshot,
  now: number
): BackgroundProcessOutputRecord {
  return {
    id: backgroundProcessOutputRecordId(processRecord.processId),
    backgroundProcessId: processRecord.id,
    processId: processRecord.processId,
    stdout: stdout.text,
    stderr: stderr.text,
    droppedStdoutChars: stdout.dropped,
    droppedStderrChars: stderr.dropped,
    updatedAt: now
  };
}

function emptyOutput(processRecord: PersistedBackgroundProcessRecord, now: number): BackgroundProcessOutputRecord {
  return {
    id: backgroundProcessOutputRecordId(processRecord.processId),
    backgroundProcessId: processRecord.id,
    processId: processRecord.processId,
    stdout: '',
    stderr: '',
    droppedStdoutChars: 0,
    droppedStderrChars: 0,
    updatedAt: now
  };
}

function commandResultFromRecords(processRecord: PersistedBackgroundProcessRecord, output: BackgroundProcessOutputRecord, limits: CommandOutputLimits): CommandRunResult {
  return {
    command: processRecord.command,
    exitCode: processRecord.exitCode ?? 0,
    killed: processRecord.killed,
    status: processRecord.status === 'abnormal' ? 'exited' : processRecord.status,
    processId: processRecord.processId,
    running: processRecord.status === 'running',
    stdout: truncateOutput(output.stdout, limits),
    stderr: truncateOutput(output.stderr, limits),
    ...((output.droppedStdoutChars + output.droppedStderrChars) > 0
      ? { droppedChars: output.droppedStdoutChars + output.droppedStderrChars }
      : {})
  };
}

function notFoundResult(processId: string): CommandRunResult {
  return {
    command: '',
    exitCode: 1,
    killed: false,
    status: 'not_found',
    processId,
    running: false,
    stdout: '',
    stderr: `未找到后台进程日志：${processId}（可能已被显式消费或从未存在）。`
  };
}

function truncateOutput(text: string, limits: CommandOutputLimits): string {
  if (!text) return text;
  let output = text;
  if (limits.maxOutputLines > 0) {
    const lines = output.split('\n');
    if (lines.length > limits.maxOutputLines) {
      const omitted = lines.length - limits.maxOutputLines;
      output = `... (共 ${lines.length} 行，已省略前 ${omitted} 行) ...\n${lines.slice(-limits.maxOutputLines).join('\n')}`;
    }
  }
  if (limits.maxOutputChars > 0 && output.length > limits.maxOutputChars) {
    output = `... (已按 ${limits.maxOutputChars} 字符上限截断) ...\n${output.slice(-limits.maxOutputChars)}`;
  }
  return output;
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

function appendLine(text: string, line: string): string {
  return text ? `${text}\n${line}` : line;
}

function appendDiagnostic(buffer: BackgroundProcessOutputBuffer, reason: string): void {
  const current = buffer.snapshot().text;
  buffer.append(`${current ? '\n' : ''}[LimCode] ${reason}`);
}

function samePublicProcessRecord(
  left: PersistedBackgroundProcessRecord | undefined,
  right: PersistedBackgroundProcessRecord
): boolean {
  return left !== undefined && JSON.stringify(publicProcessRecord(left)) === JSON.stringify(publicProcessRecord(right));
}

function sameOriginLinkOptional(
  left: BackgroundProcessOriginLinkRecord | undefined,
  right: BackgroundProcessOriginLinkRecord
): boolean {
  return left !== undefined && sameOriginLink(left, right);
}

function sameOriginLink(left: BackgroundProcessOriginLinkRecord, right: BackgroundProcessOriginLinkRecord): boolean {
  return left.id === right.id
    && left.backgroundProcessId === right.backgroundProcessId
    && left.processId === right.processId
    && left.sourceToolCallId === right.sourceToolCallId
    && left.sourceRunId === right.sourceRunId
    && left.conversationId === right.conversationId
    && left.sourceAttemptId === right.sourceAttemptId
    && left.sourceGeneration === right.sourceGeneration
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt;
}

function sameExitReceipt(left: BackgroundProcessExitReceiptRecord, right: BackgroundProcessExitReceiptRecord): boolean {
  return left.id === right.id
    && left.backgroundProcessId === right.backgroundProcessId
    && left.processId === right.processId
    && left.terminalRevision === right.terminalRevision
    && left.status === right.status
    && left.exitCode === right.exitCode
    && left.killed === right.killed
    && left.exitedAt === right.exitedAt
    && left.command === right.command
    && left.cwd === right.cwd
    && left.stdoutTail === right.stdoutTail
    && left.stderrTail === right.stderrTail
    && left.droppedChars === right.droppedChars
    && left.outputRecordId === right.outputRecordId
    && left.createdAt === right.createdAt;
}

function assertReceiptMatchesProcess(
  receipt: BackgroundProcessExitReceiptRecord,
  processRecord: PersistedBackgroundProcessRecord,
  terminalRevision: number
): void {
  if (receipt.backgroundProcessId !== processRecord.id
    || receipt.processId !== processRecord.processId
    || receipt.terminalRevision !== terminalRevision
    || receipt.status !== processRecord.status
    || receipt.exitCode !== (processRecord.exitCode ?? 1)
    || receipt.killed !== processRecord.killed
    || receipt.exitedAt !== processRecord.exitedAt
    || receipt.command !== processRecord.command
    || receipt.cwd !== processRecord.cwd
    || receipt.outputRecordId !== backgroundProcessOutputRecordId(processRecord.processId)) {
    throw new Error(`Immutable BackgroundProcess exit receipt conflicts with Process state: ${receipt.id}`);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function isPersistedBackgroundProcessRecord(value: unknown): value is PersistedBackgroundProcessRecord {
  const record = asRecord(value);
  return !!record
    && record.version === STORAGE_VERSION
    && typeof record.storageRevision === 'number'
    && Number.isSafeInteger(record.storageRevision)
    && record.storageRevision > 0
    && typeof record.id === 'string'
    && record.id === record.processId
    && typeof record.processId === 'string'
    && (record.pid === undefined || (typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0))
    && (record.toolName === 'shell' || record.toolName === 'bash')
    && typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && isBackgroundProcessStatus(record.status)
    && (record.exitCode === null || (typeof record.exitCode === 'number' && Number.isSafeInteger(record.exitCode)))
    && typeof record.killed === 'boolean'
    && finiteNumber(record.startedAt)
    && finiteNumber(record.backgroundedAt)
    && finiteNumber(record.updatedAt)
    && (record.exitedAt === undefined || finiteNumber(record.exitedAt))
    && typeof record.terminalRevision === 'number'
    && Number.isSafeInteger(record.terminalRevision)
    && record.terminalRevision >= 0
    && nonNegativeSafeInteger(record.stdoutChars)
    && nonNegativeSafeInteger(record.stderrChars)
    && nonNegativeSafeInteger(record.droppedChars)
    && typeof record.outputAvailable === 'boolean'
    && (record.outputConsumedAt === undefined || finiteNumber(record.outputConsumedAt))
    && (record.abnormalReason === undefined || typeof record.abnormalReason === 'string')
    && typeof record.ownerInstanceId === 'string'
    && typeof record.ownerPid === 'number'
    && Number.isSafeInteger(record.ownerPid)
    && record.ownerPid > 0
    && finiteNumber(record.heartbeatAt)
    && typeof record.outputFile === 'string'
    && !!record.outputFile
    && !record.outputFile.includes('/')
    && !record.outputFile.includes('\\')
    && validProcessLifecycle(record);
}

function isBackgroundProcessOutputRecord(value: unknown): value is BackgroundProcessOutputRecord {
  const record = asRecord(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.backgroundProcessId === 'string'
    && typeof record.processId === 'string'
    && record.backgroundProcessId === record.processId
    && record.id === backgroundProcessOutputRecordId(record.processId)
    && typeof record.stdout === 'string'
    && typeof record.stderr === 'string'
    && nonNegativeSafeInteger(record.droppedStdoutChars)
    && nonNegativeSafeInteger(record.droppedStderrChars)
    && finiteNumber(record.updatedAt);
}

function isBackgroundProcessOriginLinkRecord(value: unknown): value is BackgroundProcessOriginLinkRecord {
  const record = asRecord(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.backgroundProcessId === 'string'
    && typeof record.processId === 'string'
    && record.backgroundProcessId === record.processId
    && record.id === backgroundProcessOriginLinkId(record.processId)
    && typeof record.sourceToolCallId === 'string'
    && typeof record.sourceRunId === 'string'
    && typeof record.conversationId === 'string'
    && typeof record.sourceAttemptId === 'string'
    && typeof record.sourceGeneration === 'number'
    && Number.isSafeInteger(record.sourceGeneration)
    && record.sourceGeneration >= 0
    && finiteNumber(record.createdAt)
    && finiteNumber(record.updatedAt);
}

function isBackgroundProcessExitReceiptRecord(value: unknown): value is BackgroundProcessExitReceiptRecord {
  const record = asRecord(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.backgroundProcessId === 'string'
    && typeof record.processId === 'string'
    && record.backgroundProcessId === record.processId
    && typeof record.terminalRevision === 'number'
    && Number.isSafeInteger(record.terminalRevision)
    && record.terminalRevision > 0
    && record.id === backgroundProcessExitReceiptId(record.processId, record.terminalRevision)
    && (record.status === 'exited' || record.status === 'killed' || record.status === 'abnormal')
    && typeof record.exitCode === 'number'
    && Number.isSafeInteger(record.exitCode)
    && typeof record.killed === 'boolean'
    && record.killed === (record.status === 'killed')
    && finiteNumber(record.exitedAt)
    && typeof record.command === 'string'
    && typeof record.cwd === 'string'
    && typeof record.stdoutTail === 'string'
    && typeof record.stderrTail === 'string'
    && nonNegativeSafeInteger(record.droppedChars)
    && record.outputRecordId === backgroundProcessOutputRecordId(record.processId)
    && finiteNumber(record.createdAt);
}

function isBackgroundProcessNotificationDeliveryRecord(value: unknown): value is BackgroundProcessNotificationDeliveryRecord {
  const record = asRecord(value);
  return !!record
    && typeof record.id === 'string'
    && typeof record.receiptId === 'string'
    && typeof record.backgroundProcessId === 'string'
    && typeof record.processId === 'string'
    && record.backgroundProcessId === record.processId
    && typeof record.terminalRevision === 'number'
    && Number.isSafeInteger(record.terminalRevision)
    && record.terminalRevision > 0
    && record.id === backgroundProcessDeliveryId(record.processId, record.terminalRevision)
    && record.receiptId === backgroundProcessExitReceiptId(record.processId, record.terminalRevision)
    && record.sourceKey === backgroundProcessDeliverySourceKey(record.processId, record.terminalRevision)
    && (record.status === 'pending' || record.status === 'delivered' || record.status === 'stale')
    && typeof record.rowVersion === 'number'
    && Number.isSafeInteger(record.rowVersion)
    && record.rowVersion > 0
    && typeof record.attemptCount === 'number'
    && Number.isSafeInteger(record.attemptCount)
    && record.attemptCount >= 0
    && finiteNumber(record.createdAt)
    && finiteNumber(record.updatedAt)
    && (record.claimOwner === undefined || record.claimOwner === 'auto_delivery' || record.claimOwner === 'model_poll')
    && (record.claimedAt === undefined || finiteNumber(record.claimedAt))
    && (record.lastAttemptAt === undefined || finiteNumber(record.lastAttemptAt))
    && (record.deliveredAt === undefined || finiteNumber(record.deliveredAt))
    && (record.staleAt === undefined || finiteNumber(record.staleAt))
    && (record.staleReason === undefined || typeof record.staleReason === 'string')
    && (record.lastError === undefined || typeof record.lastError === 'string')
    && validDeliveryLifecycle(record);
}

function isBackgroundProcessStatus(value: unknown): value is BackgroundProcessStatus {
  return value === 'running' || value === 'exited' || value === 'killed' || value === 'abnormal';
}

function validProcessLifecycle(record: Record<string, unknown>): boolean {
  if (record.status === 'running') {
    return record.exitCode === null
      && record.killed === false
      && record.exitedAt === undefined
      && record.terminalRevision === 0
      && record.outputAvailable === true
      && record.outputConsumedAt === undefined;
  }
  return typeof record.exitCode === 'number'
    && Number.isSafeInteger(record.exitCode)
    && finiteNumber(record.exitedAt)
    && typeof record.terminalRevision === 'number'
    && Number.isSafeInteger(record.terminalRevision)
    && record.terminalRevision > 0
    && record.killed === (record.status === 'killed')
    && (record.outputAvailable === true || finiteNumber(record.outputConsumedAt));
}

function validDeliveryLifecycle(record: Record<string, unknown>): boolean {
  if (record.claimOwner === undefined && record.claimedAt !== undefined) return false;
  if (record.claimOwner !== undefined && !finiteNumber(record.claimedAt)) return false;
  if (record.status === 'pending') {
    return record.claimOwner !== 'model_poll'
      && record.deliveredAt === undefined
      && record.staleAt === undefined
      && record.staleReason === undefined;
  }
  if (record.status === 'delivered') {
    return record.claimOwner === 'auto_delivery'
      && finiteNumber(record.deliveredAt)
      && record.staleAt === undefined
      && record.staleReason === undefined;
  }
  return record.status === 'stale'
    && finiteNumber(record.staleAt)
    && typeof record.staleReason === 'string'
    && !!record.staleReason.trim()
    && record.deliveredAt === undefined;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

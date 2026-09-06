import { randomUUID } from 'node:crypto';
import {
  DEBUG_CAPTURE_LIMITS,
  normalizeDebugCaptureSettings,
  type DebugCaptureContext,
  type DebugCaptureManifest,
  type DebugCaptureSettings,
  type DebugCaptureStopReason,
  type DebugCaptureTarget
} from '../../../shared/debugCapture';

/** 实现阶段的端口；只有两条接收链路和文件保存均就绪，产品组合才可开放启停。 */
export interface DebugCaptureControllerPorts {
  ready(): boolean;
  validate(): Promise<void>;
  inventory(): Promise<{ runs: DebugCaptureManifest[]; totalBytes: number }>;
  begin(manifest: DebugCaptureManifest): Promise<void>;
  rememberCommand(runId: string, commandId: string): Promise<void>;
  seal(manifest: DebugCaptureManifest): Promise<void>;
  progress?(runId: string): DebugCaptureManifest | undefined;
  abandon?(): Promise<void>;
  source: DebugCaptureManifest['source'];
  now?: () => number;
  monotonicNow?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 仅决定观察活动的生命周期，不持有模型能力或聊天数据库。 */
export class DebugCaptureController {
  private active: DebugCaptureManifest | undefined;
  private startedMark = 0;
  private cancelTimer: (() => void) | undefined;
  private operations: Promise<unknown> = Promise.resolve();
  private closed = false;
  private accepting = false;
  private lastError: string | undefined;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  public constructor(private readonly ports: DebugCaptureControllerPorts) {
    this.now = ports.now ?? Date.now;
    this.monotonicNow = ports.monotonicNow ?? (() => performance.now());
  }

  public current(): DebugCaptureManifest | undefined {
    if (!this.active) return undefined;
    const snapshot = structuredClone(this.active);
    const saved = this.ports.progress?.(snapshot.runId);
    if (saved) for (const key of ['lastAcceptedSeq', 'durableSeq', 'payloadBytes', 'indexBytes', 'acceptedBytes', 'peakMemoryBytes', 'batches'] as const) snapshot[key] = saved[key];
    if (saved?.hasGaps) { snapshot.hasGaps = true; snapshot.gapReason = saved.gapReason ?? snapshot.gapReason; }
    if (snapshot.status !== 'sealed') snapshot.elapsedMs = this.elapsed();
    return snapshot;
  }

  public failure(): string | undefined {
    return this.lastError;
  }

  public activeId(context?: DebugCaptureContext): string | undefined {
    if (this.accepting && this.active && this.elapsed() >= this.active.maxDurationMs) {
      void this.stop(this.active.runId, 'time_limit').catch(() => undefined);
      return undefined;
    }
    if (!context) return this.accepting && this.active?.status === 'recording' ? this.active.runId : undefined;
    return this.accepts(context) ? this.active?.runId : undefined;
  }

  public interrupt(reason: DebugCaptureStopReason, detail?: string): void {
    if (!this.active || this.active.status === 'sealed') return;
    if (detail) { this.active.hasGaps = true; this.active.gapReason = detail; }
    void this.stop(this.active.runId, reason).catch(() => undefined);
  }

  public accepts(context: DebugCaptureContext): boolean {
    if (!this.accepting || !this.active || this.active.status !== 'recording') return false;
    if (this.elapsed() >= this.active.maxDurationMs) {
      void this.stop(this.active.runId, 'time_limit').catch(() => undefined);
      return false;
    }
    return this.active.target.scope === 'workspace'
      || context.conversationId === this.active.target.conversationId;
  }

  public start(input: {
    commandId: string;
    settings: DebugCaptureSettings;
    conversationId?: string;
  }): Promise<DebugCaptureManifest> {
    // 在排队前转成独立普通值，调用者随后切换页面或修改设置不会改动本次命令。
    const commandId = requireIdentifier(input.commandId, '开启命令编号');
    const settings = normalizeDebugCaptureSettings(input.settings);
    const target: DebugCaptureTarget = settings.scope === 'workspace'
      ? { scope: 'workspace' }
      : { scope: 'conversation', conversationId: requireIdentifier(input.conversationId, '目标对话编号') };
    return this.serialize(async () => {
      if (this.closed) throw new Error('取证控制器已经关闭。');
      if (!this.ports.ready()) throw new Error('取证接收链路尚未就绪，不能开启不完整的调试功能。');
      await this.ports.validate();
      const inventory = await this.ports.inventory();
      const previous = this.active && hasCommand(this.active, commandId)
        ? this.active
        : inventory.runs.find((run) => hasCommand(run, commandId));
      if (previous) {
        if (!sameTarget(previous.target, target)) throw new Error('同一开启命令不能更换取证目标。');
        return structuredClone(previous);
      }
      if (this.active && this.active.status !== 'sealed') {
        if (!sameTarget(this.active.target, target)) throw new Error('已有活动取证，请先停止再更换目标。');
        const aliases = [...this.active.commandAliases, commandId];
        // 控制命令也不能无限积累；清单与临时发布副本共同占用既有收尾预留。
        if (Buffer.byteLength(JSON.stringify({ ...this.active, commandAliases: aliases })) + 64 > DEBUG_CAPTURE_LIMITS.reserveBytes / 4) {
          throw new Error('取证控制记录已达到容量上限，未创建新记录；现有取证状态不变。');
        }
        await this.ports.rememberCommand(this.active.runId, commandId);
        this.active.commandAliases = aliases;
        return this.current()!;
      }
      const maxBytes = settings.maxMiB * 1_048_576;
      if (inventory.runs.length >= DEBUG_CAPTURE_LIMITS.maxRuns) {
        throw new Error('当前工作区已保留 16 份记录，请先手动清理。');
      }
      if (inventory.totalBytes + maxBytes > DEBUG_CAPTURE_LIMITS.totalBytes) {
        throw new Error(`取证空间不足：需要 ${maxBytes} 字节，剩余 ${Math.max(0, DEBUG_CAPTURE_LIMITS.totalBytes - inventory.totalBytes)} 字节。`);
      }
      const startedAt = new Date(this.now()).toISOString();
      const run: DebugCaptureManifest = {
        runId: `${startedAt.slice(0, 10).replace(/-/g, '')}-${startedAt.slice(11, 19).replace(/:/g, '')}-${startedAt.slice(20, 23)}-model-stream-${randomUUID().slice(0, 8)}`,
        commandId,
        commandAliases: [],
        target,
        maxBytes,
        maxDurationMs: settings.maxMinutes * 60_000,
        startedAt,
        status: 'recording',
        hasGaps: false,
        lastAcceptedSeq: 0,
        durableSeq: 0,
        payloadBytes: 0,
        indexBytes: 0,
        acceptedBytes: DEBUG_CAPTURE_LIMITS.reserveBytes,
        peakMemoryBytes: 0,
        batches: 0,
        elapsedMs: 0,
        source: structuredClone(this.ports.source)
      };
      const startedMark = this.monotonicNow();
      await this.ports.begin(structuredClone(run));
      this.active = run;
      this.startedMark = startedMark;
      if (this.closed) return this.sealActive(run.runId, 'host_closed');
      this.accepting = true;
      this.lastError = undefined;
      const schedule = this.ports.schedule ?? scheduleTimeout;
      this.cancelTimer = schedule(() => {
        void this.stop(run.runId, 'time_limit').catch(() => undefined);
      }, Math.max(0, run.maxDurationMs - this.elapsed()));
      return this.current()!;
    });
  }

  public stop(runIdInput: string, reason: DebugCaptureStopReason = 'user'): Promise<DebugCaptureManifest> {
    const runId = requireIdentifier(runIdInput, '取证编号');
    if (this.active?.runId === runId && this.active.status !== 'sealed') {
      this.accepting = false;
      this.active.status = 'stopping';
      this.cancelTimer?.();
      this.cancelTimer = undefined;
    }
    return this.serialize(() => this.sealActive(runId, reason));
  }

  public close(): Promise<void> {
    this.closed = true;
    this.accepting = false;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    return this.serialize(async () => {
      if (this.active && this.active.status !== 'sealed') await this.sealActive(this.active.runId, 'host_closed');
    });
  }

  private async sealActive(runId: string, reason: DebugCaptureStopReason): Promise<DebugCaptureManifest> {
    if (this.active?.runId !== runId) {
      await this.ports.validate();
      const old = (await this.ports.inventory()).runs.find((run) => run.runId === runId);
      if (old?.status === 'sealed') return structuredClone(old);
      throw new Error('取证编号已失效，未停止其他活动记录。');
    }
    const run = this.active;
    if (run.status === 'sealed') return structuredClone(run);
    this.accepting = false;
    run.status = 'stopping';
    run.elapsedMs = this.elapsed();
    run.stoppedAt = new Date(this.now()).toISOString();
    run.stopReason = reason;
    try {
      await this.ports.validate();
      await this.ports.seal({ ...structuredClone(run), status: 'sealed' });
      run.status = 'sealed';
    } catch (error) {
      await this.ports.abandon?.().catch(() => undefined);
      run.hasGaps = true;
      run.gapReason = error instanceof Error ? error.message : String(error);
      this.lastError = run.gapReason;
      // 内存可以结束；磁盘清单仍可能未封存，读取端必须独立识别异常中断。
      run.status = 'sealed';
      run.stopReason = 'write_failed';
      throw error;
    }
    return this.current()!;
  }

  private elapsed(): number {
    return Math.max(0, this.monotonicNow() - this.startedMark);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    this.operations = task.catch(() => undefined);
    return task;
  }
}

function sameTarget(left: DebugCaptureTarget, right: DebugCaptureTarget): boolean {
  return left.scope === right.scope && left.conversationId === right.conversationId;
}

function hasCommand(run: DebugCaptureManifest, commandId: string): boolean {
  return run.commandId === commandId || run.commandAliases.includes(commandId);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error(`${label}无效。`);
  return value.trim();
}

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

import { DEBUG_CAPTURE_UI_LIMITS, type DebugCaptureContext, type DebugCaptureManifest, type DebugCaptureSettings, type DebugCaptureState, type DebugCaptureSummary, type DebugCaptureUiBatch, type DebugCaptureUiAck } from '../../../shared/debugCapture';
import { boundedJsonBytes } from '../../../shared/debugCaptureEncoding';
import type { RootBinding } from '../contracts';
import type { RootAuthority } from '../rootAuthority';
import { DebugCaptureController } from './controller';
import { DebugCaptureFiles } from './files';
import { analyzeDebugCapture } from './analyzer';
import type { DebugCaptureInput, DebugCaptureRecorder } from './observer';

export class DebugCaptureService implements DebugCaptureRecorder {
  public readonly files: DebugCaptureFiles;
  public readonly controller: DebugCaptureController;
  private listener?: (state: DebugCaptureState) => void;
  private timer?: ReturnType<typeof setInterval>;
  private publishing = false;
  private uiRunId?: string;
  private readonly uiHeads = new Map<string, number>();
  public constructor(authority: Pick<RootAuthority, 'validate'>, binding: RootBinding, public readonly source: DebugCaptureManifest['source']) {
    this.files = new DebugCaptureFiles(authority, binding, (reason, detail) => this.controller.interrupt(reason, detail));
    this.controller = new DebugCaptureController({
      ready: () => Boolean(source.hostBootId), source, validate: async () => { await this.files.validate(); },
      inventory: () => this.files.inventory(), begin: run => this.files.begin(run),
      rememberCommand: (runId, commandId) => this.files.rememberCommand(runId, commandId),
      seal: run => this.files.seal(run), progress: runId => this.files.progress(runId), abandon: () => this.files.abandon()
    });
  }
  public active(context?: DebugCaptureContext): string | undefined { return this.controller.activeId(context); }
  public record(input: DebugCaptureInput) { return this.active(input.context) ? this.files.record(input) : undefined; }
  public setListener(listener: (state: DebugCaptureState) => void): void { this.listener = listener; }
  public async state(): Promise<DebugCaptureState> {
    const current = this.controller.current();
    try {
      const inventory = await this.files.inventory();
      return { runs: inventory.runs.map(summary), totalBytes: inventory.totalBytes, ...(current ? { active: summary(current) } : {}), directory: this.files.directory, ...(this.controller.failure() ? { error: this.controller.failure() } : {}) };
    } catch (error) {
      return { active: current ? summary(current) : undefined, runs: [], totalBytes: 0, directory: this.files.directory, error: error instanceof Error ? error.message : String(error) };
    }
  }
  public async start(input: { commandId: string; settings: DebugCaptureSettings; conversationId?: string }): Promise<void> {
    await this.controller.start(input);
    if (this.active() && !this.timer) { this.timer = setInterval(() => { void this.publish(); }, 1_000); this.timer.unref(); }
    await this.publish();
  }
  public async stop(runId: string): Promise<void> { await this.controller.stop(runId); await this.publish(); }
  public analyze(runId: string) { return analyzeDebugCapture(this.files, runId, this.source); }
  public observeUi(clientId: string, batch: DebugCaptureUiBatch): DebugCaptureUiAck {
    const ack: DebugCaptureUiAck = { runId: batch.runId, viewId: batch.viewId, batchSeq: batch.batchSeq, accepted: false };
    if (batch.runId !== this.active()) return ack;
    try {
      boundedJsonBytes(batch, DEBUG_CAPTURE_UI_LIMITS.batchBytes);
      if (typeof batch.viewId !== 'string' || !batch.viewId || batch.viewId.length > 256
        || !Number.isSafeInteger(batch.batchSeq) || batch.batchSeq < 1 || !Array.isArray(batch.events)
        || batch.events.length > DEBUG_CAPTURE_UI_LIMITS.events) throw new Error('界面取证批次无效。');
      if (this.uiRunId !== batch.runId) { this.uiRunId = batch.runId; this.uiHeads.clear(); }
      const key = `${clientId}:${batch.viewId}`;
      if (!this.uiHeads.has(key) && this.uiHeads.size >= 64) throw new Error('界面取证来源数量超过限制。');
      const head = this.uiHeads.get(key) ?? 0;
      if (batch.batchSeq <= head) return { ...ack, accepted: true };
      if (batch.batchSeq !== head + 1) throw new Error('界面取证批次缺失。');
      if (batch.gap) throw new Error(batch.gap.slice(0, 1000));
      for (const event of batch.events) {
        if (!['ui.frame', 'ui.tool_apply', 'ui.tool_baseline', 'ui.snapshot'].includes(event.stage)
          || typeof event.context?.conversationId !== 'string' || typeof event.context?.modelRequestId !== 'string'
          || !event.metadata || typeof event.metadata !== 'object' || typeof event.observedAt !== 'string'
          || Object.values(event.metadata).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('界面取证事件无效。');
        if (this.active(event.context) !== batch.runId) continue;
        this.record({ stage: event.stage, context: event.context, payload: event.payload,
          metadata: { ...event.metadata, clientId, viewId: batch.viewId, batchSeq: batch.batchSeq, clientObservedAt: event.observedAt } });
      }
      this.uiHeads.set(key, batch.batchSeq);
      return { ...ack, accepted: this.active() === batch.runId };
    } catch (error) {
      this.controller.interrupt('memory_limit', `界面取证不完整：${error instanceof Error ? error.message : String(error)}`);
      return ack;
    }
  }
  public async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    try { await this.controller.close(); } finally { await this.files.abandon(); }
  }
  private async publish(): Promise<void> {
    if (this.publishing) return; this.publishing = true;
    try {
      const state = await this.state(); this.listener?.(state);
      if (!this.active() && state.active?.status === 'sealed' && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    } catch { /* 界面失联不会改变模型或文件保存。 */ }
    finally { this.publishing = false; }
  }
}

function summary(run: DebugCaptureManifest): DebugCaptureSummary {
  const { source: _source, commandId: _commandId, commandAliases: _commandAliases, ...visible } = run;
  return visible;
}

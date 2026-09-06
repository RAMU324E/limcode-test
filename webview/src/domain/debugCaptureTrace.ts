import { DEBUG_CAPTURE_UI_LIMITS, type DebugCaptureContext, type DebugCaptureSummary, type DebugCaptureUiAck, type DebugCaptureUiBatch, type DebugCaptureUiEvent } from '@shared/debugCapture';
import { boundedJsonBytes } from '@shared/debugCaptureEncoding';

/** 界面观察只保留有界待发片段；发送确认丢失时停止观察，不阻塞渲染。 */
export class DebugCaptureUiTrace {
  private run?: DebugCaptureSummary;
  private stoppedRunId?: string;
  private sequence = 0;
  private pending: Array<{ event: DebugCaptureUiEvent; bytes: number }> = [];
  private pendingBytes = 0;
  private inFlight?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private readonly baselines = new Set<string>();
  public constructor(private readonly viewId: string, private readonly send: (batch: DebugCaptureUiBatch) => void) {}
  public update(run?: DebugCaptureSummary): void {
    if (run?.status !== 'recording') { this.clear(); this.run = undefined; return; }
    if (run.runId === this.stoppedRunId) return;
    if (this.run?.runId !== run.runId) { this.clear(); this.sequence = 0; this.baselines.clear(); }
    this.run = run;
  }
  public active(context: DebugCaptureContext): boolean {
    return Boolean(this.run && (this.run.target.scope === 'workspace' || this.run.target.conversationId === context.conversationId));
  }
  public observe(context: DebugCaptureContext, event: () => Omit<DebugCaptureUiEvent, 'context' | 'observedAt'>): void {
    if (!this.active(context)) return;
    try {
      const input: DebugCaptureUiEvent = { ...event(), context, observedAt: new Date().toISOString() };
      const bytes = boundedJsonBytes(input, Math.min(DEBUG_CAPTURE_UI_LIMITS.batchBytes - 2048, DEBUG_CAPTURE_UI_LIMITS.queueBytes - this.pendingBytes));
      if (this.pending.length >= 512) throw new Error('界面待发事件过多。');
      this.pending.push({ event: JSON.parse(JSON.stringify(input)) as DebugCaptureUiEvent, bytes });
      this.pendingBytes += bytes;
      this.schedule();
    } catch { this.gap('界面记录超过容量上限，未保存全部界面变化。'); }
  }
  public tool(context: DebugCaptureContext, metadata: DebugCaptureUiEvent['metadata'], before: string, fragment: string, after: string): void {
    if (!this.active(context)) return;
    const key = JSON.stringify([context.modelRequestId, context.attemptSeq, context.socketGeneration, metadata.callId, metadata.mode, metadata.snapshotId]);
    if (!this.baselines.has(key)) {
      if (this.baselines.size >= 2048) { this.gap('界面工具起点数量超过上限。'); return; }
      this.baselines.add(key);
      this.observe(context, () => ({ stage: 'ui.tool_baseline', metadata, payload: before }));
    }
    this.observe(context, () => ({ stage: 'ui.tool_apply', metadata: { ...metadata, beforeChars: before.length, afterChars: after.length }, payload: fragment }));
  }
  public flush(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.run || this.inFlight !== undefined || !this.pending.length) return;
    const events: DebugCaptureUiEvent[] = [];
    let bytes = 1024;
    while (this.pending.length && events.length < DEBUG_CAPTURE_UI_LIMITS.events && bytes + this.pending[0]!.bytes + 1 < DEBUG_CAPTURE_UI_LIMITS.batchBytes) {
      const next = this.pending.shift()!; events.push(next.event); bytes += next.bytes + 1; this.pendingBytes -= next.bytes;
    }
    const batchSeq = ++this.sequence;
    this.inFlight = batchSeq;
    this.ackTimer = setTimeout(() => this.gap('界面记录发送后未收到确认，后续变化可能缺失。'), DEBUG_CAPTURE_UI_LIMITS.ackMs);
    try { this.send({ runId: this.run.runId, viewId: this.viewId, batchSeq, events }); }
    catch { this.gap('界面记录发送失败。'); }
  }
  public acknowledge(ack: DebugCaptureUiAck): void {
    if (ack.runId !== this.run?.runId || ack.viewId !== this.viewId || ack.batchSeq !== this.inFlight) return;
    if (this.ackTimer) clearTimeout(this.ackTimer); this.ackTimer = undefined; this.inFlight = undefined;
    if (!ack.accepted) { this.stoppedRunId = this.run.runId; this.update(); return; }
    if (this.pending.length) this.schedule();
  }
  public beforeStop(): void {
    this.flush();
    if (this.pending.length) this.gap('停止时还有未确认的界面记录，未发送部分已标记缺失。');
  }
  private gap(detail: string): void {
    const run = this.run;
    if (!run) return;
    this.stoppedRunId = run.runId;
    this.clear(); this.run = undefined;
    try { this.send({ runId: run.runId, viewId: this.viewId, batchSeq: ++this.sequence, events: [], gap: detail }); } catch { /* 断开时由主机入口与界面回执差异揭示缺失。 */ }
  }
  private schedule(): void {
    if (!this.timer && this.inFlight === undefined) this.timer = setTimeout(() => this.flush(), 1000);
  }
  private clear(): void {
    if (this.timer) clearTimeout(this.timer); if (this.ackTimer) clearTimeout(this.ackTimer);
    this.timer = this.ackTimer = undefined; this.pending = []; this.pendingBytes = 0; this.inFlight = undefined;
  }
}

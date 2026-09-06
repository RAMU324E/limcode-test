import { defineStore } from 'pinia';
import { BridgeMessageType, createMessageId } from '@shared/protocol';
import type { DebugCaptureAnalysis, DebugCaptureCommand, DebugCaptureState } from '@shared/debugCapture';
import { bridge } from '@webview/transport';
import { debugCaptureTrace } from '@webview/transport/debugCapture';

let installed = false;
let timeout: ReturnType<typeof setTimeout> | undefined;
export const useDebugCaptureStore = defineStore('debug-capture', {
  state: () => ({ state: undefined as DebugCaptureState | undefined, analysis: undefined as DebugCaptureAnalysis | undefined, pending: '', error: '' }),
  actions: {
    initialize(): void {
      if (installed) return; installed = true;
      bridge.on(BridgeMessageType.DebugCaptureResult, message => {
        if (message.payload) {
          this.state = message.payload.state;
          if (message.payload.analysis) this.analysis = message.payload.analysis;
          if (this.analysis && !this.state.error && !this.state.runs.some(run => run.runId === this.analysis?.runId)) this.analysis = undefined;
        }
        if (message.correlationId === this.pending) this.settled();
      });
      bridge.on(BridgeMessageType.Error, message => {
        if (message.correlationId !== this.pending || !this.pending) return;
        this.error = message.payload?.message ?? '取证操作失败。'; this.settled();
      });
    },
    command(command: DebugCaptureCommand): void {
      this.initialize();
      if (this.pending) return;
      this.error = '';
      if (command.action === 'stop') debugCaptureTrace.beforeStop();
      const id = createMessageId(); this.pending = id;
      timeout = setTimeout(() => { this.error = '操作确认尚未返回，请重新读取状态后核对。'; this.settled(); }, 15000);
      try { bridge.request(BridgeMessageType.DebugCaptureCommand, command, { requestId: id }); }
      catch (error) { this.error = error instanceof Error ? error.message : String(error); this.settled(); }
    },
    settled(): void { this.pending = ''; if (timeout) clearTimeout(timeout); timeout = undefined; }
  }
});

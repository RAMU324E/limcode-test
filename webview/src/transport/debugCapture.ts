import { createMessageId, BridgeMessageType } from '@shared/protocol';
import { DebugCaptureUiTrace } from '@webview/domain/debugCaptureTrace';
import { bridge } from './index';

export const debugCaptureTrace = new DebugCaptureUiTrace(createMessageId(), batch => bridge.request(BridgeMessageType.DebugCaptureObservation, batch));
let installed = false;
export function installDebugCaptureTrace(): void {
  if (installed) return; installed = true;
  bridge.on(BridgeMessageType.DebugCaptureResult, message => { if (message.payload) debugCaptureTrace.update(message.payload.state.active); });
  bridge.on(BridgeMessageType.DebugCaptureObservationAck, message => { if (message.payload) debugCaptureTrace.acknowledge(message.payload); });
  bridge.on(BridgeMessageType.Hello, () => debugCaptureTrace.update());
  window.addEventListener('pagehide', () => debugCaptureTrace.beforeStop());
}

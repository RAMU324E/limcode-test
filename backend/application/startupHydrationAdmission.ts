import { BridgeMessageType, type WebviewToExtensionMessage } from '../../shared/protocol';

/**
 * Messages admitted before storage hydration must be strictly side-effect free.
 *
 * Several settings "get" paths materialize missing defaults, conversation open/create can persist
 * records, and background-output reads can reconcile Process state. Default-deny prevents any new
 * bridge message from accidentally racing the one-shot Stable ID source inventory. Ready must remain
 * available so the Webview can receive Hello and subscribe while the backend is starting.
 */
const PRE_HYDRATION_CONTROL_MESSAGES = new Set<string>([
  BridgeMessageType.Ready,
  BridgeMessageType.Ping,
  BridgeMessageType.GetWorkspaceInfo,
  BridgeMessageType.ShowInfo
]);

/** Default-deny admission shared by startup and fail-closed read-only mode. */
export function requiresHydratedStorage(message: Pick<WebviewToExtensionMessage, 'type'>): boolean {
  return !PRE_HYDRATION_CONTROL_MESSAGES.has(message.type);
}

export function shouldDeferUntilHydrated(message: Pick<WebviewToExtensionMessage, 'type'>): boolean {
  return requiresHydratedStorage(message);
}

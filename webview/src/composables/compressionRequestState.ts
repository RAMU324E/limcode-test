import { shallowReactive } from 'vue';
import { BridgeMessageType, type ConversationCommittedPatchPayload } from '@shared/protocol';

export type CompressionCommandType =
  | BridgeMessageType.CompressionCreate
  | BridgeMessageType.CompressionDelete
  | BridgeMessageType.CompressionUpdate
  | BridgeMessageType.CompressionRegenerate
  | BridgeMessageType.CompressionDisable
  | BridgeMessageType.CompressionEnable;

export interface PendingCompressionRequest {
  requestId: string;
  requestType: CompressionCommandType;
  conversationId: string;
}

const INTERNAL_WEBVIEW_CAUSE_PREFIX = 'internal:webview:';
const COMPRESSION_COMMAND_TYPES: ReadonlySet<string> = new Set([
  BridgeMessageType.CompressionCreate,
  BridgeMessageType.CompressionDelete,
  BridgeMessageType.CompressionUpdate,
  BridgeMessageType.CompressionRegenerate,
  BridgeMessageType.CompressionDisable,
  BridgeMessageType.CompressionEnable
]);
const COMPRESSION_START_COMMAND_TYPES: ReadonlySet<string> = new Set([
  BridgeMessageType.CompressionCreate,
  BridgeMessageType.CompressionRegenerate
]);
const pendingCompressionRequests = shallowReactive(new Map<string, PendingCompressionRequest>());

export function trackCompressionRequest(request: PendingCompressionRequest): void {
  const requestId = request.requestId.trim();
  const conversationId = request.conversationId.trim();
  if (!requestId || !conversationId) return;
  pendingCompressionRequests.set(requestId, {
    requestId,
    requestType: request.requestType,
    conversationId
  });
}

export function takeCompressionRequestError(
  correlationId: string | undefined,
  requestType: string | undefined
): PendingCompressionRequest | undefined {
  if (!correlationId || !isCompressionCommandType(requestType)) return undefined;
  const pending = pendingCompressionRequests.get(correlationId);
  if (!pending || pending.requestType !== requestType) return undefined;
  pendingCompressionRequests.delete(correlationId);
  return { ...pending };
}

export function settleCompressionRequestsFromPatch(
  patch: Pick<ConversationCommittedPatchPayload, 'conversationId' | 'causes'>
): void {
  for (const cause of patch.causes ?? []) {
    if (cause.kind !== 'callback' || !cause.id.startsWith(INTERNAL_WEBVIEW_CAUSE_PREFIX)) continue;
    const requestId = cause.id.slice(INTERNAL_WEBVIEW_CAUSE_PREFIX.length);
    const pending = pendingCompressionRequests.get(requestId);
    if (pending?.conversationId === patch.conversationId) pendingCompressionRequests.delete(requestId);
  }
}

export function hasPendingCompressionStartRequest(conversationId: string | undefined): boolean {
  if (!conversationId) return false;
  for (const request of pendingCompressionRequests.values()) {
    if (request.conversationId === conversationId && COMPRESSION_START_COMMAND_TYPES.has(request.requestType)) return true;
  }
  return false;
}

export function isCompressionCommandType(requestType: string | undefined): requestType is CompressionCommandType {
  return !!requestType && COMPRESSION_COMMAND_TYPES.has(requestType);
}

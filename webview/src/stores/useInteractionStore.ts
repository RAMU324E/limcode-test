import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import type {
  DurableInteractionDecision,
  DurableInteractionRequestRecord,
  InteractionOwnerLinkRecord,
  JsonValue
} from '@shared/conversationReliability';
import { BridgeMessageType, type InteractionResultPayload } from '@shared/protocol';
import { bridge } from '@webview/transport';

const RESPONSE_TIMEOUT_MS = 8_000;

export interface InteractionResolveTarget {
  request: DurableInteractionRequestRecord;
  owner: InteractionOwnerLinkRecord;
}

export interface PendingInteractionResolution {
  interactionRequestId: DurableInteractionRequestRecord['id'];
  interactionRevision: number;
  ownerTurnId: InteractionOwnerLinkRecord['turnId'];
  conversationId: InteractionOwnerLinkRecord['conversationId'];
  decision: DurableInteractionDecision;
  requestId: string;
  startedAt: number;
}

const timers = new Map<string, number>();

/**
 * Webview Interaction 控制只保存短暂提交状态；请求、owner 与最终 response 始终来自 ClientState。
 * 重试使用相同 Interaction revision，后端 first-response-wins，因此无需本地伪造终态。
 */
export const useInteractionStore = defineStore('interactions', () => {
  const pending = reactive<Record<string, PendingInteractionResolution>>({});
  const pendingResolutions = computed(() => Object.values(pending)
    .sort((left, right) => left.startedAt - right.startedAt || left.interactionRequestId.localeCompare(right.interactionRequestId)));

  function resolve(target: InteractionResolveTarget, decision: DurableInteractionDecision, response: JsonValue): boolean {
    const { request, owner } = target;
    if (request.state !== 'pending' || !request.choices.includes(decision)) return false;
    if (pending[request.id]) return false;
    const requestId = bridge.request(BridgeMessageType.InteractionResolve, {
      conversationId: owner.conversationId,
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      ownerTurnId: owner.turnId,
      decision,
      response: cloneJson(response)
    });
    pending[request.id] = {
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      ownerTurnId: owner.turnId,
      conversationId: owner.conversationId,
      decision,
      requestId,
      startedAt: Date.now()
    };
    armTimeout(request.id);
    return true;
  }

  function applyResult(payload: InteractionResultPayload, correlationId?: string): void {
    const record = pending[payload.targetId]
      ?? Object.values(pending).find((candidate) => candidate.requestId === correlationId);
    if (!record) return;
    clear(record.interactionRequestId);
  }

  function reconcile(requests: readonly DurableInteractionRequestRecord[]): void {
    const currentById = new Map(requests.map((request) => [request.id, request]));
    for (const record of Object.values(pending)) {
      const request = currentById.get(record.interactionRequestId);
      if (!request || request.revision !== record.interactionRevision || request.state !== 'pending') {
        clear(record.interactionRequestId);
      }
    }
  }

  function isPending(interactionRequestId: string): boolean {
    return !!pending[interactionRequestId];
  }

  function armTimeout(interactionRequestId: string): void {
    const previous = timers.get(interactionRequestId);
    if (previous !== undefined) window.clearTimeout(previous);
    timers.set(interactionRequestId, window.setTimeout(() => clear(interactionRequestId), RESPONSE_TIMEOUT_MS));
  }

  function clear(interactionRequestId: string): void {
    const timer = timers.get(interactionRequestId);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.delete(interactionRequestId);
    delete pending[interactionRequestId];
  }

  return { pending, pendingResolutions, resolve, applyResult, reconcile, isPending };
});

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

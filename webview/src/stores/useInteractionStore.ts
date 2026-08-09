import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import type {
  DurableInteractionDecision,
  DurableInteractionRequestRecord,
  InteractionOwnerLinkRecord,
  JsonValue
} from '@shared/conversationReliability';
import { BridgeMessageType, createMessageId, type InteractionResultPayload } from '@shared/protocol';
import { bridge } from '@webview/transport';

const RESPONSE_TIMEOUT_MS = 8_000;
const OUTBOX_RETRY_MS = 30_000;
const OUTBOX_MAX_AUTOMATIC_RETRIES_PER_GENERATION = 1;
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const PERSISTED_INTERACTION_OUTBOX_KEY = 'reliableInteractionResolutionOutbox';

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
  response: JsonValue;
  requestId: string;
  startedAt: number;
  lastSentAt?: number;
  sentClientId?: string;
  sentGeneration?: string;
  automaticRetryCount?: number;
}

export interface ObservedInteractionResult {
  payload: InteractionResultPayload;
  decision?: DurableInteractionDecision;
  correlationId?: string;
  observedAt: number;
}

const responseTimers = new Map<string, number>();
const retryTimers = new Map<string, number>();
const sentThisBoot = new Set<string>();

/**
 * Interaction 请求和最终 response 仍以可靠 Runtime 为权威；这里是 Webview 的持久发送箱。
 * 固定 request id 会跨 Webview/Extension Host 重启重放，后端 first-response-wins 负责去重。
 */
export const useInteractionStore = defineStore('interactions', () => {
  const pending = reactive<Record<string, PendingInteractionResolution>>(readPersistedOutbox());
  const submitting = reactive<Record<string, true>>({});
  const observedResults = reactive<Record<string, ObservedInteractionResult>>({});
  const pendingResolutions = computed(() => Object.values(pending)
    .sort((left, right) => left.startedAt - right.startedAt || left.interactionRequestId.localeCompare(right.interactionRequestId)));

  function resolve(target: InteractionResolveTarget, decision: DurableInteractionDecision, response: JsonValue): boolean {
    const { request, owner } = target;
    if (request.state !== 'pending' || !request.choices.includes(decision)) return false;
    const frozenResponse = cloneJson(response);
    const existing = pending[request.id];
    if (existing) {
      if (
        existing.interactionRevision !== request.revision
        || existing.ownerTurnId !== owner.turnId
        || existing.conversationId !== owner.conversationId
        || existing.decision !== decision
        || JSON.stringify(existing.response) !== JSON.stringify(frozenResponse)
      ) return false;
      postResolution(existing, {
        force: true,
        showSubmitting: true,
        resetRetryBudget: true
      });
      return true;
    }

    const record: PendingInteractionResolution = {
      interactionRequestId: request.id,
      interactionRevision: request.revision,
      ownerTurnId: owner.turnId,
      conversationId: owner.conversationId,
      decision,
      response: frozenResponse,
      requestId: createMessageId(),
      startedAt: Date.now()
    };
    pending[request.id] = record;
    // The outbox must exist before postMessage: a synchronous host response or process exit cannot
    // fall into a persist-after-send gap.
    persistOutbox(pending);
    postResolution(record, {
      force: true,
      showSubmitting: true,
      resetRetryBudget: true
    });
    return true;
  }

  function replayForClient(
    clientId: string | undefined = bridge.currentClientId(),
    transportGeneration?: string
  ): void {
    if (!clientId) return;
    for (const record of Object.values(pending)) {
      const deliveryKey = deliveryIdentity(record.requestId, clientId, transportGeneration);
      if (sentThisBoot.has(deliveryKey)) continue;
      postResolution(record, {
        clientId,
        deliveryGeneration: transportGeneration,
        force: false,
        showSubmitting: false
      });
    }
  }

  function applyResult(payload: InteractionResultPayload, correlationId?: string): void {
    const record = pending[payload.targetId]
      ?? Object.values(pending).find((candidate) => candidate.requestId === correlationId);
    observedResults[payload.targetId] = {
      payload,
      ...(record && payload.status === 'committed' ? { decision: record.decision } : {}),
      ...(correlationId ? { correlationId } : {}),
      observedAt: Date.now()
    };
    const stale = Object.entries(observedResults)
      .sort((left, right) => left[1].observedAt - right[1].observedAt || left[0].localeCompare(right[0]));
    while (stale.length > 256) {
      const oldest = stale.shift();
      if (oldest) delete observedResults[oldest[0]];
    }
    if (record) clear(record.interactionRequestId);
  }

  /** Legacy projection reconciliation retained for callers that own typed InteractionRequest facts. */
  function reconcile(requests: readonly DurableInteractionRequestRecord[]): void {
    const currentById = new Map(requests.map((request) => [request.id, request]));
    for (const record of Object.values(pending)) {
      const request = currentById.get(record.interactionRequestId);
      if (request && (request.revision !== record.interactionRevision || request.state !== 'pending')) {
        clear(record.interactionRequestId);
      }
    }
  }

  /** Reliable Feed rows are sufficient to settle an outbox even if the direct result was lost. */
  function reconcileReliableFacts(requests: readonly Record<string, unknown>[]): void {
    const currentById = new Map(requests.flatMap((request) =>
      typeof request.id === 'string' ? [[request.id, request] as const] : []
    ));
    for (const record of Object.values(pending)) {
      const request = currentById.get(record.interactionRequestId);
      if (request && request.status !== 'pending') clear(record.interactionRequestId);
    }
  }

  /** A bridge-level error unlocks the UI but preserves the outbox for same-id retry/restart replay. */
  function observeTransportError(correlationId: string | undefined): void {
    if (!correlationId) return;
    const record = Object.values(pending).find((candidate) => candidate.requestId === correlationId);
    if (!record) return;
    clearResponseTimer(record.interactionRequestId);
    delete submitting[record.interactionRequestId];
    armRetry(record.interactionRequestId);
  }

  function hasPendingResolution(interactionRequestId: string): boolean {
    return !!pending[interactionRequestId];
  }

  function isPending(interactionRequestId: string): boolean {
    return !!submitting[interactionRequestId];
  }

  function resultFor(targetId: string, correlationId?: string): ObservedInteractionResult | undefined {
    const result = observedResults[targetId];
    if (!result || (correlationId && result.correlationId !== correlationId)) return undefined;
    return result;
  }

  function postResolution(
    record: PendingInteractionResolution,
    options: {
      clientId?: string;
      deliveryGeneration?: string;
      force: boolean;
      showSubmitting: boolean;
      automaticRetry?: boolean;
      resetRetryBudget?: boolean;
    }
  ): void {
    const clientId = options.clientId ?? bridge.currentClientId();
    const deliveryGeneration = options.deliveryGeneration ?? record.sentGeneration ?? 'current';
    const deliveryKey = deliveryIdentity(record.requestId, clientId, deliveryGeneration);
    if (!options.force && sentThisBoot.has(deliveryKey)) return;
    const sameGeneration = record.sentClientId === clientId
      && record.sentGeneration === deliveryGeneration;
    const automaticRetryCount = options.automaticRetry
      ? (record.automaticRetryCount ?? 0) + 1
      : options.resetRetryBudget || !sameGeneration
        ? 0
        : record.automaticRetryCount ?? 0;
    const next: PendingInteractionResolution = {
      ...record,
      lastSentAt: Date.now(),
      ...(clientId ? { sentClientId: clientId } : {}),
      sentGeneration: deliveryGeneration,
      automaticRetryCount
    };
    pending[record.interactionRequestId] = next;
    persistOutbox(pending);
    sentThisBoot.add(deliveryKey);
    if (options.showSubmitting) {
      submitting[record.interactionRequestId] = true;
      armResponseTimeout(record.interactionRequestId);
    }
    if (automaticRetryCount < OUTBOX_MAX_AUTOMATIC_RETRIES_PER_GENERATION) {
      armRetry(record.interactionRequestId);
    } else {
      clearRetryTimer(record.interactionRequestId);
    }
    try {
      bridge.request(BridgeMessageType.InteractionResolve, {
        conversationId: next.conversationId,
        interactionRequestId: next.interactionRequestId,
        interactionRevision: next.interactionRevision,
        ownerTurnId: next.ownerTurnId,
        decision: next.decision,
        response: cloneJson(next.response)
      }, { requestId: next.requestId });
    } catch {
      sentThisBoot.delete(deliveryKey);
      clearResponseTimer(record.interactionRequestId);
      delete submitting[record.interactionRequestId];
    }
  }

  function armResponseTimeout(interactionRequestId: string): void {
    clearResponseTimer(interactionRequestId);
    responseTimers.set(interactionRequestId, window.setTimeout(() => {
      responseTimers.delete(interactionRequestId);
      delete submitting[interactionRequestId];
    }, RESPONSE_TIMEOUT_MS));
  }

  function armRetry(interactionRequestId: string): void {
    clearRetryTimer(interactionRequestId);
    const current = pending[interactionRequestId];
    if (
      !current
      || (current.automaticRetryCount ?? 0) >= OUTBOX_MAX_AUTOMATIC_RETRIES_PER_GENERATION
    ) return;
    retryTimers.set(interactionRequestId, window.setTimeout(() => {
      retryTimers.delete(interactionRequestId);
      const record = pending[interactionRequestId];
      if (!record) return;
      postResolution(record, {
        clientId: record.sentClientId,
        deliveryGeneration: record.sentGeneration,
        force: true,
        showSubmitting: false,
        automaticRetry: true
      });
    }, OUTBOX_RETRY_MS));
  }

  function clear(interactionRequestId: string): void {
    clearResponseTimer(interactionRequestId);
    clearRetryTimer(interactionRequestId);
    delete submitting[interactionRequestId];
    const record = pending[interactionRequestId];
    if (!record) return;
    delete pending[interactionRequestId];
    for (const key of [...sentThisBoot]) {
      if (key.startsWith(`${record.requestId}:`)) sentThisBoot.delete(key);
    }
    persistOutbox(pending);
  }

  return {
    pending,
    pendingResolutions,
    observedResults,
    resolve,
    replayForClient,
    applyResult,
    reconcile,
    reconcileReliableFacts,
    observeTransportError,
    hasPendingResolution,
    isPending,
    resultFor
  };
});

function readPersistedOutbox(): Record<string, PendingInteractionResolution> {
  const value = bridge.readPersistedState<Record<string, PendingInteractionResolution>>(PERSISTED_INTERACTION_OUTBOX_KEY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const cutoff = Date.now() - OUTBOX_MAX_AGE_MS;
  return Object.fromEntries(Object.entries(value).filter(([, record]) =>
    record
    && typeof record === 'object'
    && typeof record.interactionRequestId === 'string'
    && typeof record.interactionRevision === 'number'
    && Number.isSafeInteger(record.interactionRevision)
    && record.interactionRevision > 0
    && typeof record.ownerTurnId === 'string'
    && typeof record.conversationId === 'string'
    && typeof record.requestId === 'string'
    && typeof record.startedAt === 'number'
    && record.startedAt >= cutoff
    && isJsonValue(record.response)
    && ['accept', 'submit', 'reject', 'cancel'].includes(record.decision)
  ).map(([id, record]) => [id, {
    ...record,
    response: cloneJson(record.response)
  }]));
}

function persistOutbox(outbox: Record<string, PendingInteractionResolution>): void {
  bridge.writePersistedState(PERSISTED_INTERACTION_OUTBOX_KEY, cloneJson(outbox as unknown as JsonValue));
}

function clearResponseTimer(interactionRequestId: string): void {
  const timer = responseTimers.get(interactionRequestId);
  if (timer !== undefined) window.clearTimeout(timer);
  responseTimers.delete(interactionRequestId);
}

function clearRetryTimer(interactionRequestId: string): void {
  const timer = retryTimers.get(interactionRequestId);
  if (timer !== undefined) window.clearTimeout(timer);
  retryTimers.delete(interactionRequestId);
}

function deliveryIdentity(
  requestId: string,
  clientId: string | undefined,
  generation?: string
): string {
  return `${requestId}:${clientId ?? 'unbound'}:${generation ?? 'current'}`;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return Boolean(value)
    && typeof value === 'object'
    && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

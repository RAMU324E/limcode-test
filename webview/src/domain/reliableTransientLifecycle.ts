import type { ReliableKernelBoundedClientState } from '@shared/reliableKernelClientFeed';
import type {
  ReliableKernelDetailState,
  ReliableKernelTransientState
} from '@webview/stores/useReliableKernelClientFeedStore';
import { hasVisibleReliableTransientOutput } from '@webview/domain/reliableTransientActivity';

const MAX_TRANSIENT_MODEL_REQUESTS = 512;

/** Reconciles memory-only overlays against the bounded durable request/message facts in place. */
export function reconcileReliableTransientRequests(
  requests: Record<string, ReliableKernelTransientState>,
  records: ReliableKernelBoundedClientState['records'],
  details: Record<string, ReliableKernelDetailState>
): void {
  const messages = records.Message ?? {};
  const linksByRequestId = new Map(Object.values(records.ModelRequestMessageLink ?? {})
    .flatMap((link) => {
      const requestId = stringValue(link.model_request_id);
      return requestId ? [[requestId, link] as const] : [];
    }));
  const durableLatestSeqByTurn = new Map<string, bigint>();
  const latestSeqByTurn = new Map<string, bigint>();
  for (const request of Object.values(records.ModelRequest ?? {})) {
    const turnId = stringValue(request.turn_id);
    const sequence = positiveDecimal(request.request_seq);
    if (!turnId || !sequence) continue;
    const parsed = BigInt(sequence);
    durableLatestSeqByTurn.set(turnId, maxBigInt(durableLatestSeqByTurn.get(turnId), parsed));
    latestSeqByTurn.set(turnId, maxBigInt(latestSeqByTurn.get(turnId), parsed));
  }
  for (const transient of Object.values(requests)) {
    const parsed = BigInt(transient.requestSeq);
    latestSeqByTurn.set(transient.turnId, maxBigInt(latestSeqByTurn.get(transient.turnId), parsed));
  }

  for (const entry of Object.values(requests)) {
    if (entry.status !== 'streaming' && !hasVisibleReliableTransientOutput(entry)) {
      // Empty failed/cancelled/completed overlays are lifecycle markers, not transcript content.
      // Retiring them here prevents an interrupted request from poisoning every later Turn.
      delete requests[entry.modelRequestId];
      continue;
    }
    const request = records.ModelRequest?.[entry.modelRequestId];
    const entrySeq = BigInt(entry.requestSeq);
    if (!request) {
      // The durable window has advanced beyond this request. A missed terminal event must not keep
      // an evicted historical stream alive at the end of the transcript.
      if ((durableLatestSeqByTurn.get(entry.turnId) ?? 0n) >= entrySeq) {
        delete requests[entry.modelRequestId];
      }
      continue;
    }
    const durableAttemptSeq = modelRequestAttemptSeq(request);
    const transientAttemptSeq = positiveBigInt(entry.attemptSeq);
    if (
      durableAttemptSeq !== undefined
      && transientAttemptSeq !== undefined
      && durableAttemptSeq > transientAttemptSeq
    ) {
      // The bounded durable Feed can advance to Attempt N+1 even when the process-local transient
      // retry terminal was missed during a Webview/host handoff. Never keep Attempt N output beside
      // the replacement Attempt: the retry is a whole-response replay, not a stream continuation.
      delete requests[entry.modelRequestId];
      continue;
    }
    if (request.status !== 'terminal') continue;

    const link = linksByRequestId.get(entry.modelRequestId);
    const messageId = stringValue(link?.message_id);
    const message = messageId ? messages[messageId] : undefined;
    const revisionId = stringValue(message?.revision_id);
    const detailReady = Boolean(
      revisionId && details[`message-content:${revisionId}`]?.status === 'ready'
    );
    const terminalState = stringValue(request.terminal_state);
    const completed = terminalState === 'completed'
      || (!terminalState && entry.status === 'completed');
    const isLatest = entrySeq === latestSeqByTurn.get(entry.turnId);
    if (completed) {
      entry.status = 'completed';
      const toolFactsReady = completedToolFactsReady(entry, records, messageId);
      if ((detailReady && toolFactsReady) || (!message && (link !== undefined || !isLatest))) {
        delete requests[entry.modelRequestId];
      }
      continue;
    }

    // Keep only the latest failed/cancelled partial so retry retains the exact model_request id.
    entry.status = entry.status === 'cancelled' ? 'cancelled' : 'failed';
    if (detailReady || (!message && !isLatest)) delete requests[entry.modelRequestId];
  }

  const terminalOverflow = Object.values(requests)
    .filter((entry) => entry.status !== 'streaming')
    .sort((left, right) => left.updatedAt - right.updatedAt || left.modelRequestId.localeCompare(right.modelRequestId));
  for (const entry of terminalOverflow) {
    if (Object.keys(requests).length <= MAX_TRANSIENT_MODEL_REQUESTS) return;
    delete requests[entry.modelRequestId];
  }
}

/**
 * A completed transient preview is the only gap-free rendering source until every provider call
 * has an authoritative ToolCallSourceLink and ToolCall. Message content and tool facts are
 * committed independently, so retiring on Message hydration alone briefly exposes an incomplete
 * durable card.
 */
function completedToolFactsReady(
  entry: ReliableKernelTransientState,
  records: ReliableKernelBoundedClientState['records'],
  messageId: string | undefined
): boolean {
  if (entry.toolCalls.length === 0) return true;
  if (!messageId) return false;

  const toolCallsById = new Map(Object.values(records.ToolCall ?? {}).flatMap((call) => {
    const id = stringValue(call.id);
    return id ? [[id, call] as const] : [];
  }));
  const candidates = Object.values(records.ToolCallSourceLink ?? {}).filter((link) =>
    stringValue(link.model_request_id) === entry.modelRequestId
    && stringValue(link.message_id) === messageId
  );
  const usedLinks = new Set<number>();

  for (let ordinal = 0; ordinal < entry.toolCalls.length; ordinal += 1) {
    const preview = entry.toolCalls[ordinal]!;
    let linkIndex = candidates.findIndex((link, index) =>
      !usedLinks.has(index) && stringValue(link.provider_call_id) === preview.callId
    );
    if (linkIndex < 0) {
      linkIndex = candidates.findIndex((link, index) =>
        !usedLinks.has(index) && nonNegativeInteger(link.provider_ordinal) === ordinal
      );
    }
    if (linkIndex < 0) return false;

    const link = candidates[linkIndex]!;
    const toolCallId = stringValue(link.tool_call_id);
    const toolCall = toolCallId ? toolCallsById.get(toolCallId) : undefined;
    if (!toolCall || stringValue(toolCall.turn_id) !== entry.turnId) return false;
    if (preview.name && stringValue(toolCall.tool_name) !== preview.name) return false;
    usedLinks.add(linkIndex);
  }
  return true;
}

function positiveDecimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined;
}

function modelRequestAttemptSeq(request: Record<string, unknown>): bigint | undefined {
  let streamStats = request.stream_stats_json;
  if (typeof streamStats === 'string') {
    try {
      streamStats = JSON.parse(streamStats);
    } catch {
      return undefined;
    }
  }
  if (!streamStats || typeof streamStats !== 'object' || Array.isArray(streamStats)) return undefined;
  return positiveBigInt((streamStats as Record<string, unknown>).attemptSeq);
}

function positiveBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'bigint') {
    return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function maxBigInt(current: bigint | undefined, next: bigint): bigint {
  return current === undefined || next > current ? next : current;
}

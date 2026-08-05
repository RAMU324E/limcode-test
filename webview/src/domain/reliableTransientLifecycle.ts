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
      if (detailReady || (!message && (link !== undefined || !isLatest))) {
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

function positiveDecimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function maxBigInt(current: bigint | undefined, next: bigint): bigint {
  return current === undefined || next > current ? next : current;
}

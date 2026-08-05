import type { ReliableKernelClientDetailKind } from '@shared/reliableKernelClientFeed';

export type ReliableKernelDetailDemandStatus = 'loading' | 'ready' | 'error' | undefined;

export interface ReliableKernelDetailDemandTarget {
  kind: ReliableKernelClientDetailKind;
  recordId: string;
  status: ReliableKernelDetailDemandStatus;
}

export function reliableKernelDetailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

/**
 * Includes both target identity and cache state. This makes an expanded tool card react when a
 * file-change member arrives after the card, or when an LRU eviction turns a ready detail missing.
 */
export function reliableKernelDetailDemandSignature(input: {
  hydrate: boolean;
  callId?: string;
  updatedAt?: number;
  targets?: readonly ReliableKernelDetailDemandTarget[];
}): string {
  const base = `${input.hydrate ? 'hydrate' : 'idle'}:${input.callId ?? ''}:${input.updatedAt ?? 0}`;
  if (!input.hydrate || !input.callId) return base;
  return [
    base,
    ...(input.targets ?? []).map(({ kind, recordId, status }) =>
      `${reliableKernelDetailKey(kind, recordId)}:${status ?? 'missing'}`)
  ].join('|');
}

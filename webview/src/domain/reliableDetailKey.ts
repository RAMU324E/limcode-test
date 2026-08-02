import type { ReliableKernelClientDetailKind } from '@shared/reliableKernelClientFeed';

export function reliableKernelDetailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

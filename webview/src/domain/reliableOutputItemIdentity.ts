import type { ModelOutputItemReference } from '@shared/protocol';

/** Provider item ids and ordinals are local to a physical response. */
export function reliableOutputItemIdentity(item: ModelOutputItemReference | undefined): string | undefined {
  return item?.id ? `${item.providerResponseId ?? ''}\u0000${item.id}\u0000${item.ordinal}` : undefined;
}

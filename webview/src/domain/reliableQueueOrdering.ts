export interface ReliableQueueOrderValue {
  id: string;
  createdAt: number;
  position?: string;
}

/** Matches backend initialGuidancePosition(created_at) for non-guidance Runtime continuations. */
export function reliableQueueEffectivePosition(value: ReliableQueueOrderValue): string {
  if (value.position && /^(?:0|[1-9]\d*)$/.test(value.position)) return value.position;
  const createdAt = Number.isFinite(value.createdAt) && value.createdAt >= 0
    ? Math.trunc(value.createdAt)
    : 0;
  return (BigInt(createdAt) * 1_000_000n).toString();
}

export function compareReliableQueueOrder(
  left: ReliableQueueOrderValue,
  right: ReliableQueueOrderValue
): number {
  const positionOrder = compareIntegerStrings(
    reliableQueueEffectivePosition(left),
    reliableQueueEffectivePosition(right)
  );
  return positionOrder
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

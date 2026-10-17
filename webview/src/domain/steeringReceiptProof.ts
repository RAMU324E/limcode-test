import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';

export interface SteeringReceiptIndex {
  appliedTargets: ReadonlyMap<string, ReadonlySet<string>>;
  appliedSuccessors: ReadonlyMap<string, ReadonlySet<string>>;
}

export function createSteeringReceiptIndex(receipts: readonly NativeSteeringReceipt[]): SteeringReceiptIndex {
  const appliedTargets = new Map<string, Set<string>>();
  const appliedSuccessors = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    if (receipt.state !== 'continuing' && receipt.state !== 'completed') continue;
    for (const [map, responseId] of [[appliedTargets, receipt.targetResponseId], [appliedSuccessors, receipt.successorResponseId]] as const) {
      if (!responseId) continue;
      const key = receiptResponseKey(receipt, responseId);
      const ids = map.get(key) ?? new Set<string>();
      ids.add(receipt.submissionId);
      map.set(key, ids);
    }
  }
  return { appliedTargets, appliedSuccessors };
}

function receiptResponseKey(receipt: NativeSteeringReceipt, responseId: string): string {
  return `${receipt.conversationId}\u0000${receipt.turnId}\u0000${receipt.modelRequestId}\u0000${responseId}`;
}

/** 只有具有完整后继身份、且同一请求没有其它回执认领同一前驱或后继时，才可标为已生效。 */
export function hasSteeringApplicationReceipt(
  receipt: NativeSteeringReceipt,
  requestReceipts: readonly NativeSteeringReceipt[] | SteeringReceiptIndex = []
): boolean {
  if (!((receipt.state === 'continuing' || receipt.state === 'completed')
    && Boolean(receipt.submissionId?.trim())
    && Boolean(receipt.conversationId?.trim())
    && Boolean(receipt.turnId?.trim())
    && Boolean(receipt.modelRequestId?.trim())
    && Boolean(receipt.messageId?.trim())
    && Boolean(receipt.targetResponseId?.trim())
    && Boolean(receipt.successorResponseId?.trim())
    && receipt.targetResponseId !== receipt.successorResponseId
    && (!receipt.responseId || receipt.responseId === receipt.successorResponseId))) return false;
  const index = Array.isArray(requestReceipts)
    ? createSteeringReceiptIndex(requestReceipts) : requestReceipts as SteeringReceiptIndex;
  const conflicts = (ids: ReadonlySet<string> | undefined): boolean => Boolean(ids
    && (ids.size > 1 || (ids.size === 1 && !ids.has(receipt.submissionId))));
  return !conflicts(index.appliedTargets.get(receiptResponseKey(receipt, receipt.targetResponseId!)))
    && !conflicts(index.appliedSuccessors.get(receiptResponseKey(receipt, receipt.successorResponseId!)));
}

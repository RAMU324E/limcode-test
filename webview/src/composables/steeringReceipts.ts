import { ref } from 'vue';
import type { NativeSteeringReceipt } from '@shared/openAIResponsesNative';

/**
 * 转向回执的会话级共享状态：useChat 在 TurnSteerResult 到达时写入，
 * 会话投影读取它做转向边界的精确拆分（modelRequestId/successorResponseId/messageId）。
 * 独立成模块以避免 useChat 与 useReliableConversation 之间循环依赖。
 */
const receiptsByConversation = ref<Record<string, Record<string, NativeSteeringReceipt>>>({});

export function steeringReceiptsByConversationState() {
  return receiptsByConversation;
}

/** Live 推送与 status 全量读取可能乱序到达；较旧的回执不得覆盖较新状态。 */
export function mergeSteeringReceipts(conversationId: string, receipts: readonly NativeSteeringReceipt[]): void {
  if (receipts.length === 0) return;
  const merged = { ...(receiptsByConversation.value[conversationId] ?? {}) };
  for (const receipt of receipts) {
    const previous = merged[receipt.submissionId];
    if (previous && previous.updatedAt > receipt.updatedAt) continue;
    merged[receipt.submissionId] = receipt;
  }
  receiptsByConversation.value = { ...receiptsByConversation.value, [conversationId]: merged };
}

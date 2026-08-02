import { bridge, BridgeMessageType } from '@webview/transport';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import type { ConversationCommandMetadata, MessageContent } from '@shared/protocol';

let reliableCommandSequence = 0;

function nextReliableCommandMetadata(): ConversationCommandMetadata {
  reliableCommandSequence += 1;
  const issuedAt = Date.now();
  return {
    commandId: `reliable-command-${issuedAt.toString(36)}-${reliableCommandSequence.toString(36)}`,
    expectedVersion: 0,
    issuedAt
  };
}

/** Conversation commands are admitted only through the reliable Turn/Message control planes. */
export function useChat() {
  const reliableConversation = useReliableConversation();

  function activeConversationId(): string {
    return reliableConversation.conversationId.value;
  }

  function activeTurnId(conversationId: string): string | undefined {
    const turn = Object.values(reliableConversation.feed.records.Turn ?? {}).find((candidate) =>
      candidate.conversation_id === conversationId && candidate.status === 'active'
    );
    return typeof turn?.id === 'string' ? turn.id : undefined;
  }

  function sendMessage(text: string, content?: MessageContent): boolean {
    const conversationId = activeConversationId();
    const trimmed = text.trim();
    if ((!trimmed && !content?.parts?.length) || !conversationId) return false;
    const payload = {
      conversationId,
      text: trimmed,
      ...(content?.parts?.length ? { content } : {}),
      command: nextReliableCommandMetadata()
    };
    bridge.request(activeTurnId(conversationId) ? BridgeMessageType.TurnEnqueue : BridgeMessageType.TurnStart, payload);
    return true;
  }

  function editMessage(
    conversationId: string,
    messageId: string,
    text: string,
    options: { runAfterEdit?: boolean; deleteFollowing?: boolean } = {}
  ): boolean {
    const trimmed = text.trim();
    if (!conversationId || !messageId || !trimmed) return false;
    bridge.request(BridgeMessageType.MessageEdit, {
      conversationId,
      messageId,
      text: trimmed,
      ...options,
      command: nextReliableCommandMetadata()
    });
    return true;
  }

  function retryMessageFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    bridge.request(BridgeMessageType.MessageRetryFrom, {
      conversationId,
      messageId,
      command: nextReliableCommandMetadata()
    });
    return true;
  }

  function deleteMessagesFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    bridge.request(BridgeMessageType.MessageDeleteFrom, {
      conversationId,
      messageId,
      command: nextReliableCommandMetadata()
    });
    return true;
  }

  function forkConversationFrom(sourceConversationId: string, messageId: string): boolean {
    if (!sourceConversationId || !messageId) return false;
    bridge.request(BridgeMessageType.ConversationFork, { sourceConversationId, messageId });
    return true;
  }

  function interruptCurrentConversation(cascadeChildAgents = false): boolean {
    const conversationId = activeConversationId();
    const turnId = activeTurnId(conversationId);
    if (!conversationId || !turnId) return false;
    bridge.request(BridgeMessageType.TurnInterrupt, {
      conversationId,
      turnId,
      leaseEpoch: 0,
      command: nextReliableCommandMetadata(),
      ...(cascadeChildAgents ? { cascadeChildAgents: true as const } : {})
    });
    return true;
  }

  return {
    sendMessage,
    editMessage,
    retryMessageFrom,
    deleteMessagesFrom,
    forkConversationFrom,
    interruptCurrentConversation
  };
}

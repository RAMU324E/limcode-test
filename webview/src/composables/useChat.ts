import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useConversationCommandStore, type CheckpointRestoreSaga } from '@webview/stores/useConversationCommandStore';
import type { ChatModelOverrideRecord, MessageContent } from '@shared/protocol';

export interface TurnIntentIdentity {
  id: string;
  rowVersion: number;
}

/** 对话控制动作只使用 Turn/Intent/Lease 权威身份，不再从 AgentRun 或可见 Message 猜测语义。 */
export function useChat() {
  const clientState = useClientStateStore();
  const agentStore = useAgentStore();
  const conversationSettings = useConversationSettingsStore();
  const globalSettings = useGlobalSettingsStore();
  const modelProfileStore = useModelProfileStore();
  const commands = useConversationCommandStore();

  function sendMessage(text: string, content?: MessageContent): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if ((!trimmed && !content?.parts?.length) || !conversationId) return false;
    const agentId = agentStore.activeAgentForConversation(conversationId)?.id;
    const model = currentConversationModelOverride(conversationId);
    const payload = {
      conversationId,
      text: trimmed,
      ...(content?.parts?.length ? { content } : {}),
      ...(agentId ? { agentId } : {}),
      ...(model ? { model } : {})
    };
    const startAdmissionPending = commands.pendingCommands.some((command) =>
      command.conversationId === conversationId
      && command.kind === 'start'
      && command.phase !== 'blocked'
      && command.phase !== 'outcome_unknown'
      && command.phase !== 'partial_success'
      && command.phase !== 'projection_recovery');
    if (clientState.currentExecution || startAdmissionPending) {
      commands.submit(BridgeMessageType.TurnEnqueue, payload, { kind: 'enqueue', targetId: conversationId });
    } else {
      commands.submit(BridgeMessageType.TurnStart, payload, { kind: 'start', targetId: conversationId });
    }
    return true;
  }

  /** 显式 steer；普通发送永远不会偷偷解除 Interaction 或注入当前 Turn。 */
  function steerCurrentTurn(
    text: string,
    content?: MessageContent,
    fallback: 'queue_next' | 'return_to_draft' | 'reject' = 'queue_next'
  ): boolean {
    const conversationId = clientState.currentConversationId;
    const execution = clientState.currentExecution;
    const trimmed = text.trim();
    if (!conversationId || !execution || (!trimmed && !content?.parts?.length)) return false;
    commands.submit(BridgeMessageType.TurnSteer, {
      conversationId,
      targetTurnId: execution.turn.id,
      targetLeaseEpoch: execution.lease.epoch,
      fallback,
      text: trimmed,
      ...(content?.parts?.length ? { content } : {})
    }, { kind: 'steer', targetId: execution.turn.id });
    return true;
  }

  function editMessage(conversationId: string, messageId: string, text: string, options: { runAfterEdit?: boolean; deleteFollowing?: boolean } = {}): boolean {
    const trimmed = text.trim();
    if (!conversationId || !messageId || !trimmed) return false;
    const model = currentConversationModelOverride(conversationId);
    const payload = { conversationId, messageId, text: trimmed, ...options, ...(model ? { model } : {}) };
    commands.submit(BridgeMessageType.MessageEdit, payload, { kind: 'edit', targetId: messageId });
    return true;
  }

  function retryMessageFrom(conversationId: string, messageId: string, saga?: CheckpointRestoreSaga): boolean {
    if (!conversationId || !messageId) return false;
    const model = currentConversationModelOverride(conversationId);
    const payload = { conversationId, messageId, ...(model ? { model } : {}) };
    commands.submit(BridgeMessageType.MessageRetryFrom, payload, { kind: 'retry', targetId: messageId, ...(saga ? { saga } : {}) });
    return true;
  }

  function deleteMessagesFrom(conversationId: string, messageId: string, saga?: CheckpointRestoreSaga): boolean {
    if (!conversationId || !messageId) return false;
    commands.submit(BridgeMessageType.MessageDeleteFrom, { conversationId, messageId }, { kind: 'delete', targetId: messageId, ...(saga ? { saga } : {}) });
    return true;
  }

  function forkConversationFrom(sourceConversationId: string, messageId: string): boolean {
    if (!sourceConversationId || !messageId) return false;
    bridge.request(BridgeMessageType.ConversationFork, { sourceConversationId, messageId });
    return true;
  }

  function cancelLlmAutoRetry(input: { requestId: string; conversationId?: string; messageId?: string; runId?: string }): boolean {
    if (!input.requestId) return false;
    bridge.request(BridgeMessageType.LlmRetryCancel, { ...input, reason: 'user_cancelled_auto_retry' });
    return true;
  }

  function interruptCurrentConversation(cascadeChildAgents = false): boolean {
    const conversationId = clientState.currentConversationId;
    const execution = clientState.currentExecution;
    if (!conversationId || !execution) return false;
    commands.submit(BridgeMessageType.TurnInterrupt, {
      conversationId,
      turnId: execution.turn.id,
      leaseEpoch: execution.lease.epoch,
      ...(cascadeChildAgents ? { cascadeChildAgents: true } : {})
    }, { kind: 'interrupt', targetId: execution.turn.id });
    return true;
  }

  function cancelTurnIntent(intent: TurnIntentIdentity): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !intent.id) return false;
    commands.submit(BridgeMessageType.TurnIntentCancel, {
      conversationId,
      intentId: intent.id,
      rowVersion: intent.rowVersion
    }, { kind: 'intent_control', targetId: intent.id });
    return true;
  }

  function promoteTurnIntent(intent: TurnIntentIdentity): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !intent.id) return false;
    const execution = clientState.currentExecution;
    commands.submit(BridgeMessageType.TurnIntentPromote, {
      conversationId,
      intentId: intent.id,
      rowVersion: intent.rowVersion,
      replaceActive: execution !== undefined,
      ...(execution ? {
        expectedActiveTurnId: execution.turn.id,
        expectedLeaseEpoch: execution.lease.epoch
      } : {})
    }, { kind: 'promote', targetId: intent.id });
    return true;
  }

  function reorderTurnIntents(intents: TurnIntentIdentity[]): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || intents.length === 0) return false;
    commands.submit(BridgeMessageType.TurnIntentReorder, {
      conversationId,
      intents: intents.map((intent) => ({ intentId: intent.id, rowVersion: intent.rowVersion }))
    }, { kind: 'intent_control', targetId: conversationId });
    return true;
  }

  function pauseTurnIntent(intent: TurnIntentIdentity): boolean {
    return submitIntentControl(BridgeMessageType.TurnIntentPause, intent);
  }

  function resumeTurnIntent(intent: TurnIntentIdentity): boolean {
    return submitIntentControl(BridgeMessageType.TurnIntentResume, intent);
  }

  function resumeAllTurnIntents(): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return false;
    commands.submit(BridgeMessageType.TurnIntentResumeAll, { conversationId }, { kind: 'intent_control', targetId: conversationId });
    return true;
  }

  function updateTurnIntent(intent: TurnIntentIdentity, text: string, content?: MessageContent): boolean {
    const conversationId = clientState.currentConversationId;
    const trimmed = text.trim();
    if (!conversationId || !intent.id || (!trimmed && !content?.parts?.length)) return false;
    commands.submit(BridgeMessageType.TurnIntentUpdate, {
      conversationId,
      intentId: intent.id,
      rowVersion: intent.rowVersion,
      text: trimmed,
      ...(content?.parts?.length ? { content } : {})
    }, { kind: 'intent_control', targetId: intent.id });
    return true;
  }

  function submitIntentControl(
    type: BridgeMessageType.TurnIntentPause | BridgeMessageType.TurnIntentResume,
    intent: TurnIntentIdentity
  ): boolean {
    const conversationId = clientState.currentConversationId;
    if (!conversationId || !intent.id) return false;
    commands.submit(type, {
      conversationId,
      intentId: intent.id,
      rowVersion: intent.rowVersion
    }, { kind: 'intent_control', targetId: intent.id });
    return true;
  }

  function currentConversationModelOverride(conversationId: string): ChatModelOverrideRecord | undefined {
    const llm = conversationSettings.llm.conversationId === conversationId ? conversationSettings.llm : undefined;
    const profile = modelProfileStore.localProfileFor('conversation', conversationId).profile;
    const configId = llm?.activeProviderConfigId || profile?.providerConfigId?.trim() || globalSettings.llm.activeProviderConfigId || globalSettings.activeLlmProviderConfig?.id || '';
    const config = globalSettings.llmProviderConfigs.configs.find((candidate) => candidate.id === configId) ?? globalSettings.activeLlmProviderConfig;
    if (!config) return undefined;
    const override = llm?.modelOverrides?.[config.id]?.trim();
    const profileModel = profile?.providerConfigId?.trim() === config.id ? profile.model.trim() : '';
    const model = override && modelExistsInConfig(config, override)
      ? override
      : profileModel && modelExistsInConfig(config, profileModel)
        ? profileModel
        : config.model?.trim();
    if (!model) return undefined;
    return { providerConfigId: config.id, provider: config.provider, model };
  }

  function modelExistsInConfig(config: { model?: string; models: Array<{ id: string }> }, modelId: string): boolean {
    const id = modelId.trim();
    if (!id) return false;
    return config.model?.trim() === id || config.models.some((model) => model.id === id);
  }

  return {
    sendMessage,
    steerCurrentTurn,
    editMessage,
    retryMessageFrom,
    deleteMessagesFrom,
    forkConversationFrom,
    cancelLlmAutoRetry,
    interruptCurrentConversation,
    cancelTurnIntent,
    promoteTurnIntent,
    reorderTurnIntents,
    pauseTurnIntent,
    resumeTurnIntent,
    resumeAllTurnIntents,
    updateTurnIntent
  };
}

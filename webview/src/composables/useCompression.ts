import { computed } from 'vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import type { CompressionBlockRecord, ConversationTimelineChunkSummaryRecord, LlmCompressionConfigRecord, LlmProviderConfigRecord } from '@shared/protocol';
import { hasPendingCompressionStartRequest, trackCompressionRequest } from './compressionRequestState';

export interface CreateCompressionOptions {
  startMessageId?: string;
  endMessageId?: string;
  methodConfigId?: string;
}

export function useCompression() {
  const clientState = useClientStateStore();
  const conversationTimeline = useConversationTimelineStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const activeCompressionBlocks = computed(() => {
    const conversationId = clientState.currentConversationId;
    if (!conversationId) return [];
    return clientState.compressionBlocks.filter((block) =>
      block.conversationId === conversationId && (block.status === 'pending' || block.status === 'running')
    );
  });
  const compressionActive = computed(() => activeCompressionBlocks.value.length > 0);
  const compressionRequestPending = computed(() => hasPendingCompressionStartRequest(clientState.currentConversationId));

  function createCompression(options: CreateCompressionOptions | string = {}): boolean {
    const input = typeof options === 'string' ? { methodConfigId: options } : options;
    const conversationId = clientState.currentConversationId;
    if (!conversationId) {
      logCompressionClientAction('create.skipNoConversation', { input });
      return false;
    }
    const runningBlocks = activeCompressionBlocks.value;
    if (runningBlocks.length > 0 || compressionRequestPending.value) {
      logCompressionClientAction('create.blockedByActiveCompression', {
        conversationId,
        requestPending: compressionRequestPending.value,
        blockIds: runningBlocks.map((block) => block.id)
      });
      bridge.request(BridgeMessageType.ShowInfo, { message: '上下文压缩正在进行，当前版本暂不支持取消，请等待本次压缩完成。' });
      return false;
    }
    const currentMessages = conversationTimeline.currentMessages;
    if (currentMessages.some((message) => message.status === 'streaming')) {
      logCompressionClientAction('create.skipStreamingMessage', compressionTimelineDebugContext(conversationId, input));
      bridge.request(BridgeMessageType.ShowInfo, { message: '请等待 AI 响应结束后再压缩上下文。' });
      return false;
    }
    const minimumMessageCount = input.startMessageId || input.endMessageId ? 1 : 2;
    const totalMessageCount = conversationTimeline.currentTotalMessages;
    if (totalMessageCount < minimumMessageCount) {
      logCompressionClientAction('create.skipInsufficientMessages', {
        ...compressionTimelineDebugContext(conversationId, input),
        minimumMessageCount
      });
      return false;
    }
    const resolvedConfig = compressionConfigForConversation(conversationId, input.methodConfigId);
    if (!resolvedConfig) {
      logCompressionClientAction('create.skipMissingMethodConfig', compressionTimelineDebugContext(conversationId, input));
      bridge.request(BridgeMessageType.ShowInfo, { message: '未找到当前上下文压缩配置，请先在全局设置中选择可用的压缩方法。' });
      return false;
    }
    const startMessageId = input.startMessageId?.trim();
    const endMessageId = input.endMessageId?.trim();
    const payload = {
      conversationId,
      ...(startMessageId ? { startMessageId } : {}),
      ...(endMessageId ? { endMessageId } : {}),
      methodConfigId: resolvedConfig.id,
      methodKind: resolvedConfig.kind
    };
    const requestId = bridge.request(BridgeMessageType.CompressionCreate, payload);
    trackCompressionRequest({ requestId, requestType: BridgeMessageType.CompressionCreate, conversationId });
    logCompressionClientAction('create.requestSent', {
      requestId,
      payload,
      ...compressionTimelineDebugContext(conversationId, input)
    });
    return true;
  }

  function deleteCompression(block: CompressionBlockRecord): void {
    if (block.status === 'pending' || block.status === 'running') {
      bridge.request(BridgeMessageType.ShowInfo, { message: '上下文压缩正在进行，当前版本暂不支持取消或删除。' });
      return;
    }
    const conversationId = block.conversationId;
    const blockId = block.id;
    const requestId = bridge.request(BridgeMessageType.CompressionDelete, { conversationId, blockId });
    trackCompressionRequest({ requestId, requestType: BridgeMessageType.CompressionDelete, conversationId });
  }

  function regenerateCompression(block: CompressionBlockRecord): void {
    if (block.status === 'pending' || block.status === 'running') return;
    const conversationId = block.conversationId;
    const blockId = block.id;
    const methodConfigId = block.methodConfigId?.trim();
    const requestId = bridge.request(BridgeMessageType.CompressionRegenerate, {
      conversationId,
      blockId,
      ...(methodConfigId ? { methodConfigId } : {})
    });
    trackCompressionRequest({ requestId, requestType: BridgeMessageType.CompressionRegenerate, conversationId });
  }

  function setCompressionEnabled(block: CompressionBlockRecord, enabled: boolean): void {
    if (block.status === 'pending' || block.status === 'running') return;
    const requestType = enabled ? BridgeMessageType.CompressionEnable : BridgeMessageType.CompressionDisable;
    const conversationId = block.conversationId;
    const blockId = block.id;
    const requestId = bridge.request(requestType, { conversationId, blockId });
    trackCompressionRequest({ requestId, requestType, conversationId });
  }

  function compressionConfigForConversation(conversationId: string, requestedConfigId?: string): LlmCompressionConfigRecord | undefined {
    const normalizedRequestedId = requestedConfigId?.trim();
    if (normalizedRequestedId) {
      return globalSettings.llmCompressionConfigs.configs.find((config) => config.id === normalizedRequestedId);
    }
    const providerConfigId = conversationSettings.llm.conversationId === conversationId
      ? conversationSettings.llm.activeProviderConfigId
      : '';
    const activeProvider = globalSettings.llmProviderConfigs.configs.find((config) => config.id === providerConfigId)
      ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
      ?? globalSettings.llmProviderConfigs.configs[0];
    const activeProviderConfigId = activeProvider?.id;
    const modelId = selectedModelIdForProvider(activeProvider, conversationId);
    const modelBinding = activeProviderConfigId && modelId
      ? globalSettings.llmCompression.modelBindings.find((item) => item.providerConfigId === activeProviderConfigId && item.modelId === modelId)
      : undefined;
    const binding = activeProviderConfigId
      ? globalSettings.llmCompression.providerBindings.find((item) => item.providerConfigId === activeProviderConfigId)
      : undefined;
    const configId = modelBinding?.compressionConfigId ?? binding?.compressionConfigId ?? globalSettings.llmCompression.defaultConfigId;
    return globalSettings.llmCompressionConfigs.configs.find((config) => config.id === configId)
      ?? globalSettings.llmCompressionConfigs.configs[0];
  }

  function selectedModelIdForProvider(config: LlmProviderConfigRecord | undefined, conversationId: string): string {
    if (!config) return '';
    const conversationOverride = conversationSettings.llm.conversationId === conversationId
      ? conversationSettings.llm.modelOverrides?.[config.id]?.trim()
      : '';
    if (conversationOverride && modelExistsInProvider(config, conversationOverride)) return conversationOverride;
    return config.model?.trim() ?? '';
  }

  function modelExistsInProvider(config: LlmProviderConfigRecord, modelId: string): boolean {
    const id = modelId.trim();
    if (!id) return false;
    return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
  }

  function compressionTimelineDebugContext(conversationId: string, input: CreateCompressionOptions): Record<string, unknown> {
    const timeline = conversationTimeline.currentTimeline;
    const chunks = timeline.loadedChunkIds
      .map((id) => timeline.chunkById[id])
      .filter((chunk): chunk is ConversationTimelineChunkSummaryRecord => !!chunk)
      .map((chunk) => ({ id: chunk.id, index: chunk.index, startSeq: chunk.startSeq, endSeq: chunk.endSeq, messageCount: chunk.messageCount }));
    const messages = conversationTimeline.currentMessages;
    return {
      conversationId,
      timelineConversationId: conversationTimeline.currentConversationId,
      input,
      loadedMessageCount: messages.length,
      totalMessages: conversationTimeline.currentTotalMessages,
      hasOlder: conversationTimeline.currentHasOlder,
      hasNewer: conversationTimeline.currentHasNewer,
      firstSeq: messages[0]?.seq,
      lastSeq: messages[messages.length - 1]?.seq,
      loadedChunks: chunks
    };
  }

  return { createCompression, deleteCompression, regenerateCompression, setCompressionEnabled, compressionActive, compressionRequestPending };
}

function logCompressionClientAction(stage: string, payload: Record<string, unknown>): void {
  console.info('[LimCode][Compression][Webview]', stage, payload);
}

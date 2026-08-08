import { onBeforeUnmount, watch } from 'vue';
import {
  GLOBAL_SETTINGS_SECTIONS,
  type BridgeScope,
  type GlobalSettingsSection
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';
import { useInteractionStore } from '@webview/stores/useInteractionStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useAgentStore } from '@webview/stores/useAgentStore';

function globalSettingsSectionFromScope(scope: BridgeScope | undefined): GlobalSettingsSection | undefined {
  if (scope?.kind !== 'settings' || scope.level !== 'global') return undefined;
  const section = scope.id;
  return GLOBAL_SETTINGS_SECTIONS.includes(section as GlobalSettingsSection)
    ? section as GlobalSettingsSection
    : undefined;
}

/** Registers the configuration/control bridge. Runtime data is accepted only by the bounded Feed. */
export function useBridgeBootstrap(): void {
  const session = useSessionStore();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const systemPrompts = useSystemPromptStore();
  const runtimeContexts = useRuntimeContextStore();
  const interactions = useInteractionStore();
  const modelProfiles = useModelProfileStore();
  const agents = useAgentStore();
  const disposers: Array<() => void> = [];

  disposers.push(
    bridge.on(BridgeMessageType.Hello, (message) => {
      session.applyHello(message.payload?.meta, message.payload?.runtime);
      if (message.payload?.runtime) console.info('[LimCode][Runtime]', { ...message.payload.runtime });
      const conversationId = message.payload?.meta?.conversationId;
      if (conversationId) clientState.setCurrentConversation(conversationId);

      if (session.viewKind === 'globalSettings') {
        globalSettings.requestAll();
        return;
      }
      globalSettings.requestChannelSettings();
      if (session.viewKind === 'chat' || session.viewKind === 'planDetail') {
        globalSettings.ensureAppearance();
      }
    }),
    bridge.on(BridgeMessageType.ConfigurationSnapshot, (message) => {
      if (!message.payload) return;
      clientState.applyConfigurationSnapshot(message.payload.state);
      modelProfiles.reconcileSnapshot(message.correlationId);
      systemPrompts.reconcilePendingSave();
      runtimeContexts.reconcilePendingSave();
    }),
    bridge.on(BridgeMessageType.InteractionResult, (message) => {
      if (message.payload) interactions.applyResult(message.payload, message.correlationId);
    }),
    bridge.on(BridgeMessageType.GlobalSettingsSnapshot, (message) => {
      if (message.payload) globalSettings.applySnapshot(message.payload, message.correlationId);
    }),
    bridge.on(BridgeMessageType.ConversationSettingsSnapshot, (message) => {
      if (message.payload) conversationSettings.applySnapshot(message.payload);
    }),
    bridge.on(BridgeMessageType.LlmProviderModelsSnapshot, (message) => {
      if (message.payload) globalSettings.applyLlmProviderModelsSnapshot(message.payload);
    }),
    bridge.on(BridgeMessageType.Error, (message) => {
      const payload = message.payload;
      if (!payload) return;
      if (payload.requestType === BridgeMessageType.ModelProfileScopeSet) {
        modelProfiles.rejectPending(message.correlationId, payload.message);
      }
      if (payload.requestType === BridgeMessageType.ConversationAgentSelect) {
        agents.rejectPending(message.correlationId, payload.message);
      }
      if (
        payload.requestType === BridgeMessageType.GlobalSettingsGet
        || payload.requestType === BridgeMessageType.GlobalSettingsUpdate
        || payload.requestType === BridgeMessageType.LlmProviderModelsGet
      ) {
        globalSettings.setError(payload.message, {
          requestType: payload.requestType,
          section: globalSettingsSectionFromScope(message.scope),
          correlationId: message.correlationId,
          code: payload.code,
          actualRevision: payload.actualRevision
        });
      }
    })
  );

  disposers.push(
    watch(
      () => clientState.currentConversationId,
      (conversationId) => {
        if ((session.viewKind !== 'chat' && session.viewKind !== 'planDetail') || !conversationId) return;
        bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
        conversationSettings.request(conversationId);
      },
      { immediate: true }
    )
  );

  bridge.ready();
  onBeforeUnmount(() => {
    for (const dispose of disposers) dispose();
  });
}

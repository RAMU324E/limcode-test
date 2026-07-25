import { onBeforeUnmount, watch } from 'vue';
import { GLOBAL_SETTINGS_SECTIONS, conversationClientStateStreamId, conversationIdFromClientStateStreamId, type BridgeScope, type ClientPatchOp, type GlobalSettingsSection } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useSessionStore } from '@webview/stores/useSessionStore';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useConversationSettingsStore } from '@webview/stores/useConversationSettingsStore';
import { useRunHistoryStore } from '@webview/stores/useRunHistoryStore';
import { useConversationTimelineStore } from '@webview/stores/useConversationTimelineStore';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useSystemPromptStore } from '@webview/stores/useSystemPromptStore';
import { useRuntimeContextStore } from '@webview/stores/useRuntimeContextStore';
import { useConversationCommandStore } from '@webview/stores/useConversationCommandStore';
import { useInteractionStore } from '@webview/stores/useInteractionStore';
import { useToolResultArtifactStore } from '@webview/stores/useToolResultArtifactStore';
import { settleCompressionRequestsFromPatch, takeCompressionRequestError } from './compressionRequestState';

/**
 * 在 App 根组件挂载时调用一次：集中注册所有入站桥接监听并接入对应 store，
 * 卸载时清理。组件层不再直接监听 bridge。
 */

function globalSettingsSectionFromScope(scope: BridgeScope | undefined): GlobalSettingsSection | undefined {
  if (scope?.kind !== 'settings' || scope.level !== 'global') return undefined;
  const section = scope.id;
  return GLOBAL_SETTINGS_SECTIONS.includes(section as GlobalSettingsSection)
    ? section as GlobalSettingsSection
    : undefined;
}

function logCompressionClientDebug(stage: string, payload: Record<string, unknown>): void {
  console.info('[LimCode][Compression][Webview]', stage, payload);
}

function compressionCommandLabel(requestType: string): string {
  switch (requestType) {
    case BridgeMessageType.CompressionCreate: return '创建上下文压缩';
    case BridgeMessageType.CompressionDelete: return '删除压缩记录';
    case BridgeMessageType.CompressionUpdate: return '更新压缩记录';
    case BridgeMessageType.CompressionRegenerate: return '重新生成上下文压缩';
    case BridgeMessageType.CompressionDisable: return '禁用压缩记录';
    case BridgeMessageType.CompressionEnable: return '启用压缩记录';
    default: return '上下文压缩操作';
  }
}

function compressionSnapshotDebug(state: { compressionBlocks?: Array<{ id: string; status: string; error?: string; sourceHash?: string; anchorSeq?: number; endSeq?: number; methodKind?: string }>; compressionBlockLlmInvocationLinks?: Array<{ blockId: string; invocationId: string }>; llmInvocations?: Array<{ id: string; status: string; error?: string }> }): Record<string, unknown> | undefined {
  const blocks = state.compressionBlocks ?? [];
  const links = state.compressionBlockLlmInvocationLinks ?? [];
  if (blocks.length === 0 && links.length === 0) return undefined;
  const invocationIds = new Set(links.map((link) => link.invocationId));
  const invocations = (state.llmInvocations ?? []).filter((invocation) => invocationIds.has(invocation.id));
  return {
    compressionBlockCount: blocks.length,
    compressionBlocks: blocks.slice(-8).map((block) => ({
      id: block.id,
      status: block.status,
      methodKind: block.methodKind,
      anchorSeq: block.anchorSeq,
      endSeq: block.endSeq,
      error: block.error
    })),
    compressionInvocationLinkCount: links.length,
    compressionInvocations: invocations.slice(-8)
  };
}

function compressionPatchDebug(patches: readonly { kind: string; [key: string]: unknown }[]): Record<string, unknown> | undefined {
  const compressionPatches = patches.filter((patch) =>
    patch.kind.startsWith('compressionBlock')
    || patch.kind.startsWith('compressionContextVariant')
    || patch.kind.startsWith('runCompressionBlockLink')
  );
  if (compressionPatches.length === 0) return undefined;
  return {
    compressionPatchCount: compressionPatches.length,
    compressionPatches: compressionPatches.slice(0, 12).map((patch) => summarizeCompressionPatch(patch)),
    omittedPatchCount: Math.max(0, compressionPatches.length - 12)
  };
}

function summarizeCompressionPatch(patch: { kind: string; [key: string]: unknown }): Record<string, unknown> {
  const block = patch.block as { id?: string; status?: string; methodKind?: string; anchorSeq?: number; endSeq?: number; error?: string } | undefined;
  const link = patch.link as { id?: string; blockId?: string; invocationId?: string; sourceId?: string; sourceKind?: string; role?: string } | undefined;
  const variant = patch.variant as { id?: string; blockId?: string; kind?: string } | undefined;
  return {
    kind: patch.kind,
    id: typeof patch.id === 'string' ? patch.id : block?.id ?? link?.id ?? variant?.id,
    block: block ? { id: block.id, status: block.status, methodKind: block.methodKind, anchorSeq: block.anchorSeq, endSeq: block.endSeq, error: block.error } : undefined,
    link: link ? { id: link.id, blockId: link.blockId, invocationId: link.invocationId, sourceKind: link.sourceKind, sourceId: link.sourceId, role: link.role } : undefined,
    variant: variant ? { id: variant.id, blockId: variant.blockId, kind: variant.kind } : undefined
  };
}

export function useBridgeBootstrap(): void {
  const session = useSessionStore();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const conversationSettings = useConversationSettingsStore();
  const runHistory = useRunHistoryStore();
  const conversationTimeline = useConversationTimelineStore();
  const conversationUi = useConversationUiStore();
  const systemPromptStore = useSystemPromptStore();
  const runtimeContextStore = useRuntimeContextStore();
  const conversationCommands = useConversationCommandStore();
  const interactions = useInteractionStore();
  const toolResults = useToolResultArtifactStore();

  const disposers: Array<() => void> = [];
  watch(
    () => clientState.interactionRequests.map((request) => `${request.id}:${request.revision}:${request.state}`).join('|'),
    () => interactions.reconcile(clientState.interactionRequests),
    { immediate: true }
  );
  let pendingCommandsResumed = false;
  const requestedConversationStreams = new Set<string>();

  function ensureConversationStream(conversationId: string): void {
    if (!conversationId) return;
    const streamId = conversationClientStateStreamId(conversationId);
    if (requestedConversationStreams.has(streamId)) return;
    requestedConversationStreams.add(streamId);
    bridge.request(BridgeMessageType.ClientResync, { conversationId, streamId });
  }

  function resync(): void {
    const conversationId = clientState.currentConversationId;
    if (conversationId) {
      bridge.request(BridgeMessageType.ClientResync, {
        conversationId,
        streamId: conversationClientStateStreamId(conversationId)
      });
    } else {
      bridge.request(BridgeMessageType.ClientResync, {});
    }
  }

  disposers.push(
    bridge.on(BridgeMessageType.Hello, (message) => {
      session.applyHello(message.payload?.meta, message.payload?.runtime);
      if (message.payload?.runtime) console.info('[LimCode][Runtime]', { ...message.payload.runtime });
      if (!pendingCommandsResumed) {
        pendingCommandsResumed = true;
        conversationCommands.resumePending();
      }
      if (session.viewKind === 'globalSettings') {
        globalSettings.requestAll();
        return;
      }
      if (session.viewKind === 'workflowSettings') {
        globalSettings.requestChannelSettings();
        return;
      }
      if (session.viewKind === 'agentSettings') {
        globalSettings.requestChannelSettings();
        return;
      }
      globalSettings.requestChannelSettings();
      globalSettings.ensureAppearance();

      if (message.payload?.meta?.conversationId) {
        clientState.setCurrentConversation(message.payload.meta.conversationId);
      }
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ClientSnapshot, (message) => {
      if (!message.payload) return;
      const debug = compressionSnapshotDebug(message.payload.state);
      if (debug) logCompressionClientDebug('clientSnapshot.received', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, ...debug });
      clientState.applyClientSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
      conversationTimeline.applyClientStateSnapshot(message.payload.streamId, message.payload.streamSeq, message.payload.state);
      conversationCommands.observeClientSnapshot(message.payload);
      systemPromptStore.reconcilePendingSave();
      runtimeContextStore.reconcilePendingSave();
      if (debug) logCompressionClientDebug('clientSnapshot.applied', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq });
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ClientPatch, (message) => {
      if (!message.payload) return;
      const epoch = message.payload.transientStreamEpoch;
      if (epoch && conversationCommands.isStreamEpochTerminal(epoch.requestId, epoch.attemptId, epoch.generation)) {
        const conversationId = conversationIdFromClientStateStreamId(message.payload.streamId);
        console.warn('[LimCode][Reliability]', {
          kind: 'late_stream_patch_dropped',
          timestamp: Date.now(),
          ...(conversationId ? { conversationId } : {}),
          requestId: epoch.requestId,
          attemptId: epoch.attemptId,
          generation: epoch.generation,
          streamSeq: epoch.streamSeq,
          phase: 'frontend_transient_patch_admission',
          reasonCode: 'terminal_stream_epoch'
        });
        if (conversationId) conversationCommands.resyncConversation(conversationId);
        else bridge.request(BridgeMessageType.ClientResync, { streamId: message.payload.streamId });
        return;
      }
      const debug = compressionPatchDebug(message.payload.patches);
      if (debug) logCompressionClientDebug('clientPatch.received', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, ...debug });
      const applied = clientState.applyClientPatch(
        message.payload.streamId,
        message.payload.streamSeq,
        message.payload.patches
      );
      if (debug) logCompressionClientDebug('clientPatch.applyResult', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq, applied });
      if (applied) {
        conversationTimeline.applyClientStatePatch(message.payload.streamId, message.payload.streamSeq, message.payload.patches);
        systemPromptStore.reconcilePendingSave();
        runtimeContextStore.reconcilePendingSave();
      }
      if (!applied) {
        if (debug) logCompressionClientDebug('clientPatch.resync', { streamId: message.payload.streamId, streamSeq: message.payload.streamSeq });
        resync();
      }
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.CommandReceipt, (message) => {
      if (message.payload) conversationCommands.applyTransportReceipt(message.payload.commandId);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.CommandResult, (message) => {
      if (message.payload) conversationCommands.applyCommandResult(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.InteractionResult, (message) => {
      if (!message.payload) return;
      interactions.applyResult(message.payload, message.correlationId);
      conversationCommands.applyInteractionResult(message.payload, message.correlationId);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.CommandStatusResult, (message) => {
      if (message.payload) conversationCommands.applyStatusResult(message.payload, message.correlationId);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationHeadSnapshot, (message) => {
      if (message.payload) conversationCommands.applyHeadSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationCommittedPatch, (message) => {
      const payload = message.payload;
      if (!payload) return;
      settleCompressionRequestsFromPatch(payload);
      if (!conversationCommands.applyCommittedPatch(payload)) return;
      const patches = payload.operations as unknown as ClientPatchOp[];
      try {
        const stateApplied = clientState.applyCommittedConversationPatch(payload.streamId, patches);
        const timelineApplied = conversationTimeline.applyCommittedConversationPatch(payload.streamId, patches);
        if (!stateApplied || !timelineApplied) throw new Error(`Committed patch uses an invalid conversation stream: ${payload.streamId}`);
        conversationCommands.confirmCommittedPatch(payload);
      } catch (error) {
        console.error('[LimCode][Reliability] Failed to apply committed conversation patch.', error);
        conversationCommands.resyncConversation(payload.conversationId);
      }
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationTimelinePageSnapshot, (message) => {
      if (message.payload) conversationTimeline.applyPageSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationTimelinePatch, (message) => {
      if (message.payload) conversationTimeline.applyTimelinePatch(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.GlobalSettingsSnapshot, (message) => {
      if (message.payload) globalSettings.applySnapshot(message.payload, message.correlationId);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ConversationSettingsSnapshot, (message) => {
      if (message.payload) conversationSettings.applySnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.RunHistoryPageSnapshot, (message) => {
      if (message.payload) runHistory.applyPageSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.RunHistoryDetailSnapshot, (message) => {
      if (message.payload) runHistory.applyDetailSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.LlmDryRunSnapshot, (message) => {
      if (message.payload) runHistory.applyDryRunSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.LlmTransientNotice, (message) => {
      const payload = message.payload;
      if (!payload) return;
      const epoch = payload.transientStreamEpoch;
      if (epoch && conversationCommands.isStreamEpochTerminal(epoch.requestId, epoch.attemptId, epoch.generation)) {
        console.warn('[LimCode][Reliability]', {
          kind: 'late_stream_notice_dropped',
          timestamp: Date.now(),
          conversationId: payload.conversationId,
          requestId: epoch.requestId,
          attemptId: epoch.attemptId,
          generation: epoch.generation,
          streamSeq: epoch.streamSeq,
          phase: 'frontend_transient_notice_admission',
          reasonCode: 'terminal_stream_epoch'
        });
        return;
      }
      conversationUi.applyLlmTransientNotice(payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.ToolResultArtifactSnapshot, (message) => {
      if (message.payload) toolResults.applySnapshot(message.payload);
    }),
    bridge.on(BridgeMessageType.LlmProviderModelsSnapshot, (message) => {
      if (message.payload) globalSettings.applyLlmProviderModelsSnapshot(message.payload);
    })
  );

  disposers.push(
    bridge.on(BridgeMessageType.Error, (message) => {
      if (message.payload?.requestType === BridgeMessageType.ToolResultArtifactGet
        && toolResults.applyRequestError(message.correlationId, message.payload.message)) return;
      const failedCompressionRequest = takeCompressionRequestError(message.correlationId, message.payload?.requestType);
      if (failedCompressionRequest && message.payload) {
        logCompressionClientDebug('command.error', {
          requestId: failedCompressionRequest.requestId,
          requestType: failedCompressionRequest.requestType,
          conversationId: failedCompressionRequest.conversationId,
          message: message.payload.message
        });
        conversationCommands.resyncConversation(failedCompressionRequest.conversationId);
        if (failedCompressionRequest.conversationId === clientState.currentConversationId) {
          bridge.request(BridgeMessageType.ShowInfo, {
            message: `${compressionCommandLabel(failedCompressionRequest.requestType)}失败：${message.payload.message}`
          });
        }
        return;
      }
      if (
        message.payload?.requestType === BridgeMessageType.GlobalSettingsGet
        || message.payload?.requestType === BridgeMessageType.GlobalSettingsUpdate
        || message.payload?.requestType === BridgeMessageType.LlmProviderModelsGet
      ) {
        globalSettings.setError(message.payload.message, {
          requestType: message.payload.requestType,
          section: globalSettingsSectionFromScope(message.scope)
        });
      } else if (message.payload?.requestType === BridgeMessageType.ConversationTimelinePageGet) {
        conversationTimeline.setError(clientState.currentConversationId, message.payload.message);
      } else if (message.payload?.requestType === BridgeMessageType.RunHistoryPageGet || message.payload?.requestType === BridgeMessageType.RunHistoryDetailGet || message.payload?.requestType === BridgeMessageType.LlmDryRunGet) {
        runHistory.setError(message.payload.message);
      }
    })
  );

  // 当前对话 id 变化（Hello 指定 / 全局快照默认回落）时：订阅该对话数据流 + 读取对话设置。
  disposers.push(
    watch(
      () => clientState.currentConversationId,
      (conversationId) => {
        if ((session.viewKind !== 'chat' && session.viewKind !== 'planDetail') || !conversationId) return;
        conversationTimeline.setCurrentConversation(conversationId);
        ensureConversationStream(conversationId);
        conversationCommands.requestHead(conversationId);
        if (session.viewKind === 'chat' && conversationTimeline.ensureTimeline(conversationId).pageInfo === undefined) {
          conversationTimeline.requestInitial(conversationId);
        }
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

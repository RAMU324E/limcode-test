import * as vscode from 'vscode';
import type { Entity, World } from '../ecs/types';
import type { CommandCapability, FsCapability, LlmCapability, StorageCapability, WebviewCapability, FsPendingFileChangeProposal } from '../capabilities/types';
import { AgentRun } from '../world/modules/agentRun/components';
import { Conversation, LlmRequest, Message, PartOf } from '../world/modules/chat/components';
import { LlmInvocation, MessageLlmInvocationLink, RunLlmInvocationLink } from '../world/modules/llm/components';
import { buildLlmStartRequestForRun } from '../world/modules/chat/llmRequestPlanning';
import { CompressionModelContextProjectionLink, ModelContextProjection, RequestModelContextProjectionLink } from '../world/modules/modelContext/components';
import { CompressionBlock, CompressionBlockLlmInvocationLink } from '../world/modules/compression/components';
import { ToolEventType } from '../world/modules/tools/events';
import { PlanReviewEventType } from '../world/modules/plan/events';
import { ToolCall, ToolCallResultLink, ToolResultArtifact, ToolState } from '../world/modules/tools/components';
import { activeToolPolicyForRun, runForToolCall } from '../world/modules/agentRun/queries';
import { activeWorkEnvironmentForRun, pathAccessibleWorkEnvironmentsForRun, toPublicWorkEnvironmentRecord } from '../world/modules/workEnvironment/queries';
import { allowOutsideProjectPathsFromConfig } from '../world/modules/tools/definitions/filePathPolicy';
import { SkillEventType } from '../world/modules/skill/events';
import { WorkflowEventType } from '../world/modules/workflow/events';
import { WorkEnvironmentEventType } from '../world/modules/workEnvironment/events';
import { CheckpointEventType } from '../world/modules/checkpoint/events';
import { AgentEventType } from '../world/modules/agent/events';
import { RuntimeContextEventType } from '../world/modules/runtimeContext/events';
import { Checkpoint, ShadowRepository } from '../world/modules/checkpoint/components';
import { ModelProfile, ModelProfileScopeLink, type ModelProfileScopeLinkData } from '../world/modules/workflow/components';
import {
  BridgeMessageType,
  GLOBAL_CLIENT_STATE_STREAM_ID,
  GLOBAL_SETTINGS_SECTIONS,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  conversationTimelineStreamId,
  conversationSettingsStreamId,
  globalSettingsStreamId,
  createMessageId,
  type BackgroundProcessOutputGetPayload,
  type ChatModelOverrideRecord,
  type BridgeClientId,
  type CheckpointDiffOpenPayload,
  type CheckpointRestorePayload,
  type AttachmentOpenPayload,
  type AttachmentReloadPayload,
  type FsStatGetPayload,
  type FsStatResultEntry,
  type ToolDiffOpenPayload,
  type ToolResultArtifactGetPayload,
  type PlanProposalExportPayload,
  type ConversationTimelinePageRequest,
  type ConversationRunDetailRecord,
  type ConversationRunDetailRequest,
  type ConversationRunHistoryPageRecord,
  type ConversationRunHistoryPageRequest,
  type LlmProviderModelsGetPayload,
  type ProjectFolderCandidateRecord,
  type RuleScope,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { EXTENSION_BRAND } from '../../shared/extensionIdentity';
import type { ResolvedAttachmentInlineData } from '../capabilities/vscodeStorage/attachmentStore';

import type { GlobalSettingsBridge } from './GlobalSettingsBridge';
import type { ConversationSettingsBridge } from './ConversationSettingsBridge';
import type { SetConversationProjectFolderInput } from './BackendApplication';
import type { WebviewClientRegistry } from './WebviewClientRegistry';
import { getRuntimeBuildInfo } from './runtimeBuildInfo';

export interface WebviewMessageRouterDeps {
  world: World;
  webview: WebviewCapability;
  clients: WebviewClientRegistry;
  storage: StorageCapability;
  fs: FsCapability;
  llm: LlmCapability;
  command: CommandCapability;
  globalSettingsBridge: GlobalSettingsBridge;
  conversationSettingsBridge: ConversationSettingsBridge;
  isHydrated: () => boolean;
  isAuthoritativeStorageReady: () => boolean;
  requestSnapshot: (conversationId?: string) => void;
  requestPersist?: (reason: string) => void;
  ensureConversationDetailLoaded: (conversationId: string) => Promise<void>;
  ensureConversationTailLoaded: (conversationId: string) => Promise<void>;
  loadConversationTimelinePage: (request: ConversationTimelinePageRequest) => Promise<import('../../shared/protocol').ConversationTimelinePageRecord>;
  loadConversationRunHistoryPage: (request: ConversationRunHistoryPageRequest) => Promise<ConversationRunHistoryPageRecord>;
  loadConversationRunDetail: (request: ConversationRunDetailRequest) => Promise<ConversationRunDetailRecord | undefined>;
  resolveConversationRunIdForMessage: (conversationId: string, messageId: string) => Promise<string | undefined>;
  resolveAttachmentForClient: (input: AttachmentReloadPayload) => Promise<ResolvedAttachmentInlineData>;
  materializeAttachmentFileUri: (input: AttachmentOpenPayload) => Promise<vscode.Uri | undefined>;
  getProjectFolderCandidates: () => ProjectFolderCandidateRecord[];
  setConversationProjectFolder: (input: SetConversationProjectFolderInput) => boolean;
  importWorkEnvironmentsFromVscode: () => Promise<number>;
  refreshSkillCatalog: () => Promise<void>;
  refreshRulesCatalog: () => Promise<void>;
  saveRuleFile: (scope: RuleScope, content: string) => Promise<void>;
  applyToolChangeFromEditor: (conversationId: string, toolCallId: string) => Promise<void>;
}

/**
 * Webview -> backend 消息路由。
 * 只负责把 bridge message 分发到 chat/settings/control 等应用动作。
 */
export class WebviewMessageRouter {
  public constructor(private readonly deps: WebviewMessageRouterDeps) {}

  public handle(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case BridgeMessageType.ToolPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('toolPolicy.scope.set');
        break;
      case BridgeMessageType.ToolPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: ToolEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('toolPolicy.scope.clear');
        break;
      case BridgeMessageType.SkillPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: SkillEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('skillPolicy.scope.set');
        break;
      case BridgeMessageType.SkillPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: SkillEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('skillPolicy.scope.clear');
        break;
      case BridgeMessageType.SkillCatalogRefresh:
        if (!this.deps.isHydrated()) return;
        void this.deps.refreshSkillCatalog().catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法刷新技能目录。', message.id));
        break;
      case BridgeMessageType.RulesFileSave:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.deps.saveRuleFile(message.payload.scope, message.payload.content).catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法保存规则文件。', message.id));
        break;
      case BridgeMessageType.RulesCatalogRefresh:
        if (!this.deps.isHydrated()) return;
        void this.deps.refreshRulesCatalog().catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法刷新规则目录。', message.id));
        break;
      case BridgeMessageType.ToolDiffOpen:
        if (!this.deps.isHydrated() || !message.payload) return;
        void this.handleToolDiffOpen(message.payload).catch((error) => {
          const messageText = error instanceof Error ? error.message : '无法打开实时差异视图。';
          void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${messageText}`);
        });
        break;
      case BridgeMessageType.PlanProposalExport:
        if (!message.payload) return;
        void this.handlePlanProposalExport(message.payload).catch((error) => {
          const messageText = error instanceof Error ? error.message : '无法导出 Plan。';
          this.postRequestError(clientId, message.type, messageText, message.id);
          void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${messageText}`);
        });
        break;
      case BridgeMessageType.AgentCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Create, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.AgentUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Update, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.AgentDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.Delete, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ConversationAgentSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ConversationSelect, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.SystemPromptScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.SystemPromptScopeSet, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('systemPrompt.scope.set');
        break;
      case BridgeMessageType.SystemPromptScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.SystemPromptScopeClear, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('systemPrompt.scope.clear');
        break;
      case BridgeMessageType.RuntimeContextScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.ScopeSet, payload: message.payload });
        this.deps.requestSnapshot(message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.ScopeClear, payload: message.payload });
        this.deps.requestSnapshot(message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextRefresh:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.Refresh, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId ?? (message.payload.scopeKind === 'conversation' ? message.payload.scopeId : undefined));
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.RuntimeContextSnapshotClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: RuntimeContextEventType.SnapshotClear, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModelProfileScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ModelProfileScopeSet, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ModelProfileScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: AgentEventType.ModelProfileScopeClear, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkflowCreate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Create, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkflowUpdate:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Update, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkflowDelete:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.Delete, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ConversationWorkflowSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkflowEventType.ConversationSelect, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.ClientResync:
        this.handleClientResync(clientId, message.payload?.streamId, message.payload?.conversationId);
        break;
      case BridgeMessageType.ConversationTimelinePageGet:
        if (message.payload) void this.postConversationTimelinePage(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.ToolResultArtifactGet:
        if (message.payload) void this.postToolResultArtifact(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.RunHistoryPageGet:
        if (message.payload) void this.postRunHistoryPage(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.RunHistoryDetailGet:
        if (message.payload) void this.postRunHistoryDetail(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.LlmDryRunGet:
        if (message.payload) void this.postLlmDryRun(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.LlmProviderModelsGet:
        if (message.payload) void this.postLlmProviderModels(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.CheckpointGitStatusGet:
        void this.postCheckpointGitStatus(clientId, message.id);
        break;
      case BridgeMessageType.CheckpointShadowStatsGet:
        void this.postCheckpointShadowStats(clientId, message.id);
        break;
      case BridgeMessageType.CheckpointShadowDelete:
        if (message.payload) void this.handleCheckpointShadowDelete(clientId, message.payload.storageKeys, message.id);
        break;
      case BridgeMessageType.GlobalSettingsGet:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, globalSettingsStreamId(message.payload.section));
        void this.deps.globalSettingsBridge.postSnapshot(clientId, message.payload.section, message.id);
        break;
      case BridgeMessageType.GlobalSettingsUpdate:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, globalSettingsStreamId(message.payload.section));
        void this.deps.globalSettingsBridge.update(message.payload, message.id);
        break;
      case BridgeMessageType.ConversationSettingsGet:
        if (!message.payload) return;
        void this.deps.conversationSettingsBridge.postSnapshot(clientId, message.payload.conversationId, message.payload.section, message.id);
        break;
      case BridgeMessageType.ConversationSettingsUpdate:
        if (!message.payload) return;
        this.deps.webview.subscribe(clientId, conversationSettingsStreamId(message.payload.settings.conversationId ?? '', message.payload.section));
        void this.deps.conversationSettingsBridge.update(message.payload, message.id);
        break;
      case BridgeMessageType.ProjectFoldersGet:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.ProjectFoldersSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { folders: this.deps.getProjectFolderCandidates() }
        });
        break;
      case BridgeMessageType.ConversationProjectSet:
        if (!message.payload) return;
        if (!this.deps.setConversationProjectFolder(message.payload)) {
          this.deps.webview.post(clientId, {
            id: createMessageId(),
            type: BridgeMessageType.Error,
            channel: 'diagnostics',
            correlationId: message.id,
            payload: { requestType: message.type, message: '无法设置对话项目归属。' }
          });
        }
        break;
      case BridgeMessageType.WorkEnvironmentSelect:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.ConversationSelectRequested, payload: message.payload });
        this.deps.requestSnapshot(message.payload.conversationId);
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentUpsert:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.UpsertRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentRemove:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.RemoveRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentImportFromVscode:
        if (!this.deps.isHydrated()) return;
        void this.deps.importWorkEnvironmentsFromVscode().then(() => this.deps.requestSnapshot()).catch((error) => this.postRequestError(clientId, message.type, error instanceof Error ? error.message : '无法从 VS Code 导入工作环境。', message.id));
        break;
      case BridgeMessageType.WorkEnvironmentPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.WorkEnvironmentPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: WorkEnvironmentEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        break;
      case BridgeMessageType.PlanReviewPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('planReviewPolicy.scope.set');
        break;
      case BridgeMessageType.PlanReviewPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: PlanReviewEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('planReviewPolicy.scope.clear');
        break;
      case BridgeMessageType.CheckpointPolicyScopeSet:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeSetRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('checkpointPolicy.scope.set');
        break;
      case BridgeMessageType.CheckpointPolicyScopeClear:
        if (!this.deps.isHydrated() || !message.payload) return;
        this.deps.world.enqueue({ type: CheckpointEventType.PolicyScopeClearRequested, payload: message.payload });
        this.deps.requestSnapshot();
        this.deps.requestPersist?.('checkpointPolicy.scope.clear');
        break;
      case BridgeMessageType.CheckpointRestore:
        if (message.payload) void this.handleCheckpointRestore(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.CheckpointDiffOpen:
        if (message.payload) void this.handleCheckpointDiffOpen(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.AttachmentOpen:
        if (message.payload) void this.handleAttachmentOpen(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.AttachmentReload:
        if (message.payload) void this.postAttachmentReloadResult(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.Ready:
        this.sendBridgeHello(clientId, message.id);
        if (this.deps.clients.getOrUnknown(clientId).meta.kind === 'globalSettings') {
          // 流订阅不依赖 hydration 状态，提前注册可确保 hydration 完成后的快照不会丢失。
          // requestSnapshot 在未 hydrated 时自动排队，hydration 完成后由 flushPendingSnapshots 投递。
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            this.deps.webview.subscribe(clientId, globalSettingsStreamId(section));
          }
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
          if (!this.deps.isHydrated() || !this.deps.isAuthoritativeStorageReady()) break;
          // 仅在迁移与初始 hydration 都成功后推送可能物化默认值的 settings 快照。
          for (const section of GLOBAL_SETTINGS_SECTIONS) {
            void this.deps.globalSettingsBridge.postSnapshot(clientId, section, message.id);
          }
        } else {
          this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
          this.deps.requestSnapshot();
          if (!this.deps.isHydrated()) break;
        }
        break;
      case BridgeMessageType.Ping:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.Pong,
          channel: 'control',
          correlationId: message.id,
          payload: { text: message.payload?.text ?? 'pong', receivedAt: Date.now() }
        });
        break;
      case BridgeMessageType.GetWorkspaceInfo:
        this.deps.webview.post(clientId, {
          id: createMessageId(),
          type: BridgeMessageType.WorkspaceInfo,
          channel: 'control',

          correlationId: message.id,
          payload: {
            name: vscode.workspace.name ?? '',
            folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
          }
        });
        break;
      case BridgeMessageType.ShowInfo:
        if (message.payload?.message) void vscode.window.showInformationMessage(message.payload.message);
        break;
      case BridgeMessageType.FsStatGet:
        if (message.payload) void this.postFsStatResult(clientId, message.payload, message.id);
        break;
      case BridgeMessageType.BackgroundProcessOutputGet:
        if (message.payload) this.postBackgroundProcessOutputResult(clientId, message.payload, message.id);
        break;
      default:
        break;
    }
  }


  private postBackgroundProcessOutputResult(clientId: BridgeClientId, payload: BackgroundProcessOutputGetPayload, correlationId: string): void {
    const processId = payload.processId.trim();
    if (!processId) {
      this.postRequestError(clientId, BridgeMessageType.BackgroundProcessOutputGet, '缺少后台命令 processId。', correlationId);
      return;
    }
    const consume = payload.consume === true;
    const output = this.deps.command.readOutput(processId, { maxOutputLines: 1000, maxOutputChars: 100_000 }, { consume });
    const terminal = output.running === false || output.status === 'exited' || output.status === 'killed' || output.status === 'not_found';
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.BackgroundProcessOutputResult,
      channel: 'state',
      correlationId,
      payload: { ...output, processId, consumed: consume && terminal && output.status !== 'not_found' }
    });
  }
  private async postFsStatResult(clientId: BridgeClientId, payload: FsStatGetPayload, correlationId: string): Promise<void> {
    const resolvedPaths = resolveDroppedPaths(payload.paths ?? []);
    const results = await Promise.all(resolvedPaths.map((path) => statPath(path)));
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.FsStatResult,
      channel: 'control',
      correlationId,
      payload: { results }
    });
  }

  private async enqueueAfterConversationTailLoaded(conversationId: string, action: () => void): Promise<void> {
    try {
      await this.deps.ensureConversationTailLoaded(conversationId);
      action();
    } catch (error) {
      console.error('[LimCode] Conversation command blocked because committed tail hydration failed.', error);
    }
  }

  private handleClientResync(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    this.subscribeRequestedStream(clientId, streamId, conversationId);
    const requestedConversationId = conversationId ?? conversationIdFromClientStateStreamId(streamId ?? '');
    if (!requestedConversationId) {
      this.deps.requestSnapshot();
      return;
    }

    void this.enqueueAfterConversationTailLoaded(requestedConversationId, () => this.deps.requestSnapshot(requestedConversationId));
  }

  private async postToolResultArtifact(
    clientId: BridgeClientId,
    payload: ToolResultArtifactGetPayload,
    correlationId?: string
  ): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(payload.conversationId);
      const artifacts = this.deps.world.query(ToolResultArtifact)
        .map((entity) => this.deps.world.get(entity, ToolResultArtifact))
        .filter((artifact): artifact is NonNullable<typeof artifact> => artifact?.id === payload.artifactId);
      if (artifacts.length !== 1 || artifacts[0].conversationId !== payload.conversationId) {
        throw new Error(`ToolResult Artifact 不存在或不属于当前对话：${payload.artifactId}`);
      }
      const artifact = artifacts[0];
      const content = await this.deps.storage.loadToolResultContent(artifact);
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.ToolResultArtifactSnapshot,
        channel: 'state',
        scope: { kind: 'conversation', id: payload.conversationId },
        correlationId,
        payload: {
          conversationId: payload.conversationId,
          artifactId: artifact.id,
          contentHash: artifact.contentHash,
          content
        }
      });
    } catch (error) {
      this.postRequestError(
        clientId,
        BridgeMessageType.ToolResultArtifactGet,
        error instanceof Error ? error.message : '无法加载完整工具结果。',
        correlationId
      );
    }
  }

  private async postConversationTimelinePage(
    clientId: BridgeClientId,
    payload: ConversationTimelinePageRequest,
    correlationId?: string
  ): Promise<void> {
    try {
      this.deps.webview.subscribe(clientId, conversationTimelineStreamId(payload.conversationId));
      const page = await this.deps.loadConversationTimelinePage(payload);
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.ConversationTimelinePageSnapshot,
        channel: 'state',
        scope: { kind: 'conversation', id: payload.conversationId },
        correlationId,
        payload: page
      });
    } catch (error) {
      console.warn('[LimCode] Failed to load conversation timeline page.', error);
      this.postRequestError(clientId, BridgeMessageType.ConversationTimelinePageGet, '无法加载对话消息分页。', correlationId);
    }
  }

  private async postRunHistoryPage(
    clientId: BridgeClientId,
    payload: { conversationId: string; cursor?: string; limit?: number },
    correlationId?: string
  ): Promise<void> {
    try {
      const page = await this.deps.loadConversationRunHistoryPage(payload);
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.RunHistoryPageSnapshot,
        channel: 'state',
        correlationId,
        payload: page
      });
    } catch (error) {
      console.warn('[LimCode] Failed to load run history page.', error);
      this.postRequestError(clientId, BridgeMessageType.RunHistoryPageGet, '无法加载运行历史列表。', correlationId);
    }
  }

  private async postRunHistoryDetail(clientId: BridgeClientId, payload: { conversationId: string; runId?: string; messageId?: string }, correlationId?: string): Promise<void> {
    try {
      const detail = await this.deps.loadConversationRunDetail(payload);
      if (!detail) {
        this.postRequestError(clientId, BridgeMessageType.RunHistoryDetailGet, '无法找到该运行详情。', correlationId);
        return;
      }
      this.deps.webview.post(clientId, { id: createMessageId(), type: BridgeMessageType.RunHistoryDetailSnapshot, channel: 'state', correlationId, payload: detail });
    } catch (error) {
      console.warn('[LimCode] Failed to load run history detail.', error);
      this.postRequestError(clientId, BridgeMessageType.RunHistoryDetailGet, '无法加载运行详情。', correlationId);
    }
  }

  private async postLlmDryRun(clientId: BridgeClientId, payload: { conversationId: string; runId?: string; messageId?: string; invocationId?: string; compressionBlockId?: string; includeApiKey?: boolean }, correlationId?: string): Promise<void> {
    try {
      if (payload.compressionBlockId) {
        await this.postCompressionLlmDryRun(clientId, payload as { conversationId: string; compressionBlockId: string; invocationId?: string; includeApiKey?: boolean }, correlationId);
        return;
      }

      const runId = payload.runId ?? (payload.messageId ? await this.deps.resolveConversationRunIdForMessage(payload.conversationId, payload.messageId) : undefined);
      if (!runId) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法根据这条消息找到对应的 run。', correlationId);
        return;
      }

      await this.ensureRunDetailHydrated(payload.conversationId, runId);
      const run = this.findRunEntity(runId);
      if (run === undefined) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '当前会话中无法找到该 run，不能构建 dry-run 请求。', correlationId);
        return;
      }

      const invocation = this.findInvocationForDryRun({ run, messageId: payload.messageId, invocationId: payload.invocationId });
      if (invocation === undefined) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法找到本次 LLM 调用快照，不能构建历史 dry-run 请求。', correlationId);
        return;
      }

      const invocationData = this.deps.world.get(invocation, LlmInvocation);
      const originalRequestEntity = invocationData?.requestId
        ? this.deps.world.entityByRecordId(LlmRequest, invocationData.requestId)
        : undefined;
      const originalRequest = originalRequestEntity === undefined ? undefined : this.deps.world.get(originalRequestEntity, LlmRequest);
      const invocationMessageLinks = this.deps.world.query(MessageLlmInvocationLink)
        .map((entity) => this.deps.world.get(entity, MessageLlmInvocationLink))
        .filter((link): link is NonNullable<typeof link> => !!link && link.invocation === invocation && link.role === 'modelOutput');
      if (invocationMessageLinks.length > 1) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '历史 invocation 存在多个 modelMessage 关系，无法确定性重放。', correlationId);
        return;
      }
      const modelMessage = originalRequest?.modelMessage ?? invocationMessageLinks[0]?.message;
      const conversation = originalRequest?.conversation ?? (modelMessage === undefined ? undefined : this.deps.world.get(modelMessage, PartOf)?.parent);
      if (modelMessage === undefined || conversation === undefined) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '历史 invocation 缺少精确 Request/modelMessage 关系，已拒绝猜测最新消息。', correlationId);
        return;
      }
      const originalRequestId = invocationData?.requestId ?? originalRequest?.id;
      const projectionLinks = originalRequestId
        ? this.deps.world.query(RequestModelContextProjectionLink)
            .map((entity) => this.deps.world.get(entity, RequestModelContextProjectionLink))
            .filter((link): link is NonNullable<typeof link> => !!link && link.requestId === originalRequestId && link.role === 'input')
        : [];
      if (projectionLinks.length !== 1) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, `历史 Request 缺少唯一的 ModelContextProjection（找到 ${projectionLinks.length} 条），已拒绝从当前消息重算。`, correlationId);
        return;
      }
      const persistedProjection = this.deps.world.get(projectionLinks[0].projection, ModelContextProjection);
      if (!persistedProjection || persistedProjection.runId !== runId || persistedProjection.modelMessageId !== this.deps.world.get(modelMessage, Message)?.id) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '历史 ModelContextProjection 与 Run/modelMessage 身份不一致。', correlationId);
        return;
      }
      const request = buildLlmStartRequestForRun(this.deps.world, {
        run,
        conversation,
        modelMessage,
        invocation,
        requestId: `dryrun-${invocationData?.id ?? runId}-${Date.now()}`,
        contextContents: persistedProjection.contents
      });
      if (!request) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法从当前 ECS 状态构建本次 LLM 请求。', correlationId);
        return;
      }

      const dryRun = await this.deps.llm.dryRun(request, { includeApiKey: payload.includeApiKey === true });
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmDryRunSnapshot,
        channel: 'state',
        correlationId,
        payload: {
          conversationId: payload.conversationId,
          runId,
          ...(invocationData ? { invocationId: invocationData.id, settingsSnapshot: invocationData.settings } : {}),
          executionKind: 'single_request',
          calls: [{ ...dryRun, id: request.id, label: 'LLM Request', ordinal: 0 }],
          generatedAt: dryRun.generatedAt
        }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to dry-run LLM request.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, error instanceof Error ? error.message : '无法生成 LLM dry-run curl。', correlationId);
    }
  }

  private async postCompressionLlmDryRun(
    clientId: BridgeClientId,
    payload: { conversationId: string; compressionBlockId: string; invocationId?: string; includeApiKey?: boolean },
    correlationId?: string
  ): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(payload.conversationId);
      const blockEntity = this.findCompressionBlockEntity(payload.compressionBlockId);
      const block = blockEntity !== undefined ? this.deps.world.get(blockEntity, CompressionBlock) : undefined;
      if (blockEntity === undefined || !block) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '无法找到该压缩块，不能构建 dry-run 请求。', correlationId);
        return;
      }
      const projectionLinks = this.deps.world.query(CompressionModelContextProjectionLink)
        .map((entity) => this.deps.world.get(entity, CompressionModelContextProjectionLink))
        .filter((link): link is NonNullable<typeof link> => !!link && link.block === blockEntity && link.role === 'source');
      if (projectionLinks.length !== 1) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, `压缩块缺少唯一的 ModelContextProjection（找到 ${projectionLinks.length} 条）。`, correlationId);
        return;
      }
      const projection = this.deps.world.get(projectionLinks[0].projection, ModelContextProjection);
      if (!projection || projection.purposeKind !== 'compression' || projection.fingerprint !== block.sourceHash) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '压缩块与其不可变 ModelContextProjection 身份不一致。', correlationId);
        return;
      }
      if (!block.compressionConfigSnapshot) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '压缩块缺少不可变方法配置快照，已拒绝使用当前设置猜测。', correlationId);
        return;
      }
      const requiresProvider = block.methodKind !== 'deterministic_summary' && block.methodKind !== 'manual_summary';
      if (requiresProvider && !block.providerSettingsSnapshot) {
        this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, '压缩块缺少 Provider 设置快照，已拒绝使用当前渠道猜测。', correlationId);
        return;
      }

      const invocationEntity = this.findCompressionInvocation(blockEntity, payload.invocationId);
      const invocation = invocationEntity !== undefined ? this.deps.world.get(invocationEntity, LlmInvocation) : undefined;
      const request = {
        id: `dryrun-${block.id}-${Date.now()}`,
        blockId: block.id,
        conversationId: payload.conversationId,
        ...(invocation ? { invocationId: invocation.id } : {}),
        ...(block.methodConfigId ? { methodConfigId: block.methodConfigId } : {}),
        methodKind: block.methodKind,
        methodConfigSnapshot: block.compressionConfigSnapshot,
        ...(block.providerSettingsSnapshot ? { settingsSnapshot: block.providerSettingsSnapshot } : {}),
        contents: projection.contents,
        ...(projection.segments ? { segments: projection.segments } : {}),
        ...(projection.priorSummaryContents ? { priorSummaryContents: projection.priorSummaryContents } : {}),
        sourceHash: projection.fingerprint
      };

      const dryRun = await this.deps.llm.dryRunCompact(request, { includeApiKey: payload.includeApiKey === true });
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmDryRunSnapshot,
        channel: 'state',
        correlationId,
        payload: {
          conversationId: payload.conversationId,
          compressionBlockId: payload.compressionBlockId,
          ...(invocation ? { invocationId: invocation.id } : {}),
          ...(block.providerSettingsSnapshot ? { settingsSnapshot: block.providerSettingsSnapshot } : {}),
          executionKind: dryRun.kind === 'no_provider_call'
            ? 'no_provider_call'
            : dryRun.calls.length > 1 ? 'multiple_requests' : 'single_request',
          calls: dryRun.calls,
          ...(dryRun.note ? { note: dryRun.note } : {}),
          generatedAt: dryRun.generatedAt
        }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to dry-run compression LLM request.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmDryRunGet, error instanceof Error ? error.message : '无法生成压缩 LLM dry-run curl。', correlationId);
    }
  }



  private async postLlmProviderModels(clientId: BridgeClientId, payload: LlmProviderModelsGetPayload, correlationId?: string): Promise<void> {
    try {
      const models = await withTimeout(this.deps.llm.listModels(payload.config), 60_000, '获取模型列表超时，请检查 Base URL、API Key 或网络代理设置。');
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.LlmProviderModelsSnapshot,
        channel: 'state',
        correlationId,
        payload: {
          configId: payload.config.id,
          provider: payload.config.provider,
          baseUrl: payload.config.baseUrl,
          models
        }
      });
    } catch (error) {
      console.warn('[LimCode] Failed to fetch LLM provider models.', error);
      this.postRequestError(clientId, BridgeMessageType.LlmProviderModelsGet, error instanceof Error ? error.message : '无法获取模型列表。', correlationId);
    }
  }

  private async postCheckpointGitStatus(clientId: BridgeClientId, correlationId?: string): Promise<void> {
    try {
      const status = await this.deps.storage.detectSystemGit();
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.CheckpointGitStatusSnapshot,
        channel: 'state',
        correlationId,
        payload: { status }
      });
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointGitStatusGet, error instanceof Error ? error.message : '无法检测系统 Git。', correlationId);
    }
  }

  private async postCheckpointShadowStats(clientId: BridgeClientId, correlationId?: string): Promise<void> {
    try {
      const stats = await this.deps.storage.collectShadowWorktreeStats();
      this.deps.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.CheckpointShadowStatsSnapshot,
        channel: 'state',
        correlationId,
        payload: { stats }
      });
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointShadowStatsGet, error instanceof Error ? error.message : '无法读取 shadow 仓库统计。', correlationId);
    }
  }

  private async handleCheckpointShadowDelete(clientId: BridgeClientId, storageKeys: string[], correlationId?: string): Promise<void> {
    try {
      await this.deps.storage.deleteShadowWorktrees(storageKeys);
      await this.postCheckpointShadowStats(clientId, correlationId);
    } catch (error) {
      this.postRequestError(clientId, BridgeMessageType.CheckpointShadowDelete, error instanceof Error ? error.message : '无法删除 shadow 仓库。', correlationId);
    }
  }

  private async handleCheckpointRestore(clientId: BridgeClientId, payload: CheckpointRestorePayload, correlationId?: string): Promise<void> {
    try {
      const result = await this.deps.storage.restoreShadowCheckpoint(payload);
      if (result.status === 'restored') {
        void vscode.window.showInformationMessage(`${EXTENSION_BRAND} 回档完成：${result.message}`);
      } else {
        void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${result.message}`);
      }
      this.postCheckpointRestoreResult(clientId, payload, result, correlationId);
    } catch (error) {
      const result = { status: 'failed' as const, message: error instanceof Error ? error.message : '回档失败。' };
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${result.message}`);
      this.postCheckpointRestoreResult(clientId, payload, result, correlationId);
    }
  }

  private async handleToolDiffOpen(payload: ToolDiffOpenPayload): Promise<void> {
    if (payload.conversationId) await this.deps.ensureConversationDetailLoaded(payload.conversationId);
    const entity = this.findToolCallEntity(payload.toolCallId);
    const call = entity !== undefined ? this.deps.world.get(entity, ToolCall) : undefined;
    const state = entity !== undefined ? this.deps.world.get(entity, ToolState) : undefined;
    if (entity === undefined || !call || !state) {
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND} 无法找到该工具调用。`);
      return;
    }
    let rawResult = state.result;
    if (rawResult === undefined) {
      const links = this.deps.world.query(ToolCallResultLink)
        .map((linkEntity) => this.deps.world.get(linkEntity, ToolCallResultLink))
        .filter((link) => link?.toolCallId === call.id && link.role === 'final');
      if (links.length > 1) throw new Error(`工具 ${call.id} 存在多个 final 结果关系。`);
      const link = links[0];
      if (link) {
        const artifacts = this.deps.world.query(ToolResultArtifact)
          .map((artifactEntity) => this.deps.world.get(artifactEntity, ToolResultArtifact))
          .filter((artifact) => artifact?.id === link.artifactId);
        if (artifacts.length !== 1) throw new Error(`工具 ${call.id} 的结果 Artifact 缺失或冲突。`);
        rawResult = await this.deps.storage.loadToolResultContent(artifacts[0]!);
      }
    }
    const proposal = this.pendingFileChangeProposal(rawResult);
    if (!proposal) {
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND} 该工具调用没有可预览的文件变更提案。`);
      return;
    }

    const run = runForToolCall(this.deps.world, entity);
    const policy = run !== undefined ? activeToolPolicyForRun(this.deps.world, run) : undefined;
    const config = policy?.toolConfigs?.[call.name]?.config;
    const workEnvironment = run !== undefined ? activeWorkEnvironmentForRun(this.deps.world, run)?.data : undefined;
    const accessibleWorkEnvironments = run !== undefined
      ? pathAccessibleWorkEnvironmentsForRun(this.deps.world, run).map((item) => toPublicWorkEnvironmentRecord(item.data))
      : [];
    const result = await this.deps.fs.openPendingFileChangeDiff(proposal, {
      ...(workEnvironment ? { workEnvironment: toPublicWorkEnvironmentRecord(workEnvironment) } : {}),
      ...(accessibleWorkEnvironments.length > 0 ? { accessibleWorkEnvironments } : {}),
      allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(config, false),
      toolCallId: call.id,
      conversationId: payload.conversationId,
      onSave: async (event) => {
        const conversationId = event.conversationId ?? payload.conversationId;
        if (!conversationId) throw new Error('文件变更保存回调缺少 conversationId。');
        await this.deps.applyToolChangeFromEditor(conversationId, event.toolCallId ?? call.id);
      }
    });
    if (result.status === 'failed') void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${result.message}`);
  }

  private async handleCheckpointDiffOpen(clientId: BridgeClientId, payload: CheckpointDiffOpenPayload, correlationId?: string): Promise<void> {
    try {
      await this.deps.ensureConversationDetailLoaded(payload.conversationId);
      const checkpointEntity = this.findCheckpointEntity(payload.checkpointId);
      const checkpoint = checkpointEntity !== undefined ? this.deps.world.get(checkpointEntity, Checkpoint) : undefined;
      if (checkpointEntity === undefined || !checkpoint) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '无法找到该存档点。' }, correlationId);
        return;
      }
      const conversation = this.deps.world.get(checkpoint.conversation, Conversation);
      if (conversation?.id !== payload.conversationId) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '存档点不属于当前对话。' }, correlationId);
        return;
      }
      if (checkpoint.status !== 'created' || !checkpoint.commitSha) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: checkpoint.message ?? '该存档点没有可查看的 shadow commit。' }, correlationId);
        return;
      }
      const shadowRepository = this.deps.world.get(checkpoint.shadowRepository, ShadowRepository);
      if (!shadowRepository?.storageKey) {
        this.postCheckpointDiffOpenResult(clientId, payload, { status: 'failed', message: '未找到此存档点关联的 shadow 仓库。' }, correlationId);
        return;
      }

      const result = await this.deps.storage.openShadowCheckpointDiff({
        checkpointId: checkpoint.id,
        conversationId: conversation.id,
        shadowRepositoryStorageKey: shadowRepository.storageKey,
        commitSha: checkpoint.commitSha,
        projectUri: checkpoint.projectUri,
        filePath: payload.filePath
      });
      this.postCheckpointDiffOpenResult(clientId, payload, result, correlationId);
    } catch (error) {
      const result = { status: 'failed' as const, message: error instanceof Error ? error.message : '无法打开差异视图。' };
      this.postCheckpointDiffOpenResult(clientId, payload, result, correlationId);
    }
  }

  private postCheckpointRestoreResult(clientId: BridgeClientId, payload: CheckpointRestorePayload, result: { status: 'restored' | 'failed'; message: string; restoredFileCount?: number; removedFileCount?: number }, correlationId?: string): void {
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CheckpointRestoreResult,
      channel: 'command',
      correlationId,
      payload: { checkpointId: payload.checkpointId, conversationId: payload.conversationId, result }
    });
  }

  private postCheckpointDiffOpenResult(clientId: BridgeClientId, payload: CheckpointDiffOpenPayload, result: { status: 'opened' | 'failed'; message: string }, correlationId?: string): void {
    if (result.status === 'failed') void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${result.message}`);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.CheckpointDiffOpenResult,
      channel: 'command',
      correlationId,
      payload: { checkpointId: payload.checkpointId, conversationId: payload.conversationId, filePath: payload.filePath, status: result.status, message: result.message }
    });
  }

  private async handleAttachmentOpen(clientId: BridgeClientId, payload: AttachmentOpenPayload, correlationId?: string): Promise<void> {
    try {
      const uri = await this.deps.materializeAttachmentFileUri(payload);
      if (!uri) {
        this.postRequestError(clientId, BridgeMessageType.AttachmentOpen, '无法找到附件文件。', correlationId);
        return;
      }
      await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法打开附件。';
      this.postRequestError(clientId, BridgeMessageType.AttachmentOpen, message, correlationId);
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND} ${message}`);
    }
  }

  private async postAttachmentReloadResult(clientId: BridgeClientId, payload: AttachmentReloadPayload, correlationId?: string): Promise<void> {
    const result = await this.deps.resolveAttachmentForClient(payload);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.AttachmentReloadResult,
      channel: 'state',
      correlationId,
      payload: {
        request: payload,
        ...(result.part ? { part: result.part } : {}),
        status: result.status,
        ...(result.error ? { error: result.error } : {})
      }
    });
  }

  private findCheckpointEntity(checkpointId: string): number | undefined {
    return this.deps.world.entityByRecordId(Checkpoint, checkpointId);
  }

  private findToolCallEntity(toolCallId: string): number | undefined {
    const entity = this.deps.world.entityByRecordId(ToolCall, toolCallId);
    return entity !== undefined && this.deps.world.has(entity, ToolState) ? entity : undefined;
  }

  private pendingFileChangeProposal(result: unknown): FsPendingFileChangeProposal | undefined {
    const proposal = this.asPlainRecord(this.asPlainRecord(result)?.proposal);
    if (proposal?.kind !== 'file_change.proposal') return undefined;
    if (proposal.operation !== 'write' && proposal.operation !== 'edit') return undefined;
    if (typeof proposal.path !== 'string' || typeof proposal.baseContent !== 'string' || typeof proposal.targetContent !== 'string') return undefined;
    if (typeof proposal.baseExisted !== 'boolean' || !Array.isArray(proposal.applyHunks)) return undefined;
    return proposal as unknown as FsPendingFileChangeProposal;
  }

  private asPlainRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private async ensureRunDetailHydrated(conversationId: string, runId: string): Promise<void> {
    if (this.findRunEntity(runId) !== undefined) return;
    await this.deps.ensureConversationDetailLoaded(conversationId);
  }

  private findRunEntity(runId: string): number | undefined {
    return this.deps.world.entityByRecordId(AgentRun, runId);
  }

  private findInvocationForDryRun(input: { run: number; messageId?: string; invocationId?: string }): number | undefined {
    if (input.invocationId) {
      const direct = this.deps.world.entityByRecordId(LlmInvocation, input.invocationId);
      if (direct !== undefined) return direct;
    }

    if (input.messageId) {
      const message = this.deps.world.entityByRecordId(Message, input.messageId);
      if (message !== undefined) {
        const link = this.deps.world
          .query(MessageLlmInvocationLink)
          .map((entity) => this.deps.world.get(entity, MessageLlmInvocationLink))
          .find((candidate) => candidate?.message === message);
        if (link) return link.invocation;
      }
    }

    return this.deps.world
      .query(RunLlmInvocationLink)
      .map((entity) => this.deps.world.get(entity, RunLlmInvocationLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.run === input.run)
      .sort((left, right) => {
        const leftInvocation = this.deps.world.get(left.invocation, LlmInvocation);
        const rightInvocation = this.deps.world.get(right.invocation, LlmInvocation);
        return (rightInvocation?.createdAt ?? 0) - (leftInvocation?.createdAt ?? 0) || right.id.localeCompare(left.id);
      })[0]?.invocation;
  }


  private subscribeRequestedStream(clientId: BridgeClientId, streamId: string | undefined, conversationId: string | undefined): void {
    if (streamId) {
      this.deps.webview.subscribe(clientId, streamId);
      return;
    }
    if (conversationId) {
      this.deps.webview.subscribe(clientId, conversationClientStateStreamId(conversationId));
      return;
    }
    this.deps.webview.subscribe(clientId, GLOBAL_CLIENT_STATE_STREAM_ID);
  }

  private sendBridgeHello(clientId: BridgeClientId, correlationId?: string): void {
    const client = this.deps.clients.getOrUnknown(clientId);
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Hello,
      channel: 'control',
      correlationId,
      payload: {
        clientId,
        attachedAt: client.attachedAt,
        meta: client.meta,
        runtime: getRuntimeBuildInfo()
      }
    });
  }

  private findCompressionBlockEntity(blockId: string): number | undefined {
    return this.deps.world.entityByRecordId(CompressionBlock, blockId);
  }

  private findCompressionInvocation(block: number, invocationId?: string): number | undefined {
    if (invocationId) {
      const direct = this.deps.world.entityByRecordId(LlmInvocation, invocationId);
      if (direct !== undefined) return direct;
    }
    return this.deps.world
      .query(CompressionBlockLlmInvocationLink)
      .map((entity) => this.deps.world.get(entity, CompressionBlockLlmInvocationLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.block === block)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0]?.invocation;
  }

  private upsertConversationModelOverride(conversationId: string, input: ChatModelOverrideRecord | undefined): void {
    const model = input?.model?.trim();
    const scopeId = conversationId.trim();
    if (!scopeId || !model) return;
    const conversation = this.deps.world.entityByRecordId(Conversation, scopeId);
    if (conversation === undefined) return;
    const now = Date.now();
    const existing = this.latestConversationModelProfileLink(conversation, scopeId);
    const profile = existing?.link.modelProfile ?? this.deps.world.spawn();
    const profileId = existing ? this.deps.world.get(profile, ModelProfile)?.id ?? modelProfileIdForConversation(scopeId) : modelProfileIdForConversation(scopeId);
    this.deps.world.add(profile, ModelProfile, {
      id: profileId,
      name: '对话临时模型',
      ...(input?.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
      ...(input?.provider ? { provider: input.provider } : {}),
      model
    });
    if (existing) {
      this.deps.world.add(existing.entity, ModelProfileScopeLink, { ...existing.link, conversation, scopeId, modelProfile: profile, updatedAt: now });
      return;
    }
    const link = this.deps.world.spawn();
    this.deps.world.add(link, ModelProfileScopeLink, {
      id: modelProfileScopeLinkIdForConversation(scopeId),
      scopeKind: 'conversation',
      scopeId,
      conversation,
      modelProfile: profile,
      role: 'active',
      createdAt: now,
      updatedAt: now
    });
  }

  private latestConversationModelProfileLink(conversation: Entity, scopeId: string): { entity: Entity; link: ModelProfileScopeLinkData } | undefined {
    return this.deps.world
      .query(ModelProfileScopeLink)
      .map((entity) => ({ entity, link: this.deps.world.get(entity, ModelProfileScopeLink) }))
      .filter((item): item is { entity: Entity; link: ModelProfileScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === 'conversation' && (item.link.conversation === conversation || item.link.scopeId === scopeId))
      .sort((left, right) => (right.link.updatedAt || right.link.createdAt) - (left.link.updatedAt || left.link.createdAt) || right.entity - left.entity)[0];
  }

  private async handlePlanProposalExport(payload: PlanProposalExportPayload): Promise<void> {
    const markdown = payload.markdown.trim();
    if (!markdown) {
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND}: 没有可导出的 Plan 内容。`);
      return;
    }

    const fileName = safeMarkdownFileName(payload.suggestedFileName ?? 'plan.md');
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const target = await vscode.window.showSaveDialog({
      title: '导出 Plan Markdown',
      saveLabel: '导出 Plan',
      ...(workspaceFolder ? { defaultUri: vscode.Uri.joinPath(workspaceFolder.uri, fileName) } : {}),
      filters: {
        Markdown: ['md'],
        'All Files': ['*']
      }
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(ensureTrailingNewline(markdown), 'utf8'));
    const targetPath = target.scheme === 'file' ? target.fsPath : target.toString(true);
    void vscode.window.showInformationMessage(`${EXTENSION_BRAND}: Plan 已导出到 ${targetPath}`);
  }

  private postRequestError(clientId: BridgeClientId, requestType: string, message: string, correlationId?: string): void {
    this.deps.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      correlationId,
      payload: { requestType, message }
    });
  }
}

function modelProfileIdForConversation(conversationId: string): string { return `model-profile:conversation:${conversationId}`; }
function modelProfileScopeLinkIdForConversation(conversationId: string): string { return `model-profile-scope:conversation:${conversationId}`; }

function safeMarkdownFileName(input: string): string {
  const safe = input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, '')
    .slice(0, 120)
    .trim();
  const base = safe || 'plan';
  return base.toLowerCase().endsWith('.md') ? base : `${base}.md`;
}

function ensureTrailingNewline(input: string): string {
  return input.endsWith('\n') ? input : `${input}\n`;
}


async function statPath(path: string): Promise<FsStatResultEntry> {
  try {
    const uri = vscode.Uri.file(path);
    const stat = await vscode.workspace.fs.stat(uri);
    const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    return { path: normalizePath(path), isDirectory, exists: true };
  } catch {
    return { path: normalizePath(path), isDirectory: false, exists: false };
  }
}

/**
 * 从 webview 拖拽数据中解析出去重的绝对路径。
 *
 * webview 传来的 paths 是 dataTransfer 各 type 的原始 getData 结果，
 * 可能包含 file:// URI、VS Code 内部 JSON payload、纯文本路径等。
 * 这里统一提取出绝对路径并去重。
 */
function resolveDroppedPaths(rawValues: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const raw of rawValues) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    collectPathsFromPayload(trimmed, candidates);
  }
  return uniquePaths(candidates);
}

function collectPathsFromPayload(value: string, output: string[]): void {
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      collectPathsFromJson(JSON.parse(value), output, 0);
      return;
    } catch {
      collectEmbeddedUris(value, output);
      return;
    }
  }
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') {
        output.push(parsed);
        return;
      }
    } catch {
      // fall through
    }
  }
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    output.push(trimmed);
  }
}

function collectPathsFromJson(value: unknown, output: string[], depth: number): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathsFromJson(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const scheme = typeof record.scheme === 'string' ? record.scheme : undefined;
  const path = typeof record.path === 'string' ? record.path : undefined;
  if (scheme && path) {
    output.push(path);
  }
  for (const key of ['fsPath', 'path', 'resource', 'uri', 'external', 'file', 'target', 'originalResource']) {
    if (key in record) collectPathsFromJson(record[key], output, depth + 1);
  }
}

function collectEmbeddedUris(value: string, output: string[]): void {
  for (const match of value.matchAll(/(?:file|vscode-remote|vscode-vfs):\/\/[^"'\]\},\s]+/gi)) {
    output.push(match[0]);
  }
  for (const match of value.matchAll(/"(?:fsPath|path|uri)"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/gi)) {
    try {
      output.push(JSON.parse(`"${match[1]}"`) as string);
    } catch {
      if (match[1]) output.push(match[1]);
    }
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const normalized = normalizePath(raw);
    if (!normalized || !looksLikeAbsolutePath(normalized)) continue;
    const key = normalized.replace(/\/+$/, '').toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizePath(value: string): string {
  let path = value.trim();
  // file:// URI → path
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      path = decodeURIComponent(path.replace(/^file:\/\//i, ''));
    }
  }
  // /f:/... → f:/...
  path = path.replace(/^\/([A-Za-z]:[\\/])/, '$1');
  // f://... → f:/...
  path = path.replace(/^([A-Za-z]):?\/\/(.+)$/, (_m, drive: string, rest: string) => `${drive.toUpperCase()}:/${rest.replace(/^\/+/, '')}`);
  // 统一为正斜杠
  path = path.replace(/\\/g, '/');
  // 去掉多余斜杠（保留 drive 冒号后的一个）
  path = path.replace(/^([A-Za-z]:)\/+/, '$1/').replace(/\/{2,}/g, '/');
  // 去掉尾部斜杠
  path = path.replace(/\/+$/, '');
  return path;
}

function looksLikeAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\//.test(value);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

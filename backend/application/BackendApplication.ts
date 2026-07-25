import * as vscode from 'vscode';
import { MapWorld } from '../ecs/World';
import { Scheduler } from '../ecs/Scheduler';
import type { ComponentType, Entity } from '../ecs/types';
import { ClientSyncEventType } from '../world/clientSync/events';
import { EffectOutbox, type WorldEffect } from '../world/effects';
import { requestSpawnAgent } from '../world/modules';
import { installProductionWorld } from '../world/productionWorld';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../world/modules/agent/components';
import {
  Conversation,
  ConversationBranchLink,
  ConversationFullContextLoaded,
  ConversationFullContextPending,
  ConversationOriginLink,
  ConversationReuseLink,
  ConversationTimeline,
  LlmRequest,
  Message,
  MessageCurrentRevisionLink,
  MessageRevision,
  PartOf
} from '../world/modules/chat/components';
import type { MessageData } from '../world/modules/chat/components';
import { ChatEventType } from '../world/modules/chat/events';
import { OpenConversationPanelIdsKey } from '../world/modules/chat/resources';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageTurnLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunWorkflowLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../world/modules/agentRun/components';
import { setConversationProject } from '../world/modules/project/bundles';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { upsertDefaultWorkflowSelection } from '../world/modules/workflow/bundles';
import { ConversationWorkflowSelection, ModelProfile, ModelProfileScopeLink, type ModelProfileScopeLinkData } from '../world/modules/workflow/components';
import { ToolCall, ToolCallEvent } from '../world/modules/tools/components';
import { WorkEnvironmentEventType, workEnvironmentIdFromUri } from '../world/modules/workEnvironment';
import { BackgroundProcessSnapshotKey } from '../world/modules/backgroundProcess/resources';
import type { LocalWorkEnvironmentCandidate } from '../world/modules/workEnvironment';
import { ClientStateContributorsKey, ClientSyncStateKey, CommittedConversationHeadsKey } from '../world/clientSync/resources';
import { projectClientState } from '../world/clientSync/projection';
import { CLIENT_STATE_TABLE_KEYS } from '../../shared/clientStateSchema';
import { EffectHandlerRegistry, registerApplicationEffectHandlers } from './effectHandlers';
import { flushEffects, flushEffectsWhere } from './executeEffects';
import type { RuntimeEnv } from './RuntimeEnv';
import type { StorageDataResetResult } from '../capabilities/types';
import { BridgeMessageType, GLOBAL_SETTINGS_SECTIONS, conversationClientStateStreamId, createMessageId } from '../../shared/protocol';
import type {
  AgentRunStatus,
  AttachmentOpenPayload,
  AttachmentReloadPayload,
  CheckpointMaintenanceSettingsRecord,
  BridgeClientId,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ClientState,
  ConversationLlmSettingsRecord,
  ConversationRunDetailRecord,
  ConversationRunDetailRequest,
  ConversationRunHistoryPageRecord,
  ConversationRunHistoryPageRequest,
  ConversationTimelinePageRecord,
  ConversationTimelinePageRequest,
  LlmProviderKind,
  MessageContent,
  ProjectFolderCandidateRecord,
  ConversationOriginLinkRecord,
  RuleScope,
  SidebarHistoryScopeKind,
  SidebarConversationHistoryEntry,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../shared/protocol';
import { createRuntimeEnv, recordsForTools, schemasForTools } from './createRuntimeEnv';
import { dedupeMcpToolNames } from './mcpRuntimeManager';
import { createDefaultAgentSpawnRequest, DEFAULT_AGENT_ID } from './defaults';
import {
  hydrateClientStateSkeleton,
  hydrateConversationDetail
} from './clientStateHydration';
import { ClientStatePersistence } from './ClientStatePersistence';
import { GlobalSettingsBridge } from './GlobalSettingsBridge';
import { ConversationSettingsBridge } from './ConversationSettingsBridge';
import { WebviewClientRegistry } from './WebviewClientRegistry';
import { WebviewMessageRouter } from './WebviewMessageRouter';
import { createNewConversationTitle, displayConversationTitle } from '../../shared/conversationTitle';
import { isInternalMessage } from '../../shared/messagePresentation';
import { loadRemoteServerWorkEnvironmentRecordsFromVscode } from './workEnvironments/vscodeSshImport';
import { McpToolSourcesKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey, ToolSchemasKey } from '../world/modules/tools/resources';
import { SkillCatalogKey } from '../world/modules/skill/resources';
import { RulesCatalogKey } from '../world/modules/rules/resources';
import { conversationDetailEvictionBlocker, evictConversationDetail } from './conversationDetailEviction';
import { materializeForkRelationsInWorld } from './conversationFork';
import { AskUserAttentionTracker, askUserAttentionMessage, collectPendingAskUserAttention } from './askUserAttention';
import { ConversationAttentionTracker, type ConversationAttentionRequest } from './conversationAttention';
import { PlanReviewAttentionTracker, collectPendingPlanReviewAttention, planReviewAttentionMessage } from './planReviewAttention';
import { canPrepareConversationForSidebarOpen, historyEntryWithLiveRunState, type ConversationRunHistoryRuntimeSummary } from './conversationHistoryRuntime';
import { nextAuxiliaryId, stableIds } from '../reliability/stableIdFactory';
import { DurableFileSystem, DataRootOwnerManager } from '../reliability/fileDurability';
import { RuntimeAuthorityAdapter, factsToClientState } from '../reliability/runtimeAuthorityStore';
import { compileEffectiveTurnAuthority } from '../reliability/authorityCompiler';
import { requireCanonicalManagedAttachmentData } from '../reliability/attachmentResource';
import { ATTACHMENT_STORAGE_RESOURCE_KEY } from '../reliability/storagePathAuthority';
import {
  materializeAttachmentFileUri as materializeResolvedAttachmentFileUri,
  resolveAttachmentForClient as resolveAttachmentReferenceForClient,
  type ResolvedAttachmentInlineData
} from '../capabilities/vscodeStorage/attachmentStore';
import {
  projectConversationRunDetail,
  projectConversationRunHistoryPage,
  resolveConversationRunIdForMessage as resolveRunIdForMessageProjection
} from '../reliability/derived/runHistoryProjection';
import { projectConversationTimelinePage } from '../reliability/derived/timelinePageProjection';
import { FileConversationTransactionBackend } from '../reliability/fileConversationTransactionBackend';
import {
  ReliabilityDiagnosticJournal,
  ReliabilityInspector,
  type ReliabilityInspectionSnapshot
} from '../reliability/reliabilityInspector';
import { ConversationCommandGateway, type HostTurnInterruptResult } from '../reliability/conversationCommandGateway';
import { CommittedConversationWorldProjection, CommittedHeadOnlyWorldProjection, CommittedMultiConversationWorldProjection, rehydrateCommittedFacts } from '../reliability/conversationWorldProjection';
import { PrimaryEffectDispatcher } from '../reliability/primaryEffectDispatcher';
import { BackgroundProcessDeliveryDispatcher } from '../reliability/backgroundProcessDeliveryDispatcher';
import type { StoragePaths } from '../capabilities/vscodeStorage/clientStateStore';
import type { ConversationId, ToolCallId } from '../../shared/stableIds';
import type { CommandServiceError } from '../../shared/conversationReliability';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import { CHECKPOINT_FEATURE_ENABLED } from '../../shared/featureFlags';
import { requiresHydratedStorage, shouldDeferUntilHydrated } from './startupHydrationAdmission';
import { committedReadView } from '../reliability/domain/internalHandlers';

const MAX_WARM_CLOSED_CONVERSATIONS = 3;
const USER_ATTENTION_NOTIFICATION_ACTION = '打开标签页';
const OPEN_PANEL_COMMAND = EXTENSION_COMMAND_IDS.openPanel;

export interface CreateConversationOptions {
  projectFolderUri?: string;
}

export interface SetConversationProjectFolderInput {
  conversationId: string;
  folderUri: string;
  name?: string;
}

/**
 * 后端应用组合根（composition root）。
 * 只负责组装 ECS world、runtime capability、effect handlers 与 VS Code/Webview 对外门面。
 */
export class BackendApplication {
  private readonly world = new MapWorld();
  private readonly outbox = new EffectOutbox();
  private readonly env: RuntimeEnv;
  private readonly scheduler: Scheduler;
  private readonly effectHandlers = new EffectHandlerRegistry();
  private readonly persistence: ClientStatePersistence;
  private readonly globalSettingsBridge: GlobalSettingsBridge;
  private readonly conversationSettingsBridge: ConversationSettingsBridge;
  private readonly webviewClients = new WebviewClientRegistry();
  private readonly webviewRouter: WebviewMessageRouter;
  private readonly askUserAttentionTracker = new AskUserAttentionTracker();
  private readonly planReviewAttentionTracker = new PlanReviewAttentionTracker();
  private reliabilityBackend: FileConversationTransactionBackend | undefined;
  private reliabilityAdapter: RuntimeAuthorityAdapter | undefined;
  private reliabilityInspector: ReliabilityInspector | undefined;
  private conversationCommands: ConversationCommandGateway | undefined;
  private primaryEffectDispatcher: PrimaryEffectDispatcher | undefined;
  private backgroundProcessDeliveryDispatcher: BackgroundProcessDeliveryDispatcher | undefined;
  private reliabilityUnavailableError: Error | undefined;
  private storageStartupNoticeShown = false;
  private dataRootChangeInProgress = false;
  /** True only after migration, recovery, initial hydration and long-lived process reconciliation succeed. */
  private authoritativeStorageReady = false;
  private hydrated = false;
  private resolveHydrated: () => void = () => undefined;
  private readonly hydratedReady = new Promise<void>((resolve) => { this.resolveHydrated = resolve; });
  private deferredSkeletonReady: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | undefined;
  private disposing = false;
  private pendingGlobalSnapshot = false;
  private readonly pendingSnapshotConversationIds = new Set<string>();
  private readonly pendingHydrationMessages: Array<{ clientId: BridgeClientId; message: WebviewToExtensionMessage }> = [];
  private readonly pendingDeferredSkeletonMessages: Array<{ clientId: BridgeClientId; message: WebviewToExtensionMessage }> = [];
  private deferredSkeletonComplete = false;
  private readonly renderLoadedConversationDetails = new Set<string>();
  private readonly runHistoryLoadedConversationDetails = new Set<string>();
  private readonly conversationTailLoaded = new Set<string>();
  private readonly conversationTailLoadInFlight = new Map<string, Promise<void>>();
  private readonly conversationDetailLoadInFlight = new Map<string, Promise<void>>();
  private readonly conversationContextLoadInFlight = new Set<string>();
  /** 从旧到新排列；仅记录最后一个主面板已经关闭的 conversation。 */
  private readonly recentClosedConversationIds: string[] = [];
  /** 冷卸载后仅保留历史列表摘要，避免重命名等轻量更新把预览误写为空。 */
  private readonly coldConversationHistoryEntries = new Map<string, SidebarConversationHistoryEntry>();
  /** 删除请求一旦开始即成为本进程内 tombstone，阻止旧历史卡片或延迟加载复活同一 ID。 */
  private readonly deletedConversationIds = new Set<string>();
  private readonly conversationDeletionInFlight = new Map<string, Promise<boolean>>();
  private readonly conversationEvictionGeneration = new Map<string, number>();
  private conversationEvictionInFlight: string | undefined;
  private readonly conversationHistoryChangedEmitter = new vscode.EventEmitter<void>();
  private readonly pendingConversationHistoryRefreshes = new Set<string>();
  private conversationHistoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private conversationHistoryRefreshTail: Promise<void> = Promise.resolve();
  private readonly disposables: vscode.Disposable[] = [];
  private backgroundProcessProjectionAttached = false;
  public readonly onDidChangeConversationHistory = this.conversationHistoryChangedEmitter.event;

  public constructor(context: vscode.ExtensionContext) {
    const runtimeSetup = createRuntimeEnv(context);
    const { env, toolSchemas, toolDefinitions } = runtimeSetup;
    this.env = env;
    runtimeSetup.installAttachmentResolver(async (input) => {
      const resolved = await this.resolveAttachmentReference(input);
      if (resolved.status !== 'available') throw new Error(resolved.error ?? '附件不可用。');
      return resolved.part;
    });
    this.world.setResource(OpenConversationPanelIdsKey, []);
    this.env.mcp.setStateChangeListener(() => this.syncMcpRuntimeResources());
    this.persistence = new ClientStatePersistence(this.world, this.env.storage);
    this.globalSettingsBridge = new GlobalSettingsBridge({
      storage: this.env.storage,
      webview: this.env.webview,
      beforeDataRootChange: () => this.prepareDataRootChange(),
      afterDataRootChange: () => this.commitDataRootChange(),
      dataRootChangeFailed: () => this.recoverDataRootChange(),
      beforeUpdate: (payload) => this.beforeGlobalSettingsUpdate(payload),
      afterUpdate: (payload) => this.afterGlobalSettingsUpdate(payload)
    });
    this.conversationSettingsBridge = new ConversationSettingsBridge({
      world: this.world,
      storage: this.env.storage,
      webview: this.env.webview,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId),
      renameConversation: (conversationId, title) => this.renameConversationTitle(conversationId, title),
      afterRead: (stored) => this.afterConversationSettingsRead(stored),
      afterUpdate: (stored) => this.afterConversationSettingsUpdate(stored)
    });
    this.webviewRouter = new WebviewMessageRouter({
      world: this.world,
      webview: this.env.webview,
      clients: this.webviewClients,
      storage: this.env.storage,
      fs: this.env.fs,
      llm: this.env.llm,
      command: this.env.command,
      globalSettingsBridge: this.globalSettingsBridge,
      conversationSettingsBridge: this.conversationSettingsBridge,
      isHydrated: () => this.hydrated,
      isAuthoritativeStorageReady: () => this.authoritativeStorageReady,
      requestSnapshot: (conversationId) => this.requestSnapshot(conversationId),
      requestPersist: (reason) => this.requestPersistSoon(reason),
      ensureConversationDetailLoaded: (conversationId) => this.ensureConversationDetailLoaded(conversationId),
      ensureConversationTailLoaded: (conversationId) => this.ensureConversationTailLoaded(conversationId),
      loadConversationTimelinePage: (request) => this.loadCommittedTimelinePage(request),
      loadConversationRunHistoryPage: (request) => this.loadCommittedRunHistoryPage(request),
      loadConversationRunDetail: (request) => this.loadCommittedRunDetail(request),
      resolveConversationRunIdForMessage: (conversationId, messageId) => this.resolveCommittedRunIdForMessage(conversationId, messageId),
      resolveAttachmentForClient: (input) => this.resolveAttachmentReference(input),
      materializeAttachmentFileUri: (input) => this.materializeAttachmentFile(input),
      getProjectFolderCandidates: () => this.getProjectFolderCandidates(),
      setConversationProjectFolder: (input) => this.setConversationProjectFolder(input),
      importWorkEnvironmentsFromVscode: () => this.importWorkEnvironmentsFromVscode(),
      refreshSkillCatalog: () => this.syncSkillCatalogResource(),
      refreshRulesCatalog: () => this.syncRulesCatalogResource(),
      saveRuleFile: (scope, content) => this.saveRuleFile(scope, content),
      applyToolChangeFromEditor: async (conversationId, toolCallId) => {
        const gateway = this.conversationCommands;
        if (!gateway) throw new Error('可靠 conversation transaction backend 尚未就绪。');
        await gateway.applyToolChangeFromEditor(conversationId as ConversationId, toolCallId as ToolCallId);
      }
    });

    registerApplicationEffectHandlers(this.effectHandlers);
    this.registerConversationContextEffectHandler();
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      // The final deferred-hydration pass re-reads the current workspace. Do not let an early VS Code
      // event start catalog or persistence work while Stable ID migration owns the source inventory.
      if (!this.authoritativeStorageReady) return;
      this.syncWorkEnvironmentsFromWorkspaceFolders();
      void this.syncSkillCatalogResource();
      void this.syncRulesCatalogResource();
    }));

    this.scheduler = new Scheduler(this.world, {
      applyEffect: (effect) => this.outbox.push(effect as WorldEffect),
      afterPass: () => {
        flushEffectsWhere(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers, isPassFlushEffect);
      },
      afterTick: () => {
        flushEffects(this.outbox, this.env, (event) => this.world.enqueue(event), this.effectHandlers);
        this.notifyPendingUserAttention();
        this.persistence.queuePersistIfSkeletonChanged();
        this.conversationHistoryChangedEmitter.fire();
        this.processConversationDetailEvictions();
      }
    }, {
      parallelWorkers: true,
      workerPoolSize: 2
    });

    installProductionWorld(
      { world: this.world, scheduler: this.scheduler },
      { toolSchemas, toolDefinitions, toolRuntimeDefinitions: this.env.tools.registry }
    );
    // Compile the exact production graph before hydration or Bridge command admission. A broken
    // graph must fail activation explicitly rather than leaving safe-point callers pending forever.
    this.scheduler.prepare();

    void this.initializeClientState();
  }

  /** 由外部显式请求生成 Agent，并链接到已经提交的独立 Conversation。 */
  public requestAgentSpawn(request: AgentSpawnRequestData): void {
    const conversationId = request.conversationId.trim();
    if (!conversationId || this.findConversationEntity(conversationId) === undefined) {
      throw new Error(`Agent spawn requires an existing committed Conversation: ${conversationId || '<empty>'}`);
    }
    requestSpawnAgent(this.world, { ...request, conversationId });
  }

  /** 先提交独立 Conversation aggregate，再创建 Agent/Project 等独立关系对象。 */
  public async createConversation(options: CreateConversationOptions = {}): Promise<string> {
    await this.waitUntilHydrated();
    this.requireAuthoritativeStorage();
    const gateway = this.conversationCommands;
    if (!gateway) throw new Error('可靠 conversation transaction backend 尚未就绪。');

    const conversationId = stableIds.nextConversationId();
    const title = createNewConversationTitle();
    await gateway.createConversation(conversationId, title);
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) throw new Error(`已提交的 Conversation 未投影到 ECS：${conversationId}`);

    const now = Date.now();
    const origin = this.world.spawn();
    this.world.add(origin, ConversationOriginLink, {
      id: nextAuxiliaryId('col'),
      conversation,
      originKind: 'user',
      sourceKind: 'user',
      createdAt: now,
      updatedAt: now
    });

    const agent = this.findDefaultAgent();
    if (agent === undefined) {
      requestSpawnAgent(this.world, createDefaultAgentSpawnRequest(conversationId));
    } else {
      const link = this.world.spawn();
      this.world.add(link, AgentConversationLink, {
        id: nextAuxiliaryId('acl'),
        agent,
        conversation,
        role: 'default',
        createdAt: now,
        updatedAt: now
      });

      const selection = this.world.spawn();
      const agentRecord = this.world.get(agent, Agent);
      this.world.add(selection, ConversationAgentSelection, {
        id: `conversation-agent:${conversationId}:${agentRecord?.id ?? DEFAULT_AGENT_ID}`,
        conversation,
        agent,
        role: 'active',
        createdAt: now,
        updatedAt: now
      });
      upsertDefaultWorkflowSelection(this.world, conversation, conversationId);
    }

    const projectFolder = this.resolveProjectFolderForNewConversation(options.projectFolderUri);
    if (projectFolder) setConversationProject(this.world, { conversation, uri: projectFolder.uri, name: projectFolder.name });

    this.renderLoadedConversationDetails.add(conversationId);
    this.runHistoryLoadedConversationDetails.add(conversationId);
    this.conversationTailLoaded.add(conversationId);
    this.persistence.queuePersist();
    this.requestSnapshot();
    void this.upsertConversationHistoryEntry(conversationId)
      .catch((error) => console.warn('[LimCode] Failed to persist new conversation history entry.', error));
    return conversationId;
  }

  /** 从已提交源 timeline 创建独立 fork aggregate，再物化跨领域 Link。 */
  public async forkConversation(sourceConversationId: string, messageId: string): Promise<string> {
    const normalizedSourceId = sourceConversationId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSourceId || !normalizedMessageId) throw new Error('缺少源对话或目标消息。');

    await this.waitUntilHydrated();
    this.requireAuthoritativeStorage();
    await this.ensureConversationDetailLoaded(normalizedSourceId);
    const gateway = this.conversationCommands;
    if (!gateway) throw new Error('可靠 conversation transaction backend 尚未就绪。');

    const conversationId = stableIds.nextConversationId();
    await gateway.forkConversation(
      normalizedSourceId as ConversationId,
      conversationId,
      normalizedMessageId
    );
    materializeForkRelationsInWorld(this.world, {
      sourceConversationId: normalizedSourceId,
      targetConversationId: conversationId,
      throughMessageId: normalizedMessageId
    });

    this.renderLoadedConversationDetails.add(conversationId);
    this.runHistoryLoadedConversationDetails.add(conversationId);
    this.conversationTailLoaded.add(conversationId);
    await this.copyConversationSettings(normalizedSourceId, conversationId);

    this.persistence.queuePersist();
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    return conversationId;
  }

  /** 侧边栏只读投影：按最近消息时间排序的对话历史列表。 */
  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    const messagesByConversation = this.collectMessagesByConversation();
    const agentNamesByConversation = this.collectAgentNamesByConversation();
    const runSummariesByConversation = this.collectRunSummariesByConversation();
    const projectsByConversation = this.collectProjectsByConversation();
    const entries: SidebarConversationHistoryEntry[] = [];

    for (const entity of this.world.query(Conversation)) {
      const conversation = this.world.get(entity, Conversation);
      if (!conversation?.id || conversation.visibility === 'hidden') continue;
      const timeline = this.world.get(entity, ConversationTimeline);
      if (!timeline) throw new Error(`Conversation ${conversation.id} has no ConversationTimeline.`);
      const messages = messagesByConversation.get(entity) ?? [];
      const latest = latestMessage(messages);
      const agentName = agentNamesByConversation.get(entity);
      const runSummary = runSummariesByConversation.get(entity);
      const project = projectsByConversation.get(entity);
      const preview = latest ? messagePreview(latest) : '暂无消息，点击开始新的交流。';
      const entry: SidebarConversationHistoryEntry = {
        id: conversation.id,
        title: displayConversationTitle({ id: conversation.id, title: conversation.title, messages }),
        preview,
        messageCount: messages.length,
        status: latest?.status ?? 'empty',
        createdAt: timeline.createdAt,
        isRunning: !!runSummary,
        updatedAt: Math.max(timeline.createdAt, timeline.lastActivityAt, latest?.createdAt ?? 0)
      };
      const previewState = latest ? aiPreviewState(latest) : undefined;
      if (previewState) entry.previewState = previewState;
      if (agentName) entry.agentName = agentName;
      if (project) {
        entry.projectFolderUri = project.uri;
        entry.projectName = project.name;
      }
      if (runSummary) {
        entry.runStatus = runSummary.status;
        entry.runStatusLabel = runSummary.label;
        entry.updatedAt = Math.max(entry.updatedAt ?? 0, runSummary.updatedAt);
      }
      entries.push(entry);
    }

    return entries
      .filter((entry) => entry.title && !this.deletedConversationIds.has(entry.id))
      .sort(compareConversationHistoryEntries);
  }

  public getConversationDisplayTitle(conversationId: string | undefined): string {
    if (!conversationId) return EXTENSION_BRAND;
    const entity = this.findConversationEntity(conversationId);
    if (entity === undefined) return displayConversationTitle({ id: conversationId });
    const conversation = this.world.get(entity, Conversation);
    if (!conversation) return displayConversationTitle({ id: conversationId });

    const messages = this.collectMessagesByConversation().get(entity) ?? [];
    return displayConversationTitle({ id: conversation.id, title: conversation.title, messages });
  }

  /** 侧边栏打开历史会话前的唯一入口；hydration 完成后绝不凭陈旧卡片创建缺失会话。 */
  public prepareConversationForSidebarOpen(conversationId: string, title?: string): boolean {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return false;
    const deleted = this.deletedConversationIds.has(normalizedConversationId);
    const existing = this.findConversationEntity(normalizedConversationId);
    if (!canPrepareConversationForSidebarOpen({ hydrated: this.hydrated, deleted, exists: existing !== undefined })) return false;
    if (!this.hydrated) return true;
    void title;
    return existing !== undefined && this.world.get(existing, Conversation)?.visibility !== 'hidden';
  }

  public ensureConversationPlaceholder(conversationId: string, title?: string): boolean {
    const normalizedConversationId = conversationId.trim();
    void title;
    return !!normalizedConversationId
      && !this.deletedConversationIds.has(normalizedConversationId)
      && this.findConversationEntity(normalizedConversationId) !== undefined;
  }

  public async renameConversationTitle(conversationId: string, title: string): Promise<boolean> {
    const normalizedConversationId = conversationId.trim();
    const normalizedTitle = normalizeConversationTitle(title);
    if (!normalizedConversationId || !normalizedTitle || this.deletedConversationIds.has(normalizedConversationId)) return false;
    await this.waitUntilHydrated();
    const gateway = this.conversationCommands;
    if (!gateway) throw this.reliabilityUnavailableError ?? new Error('可靠 conversation transaction backend 尚未就绪。');
    return gateway.renameConversationFromHost(normalizedConversationId as ConversationId, normalizedTitle);
  }

  public deleteConversation(conversationId: string): Promise<boolean> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return Promise.resolve(false);
    const existing = this.conversationDeletionInFlight.get(normalizedConversationId);
    if (existing) return existing;

    const deletion = this.deleteConversationInternal(normalizedConversationId);
    this.conversationDeletionInFlight.set(normalizedConversationId, deletion);
    const clear = (): void => {
      if (this.conversationDeletionInFlight.get(normalizedConversationId) === deletion) {
        this.conversationDeletionInFlight.delete(normalizedConversationId);
      }
    };
    void deletion.then(clear, clear);
    return deletion;
  }

  private async deleteConversationInternal(conversationId: string): Promise<boolean> {
    await this.waitUntilHydrated();
    await this.deferredSkeletonReady;
    const gateway = this.conversationCommands;
    if (!gateway) throw this.reliabilityUnavailableError ?? new Error('可靠 conversation transaction backend 尚未就绪。');
    const committed = await gateway.deleteConversationFromHost(conversationId as ConversationId);
    if (!committed) return false;

    // The durable tombstone and Run graph termination are already committed. Everything below is a
    // rebuildable process/read-model cleanup and must never turn the domain result back into failure.
    this.deletedConversationIds.add(conversationId);
    this.renderLoadedConversationDetails.delete(conversationId);
    this.runHistoryLoadedConversationDetails.delete(conversationId);
    this.conversationTailLoaded.delete(conversationId);
    this.coldConversationHistoryEntries.delete(conversationId);
    this.removeRecentClosedConversation(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
    this.requestSnapshot();
    this.requestSnapshot(conversationId);
    this.conversationHistoryChangedEmitter.fire();
    void this.cleanupDeletedConversationReadModels(conversationId);
    return true;
  }

  private async cleanupDeletedConversationReadModels(conversationId: string): Promise<void> {
    try {
      await this.scheduler.waitForIdle();
      await this.persistence.persistImmediately({ force: true, throwOnError: true });
      await this.env.storage.removeConversationHistoryEntry(conversationId);
    } catch (error) {
      console.warn(`[LimCode][Reliability] Conversation ${conversationId} was deleted durably, but read-model cleanup failed.`, error);
    }
  }

  public async abortConversation(conversationId: string, requestId?: string): Promise<HostTurnInterruptResult> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || this.deletedConversationIds.has(normalizedConversationId)) {
      return { status: 'already_satisfied', reason: 'conversation_not_available' };
    }
    await this.waitUntilHydrated();
    const gateway = this.conversationCommands;
    if (!gateway) throw this.reliabilityUnavailableError ?? new Error('可靠 conversation transaction backend 尚未就绪。');
    return gateway.cancelConversationFromHost(normalizedConversationId as ConversationId, requestId);
  }

  public getProjectFolderCandidates(): ProjectFolderCandidateRecord[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index
    }));
  }

  public setConversationProjectFolder(input: SetConversationProjectFolderInput): boolean {
    const conversation = this.findConversationEntity(input.conversationId);
    if (conversation === undefined) return false;

    const candidate = this.projectFolderCandidateForUri(input.folderUri);
    const uri = candidate?.uri ?? input.folderUri.trim();
    if (!uri) return false;

    setConversationProject(this.world, {
      conversation,
      uri,
      name: input.name ?? candidate?.name ?? projectFolderNameFromUri(uri)
    });
    void this.upsertConversationHistoryEntry(input.conversationId);
    this.requestSnapshot();
    this.requestSnapshot(input.conversationId);
    return true;
  }

  /** 当前 active data root；可能是 VS Code 默认 globalStorageUri，也可能是用户配置的自定义目录。 */
  public getStorageRootUri(): vscode.Uri {
    return this.env.storage.paths.globalStorageUri;
  }

  /**
   * Stops every writer, archives only LimCode-managed data, stamps the current epoch and leaves the
   * process unavailable until VS Code reloads. This is intentionally a reset, not an old-format migration.
   */
  public async resetDevelopmentData(): Promise<StorageDataResetResult> {
    await this.hydratedReady;
    if (this.dataRootChangeInProgress) throw new Error('数据根操作正在进行中。');
    this.dataRootChangeInProgress = true;
    this.reliabilityUnavailableError = codedError('migration_required', '正在归档并重置开发数据；重载窗口前命令入口保持关闭。');

    const dispatcher = this.primaryEffectDispatcher;
    const backend = this.reliabilityBackend;
    this.conversationCommands = undefined;
    this.primaryEffectDispatcher = undefined;
    this.reliabilityBackend = undefined;
    this.reliabilityAdapter = undefined;
    this.reliabilityInspector = undefined;

    await dispatcher?.dispose();
    await backend?.quiesce();
    await this.persistence.suspend();
    await backend?.dispose();
    await this.scheduler.stopAndDrain();
    await this.env.mcp.dispose();
    return this.env.storage.resetDataRoot({ archive: true });
  }

  public getConversationHistoryRootUri(): vscode.Uri {
    return this.env.storage.paths.conversationHistoryRootUri;
  }

  public async inspectReliability(conversationId?: string): Promise<ReliabilityInspectionSnapshot> {
    await this.hydratedReady;
    const inspector = this.reliabilityInspector;
    if (!inspector) throw this.reliabilityUnavailableError ?? new Error('可靠存储 inspector 尚未就绪。');
    const scope = conversationId?.trim();
    return inspector.snapshot(scope ? scope as ConversationId : undefined);
  }

  public attachWebview(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    const clientId = this.env.webview.attach(webview, meta);
    this.webviewClients.register(clientId, meta);
    const conversationId = mainPanelConversationId(meta);
    if (conversationId) {
      this.markConversationOpened(conversationId);
      this.syncOpenConversationPanelPresence(conversationId);
    }
    return clientId;
  }

  public ensureConversationTailLoaded(conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || this.deletedConversationIds.has(normalizedConversationId) || this.isConversationTailLoaded(normalizedConversationId)) return Promise.resolve();

    const existing = this.conversationTailLoadInFlight.get(normalizedConversationId);
    if (existing) return existing;

    const load = this.loadConversationTail(normalizedConversationId);
    this.conversationTailLoadInFlight.set(normalizedConversationId, load);
    const clear = (): void => {
      if (this.conversationTailLoadInFlight.get(normalizedConversationId) === load) {
        this.conversationTailLoadInFlight.delete(normalizedConversationId);
        this.processConversationDetailEvictions();
      }
    };
    void load.then(clear, clear);
    return load;
  }

  private isConversationTailLoaded(conversationId: string): boolean {
    if (this.conversationTailLoaded.has(conversationId)) return true;
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return false;
    const loaded = this.world.has(conversation, ConversationFullContextLoaded)
      || this.world.query(Message, PartOf).some((entity) => this.world.get(entity, PartOf)?.parent === conversation);
    if (loaded) this.conversationTailLoaded.add(conversationId);
    return loaded;
  }

  private async loadConversationTail(conversationId: string): Promise<void> {
    if (this.deletedConversationIds.has(conversationId)) return;
    const page = await this.loadCommittedTimelinePage({
      conversationId,
      direction: 'initial',
      chunkCount: 1
    });
    if (this.deletedConversationIds.has(conversationId)) return;
    if (this.findConversationEntity(conversationId) === undefined) {
      throw new Error(`Timeline page has no committed Conversation projection: ${conversationId}`);
    }
    if (page.state.messages.length > 0) {
      await hydrateConversationDetail(this.world, page.state, conversationId);
    }
    this.conversationTailLoaded.add(conversationId);
  }

  public ensureConversationDetailLoaded(conversationId: string): Promise<void> {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId || this.deletedConversationIds.has(normalizedConversationId)) return Promise.resolve();
    if (this.renderLoadedConversationDetails.has(normalizedConversationId)) {
      this.markConversationFullContextLoaded(normalizedConversationId);
      return Promise.resolve();
    }

    const existing = this.conversationDetailLoadInFlight.get(normalizedConversationId);
    if (existing) return existing;

    const load = this.loadConversationDetail(normalizedConversationId);
    this.conversationDetailLoadInFlight.set(normalizedConversationId, load);
    const clear = (): void => {
      if (this.conversationDetailLoadInFlight.get(normalizedConversationId) === load) {
        this.conversationDetailLoadInFlight.delete(normalizedConversationId);
        this.processConversationDetailEvictions();
      }
    };
    void load.then(clear, clear);
    return load;
  }

  private async loadConversationDetail(conversationId: string): Promise<void> {
    if (!this.hydrated) await this.waitUntilHydrated();
    if (this.deletedConversationIds.has(conversationId)) return;
    if (this.renderLoadedConversationDetails.has(conversationId)) {
      this.markConversationFullContextLoaded(conversationId);
      return;
    }

    const detail = await this.loadCommittedConversationClientState(conversationId);
    if (this.deletedConversationIds.has(conversationId)) return;
    if (this.findConversationEntity(conversationId) === undefined) {
      throw new Error(`Conversation detail has no committed aggregate projection: ${conversationId}`);
    }
    const hydrated = await hydrateConversationDetail(this.world, detail, conversationId);
    if (!hydrated) throw new Error(`Committed Conversation detail could not be hydrated: ${conversationId}`);
    this.primeConversationStreamState(conversationId, detail);
    this.renderLoadedConversationDetails.add(conversationId);
    this.coldConversationHistoryEntries.delete(conversationId);
    this.markConversationFullContextLoaded(conversationId);
  }

  public getCurrentProjectHistoryScope(): ConversationHistoryScope {
    const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeEditorUri ? vscode.workspace.getWorkspaceFolder(activeEditorUri) : undefined;
    if (activeFolder) return { kind: 'project', folderUri: activeFolder.uri.toString() };

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length > 0) return { kind: 'project', folderUri: folders[0].uri.toString() };
    return { kind: 'unbound' };
  }

  public async getConversationHistoryPage(input: { scopeKind: SidebarHistoryScopeKind; projectFolderUri?: string; cursor?: string; limit?: number }): Promise<ConversationHistoryPageRecord> {
    await this.waitUntilHydrated();
    this.requireAuthoritativeStorage();
    const scope = this.resolveHistoryScope(input.scopeKind, input.projectFolderUri);
    const page = await this.env.storage.loadConversationHistoryPage({ scope, cursor: input.cursor, limit: input.limit });
    return this.mergeLiveConversationHistoryPage(page, scope);
  }

  private resolveHistoryScope(scopeKind: SidebarHistoryScopeKind, projectFolderUri: string | undefined): ConversationHistoryScope {
    if (scopeKind === 'all') return { kind: 'all' };
    if (scopeKind === 'unbound') return { kind: 'unbound' };
    if (scopeKind === 'project' && projectFolderUri?.trim()) return { kind: 'project', folderUri: projectFolderUri.trim() };
    return this.getCurrentProjectHistoryScope();
  }

  private mergeLiveConversationHistoryPage(page: ConversationHistoryPageRecord, scope: ConversationHistoryScope): ConversationHistoryPageRecord {
    const runSummariesById = new Map<string, ConversationRunHistoryRuntimeSummary>();
    for (const [entity, summary] of this.collectRunSummariesByConversation()) {
      const conversationId = this.world.get(entity, Conversation)?.id;
      if (conversationId && !this.deletedConversationIds.has(conversationId)) runSummariesById.set(conversationId, summary);
    }

    const entriesById = new Map<string, SidebarConversationHistoryEntry>();
    let changed = false;
    let removedStoredCount = 0;
    for (const stored of page.entries) {
      if (this.deletedConversationIds.has(stored.id)) {
        changed = true;
        removedStoredCount += 1;
        continue;
      }
      const summary = runSummariesById.get(stored.id);
      const normalized = historyEntryWithLiveRunState(stored, summary);
      if (JSON.stringify(stored) !== JSON.stringify(normalized)) changed = true;
      entriesById.set(normalized.id, normalized);
    }

    const liveEntries = this.getConversationHistoryEntries()
      .filter((entry) => this.isConversationHistorySummaryComplete(entry.id) && (historyEntryMatchesScope(entry, scope) || entriesById.has(entry.id)));
    const isFirstPage = page.pageInfo.pageIndex === 0;
    for (const entry of liveEntries) {
      if (!isFirstPage && !entriesById.has(entry.id)) continue;
      const existing = entriesById.get(entry.id);
      const scopedEntry = existing && !historyEntryMatchesScope(entry, scope)
        ? { ...entry, projectFolderUri: existing.projectFolderUri, projectName: existing.projectName }
        : entry;
      if (existing && JSON.stringify(existing) === JSON.stringify(scopedEntry)) continue;
      entriesById.set(entry.id, scopedEntry);
      changed = true;
    }
    if (!changed) return page;

    const nominalPageSize = Math.max(page.pageInfo.pageSize || 0, page.entries.length || 0, 1);
    const entries = [...entriesById.values()].sort(compareConversationHistoryEntries);
    const visibleEntries = isFirstPage ? entries.slice(0, nominalPageSize) : entries;
    const visibleEntryIds = new Set(visibleEntries.map((entry) => entry.id));
    const originLinksByConversationId = new Map(page.originLinks.map((link) => [link.conversationId, link]));
    for (const [conversationId, originLink] of this.collectConversationOriginLinksById()) {
      if (visibleEntryIds.has(conversationId)) originLinksByConversationId.set(conversationId, originLink);
    }

    return {
      ...page,
      entries: visibleEntries,
      originLinks: [...originLinksByConversationId.values()].filter((link) => visibleEntryIds.has(link.conversationId)),
      pageInfo: {
        ...page.pageInfo,
        total: Math.max(Math.max(0, page.pageInfo.total - removedStoredCount), visibleEntries.length)
      }
    };
  }

  private isConversationHistorySummaryComplete(conversationId: string): boolean {
    return this.renderLoadedConversationDetails.has(conversationId);
  }

  private async resolveAttachmentReference(input: AttachmentReloadPayload): Promise<ResolvedAttachmentInlineData> {
    return resolveAttachmentReferenceForClient(
      this.env.storage.paths,
      input,
      (attachmentId) => this.loadCanonicalManagedAttachment(attachmentId)
    );
  }

  private async materializeAttachmentFile(input: AttachmentOpenPayload): Promise<vscode.Uri | undefined> {
    return materializeResolvedAttachmentFileUri(
      this.env.storage.paths,
      input,
      (attachmentId) => this.loadCanonicalManagedAttachment(attachmentId)
    );
  }

  private async loadCanonicalManagedAttachment(attachmentId: string): Promise<import('../../shared/protocol').InlineDataPart> {
    const backend = this.reliabilityBackend;
    if (!backend) throw this.reliabilityUnavailableError ?? new Error('可靠 attachment resource backend 尚未就绪。');
    const files = new DurableFileSystem(this.env.storage.paths.globalStoragePath);
    return backend.readStorageResource(
      [ATTACHMENT_STORAGE_RESOURCE_KEY],
      () => requireCanonicalManagedAttachmentData(files, attachmentId)
    );
  }

  private async loadCommittedTimelinePage(request: ConversationTimelinePageRequest): Promise<ConversationTimelinePageRecord> {
    const gateway = this.conversationCommands;
    if (!gateway) throw this.reliabilityUnavailableError ?? new Error('可靠 conversation transaction backend 尚未就绪。');
    return projectConversationTimelinePage(
      await gateway.readCommittedConversationFacts(request.conversationId as ConversationId),
      request
    );
  }

  private async loadCommittedRunHistoryPage(request: ConversationRunHistoryPageRequest): Promise<ConversationRunHistoryPageRecord> {
    return projectConversationRunHistoryPage(
      await this.loadCommittedConversationClientState(request.conversationId),
      request
    );
  }

  private async loadCommittedRunDetail(request: ConversationRunDetailRequest): Promise<ConversationRunDetailRecord | undefined> {
    const state = await this.loadCommittedConversationClientState(request.conversationId);
    const runId = request.runId
      ?? (request.messageId ? resolveRunIdForMessageProjection(state, request.conversationId, request.messageId) : undefined);
    return runId ? projectConversationRunDetail(state, request.conversationId, runId) : undefined;
  }

  private async resolveCommittedRunIdForMessage(conversationId: string, messageId: string): Promise<string | undefined> {
    const state = await this.loadCommittedConversationClientState(conversationId);
    return resolveRunIdForMessageProjection(state, conversationId, messageId);
  }

  private async loadCommittedConversationClientState(conversationId: string): Promise<ClientState> {
    const gateway = this.conversationCommands;
    if (!gateway) throw this.reliabilityUnavailableError ?? new Error('可靠 conversation transaction backend 尚未就绪。');
    const facts = await gateway.readCommittedConversationFacts(conversationId as ConversationId);
    return factsToClientState(facts);
  }

  private collectConversationOriginLinksById(): Map<string, ConversationOriginLinkRecord> {
    const result = new Map<string, ConversationOriginLinkRecord>();
    for (const [entity, originLink] of this.collectConversationOriginsByConversation()) {
      const conversation = this.world.get(entity, Conversation);
      if (conversation?.id) result.set(conversation.id, originLink);
    }
    return result;
  }


  private async refreshConversationHistoryReadModel(conversationId: string): Promise<void> {
    const entity = this.findConversationEntity(conversationId);
    const conversation = entity === undefined ? undefined : this.world.get(entity, Conversation);
    if (!conversation || conversation.visibility === 'hidden' || this.deletedConversationIds.has(conversationId)) {
      await this.env.storage.removeConversationHistoryEntry(conversationId);
    } else {
      await this.upsertConversationHistoryEntry(conversationId);
    }
    this.conversationHistoryChangedEmitter.fire();
  }

  private async upsertConversationHistoryEntry(conversationId: string): Promise<void> {
    if (this.deletedConversationIds.has(conversationId)) return;
    const projected = this.getConversationHistoryEntries().find((candidate) => candidate.id === conversationId);
    if (!projected) return;
    const retained = this.coldConversationHistoryEntries.get(conversationId);
    const entry = retained && !this.isConversationHistorySummaryComplete(conversationId)
      ? {
          ...retained,
          ...projected,
          preview: retained.preview,
          messageCount: retained.messageCount,
          status: retained.status,
          updatedAt: Math.max(retained.updatedAt ?? 0, projected.updatedAt ?? 0),
          ...(retained.previewState ? { previewState: retained.previewState } : {})
        }
      : projected;
    const conversationEntity = this.findConversationEntity(conversationId);
    const originLink = conversationEntity === undefined
      ? undefined
      : this.collectConversationOriginsByConversation().get(conversationEntity);
    await this.env.storage.upsertConversationHistoryEntry(entry, originLink);
  }


  public waitUntilHydrated(): Promise<void> {
    return this.hydrated ? Promise.resolve() : this.hydratedReady;
  }

  private registerConversationContextEffectHandler(): void {
    this.effectHandlers.register('conversation.context.load', (effect) => {
      this.scheduleConversationContextLoad(effect.conversationId);
    });
  }

  private scheduleConversationContextLoad(conversationId: string): void {
    if (!conversationId || this.deletedConversationIds.has(conversationId) || this.conversationContextLoadInFlight.has(conversationId)) return;
    this.conversationContextLoadInFlight.add(conversationId);
    setTimeout(() => {
      void this.ensureConversationDetailLoaded(conversationId)
        .catch((error) => {
          console.warn('[LimCode] Failed to hydrate conversation context for LLM.', error);
        })
        .finally(() => {
          this.conversationContextLoadInFlight.delete(conversationId);
          this.clearConversationFullContextPending(conversationId);
          this.requestSnapshot(conversationId);
        });
    }, 0);
  }

  private markConversationFullContextLoaded(conversationId: string): void {
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return;
    this.conversationTailLoaded.add(conversationId);
    this.world.add(conversation, ConversationFullContextLoaded, { loadedAt: Date.now() });
    this.world.remove(conversation, ConversationFullContextPending);
  }

  private clearConversationFullContextPending(conversationId: string): void {
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return;
    this.world.remove(conversation, ConversationFullContextPending);
  }

  public detachWebview(clientId: BridgeClientId): void {
    const registration = this.webviewClients.get(clientId);
    const releasedStreamIds = this.env.webview.detach(clientId);
    this.webviewClients.unregister(clientId);
    if (releasedStreamIds.length > 0) {
      this.world.enqueue({
        type: ClientSyncEventType.StreamsReleased,
        payload: { streamIds: releasedStreamIds }
      });
    }

    const conversationId = registration ? mainPanelConversationId(registration.meta) : undefined;
    if (conversationId) {
      this.syncOpenConversationPanelPresence(conversationId);
      if (!this.hasOpenConversationPanel(conversationId)) this.rememberRecentlyClosedConversation(conversationId);
      this.persistence.queuePersist();
    }
  }

  private notifyPendingUserAttention(): void {
    this.notifyPendingConversationAttention(
      this.askUserAttentionTracker,
      collectPendingAskUserAttention(this.world),
      askUserAttentionMessage
    );
    this.notifyPendingConversationAttention(
      this.planReviewAttentionTracker,
      collectPendingPlanReviewAttention(this.world),
      planReviewAttentionMessage
    );
  }

  private notifyPendingConversationAttention<TRequest extends ConversationAttentionRequest & { conversationTitle?: string }>(
    tracker: ConversationAttentionTracker<TRequest>,
    requests: readonly TRequest[],
    createMessage: (request: TRequest) => string
  ): void {
    for (const request of tracker.takeNew(requests)) {
      void vscode.window.showInformationMessage(
        createMessage(request),
        USER_ATTENTION_NOTIFICATION_ACTION
      ).then((selection) => {
        if (selection !== USER_ATTENTION_NOTIFICATION_ACTION) return undefined;
        return vscode.commands.executeCommand(OPEN_PANEL_COMMAND, {
          conversationId: request.conversationId,
          ...(request.conversationTitle ? { title: request.conversationTitle } : {}),
          reuse: true
        });
      }).then(undefined, (error) => {
        console.warn('[LimCode] Failed to open the conversation awaiting user input.', error);
      });
    }
  }

  private syncOpenConversationPanelPresence(changedConversationId: string): void {
    const conversationIds = [...new Set(
      this.env.webview.clientRecords()
        .map((client) => mainPanelConversationId(client.meta))
        .filter((conversationId): conversationId is string => !!conversationId)
    )].sort();
    this.world.setResource(OpenConversationPanelIdsKey, conversationIds);
    this.world.enqueue({
      type: ChatEventType.ConversationPanelPresenceChanged,
      payload: { conversationId: changedConversationId, open: conversationIds.includes(changedConversationId) }
    });
  }

  private markConversationOpened(conversationId: string): void {
    this.removeRecentClosedConversation(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
  }

  private rememberRecentlyClosedConversation(conversationId: string): void {
    if (this.findConversationEntity(conversationId) === undefined) return;
    this.removeRecentClosedConversation(conversationId);
    this.recentClosedConversationIds.push(conversationId);
    this.bumpConversationEvictionGeneration(conversationId);
    this.processConversationDetailEvictions();
  }

  private removeRecentClosedConversation(conversationId: string): void {
    const index = this.recentClosedConversationIds.indexOf(conversationId);
    if (index >= 0) this.recentClosedConversationIds.splice(index, 1);
  }

  private bumpConversationEvictionGeneration(conversationId: string): number {
    const next = (this.conversationEvictionGeneration.get(conversationId) ?? 0) + 1;
    this.conversationEvictionGeneration.set(conversationId, next);
    return next;
  }

  private hasOpenConversationPanel(conversationId: string): boolean {
    return this.env.webview.clientRecords().some((client) => mainPanelConversationId(client.meta) === conversationId);
  }

  private processConversationDetailEvictions(): void {
    if (this.conversationEvictionInFlight || this.recentClosedConversationIds.length <= MAX_WARM_CLOSED_CONVERSATIONS) return;

    const overflowCount = this.recentClosedConversationIds.length - MAX_WARM_CLOSED_CONVERSATIONS;
    for (const conversationId of this.recentClosedConversationIds.slice(0, overflowCount)) {
      if (this.hasOpenConversationPanel(conversationId)) {
        this.removeRecentClosedConversation(conversationId);
        this.processConversationDetailEvictions();
        return;
      }
      if (this.conversationTailLoadInFlight.has(conversationId)
        || this.conversationDetailLoadInFlight.has(conversationId)
        || this.conversationContextLoadInFlight.has(conversationId)) continue;

      const conversation = this.findConversationEntity(conversationId);
      if (conversation === undefined) {
        this.removeRecentClosedConversation(conversationId);
        this.processConversationDetailEvictions();
        return;
      }
      if (conversationDetailEvictionBlocker(this.world, conversation)) continue;

      const generation = this.conversationEvictionGeneration.get(conversationId) ?? 0;
      this.conversationEvictionInFlight = conversationId;
      void this.persistAndEvictConversationDetail(conversationId, generation);
      return;
    }
  }

  private async persistAndEvictConversationDetail(conversationId: string, generation: number): Promise<void> {
    let continueDraining = true;
    try {
      if ((this.conversationEvictionGeneration.get(conversationId) ?? 0) !== generation) return;
      if (this.hasOpenConversationPanel(conversationId)) return;
      if (this.conversationTailLoadInFlight.has(conversationId)
        || this.conversationDetailLoadInFlight.has(conversationId)
        || this.conversationContextLoadInFlight.has(conversationId)) return;

      const warmStart = Math.max(0, this.recentClosedConversationIds.length - MAX_WARM_CLOSED_CONVERSATIONS);
      const queueIndex = this.recentClosedConversationIds.indexOf(conversationId);
      if (queueIndex < 0 || queueIndex >= warmStart) return;

      const conversation = this.findConversationEntity(conversationId);
      if (conversation === undefined || conversationDetailEvictionBlocker(this.world, conversation)) return;

      const historyEntry = this.getConversationHistoryEntries().find((candidate) => candidate.id === conversationId);
      if (historyEntry) this.coldConversationHistoryEntries.set(conversationId, historyEntry);
      const result = evictConversationDetail(this.world, conversation);
      this.renderLoadedConversationDetails.delete(conversationId);
      this.runHistoryLoadedConversationDetails.delete(conversationId);
      this.conversationTailLoaded.delete(conversationId);
      this.world.remove(conversation, ConversationFullContextLoaded);
      this.world.remove(conversation, ConversationFullContextPending);
      this.removeRecentClosedConversation(conversationId);
      this.requestSnapshot();
      console.debug(`[LimCode] Cold-evicted conversation detail "${conversationId}" (${result.removedEntities} entities).`);
    } catch (error) {
      continueDraining = false;
      console.warn(`[LimCode] Failed to persist conversation "${conversationId}" before cold eviction.`, error);
    } finally {
      if (this.conversationEvictionInFlight === conversationId) this.conversationEvictionInFlight = undefined;
      if (continueDraining) this.processConversationDetailEvictions();
    }
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    if (this.disposing) return;
    if (!this.hydrated && shouldDeferUntilHydrated(message)) {
      this.pendingHydrationMessages.push({ clientId, message });
      return;
    }
    if (this.hydrated && !this.authoritativeStorageReady && requiresHydratedStorage(message)) {
      this.postReliabilityUnavailable(clientId, message);
      return;
    }
    if (this.hydrated && !this.deferredSkeletonComplete && shouldDeferUntilDeferredSkeleton(message)) {
      this.pendingDeferredSkeletonMessages.push({ clientId, message });
      return;
    }
    if (this.conversationCommands?.handle(clientId, message)) return;
    if (isReliabilityBridgeMessageType(message.type)) {
      this.postReliabilityUnavailable(clientId, message);
      return;
    }
    this.webviewRouter.handle(clientId, message);
  }

  private requireAuthoritativeStorage(): void {
    if (this.authoritativeStorageReady) return;
    throw this.reliabilityUnavailableError ?? new Error('权威存储尚未完成启动。');
  }

  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposing = true;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.env.webview.detachAll();
    this.webviewClients.clear();
    this.env.mcp.setStateChangeListener(undefined);

    await this.hydratedReady;
    await this.deferredSkeletonReady;
    await this.backgroundProcessDeliveryDispatcher?.dispose();
    await this.primaryEffectDispatcher?.dispose();
    this.env.command.dispose();
    await this.scheduler.stopAndDrain();
    this.env.llm.dispose();
    if (this.conversationHistoryRefreshTimer) clearTimeout(this.conversationHistoryRefreshTimer);
    this.conversationHistoryRefreshTimer = undefined;
    this.flushConversationHistoryRefreshes();
    await this.conversationHistoryRefreshTail;

    let persistenceError: unknown;
    try {
      await this.persistForShutdown();
    } catch (error) {
      persistenceError = error;
    }

    await this.reliabilityBackend?.dispose();
    await this.env.mcp.dispose();
    if (persistenceError) throw persistenceError;
  }

  private async persistForShutdown(): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.persistence.persistImmediately({ ensurePersisted: true, throwOnError: true });
        return;
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  private async initializeClientState(): Promise<void> {
    let startupStorageHealthy = true;
    try {
      await this.env.storage.ensureReady();
      await this.initializeReliabilityInfrastructure();
      const gateway = this.conversationCommands;
      const adapter = this.reliabilityAdapter;
      if (!gateway || !adapter) throw new Error('可靠 conversation transaction backend 初始化不完整。');

      const runtimeConversationIds = await adapter.listRuntimeConversationIds();
      await gateway.adoptExistingRuntimeConversations(runtimeConversationIds, {
        rehydrateConversationIds: runtimeConversationIds
      });

      const restored = await this.env.storage.loadClientStateSkeleton({ profile: 'startup' });
      if (restored?.conversations.length) {
        throw codedError('migration_required', '独立领域 skeleton 不得包含 Conversation aggregate；请重置开发数据 Epoch。');
      }
      if (restored) {
        await hydrateClientStateSkeleton(this.world, restored, {
          allowDefaults: false,
          resetMessageSeq: runtimeConversationIds.length === 0
        });
        this.persistence.rememberPersistedState(restored);
      }

      if (runtimeConversationIds.length === 0) {
        const conversationId = stableIds.nextConversationId();
        await gateway.createConversation(conversationId, createNewConversationTitle());
        const conversation = this.findConversationEntity(conversationId);
        if (conversation === undefined) throw new Error(`Fresh-root Conversation projection is missing: ${conversationId}`);
        const now = Date.now();
        const origin = this.world.spawn();
        this.world.add(origin, ConversationOriginLink, {
          id: nextAuxiliaryId('col'),
          conversation,
          originKind: 'user',
          sourceKind: 'user',
          createdAt: now,
          updatedAt: now
        });
        requestSpawnAgent(this.world, createDefaultAgentSpawnRequest(conversationId));
        this.renderLoadedConversationDetails.add(conversationId);
        this.runHistoryLoadedConversationDetails.add(conversationId);
        this.conversationTailLoaded.add(conversationId);
      }

      await this.primaryEffectDispatcher?.reconcileStartup();
      this.attachBackgroundProcessProjection();
      this.authoritativeStorageReady = true;
    } catch (error) {
      startupStorageHealthy = false;
      this.authoritativeStorageReady = false;
      this.reliabilityUnavailableError = error instanceof Error ? error : new Error(String(error));
      const dispatcher = this.primaryEffectDispatcher;
      const backgroundDelivery = this.backgroundProcessDeliveryDispatcher;
      const backend = this.reliabilityBackend;
      this.conversationCommands = undefined;
      this.primaryEffectDispatcher = undefined;
      this.backgroundProcessDeliveryDispatcher = undefined;
      this.reliabilityAdapter = undefined;
      this.reliabilityInspector = undefined;
      this.reliabilityBackend = undefined;
      await backgroundDelivery?.dispose().catch((disposeError) => console.error('[LimCode] Failed to stop background-process delivery after startup rejection.', disposeError));
      await dispatcher?.dispose().catch((disposeError) => console.error('[LimCode] Failed to stop reliability dispatcher after startup rejection.', disposeError));
      await backend?.dispose().catch((disposeError) => console.error('[LimCode] Failed to release reliability storage after startup rejection.', disposeError));
      await this.persistence.suspend();
      console.error('[LimCode] Stored state was rejected; no fallback Conversation or writer was started.', error);
      this.notifyStorageStartupFailure(this.reliabilityUnavailableError);
    } finally {
      this.hydrated = true;
      if (this.authoritativeStorageReady) {
        this.primaryEffectDispatcher?.start();
        this.backgroundProcessDeliveryDispatcher?.start();
      }
      this.deferredSkeletonComplete = false;
      // 工作环境、存档点等策略属于 deferred skeleton。先启动 deferred hydration，再放行配置类消息，
      // 避免设置页刚打开时的修改被尚未加载的旧 skeleton 覆盖或因 scope 依赖未就绪而丢弃。
      this.deferredSkeletonReady = this.startDeferredClientStateSkeletonLoad(startupStorageHealthy);
      this.flushPendingSnapshots();
      this.flushPendingHydrationMessages();
      if (this.authoritativeStorageReady) {
        for (const section of GLOBAL_SETTINGS_SECTIONS) {
          void this.globalSettingsBridge.postSnapshot(undefined, section);
        }
        this.startCheckpointShadowAutoCleanup();
        void this.refreshMcpRuntime(true);
        void this.syncSkillCatalogResource();
        void this.syncRulesCatalogResource();
      }
      this.resolveHydrated();
    }
  }

  private attachBackgroundProcessProjection(): void {
    if (this.backgroundProcessProjectionAttached) return;
    const initialSnapshot = this.env.backgroundProcesses.snapshot();
    this.world.setResource(BackgroundProcessSnapshotKey, initialSnapshot);
    const unsubscribe = this.env.backgroundProcesses.onSnapshotChanged((snapshot) => {
      if (this.disposing) return;
      void this.scheduler.runAtSafePoint(() => {
        if (this.disposing) return;
        this.world.setResource(BackgroundProcessSnapshotKey, snapshot);
        this.world.enqueue({ type: ClientSyncEventType.Resync, payload: {} });
      });
    });
    this.disposables.push({ dispose: unsubscribe });
    this.backgroundProcessProjectionAttached = true;
  }

  private async initializeReliabilityInfrastructure(): Promise<void> {
    if (this.reliabilityBackend) return;
    const files = new DurableFileSystem(this.env.storage.paths.globalStoragePath);
    const owner = new DataRootOwnerManager(files);
    const adapter = new RuntimeAuthorityAdapter({
      files,
      projectionFactory: (facts, plan, baseStorageHeads) => isTransientCheckpointTransition(plan)
        ? new CommittedHeadOnlyWorldProjection(plan.transitionId, this.world, this.scheduler, plan, baseStorageHeads)
        : facts.length === 1
          ? new CommittedConversationWorldProjection(plan.transitionId, this.world, this.scheduler, facts[0], plan, baseStorageHeads)
          : new CommittedMultiConversationWorldProjection(plan.transitionId, this.world, this.scheduler, facts, plan, baseStorageHeads),
      afterCommit: (plan) => {
        for (const hint of plan.cleanupHints) this.primaryEffectDispatcher?.handleCleanupHint(hint);
      }
    });
    const diagnostics = new ReliabilityDiagnosticJournal(
      256,
      (event) => console.info('[LimCode][Reliability]', event)
    );
    const backend = new FileConversationTransactionBackend({
      files,
      owner,
      adapter,
      diagnostics
    });
    await backend.initialize();

    this.reliabilityAdapter = adapter;
    this.reliabilityBackend = backend;
    this.reliabilityInspector = new ReliabilityInspector({ backend, world: this.world, diagnostics });
    const gateway = new ConversationCommandGateway({
      backend,
      adapter,
      storage: this.env.storage,
      webview: this.env.webview,
      resolveAgentId: (conversationId, requestedAgentId) => this.resolveCommandAgentId(conversationId, requestedAgentId),
      resolveTurnAuthority: (conversationId, agentId, executionPolicy) => compileEffectiveTurnAuthority(
        projectClientState(this.world, this.world.getResource(ClientStateContributorsKey).list()),
        { conversationId, agentId, executionPolicy }
      ),
      resolveToolConversationId: (toolCallId) => this.resolveToolConversationId(toolCallId),
      installCommittedHead: (head) => this.scheduler.runAtSafePoint(() => {
        this.world.setResource(CommittedConversationHeadsKey, {
          ...this.world.getResource(CommittedConversationHeadsKey),
          [head.conversationId]: head
        });
      }),
      rehydrateCommittedConversation: async (conversationId) => {
        const view = await backend.readCommittedView(committedReadView('application.rehydrate', conversationId));
        await this.scheduler.runAtSafePoint(() => rehydrateCommittedFacts(this.world, view.facts));
      },
      onCommitted: (conversationIds) => this.afterReliableCommit(conversationIds)
    });
    this.conversationCommands = gateway;
    this.primaryEffectDispatcher = new PrimaryEffectDispatcher({
      backend,
      adapter,
      files,
      world: this.world,
      scheduler: this.scheduler,
      env: this.env,
      conversationIds: () => gateway.managedConversationIds(),
      ensureConversationLoaded: (conversationId) => this.ensureConversationDetailLoaded(conversationId),
      prepareConversationOwnership: (conversationId) => gateway.prepareInternalConversation(conversationId),
      adoptCommittedConversation: (conversationId) => gateway.adoptCommittedInternalConversation(conversationId),
      cleanupCheckpointGarbage: () => this.startCheckpointShadowAutoCleanup(),
      onCommitted: (conversationIds) => this.afterReliableCommit(conversationIds),
      onIntegrityError: (conversationId, error) => console.error(`[LimCode][Reliability] Conversation ${conversationId} runtime blocked.`, error)
    });
    this.backgroundProcessDeliveryDispatcher = new BackgroundProcessDeliveryDispatcher({
      processes: this.env.backgroundProcesses,
      target: this.primaryEffectDispatcher,
      onError: (error) => console.error('[LimCode][BackgroundProcessDelivery]', error)
    });
    this.reliabilityUnavailableError = undefined;
  }

  private afterReliableCommit(conversationIds: readonly ConversationId[]): void {
    this.primaryEffectDispatcher?.wake(conversationIds);
    for (const conversationId of conversationIds) this.pendingConversationHistoryRefreshes.add(conversationId);
    if (this.conversationHistoryRefreshTimer || this.disposing) return;
    this.conversationHistoryRefreshTimer = setTimeout(() => {
      this.conversationHistoryRefreshTimer = undefined;
      this.flushConversationHistoryRefreshes();
    }, 100);
  }

  private flushConversationHistoryRefreshes(): void {
    const pending = [...this.pendingConversationHistoryRefreshes];
    this.pendingConversationHistoryRefreshes.clear();
    if (pending.length === 0) return;
    this.conversationHistoryRefreshTail = this.conversationHistoryRefreshTail
      .then(async () => {
        for (const conversationId of pending) await this.refreshConversationHistoryReadModel(conversationId);
      })
      .catch((error) => console.warn('[LimCode][Reliability] Failed to refresh conversation history read models.', error));
  }

  private resolveToolConversationId(toolCallId: string): string | undefined {
    const toolCall = this.world.entityByRecordId(ToolCall, toolCallId);
    if (toolCall === undefined) return undefined;
    const runLinks = this.world.query(ToolCallRunLink)
      .map((entity) => this.world.get(entity, ToolCallRunLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.toolCall === toolCall);
    if (runLinks.length !== 1) {
      if (runLinks.length > 1) throw new Error(`ToolCall ${toolCallId} has ambiguous Run ownership.`);
      return undefined;
    }
    const targets = this.world.query(AgentRunTargetLink)
      .map((entity) => this.world.get(entity, AgentRunTargetLink))
      .filter((link): link is NonNullable<typeof link> => !!link && link.run === runLinks[0].run && link.role === 'executor');
    if (targets.length !== 1) {
      if (targets.length > 1) throw new Error(`Run target ownership is ambiguous for ToolCall ${toolCallId}.`);
      return undefined;
    }
    return this.world.get(targets[0].conversation, Conversation)?.id;
  }

  private resolveCommandAgentId(conversationId: string, requestedAgentId?: string): string | undefined {
    const requested = requestedAgentId?.trim();
    if (requested) return this.findAgentEntity(requested) !== undefined ? requested : undefined;
    const conversation = this.findConversationEntity(conversationId);
    if (conversation === undefined) return undefined;
    const selected = this.activeSelectionForConversation(conversation)?.agent;
    const agent = selected ?? this.findDefaultAgent();
    return agent !== undefined ? this.world.get(agent, Agent)?.id : undefined;
  }

  private postReliabilityUnavailable(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    const commandId = reliableCommandId(message);
    if (commandId) {
      this.env.webview.post(clientId, {
        id: createMessageId(),
        type: BridgeMessageType.CommandResult,
        channel: 'command',
        correlationId: message.id,
        payload: {
          error: {
            commandId: commandId as import('../../shared/stableIds').CommandId,
            status: 'unavailable',
            code: reliabilityUnavailableCode(this.reliabilityUnavailableError),
            message: this.reliabilityUnavailableError?.message ?? '可靠存储后端不可用。'
          }
        }
      });
      return;
    }
    this.env.webview.post(clientId, {
      id: createMessageId(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      correlationId: message.id,
      payload: { requestType: message.type, message: this.reliabilityUnavailableError?.message ?? '可靠存储后端不可用。' }
    });
  }

  private notifyStorageStartupFailure(error: Error): void {
    if (this.storageStartupNoticeShown) return;
    this.storageStartupNoticeShown = true;
    const migrationRequired = errorCodeOf(error) === 'migration_required';
    const actions = migrationRequired ? ['归档并重置开发数据', '打开数据目录'] as const : ['打开数据目录'] as const;
    void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${error.message}`, ...actions).then((action) => {
      if (action === '归档并重置开发数据') {
        void vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.resetDevelopmentData);
      } else if (action === '打开数据目录') {
        void vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.revealGlobalStorage);
      }
    });
  }

  private async startDeferredClientStateSkeletonLoad(startupStorageHealthy: boolean): Promise<void> {
    let deferredStorageHealthy = true;
    try {
      const deferred = await this.env.storage.loadClientStateSkeleton({ profile: 'deferred' });
      if (deferred) {
        const hydrated = await hydrateClientStateSkeleton(this.world, deferred, { allowDefaults: false, resetMessageSeq: false });
        if (hydrated) {
          this.requestSnapshot();
          this.conversationHistoryChangedEmitter.fire();
        }
      }
    } catch (error) {
      deferredStorageHealthy = false;
      console.warn('[LimCode] Failed to lazy-load deferred client state skeleton.', error);
    } finally {
      try {
        this.syncWorkEnvironmentsFromWorkspaceFolders();
      } catch (error) {
        deferredStorageHealthy = false;
        console.warn('[LimCode] Failed to synchronize workspace work environments after deferred hydration.', error);
      }
      if (startupStorageHealthy && deferredStorageHealthy) {
        this.persistence.enable();
        this.persistence.queuePersist();
      } else {
        console.warn('[LimCode] Skeleton persistence is disabled for this session to avoid overwriting partially loaded data.');
      }
      this.deferredSkeletonComplete = true;
      this.flushPendingDeferredSkeletonMessages();
    }
  }

  private startCheckpointShadowAutoCleanup(): void {
    if (!CHECKPOINT_FEATURE_ENABLED) return;
    void (async () => {
      try {
        const loaded = await this.env.storage.loadGlobalSettings('checkpointMaintenance');
        const settings = loaded.settings as CheckpointMaintenanceSettingsRecord;
        if (!settings.autoCleanupEnabled) return;
        const result = await this.env.storage.cleanupUnusedShadowWorktrees(settings.autoCleanupDays);
        if (result.deletedStorageKeys.length > 0) {
          console.info(`[LimCode] Auto-cleaned ${result.deletedStorageKeys.length} unused shadow worktrees (>${settings.autoCleanupDays}d).`);
        }
      } catch (error) {
        console.warn('[LimCode] Failed to auto-clean unused shadow worktrees.', error);
      }
    })();
  }

  private requestPersistSoon(reason: string): void {
    setTimeout(() => {
      void this.persistence.persistImmediately({ force: true }).catch((error) => {
        console.warn(`[LimCode] Failed to persist after config mutation (${reason}).`, error);
      });
    }, 750);
  }

  private requestSnapshot(conversationId?: string): void {
    if (this.disposing) return;
    if (!this.hydrated) {
      if (conversationId) this.pendingSnapshotConversationIds.add(conversationId);
      else this.pendingGlobalSnapshot = true;
      return;
    }
    this.world.enqueue({ type: ClientSyncEventType.Resync, payload: conversationId ? { conversationId } : {} });
  }

  private async prepareDataRootChange(): Promise<void> {
    if (this.dataRootChangeInProgress) throw new Error('Data-root change is already in progress.');
    this.dataRootChangeInProgress = true;
    this.authoritativeStorageReady = false;
    this.reliabilityUnavailableError = new Error('数据根正在切换，可靠命令入口已关闭。');

    const dispatcher = this.primaryEffectDispatcher;
    const backgroundDelivery = this.backgroundProcessDeliveryDispatcher;
    const backend = this.reliabilityBackend;
    this.conversationCommands = undefined;
    this.primaryEffectDispatcher = undefined;
    this.backgroundProcessDeliveryDispatcher = undefined;
    await backgroundDelivery?.dispose();
    await dispatcher?.dispose();
    this.env.command.quiesce();

    await backend?.quiesce();
    await this.persistence.persistImmediately({ force: true, throwOnError: true });
    await this.persistence.suspend();
    await backend?.dispose();
    this.reliabilityBackend = undefined;
    this.reliabilityAdapter = undefined;
    this.reliabilityInspector = undefined;
  }

  private async commitDataRootChange(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  private async recoverDataRootChange(): Promise<void> {
    const staleBackend = this.reliabilityBackend;
    await this.backgroundProcessDeliveryDispatcher?.dispose();
    await this.primaryEffectDispatcher?.dispose();
    this.backgroundProcessDeliveryDispatcher = undefined;
    this.primaryEffectDispatcher = undefined;
    this.conversationCommands = undefined;
    this.reliabilityBackend = undefined;
    this.reliabilityAdapter = undefined;
    this.reliabilityInspector = undefined;
    try { await staleBackend?.dispose(); }
    finally { this.persistence.enable(); }

    await this.initializeReliabilityInfrastructure();
    const conversationIds = this.world.query(Conversation)
      .map((entity) => this.world.get(entity, Conversation)?.id)
      .filter((id): id is string => !!id);
    const adapter = this.reliabilityAdapter as RuntimeAuthorityAdapter | undefined;
    const runtimeConversationIds = await adapter?.listRuntimeConversationIds() ?? [];
    const projected = new Set(conversationIds);
    const commands = this.conversationCommands as ConversationCommandGateway | undefined;
    const dispatcher = this.primaryEffectDispatcher as PrimaryEffectDispatcher | undefined;
    const backgroundDelivery = this.backgroundProcessDeliveryDispatcher as BackgroundProcessDeliveryDispatcher | undefined;
    await commands?.adoptExistingRuntimeConversations(
      [...new Set([...conversationIds, ...runtimeConversationIds])],
      { rehydrateConversationIds: runtimeConversationIds.filter((conversationId) => !projected.has(conversationId)) }
    );
    await dispatcher?.reconcileStartup();
    this.authoritativeStorageReady = true;
    dispatcher?.start();
    backgroundDelivery?.start();
    this.dataRootChangeInProgress = false;
  }

  private async beforeGlobalSettingsUpdate(payload: { section: string; settings?: unknown }): Promise<void> {
    if (payload.section === 'llm') {
      await this.freezeLoadedConversationsToCurrentGlobalLlmDefault();
      return;
    }
    if (payload.section === 'llmProviderConfigs') {
      await this.freezeLoadedConversationsToCurrentProviderModels();
    }
  }

  private async copyConversationSettings(sourceConversationId: string, targetConversationId: string): Promise<void> {
    try {
      const llm = await this.env.storage.loadConversationSettings(sourceConversationId, 'llm');
      const settings = llm?.settings as ConversationLlmSettingsRecord | undefined;
      if (!settings) return;
      const copied: ConversationLlmSettingsRecord = {
        conversationId: targetConversationId,
        activeProviderConfigId: settings.activeProviderConfigId,
        ...(settings.modelOverrides ? { modelOverrides: { ...settings.modelOverrides } } : {})
      };
      await this.env.storage.saveConversationSettings('llm', copied);
      await this.applyConversationModelSettingsToWorld(copied);
    } catch (error) {
      console.warn(`[LimCode] Failed to copy LLM settings to fork "${targetConversationId}".`, error);
    }
  }

  private async afterConversationSettingsRead(stored: { conversationId: string; section: string; settings: unknown }): Promise<void> {
    if (stored.section !== 'llm') return;
    await this.applyConversationModelSettingsToWorld(stored.settings as ConversationLlmSettingsRecord | undefined);
  }

  private async afterConversationSettingsUpdate(stored: { conversationId: string; section: string; settings: unknown }): Promise<void> {
    if (stored.section !== 'llm') return;
    const settings = stored.settings as ConversationLlmSettingsRecord | undefined;
    await this.applyConversationModelSettingsToWorld(settings);
    const activeProviderConfigId = settings?.activeProviderConfigId?.trim();
    if (!activeProviderConfigId) return;

    await this.globalSettingsBridge.update({
      section: 'llm',
      settings: { activeProviderConfigId }
    });
  }

  private async applyConversationModelSettingsToWorld(settings: ConversationLlmSettingsRecord | undefined): Promise<void> {
    const conversationId = settings?.conversationId?.trim();
    const providerConfigId = settings?.activeProviderConfigId?.trim();
    if (!conversationId || !providerConfigId) return;
    const model = settings?.modelOverrides?.[providerConfigId]?.trim();
    if (!model) return;
    const provider = await this.env.storage.loadLlmProviderConfigById(providerConfigId);
    if (!provider || !modelExistsInProviderConfig(provider, model)) return;
    this.upsertConversationModelProfile(conversationId, {
      providerConfigId,
      provider: provider.provider,
      model
    });
  }

  private async afterGlobalSettingsUpdate(payload: { section: string; refreshMcpTools?: boolean }): Promise<void> {
    if (payload.section === 'mcpServers' || payload.section === 'common') {
      await this.refreshMcpRuntime(payload.refreshMcpTools === true);
    }
    if (payload.section === 'common') {
      // 数据根目录切换后，全局技能来源 <dataRoot>/skills 会变化，需重新扫描技能目录。
      await this.syncSkillCatalogResource();
      // 同理，全局规则来源 <dataRoot>/{AGENTS,CLAUDE}.md 也随数据根变化，需重新扫描规则。
      await this.syncRulesCatalogResource();
    }
  }

  private async refreshMcpRuntime(discover: boolean): Promise<void> {
    await this.env.mcp.refreshFromSettings({ discover });
    if (!this.disposing) this.syncMcpRuntimeResources();
  }

  private syncMcpRuntimeResources(): void {
    if (this.disposing) return;
    const builtinTools = this.env.tools.registry.filter((tool) => tool.declaration.source?.kind !== 'mcp');
    const mcpTools = dedupeMcpToolNames(this.env.mcp.runtimeTools(), builtinTools.map((tool) => tool.declaration.name));
    const mergedTools = [...builtinTools, ...mcpTools];
    this.env.tools.registry.splice(0, this.env.tools.registry.length, ...mergedTools);
    this.world.setResource(ToolRuntimeDefinitionsKey, this.env.tools.registry);
    this.world.setResource(ToolSchemasKey, schemasForTools(mergedTools));
    this.world.setResource(ToolDefinitionsKey, recordsForTools(mergedTools));
    this.world.setResource(McpToolSourcesKey, this.env.mcp.sourceRecords());
    this.requestSnapshot();
  }

  private async freezeLoadedConversationsToCurrentGlobalLlmDefault(): Promise<void> {
    let currentProviderConfigId = '';
    try {
      currentProviderConfigId = (await this.env.storage.loadActiveLlmProviderConfig()).id;
    } catch (error) {
      console.warn('[LimCode] Failed to resolve current global LLM default before update.', error);
      return;
    }
    if (!currentProviderConfigId) return;

    for (const conversationId of this.loadedConversationIds()) {
      try {
        const stored = await this.env.storage.loadConversationSettings(conversationId, 'llm');
        const settings = stored?.settings as import('../../shared/protocol').ConversationLlmSettingsRecord | undefined;
        if (settings?.activeProviderConfigId) continue;
        await this.env.storage.saveConversationSettings('llm', {
          conversationId,
          activeProviderConfigId: currentProviderConfigId,
          ...(settings?.modelOverrides ? { modelOverrides: settings.modelOverrides } : {})
        });
      } catch (error) {
        console.warn(`[LimCode] Failed to freeze LLM default for conversation "${conversationId}".`, error);
      }
    }
  }

  private async freezeLoadedConversationsToCurrentProviderModels(): Promise<void> {
    for (const conversationId of this.loadedConversationIds()) {
      try {
        const stored = await this.env.storage.loadConversationSettings(conversationId, 'llm');
        const settings = stored?.settings as import('../../shared/protocol').ConversationLlmSettingsRecord | undefined;
        if (!settings?.activeProviderConfigId) continue;
        if (settings.modelOverrides?.[settings.activeProviderConfigId]) continue;
        const provider = await this.env.storage.loadActiveLlmProviderConfig(conversationId);
        const model = provider.model?.trim();
        if (!model) continue;
        await this.env.storage.saveConversationSettings('llm', {
          conversationId,
          activeProviderConfigId: settings.activeProviderConfigId,
          modelOverrides: {
            ...(settings.modelOverrides ?? {}),
            [settings.activeProviderConfigId]: model
          }
        });
      } catch (error) {
        console.warn(`[LimCode] Failed to freeze LLM model for conversation "${conversationId}".`, error);
      }
    }
  }

  private loadedConversationIds(): string[] {
    return this.world
      .query(Conversation)
      .map((entity) => this.world.get(entity, Conversation)?.id)
      .filter((id): id is string => !!id);
  }

  private async syncSkillCatalogResource(): Promise<void> {
    await this.env.skills.refresh();
    if (this.disposing) return;
    this.world.setResource(SkillCatalogKey, this.env.skills.list());
    if (this.hydrated) this.requestSnapshot();
  }

  private async syncRulesCatalogResource(): Promise<void> {
    await this.env.rules.refresh();
    if (this.disposing) return;
    this.world.setResource(RulesCatalogKey, this.env.rules.list());
    if (this.hydrated) this.requestSnapshot();
  }

  private async saveRuleFile(scope: RuleScope, content: string): Promise<void> {
    await this.env.rules.writeAgents(scope, content);
    await this.syncRulesCatalogResource();
  }

  private flushPendingSnapshots(): void {
    if (this.pendingGlobalSnapshot) {
      this.pendingGlobalSnapshot = false;
      this.requestSnapshot();
    }

    const conversationIds = [...this.pendingSnapshotConversationIds];
    this.pendingSnapshotConversationIds.clear();
    for (const conversationId of conversationIds) this.requestSnapshot(conversationId);
  }

  private flushPendingHydrationMessages(): void {
    if (this.disposing) {
      this.pendingHydrationMessages.length = 0;
      return;
    }
    const pending = this.pendingHydrationMessages.splice(0);
    for (const item of pending) this.handleWebviewMessage(item.clientId, item.message);
  }

  private flushPendingDeferredSkeletonMessages(): void {
    if (this.disposing) {
      this.pendingDeferredSkeletonMessages.length = 0;
      return;
    }
    const pending = this.pendingDeferredSkeletonMessages.splice(0);
    for (const item of pending) this.handleWebviewMessage(item.clientId, item.message);
  }

  private primeConversationStreamState(conversationId: string, detail: ClientState): void {
    const syncState = this.world.tryGetResource(ClientSyncStateKey);
    if (!syncState) return;
    const streamId = conversationClientStateStreamId(conversationId);
    const stream = syncState.streams[streamId];
    if (!stream?.lastState) return;

    const nextStreamState = cloneClientState(stream.lastState);
    mergeClientStateRecords(nextStreamState, detail);
    this.world.setResource(ClientSyncStateKey, {
      ...syncState,
      streams: {
        ...syncState.streams,
        [streamId]: { ...stream, lastState: nextStreamState }
      }
    });
  }

  private syncWorkEnvironmentsFromWorkspaceFolders(): void {
    if (!this.hydrated || this.disposing) return;
    this.world.enqueue({
      type: WorkEnvironmentEventType.WorkspaceFoldersSynced,
      payload: { folders: this.getLocalWorkEnvironmentCandidates() }
    });
    this.requestSnapshot();
  }

  private getLocalWorkEnvironmentCandidates(): LocalWorkEnvironmentCandidate[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      id: workEnvironmentIdFromUri(folder.uri.toString()),
      name: folder.name,
      uri: folder.uri.toString(),
      rootPath: folder.uri.fsPath,
      displayPath: folder.uri.fsPath || folder.uri.toString(),
      index
    }));
  }

  public async importWorkEnvironmentsFromVscode(): Promise<number> {
    const records = await loadRemoteServerWorkEnvironmentRecordsFromVscode();
    if (records.length === 0) return 0;
    this.world.enqueue({
      type: WorkEnvironmentEventType.ImportFromVscodeRequested,
      payload: { records }
    });
    this.requestSnapshot();
    return records.length;
  }



  private findDefaultAgent(): Entity | undefined {
    return this.world.entityByRecordId(Agent, DEFAULT_AGENT_ID) ?? this.world.query(Agent)[0];
  }

  private findAgentEntity(agentId: string): Entity | undefined {
    return this.world.entityByRecordId(Agent, agentId);
  }

  private activeSelectionForConversation(conversation: Entity): { entity: Entity; agent: Entity } | undefined {
    let selected: { entity: Entity; data: { agent: Entity; updatedAt: number } } | undefined;
    for (const entity of this.world.query(ConversationAgentSelection)) {
      const data = this.world.get(entity, ConversationAgentSelection);
      if (!data || data.role !== 'active' || data.conversation !== conversation) continue;
      if (!selected || data.updatedAt > selected.data.updatedAt || (data.updatedAt === selected.data.updatedAt && entity > selected.entity)) {
        selected = { entity, data };
      }
    }
    return selected ? { entity: selected.entity, agent: selected.data.agent } : undefined;
  }

  private resolveProjectFolderForNewConversation(projectFolderUri: string | undefined): ProjectFolderCandidateRecord | undefined {
    if (projectFolderUri) {
      const normalizedUri = projectFolderUri.trim();
      if (!normalizedUri) return undefined;
      const candidate = this.projectFolderCandidateForUri(projectFolderUri);
      return candidate ?? { uri: normalizedUri, name: projectFolderNameFromUri(normalizedUri), index: -1 };
    }

    const candidates = this.getProjectFolderCandidates();
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private projectFolderCandidateForUri(folderUri: string): ProjectFolderCandidateRecord | undefined {
    const normalized = folderUri.trim();
    return this.getProjectFolderCandidates().find((candidate) => candidate.uri === normalized);
  }

  private findConversationEntity(conversationId: string): Entity | undefined {
    return this.world.entityByRecordId(Conversation, conversationId);
  }

  private upsertConversationModelProfile(
    conversationId: string,
    input: { providerConfigId?: string; provider?: LlmProviderKind; model: string }
  ): void {
    const scopeId = conversationId.trim();
    const model = input.model.trim();
    if (!scopeId || !model) return;
    const conversation = this.findConversationEntity(scopeId);
    if (conversation === undefined) return;
    const now = Date.now();
    const existing = this.latestConversationModelProfileLink(conversation, scopeId);
    const profile = existing?.link.modelProfile ?? this.world.spawn();
    const profileId = existing ? this.world.get(profile, ModelProfile)?.id ?? modelProfileIdForConversation(scopeId) : modelProfileIdForConversation(scopeId);
    this.world.add(profile, ModelProfile, {
      id: profileId,
      name: '对话临时模型',
      ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      model
    });
    if (existing) {
      this.world.add(existing.entity, ModelProfileScopeLink, { ...existing.link, conversation, scopeId, modelProfile: profile, updatedAt: now });
      return;
    }
    const link = this.world.spawn();
    this.world.add(link, ModelProfileScopeLink, {
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
    return this.world
      .query(ModelProfileScopeLink)
      .map((entity) => ({ entity, link: this.world.get(entity, ModelProfileScopeLink) }))
      .filter((item): item is { entity: Entity; link: ModelProfileScopeLinkData } => !!item.link && item.link.role === 'active' && item.link.scopeKind === 'conversation' && (item.link.conversation === conversation || item.link.scopeId === scopeId))
      .sort((left, right) => (right.link.updatedAt || right.link.createdAt) - (left.link.updatedAt || left.link.createdAt) || right.entity - left.entity)[0];
  }

  private collectConversationOriginsByConversation(): Map<Entity, ConversationOriginLinkRecord> {
    const result = new Map<Entity, ConversationOriginLinkRecord>();
    for (const entity of this.world.query(ConversationOriginLink)) {

      const link = this.world.get(entity, ConversationOriginLink);
      if (!link) continue;
      const conversation = this.world.get(link.conversation, Conversation);
      if (!conversation?.id) continue;
      const existing = result.get(link.conversation);
      if (existing && (existing.createdAt < link.createdAt || (existing.createdAt === link.createdAt && existing.id.localeCompare(link.id) <= 0))) continue;

      const sourceAgentId = (link.sourceAgent !== undefined ? this.world.get(link.sourceAgent, Agent)?.id : undefined) ?? link.sourceAgentId;
      const sourceConversationId = (link.sourceConversation !== undefined ? this.world.get(link.sourceConversation, Conversation)?.id : undefined) ?? link.sourceConversationId;
      const sourceMessageId = (link.sourceMessage !== undefined ? this.world.get(link.sourceMessage, Message)?.id : undefined) ?? link.sourceMessageId;
      const sourceToolCallId = (link.sourceToolCall !== undefined ? this.world.get(link.sourceToolCall, ToolCall)?.id : undefined) ?? link.sourceToolCallId;
      const sourceRunId = (link.sourceRun !== undefined ? this.world.get(link.sourceRun, AgentRun)?.id : undefined) ?? link.sourceRunId;
      result.set(link.conversation, {
        id: link.id,
        conversationId: conversation.id,
        originKind: link.originKind,
        ...(link.sourceKind ? { sourceKind: link.sourceKind } : {}),
        ...(sourceAgentId ? { sourceAgentId } : {}),
        ...(sourceConversationId ? { sourceConversationId } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(sourceToolCallId ? { sourceToolCallId } : {}),
        ...(sourceRunId ? { sourceRunId } : {}),
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
      });
    }
    return result;
  }


  private collectProjectsByConversation(): Map<Entity, { uri: string; name: string }> {
    const result = new Map<Entity, { uri: string; name: string }>();
    for (const linkEntity of this.world.query(ConversationProjectLink)) {
      const link = this.world.get(linkEntity, ConversationProjectLink);
      if (!link || link.role !== 'primary') continue;
      const project = this.world.get(link.projectContext, ProjectContext);
      if (!project) continue;
      result.set(link.conversation, { uri: project.uri, name: project.name });
    }
    return result;
  }


  private collectMessagesByConversation(): Map<Entity, MessageData[]> {
    const result = new Map<Entity, MessageData[]>();
    for (const messageEntity of this.world.query(Message)) {
      const message = this.world.get(messageEntity, Message);
      const partOf = this.world.get(messageEntity, PartOf);
      if (!message || !partOf || isInternalMessage(message)) continue;
      const list = result.get(partOf.parent) ?? [];
      list.push(message);
      result.set(partOf.parent, list);
    }
    for (const messages of result.values()) messages.sort(compareMessagesBySeq);
    return result;
  }

  private collectAgentNamesByConversation(): Map<Entity, string> {
    const result = new Map<Entity, string>();
    for (const linkEntity of this.world.query(AgentConversationLink)) {
      const link = this.world.get(linkEntity, AgentConversationLink);
      if (!link) continue;
      if (result.has(link.conversation) && link.role !== 'default') continue;
      const agent = this.world.get(link.agent, Agent);
      if (!agent?.name) continue;
      result.set(link.conversation, agent.name);
    }
    return result;
  }

  private collectRunSummariesByConversation(): Map<Entity, { status: AgentRunStatus; label: string; updatedAt: number }> {
    const result = new Map<Entity, { status: AgentRunStatus; label: string; updatedAt: number }>();
    for (const linkEntity of this.world.query(AgentRunTargetLink)) {
      const link = this.world.get(linkEntity, AgentRunTargetLink);
      if (!link) continue;
      const run = this.world.get(link.run, AgentRun);
      if (!run || !isActiveAgentRunStatus(run.status)) continue;
      const existing = result.get(link.conversation);
      if (existing && existing.updatedAt >= run.updatedAt) continue;
      result.set(link.conversation, {
        status: run.status,
        label: labelForAgentRunStatus(run.status),
        updatedAt: run.updatedAt
      });
    }
    return result;
  }
}

function compareConversationHistoryEntries(left: SidebarConversationHistoryEntry, right: SidebarConversationHistoryEntry): number {
  return right.updatedAt - left.updatedAt
    || right.createdAt - left.createdAt
    || right.id.localeCompare(left.id, 'zh-CN');
}

function historyEntryMatchesScope(entry: SidebarConversationHistoryEntry, scope: ConversationHistoryScope): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'unbound') return !entry.projectFolderUri;
  return entry.projectFolderUri === scope.folderUri;
}

function compareMessagesBySeq(left: MessageData, right: MessageData): number {
  return left.seq - right.seq || left.createdAt - right.createdAt;
}

function latestMessage(messages: MessageData[]): MessageData | undefined {
  return messages.reduce<MessageData | undefined>((latest, message) => {
    if (!latest) return message;
    return message.createdAt > latest.createdAt || (message.createdAt === latest.createdAt && message.seq > latest.seq)
      ? message
      : latest;
  }, undefined);
}

function messagePreview(message: MessageData): string {
  const text = normalizeText(textPreview(message.content));
  if (text) return truncateText(text, 72);
  const state = aiPreviewState(message);
  return message.role === 'user' ? '用户消息' : state === 'pending' ? '响应中' : '空响应';
}

function aiPreviewState(message: MessageData): 'pending' | 'empty' | undefined {
  if (message.role !== 'model' || normalizeText(textPreview(message.content))) return undefined;
  return message.status === 'streaming' ? 'pending' : 'empty';
}

function textPreview(content: MessageContent): string {
  for (const part of content.parts) {
    if ('text' in part && part.thought !== true && part.text.trim()) return part.text;
    if ('functionCall' in part) return `调用工具：${part.functionCall.name}`;
    if ('functionResponse' in part) return `工具返回：${part.functionResponse.name}`;
    if ('fileData' in part) return `文件：${part.fileData.uri}`;
    if ('inlineData' in part) return `附件：${part.inlineData.mimeType}`;
  }
  return '';
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeConversationTitle(title: string): string {
  return truncateText(normalizeText(title) || '新对话', 80);
}


function projectFolderNameFromUri(uri: string): string {
  try {
    const parsed = vscode.Uri.parse(uri);
    const normalizedPath = parsed.fsPath || parsed.path || uri;
    const withoutTrailingSlash = normalizedPath.replace(/[\\/]+$/g, '');
    const name = withoutTrailingSlash.split(/[\\/]/).pop()?.trim();
    return name || uri;
  } catch {
    const withoutTrailingSlash = uri.replace(/[\\/]+$/g, '');
    return withoutTrailingSlash.split(/[\\/]/).pop()?.trim() || uri;
  }
}


function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'stale' && status !== 'interrupted';
}

function labelForAgentRunStatus(status: AgentRunStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'preparing':
      return '准备中';
    case 'running':
      return '执行中';
    case 'waiting_tool':
      return '等待工具';
    case 'waiting_child_run':
      return '等待子任务';
    case 'delivering':
      return '整理回复';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'failed':


      return '失败';
    case 'cancelled':
      return '已终止';
    case 'stale':
      return '已过期';
    case 'interrupted':
      return '已中断';
  }
}
function isTransientCheckpointTransition(plan: { patches: ReadonlyArray<{ operations: readonly unknown[] }> }): boolean {
  return plan.patches.length > 0 && plan.patches.every((patch) => patch.operations.length > 0 && patch.operations.every((operation) => {
    return !!operation && typeof operation === 'object' && !Array.isArray(operation) && (operation as { kind?: unknown }).kind === 'stream.checkpoint';
  }));
}

function isPassFlushEffect(effect: WorldEffect): boolean {
  const kind = (effect as { kind?: string }).kind;
  return kind === 'client.patch'
    || kind === 'client.snapshot'
    || kind === 'client.transientNotice'
    || kind === 'llm.resolveInvocation'
    || kind === 'llm.start'
    || kind === 'llm.compact'
    || kind === 'llm.abort'
    || kind === 'tool.run'
    || kind === 'tool.change.apply'
    || kind === 'tool.abort'
    || kind === 'tool.background'
    || kind === 'checkpoint.create';
}

function mainPanelConversationId(meta: WebviewClientMeta): string | undefined {
  if (meta.kind !== 'mainPanel' && meta.kind !== 'planDetail') return undefined;
  return meta.conversationId?.trim() || undefined;
}

function modelProfileIdForConversation(conversationId: string): string { return `model-profile:conversation:${conversationId}`; }
function modelProfileScopeLinkIdForConversation(conversationId: string): string { return `model-profile-scope:conversation:${conversationId}`; }
function modelExistsInProviderConfig(config: { model?: string; models: Array<{ id: string }> }, model: string): boolean {
  const id = model.trim();
  if (!id) return false;
  return config.model?.trim() === id || config.models.some((candidate) => candidate.id.trim() === id);
}

function isReliabilityBridgeMessageType(type: string): boolean {
  return type === BridgeMessageType.TurnStart
    || type === BridgeMessageType.TurnEnqueue
    || type === BridgeMessageType.TurnSteer
    || type === BridgeMessageType.TurnInterrupt
    || type === BridgeMessageType.TurnIntentUpdate
    || type === BridgeMessageType.TurnIntentCancel
    || type === BridgeMessageType.TurnIntentReorder
    || type === BridgeMessageType.TurnIntentPause
    || type === BridgeMessageType.TurnIntentResume
    || type === BridgeMessageType.TurnIntentResumeAll
    || type === BridgeMessageType.TurnIntentPromote
    || type === BridgeMessageType.InteractionResolve
    || type === BridgeMessageType.MessageEdit
    || type === BridgeMessageType.MessageDeleteFrom
    || type === BridgeMessageType.MessageRetryFrom
    || type === BridgeMessageType.CompressionCreate
    || type === BridgeMessageType.CompressionDelete
    || type === BridgeMessageType.CompressionUpdate
    || type === BridgeMessageType.CompressionRegenerate
    || type === BridgeMessageType.CompressionDisable
    || type === BridgeMessageType.CompressionEnable
    || type === BridgeMessageType.CommandOutcomeResolve
    || type === BridgeMessageType.CommandStatusGet
    || type === BridgeMessageType.ConversationHeadGet
    || type === BridgeMessageType.ToolExecutionCancel;
}

function reliableCommandId(message: WebviewToExtensionMessage): string | undefined {
  if (!isReliabilityBridgeMessageType(message.type) || !message.payload || typeof message.payload !== 'object') return undefined;
  const command = (message.payload as { command?: { commandId?: unknown } }).command;
  return typeof command?.commandId === 'string' ? command.commandId : undefined;
}

function shouldDeferUntilDeferredSkeleton(message: WebviewToExtensionMessage): boolean {
  switch (message.type) {
    case 'agent.create':
    case 'agent.update':
    case 'agent.delete':
    case 'conversation.agent.select':
    case 'systemPrompt.scope.set':
    case 'systemPrompt.scope.clear':
    case 'runtimeContext.scope.set':
    case 'runtimeContext.scope.clear':
    case 'runtimeContext.refresh':
    case 'runtimeContext.snapshot.clear':
    case 'modelProfile.scope.set':
    case 'modelProfile.scope.clear':
    case 'workflow.create':
    case 'workflow.update':
    case 'workflow.delete':
    case 'conversation.workflow.select':
    case 'toolPolicy.scope.set':
    case 'toolPolicy.scope.clear':
    case 'skillPolicy.scope.set':
    case 'skillPolicy.scope.clear':
    case 'workEnvironment.select':
    case 'workEnvironment.upsert':
    case 'workEnvironment.remove':
    case 'workEnvironment.importFromVscode':
    case 'workEnvironmentPolicy.scope.set':
    case 'workEnvironmentPolicy.scope.clear':
    case 'planReviewPolicy.scope.set':
    case 'planReviewPolicy.scope.clear':
    case 'checkpointPolicy.scope.set':
    case 'checkpointPolicy.scope.clear':
      return true;
    default:
      return false;
  }
}

function errorCodeOf(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

function codedError<TCode extends string>(code: TCode, message: string): Error & { code: TCode } {
  return Object.assign(new Error(message), { code });
}

function reliabilityUnavailableCode(error: unknown): CommandServiceError['code'] {
  const code = errorCodeOf(error);
  if (code === 'migration_required') return 'migration_required';
  if (code === 'scheduler_compile_failed' || code === 'runtime_unavailable') return 'runtime_unavailable';
  if (code === 'integrity_violation' || (error instanceof Error && error.name === 'FileTransactionIntegrityError')) return 'integrity_violation';
  if (code === 'recovery_required') return 'recovery_required';
  return 'storage_unavailable';
}

function cloneClientState(state: ClientState): ClientState {
  if (typeof structuredClone === 'function') return structuredClone(state);
  return JSON.parse(JSON.stringify(state)) as ClientState;
}

function mergeClientStateRecords(target: ClientState, source: ClientState): void {
  for (const tableKey of CLIENT_STATE_TABLE_KEYS) {
    const targetRecords = target[tableKey] as Array<{ id: string }>;
    const sourceRecords = source[tableKey] as Array<{ id: string }>;
    if (sourceRecords.length === 0) continue;
    const indexById = new Map(targetRecords.map((record, index) => [record.id, index]));
    for (const record of sourceRecords) upsertClientStateRecord(targetRecords, indexById, record);
  }
}

function upsertClientStateRecord(list: Array<{ id: string }>, indexById: Map<string, number>, record: { id: string }): void {
  const index = indexById.get(record.id);
  const next = typeof structuredClone === 'function'
    ? structuredClone(record)
    : JSON.parse(JSON.stringify(record));
  if (index !== undefined) {
    list[index] = next;
    return;
  }
  indexById.set(record.id, list.length);
  list.push(next);
}

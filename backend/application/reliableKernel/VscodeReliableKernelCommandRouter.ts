import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { toStructuredClonePlainData } from '../../../shared/plainData';
import {
  BridgeMessageType,
  type AttachmentOpenPayload,
  type AttachmentReloadPayload,
  type ConversationAgentSelectPayload,
  type ConversationLlmSettingsRecord,
  type ConversationSettingsGetPayload,
  type ConversationSettingsUpdatePayload,
  type GlobalSettingsGetPayload,
  type GlobalSettingsUpdatePayload,
  type InteractionResolvePayload,
  type LlmProviderModelsGetPayload,
  type MessageDeleteFromPayload,
  type MessageEditPayload,
  type MessageRetryFromPayload,
  type PlanProposalExportPayload,
  type ToolDecisionPayload,
  type TurnInterruptPayload,
  type TurnStartPayload,
  type WebviewToExtensionMessage
} from '../../../shared/protocol';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import type { VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';
import { readVscodeSshWorkEnvironments } from './VscodeSshConfigurationReader';

export interface VscodeReliableKernelCommandRouterOptions {
  broadcast?(message: unknown): void;
  createConversation?(options: { projectFolderUri?: string }): Promise<string>;
  forkConversation?(sourceConversationId: string, messageId: string): Promise<string>;
  openPlanProposal?(payload: { conversationId?: string; toolCallId?: string; planProposalId?: string; title?: string }): void;
}

/** Normal Webview command route for reliable Runtime mutations. Bounded Feed remains the only data route. */
export class VscodeReliableKernelCommandRouter {
  public constructor(
    private readonly product: VscodeReliableKernelProductRuntime,
    private readonly options: VscodeReliableKernelCommandRouterOptions = {}
  ) {}

  public handle(
    clientId: string,
    webview: vscode.Webview,
    message: WebviewToExtensionMessage
  ): void {
    void this.dispatch(clientId, webview, message).catch((error) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error('[LimCode] Reliable Webview command failed.', message.type, error);
      this.postRequestError(webview, message.type, text, message.id);
      if (isConfigurationMutationType(message.type)) {
        void this.postConfigurationSnapshot(webview).catch((snapshotError) =>
          console.warn('[LimCode] Failed to reconcile configuration snapshot after mutation error.', snapshotError)
        );
      }
      void vscode.window.showWarningMessage(`LimCode：${text}`);
    });
  }

  private async dispatch(
    clientId: string,
    webview: vscode.Webview,
    message: WebviewToExtensionMessage
  ): Promise<void> {
    switch (message.type) {
      case BridgeMessageType.Ready:
        this.product.application.webviewFeed.reconnect(clientId);
        await this.postConfigurationSnapshot(webview, message.id);
        return;
      case BridgeMessageType.ConversationOpen:
        if (message.payload?.conversationId) {
          await this.product.application.webviewFeed.setActiveConversation(clientId, message.payload.conversationId);
        }
        return;
      case BridgeMessageType.ClientResync:
        this.product.application.webviewFeed.reconnect(clientId, message.payload?.conversationId ?? null);
        return;
      case BridgeMessageType.Ping:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.Pong,
          channel: 'control',
          correlationId: message.id,
          payload: { text: message.payload?.text ?? 'pong', receivedAt: Date.now() }
        });
        return;
      case BridgeMessageType.GetWorkspaceInfo:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.WorkspaceInfo,
          channel: 'control',
          correlationId: message.id,
          payload: {
            name: vscode.workspace.name ?? '',
            folders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? []
          }
        });
        return;
      case BridgeMessageType.ProjectFoldersGet:
        this.postProjectFolders(webview, message.id);
        return;
      case BridgeMessageType.GlobalSettingsGet:
        await this.postGlobalSettings(webview, requirePayload(message.payload, 'Global settings get'), message.id);
        return;
      case BridgeMessageType.GlobalSettingsUpdate:
        await this.updateGlobalSettings(webview, requirePayload(message.payload, 'Global settings update'), message.id);
        return;
      case BridgeMessageType.ConversationSettingsGet:
        await this.postConversationSettings(webview, requirePayload(message.payload, 'Conversation settings get'), message.id);
        return;
      case BridgeMessageType.ConversationSettingsUpdate:
        await this.updateConversationSettings(webview, requirePayload(message.payload, 'Conversation settings update'), message.id);
        return;
      case BridgeMessageType.LlmProviderModelsGet:
        await this.postProviderModels(webview, requirePayload(message.payload, 'Provider models get'), message.id);
        return;
      case BridgeMessageType.FsStatGet:
        await this.postFsStats(webview, message.payload?.paths ?? [], message.id);
        return;
      case BridgeMessageType.ConversationCreate: {
        if (!this.options.createConversation) throw new Error('当前 Webview 容器不能创建 Conversation。');
        const conversationId = await this.options.createConversation({
          ...(message.payload?.projectFolderUri?.trim() ? { projectFolderUri: message.payload.projectFolderUri.trim() } : {})
        });
        await this.product.application.webviewFeed.setActiveConversation(clientId, conversationId);
        return;
      }
      case BridgeMessageType.ConversationFork: {
        if (!this.options.forkConversation) throw new Error('当前 Webview 容器不能创建 Conversation 分支。');
        const payload = requirePayload(message.payload, 'Conversation fork');
        const conversationId = await this.options.forkConversation(payload.sourceConversationId, payload.messageId);
        await this.product.application.webviewFeed.setActiveConversation(clientId, conversationId);
        return;
      }
      case BridgeMessageType.AgentCreate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.createAgent(requirePayload(message.payload, 'Agent create')));
        return;
      case BridgeMessageType.AgentUpdate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.updateAgent(requirePayload(message.payload, 'Agent update')));
        return;
      case BridgeMessageType.AgentDelete: {
        const payload = requirePayload(message.payload, 'Agent delete');
        const links = await this.list('AgentConversationLink', { agent_id: payload.agentId }, 1);
        if (links.length > 0) throw new Error('该 Agent 仍被 Conversation 引用，不能删除。');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.deleteAgent(payload));
        return;
      }
      case BridgeMessageType.ConversationAgentSelect:
        await this.handleConversationAgentSelect(requirePayload(message.payload, 'Conversation Agent select'));
        return;
      case BridgeMessageType.WorkflowCreate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.createWorkflow(requirePayload(message.payload, 'Workflow create')));
        return;
      case BridgeMessageType.WorkflowUpdate:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.updateWorkflow(requirePayload(message.payload, 'Workflow update')));
        return;
      case BridgeMessageType.WorkflowDelete:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.deleteWorkflow(requirePayload(message.payload, 'Workflow delete').workflowId));
        return;
      case BridgeMessageType.ConversationWorkflowSelect: {
        const payload = requirePayload(message.payload, 'Conversation Workflow select');
        await this.requireRow('Conversation', payload.conversationId);
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.selectConversationWorkflow(payload));
        return;
      }
      case BridgeMessageType.ModelProfileScopeSet: {
        const payload = requirePayload(message.payload, 'Model Profile scope set');
        if (payload.providerConfigId) await this.product.configuration.providerConfig(payload.providerConfigId);
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setModelProfile(payload));
        return;
      }
      case BridgeMessageType.ModelProfileScopeClear: {
        const payload = requirePayload(message.payload, 'Model Profile scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearModelProfile(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.ToolPolicyScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setToolPolicy(requirePayload(message.payload, 'Tool Policy scope set')));
        return;
      case BridgeMessageType.ToolPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Tool Policy scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearToolPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.SkillPolicyScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setSkillPolicy(requirePayload(message.payload, 'Skill Policy scope set')));
        return;
      case BridgeMessageType.SkillPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Skill Policy scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearSkillPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.SystemPromptScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setSystemPrompt(requirePayload(message.payload, 'System Prompt scope set')));
        return;
      case BridgeMessageType.SystemPromptScopeClear: {
        const payload = requirePayload(message.payload, 'System Prompt scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearSystemPrompt(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.RuntimeContextScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setRuntimeContext(requirePayload(message.payload, 'Runtime Context scope set')));
        return;
      case BridgeMessageType.RuntimeContextScopeClear: {
        const payload = requirePayload(message.payload, 'Runtime Context scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearRuntimeContext(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.PlanReviewPolicyScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setPlanReviewPolicy(requirePayload(message.payload, 'Plan Review Policy scope set')));
        return;
      case BridgeMessageType.PlanReviewPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Plan Review Policy scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearPlanReviewPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.CheckpointPolicyScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setCheckpointPolicy(requirePayload(message.payload, 'Checkpoint Policy scope set')));
        return;
      case BridgeMessageType.CheckpointPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Checkpoint Policy scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearCheckpointPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.WorkEnvironmentPolicyScopeSet:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.setWorkEnvironmentPolicy(requirePayload(message.payload, 'Work Environment Policy scope set')));
        return;
      case BridgeMessageType.WorkEnvironmentPolicyScopeClear: {
        const payload = requirePayload(message.payload, 'Work Environment Policy scope clear');
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.clearWorkEnvironmentPolicy(payload.scopeKind, payload.scopeId));
        return;
      }
      case BridgeMessageType.WorkEnvironmentUpsert:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.upsertWorkEnvironment(requirePayload(message.payload, 'Work Environment upsert').workEnvironment));
        return;
      case BridgeMessageType.WorkEnvironmentRemove:
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.removeWorkEnvironment(requirePayload(message.payload, 'Work Environment remove').workEnvironmentId));
        return;
      case BridgeMessageType.WorkEnvironmentSelect: {
        const payload = requirePayload(message.payload, 'Work Environment select');
        await this.requireRow('Conversation', payload.conversationId);
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.selectConversationWorkEnvironment(payload.conversationId, payload.workEnvironmentId));
        return;
      }
      case BridgeMessageType.WorkEnvironmentImportFromVscode: {
        const payload = requirePayload(message.payload, 'Work Environment import');
        const records = await readVscodeSshWorkEnvironments(payload.includeDefaultSshConfig !== false);
        await this.mutateConfiguration(webview, message.id, () => this.product.configuration.mutations.upsertWorkEnvironments(records));
        void vscode.window.showInformationMessage(`LimCode：已从 VS Code SSH 配置导入 ${records.length} 个工作环境。`);
        return;
      }
      case BridgeMessageType.SkillCatalogRefresh:
        await this.product.toolHost.refreshSkillCatalog();
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      case BridgeMessageType.RulesCatalogRefresh:
        await this.product.toolHost.refreshRulesCatalog();
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      case BridgeMessageType.RulesFileSave: {
        const payload = requirePayload(message.payload, 'Rules file save');
        await this.product.toolHost.saveRulesFile(payload.scope, payload.content);
        await this.broadcastConfigurationSnapshot(webview, message.id);
        return;
      }
      case BridgeMessageType.PlanProposalExport:
        await this.exportPlanProposal(requirePayload(message.payload, 'Plan Proposal export'));
        return;
      case BridgeMessageType.PlanProposalOpen:
        if (!this.options.openPlanProposal) throw new Error('当前 Webview 容器不能打开 Plan Proposal。');
        this.options.openPlanProposal(requirePayload(message.payload, 'Plan Proposal open'));
        return;
      case BridgeMessageType.AttachmentOpen:
        await this.openAttachment(requirePayload(message.payload, 'Attachment open'));
        return;
      case BridgeMessageType.AttachmentReload:
        await this.reloadAttachment(webview, message.id, requirePayload(message.payload, 'Attachment reload'));
        return;
      case BridgeMessageType.CheckpointGitStatusGet:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointGitStatusSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { status: { available: false, checkedAt: Date.now(), message: 'Checkpoint 功能当前未启用。' } }
        });
        return;
      case BridgeMessageType.CheckpointShadowStatsGet:
      case BridgeMessageType.CheckpointShadowDelete:
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointShadowStatsSnapshot,
          channel: 'state',
          correlationId: message.id,
          payload: { stats: [] }
        });
        return;
      case BridgeMessageType.CheckpointRestore: {
        const payload = requirePayload(message.payload, 'Checkpoint restore');
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointRestoreResult,
          channel: 'state',
          correlationId: message.id,
          payload: {
            checkpointId: payload.checkpointId,
            conversationId: payload.conversationId,
            result: { status: 'failed', message: 'Checkpoint 功能当前未启用。' }
          }
        });
        return;
      }
      case BridgeMessageType.CheckpointDiffOpen: {
        const payload = requirePayload(message.payload, 'Checkpoint Diff');
        this.post(webview, {
          id: randomUUID(),
          type: BridgeMessageType.CheckpointDiffOpenResult,
          channel: 'state',
          correlationId: message.id,
          payload: { ...payload, status: 'failed', message: 'Checkpoint 功能当前未启用。' }
        });
        return;
      }
      case BridgeMessageType.CheckpointDismiss:
        throw new Error('Checkpoint 功能当前未启用。');
      case BridgeMessageType.TurnStart:
      case BridgeMessageType.TurnEnqueue:
        await this.handleTurnInput(requirePayload(message.payload, 'Turn input'));
        return;
      case BridgeMessageType.TurnInterrupt:
        await this.handleInterrupt(requirePayload(message.payload, 'Turn interrupt'));
        return;
      case BridgeMessageType.MessageEdit:
        await this.handleMessageEdit(requirePayload(message.payload, 'Message edit'));
        return;
      case BridgeMessageType.MessageDeleteFrom:
        await this.handleMessageDelete(requirePayload(message.payload, 'Message delete'));
        return;
      case BridgeMessageType.MessageRetryFrom:
        await this.handleMessageRetry(requirePayload(message.payload, 'Message retry'));
        return;
      case BridgeMessageType.InteractionResolve:
        await this.handleInteractionResolve(webview, message.id, requirePayload(message.payload, 'Interaction resolve'));
        return;
      case BridgeMessageType.ToolExecutionCancel:
        await this.handleToolCancel(webview, message.id, requirePayload(message.payload, 'Tool cancel'));
        return;
      case BridgeMessageType.ToolDiffOpen: {
        const payload = requirePayload(message.payload, 'Tool Diff');
        const result = await this.product.fileDiffs.openToolCallDiff(payload.toolCallId);
        if (result.status === 'failed') void vscode.window.showWarningMessage(`LimCode：${result.message}`);
        return;
      }
      case BridgeMessageType.ShowInfo:
        if (message.payload?.message) void vscode.window.showInformationMessage(message.payload.message);
        return;
      default:
        this.postRequestError(webview, message.type, `可靠 Runtime 尚不支持该命令：${message.type}`, message.id);
        return;
    }
  }

  private async postConfigurationSnapshot(webview: vscode.Webview, correlationId?: string): Promise<void> {
    this.post(webview, await this.configurationSnapshot(correlationId));
  }

  private async broadcastConfigurationSnapshot(webview: vscode.Webview, correlationId?: string): Promise<void> {
    this.broadcastOrPost(webview, await this.configurationSnapshot(correlationId));
  }

  private async configurationSnapshot(correlationId?: string): Promise<unknown> {
    const state = await this.product.configuration.configurationClientState();
    state.toolDefinitions = this.product.toolHost.definitionRecords();
    state.mcpToolSources = this.product.toolHost.mcp.sourceRecords();
    state.skillDefinitions = this.product.toolHost.skillDefinitions();
    state.ruleFiles = this.product.toolHost.ruleFiles();
    return {
      id: randomUUID(),
      type: BridgeMessageType.ConfigurationSnapshot,
      channel: 'state',
      scope: { kind: 'global' },
      correlationId,
      payload: {
        state,
        loadedAt: Date.now()
      }
    };
  }

  private async mutateConfiguration(
    webview: vscode.Webview,
    correlationId: string | undefined,
    operation: () => Promise<unknown>
  ): Promise<void> {
    await operation();
    await this.broadcastConfigurationSnapshot(webview, correlationId);
  }

  private postProjectFolders(webview: vscode.Webview, correlationId?: string): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.ProjectFoldersSnapshot,
      channel: 'state',
      correlationId,
      payload: {
        folders: (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
          uri: folder.uri.toString(),
          name: folder.name,
          index
        }))
      }
    });
  }

  private async postGlobalSettings(
    webview: vscode.Webview,
    payload: GlobalSettingsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const stored = await this.product.configuration.loadGlobalSettings(payload.section);
    this.post(webview, this.globalSettingsSnapshot(stored, correlationId));
  }

  private async updateGlobalSettings(
    webview: vscode.Webview,
    payload: GlobalSettingsUpdatePayload,
    correlationId?: string
  ): Promise<void> {
    const stored = await this.product.configuration.saveGlobalSettings(payload.section, payload.settings);
    const snapshot = this.globalSettingsSnapshot(stored, correlationId);
    this.broadcastOrPost(webview, snapshot);
    if (payload.section === 'mcpServers') {
      await this.product.toolHost.mcp.refreshFromSettings({ discover: true });
    }
  }

  private globalSettingsSnapshot(
    stored: Awaited<ReturnType<VscodeReliableKernelProductRuntime['configuration']['loadGlobalSettings']>>,
    correlationId?: string
  ): unknown {
    return {
      id: randomUUID(),
      type: BridgeMessageType.GlobalSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'global', id: stored.section },
      correlationId,
      payload: stored
    };
  }

  private async postConversationSettings(
    webview: vscode.Webview,
    payload: ConversationSettingsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const stored = await this.readConversationSettings(payload.conversationId, payload.section);
    this.post(webview, this.conversationSettingsSnapshot(stored, correlationId));
  }

  private async updateConversationSettings(
    webview: vscode.Webview,
    payload: ConversationSettingsUpdatePayload,
    correlationId?: string
  ): Promise<void> {
    const conversationId = payload.settings.conversationId?.trim();
    if (!conversationId) throw new TypeError('Conversation settings 缺少 conversationId。');
    if (payload.section === 'common') {
      const name = 'name' in payload.settings ? payload.settings.name.trim() : '';
      if (!name) throw new TypeError('Conversation 名称不能为空。');
      await this.requireRow('Conversation', conversationId);
      await this.product.application.database.transaction([
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: name,
          updated_at: new Date().toISOString()
        })
      ]);
    } else {
      const input = payload.settings as ConversationLlmSettingsRecord;
      const current = await this.product.configuration.loadGlobalSettings('llm');
      await this.product.configuration.saveGlobalSettings('llm', {
        activeProviderConfigId: input.activeProviderConfigId?.trim()
          || (current.settings as { activeProviderConfigId: string }).activeProviderConfigId
      });
    }
    const stored = await this.readConversationSettings(conversationId, payload.section);
    this.broadcastOrPost(webview, this.conversationSettingsSnapshot(stored, correlationId));
  }

  private async readConversationSettings(
    conversationId: string,
    section: ConversationSettingsGetPayload['section']
  ): Promise<{ conversationId: string; section: ConversationSettingsGetPayload['section']; settings: unknown; filePath: string }> {
    const conversation = await this.requireRow('Conversation', conversationId);
    if (section === 'common') {
      return {
        conversationId,
        section,
        settings: { conversationId, name: String(conversation.title) },
        filePath: ''
      };
    }
    const llm = await this.product.configuration.loadGlobalSettings('llm');
    return {
      conversationId,
      section,
      settings: {
        conversationId,
        activeProviderConfigId: (llm.settings as { activeProviderConfigId: string }).activeProviderConfigId
      },
      filePath: llm.filePath
    };
  }

  private conversationSettingsSnapshot(
    stored: { conversationId: string; section: string; settings: unknown; filePath: string },
    correlationId?: string
  ): unknown {
    return {
      id: randomUUID(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: stored.conversationId },
      correlationId,
      payload: stored
    };
  }

  private async postProviderModels(
    webview: vscode.Webview,
    payload: LlmProviderModelsGetPayload,
    correlationId?: string
  ): Promise<void> {
    const models = await this.product.providerRegistry.listModels(payload.config);
    this.post(webview, {
      id: randomUUID(),
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
  }

  private async postFsStats(webview: vscode.Webview, paths: string[], correlationId?: string): Promise<void> {
    const results = await Promise.all(paths.map(async (inputPath) => {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(inputPath));
        return {
          path: inputPath,
          isDirectory: (stat.type & vscode.FileType.Directory) !== 0,
          exists: true
        };
      } catch {
        return { path: inputPath, isDirectory: false, exists: false };
      }
    }));
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.FsStatResult,
      channel: 'state',
      correlationId,
      payload: { results }
    });
  }

  private async handleConversationAgentSelect(payload: ConversationAgentSelectPayload): Promise<void> {
    const conversationId = requireText(payload.conversationId, 'conversationId');
    const agentId = requireText(payload.agentId, 'agentId');
    await this.requireRow('Conversation', conversationId);
    await this.product.configuration.resolveAgent({ agentId });
    const links = await this.list('AgentConversationLink', { conversation_id: conversationId, role: 'default' }, 2);
    if (links.length !== 1) throw new Error('Conversation 缺少唯一默认 Agent Link。');
    await this.product.application.database.transaction([
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').update(String(links[0].id), {
        agent_id: agentId,
        updated_at: new Date().toISOString()
      })
    ]);
  }

  private async exportPlanProposal(payload: PlanProposalExportPayload): Promise<void> {
    const markdown = payload.markdown;
    if (typeof markdown !== 'string') throw new TypeError('Plan Proposal markdown 必须是字符串。');
    const suggested = sanitizeFileName(payload.suggestedFileName ?? 'plan.md');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.workspace.workspaceFolders?.[0]
        ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, suggested)
        : vscode.Uri.file(suggested),
      filters: { Markdown: ['md'], Text: ['txt'] },
      saveLabel: '导出计划'
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
  }

  private async openAttachment(payload: AttachmentOpenPayload): Promise<void> {
    if (payload.sourcePath?.trim()) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(payload.sourcePath.trim()));
      return;
    }
    if (!payload.attachmentId?.trim()) throw new TypeError('Attachment open 缺少 attachmentId 或 sourcePath。');
    const part = await this.product.application.attachments.resolveInlineData(payload.attachmentId.trim());
    const mimeType = part.inlineData.mimeType.toLowerCase();
    if (!isTextMimeType(mimeType)) {
      throw new Error('二进制 CAS 附件请在内联预览中查看；当前只将文本附件打开为只读文档。');
    }
    const data = part.inlineData.data;
    if (typeof data !== 'string') throw new Error('CAS 附件没有可读取的内联正文。');
    const content = Buffer.from(data, 'base64').toString('utf8');
    const document = await vscode.workspace.openTextDocument({ content, language: languageForMimeType(mimeType) });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async reloadAttachment(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: AttachmentReloadPayload
  ): Promise<void> {
    let part;
    if (payload.attachmentId?.trim()) {
      part = await this.product.application.attachments.resolveInlineData(payload.attachmentId.trim());
    } else if (payload.sourcePath?.trim()) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(payload.sourcePath.trim()));
      part = {
        inlineData: {
          data: Buffer.from(bytes).toString('base64'),
          mimeType: payload.mimeType?.trim() || 'application/octet-stream',
          ...(payload.name?.trim() ? { name: payload.name.trim() } : {}),
          sourcePath: payload.sourcePath.trim()
        }
      };
    } else {
      throw new TypeError('Attachment reload 缺少 attachmentId 或 sourcePath。');
    }
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.AttachmentReloadResult,
      channel: 'state',
      correlationId,
      payload: { request: payload, part, status: 'available' }
    });
  }

  private async handleTurnInput(payload: TurnStartPayload): Promise<void> {
    await this.product.conversations.input({
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      ...(payload.text ? { text: payload.text } : {}),
      ...(payload.content ? { content: payload.content } : {})
    });
  }

  private async handleInterrupt(payload: TurnInterruptPayload): Promise<void> {
    await this.product.conversations.interrupt({
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      turnId: payload.turnId,
      reason: payload.cascadeChildAgents
        ? '用户请求中断当前 Turn 及其子执行。'
        : '用户请求中断当前 Turn。'
    });
    if (payload.cascadeChildAgents) {
      const children = await this.list('ChildExecutionParentLink', { parent_turn_id: payload.turnId }, 1000);
      for (const link of children) {
        await this.product.application.runtime.children.cancelSubtree({
          sourceKey: `${payload.command.commandId}:child:${String(link.child_execution_id)}`,
          childExecutionId: String(link.child_execution_id),
          reason: 'parent_turn_interrupted'
        });
      }
    }
  }

  private async handleMessageEdit(payload: MessageEditPayload): Promise<void> {
    const content = serializeMessagePayload(payload.text, payload.content);
    await this.product.application.turns.edit({
      source: { kind: 'command', key: payload.command.commandId },
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      content: content.value,
      contentType: content.contentType
    });
    if (payload.runAfterEdit) {
      const sourceTurnId = await this.turnIdForMessage(payload.conversationId, payload.messageId);
      await this.product.conversations.retry({
        commandId: `${payload.command.commandId}:retry`,
        conversationId: payload.conversationId,
        sourceTurnId
      });
    }
  }

  private async handleMessageDelete(payload: MessageDeleteFromPayload): Promise<void> {
    const messages = await this.conversationMessages(payload.conversationId);
    const source = messages.find((message) => message.id === payload.messageId);
    if (!source) throw new Error('待删除 Message 不属于当前 Conversation。');
    const targets = messages.filter((message) => message.messageSeq >= source.messageSeq);
    for (let index = 0; index < targets.length; index += 1) {
      await this.product.application.turns.delete({
        source: { kind: 'command', key: `${payload.command.commandId}:${index + 1}` },
        conversationId: payload.conversationId,
        messageId: targets[index].id
      });
    }
  }

  private async handleMessageRetry(payload: MessageRetryFromPayload): Promise<void> {
    const sourceTurnId = await this.turnIdForMessage(payload.conversationId, payload.messageId);
    await this.product.conversations.retry({
      commandId: payload.command.commandId,
      conversationId: payload.conversationId,
      sourceTurnId
    });
  }

  private async handleInteractionResolve(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: InteractionResolvePayload
  ): Promise<void> {
    const request = await this.requireRow('InteractionRequest', payload.interactionRequestId);
    const owner = (await this.list('InteractionOwnerLink', { request_id: payload.interactionRequestId }, 2))[0];
    const toolLink = (await this.list('InteractionToolCallLink', { request_id: payload.interactionRequestId }, 2))[0];
    if (!owner || owner.turn_id !== payload.ownerTurnId) throw new Error('Interaction owner 已变化。');
    if (!toolLink) throw new Error('Interaction 缺少 ToolCall 关系。');
    let won: boolean;
    if (request.request_kind === 'ask_user') {
      const result = await this.product.application.interactions.resolveAskUser({
        source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
        requestId: payload.interactionRequestId,
        response: payload.response,
        cancelled: payload.decision === 'cancel' || payload.decision === 'reject'
      });
      won = result.won;
    } else if (request.request_kind === 'file_change_approval') {
      const changeSets = await this.list('FileChangeSet', { tool_call_id: toolLink.tool_call_id }, 2);
      const changeSet = changeSets[0];
      if (!changeSet) throw new Error('文件 Interaction 缺少 FileChangeSet。');
      const result = await this.product.application.files.decide({
        source: { kind: 'command', key: `interaction:${payload.interactionRequestId}:${payload.decision}:${correlationId ?? randomUUID()}` },
        changeSetId: String(changeSet.id),
        decision: payload.decision === 'accept' || payload.decision === 'submit' ? 'approved' : 'rejected',
        response: payload.response
      });
      won = result.won;
      if (result.preparedEffect) {
        await this.product.application.fileMutations.dispatchRecordAndReconcile(result.preparedEffect.effectIntentId);
      }
    } else {
      throw new Error(`不支持的可靠 Interaction 类型：${String(request.request_kind)}。`);
    }
    this.product.conversations.resume(payload.conversationId, payload.ownerTurnId);
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.InteractionResult,
      correlationId,
      payload: {
        requestType: String(request.request_kind),
        conversationId: payload.conversationId,
        targetId: payload.interactionRequestId,
        status: won ? 'committed' : 'already_resolved'
      }
    });
  }

  private async handleToolCancel(
    webview: vscode.Webview,
    correlationId: string | undefined,
    payload: ToolDecisionPayload
  ): Promise<void> {
    const links = await this.list('InteractionToolCallLink', { tool_call_id: payload.toolCallId }, 10);
    const pending = await Promise.all(links.map((link) => this.requireRow('InteractionRequest', String(link.request_id))));
    const request = pending.find((candidate) => candidate.status === 'pending');
    if (request) {
      const owner = (await this.list('InteractionOwnerLink', { request_id: request.id }, 2))[0];
      if (!owner) throw new Error('Interaction 缺少 owner。');
      await this.handleInteractionResolve(webview, correlationId, {
        conversationId: payload.conversationId ?? String((await this.requireRow('Turn', String(owner.turn_id))).conversation_id),
        interactionRequestId: String(request.id),
        interactionRevision: 1,
        ownerTurnId: String(owner.turn_id),
        decision: request.request_kind === 'ask_user' ? 'cancel' : 'reject',
        response: { reason: payload.reason ?? '用户取消工具。' }
      });
      return;
    }
    const toolCall = await this.requireRow('ToolCall', payload.toolCallId);
    const turn = await this.requireRow('Turn', String(toolCall.turn_id));
    await this.product.conversations.interrupt({
      commandId: `tool-cancel:${payload.toolCallId}:${correlationId ?? randomUUID()}`,
      conversationId: String(turn.conversation_id),
      turnId: String(turn.id),
      reason: payload.reason ?? '用户取消工具执行。'
    });
  }

  private async turnIdForMessage(conversationId: string, messageId: string): Promise<string> {
    const memberships = await this.list('MessagePartOfConversation', { conversation_id: conversationId, message_id: messageId }, 2);
    if (memberships.length !== 1) throw new Error('Message 不属于当前 Conversation。');
    const links = await this.list('MessageTurnLink', { message_id: messageId }, 20);
    const turnIds = [...new Set(links.map((link) => String(link.turn_id)))];
    if (turnIds.length !== 1) throw new Error('Message 缺少唯一 Turn 关系。');
    return turnIds[0];
  }

  private async conversationMessages(conversationId: string): Promise<Array<{ id: string; messageSeq: bigint }>> {
    const memberships = await this.list('MessagePartOfConversation', { conversation_id: conversationId }, 1000);
    return memberships
      .map((row) => ({ id: String(row.message_id), messageSeq: requireBigInt(row.message_seq, 'message_seq') }))
      .sort((left, right) => left.messageSeq < right.messageSeq ? -1 : left.messageSeq > right.messageSeq ? 1 : 0);
  }

  private async requireRow(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.product.application.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} 不存在。`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list 未返回数组。`);
    return rows;
  }

  private broadcastOrPost(webview: vscode.Webview, message: unknown): void {
    if (this.options.broadcast) this.options.broadcast(message);
    else this.post(webview, message);
  }

  private postRequestError(
    webview: vscode.Webview,
    requestType: BridgeMessageType,
    message: string,
    correlationId?: string
  ): void {
    this.post(webview, {
      id: randomUUID(),
      type: BridgeMessageType.Error,
      channel: 'diagnostics',
      correlationId,
      payload: { requestType, message }
    });
  }

  private post(webview: vscode.Webview, message: unknown): void {
    void webview.postMessage(toStructuredClonePlainData(message, 'reliable command result'));
  }
}

function requirePayload<T>(payload: T | undefined, label: string): T {
  if (!payload) throw new TypeError(`${label} payload 缺失。`);
  return payload;
}

function serializeMessagePayload(text: string | undefined, content: { role: string; parts: unknown[] } | undefined): {
  value: string;
  contentType: string;
} {
  if (content?.parts?.length) {
    return { value: JSON.stringify(content), contentType: 'application/vnd.limcode.message+json' };
  }
  const value = text?.trim();
  if (!value) throw new TypeError('Message 内容不能为空。');
  return { value, contentType: 'text/plain; charset=utf-8' };
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} 必须是 bigint。`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function sanitizeFileName(value: string): string {
  const name = value.trim().replace(/[\\/:*?\"<>|\u0000-\u001f]/g, '-').replace(/^\.+/, '').slice(0, 120);
  return name || 'plan.md';
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/')
    || mimeType === 'application/json'
    || mimeType.endsWith('+json')
    || mimeType === 'application/xml'
    || mimeType.endsWith('+xml');
}

function languageForMimeType(mimeType: string): string {
  if (mimeType === 'application/json' || mimeType.endsWith('+json')) return 'json';
  if (mimeType === 'application/xml' || mimeType.endsWith('+xml')) return 'xml';
  if (mimeType.includes('markdown')) return 'markdown';
  return 'plaintext';
}

function isConfigurationMutationType(type: BridgeMessageType): boolean {
  return CONFIGURATION_MUTATION_TYPES.has(type);
}

const CONFIGURATION_MUTATION_TYPES = new Set<BridgeMessageType>([
  BridgeMessageType.AgentCreate,
  BridgeMessageType.AgentUpdate,
  BridgeMessageType.AgentDelete,
  BridgeMessageType.WorkflowCreate,
  BridgeMessageType.WorkflowUpdate,
  BridgeMessageType.WorkflowDelete,
  BridgeMessageType.ConversationWorkflowSelect,
  BridgeMessageType.ModelProfileScopeSet,
  BridgeMessageType.ModelProfileScopeClear,
  BridgeMessageType.ToolPolicyScopeSet,
  BridgeMessageType.ToolPolicyScopeClear,
  BridgeMessageType.SkillPolicyScopeSet,
  BridgeMessageType.SkillPolicyScopeClear,
  BridgeMessageType.SystemPromptScopeSet,
  BridgeMessageType.SystemPromptScopeClear,
  BridgeMessageType.RuntimeContextScopeSet,
  BridgeMessageType.RuntimeContextScopeClear,
  BridgeMessageType.PlanReviewPolicyScopeSet,
  BridgeMessageType.PlanReviewPolicyScopeClear,
  BridgeMessageType.CheckpointPolicyScopeSet,
  BridgeMessageType.CheckpointPolicyScopeClear,
  BridgeMessageType.WorkEnvironmentPolicyScopeSet,
  BridgeMessageType.WorkEnvironmentPolicyScopeClear,
  BridgeMessageType.WorkEnvironmentUpsert,
  BridgeMessageType.WorkEnvironmentRemove,
  BridgeMessageType.WorkEnvironmentSelect,
  BridgeMessageType.WorkEnvironmentImportFromVscode,
  BridgeMessageType.RulesFileSave
]);

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StorageDataResetResult } from '../../capabilities/types';
import { mapSettledWithBoundedConcurrency } from '../../capabilities/boundedConcurrency';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths, type StoragePaths } from '../../capabilities/vscodeStorage/paths';
import { RUNTIME_KERNEL_EPOCH } from '../../reliableKernel/contracts';
import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import { projectFolderAssignmentSteps } from '../../reliableKernel/conversationProject';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import { createVscodeRootAuthority } from '../../reliableKernel/vscodeRootAuthority';
import type { RuntimeCommitResult } from '../../reliableKernel/contracts';
import {
  DEFAULT_CONVERSATION_TITLE,
  displayConversationTitle
} from '../../../shared/conversationTitle';
import { toStructuredClonePlainData } from '../../../shared/plainData';
import type {
  BridgeClientId,
  ConversationForkPayload,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ConversationOriginLinkRecord,
  GlobalSettingsSection,
  ProjectFolderCandidateRecord,
  SidebarConversationHistoryEntry,
  SidebarHistoryScopeKind,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../../shared/protocol';
import type {
  ApplicationFacade,
  ConversationAbortResult,
  ConversationAbortTarget,
  ConversationForkResult
} from '../../../vscode/ApplicationFacade';
import { VscodeReliableKernelCommandRouter } from './VscodeReliableKernelCommandRouter';
import { VscodeReliableKernelCutoverCoordinator } from './VscodeReliableKernelCutoverCoordinator';
import { VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';
import { ExternalDataVersionWatcher } from './ExternalDataVersionWatcher';
import {
  conversationHistoryPreviewFromBytes,
  conversationHistoryTitleContentFromBytes,
  projectChildConversationHistory
} from './conversationHistoryProjection';

const HISTORY_CACHE_LIMIT = 512;
const HISTORY_CONTENT_READ_CONCURRENCY = 4;
const DEFAULT_HISTORY_PAGE_SIZE = 50;

/** VS Code shell facade backed only by the reliable SQLite/CAS Runtime and independent settings authority. */
export class VscodeReliableKernelApplicationFacade implements ApplicationFacade {
  private readonly historyEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversationHistory = this.historyEmitter.event;

  private readonly webviews = new Map<BridgeClientId, vscode.Webview>();
  private readonly commandRouter: VscodeReliableKernelCommandRouter;
  private readonly externalHistoryWatcher: ExternalDataVersionWatcher;
  private historyEntries: SidebarConversationHistoryEntry[] = [];
  private originLinks: ConversationOriginLinkRecord[] = [];
  private readonly historyPreviewByRevisionId = new Map<string, string>();
  private readonly historyTitleByRevisionId = new Map<string, string>();
  private historyRefresh: Promise<void> | undefined;
  private historyRefreshPending = false;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private hydration: Promise<void> | undefined;
  private unsubscribeCommit: (() => void) | undefined;
  private disposed = false;
  private productClosed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    public readonly product: VscodeReliableKernelProductRuntime,
    private readonly getPaths: () => StoragePaths
  ) {
    this.commandRouter = new VscodeReliableKernelCommandRouter(product, {
      broadcast: (message) => this.broadcast(message),
      createConversation: (options) => this.createConversation(options),
      forkConversation: (request) => this.forkConversation(request)
    });
    this.externalHistoryWatcher = new ExternalDataVersionWatcher(
      () => product.application.database.externalDataVersion(),
      () => this.refreshConversationHistory(),
      {
        onError: (error) => {
          console.error('[LimCode] Cross-host conversation history refresh failed.', error);
        }
      }
    );
    this.unsubscribeCommit = product.application.database.onCommit((commit) => this.onRuntimeCommit(commit));
  }

  public static async open(context: vscode.ExtensionContext): Promise<VscodeReliableKernelApplicationFacade> {
    await loadCommittedGlobalStatus(context);
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    const authority = createVscodeRootAuthority(getPaths);
    await new VscodeReliableKernelCutoverCoordinator(authority, getPaths().globalStoragePath).ensureCurrentRoot();
    const product = await VscodeReliableKernelProductRuntime.open(context, { authority });
    return new VscodeReliableKernelApplicationFacade(context, product, getPaths);
  }

  /** Starts the history/watcher hydration after VS Code surfaces have been registered. */
  public startHydration(): Promise<void> {
    this.requireOpen();
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      // Baseline external writer state before the initial history snapshot. A racing commit is then
      // discovered by the watcher instead of being lost between initialization and polling.
      await this.externalHistoryWatcher.start();
      if (this.disposed) return;
      await this.refreshConversationHistory();
      if (this.disposed) return;
      if (this.historyEntries.length === 0) await this.createConversation();
    })();
    return this.hydration;
  }

  public startRuntimeRecovery(): ReturnType<VscodeReliableKernelProductRuntime['startRecovery']> {
    this.requireOpen();
    return this.product.startRecovery();
  }

  public async createConversation(options: { projectFolderUri?: string } = {}): Promise<string> {
    this.requireOpen();
    const conversationId = runtimeId('conversation');
    const agent = await this.product.configuration.resolveAgent({ agentType: 'main' });
    const now = new Date().toISOString();
    const projectFolder = this.resolveProjectFolderForNewConversation(options.projectFolderUri);
    await this.product.application.database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: DEFAULT_CONVERSATION_TITLE,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: runtimeId('agent_conversation_link'),
        conversation_id: conversationId,
        agent_id: agent.agentId,
        role: 'default',
        created_at: now,
        updated_at: now
      }),
      ...(projectFolder
        ? projectFolderAssignmentSteps({
            conversationId,
            folder: { uri: projectFolder.uri.toString(), name: projectFolder.name },
            now
          })
        : [])
    ]);
    await this.refreshConversationHistory();
    return conversationId;
  }

  public async forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult> {
    this.requireOpen();
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const messageId = requireText(request.messageId, 'Conversation fork messageId');
    const expectedRevisionId = requireText(request.expectedRevisionId, 'Conversation fork expectedRevisionId');
    const commandId = requireText(request.command?.commandId, 'Conversation fork commandId');
    const reuseKey = `conversation-fork-command:${commandId}`;

    // Replay is resolved from the immutable branch/reuse facts before consulting today's mutable
    // MessageCurrentRevisionLink. A lost result therefore remains replayable even if the source is
    // edited after the original fork committed.
    const existingReuse = await this.list('ConversationReuseLink', { reuse_key: reuseKey }, 2);
    if (existingReuse.length > 1) throw new Error('Conversation fork command identity is not unique.');
    if (existingReuse.length === 1) {
      const conversationId = requireText(existingReuse[0].conversation_id, 'ConversationReuseLink.conversation_id');
      const branches = await this.list('ConversationBranchLink', { target_conversation_id: conversationId }, 2);
      if (
        branches.length !== 1
        || branches[0].source_conversation_id !== sourceConversationId
        || branches[0].source_message_revision_id !== expectedRevisionId
      ) throw new Error('Conversation fork command was replayed with different source facts.');
      const revision = await this.requireRow('MessageRevision', expectedRevisionId);
      if (revision.message_id !== messageId) {
        throw new Error('Conversation fork command was replayed with a different source Message.');
      }
      return { conversationId, deduplicated: true };
    }

    await this.requireRow('Conversation', sourceConversationId);
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new Error('Fork 源 Message 缺少唯一当前 Revision。');
    const revisionId = requireText(currentLinks[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
    if (revisionId !== expectedRevisionId) throw new Error('Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。');
    const memberships = await this.list('MessagePartOfConversation', {
      conversation_id: sourceConversationId,
      message_id: messageId
    }, 2);
    if (memberships.length !== 1) throw new Error('Fork 源 Message 不属于当前 Conversation。');
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: revisionId
    }, 10);
    if (sources.length === 0) throw new Error('Fork 源 MessageRevision 尚未进入 Context DAG。');
    const sourceSegmentIds = new Set(sources.map((row) => requireText(row.segment_id, 'ContextSegmentSource.segment_id')));
    const revision = await this.requireRow('MessageRevision', revisionId);
    const requiredToolPairSegmentIds: string[] = [];
    if (revision.role === 'model') {
      const callLinks = (await this.product.application.database.snapshotAll(
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
          where: { message_id: messageId },
          orderBy: { column: 'id', direction: 'asc' },
          limit: 1000
        })
      )).snapshot.sort((left, right) =>
        compareBigInt(left.provider_ordinal, right.provider_ordinal) || String(left.id).localeCompare(String(right.id))
      );
      for (const callLink of callLinks) {
        const toolCallId = requireText(callLink.tool_call_id, 'ToolCallSourceLink.tool_call_id');
        const pairSources = await this.list('ContextSegmentSource', {
          source_kind: 'tool_call',
          source_id: toolCallId
        }, 2);
        if (pairSources.length !== 1) {
          throw new Error('Fork 源模型消息仍有未闭合工具调用，无法创建非规范 Context 分支。');
        }
        requiredToolPairSegmentIds.push(requireText(
          pairSources[0].segment_id,
          'ContextSegmentSource.segment_id'
        ));
      }
    }
    const roots = (await this.product.application.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').list({
        where: { conversation_id: sourceConversationId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot.sort((left, right) =>
      compareBigInt(left.root_seq, right.root_seq) || String(left.id).localeCompare(String(right.id))
    );
    let sourceRootId: string | undefined;
    for (const root of roots) {
      const rootId = requireText(root.id, 'ContextSequenceRoot.id');
      const structure = await this.product.application.context.materializeStructure(rootId);
      const segmentIndexes = new Map(structure.records.map((record, index) => [String(record.segment.id), index]));
      const messageIndex = structure.records.findIndex((record) => sourceSegmentIds.has(String(record.segment.id)));
      let previousIndex = messageIndex;
      const containsClosedToolSuffix = messageIndex >= 0 && requiredToolPairSegmentIds.every((segmentId) => {
        const index = segmentIndexes.get(segmentId) ?? -1;
        if (index <= previousIndex) return false;
        previousIndex = index;
        return true;
      });
      if (messageIndex >= 0 && containsClosedToolSuffix) {
        sourceRootId = rootId;
        break;
      }
    }
    if (!sourceRootId) throw new Error('无法定位 Fork 源 MessageRevision 对应的 Context root。');

    const turnLinks = (await this.product.application.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({
        where: { message_id: messageId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot;
    const sourceTurnIds = [...new Set(turnLinks.map((row) => String(row.turn_id)))];
    const agentLinks = await this.list('AgentConversationLink', {
      conversation_id: sourceConversationId,
      role: 'default'
    }, 2);
    if (agentLinks.length !== 1) throw new Error('Fork 源 Conversation 缺少唯一默认 Agent 关系。');
    const result = await this.product.application.runtime.conversationFork.fork({
      idempotencyKey: commandId,
      reuseKey,
      sourceConversationId,
      sourceContextRootId: sourceRootId,
      sourceMessageRevisionId: revisionId,
      expectedCurrentMessageRevisionId: revisionId,
      ...(sourceTurnIds.length === 1 ? { sourceTurnId: sourceTurnIds[0] } : {}),
      targetTitle: `${this.getConversationDisplayTitle(sourceConversationId)} 分支`,
      targetAgentId: requireText(agentLinks[0].agent_id, 'AgentConversationLink.agent_id')
    });
    await this.refreshConversationHistory();
    return { conversationId: result.targetConversationId, deduplicated: result.deduplicated };
  }

  public waitUntilHydrated(): Promise<void> {
    return this.startHydration();
  }

  public getConversationDisplayTitle(conversationId: string | undefined): string {
    if (!conversationId) return DEFAULT_CONVERSATION_TITLE;
    const entry = this.historyEntries.find((candidate) => candidate.id === conversationId);
    return displayConversationTitle({ id: conversationId, title: entry?.title });
  }

  public prepareConversationForSidebarOpen(conversationId: string, title?: string): boolean {
    const entry = this.historyEntries.find((candidate) => candidate.id === conversationId);
    if (!entry) return false;
    if (title?.trim() && entry.title !== title.trim()) entry.title = title.trim();
    return true;
  }

  public async renameConversationTitle(conversationId: string, title: string): Promise<boolean> {
    this.requireOpen();
    const existing = await this.maybeRow('Conversation', conversationId);
    if (!existing) return false;
    const normalized = title.trim();
    if (!normalized) throw new TypeError('Conversation 标题不能为空。');
    await this.product.application.database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
        title: normalized,
        updated_at: new Date().toISOString()
      })
    ]);
    await this.refreshConversationHistory();
    return true;
  }

  public async deleteConversation(conversationId: string): Promise<boolean> {
    this.requireOpen();
    if (!await this.maybeRow('Conversation', conversationId)) return false;
    const activeLease = (await this.list('ExecutionLease', { conversation_id: conversationId }, 2))[0];
    if (activeLease) throw new Error('Conversation 仍有活动 Turn；请先终止后再删除。');
    const activeTurn = (await this.list('Turn', { conversation_id: conversationId, status: 'active' }, 2))[0];
    if (activeTurn) throw new Error('Conversation 仍有活动 Turn；请先终止后再删除。');
    const pendingDelivery = (await this.list('RuntimeDelivery', {
      target_conversation_id: conversationId,
      state: 'pending'
    }, 2))[0];
    if (pendingDelivery) throw new Error('Conversation 仍有待接收的后台结果；结果收敛后才能删除。');
    const processSources = (await this.product.application.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').list({
        where: { conversation_id: conversationId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot;
    for (const source of processSources) {
      const processId = requireText(source.process_id, 'ProcessCompletionSourceLink.process_id');
      const process = await this.maybeRow('Process', processId);
      if (process?.status === 'running') {
        throw new Error('Conversation 仍有后台进程运行；请先等待完成或终止进程后再删除。');
      }
      const receipts = await this.list('ProcessReceipt', { process_id: processId }, 2);
      if (receipts.length === 0) continue;
      const dispatch = (await this.list('ProcessCompletionDispatch', {
        process_receipt_id: receipts[0].id
      }, 2))[0];
      if (dispatch && (dispatch.state === 'pending' || dispatch.state === 'claimed')) {
        throw new Error('Conversation 的后台进程完成结果仍在投递；请等待投递收敛后再删除。');
      }
    }
    await this.product.application.database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').delete(conversationId)
    ]);
    await this.refreshConversationHistory();
    return true;
  }

  public async abortConversation(
    conversationId: string,
    requestId: string,
    target: ConversationAbortTarget
  ): Promise<ConversationAbortResult> {
    this.requireOpen();
    const turnId = requireText(target.turnId, 'abort target Turn.id');
    const expectedLeaseGeneration = requireDecimal(target.leaseGeneration, 'abort target lease generation');
    const turn = await this.maybeRow('Turn', turnId);
    if (!turn || turn.conversation_id !== conversationId) {
      return { status: 'stale', reason: 'target_turn_not_current', turnId };
    }
    if (turn.status === 'terminated') {
      return { status: 'already_satisfied', reason: 'target_turn_already_terminal', turnId };
    }
    if (turn.status !== 'active') return { status: 'stale', reason: 'target_turn_not_active', turnId };
    const leases = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leases.length !== 1 || requireBigInt(leases[0].generation, 'ExecutionLease.generation') !== BigInt(expectedLeaseGeneration)) {
      return { status: 'stale', reason: 'lease_generation_replaced', turnId };
    }
    try {
      await this.product.conversations.interrupt({
        commandId: requestId,
        conversationId,
        turnId,
        expectedLeaseGeneration,
        reason: '用户从侧栏请求终止当前 Conversation。'
      });
      return { status: 'committed', turnId };
    } catch (error) {
      const turn = await this.maybeRow('Turn', turnId);
      if (turn?.status === 'terminated') {
        return { status: 'already_satisfied', reason: 'target_turn_already_terminal', turnId };
      }
      throw error;
    }
  }

  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    return this.historyEntries.map((entry) => ({ ...entry }));
  }

  public async getConversationHistoryPage(input: {
    scopeKind: SidebarHistoryScopeKind;
    projectFolderUri?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationHistoryPageRecord> {
    await this.waitUntilHydrated();
    const scope = this.resolveHistoryScope(input.scopeKind, input.projectFolderUri);
    const limit = normalizePageSize(input.limit);
    const page = await this.queryConversationHistoryPage(scope, input.cursor, limit);
    this.mergeHistoryCache(page.entries, page.originLinks);
    return page;
  }

  public getCurrentProjectHistoryScope(): ConversationHistoryScope {
    const folder = this.currentWorkspaceFolder();
    return folder ? { kind: 'project', folderUri: folder.uri.toString() } : { kind: 'unbound' };
  }

  public getProjectFolderCandidates(): ProjectFolderCandidateRecord[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index
    }));
  }

  public getStorageRootUri(): vscode.Uri {
    return resolveDataRootUri(this.context);
  }

  public refreshGlobalSettings(section: GlobalSettingsSection): Promise<void> {
    this.requireOpen();
    return this.commandRouter.refreshGlobalSettings(section);
  }

  public async resetDevelopmentData(): Promise<StorageDataResetResult> {
    this.requireOpen();
    const binding = this.product.application.database.binding;
    const controlRoot = path.dirname(binding.paths.rootPointerPath);
    const storageRoot = this.getPaths().globalStoragePath;
    const backupRoot = path.join(storageRoot, '.limcode-runtime-backups');
    const backupPath = path.join(backupRoot, timestampSlug());
    this.unsubscribeCommit?.();
    this.unsubscribeCommit = undefined;
    this.productClosed = true;
    await this.product.close();
    let archived = false;
    try {
      await fs.mkdir(backupRoot, { recursive: true });
      await fs.rename(controlRoot, backupPath);
      archived = true;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    const authority = createVscodeRootAuthority(this.getPaths);
    await new VscodeReliableKernelCutoverCoordinator(authority, this.getPaths().globalStoragePath).ensureCurrentRoot();
    return {
      dataRootPath: storageRoot,
      epoch: RUNTIME_KERNEL_EPOCH,
      archivedEntries: archived ? [path.basename(controlRoot)] : [],
      ...(archived ? { backupPath } : {})
    };
  }

  public async inspectReliability(conversationId?: string): Promise<unknown> {
    this.requireOpen();
    const database = await this.product.application.database.inspect();
    return {
      runtime: {
        dataSetId: this.product.application.database.binding.dataSetId,
        rootInstanceId: this.product.application.database.binding.rootInstanceId,
        rootGeneration: this.product.application.database.binding.rootGeneration,
        pointerRevision: this.product.application.database.binding.pointerRevision,
        runtimeKernelEpoch: this.product.application.database.binding.runtimeKernelEpoch
      },
      database,
      recovery: this.product.recoveryState(),
      diagnostics: await this.product.diagnostics.inspect({ scopeId: conversationId, limit: 200 }),
      ...(conversationId ? {
        conversation: await this.maybeRow('Conversation', conversationId),
        activeLeases: await this.list('ExecutionLease', { conversation_id: conversationId }, 10),
        turns: await this.list('Turn', { conversation_id: conversationId }, 200)
      } : {})
    };
  }

  public attachWebview(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    this.requireOpen();
    const clientId = this.product.application.webviewFeed.attach(webview, meta);
    this.webviews.set(clientId, webview);
    return clientId;
  }

  public setWebviewVisible(clientId: BridgeClientId, visible: boolean): void {
    this.product.application.webviewFeed.setVisible(clientId, visible);
  }

  public detachWebview(clientId: BridgeClientId): void {
    this.webviews.delete(clientId);
    this.product.application.webviewFeed.detach(clientId);
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    const webview = this.webviews.get(clientId);
    if (!webview) return;
    this.commandRouter.handle(clientId, webview, message);
  }

  public handleReliableKernelControl(clientId: BridgeClientId, message: unknown): Promise<boolean> {
    return this.product.application.webviewFeed.handleControl(clientId, message);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = undefined;
    this.unsubscribeCommit?.();
    this.unsubscribeCommit = undefined;
    this.externalHistoryWatcher.cancel();
    // Host handoff must not wait behind a projection read which the old Host no longer needs.
    // Closing the product below rejects/settles ordinary database work; keep rejection observed.
    void this.hydration?.catch(() => undefined);
    void this.historyRefresh?.catch(() => undefined);
    for (const clientId of [...this.webviews.keys()]) this.detachWebview(clientId);
    this.historyEmitter.dispose();
    if (!this.productClosed) {
      this.productClosed = true;
      await this.product.close();
    }
  }

  private onRuntimeCommit(commit: RuntimeCommitResult): void {
    if (this.disposed) return;
    if (!commit.changes.some((change) => [
      'Conversation',
      'Turn',
      'ExecutionLease',
      'Message',
      'ConversationOriginLink',
      'AgentConversationLink',
      'ProjectContext',
      'ConversationProjectLink',
      'ChildExecution',
      'ChildExecutionActiveTurnLink',
      'AnswerBridge',
      'RuntimeInboxItem',
      'RuntimeDelivery',
      'RuntimeDeliveryWake',
      // markInputHandled() advances only these two domains. Observing both prevents the sidebar
      // from remaining on “等待主 Agent 接收” after the exact delivery input was consumed.
      'RuntimeDeliveryInputLink',
      'PendingTurnInput'
    ].includes(change.domain))) return;
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = undefined;
      void this.refreshConversationHistory().catch((error) => {
        console.error('[LimCode] Reliable conversation history refresh failed.', error);
      });
    }, 25);
  }

  private refreshConversationHistory(): Promise<void> {
    if (this.historyRefresh) {
      // A commit may arrive while CAS-backed previews are still being read. Remember that edge so
      // the exact delivery/handled state cannot remain stuck at the older snapshot indefinitely.
      this.historyRefreshPending = true;
      return this.historyRefresh;
    }
    this.historyRefresh = (async () => {
      do {
        this.historyRefreshPending = false;
        await this.readConversationHistory();
      } while (this.historyRefreshPending && !this.disposed);
    })()
      .finally(() => { this.historyRefresh = undefined; });
    return this.historyRefresh;
  }

  private async readConversationHistory(): Promise<void> {
    const page = await this.queryConversationHistoryPage({ kind: 'all' }, undefined, DEFAULT_HISTORY_PAGE_SIZE);
    this.historyEntries = page.entries;
    this.originLinks = page.originLinks;
    this.historyEmitter.fire();
  }

  private async queryConversationHistoryPage(
    scope: ConversationHistoryScope,
    cursor: string | undefined,
    limit: number
  ): Promise<ConversationHistoryPageRecord> {
    const scopeKey = conversationHistoryScopeKey(scope);
    const decoded = decodeHistoryKeysetCursor(cursor, scopeKey, limit);
    const projection = await this.product.application.database.conversationHistoryProjection({
      scopeKind: scope.kind,
      ...(scope.kind === 'project' ? { projectFolderUri: scope.folderUri } : {}),
      limit,
      ...(decoded.anchor ? { afterUpdatedAt: decoded.anchor.updatedAt, afterId: decoded.anchor.id } : {}),
      ...(decoded.commitSeq ? { expectedCommitSeq: decoded.commitSeq } : {})
    });
    const state = projection.cursorReset ? emptyHistoryCursorState() : decoded;
    const messageCounts = new Map(projection.messageSummaries.map((row) => [
      String(row.conversation_id),
      Number(row.message_count)
    ]));
    const projectedTitles = await this.readConversationHistoryProjectionTitles(projection.titleTargets);
    const previews = await this.readConversationHistoryProjectionPreviews(projection.previewTargets);
    const activeTurnByConversation = new Map(
      projection.turns.filter((row) => row.status === 'active').map((row) => [String(row.conversation_id), row])
    );
    const leaseByTurn = new Map(projection.leases.map((row) => [String(row.turn_id), row]));
    const agentNames = new Map((await this.product.configuration.agents()).map((agent) => [agent.id, agent.name]));
    const defaultAgentByConversation = new Map(projection.agentLinks
      .filter((row) => row.role === 'default')
      .map((row) => [String(row.conversation_id), String(row.agent_id)]));
    const projectContextById = new Map(projection.projectContexts.map((row) => [String(row.id), row]));
    const projectByConversation = new Map(projection.conversationProjectLinks
      .filter((row) => row.role === 'primary')
      .flatMap((row) => {
        const project = projectContextById.get(String(row.project_context_id));
        return project ? [[String(row.conversation_id), project] as const] : [];
      }));
    const entries = projection.conversations.map((row): SidebarConversationHistoryEntry => {
      const id = requireText(row.id, 'Conversation.id');
      const messageCount = messageCounts.get(id) ?? 0;
      const childProjection = projectChildConversationHistory(id, {
        turns: projection.turns,
        leases: projection.leases,
        childExecutions: projection.childExecutions,
        activeTurnLinks: projection.activeChildTurnLinks,
        answerBridges: projection.answerBridges,
        inboxItems: projection.inboxItems,
        deliveries: projection.deliveries,
        deliveryWakes: projection.deliveryWakes,
        deliveryInputLinks: projection.deliveryInputLinks
      });
      const activeTurn = activeTurnByConversation.get(id);
      const activeLease = activeTurn ? leaseByTurn.get(String(activeTurn.id)) : undefined;
      const running = childProjection?.isRunning ?? activeTurn !== undefined;
      const agentId = defaultAgentByConversation.get(id);
      const preview = previews.get(id);
      const projectedTitle = projectedTitles.get(id);
      const project = projectByConversation.get(id);
      return {
        id,
        title: displayConversationTitle({
          id,
          title: String(row.title),
          ...(projectedTitle ? {
            messages: [{
              role: 'user',
              content: { role: 'user', parts: [{ text: projectedTitle }] }
            }]
          } : {})
        }),
        preview: messageCount === 0 ? '' : preview ?? '消息内容暂不可用',
        ...(messageCount === 0
          ? { previewState: 'empty' as const }
          : preview === undefined ? { previewState: 'pending' as const } : {}),
        messageCount,
        status: messageCount > 0 ? 'final' : 'empty',
        createdAt: timestampMs(row.created_at),
        updatedAt: timestampMs(row.updated_at),
        ...(agentId && agentNames.get(agentId) ? { agentName: agentNames.get(agentId) } : {}),
        ...(project ? {
          projectFolderUri: requireText(project.uri, 'ProjectContext.uri'),
          projectName: requireText(project.name, 'ProjectContext.name')
        } : {}),
        isRunning: running,
        ...(running && activeTurn && activeLease ? {
          activeTurnId: requireText(activeTurn.id, 'Turn.id'),
          executionLeaseGeneration: requireBigInt(
            activeLease.generation,
            'ExecutionLease.generation'
          ).toString()
        } : {}),
        ...(childProjection ? { runState: childProjection.state } : running ? { runState: 'running' as const } : {}),
        ...(childProjection?.runStatusLabel
          ? { runStatusLabel: childProjection.runStatusLabel }
          : running ? { runStatusLabel: '执行中' } : {})
      };
    });
    const originLinks = projection.origins.map(conversationOriginLink);
    const lastSeed = projection.seedRows.at(-1);
    const currentCursor = encodeHistoryKeysetCursor(scopeKey, limit, {
      ...state,
      commitSeq: projection.snapshotCommitSeq
    });
    const nextCursor = projection.hasMore && lastSeed
      ? encodeHistoryKeysetCursor(scopeKey, limit, {
          commitSeq: projection.snapshotCommitSeq,
          anchor: { updatedAt: requireText(lastSeed.updated_at, 'Conversation.updated_at'), id: requireText(lastSeed.id, 'Conversation.id') },
          trail: [...state.trail, state.anchor]
        })
      : undefined;
    const previousAnchor = state.trail.at(-1) ?? null;
    const previousCursor = state.trail.length > 0
      ? encodeHistoryKeysetCursor(scopeKey, limit, {
          commitSeq: projection.snapshotCommitSeq,
          anchor: previousAnchor,
          trail: state.trail.slice(0, -1)
        })
      : undefined;
    return {
      scope,
      entries,
      originLinks,
      pageInfo: {
        cursor: currentCursor,
        ...(nextCursor ? { nextCursor } : {}),
        ...(previousCursor ? { previousCursor } : {}),
        pageIndex: state.trail.length,
        pageSize: limit,
        total: projection.total,
        hasNext: Boolean(nextCursor),
        hasPrevious: Boolean(previousCursor)
      }
    };
  }

  private async readConversationHistoryProjectionPreviews(
    targets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>
  ): Promise<Map<string, string>> {
    const previews = new Map<string, string>();
    const unresolved = targets.filter((target) => {
      const cached = this.historyPreviewByRevisionId.get(target.revisionId);
      if (cached === undefined) return true;
      previews.set(target.conversationId, cached);
      return false;
    });
    const settled = await mapSettledWithBoundedConcurrency(
      unresolved,
      HISTORY_CONTENT_READ_CONCURRENCY,
      (target) => this.product.application.contentStore.read(target.content as unknown as ContentObjectMetadata)
    );
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = unresolved[index];
      if (!target) return;
      const preview = conversationHistoryPreviewFromBytes(result.value, String(target.content.content_type));
      if (preview === undefined) return;
      previews.set(target.conversationId, preview);
      this.historyPreviewByRevisionId.set(target.revisionId, preview);
    });
    while (this.historyPreviewByRevisionId.size > HISTORY_CACHE_LIMIT * 2) {
      const oldestRevisionId = this.historyPreviewByRevisionId.keys().next().value as string | undefined;
      if (!oldestRevisionId) break;
      this.historyPreviewByRevisionId.delete(oldestRevisionId);
    }
    return previews;
  }

  private async readConversationHistoryProjectionTitles(
    targets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>
  ): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const unresolved = targets.filter((target) => {
      const cached = this.historyTitleByRevisionId.get(target.revisionId);
      if (cached === undefined) return true;
      titles.set(target.conversationId, cached);
      return false;
    });
    const settled = await mapSettledWithBoundedConcurrency(
      unresolved,
      HISTORY_CONTENT_READ_CONCURRENCY,
      (target) => this.product.application.contentStore.read(target.content as unknown as ContentObjectMetadata)
    );
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = unresolved[index];
      if (!target) return;
      const content = conversationHistoryTitleContentFromBytes(
        result.value,
        String(target.content.content_type)
      );
      if (!content) return;
      const title = displayConversationTitle({
        id: target.conversationId,
        messages: [{ role: 'user', content }]
      });
      titles.set(target.conversationId, title);
      this.historyTitleByRevisionId.set(target.revisionId, title);
    });
    while (this.historyTitleByRevisionId.size > HISTORY_CACHE_LIMIT * 2) {
      const oldestRevisionId = this.historyTitleByRevisionId.keys().next().value as string | undefined;
      if (!oldestRevisionId) break;
      this.historyTitleByRevisionId.delete(oldestRevisionId);
    }
    return titles;
  }

  private mergeHistoryCache(
    entries: SidebarConversationHistoryEntry[],
    origins: ConversationOriginLinkRecord[]
  ): void {
    const entryIds = new Set(entries.map((entry) => entry.id));
    this.historyEntries = [
      ...entries.map((entry) => ({ ...entry })),
      ...this.historyEntries.filter((entry) => !entryIds.has(entry.id))
    ].slice(0, HISTORY_CACHE_LIMIT);
    const originIds = new Set(origins.map((origin) => origin.id));
    this.originLinks = [
      ...origins.map((origin) => ({ ...origin })),
      ...this.originLinks.filter((origin) => !originIds.has(origin.id))
    ].slice(0, HISTORY_CACHE_LIMIT * 2);
  }

  private resolveHistoryScope(kind: SidebarHistoryScopeKind, folderUri?: string): ConversationHistoryScope {
    if (kind === 'currentProject') return this.getCurrentProjectHistoryScope();
    if (kind === 'project' && folderUri?.trim()) {
      return { kind: 'project', folderUri: canonicalFolderUri(folderUri) };
    }
    if (kind === 'all') return { kind: 'all' };
    return { kind: 'unbound' };
  }

  private resolveProjectFolderForNewConversation(folderUriInput?: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folderUriInput?.trim()) {
      const folderUri = canonicalFolderUri(folderUriInput);
      const folder = folders.find((candidate) => candidate.uri.toString() === folderUri);
      if (!folder) throw new Error('新对话指定的项目不属于当前 VS Code 工作区。');
      return folder;
    }
    return folders.length === 1 ? folders[0] : undefined;
  }

  private currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeDocument = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined;
    if (activeFolder) return activeFolder;
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? folders[0] : undefined;
  }

  private async maybeRow(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).get(id)
    ]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : null;
  }

  private async requireRow(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeRow(domain, id);
    if (!row) throw new Error(`${domain} ${id} 不存在。`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(snapshot.snapshot[0], `${domain} list`);
  }

  private broadcast(message: unknown): void {
    const plain = toStructuredClonePlainData(message, 'reliable configuration broadcast');
    for (const webview of this.webviews.values()) {
      void webview.postMessage(plain).then(undefined, (error) => {
        console.warn('[LimCode] Reliable configuration broadcast failed.', error);
      });
    }
  }

  private requireOpen(): void {
    if (this.disposed || this.productClosed) throw new Error('可靠 ApplicationFacade 已关闭。');
  }
}

function runtimeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function requireRows(value: DomainRow | DomainRow[] | null, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 未返回数组。`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} 必须保持 SQLite INTEGER。`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${label} 必须是正十进制整数。`);
  }
  return value;
}

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return DEFAULT_HISTORY_PAGE_SIZE;
  return Math.min(200, value!);
}

function conversationHistoryScopeKey(scope: ConversationHistoryScope): string {
  return scope.kind === 'project' ? `project:${scope.folderUri}` : scope.kind;
}

interface HistoryCursorAnchor { updatedAt: string; id: string }
interface HistoryCursorState {
  commitSeq?: string;
  anchor: HistoryCursorAnchor | null;
  trail: Array<HistoryCursorAnchor | null>;
}

function emptyHistoryCursorState(): HistoryCursorState {
  return { anchor: null, trail: [] };
}

function encodeHistoryKeysetCursor(scopeKey: string, pageSize: number, state: HistoryCursorState): string {
  return Buffer.from(JSON.stringify({
    kind: 'conversation-history-keyset-page',
    scopeKey,
    pageSize,
    commitSeq: state.commitSeq,
    anchor: state.anchor,
    trail: state.trail
  }), 'utf8').toString('base64url');
}

function decodeHistoryKeysetCursor(
  cursor: string | undefined,
  scopeKey: string,
  pageSize: number
): HistoryCursorState {
  if (!cursor) return emptyHistoryCursorState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Conversation history cursor is malformed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Conversation history cursor is malformed.');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.kind !== 'conversation-history-keyset-page'
    || value.scopeKey !== scopeKey
    || value.pageSize !== pageSize
    || (value.commitSeq !== undefined && typeof value.commitSeq !== 'string')
    || !Array.isArray(value.trail)
  ) {
    throw new TypeError('Conversation history cursor does not match the requested tree page.');
  }
  return {
    ...(typeof value.commitSeq === 'string' ? { commitSeq: value.commitSeq } : {}),
    anchor: decodeHistoryCursorAnchor(value.anchor),
    trail: value.trail.map(decodeHistoryCursorAnchor)
  };
}

function decodeHistoryCursorAnchor(value: unknown): HistoryCursorAnchor | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Conversation history cursor anchor is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.updatedAt !== 'string' || !record.updatedAt || typeof record.id !== 'string' || !record.id) {
    throw new TypeError('Conversation history cursor anchor is malformed.');
  }
  return { updatedAt: record.updatedAt, id: record.id };
}

function conversationOriginLink(row: DomainRow): ConversationOriginLinkRecord {
  const createdAt = timestampMs(row.created_at);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    originKind: row.source_tool_call_id ? 'agent' : 'user',
    ...(row.source_conversation_id ? { sourceConversationId: String(row.source_conversation_id) } : {}),
    ...(row.source_tool_call_id ? { sourceToolCallId: String(row.source_tool_call_id) } : {}),
    createdAt,
    updatedAt: createdAt
  };
}


function canonicalFolderUri(value: string): string {
  const text = requireText(value, 'projectFolderUri');
  try {
    return vscode.Uri.parse(text, true).toString();
  } catch {
    throw new TypeError('projectFolderUri 必须是有效的 URI。');
  }
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

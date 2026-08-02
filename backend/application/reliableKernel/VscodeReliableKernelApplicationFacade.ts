import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StorageDataResetResult } from '../../capabilities/types';
import { resolveDataRootUri } from '../../capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths, type StoragePaths } from '../../capabilities/vscodeStorage/paths';
import { RUNTIME_KERNEL_EPOCH } from '../../reliableKernel/contracts';
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
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ConversationOriginLinkRecord,
  ProjectFolderCandidateRecord,
  SidebarConversationHistoryEntry,
  SidebarHistoryScopeKind,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../../shared/protocol';
import type { ApplicationFacade, ConversationAbortResult } from '../../../vscode/ApplicationFacade';
import { VscodeReliableKernelCommandRouter } from './VscodeReliableKernelCommandRouter';
import { VscodeReliableKernelCutoverCoordinator } from './VscodeReliableKernelCutoverCoordinator';
import { VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';

const HISTORY_LIMIT = 1000;
const DEFAULT_HISTORY_PAGE_SIZE = 50;

/** VS Code shell facade backed only by the reliable SQLite/CAS Runtime and independent settings authority. */
export class VscodeReliableKernelApplicationFacade implements ApplicationFacade {
  private readonly historyEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversationHistory = this.historyEmitter.event;

  private readonly webviews = new Map<BridgeClientId, vscode.Webview>();
  private readonly commandRouter: VscodeReliableKernelCommandRouter;
  private historyEntries: SidebarConversationHistoryEntry[] = [];
  private originLinks: ConversationOriginLinkRecord[] = [];
  private historyRefresh: Promise<void> | undefined;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
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
      forkConversation: (sourceConversationId, messageId) => this.forkConversation(sourceConversationId, messageId)
    });
    this.unsubscribeCommit = product.application.database.onCommit((commit) => this.onRuntimeCommit(commit));
  }

  public static async open(context: vscode.ExtensionContext): Promise<VscodeReliableKernelApplicationFacade> {
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    const authority = createVscodeRootAuthority(getPaths);
    await new VscodeReliableKernelCutoverCoordinator(authority, getPaths().globalStoragePath).ensureCurrentRoot();
    const product = await VscodeReliableKernelProductRuntime.open(context, { authority });
    const facade = new VscodeReliableKernelApplicationFacade(context, product, getPaths);
    try {
      await facade.refreshConversationHistory();
      if (facade.historyEntries.length === 0) await facade.createConversation();
      return facade;
    } catch (error) {
      await facade.dispose();
      throw error;
    }
  }

  public async createConversation(_options: { projectFolderUri?: string } = {}): Promise<string> {
    this.requireOpen();
    const conversationId = runtimeId('conversation');
    const agent = await this.product.configuration.resolveAgent({ agentType: 'main' });
    const now = new Date().toISOString();
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
      })
    ]);
    await this.refreshConversationHistory();
    return conversationId;
  }

  public async forkConversation(sourceConversationId: string, messageId: string): Promise<string> {
    this.requireOpen();
    const sourceConversation = await this.requireRow('Conversation', sourceConversationId);
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new Error('Fork 源 Message 缺少唯一当前 Revision。');
    const revisionId = requireText(currentLinks[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
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
      if (structure.records.some((record) => sourceSegmentIds.has(String(record.segment.id)))) {
        sourceRootId = rootId;
        break;
      }
    }
    if (!sourceRootId) throw new Error('无法定位 Fork 源 MessageRevision 对应的 Context root。');

    const turnLinks = await this.list('MessageTurnLink', { message_id: messageId }, 20);
    const sourceTurnIds = [...new Set(turnLinks.map((row) => String(row.turn_id)))];
    const agentLinks = await this.list('AgentConversationLink', {
      conversation_id: sourceConversationId,
      role: 'default'
    }, 2);
    if (agentLinks.length !== 1) throw new Error('Fork 源 Conversation 缺少唯一默认 Agent 关系。');
    const targetConversationId = runtimeId('conversation');
    const operationId = runtimeId('conversation_fork');
    const result = await this.product.application.runtime.conversationFork.fork({
      idempotencyKey: operationId,
      reuseKey: operationId,
      sourceConversationId,
      sourceContextRootId: sourceRootId,
      sourceMessageRevisionId: revisionId,
      ...(sourceTurnIds.length === 1 ? { sourceTurnId: sourceTurnIds[0] } : {}),
      targetConversationId,
      targetTitle: `${String(sourceConversation.title)} 分支`,
      targetAgentId: requireText(agentLinks[0].agent_id, 'AgentConversationLink.agent_id')
    });
    await this.refreshConversationHistory();
    return result.targetConversationId;
  }

  public waitUntilHydrated(): Promise<void> {
    return this.historyRefresh ?? Promise.resolve();
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
    await this.product.application.database.transaction([
      DOMAIN_REPOSITORIES.domain('Conversation').delete(conversationId)
    ]);
    await this.refreshConversationHistory();
    return true;
  }

  public async abortConversation(conversationId: string, requestId = runtimeId('abort')): Promise<ConversationAbortResult> {
    this.requireOpen();
    const lease = (await this.list('ExecutionLease', { conversation_id: conversationId }, 2))[0];
    if (!lease) return { status: 'already_satisfied', reason: 'no_active_turn' };
    const turnId = requireText(lease.turn_id, 'ExecutionLease.turn_id');
    try {
      await this.product.conversations.interrupt({
        commandId: requestId,
        conversationId,
        turnId,
        reason: '用户从侧栏请求终止当前 Conversation。'
      });
      const childLinks = await this.list('ChildExecutionParentLink', { parent_turn_id: turnId }, 1000);
      for (const link of childLinks) {
        await this.product.application.runtime.children.cancelSubtree({
          sourceKey: `${requestId}:child:${String(link.child_execution_id)}`,
          childExecutionId: String(link.child_execution_id),
          reason: 'parent_turn_interrupted'
        });
      }
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
    const scoped = scope.kind === 'project' ? [] : this.getConversationHistoryEntries();
    const limit = normalizePageSize(input.limit);
    const offset = decodeOffset(input.cursor);
    const entries = scoped.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    const previousOffset = Math.max(0, offset - limit);
    const ids = new Set(entries.map((entry) => entry.id));
    return {
      scope,
      entries,
      originLinks: this.originLinks.filter((link) => ids.has(link.conversationId)).map((link) => ({ ...link })),
      pageInfo: {
        ...(nextOffset < scoped.length ? { nextCursor: encodeOffset(nextOffset) } : {}),
        ...(offset > 0 ? { previousCursor: encodeOffset(previousOffset) } : {}),
        pageIndex: Math.floor(offset / limit),
        pageSize: limit,
        total: scoped.length,
        hasNext: nextOffset < scoped.length,
        hasPrevious: offset > 0
      }
    };
  }

  public getConversationHistoryRootUri(): vscode.Uri {
    return vscode.Uri.file(path.dirname(this.product.application.database.binding.paths.rootPointerPath));
  }

  public getCurrentProjectHistoryScope(): ConversationHistoryScope {
    return { kind: 'unbound' };
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
      recovery: this.product.recovery,
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
    this.unsubscribeCommit?.();
    this.unsubscribeCommit = undefined;
    for (const clientId of [...this.webviews.keys()]) this.detachWebview(clientId);
    this.historyEmitter.dispose();
    if (!this.productClosed) {
      this.productClosed = true;
      await this.product.close();
    }
  }

  private onRuntimeCommit(commit: RuntimeCommitResult): void {
    if (!commit.changes.some((change) => [
      'Conversation',
      'Turn',
      'ExecutionLease',
      'Message',
      'ConversationOriginLink',
      'AgentConversationLink'
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
    if (this.historyRefresh) return this.historyRefresh;
    this.historyRefresh = this.readConversationHistory()
      .finally(() => { this.historyRefresh = undefined; });
    return this.historyRefresh;
  }

  private async readConversationHistory(): Promise<void> {
    const barrier = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Conversation').list({ limit: HISTORY_LIMIT }),
      DOMAIN_REPOSITORIES.domain('Turn').list({ limit: HISTORY_LIMIT }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ limit: HISTORY_LIMIT }),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({ limit: HISTORY_LIMIT }),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').list({ limit: HISTORY_LIMIT }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').list({ limit: HISTORY_LIMIT })
    ]);
    const conversations = requireRows(barrier.snapshot[0], 'Conversation history');
    const turns = requireRows(barrier.snapshot[1], 'Turn history');
    const leases = requireRows(barrier.snapshot[2], 'ExecutionLease history');
    const memberships = requireRows(barrier.snapshot[3], 'Message membership history');
    const origins = requireRows(barrier.snapshot[4], 'Conversation origin history');
    const agentLinks = requireRows(barrier.snapshot[5], 'Agent conversation history');
    const messageCounts = countBy(memberships, 'conversation_id');
    const runningConversationIds = new Set(leases.map((row) => String(row.conversation_id)));
    const activeTurnByConversation = new Map(
      turns.filter((row) => row.status === 'active').map((row) => [String(row.conversation_id), row])
    );
    const agentNames = new Map((await this.product.configuration.agents()).map((agent) => [agent.id, agent.name]));
    const defaultAgentByConversation = new Map(agentLinks
      .filter((row) => row.role === 'default')
      .map((row) => [String(row.conversation_id), String(row.agent_id)]));
    this.historyEntries = conversations.map((row) => {
      const id = requireText(row.id, 'Conversation.id');
      const messageCount = messageCounts.get(id) ?? 0;
      const running = runningConversationIds.has(id) || activeTurnByConversation.has(id);
      const agentId = defaultAgentByConversation.get(id);
      return {
        id,
        title: String(row.title),
        preview: '',
        previewState: 'empty' as const,
        messageCount,
        status: messageCount > 0 ? 'final' as const : 'empty' as const,
        createdAt: timestampMs(row.created_at),
        updatedAt: timestampMs(row.updated_at),
        ...(agentId && agentNames.get(agentId) ? { agentName: agentNames.get(agentId) } : {}),
        isRunning: running,
        ...(running ? { runStatusLabel: '执行中' } : {})
      };
    }).sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.id.localeCompare(right.id));
    this.originLinks = origins.map((row) => {
      const createdAt = timestampMs(row.created_at);
      return {
        id: String(row.id),
        conversationId: String(row.conversation_id),
        originKind: row.source_tool_call_id ? 'agent' as const : 'user' as const,
        ...(row.source_conversation_id ? { sourceConversationId: String(row.source_conversation_id) } : {}),
        ...(row.source_tool_call_id ? { sourceToolCallId: String(row.source_tool_call_id) } : {}),
        createdAt,
        updatedAt: createdAt
      };
    });
    this.historyEmitter.fire();
  }

  private resolveHistoryScope(kind: SidebarHistoryScopeKind, folderUri?: string): ConversationHistoryScope {
    if (kind === 'project' && folderUri?.trim()) return { kind: 'project', folderUri: folderUri.trim() };
    if (kind === 'all') return { kind: 'all' };
    return { kind: 'unbound' };
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

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function countBy(rows: DomainRow[], key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== 'string') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return DEFAULT_HISTORY_PAGE_SIZE;
  return Math.min(200, value!);
}

function encodeOffset(offset: number): string {
  return `offset:${offset}`;
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';
}

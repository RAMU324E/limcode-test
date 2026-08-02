import * as vscode from 'vscode';
import { MainPanel } from '../panels/MainPanel';
import { getWebviewHtml } from '../webview/getWebviewHtml';
import type { ApplicationFacade } from '../ApplicationFacade';
import { EXTENSION_BRAND, SIDEBAR_ENTRY_VIEW_ID } from '../../shared/extensionIdentity';
import { toStructuredClonePlainData } from '../../shared/plainData';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  OpenConversationPanelRecord,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind
} from '../../shared/protocol';

const OPEN_CONVERSATION_MESSAGE = 'openConversation';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';
const OPEN_WORKFLOW_SETTINGS_MESSAGE = 'openWorkflowSettings';
const OPEN_AGENT_SETTINGS_MESSAGE = 'openAgentSettings';
const HISTORY_PAGE_GET_MESSAGE = 'sidebar.historyPage.get';
const SIDEBAR_STATE_MESSAGE = 'sidebar.state';
const SIDEBAR_READY_MESSAGE = 'sidebar.ready';
const RENAME_CONVERSATION_MESSAGE = 'renameConversation';
const DELETE_CONVERSATION_MESSAGE = 'deleteConversation';
const ABORT_CONVERSATION_MESSAGE = 'abortConversation';
const CONVERSATION_OPERATION_RESULT_MESSAGE = 'sidebar.conversationOperation.result';

type SidebarConversationOperation = 'delete' | 'abort';

interface SidebarWebviewMessage {
  type?: string;
  conversationId?: string;
  title?: string;
  projectFolderUri?: string;
  scopeKind?: SidebarHistoryScopeKind;
  cursor?: string;
  limit?: number;
  requestId?: string;
}

interface SidebarStateMessage {
  type: typeof SIDEBAR_STATE_MESSAGE;
  history: ConversationHistoryPageRecord;
  activeScopeKind: SidebarHistoryScopeKind;
  activeProjectFolderUri?: string;
  currentProjectScope: ConversationHistoryScope;
  projectFolders: ProjectFolderCandidateRecord[];
  openConversations: OpenConversationPanelRecord[];
}

export function registerSidebarEntryView(context: vscode.ExtensionContext, backendApp: ApplicationFacade): void {
  const provider = new SidebarEntryViewProvider(context.extensionUri, backendApp);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_ENTRY_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(MainPanel.onDidChangeConversationPanelState(() => provider.refreshOpenConversationPanelStates()));
  context.subscriptions.push(backendApp.onDidChangeConversationHistory(() => provider.refreshConversationHistory()));
}

class SidebarEntryViewProvider implements vscode.WebviewViewProvider {
  private lastScopeKind: SidebarHistoryScopeKind = 'currentProject';
  private lastProjectFolderUri: string | undefined;
  private lastCursor: string | undefined;
  private activeWebview: vscode.Webview | undefined;
  private historyWatcher: vscode.FileSystemWatcher | undefined;
  private historyWatcherRoot: string | undefined;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private historyRequestSeq = 0;
  private lastStateMessage: SidebarStateMessage | undefined;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly backendApp: ApplicationFacade
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.activeWebview = webviewView.webview;
    webviewView.onDidDispose(() => {
      if (this.activeWebview === webviewView.webview) this.activeWebview = undefined;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
      ]
    };

    this.ensureConversationHistoryWatcher();

    webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (message.type === OPEN_CONVERSATION_MESSAGE && message.conversationId) {
        if (!this.backendApp.prepareConversationForSidebarOpen(message.conversationId, message.title)) {
          this.postSidebarStateWhenReady(webviewView.webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
          void vscode.window.showWarningMessage(`${EXTENSION_BRAND}: 该对话已被删除或不再存在。`);
          return;
        }
        MainPanel.createOrShow(this.extensionUri, this.backendApp, {
          conversationId: message.conversationId,
          title: message.title,
          reuse: true
        });
        return;
      }

      if (message.type === NEW_CONVERSATION_MESSAGE) {
        this.createConversationFromSidebar(webviewView.webview, message.projectFolderUri);
        return;
      }

      if (message.type === OPEN_GLOBAL_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'globalSettings', reuse: true });
        return;
      }

      if (message.type === OPEN_WORKFLOW_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'workflowSettings', reuse: true });
        return;
      }

      if (message.type === OPEN_AGENT_SETTINGS_MESSAGE) {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { kind: 'agentSettings', reuse: true });
        return;
      }

      if (message.type === RENAME_CONVERSATION_MESSAGE && message.conversationId && typeof message.title === 'string') {
        this.renameConversationFromSidebar(webviewView.webview, message.conversationId, message.title);
        return;
      }

      if (message.type === DELETE_CONVERSATION_MESSAGE && message.conversationId) {
        this.deleteConversationFromSidebar(webviewView.webview, message.conversationId);
        return;
      }

      if (message.type === ABORT_CONVERSATION_MESSAGE && message.conversationId && message.requestId) {
        this.abortConversationFromSidebar(webviewView.webview, message.conversationId, message.requestId);
        return;
      }

      if (message.type === SIDEBAR_READY_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, 'currentProject');
        return;
      }

      if (message.type === HISTORY_PAGE_GET_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, message.scopeKind ?? 'currentProject', message.cursor, message.limit, message.projectFolderUri);
      }
    });

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, {
      htmlFileName: 'sidebar.html',
      devEntry: '/src/sidebar/main.ts',
      title: `${EXTENSION_BRAND} Sidebar`,
      rootId: 'sidebar-app'
    });
  }

  public refreshConversationHistory(): void {
    this.scheduleConversationHistoryRefresh();
  }

  public refreshOpenConversationPanelStates(): void {
    const target = this.activeWebview;
    if (!target) return;
    if (!this.lastStateMessage) {
      this.scheduleConversationHistoryRefresh();
      return;
    }
    const message = this.withLivePanelState(this.lastStateMessage);
    this.lastStateMessage = message;
    void postSidebarWebviewMessage(target, message);
  }

  private postSidebarStateWhenReady(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind = 'currentProject', cursor?: string, limit?: number, projectFolderUri?: string): Promise<void> {
    this.activeWebview = webview;
    this.ensureConversationHistoryWatcher();
    const requestSeq = ++this.historyRequestSeq;
    return this.postSidebarState(webview, scopeKind, cursor, limit, projectFolderUri, requestSeq)
      .catch((error) => console.warn('[LimCode] Failed to read sidebar state.', error));
  }

  private ensureConversationHistoryWatcher(): void {
    const root = this.backendApp.getConversationHistoryRootUri();
    const rootKey = root.toString();
    if (this.historyWatcher && this.historyWatcherRoot === rootKey) return;

    this.historyWatcher?.dispose();
    this.historyWatcherRoot = rootKey;
    void Promise.resolve(vscode.workspace.fs.createDirectory(root)).catch((error: unknown) => {
      console.warn('[LimCode] Failed to ensure conversation history watcher root.', error);
    });

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*.json'));
    const schedule = () => this.scheduleConversationHistoryRefresh();
    watcher.onDidCreate(schedule);
    watcher.onDidChange(schedule);
    watcher.onDidDelete(schedule);
    this.historyWatcher = watcher;
  }

  private scheduleConversationHistoryRefresh(): void {
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = undefined;
      const target = this.activeWebview;
      if (!target) return;
      this.postSidebarStateWhenReady(target, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
    }, 180);
  }

  private createConversationFromSidebar(webview: vscode.Webview, projectFolderUri?: string): void {
    void this.backendApp
      .createConversation({ projectFolderUri })
      .then((conversationId) => {
        MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to create sidebar conversation.', error));
  }

  private renameConversationFromSidebar(webview: vscode.Webview, conversationId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    void this.backendApp
      .waitUntilHydrated()
      .then(async () => {
        const renamed = await this.backendApp.renameConversationTitle(conversationId, nextTitle);
        if (!renamed) console.warn(`[LimCode] Sidebar rename target not found: ${conversationId}`);
        else MainPanel.refreshConversationTitle(conversationId);
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to rename sidebar conversation.', error));
  }

  private deleteConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    const deletion = this.backendApp.deleteConversation(conversationId);
    void (async () => {
      try {
        const deleted = await deletion;
        if (deleted) MainPanel.closePanelsByConversationId(conversationId);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        await this.postConversationOperationResult(webview, 'delete', conversationId, deleted, deleted ? undefined : '该对话不存在。');
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除对话失败。';
        console.warn('[LimCode] Failed to delete sidebar conversation.', error);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        await this.postConversationOperationResult(webview, 'delete', conversationId, false, message);
        void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${message}`);
      }
    })();
  }

  private abortConversationFromSidebar(webview: vscode.Webview, conversationId: string, requestId: string): void {
    void (async () => {
      try {
        const outcome = await this.backendApp.abortConversation(conversationId, requestId);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        const ok = outcome.status !== 'stale';
        const message = outcome.status === 'already_satisfied'
          ? outcome.reason === 'target_turn_already_terminal'
            ? '目标回合已经结束；未影响后续排队任务。'
            : '当前对话没有正在执行的回合。'
          : outcome.status === 'stale'
            ? `中断目标状态已变化：${outcome.reason ?? 'turn_not_current'}`
            : undefined;
        await this.postConversationOperationResult(webview, 'abort', conversationId, ok, message, {
          requestId,
          status: outcome.status,
          ...(outcome.turnId ? { turnId: outcome.turnId } : {})
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '终止后台任务失败。';
        console.warn('[LimCode] Failed to abort sidebar conversation.', error);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        await this.postConversationOperationResult(webview, 'abort', conversationId, false, message, { requestId });
        void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${message}`);
      }
    })();
  }

  private async postConversationOperationResult(
    webview: vscode.Webview,
    operation: SidebarConversationOperation,
    conversationId: string,
    ok: boolean,
    message?: string,
    details: {
      requestId?: string;
      status?: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
      runId?: string;
    } = {}
  ): Promise<void> {
    try {
      await postSidebarWebviewMessage(webview, {
        type: CONVERSATION_OPERATION_RESULT_MESSAGE,
        operation,
        conversationId,
        ok,
        ...details,
        ...(message ? { message } : {})
      });
    } catch (error) {
      console.warn('[LimCode] Failed to post sidebar operation result.', error);
    }
  }

  private async postSidebarState(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind, cursor?: string, limit?: number, projectFolderUri?: string, requestSeq = this.historyRequestSeq): Promise<void> {
    this.lastScopeKind = scopeKind;
    this.lastProjectFolderUri = projectFolderUri;
    this.lastCursor = cursor;
    const history = await this.backendApp.getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit });
    if (requestSeq !== this.historyRequestSeq) {
      return;
    }
    const activeProjectFolderUri = projectFolderUri
      ?? (history.scope.kind === 'project' ? history.scope.folderUri : undefined);
    const message: SidebarStateMessage = this.withLivePanelState({
      type: SIDEBAR_STATE_MESSAGE,
      history,
      activeScopeKind: scopeKind,
      ...(activeProjectFolderUri ? { activeProjectFolderUri } : {}),
      currentProjectScope: this.backendApp.getCurrentProjectHistoryScope(),
      projectFolders: this.backendApp.getProjectFolderCandidates(),
      openConversations: []
    });
    this.lastStateMessage = message;
    await postSidebarWebviewMessage(webview, message);
  }

  private withLivePanelState(message: SidebarStateMessage): SidebarStateMessage {
    return {
      ...message,
      currentProjectScope: this.backendApp.getCurrentProjectHistoryScope(),
      projectFolders: this.backendApp.getProjectFolderCandidates(),
      openConversations: MainPanel.getOpenConversationPanelStates()
    };
  }
}

function postSidebarWebviewMessage(webview: vscode.Webview, message: unknown): Thenable<boolean> {
  return webview.postMessage(toStructuredClonePlainData(message, 'sidebar webview message'));
}

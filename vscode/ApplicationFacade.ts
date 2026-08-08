import type * as vscode from 'vscode';
import type { StorageDataResetResult } from '../backend/capabilities/types';
import type {
  BridgeClientId,
  ConversationForkPayload,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ProjectFolderCandidateRecord,
  GlobalSettingsSection,
  SidebarConversationHistoryEntry,
  SidebarHistoryScopeKind,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../shared/protocol';

export interface ConversationAbortResult {
  status: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
  reason?: string;
  turnId?: string;
}

export interface ConversationAbortTarget {
  turnId: string;
  leaseGeneration: string;
}

export interface ConversationForkResult {
  conversationId: string;
  deduplicated: boolean;
}

/** VS Code shell 只依赖此门面，不拥有或推断 Runtime 领域关系。 */
export interface ApplicationFacade {
  readonly onDidChangeConversationHistory: vscode.Event<void>;

  createConversation(options?: { projectFolderUri?: string }): Promise<string>;
  forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult>;
  waitUntilHydrated(): Promise<void>;
  getConversationDisplayTitle(conversationId: string | undefined): string;
  prepareConversationForSidebarOpen(conversationId: string, title?: string): boolean;
  renameConversationTitle(conversationId: string, title: string): Promise<boolean>;
  deleteConversation(conversationId: string): Promise<boolean>;
  abortConversation(
    conversationId: string,
    requestId: string,
    target: ConversationAbortTarget
  ): Promise<ConversationAbortResult>;

  getConversationHistoryEntries(): SidebarConversationHistoryEntry[];
  getConversationHistoryPage(input: {
    scopeKind: SidebarHistoryScopeKind;
    projectFolderUri?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationHistoryPageRecord>;
  getConversationHistoryRootUri(): vscode.Uri;
  getCurrentProjectHistoryScope(): ConversationHistoryScope;
  getProjectFolderCandidates(): ProjectFolderCandidateRecord[];

  getStorageRootUri(): vscode.Uri;
  refreshGlobalSettings(section: GlobalSettingsSection): Promise<void>;
  resetDevelopmentData(): Promise<StorageDataResetResult>;
  inspectReliability(conversationId?: string): Promise<unknown>;

  attachWebview(webview: vscode.Webview, meta?: WebviewClientMeta): BridgeClientId;
  detachWebview(clientId: BridgeClientId): void;
  handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void;
  handleReliableKernelControl?(clientId: BridgeClientId, message: unknown): Promise<boolean> | boolean;
  dispose(): Promise<void>;
}

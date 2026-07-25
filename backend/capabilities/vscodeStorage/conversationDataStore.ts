import * as vscode from 'vscode';
import type { StoragePaths } from './clientStateStore';
import { conversationShardName } from './naming';
import { withRecordStoreTransaction } from './recordStore';

const CONVERSATION_SETTINGS_TRANSACTIONS_DIR = '.conversation-settings-transactions';

/** Serializes one Conversation's independent settings files; it never writes Conversation facts. */
export function withConversationDataTransaction<T>(
  paths: StoragePaths,
  conversationId: string,
  action: () => Promise<T>
): Promise<T> {
  const transactionUri = vscode.Uri.joinPath(
    paths.settingsRootUri,
    CONVERSATION_SETTINGS_TRANSACTIONS_DIR,
    conversationShardName(conversationId)
  );
  return withRecordStoreTransaction(transactionUri, action);
}

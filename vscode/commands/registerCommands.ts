import * as vscode from 'vscode';
import { MainPanel, type MainPanelOptions } from '../panels/MainPanel';
import type { ApplicationFacade } from '../ApplicationFacade';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';

export function registerCommands(context: vscode.ExtensionContext, backendApp: ApplicationFacade): void {
  const openPanelCommand = vscode.commands.registerCommand(EXTENSION_COMMAND_IDS.openPanel, async (options?: unknown) => {
    MainPanel.createOrShow(context.extensionUri, backendApp, await resolveOpenPanelOptions(backendApp, options));
  });

  const revealGlobalStorageCommand = vscode.commands.registerCommand(EXTENSION_COMMAND_IDS.revealGlobalStorage, async () => {
    const storageRootUri = backendApp.getStorageRootUri();
    await vscode.workspace.fs.createDirectory(storageRootUri);
    await vscode.commands.executeCommand('revealFileInOS', storageRootUri);
  });

  const resetDevelopmentDataCommand = vscode.commands.registerCommand(EXTENSION_COMMAND_IDS.resetDevelopmentData, async () => {
    const dataRoot = backendApp.getStorageRootUri().fsPath;
    const confirmed = await vscode.window.showWarningMessage(
      `归档并重置 ${EXTENSION_BRAND} 开发数据？`,
      {
        modal: true,
        detail: `扩展将先停止所有写入，把受管数据归档到 data root 内的 .limcode-data-backups，然后创建当前数据 epoch。不会删除该目录中的其它用户文件。\n\n${dataRoot}`
      },
      '归档并重置'
    );
    if (confirmed !== '归档并重置') return;

    try {
      const result = await backendApp.resetDevelopmentData();
      const detail = result.backupPath
        ? `旧数据已归档到：${result.backupPath}`
        : '当前 data root 中没有需要归档的旧数据。';
      await vscode.window.showInformationMessage(`${EXTENSION_BRAND} 开发数据已重置。${detail}`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`${EXTENSION_BRAND} 数据重置失败：${message}`);
    }
  });

  const inspectReliabilityCommand = vscode.commands.registerCommand(EXTENSION_COMMAND_IDS.inspectReliability, async (options?: unknown) => {
    if (context.extensionMode !== vscode.ExtensionMode.Development) {
      await vscode.window.showInformationMessage('可靠性 inspector 仅在 Extension Development Host 中开放。');
      return;
    }
    let conversationId = requestedConversationId(options);
    if (conversationId === undefined) {
      const entries = backendApp.getConversationHistoryEntries();
      const selected = await vscode.window.showQuickPick([
        { label: 'Data root（全局）', description: 'writer、StorageHead、WAL、receipt 与全部 loaded Stable ID', conversationId: '' },
        ...entries.map((entry) => ({
          label: entry.title || entry.id,
          description: entry.id,
          conversationId: entry.id
        }))
      ], { placeHolder: '选择可靠性 inspector 范围' });
      if (!selected) return;
      conversationId = selected.conversationId;
    }
    const snapshot = await backendApp.inspectReliability(conversationId || undefined);
    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: `${JSON.stringify(snapshot, null, 2)}\n`
    });
    await vscode.window.showTextDocument(document, { preview: true });
  });

  context.subscriptions.push(openPanelCommand, revealGlobalStorageCommand, resetDevelopmentDataCommand, inspectReliabilityCommand);
}

export function registerUnavailableCommands(context: vscode.ExtensionContext, message: string): void {
  const displayMessage = `${EXTENSION_BRAND} 运行时无法启动：${message}`;
  const openPanelCommand = vscode.commands.registerCommand(EXTENSION_COMMAND_IDS.openPanel, () => {
    MainPanel.createUnavailable(message);
  });
  const unavailableCommands = [
    EXTENSION_COMMAND_IDS.revealGlobalStorage,
    EXTENSION_COMMAND_IDS.resetDevelopmentData,
    EXTENSION_COMMAND_IDS.inspectReliability
  ].map((commandId) => vscode.commands.registerCommand(commandId, async () => {
    await vscode.window.showErrorMessage(displayMessage);
  }));
  context.subscriptions.push(openPanelCommand, ...unavailableCommands);
}

function requestedConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const conversationId = (value as { conversationId?: unknown }).conversationId;
  return typeof conversationId === 'string' ? conversationId.trim() : undefined;
}

async function resolveOpenPanelOptions(backendApp: ApplicationFacade, value: unknown): Promise<MainPanelOptions> {
  const options = openPanelOptions(value);
  if (options.kind !== undefined && options.kind !== 'chat') return options;
  await backendApp.waitUntilHydrated();
  if (options.conversationId) {
    return {
      ...options,
      title: options.title ?? backendApp.getConversationDisplayTitle(options.conversationId)
    };
  }
  const existing = backendApp.getConversationHistoryEntries()[0];
  const conversationId = existing?.id ?? await backendApp.createConversation();
  return {
    ...options,
    conversationId,
    title: options.title ?? existing?.title ?? backendApp.getConversationDisplayTitle(conversationId),
    reuse: options.reuse ?? true
  };
}

function openPanelOptions(value: unknown): MainPanelOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const options: MainPanelOptions = {};
  if (typeof record.conversationId === 'string' && record.conversationId.trim()) options.conversationId = record.conversationId.trim();
  if (typeof record.title === 'string' && record.title.trim()) options.title = record.title.trim();
  if (record.kind === 'chat' || record.kind === 'globalSettings' || record.kind === 'workflowSettings' || record.kind === 'agentSettings' || record.kind === 'planDetail') options.kind = record.kind;
  if (typeof record.toolCallId === 'string' && record.toolCallId.trim()) options.toolCallId = record.toolCallId.trim();
  if (typeof record.planProposalId === 'string' && record.planProposalId.trim()) options.planProposalId = record.planProposalId.trim();
  if (typeof record.reuse === 'boolean') options.reuse = record.reuse;
  return options;
}

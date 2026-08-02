import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { MainPanel } from './panels/MainPanel';
import { registerSidebarEntryView } from './views/SidebarEntryView';
import { VscodeReliableKernelApplicationFacade } from '../backend/application/reliableKernel/VscodeReliableKernelApplicationFacade';
import { EXTENSION_BRAND } from '../shared/extensionIdentity';
import { RUNTIME_BUILD_INFO } from '../backend/application/runtimeBuildInfo';

let backendApp: VscodeReliableKernelApplicationFacade | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const application = await VscodeReliableKernelApplicationFacade.open(context);
  backendApp = application;

  MainPanel.registerSerializer(context, application);
  registerCommands(context, application);
  registerSidebarEntryView(context, application);

  console.log(`${EXTENSION_BRAND} reliable SQLite/CAS Runtime is active.`, JSON.stringify(RUNTIME_BUILD_INFO));
  void application.startHydration().then(
    () => console.log(`${EXTENSION_BRAND} conversation history hydration completed.`),
    (error) => {
      console.error(`${EXTENSION_BRAND} conversation history hydration failed.`, error);
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`${EXTENSION_BRAND} 对话历史加载失败：${message}`);
    }
  );
  const recoveryStartedAt = Date.now();
  void application.startRuntimeRecovery().then(
    () => console.log(`${EXTENSION_BRAND} reliable Runtime recovery converged in ${Date.now() - recoveryStartedAt}ms.`),
    (error) => {
      if (error instanceof Error && error.name === 'AbortError') return;
      console.error(`${EXTENSION_BRAND} reliable Runtime recovery failed.`, error);
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`${EXTENSION_BRAND} 运行数据恢复失败：${message}`);
    }
  );
}

export async function deactivate(): Promise<void> {
  const app = backendApp;
  backendApp = undefined;
  await app?.dispose();
}

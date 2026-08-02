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
}

export async function deactivate(): Promise<void> {
  const app = backendApp;
  backendApp = undefined;
  await app?.dispose();
}

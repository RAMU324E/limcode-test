import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { MainPanel } from './panels/MainPanel';
import { registerSidebarEntryView } from './views/SidebarEntryView';
import { BackendApplication } from '../backend/application/BackendApplication';
import { EXTENSION_BRAND } from '../shared/extensionIdentity';
import { RUNTIME_BUILD_INFO } from '../backend/application/runtimeBuildInfo';

let backendApp: BackendApplication | undefined;

export function activate(context: vscode.ExtensionContext): void {
  backendApp = new BackendApplication(context);

  MainPanel.registerSerializer(context, backendApp);
  registerCommands(context, backendApp);
  registerSidebarEntryView(context, backendApp);

  console.log(`${EXTENSION_BRAND} (ECS backend) is active.`, JSON.stringify(RUNTIME_BUILD_INFO));
}

export async function deactivate(): Promise<void> {
  const app = backendApp;
  backendApp = undefined;
  await app?.dispose();
}

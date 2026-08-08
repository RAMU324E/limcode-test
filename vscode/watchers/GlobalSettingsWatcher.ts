import * as vscode from 'vscode';
import type { ApplicationFacade } from '../ApplicationFacade';
import type { GlobalSettingsSection } from '../../shared/protocol';
import { LIMCODE_GLOBAL_STATUS_FILE } from '../../backend/capabilities/vscodeStorage/globalStatus';

/** 只监听全局设置白名单，避免把会话文件变化误当成设置变化。 */
const GLOBAL_SETTINGS_WATCH_PATTERNS = [
  'settings/{llm,llm-compression,appearance,attachments,checkpoint-maintenance}.json',
  'settings/llm-provider-configs/**/*.json',
  'settings/llm-compression-configs/**/*.json',
  'settings/mcp-servers/**/*.json'
] as const;

const FILE_NAME_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm.json': 'llm',
  'llm-compression.json': 'llmCompression',
  'appearance.json': 'appearance',
  'attachments.json': 'attachments',
  'checkpoint-maintenance.json': 'checkpointMaintenance'
};

const DIRECTORY_SECTIONS: Record<string, GlobalSettingsSection> = {
  'llm-provider-configs': 'llmProviderConfigs',
  'llm-compression-configs': 'llmCompressionConfigs',
  'mcp-servers': 'mcpServers'
};

const REFRESH_DEBOUNCE_MS = 180;

export function registerGlobalSettingsWatcher(
  context: vscode.ExtensionContext,
  application: ApplicationFacade
): void {
  const watcher = new GlobalSettingsWatcher(application, context.globalStorageUri);
  context.subscriptions.push(watcher);
  watcher.start();
}

class GlobalSettingsWatcher implements vscode.Disposable {
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private readonly dirtySections = new Set<GlobalSettingsSection>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly application: ApplicationFacade,
    private readonly canonicalStatusRoot: vscode.Uri
  ) {}

  public start(): void {
    const root = this.application.getStorageRootUri();
    for (const pattern of GLOBAL_SETTINGS_WATCH_PATTERNS) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, pattern));
      const schedule = (uri: vscode.Uri) => this.schedule(uri);
      watcher.onDidCreate(schedule);
      watcher.onDidChange(schedule);
      watcher.onDidDelete(schedule);
      this.watchers.push(watcher);
    }
    const statusWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.canonicalStatusRoot, LIMCODE_GLOBAL_STATUS_FILE)
    );
    const scheduleCommon = () => this.scheduleSection('common');
    statusWatcher.onDidCreate(scheduleCommon);
    statusWatcher.onDidChange(scheduleCommon);
    statusWatcher.onDidDelete(scheduleCommon);
    this.watchers.push(statusWatcher);
  }

  public dispose(): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers.length = 0;
  }

  private schedule(uri: vscode.Uri): void {
    const section = sectionFromSettingsUri(uri);
    if (!section) return;
    this.scheduleSection(section);
  }

  private scheduleSection(section: GlobalSettingsSection): void {
    this.dirtySections.add(section);
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      const sections = [...this.dirtySections];
      this.dirtySections.clear();
      for (const item of sections) {
        void this.application.refreshGlobalSettings(item).catch((error) => {
          console.warn(`[LimCode] Failed to refresh externally changed settings: ${item}`, error);
        });
      }
    }, REFRESH_DEBOUNCE_MS);
  }
}

export function sectionFromSettingsUri(uri: vscode.Uri): GlobalSettingsSection | undefined {
  const segments = uri.path.split('/').filter(Boolean);
  const settingsIndex = segments.lastIndexOf('settings');
  if (settingsIndex < 0) return undefined;
  const rest = segments.slice(settingsIndex + 1);
  if (rest.length === 1) return FILE_NAME_SECTIONS[rest[0]];
  return rest.length > 1 ? DIRECTORY_SECTIONS[rest[0]] : undefined;
}

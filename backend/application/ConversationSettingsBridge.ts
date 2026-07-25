import type { World } from '../ecs/types';
import type { StorageCapability, WebviewCapability } from '../capabilities/types';
import { Conversation } from '../world/modules/chat/components';
import {
  BridgeMessageType,
  conversationSettingsStreamId,
  createMessageId,
  type BridgeClientId,
  type ConversationLlmSettingsRecord,
  type ConversationSettingsRecord,
  type ConversationSettingsSection,
  type ConversationSettingsSectionValue,
  type ConversationSettingsUpdatePayload,
  type ExtensionToWebviewMessage
} from '../../shared/protocol';
import { DEFAULT_CONVERSATION_TITLE, displayConversationTitle } from '../../shared/conversationTitle';

type StoredConversationSettings = {
  conversationId: string;
  section: ConversationSettingsSection;
  settings: ConversationSettingsSectionValue;
  filePath: string;
};

export interface ConversationSettingsBridgeDeps {
  world: World;
  storage: StorageCapability;
  webview: WebviewCapability;
  requestSnapshot: (conversationId?: string) => void;
  renameConversation(conversationId: string, title: string): Promise<boolean>;
  afterRead?: (stored: StoredConversationSettings) => Promise<void> | void;
  afterUpdate?: (stored: StoredConversationSettings) => Promise<void> | void;
}

export class ConversationSettingsBridge {
  public constructor(private readonly deps: ConversationSettingsBridgeDeps) {}

  public async postSnapshot(clientId: BridgeClientId, conversationId: string, section: ConversationSettingsSection, correlationId?: string): Promise<void> {
    const streamId = conversationSettingsStreamId(conversationId, section);
    this.deps.webview.subscribe(clientId, streamId);
    const stored = await this.readSettings(conversationId, section);
    await this.deps.afterRead?.(stored);
    this.deps.webview.post(clientId, this.createSnapshotMessage(stored, correlationId));
  }

  public async update(payload: ConversationSettingsUpdatePayload | undefined, correlationId?: string): Promise<void> {
    if (!payload) return;
    const settings = normalizeConversationSettings(payload.section, payload.settings);
    const stored = payload.section === 'common'
      ? await this.renameCommonSettings(settings as ConversationSettingsRecord)
      : await this.deps.storage.saveConversationSettings(payload.section, settings);
    this.deps.webview.broadcastToStream(conversationSettingsStreamId(stored.conversationId, stored.section), this.createSnapshotMessage(stored, correlationId));
    this.deps.requestSnapshot();
    this.deps.requestSnapshot(stored.conversationId);
    await this.deps.afterUpdate?.(stored);
  }

  private async readSettings(conversationId: string, section: ConversationSettingsSection): Promise<{ conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }> {
    if (section === 'common') {
      const entity = this.findConversation(conversationId);
      const conversation = entity === undefined ? undefined : this.deps.world.get(entity, Conversation);
      if (!conversation) throw new Error(`Conversation settings require committed authority: ${conversationId}`);
      return {
        conversationId,
        section,
        settings: normalizeConversationCommonSettings(conversationId, {
          conversationId,
          name: displayConversationTitle({ id: conversationId, title: conversation.title })
        }),
        filePath: ''
      };
    }

    const stored = await this.deps.storage.loadConversationSettings(conversationId, section);
    const settings = stored?.settings as ConversationLlmSettingsRecord | undefined;
    return {
      conversationId,
      section,
      settings: normalizeConversationLlmSettings(conversationId, settings),
      filePath: stored?.filePath ?? ''
    };
  }

  private createSnapshotMessage(stored: { conversationId: string; section: ConversationSettingsSection; settings: ConversationSettingsSectionValue; filePath: string }, correlationId?: string): ExtensionToWebviewMessage {
    return {
      id: createMessageId(),
      type: BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: stored.conversationId },
      correlationId,
      payload: { conversationId: stored.conversationId, section: stored.section, settings: stored.settings, filePath: stored.filePath }
    };
  }

  private async renameCommonSettings(settings: ConversationSettingsRecord): Promise<StoredConversationSettings> {
    const committed = await this.deps.renameConversation(settings.conversationId, settings.name);
    if (!committed) throw new Error(`Conversation rename was rejected: ${settings.conversationId}`);
    return {
      conversationId: settings.conversationId,
      section: 'common',
      settings,
      filePath: ''
    };
  }

  private findConversation(conversationId: string): number | undefined {
    return this.deps.world.entityByRecordId(Conversation, conversationId);
  }
}

function normalizeConversationSettings(section: ConversationSettingsSection, settings: ConversationSettingsSectionValue): ConversationSettingsSectionValue {
  return section === 'llm'
    ? normalizeConversationLlmSettings((settings as ConversationLlmSettingsRecord).conversationId, settings as ConversationLlmSettingsRecord)
    : normalizeConversationCommonSettings((settings as ConversationSettingsRecord).conversationId, settings as ConversationSettingsRecord);
}

function normalizeConversationCommonSettings(conversationId: string, settings: Partial<ConversationSettingsRecord> | undefined): ConversationSettingsRecord {
  const name = settings?.name?.trim() || DEFAULT_CONVERSATION_TITLE;
  return { conversationId, name };
}

function normalizeConversationLlmSettings(conversationId: string, settings: Partial<ConversationLlmSettingsRecord> | undefined): ConversationLlmSettingsRecord {
  const modelOverrides = normalizeModelOverrides(settings?.modelOverrides);
  return {
    conversationId,
    activeProviderConfigId: settings?.activeProviderConfigId?.trim() ?? '',
    ...(modelOverrides ? { modelOverrides } : {})
  };
}

function normalizeModelOverrides(value: ConversationLlmSettingsRecord['modelOverrides'] | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [rawConfigId, rawModelId] of Object.entries(value)) {
    const configId = rawConfigId.trim();
    const modelId = rawModelId.trim();
    if (configId && modelId) result[configId] = modelId;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

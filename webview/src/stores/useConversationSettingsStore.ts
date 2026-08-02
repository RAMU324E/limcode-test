import { defineStore } from 'pinia';
import type {
  ConversationSettingsRecord,
  ConversationSettingsSnapshotPayload
} from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';

interface ConversationSettingsState {
  common: ConversationSettingsRecord;
  status: string;
}

function emptyCommon(conversationId = ''): ConversationSettingsRecord {
  return { conversationId, name: '' };
}

/** 对话级 common 设置；模型选择只有 ModelProfile 一个 authority。 */
export const useConversationSettingsStore = defineStore('conversationSettings', {
  state: (): ConversationSettingsState => ({
    common: emptyCommon(),
    status: ''
  }),
  actions: {
    request(conversationId: string): void {
      if (!conversationId) return;
      // 进入对话时先占位 conversationId，避免快照未到时保存按钮不可用。
      if (this.common.conversationId !== conversationId) this.common = emptyCommon(conversationId);
      this.status = '正在读取对话设置...';
      bridge.request(BridgeMessageType.ConversationSettingsGet, { conversationId, section: 'common' });
    },
    save(): void {
      if (!this.common.conversationId) return;
      this.status = '正在保存对话设置...';
      bridge.request(BridgeMessageType.ConversationSettingsUpdate, {
        section: 'common',
        settings: { conversationId: this.common.conversationId, name: this.common.name }
      });
    },
    applySnapshot(payload: ConversationSettingsSnapshotPayload): void {
      if (payload.section === 'common') {
        this.common = payload.settings as ConversationSettingsRecord;
      }
      this.status = '对话设置已同步';
    }
  }
});

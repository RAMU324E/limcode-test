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
      // 进入对话时先占位 conversationId，避免快照未到时保存按钮不可用。
      if (this.common.conversationId !== conversationId) this.common = emptyCommon(conversationId);
      if (!conversationId) {
        this.status = '';
        return;
      }
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
      const conversationId = this.common.conversationId;
      const settings = payload.settings as ConversationSettingsRecord;
      // 导航决定作用域；快照自身的两处会话身份必须一致，不能用错位正文覆盖当前表单。
      if (!conversationId || payload.conversationId !== conversationId
        || settings?.conversationId !== conversationId || payload.section !== 'common') return;
      this.common = { conversationId, name: settings.name };
      this.status = '对话设置已同步';
    },
    applyError(error: { message: string; conversationId?: string }): void {
      // 迟到错误只影响仍绑定该会话的视图。
      if (!this.common.conversationId || error.conversationId !== this.common.conversationId) return;
      this.status = error.message;
    }
  }
});

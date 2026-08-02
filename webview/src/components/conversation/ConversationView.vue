<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isVisibleTextPart, type MessageContent } from '@shared/protocol';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useBottomStickyScroller } from '@webview/composables/useBottomStickyScroller';
import ReliableMessageList from './ReliableMessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const conversationUi = useConversationUiStore();
const reliableConversation = useReliableConversation();
const { sendMessage, editMessage } = useChat();
const currentConversationId = reliableConversation.conversationId;
const currentDisplayMessages = computed(() => reliableConversation.projection.value.messages);

const scroller = ref<HTMLElement | null>(null);
const conversationBody = ref<HTMLElement | null>(null);
const bottomStickyScroller = useBottomStickyScroller(scroller);
let pendingInitialBottomConversationId = '';
let initialBottomScrollFrame: number | undefined;

const loadingDetail = computed(() =>
  Boolean(reliableConversation.feed.sessionId)
  && Boolean(currentConversationId.value)
  && currentDisplayMessages.value.length === 0
  && reliableConversation.projection.value.loadingMessageRevisionIds.length > 0
);
const ready = computed(() => Boolean(reliableConversation.feed.sessionId && currentConversationId.value) && !loadingDetail.value);
const placeholder = computed(() =>
  ready.value
    ? '输入消息，Enter 发送，Shift+Enter 换行'
    : loadingDetail.value ? '对话内容加载中...' : '可靠 Runtime 初始化中...'
);
const emptyHint = computed(() =>
  ready.value ? '还没有消息，发一条试试。' : loadingDetail.value ? '正在加载对话内容，请稍候。' : '可靠 Runtime 初始化中，请稍候。'
);
const editFollowupCount = computed(() => Math.max(0, (conversationUi.editingMessage?.deleteCount ?? 1) - 1));
const editConfirmDescriptionHtml = computed(
  () => `是否编辑此消息？将同时删除后续 ${editFollowupCount.value} 条消息，此操作<strong>不可撤销</strong>`
);
const editConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'direct-confirm', label: '确认编辑' }
];
const scrollMarkers = computed(() =>
  currentDisplayMessages.value
    .filter((message) => message.role === 'user')
    .map((message, index) => {
      const editing = conversationUi.editingMessage?.message.id === message.id;
      const text = message.content.parts
        .filter(isVisibleTextPart)
        .map((part) => part.text)
        .join('')
        .trim()
        .replace(/\s+/g, ' ');
      return {
        id: message.id,
        label: `用户消息 · ${index + 1}`,
        preview: text ? truncatePreview(text) : '',
        kind: editing ? 'user editing' : 'user'
      };
    })
);

watch(
  currentConversationId,
  (conversationId) => {
    pendingInitialBottomConversationId = conversationId;
    bottomStickyScroller.scrollToBottomNow();
    scheduleInitialConversationBottomScroll();
  },
  { immediate: true, flush: 'post' }
);

watch(
  () => `${currentConversationId.value}:${currentDisplayMessages.value.length}:${reliableConversation.feed.lastCommitSeq ?? ''}:${Object.keys(reliableConversation.feed.transientModelRequests).length}`,
  () => scheduleInitialConversationBottomScroll(),
  { flush: 'post' }
);

onBeforeUnmount(() => cancelInitialBottomScrollFrame());

function scheduleInitialConversationBottomScroll(): void {
  const conversationId = currentConversationId.value;
  if (!conversationId || pendingInitialBottomConversationId !== conversationId) return;
  if (currentDisplayMessages.value.length === 0 && loadingDetail.value) return;
  void nextTick(() => {
    if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;
    bottomStickyScroller.scrollToBottomNow();
    cancelInitialBottomScrollFrame();
    initialBottomScrollFrame = window.requestAnimationFrame(() => {
      initialBottomScrollFrame = undefined;
      if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;
      bottomStickyScroller.scrollToBottomNow();
      pendingInitialBottomConversationId = '';
    });
  });
}

function cancelInitialBottomScrollFrame(): void {
  if (initialBottomScrollFrame === undefined) return;
  window.cancelAnimationFrame(initialBottomScrollFrame);
  initialBottomScrollFrame = undefined;
}

function onSubmit(text: string, content?: MessageContent): void {
  if (conversationUi.isEditing) {
    conversationUi.pendingEditText = text;
    conversationUi.editConfirmOpen = true;
    return;
  }
  sendMessage(text, content);
}

function handleEditConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') {
    conversationUi.editConfirmOpen = false;
    return;
  }
  if (action.key === 'direct-confirm') commitEditMessage();
}

function commitEditMessage(): void {
  const editing = conversationUi.editingMessage;
  const text = conversationUi.pendingEditText.trim();
  if (!editing || !text) return;
  conversationUi.editConfirmOpen = false;
  const commit = (): void => {
    editMessage(editing.message.conversationId, editing.message.id, text, { runAfterEdit: true, deleteFollowing: true });
    conversationUi.cancelEditMode();
  };
  const nextMessage = nextMessageAfter(editing.message.id);
  if (nextMessage) {
    conversationUi.playExitFrom(nextMessage.id, commit);
    return;
  }
  commit();
}

function nextMessageAfter(messageId: string) {
  const index = currentDisplayMessages.value.findIndex((message) => message.id === messageId);
  return index >= 0 ? currentDisplayMessages.value[index + 1] : undefined;
}

function startReliableMessageEdit(message: (typeof currentDisplayMessages.value)[number], deleteCount: number): void {
  conversationUi.startEditMessage(message, deleteCount);
}

function truncatePreview(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}
</script>

<template>
  <div class="conversation">
    <div ref="conversationBody" class="conversation-body">
      <div ref="scroller" class="conversation-scroll">
        <ReliableMessageList
          :empty-hint="emptyHint"
          :scroller="scroller"
          @edit-message="startReliableMessageEdit"
        />
      </div>
      <AdvancedScrollbar
        class="conversation-main-scrollbar"
        :scroller="scroller"
        :markers="scrollMarkers"
        show-markers
        show-edge-buttons
        show-marker-preview
      />
    </div>
    <footer class="conversation-composer">
      <Composer :disabled="!ready" :placeholder="placeholder" :expand-boundary="conversationBody" @submit="onSubmit" />
    </footer>
    <ConfirmPanel
      :open="conversationUi.editConfirmOpen"
      title="编辑消息"
      :description-html="editConfirmDescriptionHtml"
      :actions="editConfirmActions"
      @action="handleEditConfirmAction"
      @cancel="conversationUi.editConfirmOpen = false"
    />
  </div>
</template>

<style scoped>
.conversation {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  --conversation-timeline-marker-width: 24px;
  --conversation-content-padding-left: var(--conversation-timeline-marker-width);
  --conversation-content-padding-right: var(--conversation-timeline-marker-width);
}

.conversation-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.conversation-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 0;
  scrollbar-width: none;
  overflow-anchor: none;
}

.conversation-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.conversation :deep(.advanced-scrollbar.conversation-main-scrollbar) {
  right: 0;
}

.conversation-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--vscode-panel-border);
  padding: 0;
  background-color: var(--vscode-editor-background);
}
</style>

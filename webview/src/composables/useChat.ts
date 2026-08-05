import { bridge, BridgeMessageType } from '@webview/transport';
import { computed, ref, watchEffect } from 'vue';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useAgentStore } from '@webview/stores/useAgentStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { interruptTargetHasSettled } from '@webview/domain/reliableInterruptLifecycle';
import { toStructuredClonePlainData } from '@shared/plainData';
import {
  type CompressionCommandTarget,
  type CompressionStartPayload,
  type ConversationCommandMetadata,
  type ConversationForkPayload,
  type MessageContent,
  type MessageDeleteFromPayload,
  type MessageEditPayload,
  type MessageRetryFromPayload,
  type MessageRetryTarget,
  type TurnAuthoritySelection,
  type TurnInputResultPayload
} from '@shared/protocol';

let reliableCommandSequence = 0;
const reliableCommandSessionId = globalThis.crypto.randomUUID();
const PERSISTED_CONTROL_KEY = 'reliableConversationControls';

type InterruptPhase = 'requesting' | 'stopping';
interface InterruptState {
  conversationId: string;
  turnId: string;
  phase: InterruptPhase;
  command: ConversationCommandMetadata;
  cascadeChildAgents: boolean;
  requestId?: string;
  sentSessionId?: string;
}

type ConversationActionKind = 'edit' | 'retry' | 'delete' | 'compress';
type ConversationActionPhase = 'waiting_for_idle' | 'requesting_stop' | 'stopping' | 'submitting' | 'running';
type ConversationActionPayload =
  | { type: BridgeMessageType.MessageEdit; payload: MessageEditPayload }
  | { type: BridgeMessageType.MessageRetryFrom; payload: MessageRetryFromPayload }
  | { type: BridgeMessageType.MessageDeleteFrom; payload: MessageDeleteFromPayload }
  | { type: BridgeMessageType.CompressionStart; payload: CompressionStartPayload };

interface ConversationActionInterrupt {
  turnId: string;
  phase: InterruptPhase;
  command: ConversationCommandMetadata;
  requestId?: string;
  sentSessionId?: string;
}

interface ConversationActionState {
  actionId: string;
  conversationId: string;
  action: ConversationActionKind;
  targetId: string;
  label: string;
  phase: ConversationActionPhase;
  commandPayload: ConversationActionPayload;
  interrupt?: ConversationActionInterrupt;
  requestId?: string;
  sentSessionId?: string;
  submittedAtCommitSeq?: string;
  blockedAtCommitSeq?: string;
  operationTurnId?: string;
}

interface ForkRequestState {
  actionId: string;
  sourceConversationId: string;
  messageId: string;
  payload: ConversationForkPayload;
  requestId?: string;
  sentSessionId?: string;
}

export interface PendingTurnInputSubmission {
  commandId: string;
  requestId: string;
  conversationId: string;
  requestType: BridgeMessageType.TurnStart | BridgeMessageType.TurnEnqueue;
  text: string;
  content?: MessageContent;
  authority: TurnAuthoritySelection;
  submittedAt: number;
  result?: TurnInputResultPayload;
}

export interface FailedTurnInputSubmission extends PendingTurnInputSubmission {
  failedAt: number;
  message: string;
}

interface PersistedConversationControls {
  interrupt?: InterruptState;
  conversationActions: Record<string, ConversationActionState>;
  forkRequests: Record<string, ForkRequestState>;
}

const restored = readPersistedControls();
const interruptState = ref<InterruptState | undefined>(restored.interrupt);
const conversationActionStates = ref<Record<string, ConversationActionState>>(restored.conversationActions);
const forkRequests = ref<Record<string, ForkRequestState>>(restored.forkRequests);
const actionNotices = ref<Record<string, string>>({});
const pendingTurnInputSubmissions = ref<Record<string, PendingTurnInputSubmission>>({});
const failedTurnInputSubmissions = ref<Record<string, FailedTurnInputSubmission>>({});
const turnInputAcknowledgements = ref<Record<string, TurnInputResultPayload>>({});

bridge.on(BridgeMessageType.TurnInputResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const pending = pendingTurnInputSubmissions.value[payload.commandId];
  if (
    !pending
    || pending.requestId !== message.correlationId
    || pending.conversationId !== payload.conversationId
    || pending.requestType !== payload.requestType
  ) return;
  if (payload.status === 'rejected') {
    failTurnInputSubmission(pending, payload.message || '消息未能可靠入队，请重试。');
    return;
  }
  turnInputAcknowledgements.value = {
    ...turnInputAcknowledgements.value,
    [payload.commandId]: payload
  };
  pendingTurnInputSubmissions.value = {
    ...pendingTurnInputSubmissions.value,
    [payload.commandId]: { ...pending, result: payload }
  };
  clearTurnInputFailure(payload.commandId);
});

bridge.on(BridgeMessageType.TurnInterruptResult, (message) => {
  const payload = message.payload;
  if (!payload) return;

  const pending = interruptState.value;
  if (
    pending?.requestId
    && message.correlationId === pending.requestId
    && payload.turnId === pending.turnId
    && payload.conversationId === pending.conversationId
  ) {
    if (payload.status === 'already_terminal') setInterruptState(undefined);
    else setInterruptState({ ...pending, phase: 'stopping', requestId: undefined });
  }

  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action?.interrupt?.requestId
    || action.interrupt.requestId !== message.correlationId
    || action.interrupt.turnId !== payload.turnId
  ) return;
  if (payload.status === 'already_terminal') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      interrupt: undefined,
      blockedAtCommitSeq: undefined
    });
    return;
  }
  setConversationAction({
    ...action,
    phase: 'stopping',
    interrupt: { ...action.interrupt, phase: 'stopping', requestId: undefined }
  });
});

bridge.on(BridgeMessageType.ConversationActionResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action
    || action.actionId !== payload.commandId
    || action.action !== payload.action
    || action.targetId !== retryTargetId(payload.target)
  ) return;
  if (payload.status === 'busy') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      requestId: undefined,
      interrupt: undefined,
      blockedAtCommitSeq: action.submittedAtCommitSeq
    });
    setActionNotice(payload.conversationId, '检测到排队中的回合；将在其精确停止后继续当前操作。');
    return;
  }
  if (action.action === 'retry' && payload.turnId) {
    setConversationAction({
      ...action,
      phase: 'running',
      requestId: undefined,
      interrupt: undefined,
      operationTurnId: payload.turnId
    });
    clearActionNotice(payload.conversationId);
    return;
  }
  clearConversationAction(payload.conversationId);
  clearActionNotice(payload.conversationId);
});

bridge.on(BridgeMessageType.CompressionCommandResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const action = conversationActionStates.value[payload.conversationId];
  if (
    !action
    || action.action !== 'compress'
    || action.actionId !== payload.commandId
    || !sameCompressionTarget(actionCompressionTarget(action), payload.target)
  ) return;
  if (payload.status === 'busy') {
    setConversationAction({
      ...action,
      phase: 'waiting_for_idle',
      requestId: undefined,
      interrupt: undefined,
      blockedAtCommitSeq: action.submittedAtCommitSeq
    });
    setActionNotice(payload.conversationId, '检测到排队中的回合；将在其精确停止后继续总结。');
    return;
  }
  if (payload.status === 'in_progress') {
    setConversationAction({
      ...action,
      phase: 'submitting',
      requestId: undefined,
      operationTurnId: payload.turnId
    });
    return;
  }
  clearConversationAction(payload.conversationId);
  if (payload.status === 'rejected') {
    setActionNotice(payload.conversationId, compressionFailureLabel(payload.reasonCode));
  } else {
    clearActionNotice(payload.conversationId);
  }
});

bridge.on(BridgeMessageType.ConversationForkResult, (message) => {
  const payload = message.payload;
  if (!payload) return;
  const request = forkRequests.value[payload.commandId];
  if (
    !request
    || request.sourceConversationId !== payload.sourceConversationId
    || request.messageId !== payload.messageId
    || request.payload.expectedRevisionId !== payload.expectedRevisionId
  ) return;
  // Navigation is a separate shell command. Sending it only after the exact durable fork result
  // makes accepted and replayed forks equally visible without guessing a target Conversation id.
  bridge.request(BridgeMessageType.ConversationOpen, { conversationId: payload.conversationId });
  clearForkRequest(payload.commandId);
});

bridge.on(BridgeMessageType.Error, (message) => {
  const requestType = message.payload?.requestType;
  if (requestType === BridgeMessageType.TurnStart || requestType === BridgeMessageType.TurnEnqueue) {
    const pending = Object.values(pendingTurnInputSubmissions.value).find((candidate) =>
      candidate.requestId === message.correlationId && candidate.requestType === requestType
    );
    if (pending) failTurnInputSubmission(
      pending,
      message.payload?.message || '消息提交失败，草稿已恢复。'
    );
    return;
  }
  if (requestType === BridgeMessageType.TurnInterrupt) {
    const pending = interruptState.value;
    if (pending?.requestId && pending.requestId === message.correlationId) setInterruptState(undefined);
    const action = Object.values(conversationActionStates.value).find((candidate) =>
      candidate.interrupt?.requestId === message.correlationId
    );
    if (action) {
      setConversationAction({
        ...action,
        phase: 'requesting_stop',
        interrupt: {
          ...action.interrupt!,
          phase: 'requesting',
          requestId: undefined
        }
      });
      setActionNotice(
        action.conversationId,
        message.payload?.message
          ? `${message.payload.message}（可再次点击停止重放同一请求。）`
          : '停止请求失败；可再次点击停止重放同一请求。'
      );
    }
    return;
  }

  if (isConversationActionRequestType(requestType)) {
    const action = Object.values(conversationActionStates.value).find((candidate) =>
      candidate.requestId === message.correlationId
    );
    if (!action) return;
    clearConversationAction(action.conversationId);
    setActionNotice(action.conversationId, message.payload?.message || '操作失败，请刷新后重试。');
    return;
  }

  if (requestType === BridgeMessageType.ConversationFork) {
    const request = Object.values(forkRequests.value).find((candidate) =>
      candidate.requestId === message.correlationId
    );
    if (!request) return;
    // The fork transaction may have committed before a later history refresh failed. Retain the
    // exact command so the next click (or reload) replays it instead of creating a second branch.
    setForkRequest({ ...request, requestId: undefined });
    setActionNotice(
      request.sourceConversationId,
      message.payload?.message
        ? `${message.payload.message}（再次点击将重放同一分支命令。）`
        : '分支提交结果未确认；再次点击将重放同一命令。'
    );
  }
});

function failTurnInputSubmission(pending: PendingTurnInputSubmission, message: string): void {
  const nextPending = { ...pendingTurnInputSubmissions.value };
  delete nextPending[pending.commandId];
  pendingTurnInputSubmissions.value = nextPending;
  const nextAcknowledgements = { ...turnInputAcknowledgements.value };
  delete nextAcknowledgements[pending.commandId];
  turnInputAcknowledgements.value = nextAcknowledgements;
  failedTurnInputSubmissions.value = {
    ...failedTurnInputSubmissions.value,
    [pending.commandId]: {
      ...pending,
      failedAt: Date.now(),
      message
    }
  };
  setActionNotice(pending.conversationId, message);
}

function clearTurnInputFailuresForConversation(conversationId: string): void {
  const next = Object.fromEntries(Object.entries(failedTurnInputSubmissions.value)
    .filter(([, failure]) => failure.conversationId !== conversationId));
  if (Object.keys(next).length !== Object.keys(failedTurnInputSubmissions.value).length) {
    failedTurnInputSubmissions.value = next;
  }
}

function clearTurnInputFailure(commandId: string): void {
  if (!failedTurnInputSubmissions.value[commandId]) return;
  const next = { ...failedTurnInputSubmissions.value };
  delete next[commandId];
  failedTurnInputSubmissions.value = next;
}

function reconcileTurnInputSubmissions(records: Record<string, Record<string, Record<string, unknown>>>): void {
  let changed = false;
  const next = { ...pendingTurnInputSubmissions.value };
  for (const pending of Object.values(next)) {
    const result = pending.result;
    if (!result) continue;
    const observed = result.admitted
      ? Boolean(result.turnId && records.Turn?.[result.turnId])
      : Boolean(result.intentId && records.TurnIntent?.[result.intentId]);
    if (!observed) continue;
    delete next[pending.commandId];
    changed = true;
  }
  if (changed) pendingTurnInputSubmissions.value = next;
}

function setInterruptState(next: InterruptState | undefined): void {
  interruptState.value = next;
  persistControls();
}

function setConversationAction(action: ConversationActionState): void {
  conversationActionStates.value = {
    ...conversationActionStates.value,
    [action.conversationId]: action
  };
  persistControls();
}

function clearConversationAction(conversationId: string): void {
  if (!conversationActionStates.value[conversationId]) return;
  const next = { ...conversationActionStates.value };
  delete next[conversationId];
  conversationActionStates.value = next;
  persistControls();
}

function setForkRequest(request: ForkRequestState): void {
  forkRequests.value = { ...forkRequests.value, [request.actionId]: request };
  persistControls();
}

function clearForkRequest(actionId: string): void {
  if (!forkRequests.value[actionId]) return;
  const next = { ...forkRequests.value };
  delete next[actionId];
  forkRequests.value = next;
  persistControls();
}

function setActionNotice(conversationId: string, notice: string): void {
  actionNotices.value = { ...actionNotices.value, [conversationId]: notice };
}

function clearActionNotice(conversationId: string): void {
  if (!actionNotices.value[conversationId]) return;
  const next = { ...actionNotices.value };
  delete next[conversationId];
  actionNotices.value = next;
}

function nextReliableCommandMetadata(): ConversationCommandMetadata {
  reliableCommandSequence += 1;
  const issuedAt = Date.now();
  return {
    commandId: `reliable-command-${reliableCommandSessionId}-${reliableCommandSequence.toString(36)}`,
    expectedVersion: 0,
    issuedAt
  };
}

/** Conversation commands are admitted only through the reliable Turn/Message control planes. */
export function useChat() {
  const reliableConversation = useReliableConversation();
  const clientState = useClientStateStore();
  const globalSettings = useGlobalSettingsStore();
  const agentStore = useAgentStore();
  const modelProfileStore = useModelProfileStore();
  const currentConversationAction = computed(() =>
    conversationActionStates.value[reliableConversation.conversationId.value]
  );
  const currentStandaloneInterrupt = computed(() => {
    const pending = interruptState.value;
    const conversationId = reliableConversation.conversationId.value;
    return pending?.conversationId === conversationId && activeTurnId(conversationId) === pending.turnId
      ? pending
      : undefined;
  });
  const currentActionInterrupt = computed(() => currentConversationAction.value?.interrupt);
  const currentInterruptPhase = computed<InterruptPhase | undefined>(() =>
    currentActionInterrupt.value?.phase ?? currentStandaloneInterrupt.value?.phase
  );
  const interruptPending = computed(() => currentInterruptPhase.value === 'stopping');
  const conversationActionPending = computed(() => Boolean(currentConversationAction.value));
  const conversationActionLabel = computed(() => currentConversationAction.value?.label);
  const compressionPending = computed(() => currentConversationAction.value?.action === 'compress');
  const conversationActionNotice = computed(() => actionNotices.value[reliableConversation.conversationId.value]);
  const currentPendingTurnInputs = computed(() => Object.values(pendingTurnInputSubmissions.value)
    .filter((submission) => submission.conversationId === reliableConversation.conversationId.value)
    .sort((left, right) => left.submittedAt - right.submittedAt || left.commandId.localeCompare(right.commandId)));
  const currentTurnInputAcknowledgements = computed(() => Object.fromEntries(
    Object.entries(turnInputAcknowledgements.value).filter(([, result]) =>
      result.conversationId === reliableConversation.conversationId.value
    )
  ));
  const currentTurnInputFailure = computed(() => Object.values(failedTurnInputSubmissions.value)
    .filter((submission) => submission.conversationId === reliableConversation.conversationId.value)
    .sort((left, right) => right.failedAt - left.failedAt || right.commandId.localeCompare(left.commandId))[0]);
  const forkPendingTargetIds = computed(() => new Set(Object.values(forkRequests.value)
    .filter((request) => request.sourceConversationId === reliableConversation.conversationId.value && request.requestId)
    .map((request) => request.messageId)));

  watchEffect(() => {
    const sessionId = reliableConversation.feed.sessionId;
    if (!sessionId) return;
    reconcileStandaloneInterrupt();
    reconcileConversationAction();
    reconcileTurnInputSubmissions(
      reliableConversation.feed.records as unknown as Record<string, Record<string, Record<string, unknown>>>
    );
    replayForkRequestsForSession(sessionId);
  });

  function activeConversationId(): string {
    return reliableConversation.conversationId.value;
  }

  function activeTurnId(conversationId: string): string | undefined {
    const turn = Object.values(reliableConversation.feed.records.Turn ?? {}).find((candidate) =>
      candidate.conversation_id === conversationId && candidate.status === 'active'
    );
    return typeof turn?.id === 'string' ? turn.id : undefined;
  }

  function activeLeaseGeneration(turnId: string): number | undefined {
    const lease = Object.values(reliableConversation.feed.records.ExecutionLease ?? {}).find((candidate) =>
      candidate.turn_id === turnId
    );
    const raw = lease?.generation;
    const generation = typeof raw === 'string' && /^\d+$/.test(raw)
      ? Number(raw)
      : typeof raw === 'number' ? raw : Number.NaN;
    return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
  }

  function sendMessage(
    text: string,
    content?: MessageContent,
    authority: TurnAuthoritySelection = {}
  ): PendingTurnInputSubmission | undefined {
    const conversationId = activeConversationId();
    const trimmed = text.trim();
    if ((!trimmed && !content?.parts?.length) || !conversationId) return undefined;
    clearTurnInputFailuresForConversation(conversationId);
    clearActionNotice(conversationId);
    const command = nextReliableCommandMetadata();
    const requestType = activeTurnId(conversationId)
      ? BridgeMessageType.TurnEnqueue
      : BridgeMessageType.TurnStart;
    const frozenContent = content ? structuredClone(content) : undefined;
    const frozenAuthority = structuredClone(authority);
    const payload = {
      conversationId,
      text: trimmed,
      ...(frozenContent?.parts?.length ? { content: frozenContent } : {}),
      ...(frozenAuthority.agentId?.trim() ? { agentId: frozenAuthority.agentId.trim() } : {}),
      ...(frozenAuthority.model ? { model: { ...frozenAuthority.model } } : {}),
      command
    };
    const requestId = command.commandId;
    const submission: PendingTurnInputSubmission = {
      commandId: command.commandId,
      requestId,
      conversationId,
      requestType,
      text: trimmed,
      ...(frozenContent ? { content: frozenContent } : {}),
      authority: frozenAuthority,
      submittedAt: Date.now()
    };
    // Register the optimistic/restore authority before posting. A synchronous test bridge or a
    // future in-process transport must not be able to return the ACK before correlation exists.
    pendingTurnInputSubmissions.value = {
      ...pendingTurnInputSubmissions.value,
      [submission.commandId]: submission
    };
    try {
      bridge.request(requestType, payload, { requestId });
    } catch (error) {
      failTurnInputSubmission(
        submission,
        error instanceof Error ? error.message : '消息提交失败，草稿已保留。'
      );
    }
    return submission;
  }

  function editMessage(
    conversationId: string,
    messageId: string,
    text: string,
    options: { expectedRevisionId: string; runAfterEdit?: boolean; deleteFollowing?: boolean } & TurnAuthoritySelection
  ): boolean {
    const trimmed = text.trim();
    const expectedRevisionId = options.expectedRevisionId.trim();
    if (!conversationId || !messageId || !trimmed || !expectedRevisionId) return false;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'edit',
      targetId: messageId,
      label: '正在停止后编辑',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.MessageEdit,
        payload: {
          conversationId,
          messageId,
          expectedRevisionId,
          text: trimmed,
          ...(options.runAfterEdit ? { runAfterEdit: true } : {}),
          ...(options.deleteFollowing ? { deleteFollowing: true } : {}),
          ...(options.agentId?.trim() ? { agentId: options.agentId.trim() } : {}),
          ...(options.model ? { model: { ...options.model } } : {}),
          command
        }
      }
    });
  }

  function retryMessageFrom(
    conversationId: string,
    target: MessageRetryTarget,
    authority: TurnAuthoritySelection = currentAuthoritySelection(),
    expectedRevisionId?: string,
    displayNumber?: number
  ): boolean {
    const targetId = retryTargetId(target);
    const revisionId = expectedRevisionId?.trim();
    if (!conversationId || !targetId || (target.kind === 'message' && !revisionId)) return false;
    const command = nextReliableCommandMetadata();
    const common = {
      conversationId,
      ...(authority.agentId?.trim() ? { agentId: authority.agentId.trim() } : {}),
      ...(authority.model ? { model: { ...authority.model } } : {}),
      command
    };
    const payload: MessageRetryFromPayload = target.kind === 'message'
      ? { ...common, target: { kind: 'message', messageId: targetId }, expectedRevisionId: revisionId! }
      : { ...common, target: { kind: 'model_request', modelRequestId: targetId } };
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'retry',
      targetId,
      label: Number.isSafeInteger(displayNumber) && displayNumber! > 0
        ? `正在从 #${displayNumber} 创建重试回合`
        : '正在创建新的重试回合',
      phase: 'waiting_for_idle',
      commandPayload: { type: BridgeMessageType.MessageRetryFrom, payload }
    });
  }

  function currentAuthoritySelection(): TurnAuthoritySelection {
    const conversationId = clientState.currentConversationId;
    const agentId = agentStore.activeAgentForConversation(conversationId)?.id.trim() ?? '';
    const profile = conversationId
      ? modelProfileStore.localProfileFor('conversation', conversationId).profile
      : undefined;
    const providerConfigId = profile?.providerConfigId?.trim()
      || globalSettings.llm.activeProviderConfigId
      || globalSettings.activeLlmProviderConfig?.id
      || '';
    const config = globalSettings.llmProviderConfigs.configs.find((candidate) => candidate.id === providerConfigId);
    const profileModel = profile?.providerConfigId?.trim() === config?.id ? profile?.model.trim() ?? '' : '';
    const model = profileModel && config && modelExists(config, profileModel)
      ? profileModel
      : config?.model.trim() ?? '';
    return {
      ...(agentId ? { agentId } : {}),
      ...(config && model
        ? { model: { providerConfigId: config.id, provider: config.provider, model } }
        : {})
    };
  }

  function deleteMessagesFrom(conversationId: string, messageId: string): boolean {
    if (!conversationId || !messageId) return false;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'delete',
      targetId: messageId,
      label: '正在停止后删除',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.MessageDeleteFrom,
        payload: { conversationId, messageId, command }
      }
    });
  }

  function forkConversationFrom(
    sourceConversationId: string,
    messageId: string,
    expectedRevisionId: string
  ): boolean {
    const revisionId = expectedRevisionId.trim();
    if (!sourceConversationId || !messageId || !revisionId) return false;
    const existing = Object.values(forkRequests.value).find((request) =>
      request.sourceConversationId === sourceConversationId && request.messageId === messageId
    );
    if (existing) {
      if (existing.payload.expectedRevisionId !== revisionId) {
        setActionNotice(sourceConversationId, '该消息已有另一 Revision 的分支请求正在提交。');
        return false;
      }
      clearActionNotice(sourceConversationId);
      sendForkRequest(existing);
      return true;
    }
    const command = nextReliableCommandMetadata();
    const request: ForkRequestState = {
      actionId: command.commandId,
      sourceConversationId,
      messageId,
      payload: { sourceConversationId, messageId, expectedRevisionId: revisionId, command }
    };
    setForkRequest(request);
    clearActionNotice(sourceConversationId);
    sendForkRequest(request);
    return true;
  }

  function compressContext(
    conversationId: string,
    target: { kind: 'current_head' } | { kind: 'through_message'; messageId: string }
  ): boolean {
    const frozenTarget = freezeCompressionTarget(conversationId, target);
    if (!conversationId || !frozenTarget) return false;
    const targetId = frozenTarget.kind === 'through_message' ? frozenTarget.messageId : frozenTarget.expectedRootId;
    const command = nextReliableCommandMetadata();
    return requestConversationAction({
      actionId: command.commandId,
      conversationId,
      action: 'compress',
      targetId,
      label: '正在停止后总结',
      phase: 'waiting_for_idle',
      commandPayload: {
        type: BridgeMessageType.CompressionStart,
        payload: { conversationId, target: frozenTarget, command }
      }
    });
  }

  function freezeCompressionTarget(
    conversationId: string,
    target: { kind: 'current_head' } | { kind: 'through_message'; messageId: string }
  ): CompressionCommandTarget | undefined {
    if (target.kind === 'through_message') {
      const messageId = target.messageId.trim();
      const expectedRevisionId = reliableConversation.projection.value.messageRevisionIdByMessageId[messageId]?.trim();
      return messageId && expectedRevisionId
        ? { kind: 'through_message', messageId, expectedRevisionId }
        : undefined;
    }
    const status = Object.values(reliableConversation.feed.records.ConversationContextStatus ?? {})
      .find((candidate) => candidate.conversation_id === conversationId);
    const expectedRootId = typeof status?.root_id === 'string' ? status.root_id.trim() : '';
    return expectedRootId ? { kind: 'current_head', expectedRootId } : undefined;
  }

  function requestConversationAction(next: ConversationActionState): boolean {
    const existing = conversationActionStates.value[next.conversationId];
    if (existing) {
      if (!sameConversationActionSemantics(existing, next)) {
        setActionNotice(
          next.conversationId,
          `“${existing.label.replace(/^正在/, '')}”仍在处理中；原操作完成前不会丢弃或替换它。`
        );
        return false;
      }
      clearActionNotice(next.conversationId);
      reconcileConversationAction(true);
      return true;
    }
    setConversationAction(next);
    clearActionNotice(next.conversationId);
    reconcileConversationAction(true);
    return true;
  }

  function reconcileConversationAction(force = false): void {
    const conversationId = reliableConversation.conversationId.value;
    let action = conversationActionStates.value[conversationId];
    if (!action) return;

    if (action.phase === 'running') {
      if (
        action.operationTurnId
        && interruptTargetHasSettled(reliableConversation.feed.records, action.operationTurnId)
      ) {
        clearConversationAction(conversationId);
        clearActionNotice(conversationId);
      }
      return;
    }

    if (action.phase === 'submitting') {
      const sessionChanged = action.sentSessionId !== reliableConversation.feed.sessionId;
      const operationSettled = action.operationTurnId
        && interruptTargetHasSettled(reliableConversation.feed.records, action.operationTurnId);
      if (sessionChanged || operationSettled || force) {
        submitConversationAction(action);
      }
      return;
    }

    if (action.interrupt) {
      const currentTurnId = activeTurnId(conversationId);
      const settled = interruptTargetHasSettled(reliableConversation.feed.records, action.interrupt.turnId)
        // A successor can only acquire the Conversation's unique lease after the prior Turn is
        // terminal. This durable successor fact also prevents an old ACK from blocking the queued
        // Turn which the history action must stop next.
        || Boolean(currentTurnId && currentTurnId !== action.interrupt.turnId);
      if (!settled) {
        const sessionChanged = action.interrupt.sentSessionId !== reliableConversation.feed.sessionId;
        if (force || sessionChanged) {
          requestActionInterrupt(action, action.interrupt.turnId, action.interrupt.command);
        }
        return;
      }
      action = { ...action, phase: 'waiting_for_idle', interrupt: undefined };
      setConversationAction(action);
    }

    const activeTurn = activeTurnId(conversationId);
    if (activeTurn) {
      requestActionInterrupt(action, activeTurn);
      return;
    }
    const frontier = reliableConversation.feed.lastCommitSeq ?? undefined;
    if (!force && action.blockedAtCommitSeq && action.blockedAtCommitSeq === frontier) return;
    submitConversationAction(action);
  }

  function requestActionInterrupt(
    action: ConversationActionState,
    turnId: string,
    frozenCommand?: ConversationCommandMetadata
  ): void {
    const command = frozenCommand ?? nextReliableCommandMetadata();
    const requestId = bridge.request(BridgeMessageType.TurnInterrupt, {
      conversationId: action.conversationId,
      turnId,
      leaseEpoch: activeLeaseGeneration(turnId) ?? 0,
      command
    });
    setConversationAction({
      ...action,
      phase: 'requesting_stop',
      blockedAtCommitSeq: undefined,
      interrupt: {
        turnId,
        phase: 'requesting',
        command,
        requestId,
        ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {})
      }
    });
  }

  function submitConversationAction(action: ConversationActionState): void {
    const requestId = requestActionPayload(action.commandPayload);
    setConversationAction({
      ...action,
      phase: 'submitting',
      interrupt: undefined,
      requestId,
      ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {}),
      operationTurnId: undefined,
      submittedAtCommitSeq: reliableConversation.feed.lastCommitSeq ?? undefined,
      blockedAtCommitSeq: undefined
    });
  }

  function requestActionPayload(command: ConversationActionPayload): string {
    switch (command.type) {
      case BridgeMessageType.MessageEdit:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.MessageRetryFrom:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.MessageDeleteFrom:
        return bridge.request(command.type, command.payload);
      case BridgeMessageType.CompressionStart:
        return bridge.request(command.type, command.payload);
    }
  }

  function reconcileStandaloneInterrupt(): void {
    const pending = interruptState.value;
    if (!pending || pending.conversationId !== reliableConversation.conversationId.value) return;
    const currentTurnId = activeTurnId(pending.conversationId);
    if (
      interruptTargetHasSettled(reliableConversation.feed.records, pending.turnId)
      || Boolean(currentTurnId && currentTurnId !== pending.turnId)
    ) {
      setInterruptState(undefined);
      return;
    }
    if (pending.sentSessionId !== reliableConversation.feed.sessionId) {
      sendStandaloneInterrupt(pending);
    }
  }

  function interruptCurrentConversation(cascadeChildAgents = false): boolean {
    const conversationId = activeConversationId();
    const turnId = activeTurnId(conversationId);
    if (!conversationId || !turnId) return false;

    const action = conversationActionStates.value[conversationId];
    if (action?.interrupt?.turnId === turnId) {
      if (action.interrupt.phase === 'stopping') return false;
      clearActionNotice(conversationId);
      requestActionInterrupt(action, turnId, action.interrupt.command);
      return true;
    }

    const pending = interruptState.value;
    if (pending?.conversationId === conversationId && pending.turnId === turnId) {
      if (pending.phase === 'stopping') return false;
      sendStandaloneInterrupt(pending);
      return true;
    }
    const next: InterruptState = {
      conversationId,
      turnId,
      phase: 'requesting',
      command: nextReliableCommandMetadata(),
      cascadeChildAgents
    };
    sendStandaloneInterrupt(next);
    return true;
  }

  function sendStandaloneInterrupt(pending: InterruptState): void {
    const requestId = bridge.request(BridgeMessageType.TurnInterrupt, {
      conversationId: pending.conversationId,
      turnId: pending.turnId,
      leaseEpoch: activeLeaseGeneration(pending.turnId) ?? 0,
      command: pending.command,
      ...(pending.cascadeChildAgents ? { cascadeChildAgents: true } : {})
    });
    setInterruptState({
      ...pending,
      phase: 'requesting',
      requestId,
      ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {})
    });
  }

  function sendForkRequest(request: ForkRequestState): void {
    const requestId = bridge.request(BridgeMessageType.ConversationFork, request.payload);
    setForkRequest({
      ...request,
      requestId,
      ...(reliableConversation.feed.sessionId ? { sentSessionId: reliableConversation.feed.sessionId } : {})
    });
  }

  function replayForkRequestsForSession(sessionId: string): void {
    for (const request of Object.values(forkRequests.value)) {
      if (
        request.sourceConversationId !== reliableConversation.conversationId.value
        || request.sentSessionId === sessionId
      ) continue;
      sendForkRequest(request);
    }
  }

  function dismissTurnInputAcknowledgement(commandId: string): void {
    if (!turnInputAcknowledgements.value[commandId]) return;
    const next = { ...turnInputAcknowledgements.value };
    delete next[commandId];
    turnInputAcknowledgements.value = next;
  }

  function dismissTurnInputFailure(commandId: string): void {
    clearTurnInputFailure(commandId);
  }

  return {
    sendMessage,
    editMessage,
    retryMessageFrom,
    currentAuthoritySelection,
    deleteMessagesFrom,
    forkConversationFrom,
    compressContext,
    interruptCurrentConversation,
    interruptPending,
    interruptPhase: currentInterruptPhase,
    compressionPending,
    conversationAction: currentConversationAction,
    conversationActionPending,
    conversationActionLabel,
    conversationActionNotice,
    currentPendingTurnInputs,
    currentTurnInputAcknowledgements,
    currentTurnInputFailure,
    dismissTurnInputAcknowledgement,
    dismissTurnInputFailure,
    forkPendingTargetIds
  };
}

function readPersistedControls(): PersistedConversationControls {
  const value = bridge.readPersistedState<PersistedConversationControls>(PERSISTED_CONTROL_KEY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyPersistedControls();
  return {
    ...(value.interrupt ? { interrupt: value.interrupt } : {}),
    conversationActions: plainRecord(value.conversationActions),
    forkRequests: plainRecord(value.forkRequests)
  };
}

function emptyPersistedControls(): PersistedConversationControls {
  return { conversationActions: {}, forkRequests: {} };
}

function plainRecord<T>(value: Record<string, T> | undefined): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function persistControls(): void {
  bridge.writePersistedState(
    PERSISTED_CONTROL_KEY,
    toStructuredClonePlainData({
      ...(interruptState.value ? { interrupt: interruptState.value } : {}),
      conversationActions: conversationActionStates.value,
      forkRequests: forkRequests.value
    }, 'reliable conversation controls') as unknown as PersistedConversationControls
  );
}

function sameConversationActionSemantics(
  left: ConversationActionState,
  right: ConversationActionState
): boolean {
  return left.action === right.action
    && left.targetId === right.targetId
    && JSON.stringify(withoutCommand(left.commandPayload)) === JSON.stringify(withoutCommand(right.commandPayload));
}

function withoutCommand(command: ConversationActionPayload): unknown {
  const { command: _command, ...payload } = command.payload;
  return { type: command.type, payload };
}

function retryTargetId(target: MessageRetryTarget): string {
  return target.kind === 'message' ? target.messageId.trim() : target.modelRequestId.trim();
}

function actionCompressionTarget(action: ConversationActionState): CompressionCommandTarget | undefined {
  return action.commandPayload.type === BridgeMessageType.CompressionStart
    ? action.commandPayload.payload.target
    : undefined;
}

function sameCompressionTarget(
  left: CompressionCommandTarget | undefined,
  right: CompressionCommandTarget
): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === 'current_head'
    ? left.expectedRootId === (right as Extract<CompressionCommandTarget, { kind: 'current_head' }>).expectedRootId
    : left.messageId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).messageId
      && left.expectedRevisionId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).expectedRevisionId;
}

function isConversationActionRequestType(value: string | undefined): boolean {
  return value === BridgeMessageType.MessageEdit
    || value === BridgeMessageType.MessageRetryFrom
    || value === BridgeMessageType.MessageDeleteFrom
    || value === BridgeMessageType.CompressionStart;
}

function compressionFailureLabel(reasonCode: string | undefined): string {
  return reasonCode ? `上下文总结未执行：${reasonCode}` : '上下文总结未执行。';
}

function modelExists(
  config: { model?: string; models: Array<{ id: string }> },
  modelId: string
): boolean {
  const id = modelId.trim();
  return !!id && (config.model?.trim() === id || config.models.some((model) => model.id === id));
}

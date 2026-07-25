import { computed, reactive } from 'vue';
import { defineStore } from 'pinia';
import {
  BridgeMessageType,
  conversationClientStateStreamId,
  type CommandResultPayload,
  type CommandStatusResultPayload,
  type ClientSnapshotPayload,
  type ConversationCommandMetadata,
  type ConversationCommittedPatchPayload,
  type ConversationHeadSnapshotPayload,
  type InteractionResultPayload,
  type WebviewToExtensionMessage
} from '@shared/protocol';
import type { CommandAck, CommandServiceError, CommandStatus, CommittedConversationHead, JsonValue, TerminalStreamFence } from '@shared/conversationReliability';
import {
  advancePatchHead,
  conversationIdForStateStream,
  headReached,
  projectionBarrierForConversation,
  projectionWaitDisposition,
  rejectedCommandDisposition,
  reserveNextExpectedVersion,
  snapshotHeadMatchesStream,
  streamEpochIdentityKey,
  streamEpochIsTerminal,
  type ObservedConversationHead
} from '@shared/conversationCommandReconciliation';
import type { CommandId } from '@shared/stableIds';
import { bridge } from '@webview/transport';
import { nextCommandId } from '@webview/reliability/browserStableIds';

const STORAGE_KEY = 'limcode.pending-conversation-commands.epoch-8';
const HOST_STATE_KEY = 'pendingConversationCommandsEpoch8';
const STATUS_QUERY_DELAY_MS = 8_000;
const COMMAND_TERMINAL_DEADLINE_MS = 120_000;
const PROJECTION_BARRIER_DEADLINE_MS = 30_000;

export type ReliableConversationCommandType =
  | BridgeMessageType.TurnStart
  | BridgeMessageType.TurnEnqueue
  | BridgeMessageType.TurnSteer
  | BridgeMessageType.TurnInterrupt
  | BridgeMessageType.TurnIntentUpdate
  | BridgeMessageType.TurnIntentCancel
  | BridgeMessageType.TurnIntentReorder
  | BridgeMessageType.TurnIntentPause
  | BridgeMessageType.TurnIntentResume
  | BridgeMessageType.TurnIntentResumeAll
  | BridgeMessageType.TurnIntentPromote
  | BridgeMessageType.MessageEdit
  | BridgeMessageType.MessageDeleteFrom
  | BridgeMessageType.MessageRetryFrom
  | BridgeMessageType.CommandOutcomeResolve;

export type PendingCommandKind =
  | 'start'
  | 'enqueue'
  | 'steer'
  | 'interrupt'
  | 'intent_control'
  | 'promote'
  | 'delete'
  | 'retry'
  | 'edit'
  | 'resolution';
export type PendingCommandPhase =
  | 'submitting'
  | 'awaiting_result'
  | 'committed_waiting_patch'
  | 'querying_status'
  | 'blocked'
  | 'outcome_unknown'
  | 'partial_success'
  | 'projection_recovery';

type PayloadFor<TType extends ReliableConversationCommandType> = NonNullable<Extract<WebviewToExtensionMessage, { type: TType }>['payload']>;
type ReliableConversationCommandPayload = PayloadFor<ReliableConversationCommandType>;
type PayloadWithoutCommand<TType extends ReliableConversationCommandType> = Omit<PayloadFor<TType>, 'command'>;

export interface CheckpointRestoreSaga {
  kind: 'checkpoint_restore_then_command';
  checkpointId: string;
  restoredAt: number;
  message: string;
  restoredFileCount?: number;
  removedFileCount?: number;
}

export interface InteractionOutcomeNotice {
  id: string;
  conversationId: string;
  targetId: string;
  status: Extract<InteractionResultPayload['status'], 'stale' | 'rejected' | 'blocked' | 'outcome_unknown'>;
  message: string;
  createdAt: number;
}

/**
 * Turn interrupt 的权威语义回执。它只负责解释已持久提交的命令结果，不参与执行状态判断；
 * Stop 是否仍可用始终由 ExecutionLease + Turn 投影决定。
 */
export interface TurnInterruptOutcomeNotice {
  id: string;
  conversationId: string;
  requestedTurnId: string;
  status: 'interrupt_committed' | 'target_replaced';
  detachedBackgroundTurnIds: string[];
  message: string;
  createdAt: number;
}

export interface PendingConversationCommandRecord {
  commandId: CommandId;
  conversationId: string;
  kind: PendingCommandKind;
  targetId: string;
  type: ReliableConversationCommandType;
  phase: PendingCommandPhase;
  startedAt: number;
  command: ConversationCommandMetadata;
  payload: ReliableConversationCommandPayload;
  transportReceivedAt?: number;
  projectionObservedAt?: number;
  committedAt?: number;
  transitionId?: string;
  controlHeads?: CommittedConversationHead[];
  projectionBarrier?: CommittedConversationHead;
  error?: CommandServiceError;
  saga?: CheckpointRestoreSaga;
  finalMessage?: string;
  notFoundRetries: number;
}

interface PersistedCommandState {
  pending: PendingConversationCommandRecord[];
  observedHeads: Record<string, ObservedConversationHead>;
  confirmedSnapshotHeads: Record<string, ObservedConversationHead>;
  interruptNotices: Record<string, TurnInterruptOutcomeNotice>;
}

interface InFlightStatusQuery {
  requestId: string;
  generation: number;
  allowReplayOnNotFound: boolean;
}

const statusTimers = new Map<string, number>();
const inFlightStatusQueries = new Map<string, InFlightStatusQuery>();
const statusQueryGenerations = new Map<string, number>();

export const useConversationCommandStore = defineStore('conversationCommands', () => {
  const restored = loadPersistedState();
  const pending = reactive<Record<string, PendingConversationCommandRecord>>(Object.fromEntries(restored.pending.map((command) => [command.commandId, command])));
  const observedHeads = reactive<Record<string, ObservedConversationHead>>({ ...restored.observedHeads });
  const confirmedSnapshotHeads = reactive<Record<string, ObservedConversationHead>>({ ...restored.confirmedSnapshotHeads });
  const resyncAwaitingSnapshot = reactive<Record<string, boolean>>({});
  const terminalStreamFences = reactive<Record<string, TerminalStreamFence>>({});
  const interactionNotices = reactive<Record<string, InteractionOutcomeNotice>>({});
  const interruptNotices = reactive<Record<string, TurnInterruptOutcomeNotice>>({ ...restored.interruptNotices });

  const pendingCommands = computed(() => Object.values(pending).sort((left, right) => left.startedAt - right.startedAt || left.commandId.localeCompare(right.commandId)));
  const blockedCommands = computed(() => pendingCommands.value.filter((command) => command.phase === 'blocked'
    || command.phase === 'outcome_unknown'
    || command.phase === 'partial_success'
    || command.phase === 'projection_recovery'));

  function submit<TType extends ReliableConversationCommandType>(
    type: TType,
    payload: PayloadWithoutCommand<TType>,
    input: { kind: PendingCommandKind; targetId: string; saga?: CheckpointRestoreSaga }
  ): CommandId {
    const conversationId = String((payload as { conversationId?: unknown }).conversationId ?? '');
    if (!conversationId) throw new Error(`Reliable command ${type} requires conversationId.`);
    const commandId = nextCommandId();
    const command: ConversationCommandMetadata = {
      commandId,
      expectedVersion: nextExpectedVersion(conversationId),
      issuedAt: Date.now()
    };
    const fullPayload = { ...(payload as object), command } as PayloadFor<TType>;
    pending[commandId] = {
      commandId,
      conversationId,
      kind: input.kind,
      targetId: input.targetId,
      type,
      phase: 'submitting',
      startedAt: command.issuedAt,
      command,
      payload: cloneRecord(fullPayload),
      ...(input.saga ? { saga: cloneRecord(input.saga) } : {}),
      notFoundRetries: 0
    };
    persist();
    armStatusQuery(commandId);
    sendReliable(type, fullPayload);
    return commandId;
  }

  function applyTransportReceipt(commandId: string): void {
    const command = pending[commandId];
    if (!command || command.controlHeads?.length) return;
    command.transportReceivedAt ??= Date.now();
    if (command.phase !== 'blocked' && command.phase !== 'outcome_unknown' && command.phase !== 'partial_success') {
      command.phase = 'awaiting_result';
    }
    persist();
    if (!inFlightStatusQueries.has(commandId)) armStatusQuery(commandId);
  }

  function applyInteractionResult(payload: InteractionResultPayload, correlationId?: string): void {
    if (payload.status === 'stale') requestAuthoritativeResync(payload.conversationId);
    if (payload.status !== 'stale' && payload.status !== 'rejected' && payload.status !== 'blocked' && payload.status !== 'outcome_unknown') return;
    const id = correlationId || `${payload.requestType}:${payload.targetId}:${Date.now()}`;
    interactionNotices[id] = {
      id,
      conversationId: payload.conversationId,
      targetId: payload.targetId,
      status: payload.status,
      message: payload.reason?.trim() || (payload.status === 'stale'
        ? '操作目标状态已变化；已请求重新同步最终状态。'
        : payload.status === 'outcome_unknown'
          ? '操作结果暂时无法证明，请重新查询或重载窗口恢复。'
          : '操作未能完成。'),
      createdAt: Date.now()
    };
  }

  function dismissInteractionNotice(id: string): void {
    delete interactionNotices[id];
  }

  function dismissInterruptNotice(id: string): void {
    if (!interruptNotices[id]) return;
    delete interruptNotices[id];
    persist();
  }

  function applyCommandResult(payload: CommandResultPayload): void {
    if (payload.ack) applyAck(payload.ack);
    if (payload.error) applyServiceError(payload.error);
  }

  function applyStatusResult(payload: CommandStatusResultPayload, correlationId?: string): void {
    const command = pending[payload.commandId];
    if (!command) return;
    const active = inFlightStatusQueries.get(command.commandId);
    if (!active || !correlationId || active.requestId !== correlationId
      || statusQueryGenerations.get(command.commandId) !== active.generation) return;
    inFlightStatusQueries.delete(command.commandId);
    clearStatusTimer(command.commandId);
    applyStatus(command, payload.result, active.allowReplayOnNotFound);
  }

  function applyCommittedPatch(batch: ConversationCommittedPatchPayload): boolean {
    // A terminal fence is an independent monotonic fact. Install it even when the authoritative
    // patch itself has a sequence gap and must be replaced by a snapshot.
    for (const fence of batch.terminalStreamFences ?? []) {
      terminalStreamFences[streamEpochIdentityKey(fence)] = { ...fence };
    }
    // Sequence admission is based on the head actually applied to permanent ClientState, not a
    // newer metadata-only HEAD query. This prevents applying only the tail of a missing patch range.
    const decision = advancePatchHead(confirmedSnapshotHeads[batch.conversationId], batch);
    if (decision.status === 'resync_required') {
      recordPatchSequenceGap(batch.conversationId, decision.reason);
      requestAuthoritativeResync(batch.conversationId);
      return false;
    }
    const observed = observedHeads[batch.conversationId];
    if (!observed
      || decision.head.version > observed.version
      || (decision.head.version === observed.version && decision.head.patchNextSeq > observed.patchNextSeq)) {
      observedHeads[batch.conversationId] = decision.head;
    }
    persist();
    return decision.status === 'accepted';
  }

  /** Marks the durable head visible only after both permanent ClientState projections applied it. */
  function confirmCommittedPatch(batch: ConversationCommittedPatchPayload): void {
    const observed = observedHeads[batch.conversationId];
    if (!observed
      || observed.streamId !== batch.streamId
      || observed.version < batch.conversationVersion
      || observed.patchNextSeq < batch.nextSeq) return;
    confirmedSnapshotHeads[batch.conversationId] = {
      version: batch.conversationVersion,
      streamId: batch.streamId,
      patchNextSeq: batch.nextSeq
    };
    const observedAt = Date.now();
    for (const commandId of batch.commandIds) {
      const command = pending[commandId];
      if (command) command.projectionObservedAt = observedAt;
    }
    for (const command of Object.values(pending)) {
      if (command.conversationId === batch.conversationId) settleIfObserved(command.commandId);
    }
    persist();
  }

  function resyncConversation(conversationId: string): void {
    requestAuthoritativeResync(conversationId);
  }

  function isStreamEpochTerminal(requestId: string, attemptId: string, generation: number): boolean {
    return streamEpochIsTerminal({ requestId, attemptId, generation }, terminalStreamFences);
  }

  function applyHeadSnapshot(head: ConversationHeadSnapshotPayload): void {
    const previous = observedHeads[head.conversationId];
    if (!previous || head.version > previous.version || (head.version === previous.version && head.patchNextSeq >= previous.patchNextSeq)) {
      observedHeads[head.conversationId] = { ...head };
    }
    persist();
  }

  function observeClientSnapshot(snapshot: ClientSnapshotPayload): void {
    const conversationId = conversationIdForStateStream(snapshot.streamId);
    if (!conversationId) return;
    const boundHead = snapshot.conversationHead;
    if (!boundHead) {
      recordPatchSequenceGap(conversationId, 'snapshot_missing_committed_head');
      throw new Error(`Conversation snapshot is missing its committed HEAD: ${conversationId}`);
    }
    if (!snapshotHeadMatchesStream(conversationId, snapshot.streamId, boundHead)) {
      recordPatchSequenceGap(conversationId, 'snapshot_head_mismatch');
      requestAuthoritativeResync(conversationId);
      return;
    }
    delete resyncAwaitingSnapshot[conversationId];
    const head = { ...boundHead };
    observedHeads[conversationId] = head;
    confirmedSnapshotHeads[conversationId] = head;
    for (const command of Object.values(pending)) {
      if (command.conversationId === conversationId) settleIfObserved(command.commandId);
    }
    persist();
  }

  function requestHead(conversationId: string): void {
    if (!conversationId) return;
    bridge.request(BridgeMessageType.ConversationHeadGet, { conversationId });
  }

  function resumePending(): void {
    for (const command of Object.values(pending)) startStatusQuery(command.commandId, true);
    persist();
  }

  function isTargetPending(conversationId: string, targetId: string, kind?: PendingCommandKind): boolean {
    return Object.values(pending).some((command) => command.phase !== 'partial_success'
      && command.phase !== 'projection_recovery'
      // A durable pre-WAL failure is a proven terminal outcome. Keep the diagnostic card until the
      // user acknowledges it, but do not let that local record monopolize the target indefinitely.
      && !(command.phase === 'blocked' && command.error?.durable === true)
      && command.conversationId === conversationId
      && command.targetId === targetId
      && (!kind || command.kind === kind));
  }

  function queryStatus(commandId: string): void {
    const command = pending[commandId];
    if (!command) return;
    command.error = undefined;
    if (command.controlHeads?.length) {
      command.phase = 'committed_waiting_patch';
      command.committedAt = Date.now();
    }
    persist();
    // Manual reconciliation never spends or resets the replay budget.
    startStatusQuery(command.commandId, false);
  }

  function resolveUnknownOutcome(conversationId: string, operationId: string, resolution: 'restart_proved_not_executed' | 'submit_verified_result' | 'abandon', input: { evidenceRef?: string; verifiedResult?: unknown } = {}): void {
    submit(BridgeMessageType.CommandOutcomeResolve, { conversationId, operationId, resolution, ...input }, { kind: 'resolution', targetId: operationId });
  }

  function applyAck(ack: CommandAck): void {
    const command = pending[ack.commandId];
    if (!command || (command.controlHeads?.length && ack.status === 'rejected')) return;
    invalidateStatusQuery(command.commandId);
    if (ack.status === 'rejected') {
      const saga = command.saga;
      if (rejectedCommandDisposition(!!saga) === 'partial_success' && saga) {
        command.phase = 'partial_success';
        command.finalMessage = `工作区已从存档点 ${saga.checkpointId} 恢复，但对话操作未执行：${ack.message}`;
        command.error = undefined;
        clearStatusTimer(command.commandId);
        persist();
      } else {
        clearCommand(command.commandId);
      }
      return;
    }
    recordTurnInterruptOutcome(command, ack.result);
    command.phase = 'committed_waiting_patch';
    command.transitionId = ack.transitionId;
    command.committedAt ??= Date.now();
    command.controlHeads = ack.controlHeads.map((head) => ({ ...head }));
    command.projectionBarrier = projectionBarrierForConversation(command.conversationId, ack.projectionHeads);
    command.error = undefined;
    persist();
    if (!settleIfObserved(command.commandId)) {
      requestAuthoritativeResync(command.conversationId);
      armStatusQuery(command.commandId);
    }
  }

  function recordTurnInterruptOutcome(command: PendingConversationCommandRecord, result: JsonValue): void {
    if (command.type !== BridgeMessageType.TurnInterrupt) return;
    const outcome = parseTurnInterruptOutcome(result);
    if (!outcome) return;

    if (outcome.status === 'target_replaced') {
      interruptNotices[command.commandId] = {
        id: command.commandId,
        conversationId: command.conversationId,
        requestedTurnId: command.targetId,
        status: outcome.status,
        detachedBackgroundTurnIds: [],
        message: '要中断的回合已被替换；新的当前回合没有被本次 Stop 误伤，已请求同步权威执行状态。',
        createdAt: command.committedAt ?? Date.now()
      };
      requestAuthoritativeResync(command.conversationId);
      return;
    }

    if (outcome.detachedBackgroundTurnIds.length === 0) return;
    interruptNotices[command.commandId] = {
      id: command.commandId,
      conversationId: command.conversationId,
      requestedTurnId: command.targetId,
      status: outcome.status,
      detachedBackgroundTurnIds: [...outcome.detachedBackgroundTurnIds],
      message: `${outcome.detachedBackgroundTurnIds.length} 个后台子 Agent 已按策略从本次 Stop 中脱离，仍会独立完成并通过 Inbox 投递结果。`,
      createdAt: command.committedAt ?? Date.now()
    };
  }

  function applyServiceError(error: CommandServiceError): void {
    const command = pending[error.commandId];
    if (!command || command.controlHeads?.length) return;
    invalidateStatusQuery(command.commandId);
    if (error.durable && command.saga) {
      command.phase = 'partial_success';
      command.finalMessage = `工作区已从存档点 ${command.saga.checkpointId} 恢复，但对话操作未执行：${error.message}`;
      command.error = undefined;
      persist();
      return;
    }
    command.phase = error.code === 'recovery_required' ? 'outcome_unknown' : 'blocked';
    command.error = { ...error };
    persist();
  }

  function applyStatus(command: PendingConversationCommandRecord, status: CommandStatus, allowReplayOnNotFound: boolean): void {
    // A committed HEAD is monotonic. A late query issued before the ack cannot demote it.
    if (command.controlHeads?.length && status.status !== 'committed') {
      continueProjectionReconciliation(command);
      return;
    }
    switch (status.status) {
      case 'committed':
      case 'rejected':
        applyAck(status.ack);
        return;
      case 'failed':
      case 'blocked':
        applyServiceError(status.error);
        return;
      case 'in_progress':
        if (Date.now() - command.startedAt >= COMMAND_TERMINAL_DEADLINE_MS) {
          command.phase = 'outcome_unknown';
          command.error = {
            commandId: command.commandId,
            status: 'unavailable',
            code: 'recovery_required',
            message: '命令超过终态等待期限；已停止自动轮询，请重新查询持久结果或重载窗口执行恢复。'
          };
          persist();
          return;
        }
        if (!command.controlHeads?.length) command.phase = 'querying_status';
        persist();
        armStatusQuery(command.commandId);
        return;
      case 'not_found':
        if (allowReplayOnNotFound && command.transportReceivedAt === undefined && command.notFoundRetries === 0) {
          command.notFoundRetries += 1;
          command.phase = 'submitting';
          persist();
          sendReliable(command.type, command.payload);
          armStatusQuery(command.commandId);
          return;
        }
        command.phase = 'outcome_unknown';
        command.error = {
          commandId: command.commandId,
          status: 'unavailable',
          code: 'recovery_required',
          message: command.transportReceivedAt === undefined
            ? '后端未找到该命令的持久结果；已保留本地待确认状态。'
            : '后端已接收命令，但状态查询未找到其持久记录；已停止自动重放，请重新查询或重载窗口执行恢复。'
        };
        persist();
    }
  }

  function settleIfObserved(commandId: string): boolean {
    const command = pending[commandId];
    if (!command?.controlHeads?.length) return false;
    // The ACK already proves the complete multi-scope transaction. This Webview only waits for the
    // initiating conversation projection it owns; unrelated child streams are not observation gates.
    const reached = !command.projectionBarrier
      || headReached(confirmedSnapshotHeads, [command.projectionBarrier]);
    if (reached) clearCommand(commandId);
    return reached;
  }

  function continueProjectionReconciliation(command: PendingConversationCommandRecord): void {
    if (settleIfObserved(command.commandId)) return;
    const committedAt = command.committedAt ?? command.startedAt;
    if (projectionWaitDisposition({
      reached: false,
      now: Date.now(),
      committedAt,
      deadlineMs: PROJECTION_BARRIER_DEADLINE_MS
    }) === 'recovery_required') {
      invalidateStatusQuery(command.commandId);
      requestAuthoritativeResync(command.conversationId);
      command.phase = 'projection_recovery';
      command.error = {
        commandId: command.commandId,
        status: 'unavailable',
        code: 'recovery_required',
        message: '命令已持久提交，但当前页面的状态投影未在期限内同步。运行已不再等待后端接受；可重同步当前会话或重载窗口恢复投影。'
      };
      command.finalMessage = '操作已提交；当前页面状态需要重新同步。';
      persist();
      return;
    }
    command.phase = 'committed_waiting_patch';
    requestAuthoritativeResync(command.conversationId);
    persist();
    armStatusQuery(command.commandId);
  }

  function nextExpectedVersion(conversationId: string): number {
    return reserveNextExpectedVersion(
      conversationId,
      observedHeads[conversationId]?.version ?? 0,
      Object.values(pending).map((command) => ({
        conversationId: command.conversationId,
        expectedVersion: command.command.expectedVersion,
        excluded: command.phase === 'partial_success',
        controlHeads: command.controlHeads
      }))
    );
  }

  function requestAuthoritativeResync(conversationId: string): void {
    resyncAwaitingSnapshot[conversationId] = true;
    bridge.request(BridgeMessageType.ClientResync, {
      conversationId,
      streamId: conversationClientStateStreamId(conversationId)
    });
  }

  function armStatusQuery(commandId: string): void {
    clearStatusTimer(commandId);
    statusTimers.set(commandId, window.setTimeout(() => {
      statusTimers.delete(commandId);
      const command = pending[commandId];
      if (!command) return;
      const timedOut = inFlightStatusQueries.get(commandId);
      if (timedOut) inFlightStatusQueries.delete(commandId);
      if (command.controlHeads?.length) {
        continueProjectionReconciliation(command);
        return;
      }
      startStatusQuery(commandId, timedOut?.allowReplayOnNotFound ?? true);
    }, STATUS_QUERY_DELAY_MS));
  }

  function startStatusQuery(commandId: string, allowReplayOnNotFound: boolean): void {
    const command = pending[commandId];
    if (!command || inFlightStatusQueries.has(commandId)) return;
    if (command.controlHeads?.length) {
      continueProjectionReconciliation(command);
      return;
    }
    const generation = (statusQueryGenerations.get(commandId) ?? 0) + 1;
    statusQueryGenerations.set(commandId, generation);
    if (!command.controlHeads?.length) command.phase = 'querying_status';
    const requestId = bridge.request(BridgeMessageType.CommandStatusGet, { commandId });
    inFlightStatusQueries.set(commandId, { requestId, generation, allowReplayOnNotFound });
    persist();
    // This timer is the response deadline. Expiry invalidates the correlation before retrying.
    armStatusQuery(commandId);
  }

  function invalidateStatusQuery(commandId: string): void {
    clearStatusTimer(commandId);
    inFlightStatusQueries.delete(commandId);
    statusQueryGenerations.set(commandId, (statusQueryGenerations.get(commandId) ?? 0) + 1);
  }

  function dismiss(commandId: string): void {
    if (!pending[commandId]) return;
    clearCommand(commandId);
  }

  function clearCommand(commandId: string): void {
    invalidateStatusQuery(commandId);
    delete pending[commandId];
    persist();
  }

  function persist(): void {
    const state: PersistedCommandState = {
      pending: Object.values(pending).map((command) => cloneRecord(command) as unknown as PendingConversationCommandRecord),
      observedHeads: cloneRecord(observedHeads),
      confirmedSnapshotHeads: cloneRecord(confirmedSnapshotHeads),
      interruptNotices: cloneRecord(interruptNotices)
    };
    const plainState = cloneRecord(state);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(plainState));
    bridge.writePersistedState(HOST_STATE_KEY, plainState);
  }

  return {
    pending,
    observedHeads,
    confirmedSnapshotHeads,
    terminalStreamFences,
    interactionNotices,
    interruptNotices,
    pendingCommands,
    blockedCommands,
    submit,
    applyTransportReceipt,
    applyCommandResult,
    applyInteractionResult,
    dismissInteractionNotice,
    dismissInterruptNotice,
    applyStatusResult,
    applyCommittedPatch,
    confirmCommittedPatch,
    resyncConversation,
    isStreamEpochTerminal,
    applyHeadSnapshot,
    observeClientSnapshot,
    requestHead,
    resumePending,
    isTargetPending,
    queryStatus,
    dismiss,
    resolveUnknownOutcome
  };
});

function recordPatchSequenceGap(conversationId: string, reasonCode: string): void {
  console.warn('[LimCode][Reliability]', {
    kind: 'patch_sequence_gap',
    timestamp: Date.now(),
    conversationId,
    phase: 'frontend_patch_admission',
    reasonCode
  });
}

function sendReliable(type: ReliableConversationCommandType, payload: ReliableConversationCommandPayload): void {
  // Pinia makes nested pending payloads reactive. Always cross the bridge with recursively plain data.
  bridge.request(type, cloneRecord(payload));
}

function clearStatusTimer(commandId: string): void {
  const timer = statusTimers.get(commandId);
  if (timer !== undefined) window.clearTimeout(timer);
  statusTimers.delete(commandId);
}

function loadPersistedState(): PersistedCommandState {
  const empty: PersistedCommandState = { pending: [], observedHeads: {}, confirmedSnapshotHeads: {}, interruptNotices: {} };
  const hosted = bridge.readPersistedState<unknown>(HOST_STATE_KEY);
  if (hosted !== undefined) return normalizePersistedState(hosted);
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`可靠命令 session 状态不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizePersistedState(parsed);
}

function normalizePersistedState(parsed: unknown): PersistedCommandState {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('可靠命令 session 状态必须是对象。');
  }
  const state = parsed as Partial<PersistedCommandState>;
  if (!Array.isArray(state.pending)
    || !state.observedHeads || typeof state.observedHeads !== 'object' || Array.isArray(state.observedHeads)
    || !state.confirmedSnapshotHeads || typeof state.confirmedSnapshotHeads !== 'object' || Array.isArray(state.confirmedSnapshotHeads)
    || !state.interruptNotices || typeof state.interruptNotices !== 'object' || Array.isArray(state.interruptNotices)) {
    throw new Error('可靠命令 session 状态字段不完整。');
  }
  return {
    pending: state.pending.map((command) => cloneRecord(command)),
    observedHeads: cloneRecord(state.observedHeads),
    confirmedSnapshotHeads: cloneRecord(state.confirmedSnapshotHeads),
    interruptNotices: cloneRecord(state.interruptNotices)
  };
}

function parseTurnInterruptOutcome(value: JsonValue):
  | { status: 'target_replaced' }
  | { status: 'interrupt_committed'; detachedBackgroundTurnIds: string[] }
  | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;
  if (value.status === 'target_replaced') return { status: 'target_replaced' };
  if (value.status !== 'interrupt_committed'
    || !Array.isArray(value.detachedBackgroundTurnIds)
    || !value.detachedBackgroundTurnIds.every((id) => typeof id === 'string')) return undefined;
  return {
    status: 'interrupt_committed',
    detachedBackgroundTurnIds: [...value.detachedBackgroundTurnIds]
  };
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

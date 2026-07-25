import { defineStore } from 'pinia';
import { createEmptyClientState } from '@shared/clientStateSchema';
import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  type AgentRunRecord,
  type AgentRunStatus,
  type CheckpointRecord,
  type CheckpointTimelineAnchorRecord,
  type ClientPatchOp,
  type ClientState,
  type ConversationRecord,
  type CompressionBlockRecord,
  type MessageRecord,
  type ProjectContextRecord,
  type WorkEnvironmentRecord
} from '@shared/protocol';
import type {
  DurableInteractionRequestRecord,
  ExecutionLeaseRecord,
  InteractionOwnerLinkRecord,
  RuntimeDeliveryLinkRecord,
  TurnIntentRecord,
  TurnRecord
} from '@shared/conversationReliability';
import { isUserVisibleTimelineMessage } from '@shared/messagePresentation';
import { workEnvironmentSortKey as buildWorkEnvironmentSortKey } from '@shared/workEnvironmentCatalog';
import { createClientStateDb, type ClientStateDb } from './clientStateDb';
import { compactClientPatchOps } from './clientPatchCompaction';

export interface ClientStateStoreState extends ClientState {
  /** 每个 state stream 当前已应用到的顺序号，用于判断 patch 是否断链。 */
  streamSeqs: Record<string, number>;
  /** 当前 webview 聚焦的对话 id（单对话场景，由 session 驱动 + 默认回落）。 */
  currentConversationId: string;
}

/** 当前对话的模型 / 工作流概要，供标签头展示。 */
export interface CurrentModelSummary {
  agentName?: string;
  workflowName?: string;
  model?: string;
}

export interface CurrentExecution {
  lease: ExecutionLeaseRecord;
  turn: TurnRecord;
  /** AgentRun is a read-only compatibility/display projection of the same Turn, never execution authority. */
  run?: AgentRunRecord;
}

export interface CurrentInteraction {
  request: DurableInteractionRequestRecord;
  owner: InteractionOwnerLinkRecord;
}

export interface CurrentRunSummary {
  activeRuns: AgentRunRecord[];
  primaryRun?: AgentRunRecord;
  status?: AgentRunStatus;
  label: string;
  isRunning: boolean;
}

const TERMINAL_AGENT_RUN_STATUSES = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled', 'stale', 'interrupted']);

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return !TERMINAL_AGENT_RUN_STATUSES.has(status);
}

const dbByStore = new WeakMap<object, ClientStateDb>();

interface PendingClientStatePatchBatch {
  streamId: string;
  streamSeq: number;
  patches: ClientPatchOp[];
  frameId?: number;
  timerId?: number;
}

const pendingClientStatePatchBatches = new Map<string, PendingClientStatePatchBatch>();
// 设置页依赖 startup + deferred 两阶段 ClientState：Ready 后第一次 global snapshot 可能还没有
// workEnvironment / checkpoint 等 deferred 表；后端 deferred 加载完成后会再次 resync。
// 因此配置页标题加载态至少等到 global stream seq >= 2 再收起。
const SETTINGS_READY_MIN_GLOBAL_STREAM_SEQ = 2;

function dbFor(store: ClientStateStoreState): ClientStateDb {
  const key = store as object;
  let db = dbByStore.get(key);
  if (!db) {
    db = createClientStateDb(store);
    dbByStore.set(key, db);
  }
  return db;
}

function clearPendingClientStatePatch(streamId: string): void {
  const batch = pendingClientStatePatchBatches.get(streamId);
  if (!batch) return;
  if (batch.frameId !== undefined) window.cancelAnimationFrame(batch.frameId);
  if (batch.timerId !== undefined) window.clearTimeout(batch.timerId);
  pendingClientStatePatchBatches.delete(streamId);
}

/**
 * 同步自后端的 ClientState 投影。
 *
 * 只负责"应用 snapshot/patch + 暴露按当前对话过滤的只读视图"，
 * 领域语义由 shared/clientStateSchema 驱动的 clientStateDb 执行器机械完成。
 */
const useClientStateStoreDefinition = defineStore('clientState', {
  state: (): ClientStateStoreState => ({
    ...createEmptyClientState(),
    streamSeqs: {},
    currentConversationId: ''
  }),
  getters: {
    currentConversationDetailLoaded(state): boolean {
      if (!state.currentConversationId) return false;
      return (state.streamSeqs[conversationClientStateStreamId(state.currentConversationId)] ?? 0) > 0;
    },
    settingsClientStateReady(state): boolean {
      return isSettingsClientStateReady(state);
    },
    settingsClientStateLoading(state): boolean {
      return !isSettingsClientStateReady(state);
    },
    isConfigScopeClientStateLoading(state): (scopeKind?: string, scopeId?: string) => boolean {
      return (scopeKind?: string, scopeId?: string): boolean => {
        if (!isSettingsClientStateReady(state)) return true;
        if (scopeKind === 'conversation' && scopeId) return (state.streamSeqs[conversationClientStateStreamId(scopeId)] ?? 0) <= 0;
        return false;
      };
    },
    currentConversation(state): ConversationRecord | undefined {
      return state.conversations.find((conversation) => conversation.id === state.currentConversationId);
    },
    currentProjectContext(state): ProjectContextRecord | undefined {
      const link = state.conversationProjectLinks.find(
        (candidate) => candidate.conversationId === state.currentConversationId && candidate.role === 'primary'
      );
      return state.projectContexts.find((candidate) => candidate.id === link?.projectContextId);
    },
    currentWorkEnvironment(state): WorkEnvironmentRecord | undefined {
      const link = state.conversationWorkEnvironmentLinks.find(
        (candidate) => candidate.conversationId === state.currentConversationId && candidate.role === 'active'
      );
      const linked = state.workEnvironments.find((candidate) => candidate.id === link?.workEnvironmentId && candidate.available);
      if (linked) return linked;
      return state.workEnvironments
        .filter((candidate) => candidate.available)
        .sort((left, right) => workEnvironmentSortKey(left).localeCompare(workEnvironmentSortKey(right), 'zh-CN') || left.id.localeCompare(right.id))
        [0];
    },
    /** 当前对话下、按 seq 排序、剔除模型内部控制输入与纯工具响应。 */
    currentMessages(state): MessageRecord[] {
      return state.messages
        .filter(
          (message) =>
            message.conversationId === state.currentConversationId &&
            isUserVisibleTimelineMessage(message)
        )
        .sort((left, right) => left.seq - right.seq);
    },
    currentCheckpoints(state): CheckpointRecord[] {
      return state.checkpoints
        .filter((checkpoint) => checkpoint.conversationId === state.currentConversationId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCheckpointTimelineAnchors(state): CheckpointTimelineAnchorRecord[] {
      return state.checkpointTimelineAnchors
        .filter((anchor) => anchor.conversationId === state.currentConversationId)
        .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentCompressionBlocks(state): CompressionBlockRecord[] {
      return state.compressionBlocks
        .filter((block) => block.conversationId === state.currentConversationId)
        .sort((left, right) => (left.anchorSeq ?? left.endSeq ?? 0) - (right.anchorSeq ?? right.endSeq ?? 0) || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentExecution(state): CurrentExecution | undefined {
      return executionForConversation(state, state.currentConversationId);
    },
    currentActiveRuns(state): AgentRunRecord[] {
      const execution = executionForConversation(state, state.currentConversationId);
      return execution?.run ? [execution.run] : [];
    },
    currentQueuedTurnIntents(state): TurnIntentRecord[] {
      return state.turnIntents
        .filter((intent) => intent.conversationId === state.currentConversationId && intent.state === 'queued')
        .sort((left, right) => left.order - right.order || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentPendingInteractions(state): CurrentInteraction[] {
      return pendingInteractionsForConversation(
        state.interactionRequests as unknown as DurableInteractionRequestRecord[],
        state.interactionOwnerLinks as unknown as InteractionOwnerLinkRecord[],
        state.currentConversationId
      );
    },
    currentPendingRuntimeDeliveries(state): RuntimeDeliveryLinkRecord[] {
      return state.runtimeDeliveryLinks
        .filter((delivery) => delivery.destinationConversationId === state.currentConversationId
          && (delivery.state === 'pending' || delivery.state === 'delivering'))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    currentRunSummary(state): CurrentRunSummary {
      const execution = executionForConversation(state, state.currentConversationId);
      const primaryRun = execution?.run;
      return {
        activeRuns: primaryRun ? [primaryRun] : [],
        ...(primaryRun ? { primaryRun, status: primaryRun.status } : {}),
        label: execution ? labelForTurn(execution.turn) : '空闲',
        isRunning: execution !== undefined
      };
    },
    currentModelSummary(state): CurrentModelSummary {
      const agentSelection = state.conversationAgentSelections
        .filter((selection) => selection.conversationId === state.currentConversationId && selection.role === 'active')
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
      const agentLink = agentSelection
        ? undefined
        : state.agentConversationLinks.find((link) => link.conversationId === state.currentConversationId && link.role === 'default') ??
          state.agentConversationLinks.find((link) => link.conversationId === state.currentConversationId);
      const agent = state.agents.find((candidate) => candidate.id === (agentSelection?.agentId ?? agentLink?.agentId));

      const conversationWorkflowSelection = state.conversationWorkflowSelections.find(
        (selection) => selection.conversationId === state.currentConversationId && selection.role === 'active'
      );
      const workflow = conversationWorkflowSelection
        ? conversationWorkflowSelection.scopeKind === 'workflow'
          ? state.workflows.find((candidate) => candidate.id === conversationWorkflowSelection.workflowId)
          : undefined
        : undefined;

      const profileLink = latestScopeLink(state.modelProfileScopeLinks.filter((link) =>
        link.role === 'active' && (
          (link.scopeKind === 'conversation' && link.scopeId === state.currentConversationId) ||
          (workflow && link.scopeKind === 'workflow' && link.scopeId === workflow.id) ||
          (agent && link.scopeKind === 'agent' && link.scopeId === agent.id) ||
          link.scopeKind === 'global'
        )
      ));
      const profile = state.modelProfiles.find((candidate) => candidate.id === profileLink?.modelProfileId);

      return { agentName: agent?.name, workflowName: workflow?.name, model: profile?.model };
    }
  },
  actions: {
    applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void {
      clearPendingClientStatePatch(streamId);
      this.streamSeqs[streamId] = streamSeq;
      if (!dbFor(this as unknown as ClientStateStoreState).applySnapshot(streamId, state)) return;
      this.ensureCurrentConversation();
    },
    applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean {
      const pending = pendingClientStatePatchBatches.get(streamId);
      const currentStreamSeq = pending?.streamSeq ?? this.streamSeqs[streamId] ?? 0;
      if (streamSeq !== currentStreamSeq + 1) return false;

      // 对话流的 patch 高频且通常包含大量流式文本/思考耗时增量。先转入 RAF 批处理，
      // 避免在 VS Code postMessage 回调内同步触发大规模 Pinia/Vue 响应式更新。
      if (conversationIdFromClientStateStreamId(streamId)) {
        const batch = pending ?? { streamId, streamSeq: currentStreamSeq, patches: [] };
        batch.streamSeq = streamSeq;
        batch.patches.push(...patches);
        pendingClientStatePatchBatches.set(streamId, batch);
        if (batch.frameId === undefined && batch.timerId === undefined) {
          // clientState 是全局索引/标题/状态概要，消息正文展示走 conversationTimeline。
          // 放到下一次绘制之后再应用，避免和可见 timeline flush 挤在同一个 RAF 长任务里。
          batch.frameId = window.requestAnimationFrame(() => {
            batch.frameId = undefined;
            batch.timerId = window.setTimeout(() => {
              batch.timerId = undefined;
              this.flushPendingClientStatePatch(streamId);
            }, 0);
          });
        }
        return true;
      }

      dbFor(this as unknown as ClientStateStoreState).applyPatches(compactClientPatchOps(patches));
      this.streamSeqs[streamId] = streamSeq;
      this.ensureCurrentConversation();
      return true;
    },
    applyCommittedConversationPatch(streamId: string, patches: ClientPatchOp[]): boolean {
      if (!conversationIdFromClientStateStreamId(streamId)) return false;
      // Commit patches and the high-frequency ClientSync stream have independent sequence heads.
      // Flush already-accepted transient deltas first so an older RAF batch cannot overwrite a
      // newly committed durable post-state.
      this.flushPendingClientStatePatch(streamId);
      dbFor(this as unknown as ClientStateStoreState).applyPatches(compactClientPatchOps(patches));
      this.ensureCurrentConversation();
      return true;
    },
    flushPendingClientStatePatch(streamId: string): void {
      const batch = pendingClientStatePatchBatches.get(streamId);
      if (!batch) return;
      pendingClientStatePatchBatches.delete(streamId);
      const currentStreamSeq = this.streamSeqs[streamId] ?? 0;
      if (batch.streamSeq <= currentStreamSeq) return;
      dbFor(this as unknown as ClientStateStoreState).applyPatches(compactClientPatchOps(batch.patches));
      this.streamSeqs[streamId] = batch.streamSeq;
      this.ensureCurrentConversation();
    },
    setCurrentConversation(conversationId: string): void {
      if (conversationId) this.currentConversationId = conversationId;
    },
    /** Hello 未提供 conversationId（"加载默认"入口）时，待快照到达后回落 default / 首个对话。 */
    ensureCurrentConversation(): void {
      if (this.currentConversationId) {
        const hasCurrent = this.conversations.some((conversation) => conversation.id === this.currentConversationId);
        if (hasCurrent) return;

        // 历史列表打开的对话通常不在 global stream 里，必须等待该 conversation stream
        // 完成加载后再判断是否失效；否则 global snapshot 会把显式目标回退成首个对话。
        const currentStreamId = conversationClientStateStreamId(this.currentConversationId);
        const currentStreamLoaded = (this.streamSeqs[currentStreamId] ?? 0) > 0;
        if (!currentStreamLoaded) return;
      }

      this.currentConversationId =
        this.conversations.find((conversation) => conversation.id === 'default')?.id ??
        this.conversations[0]?.id ??
        '';
    }
  }
});

/**
 * ClientState 表数量较多，直接导出 Pinia 对整个 options store 推导出的递归泛型，会让
 * vue-tsc 在每个消费组件中反复展开 ClientState/JsonValue，最终触发 TS2589。
 * 这里显式冻结 Webview 实际使用的公共表面；运行时仍是同一个 Pinia store。
 */
export interface ClientStateStorePublic extends ClientStateStoreState {
  $state: ClientStateStoreState;

  readonly currentConversationDetailLoaded: boolean;
  readonly settingsClientStateReady: boolean;
  readonly settingsClientStateLoading: boolean;
  readonly isConfigScopeClientStateLoading: (scopeKind?: string, scopeId?: string) => boolean;
  readonly currentConversation: ConversationRecord | undefined;
  readonly currentProjectContext: ProjectContextRecord | undefined;
  readonly currentWorkEnvironment: WorkEnvironmentRecord | undefined;
  readonly currentMessages: MessageRecord[];
  readonly currentCheckpoints: CheckpointRecord[];
  readonly currentCheckpointTimelineAnchors: CheckpointTimelineAnchorRecord[];
  readonly currentCompressionBlocks: CompressionBlockRecord[];
  readonly currentExecution: CurrentExecution | undefined;
  readonly currentActiveRuns: AgentRunRecord[];
  readonly currentQueuedTurnIntents: TurnIntentRecord[];
  readonly currentPendingInteractions: CurrentInteraction[];
  readonly currentPendingRuntimeDeliveries: RuntimeDeliveryLinkRecord[];
  readonly currentRunSummary: CurrentRunSummary;
  readonly currentModelSummary: CurrentModelSummary;

  applyClientSnapshot(streamId: string, streamSeq: number, state: ClientState): void;
  applyClientPatch(streamId: string, streamSeq: number, patches: ClientPatchOp[]): boolean;
  applyCommittedConversationPatch(streamId: string, patches: ClientPatchOp[]): boolean;
  flushPendingClientStatePatch(streamId: string): void;
  setCurrentConversation(conversationId: string): void;
  ensureCurrentConversation(): void;
}

export const useClientStateStore = useClientStateStoreDefinition as unknown as () => ClientStateStorePublic;

interface ExecutionLookupState {
  executionLeases: ExecutionLeaseRecord[];
  turns: TurnRecord[];
  agentRuns: AgentRunRecord[];
}

function executionForConversation(state: ExecutionLookupState, conversationId: string): CurrentExecution | undefined {
  if (!conversationId) return undefined;
  const leases = state.executionLeases.filter((lease) => lease.conversationId === conversationId && lease.state !== 'released');
  if (leases.length !== 1) return undefined;
  const lease = leases[0];
  const turn = state.turns.find((candidate) => candidate.id === lease.turnId && candidate.conversationId === conversationId);
  if (!turn || turn.lifecycle !== 'active' || turn.phase === 'terminal') return undefined;
  const run = state.agentRuns.find((candidate) => candidate.id === turn.id);
  return { lease, turn, ...(run ? { run } : {}) };
}

function pendingInteractionsForConversation(
  interactionRequests: readonly DurableInteractionRequestRecord[],
  interactionOwnerLinks: readonly InteractionOwnerLinkRecord[],
  conversationId: string
): CurrentInteraction[] {
  if (!conversationId) return [];
  const requestById = new Map(interactionRequests.map((request) => [request.id, request]));
  return interactionOwnerLinks
    .filter((owner) => owner.conversationId === conversationId)
    .flatMap((owner) => {
      const request = requestById.get(owner.interactionRequestId);
      return request?.state === 'pending' ? [{ request, owner }] : [];
    })
    .sort((left, right) => left.request.createdAt - right.request.createdAt || left.request.id.localeCompare(right.request.id));
}

function labelForTurn(turn: TurnRecord): string {
  switch (turn.phase) {
    case 'loading_context':
      return '加载上下文';
    case 'waiting_compression':
      return '等待压缩';
    case 'resolving_invocation':
    case 'waiting_checkpoint_before_llm':
    case 'llm_request_pending':
      return '准备中';
    case 'llm_streaming':
      return '执行中';
    case 'waiting_tools':
      return '等待工具';
    case 'waiting_child_run':
      return '等待子任务';
    case 'waiting_user':
      return '等待用户';
    case 'waiting_plan_review':
      return '等待 Plan 审批';
    case 'waiting_checkpoint_after_llm':
      return '保存检查点';
    case 'delivering':
      return '整理回复';
    case 'paused':
      return '已暂停';
    case 'terminal':
      return '空闲';
  }
}

function labelForRunStatus(status: AgentRunStatus): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'preparing':
      return '准备中';
    case 'running':
      return '执行中';
    case 'waiting_tool':
      return '等待工具';
    case 'waiting_child_run':
      return '等待子任务';
    case 'delivering':
      return '整理回复';
    case 'paused':
      return '已暂停';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已终止';
    case 'interrupted':
      return '已中断';
    case 'stale':
      return '已过期';
  }
}

function workEnvironmentSortKey(environment: WorkEnvironmentRecord): string {
  return buildWorkEnvironmentSortKey(environment);
}

function latestScopeLink<T extends { createdAt: number; updatedAt: number; id: string }>(links: T[]): T | undefined {
  return [...links].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
}

function isSettingsClientStateReady(state: {
  streamSeqs: Record<string, number>;
  workEnvironments: readonly unknown[];
  workEnvironmentPolicies: readonly unknown[];
  checkpointPolicies: readonly unknown[];
  shadowRepositories: readonly unknown[];
}): boolean {
  const streamSeq = state.streamSeqs[GLOBAL_CLIENT_STATE_STREAM_ID] ?? 0;
  if (streamSeq >= SETTINGS_READY_MIN_GLOBAL_STREAM_SEQ) return true;
  if (streamSeq <= 0) return false;
  // 如果设置面板是在后端 deferred skeleton 已加载后才打开，第一次 global snapshot 就可能已经包含完整配置数据。
  return state.workEnvironments.length > 0
    || state.workEnvironmentPolicies.length > 0
    || state.checkpointPolicies.length > 0
    || state.shadowRepositories.length > 0;
}


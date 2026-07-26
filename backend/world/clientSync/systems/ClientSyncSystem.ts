import {
  GLOBAL_CLIENT_STATE_STREAM_ID,
  conversationClientStateStreamId,
  conversationIdFromClientStateStreamId,
  isTextPart,
  type ClientPatchOp,
  type ClientState,
  type ClientStateTableKey,
  type MessageRecord,
  type ToolCallPreviewRecord,
  type ToolCallPreviewTargetLinkRecord
} from '../../../../shared/protocol';
import { clientStateWithTables, createEmptyClientState, GLOBAL_CLIENT_STATE_TABLE_KEYS } from '../../../../shared/clientStateSchema';
import { collectChangedClientStateConversationIds } from '../../../../shared/clientStateConversationScope';
import { defineSystem, type AccessDeclaration, type WorldEvent, type WorldReader } from '../../../ecs/types';
import { readEvents } from '../../events';
import { LlmRequest, Message } from '../../modules/chat/components';
import { ToolCallPreview, ToolCallPreviewTargetLink } from '../../modules/tools/components';
import type { ClientStateContributor } from '../contributors';
import { diffClientStateTables } from '../diff';
import { ClientSyncEventType } from '../events';
import { mergeFastPatchBatches } from '../fastPatchBatches';
import { ClientStateContributorsKey, ClientStateDirtyConversationIdsKey, ClientSyncFastPatchStateKey, ClientSyncStateKey, CommittedConversationHeadsKey, type ClientStreamState, type ClientSyncFastPatchState, type ClientSyncState } from '../resources';
import { projectClientStateWithCache } from '../projection';
import { contributorClock } from '../../projection/cache';
import type { TransientStreamEpoch } from '../../../../shared/conversationReliability';

const CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT = 240;
const FAST_PATCH_COMPONENTS = [Message, ToolCallPreview, ToolCallPreviewTargetLink] as const;

export const ClientSyncSystem = defineSystem({
  name: 'ClientSyncSystem',
  access(world) {
    const projectionReads = world.tryGetResource(ClientStateContributorsKey)?.reads() ?? emptyReads();
    return {
      reads: {
        ...projectionReads,
        components: [...(projectionReads.components ?? []), LlmRequest]
      },
      resources: {
        read: [ClientStateContributorsKey, ClientSyncStateKey, ClientSyncFastPatchStateKey, ClientStateDirtyConversationIdsKey, CommittedConversationHeadsKey],
        write: [ClientSyncStateKey, ClientSyncFastPatchStateKey],
        mutationMode: 'update'
      },
      events: { read: [ClientSyncEventType.Resync, ClientSyncEventType.StreamsReleased] },
      effects: { emit: ['client.snapshot', 'client.patch'] }
    };
  },
  shouldRun({ world, events }) {
    return shouldRunClientSync(world, events);
  },
  run(ctx) {
    const { world, cmd } = ctx;
    const registry = world.getResource(ClientStateContributorsKey);
    const storedSyncState = world.getResource(ClientSyncStateKey);
    const fastPatchState = world.getResource(ClientSyncFastPatchStateKey);
    const committedConversationHeads = world.getResource(CommittedConversationHeadsKey);
    const contributors = registry.list();
    const resyncRequests = readEvents(ctx, ClientSyncEventType.Resync);
    const requestedStreamIds = new Set(resyncRequests.map((request) =>
      request.streamId
      ?? (request.conversationId ? conversationClientStateStreamId(request.conversationId) : GLOBAL_CLIENT_STATE_STREAM_ID)
    ));
    const releasedStreamIds = new Set(
      readEvents(ctx, ClientSyncEventType.StreamsReleased).flatMap((payload) => payload.streamIds)
    );
    let syncState = releaseUnusedStreamStates(storedSyncState, releasedStreamIds, requestedStreamIds);
    const didReleaseStreamStates = syncState !== storedSyncState;
    const hasResyncRequests = resyncRequests.length > 0;
    const hasActiveLlmRequests = world.query(LlmRequest).length > 0;
    const shouldDeferFullSync = fastPatchState.deferFullSync && hasActiveLlmRequests;
    const hasOnlyFastPatchChanges = syncState.lastState !== null
      && hasOnlyFastPatchCompatibleChanges(world, contributors, syncState);
    // Apply epoch-tagged stream deltas to the local baseline before any required full projection.
    // A mixed full diff can then carry unrelated durable changes without smuggling an untagged
    // transient delta across a terminal fence.
    const canApplyFastPatches = fastPatchState.patches.length > 0
      && syncState.lastState !== null
      && !hasResyncRequests;
    const fastPatchesCoverAllMessageChanges = canApplyFastPatches
      && doFastPatchesCoverAllComponentChanges(world, syncState, fastPatchState);
    let didApplyFastPatches = false;
    if (canApplyFastPatches) {
      const fastPatchedState = emitFastPatches(world, cmd, syncState, fastPatchState);
      if (fastPatchedState) {
        syncState = fastPatchedState;
        didApplyFastPatches = true;
        if (shouldDeferFullSync && !fastPatchState.requireFullSync && hasOnlyFastPatchChanges && fastPatchesCoverAllMessageChanges) {
          cmd.setResource(ClientSyncStateKey, syncState);
          cmd.setResource(ClientSyncFastPatchStateKey, {
            patches: [],
            deferFullSync: fastPatchState.deferFullSync,
            requireFullSync: false
          });
          return;
        }
      }
    }

    if (shouldDeferFullSync
      && !fastPatchState.requireFullSync
      && !hasResyncRequests
      && fastPatchState.patches.length === 0
      && fastPatchedComponentVersionsAreCurrent(world, syncState)
      && hasOnlyFastPatchCompatibleChanges(world, contributors, syncState)) {
      if (didReleaseStreamStates) cmd.setResource(ClientSyncStateKey, syncState);
      return;
    }

    const projection = projectClientStateWithCache(world, contributors, syncState);
    const sourceChanged = syncState.lastState === null || projection.changed || fastPatchState.requireFullSync;
    const changedTableKeys = sourceChanged ? changedClientStateTableKeys(contributors, projection.changedContributorKeys) : [];
    const nextFull = projection.state;
    const prevFull = syncState.lastState;
    const changedConversationIds = sourceChanged && prevFull !== null
      ? collectChangedClientStateConversationIds(prevFull, nextFull, changedTableKeys)
      : undefined;
    const nextDirtyConversationResourceVersion = sourceChanged
      ? world.resourceVersion(ClientStateDirtyConversationIdsKey)
      : syncState.dirtyConversationResourceVersion;
    const requestedConversationIds = new Set<string>();
    let wantsGlobalSnapshot = prevFull === null;

    for (const request of resyncRequests) {
      const streamId = request.streamId;
      const conversationId = request.conversationId ?? (streamId ? conversationIdFromClientStateStreamId(streamId) : undefined);
      if (conversationId) {
        requestedConversationIds.add(conversationId);
        continue;
      }
      if (!streamId || streamId === GLOBAL_CLIENT_STATE_STREAM_ID) wantsGlobalSnapshot = true;
    }

    if (!sourceChanged && !hasResyncRequests) {
      if (didReleaseStreamStates || didApplyFastPatches) cmd.setResource(ClientSyncStateKey, syncState);
      clearFastPatchStateIfNeeded(cmd, fastPatchState);
      return;
    }

    const streams: Record<string, ClientStreamState> = { ...syncState.streams };
    let didUpdateStreams = false;

    const globalNext = globalClientState(nextFull);
    const globalExisting = streams[GLOBAL_CLIENT_STATE_STREAM_ID];
    if (wantsGlobalSnapshot) {
      streams[GLOBAL_CLIENT_STATE_STREAM_ID] = emitSnapshot(cmd, GLOBAL_CLIENT_STATE_STREAM_ID, globalExisting, globalNext);
      didUpdateStreams = true;
    } else if (globalExisting) {
      const updated = emitPatchIfChanged(cmd, contributors, GLOBAL_CLIENT_STATE_STREAM_ID, globalExisting, globalNext);
      if (updated) {
        streams[GLOBAL_CLIENT_STATE_STREAM_ID] = updated;
        didUpdateStreams = true;
      }
    }

    for (const conversationId of collectConversationIds(prevFull, nextFull, streams, requestedConversationIds, sourceChanged, changedTableKeys, changedConversationIds)) {
      const streamId = conversationClientStateStreamId(conversationId);
      const existing = streams[streamId];
      const requested = requestedConversationIds.has(conversationId);
      if (!requested && !existing) continue;
      const next = conversationClientState(nextFull, conversationId);
      if (requested || !existing?.lastState) {
        streams[streamId] = emitSnapshot(cmd, streamId, existing, next, committedConversationHeads[conversationId]);
        didUpdateStreams = true;
        continue;
      }
      const updated = emitPatchIfChanged(cmd, contributors, streamId, existing, next);
      if (updated) {
        streams[streamId] = updated;
        didUpdateStreams = true;
      }
    }

    if (sourceChanged || didUpdateStreams || didReleaseStreamStates) {
      cmd.setResource(ClientSyncStateKey, {
        lastState: nextFull,
        projectionClock: projection.projectionClock,
        contributorStates: projection.contributorStates,
        dirtyConversationResourceVersion: nextDirtyConversationResourceVersion,
        fastPatchedComponentVersions: currentFastPatchComponentVersions(world),
        streams
      });
    }
    clearFastPatchStateIfNeeded(cmd, fastPatchState);
  }
});

function emptyReads(): AccessDeclaration {
  return { components: [], resources: [], events: [], effects: [] };
}

function releaseUnusedStreamStates(
  state: ClientSyncState,
  releasedStreamIds: ReadonlySet<string>,
  requestedStreamIds: ReadonlySet<string>
): ClientSyncState {
  const removable = [...releasedStreamIds].filter((streamId) => streamId && !requestedStreamIds.has(streamId) && state.streams[streamId]);
  if (removable.length === 0) return state;

  const streams = { ...state.streams };
  for (const streamId of removable) delete streams[streamId];
  return { ...state, streams };
}

export function shouldRunClientSync(world: WorldReader, events: ReadonlyArray<WorldEvent>): boolean {
  if (events.some((event) => event.type === ClientSyncEventType.Resync || event.type === ClientSyncEventType.StreamsReleased)) return true;
  const registry = world.tryGetResource(ClientStateContributorsKey);
  const syncState = world.tryGetResource(ClientSyncStateKey);
  const fastPatchState = world.tryGetResource(ClientSyncFastPatchStateKey);
  if (!registry || !syncState || !fastPatchState || syncState.lastState === null) return true;
  if (fastPatchState.patches.length > 0 || fastPatchState.requireFullSync) return true;

  const contributors = registry.list();
  const hasActiveLlmRequests = world.query(LlmRequest).length > 0;
  if (fastPatchState.deferFullSync) {
    if (!hasActiveLlmRequests) return true;
    // Message clock 在快路径期间故意落后；只要其他 projection source 没变，就无需再跑一个空 pass。
    if (fastPatchedComponentVersionsAreCurrent(world, syncState)
      && hasOnlyFastPatchCompatibleChanges(world, contributors, syncState)) return false;
  }

  return contributors.some((contributor) =>
    syncState.contributorStates[contributor.key]?.clock !== contributorClock(world, contributor)
  );
}

function currentFastPatchComponentVersions(world: WorldReader): Readonly<Record<string, number>> {
  return Object.fromEntries(FAST_PATCH_COMPONENTS.map((component) => [component.name, world.componentVersion(component)]));
}

function fastPatchedComponentVersionsAreCurrent(world: WorldReader, syncState: ClientSyncState): boolean {
  const versions = syncState.fastPatchedComponentVersions;
  return !!versions && FAST_PATCH_COMPONENTS.every((component) => versions[component.name] === world.componentVersion(component));
}

function fastPatchComponentName(patch: ClientPatchOp): string | undefined {
  if (isMessageFastPatch(patch)) return Message.name;
  if (patch.kind === 'toolCallPreview.upsert' || patch.kind === 'toolCallPreview.remove') return ToolCallPreview.name;
  if (patch.kind === 'toolCallPreviewTargetLink.upsert' || patch.kind === 'toolCallPreviewTargetLink.remove') return ToolCallPreviewTargetLink.name;
  return undefined;
}

function fastPatchRecordId(patch: ClientPatchOp): string {
  if ('id' in patch && typeof patch.id === 'string') return patch.id;
  if (patch.kind === 'toolCallPreview.upsert') return patch.preview.id;
  if (patch.kind === 'toolCallPreviewTargetLink.upsert') return patch.link.id;
  return '';
}

function doFastPatchesCoverAllComponentChanges(
  world: WorldReader,
  syncState: ClientSyncState,
  fastPatchState: ClientSyncFastPatchState
): boolean {
  const baselineVersions = syncState.fastPatchedComponentVersions;
  if (!baselineVersions) return false;
  const changedIds = new Map<string, Set<string>>();
  for (const batch of fastPatchState.patches) {
    for (const patch of batch.patches) {
      const componentName = fastPatchComponentName(patch);
      if (!componentName) return false;
      const ids = changedIds.get(componentName) ?? new Set<string>();
      ids.add(fastPatchRecordId(patch));
      changedIds.set(componentName, ids);
    }
  }
  for (const component of FAST_PATCH_COMPONENTS) {
    const baselineVersion = baselineVersions[component.name];
    if (baselineVersion === undefined) return false;
    const changedVersions = world.componentVersion(component) - baselineVersion;
    if (changedVersions < 0 || changedVersions > (changedIds.get(component.name)?.size ?? 0)) return false;
  }
  return true;
}

/**
 * 流式快路径只能吞掉已显式登记的 Message 文本/思考增量与 ToolCallPreview 变化。
 * 任一其他 component/resource 同轮发生变化（例如另一对话新建消息、Run、Conversation）时，
 * 必须立即走 full projection，不能因为某个对话持续吐 token 而让其他对话饥饿。
 */
function hasOnlyFastPatchCompatibleChanges(
  world: WorldReader,
  contributors: readonly ClientStateContributor[],
  syncState: ClientSyncState
): boolean {
  const ignoredClockPrefixes = FAST_PATCH_COMPONENTS.map((component) => `c:${component.name}:`);
  for (const contributor of contributors) {
    const previousClock = syncState.contributorStates[contributor.key]?.clock;
    if (previousClock === undefined) return false;
    const nextClock = contributorClock(world, contributor);
    if (clockWithoutPrefixes(previousClock, ignoredClockPrefixes) !== clockWithoutPrefixes(nextClock, ignoredClockPrefixes)) return false;
  }
  return true;
}

function clockWithoutPrefixes(clock: string, prefixes: readonly string[]): string {
  return clock
    .split('|')
    .filter((part) => !prefixes.some((prefix) => part.startsWith(prefix)))
    .join('|');
}

function emitSnapshot(
  cmd: { effect(effect: unknown): void },
  streamId: string,
  current: ClientStreamState | undefined,
  state: ClientState,
  conversationHead?: import('../../../../shared/conversationReliability').CommittedConversationHead
): ClientStreamState {
  const stream = nextStreamSnapshot(current, state);
  cmd.effect({ kind: 'client.snapshot', streamId, streamSeq: stream.streamSeq, state, ...(conversationHead ? { conversationHead } : {}) });
  return stream;
}

function emitPatchIfChanged(
  cmd: { effect(effect: unknown): void },
  contributors: ClientStateContributor[],
  streamId: string,
  current: ClientStreamState,
  next: ClientState
): ClientStreamState | undefined {
  if (!current.lastState) return emitSnapshot(cmd, streamId, current, next);
  const patches = diffClientState(contributors, current.lastState, next);
  if (patches.length === 0) return undefined;
  const stream: ClientStreamState = { streamSeq: current.streamSeq + 1, lastState: next };
  cmd.effect({ kind: 'client.patch', streamId, streamSeq: stream.streamSeq, patches });
  return stream;
}

function emitFastPatches(
  world: WorldReader,
  cmd: { effect(effect: unknown): void },
  syncState: ClientSyncState,
  fastPatchState: ClientSyncFastPatchState
): ClientSyncState | undefined {
  if (!syncState.lastState) return undefined;
  const batches = mergeFastPatchBatches(fastPatchState.patches);
  const allPatches = batches.flatMap((batch) => batch.patches);
  const nextFull = applyFastPatches(syncState.lastState, allPatches);
  if (!nextFull) return undefined;

  const streams: Record<string, ClientStreamState> = { ...syncState.streams };
  const emitted: Array<{
    streamId: string;
    streamSeq: number;
    patches: readonly ClientPatchOp[];
    transientStreamEpoch?: TransientStreamEpoch;
  }> = [];

  for (const batch of batches) {
    const existing = streams[batch.streamId];
    if (!existing) continue;
    if (!existing.lastState) return undefined;
    const nextStreamState = applyFastPatches(existing.lastState, batch.patches);
    if (!nextStreamState) return undefined;
    const stream: ClientStreamState = { streamSeq: existing.streamSeq + 1, lastState: nextStreamState };
    streams[batch.streamId] = stream;
    emitted.push({
      streamId: batch.streamId,
      streamSeq: stream.streamSeq,
      patches: batch.patches,
      ...(batch.transientStreamEpoch ? { transientStreamEpoch: batch.transientStreamEpoch } : {})
    });
  }

  for (const item of emitted) {
    cmd.effect({
      kind: 'client.patch',
      streamId: item.streamId,
      streamSeq: item.streamSeq,
      patches: item.patches,
      ...(item.transientStreamEpoch ? { transientStreamEpoch: item.transientStreamEpoch } : {})
    });
  }
  return {
    lastState: nextFull,
    projectionClock: syncState.projectionClock,
    contributorStates: syncState.contributorStates,
    dirtyConversationResourceVersion: syncState.dirtyConversationResourceVersion,
    fastPatchedComponentVersions: currentFastPatchComponentVersions(world),
    streams
  };
}

function applyFastPatches(state: ClientState, patches: readonly ClientPatchOp[]): ClientState | undefined {
  let nextMessages: MessageRecord[] | undefined;
  let nextPreviews: ToolCallPreviewRecord[] | undefined;
  let nextPreviewLinks: ToolCallPreviewTargetLinkRecord[] | undefined;
  const messageIndexById = new Map(state.messages.map((message, index) => [message.id, index]));

  for (const patch of patches) {
    if (isMessageFastPatch(patch)) {
      const index = messageIndexById.get(patch.id);
      if (index === undefined) return undefined;
      const messages = nextMessages ?? state.messages;
      const message = messages[index];
      if (!message) return undefined;
      const nextMessage = applyMessageFastPatch(message, patch);
      if (!nextMessage) return undefined;
      nextMessages ??= [...state.messages];
      nextMessages[index] = nextMessage;
      continue;
    }

    if (patch.kind === 'toolCallPreview.upsert') {
      nextPreviews = upsertFastPatchRecord(nextPreviews ?? state.toolCallPreviews, patch.preview);
      continue;
    }
    if (patch.kind === 'toolCallPreview.remove') {
      nextPreviews = removeFastPatchRecord(nextPreviews ?? state.toolCallPreviews, patch.id);
      continue;
    }
    if (patch.kind === 'toolCallPreviewTargetLink.upsert') {
      nextPreviewLinks = upsertFastPatchRecord(nextPreviewLinks ?? state.toolCallPreviewTargetLinks, patch.link);
      continue;
    }
    if (patch.kind === 'toolCallPreviewTargetLink.remove') {
      nextPreviewLinks = removeFastPatchRecord(nextPreviewLinks ?? state.toolCallPreviewTargetLinks, patch.id);
      continue;
    }
    return undefined;
  }

  return nextMessages || nextPreviews || nextPreviewLinks
    ? {
        ...state,
        ...(nextMessages ? { messages: nextMessages } : {}),
        ...(nextPreviews ? { toolCallPreviews: nextPreviews } : {}),
        ...(nextPreviewLinks ? { toolCallPreviewTargetLinks: nextPreviewLinks } : {})
      }
    : state;
}

function upsertFastPatchRecord<T extends { id: string }>(records: readonly T[], record: T): T[] {
  const index = records.findIndex((candidate) => candidate.id === record.id);
  if (index < 0) return [...records, clonePatchValue(record)];
  const next = [...records];
  next[index] = clonePatchValue(record);
  return next;
}

function removeFastPatchRecord<T extends { id: string }>(records: readonly T[], id: string): T[] {
  return records.filter((record) => record.id !== id);
}

type MessageFastPatch = Extract<ClientPatchOp, { kind: 'message.partText.append' | 'message.partThoughtElapsed.set' | 'message.part.insert' }>;

function isMessageFastPatch(patch: ClientPatchOp): patch is MessageFastPatch {
  return patch.kind === 'message.partText.append' || patch.kind === 'message.partThoughtElapsed.set' || patch.kind === 'message.part.insert';
}

function applyMessageFastPatch(message: MessageRecord, patch: MessageFastPatch): MessageRecord | undefined {
  const parts = message.content.parts;
  if (patch.kind === 'message.partText.append') {
    const part = parts[patch.partIndex];
    if (!part || !isTextPart(part)) return undefined;
    const nextParts = [...parts];
    nextParts[patch.partIndex] = { ...part, text: part.text + patch.delta };
    return { ...message, content: { ...message.content, parts: nextParts } };
  }

  if (patch.kind === 'message.partThoughtElapsed.set') {
    const part = parts[patch.partIndex];
    if (!part || !isTextPart(part)) return undefined;
    const nextParts = [...parts];
    nextParts[patch.partIndex] = { ...part, thoughtElapsedMs: patch.elapsedMs };
    return { ...message, content: { ...message.content, parts: nextParts } };
  }

  if (patch.index < 0 || patch.index > parts.length) return undefined;
  const nextParts = [...parts];
  nextParts.splice(patch.index, 0, clonePatchValue(patch.part));
  return { ...message, content: { ...message.content, parts: nextParts } };
}

function clonePatchValue<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function clearFastPatchStateIfNeeded(cmd: { setResource<T>(key: { readonly id: symbol; readonly name: string; readonly __t?: T }, value: T): void }, state: ClientSyncFastPatchState): void {
  if (state.patches.length === 0 && !state.deferFullSync && !state.requireFullSync) return;
  cmd.setResource(ClientSyncFastPatchStateKey, { patches: [], deferFullSync: false, requireFullSync: false });
}

function diffClientState(contributors: ClientStateContributor[], prev: ClientState, next: ClientState): ClientPatchOp[] {
  const patches: ClientPatchOp[] = [];
  for (const contributor of contributors) {
    patches.push(...diffClientStateTables(prev, next, contributor.tables ?? []));
    patches.push(...(contributor.diff?.(prev, next) ?? []));
  }
  return patches;
}

function globalClientState(state: ClientState): ClientState {
  return clientStateWithTables(state, GLOBAL_CLIENT_STATE_TABLE_KEYS);
}

function conversationClientState(state: ClientState, conversationId: string): ClientState {
  const messages = recentConversationStreamMessages(state.messages.filter((message) => message.conversationId === conversationId));
  const messageIds = new Set(messages.map((message) => message.id));
  const messageToolCalls = state.toolCalls.filter((toolCall) => messageIds.has(toolCall.messageId));
  const messageToolCallIds = new Set(messageToolCalls.map((toolCall) => toolCall.id));
  const runIds = collectConversationRunIds(state, conversationId, messageIds, messageToolCallIds);
  const turns = state.turns.filter((turn) => turn.conversationId === conversationId);
  for (const turn of turns) runIds.add(turn.id);
  const runPlanProposalLinks = state.runPlanProposalLinks.filter((link) => runIds.has(link.runId));
  const planProposalIds = new Set(runPlanProposalLinks.map((link) => link.planProposalId));
  const turnIntents = state.turnIntents.filter((intent) => intent.conversationId === conversationId);
  const turnIntentIds = new Set(turnIntents.map((intent) => intent.id));
  const interactionOwnerLinks = state.interactionOwnerLinks.filter((link) => link.conversationId === conversationId);
  const interactionRequestIds = new Set(interactionOwnerLinks.map((link) => link.interactionRequestId));
  const toolCallIds = new Set(messageToolCallIds);
  for (const owner of interactionOwnerLinks) if (owner.sourceToolCallId) toolCallIds.add(owner.sourceToolCallId);
  // 父对话的 Agent 面板需要解释关联子 Run 的 waiting_tool；仅补入这些 Run 当前仍活跃的工具详情。
  for (const toolCallId of collectRunDetailToolCallIds(state, runIds)) toolCallIds.add(toolCallId);
  const toolCalls = state.toolCalls.filter((toolCall) => toolCallIds.has(toolCall.id));
  const toolCallResultLinks = state.toolCallResultLinks.filter((link) => toolCallIds.has(link.toolCallId));
  const toolResultArtifactIds = new Set(toolCallResultLinks.map((link) => link.artifactId));
  const toolCallPreviewState = conversationToolCallPreviewState(state, conversationId);
  const runPolicyIds = collectRunPolicyIds(state, runIds);
  const conversationProjectLinks = state.conversationProjectLinks.filter((link) => link.conversationId === conversationId);
  const projectContextIds = new Set(conversationProjectLinks.map((link) => link.projectContextId));
  const conversationWorkflowSelections = state.conversationWorkflowSelections.filter((selection) => selection.conversationId === conversationId);
  const checkpointTimelineAnchors = state.checkpointTimelineAnchors.filter((anchor) => anchor.conversationId === conversationId && messageIds.has(anchor.floorMessageId));
  const checkpointIds = new Set(checkpointTimelineAnchors.map((anchor) => anchor.checkpointId));
  const checkpoints = state.checkpoints.filter((checkpoint) => checkpointIds.has(checkpoint.id));
  for (const checkpoint of checkpoints) {
    checkpointIds.add(checkpoint.id);
    projectContextIds.add(checkpoint.projectContextId);
  }
  const shadowRepositoryIds = new Set(checkpoints.map((checkpoint) => checkpoint.shadowRepositoryId));
  const conversationCheckpointRepositoryLinks = state.conversationCheckpointRepositoryLinks.filter((link) => {
    const matches = shadowRepositoryIds.has(link.shadowRepositoryId) || projectContextIds.has(link.projectContextId);
    if (matches) {
      shadowRepositoryIds.add(link.shadowRepositoryId);
      projectContextIds.add(link.projectContextId);
    }
    return matches;
  });
  const compressionBlocks = state.compressionBlocks.filter((block) => block.conversationId === conversationId && compressionBlockInMessageWindow(block, messages));
  const compressionBlockIds = new Set(compressionBlocks.map((block) => block.id));
  const modelContextProjections = state.modelContextProjections.filter((projection) => projection.conversationId === conversationId);
  const modelContextProjectionIds = new Set(modelContextProjections.map((projection) => projection.id));
  const modelContextProjectionSourceLinks = state.modelContextProjectionSourceLinks.filter((link) =>
    link.conversationId === conversationId && modelContextProjectionIds.has(link.projectionId)
  );
  const requestModelContextProjectionLinks = state.requestModelContextProjectionLinks.filter((link) => modelContextProjectionIds.has(link.projectionId));
  const compressionModelContextProjectionLinks = state.compressionModelContextProjectionLinks.filter((link) =>
    compressionBlockIds.has(link.blockId) && modelContextProjectionIds.has(link.projectionId)
  );
  const compressionVariantIds = new Set(state.runCompressionBlockLinks.filter((link) => compressionBlockIds.has(link.blockId)).map((link) => link.variantId).filter((id): id is string => !!id));
  const compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId));
  const invocationIds = new Set(compressionBlockLlmInvocationLinks.map((link) => link.invocationId));
  for (const link of state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId))) invocationIds.add(link.invocationId);
  for (const link of state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId))) invocationIds.add(link.invocationId);
  const conversationRuntimeContextSnapshotLinks = state.conversationRuntimeContextSnapshotLinks.filter((link) => link.conversationId === conversationId);
  const runRuntimeContextSnapshotLinks = state.runRuntimeContextSnapshotLinks.filter((link) => runIds.has(link.runId));
  const conversationWorkEnvironmentLinks = state.conversationWorkEnvironmentLinks.filter((link) => link.conversationId === conversationId);
  const runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => runIds.has(link.runId));
  const runtimeContextSnapshotIds = new Set<string>();
  for (const link of conversationRuntimeContextSnapshotLinks) runtimeContextSnapshotIds.add(link.runtimeContextSnapshotId);
  for (const link of runRuntimeContextSnapshotLinks) runtimeContextSnapshotIds.add(link.runtimeContextSnapshotId);

  return {
    ...createEmptyClientState(),
    conversations: state.conversations.filter((conversation) => conversation.id === conversationId || conversationReferencedByRuns(state, conversation.id, runIds)),
    conversationReuseLinks: state.conversationReuseLinks.filter((link) => link.conversationId === conversationId),
    conversationBranchLinks: state.conversationBranchLinks.filter((link) => link.sourceConversationId === conversationId || link.targetConversationId === conversationId),
    conversationOriginLinks: state.conversationOriginLinks.filter((link) => link.conversationId === conversationId),
    projectContexts: state.projectContexts.filter((projectContext) => projectContextIds.has(projectContext.id)),
    conversationProjectLinks,
    shadowRepositories: state.shadowRepositories.filter((repository) => shadowRepositoryIds.has(repository.id)),
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors,
    conversationWorkflowSelections,
    planProposals: state.planProposals.filter((proposal) => planProposalIds.has(proposal.id)),
    runPlanProposalLinks,
    turns,
    turnIntents,
    turnIntentRevisions: state.turnIntentRevisions.filter((revision) => turnIntentIds.has(revision.turnIntentId)),
    pendingTurnInputs: state.pendingTurnInputs.filter((input) => input.conversationId === conversationId),
    executionLeases: state.executionLeases.filter((lease) => lease.conversationId === conversationId),
    authoritySnapshots: state.authoritySnapshots.filter((snapshot) => snapshot.conversationId === conversationId),
    interactionRequests: state.interactionRequests.filter((request) => interactionRequestIds.has(request.id)),
    interactionOwnerLinks,
    interactionResponses: state.interactionResponses.filter((response) => interactionRequestIds.has(response.interactionRequestId)),
    runtimeDeliveryLinks: state.runtimeDeliveryLinks.filter((link) => link.destinationConversationId === conversationId),
    messages,
    messageRevisions: state.messageRevisions.filter((revision) => messageIds.has(revision.messageId)),
    messageCurrentRevisionLinks: state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId)),
    modelContextProjections,
    modelContextProjectionSourceLinks,
    requestModelContextProjectionLinks,
    compressionModelContextProjectionLinks,
    compressionBlocks,
    compressionBlockSourceLinks: state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId)),
    compressionContextVariants: state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId) || compressionVariantIds.has(variant.id)),
    runCompressionBlockLinks: state.runCompressionBlockLinks.filter((link) => runIds.has(link.runId) || compressionBlockIds.has(link.blockId)),
    compressionBlockLlmInvocationLinks,
    llmInvocations: state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id)),
    runLlmInvocationLinks: state.runLlmInvocationLinks.filter((link) => runIds.has(link.runId) || invocationIds.has(link.invocationId)),
    messageLlmInvocationLinks: state.messageLlmInvocationLinks.filter((link) => messageIds.has(link.messageId) || invocationIds.has(link.invocationId)),
    toolCalls,
    toolCallPreviews: toolCallPreviewState.previews,
    toolCallPreviewTargetLinks: toolCallPreviewState.links,
    toolCallEvents: state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId)),
    toolCallResultLinks,
    toolResultArtifacts: state.toolResultArtifacts.filter((artifact) => toolResultArtifactIds.has(artifact.id)),
    agentRuns: state.agentRuns.filter((run) => runIds.has(run.id)),
    runTerminations: state.runTerminations.filter((termination) => runIds.has(termination.runId)),
    agentRunSourceLinks: state.agentRunSourceLinks.filter((link) => runIds.has(link.runId) || (link.sourceRunId !== undefined && runIds.has(link.sourceRunId))),
    agentRunTargetLinks: state.agentRunTargetLinks.filter((link) => runIds.has(link.runId)),
    messageTurnLinks: state.messageTurnLinks.filter((link) => runIds.has(link.turnId) || messageIds.has(link.messageId)),
    toolCallRunLinks: state.toolCallRunLinks.filter((link) => toolCallIds.has(link.toolCallId)),
    runConversationPolicies: state.runConversationPolicies.filter((policy) => runPolicyIds.conversationPolicyIds.has(policy.id)),
    runContextPolicies: state.runContextPolicies.filter((policy) => runPolicyIds.contextPolicyIds.has(policy.id)),
    runDeliveryPolicies: state.runDeliveryPolicies.filter((policy) => runPolicyIds.deliveryPolicyIds.has(policy.id)),
    runEditPolicies: state.runEditPolicies.filter((policy) => runPolicyIds.editPolicyIds.has(policy.id)),
    runWorkflowLinks: state.runWorkflowLinks.filter((link) => runIds.has(link.runId)),
    runSystemPromptLinks: state.runSystemPromptLinks.filter((link) => runIds.has(link.runId)),
    runModelProfileLinks: state.runModelProfileLinks.filter((link) => runIds.has(link.runId)),
    runToolPolicyLinks: state.runToolPolicyLinks.filter((link) => runIds.has(link.runId)),
    runConversationPolicyLinks: state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)),
    runContextPolicyLinks: state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)),
    runDeliveryPolicyLinks: state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)),
    runEditPolicyLinks: state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)),
    agentRunInputRevisions: state.agentRunInputRevisions.filter((inputRevision) => runIds.has(inputRevision.runId)),
    runtimeContextSnapshots: state.runtimeContextSnapshots.filter((snapshot) => snapshot.conversationId === conversationId || runtimeContextSnapshotIds.has(snapshot.id)),
    conversationRuntimeContextSnapshotLinks,
    runRuntimeContextSnapshotLinks,
    conversationWorkEnvironmentLinks,
    runWorkEnvironmentLinks,
  };
}

function conversationToolCallPreviewState(
  state: ClientState,
  conversationId: string
): { previews: ToolCallPreviewRecord[]; links: ToolCallPreviewTargetLinkRecord[] } {
  const previewsById = new Map(state.toolCallPreviews.map((preview) => [preview.id, preview]));
  const links = state.toolCallPreviewTargetLinks.filter((link) =>
    link.conversationId === conversationId && previewsById.has(link.previewId)
  );
  const previewIds = new Set(links.map((link) => link.previewId));
  return {
    previews: state.toolCallPreviews.filter((preview) => previewIds.has(preview.id)),
    links
  };
}

function recentConversationStreamMessages(messages: MessageRecord[]): MessageRecord[] {
  const ordered = [...messages].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  return ordered.length <= CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT
    ? ordered
    : ordered.slice(-CONVERSATION_STREAM_RECENT_MESSAGE_LIMIT);
}

function compressionBlockInMessageWindow(block: { anchorSeq?: number; endSeq?: number }, messages: readonly MessageRecord[]): boolean {
  const seq = block.anchorSeq ?? block.endSeq;
  if (seq === undefined) return false;
  const firstSeq = messages[0]?.seq;
  const lastSeq = messages[messages.length - 1]?.seq;
  return firstSeq !== undefined && lastSeq !== undefined && seq >= firstSeq && seq <= lastSeq;
}

function collectRunDetailToolCallIds(state: ClientState, runIds: ReadonlySet<string>): Set<string> {
  const toolCallsById = new Map(state.toolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const linkedIdsByRun = new Map<string, Set<string>>();
  for (const link of state.toolCallRunLinks) {
    if (!runIds.has(link.runId)) continue;
    const ids = linkedIdsByRun.get(link.runId) ?? new Set<string>();
    ids.add(link.toolCallId);
    linkedIdsByRun.set(link.runId, ids);
  }

  const visibleIds = new Set<string>();
  for (const runId of runIds) {
    const calls = [...(linkedIdsByRun.get(runId) ?? [])]
      .map((id) => toolCallsById.get(id))
      .filter((call): call is NonNullable<typeof call> => !!call);
    const activeCalls = calls.filter((call) => call.status !== 'success' && call.status !== 'warning' && call.status !== 'error');
    if (activeCalls.length > 0) {
      for (const call of activeCalls) visibleIds.add(call.id);
      continue;
    }
    const run = state.agentRuns.find((candidate) => candidate.id === runId);
    if (run?.status !== 'waiting_tool') continue;
    const latest = [...calls].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
    if (latest) visibleIds.add(latest.id);
  }
  return visibleIds;
}

function collectConversationRunIds(state: ClientState, conversationId: string, messageIds: ReadonlySet<string>, toolCallIds: ReadonlySet<string>): Set<string> {
  const runIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const add = (id: string | undefined): void => {
      if (!id || runIds.has(id)) return;
      runIds.add(id);
      changed = true;
    };
    for (const link of state.agentRunTargetLinks) if (link.conversationId === conversationId || runIds.has(link.runId)) add(link.runId);
    for (const link of state.agentRunSourceLinks) {
      if (link.sourceConversationId === conversationId || (link.sourceMessageId && messageIds.has(link.sourceMessageId)) || (link.sourceToolCallId && toolCallIds.has(link.sourceToolCallId)) || (link.sourceRunId && runIds.has(link.sourceRunId)) || runIds.has(link.runId)) {
        add(link.runId);
      }
    }
    for (const link of state.messageTurnLinks) if (messageIds.has(link.messageId) || runIds.has(link.turnId)) add(link.turnId);
    for (const link of state.toolCallRunLinks) if (toolCallIds.has(link.toolCallId) || runIds.has(link.runId)) add(link.runId);
  }
  return runIds;
}

function collectRunPolicyIds(state: ClientState, runIds: ReadonlySet<string>): {
  conversationPolicyIds: Set<string>;
  contextPolicyIds: Set<string>;
  deliveryPolicyIds: Set<string>;
  editPolicyIds: Set<string>;
} {
  return {
    conversationPolicyIds: new Set(state.runConversationPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    contextPolicyIds: new Set(state.runContextPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    deliveryPolicyIds: new Set(state.runDeliveryPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId)),
    editPolicyIds: new Set(state.runEditPolicyLinks.filter((link) => runIds.has(link.runId)).map((link) => link.policyId))
  };
}

function conversationReferencedByRuns(state: ClientState, conversationId: string, runIds: ReadonlySet<string>): boolean {
  return state.agentRunTargetLinks.some((link) => runIds.has(link.runId) && link.conversationId === conversationId)
    || state.agentRunSourceLinks.some((link) => runIds.has(link.runId) && link.sourceConversationId === conversationId);
}

function nextStreamSnapshot(current: ClientStreamState | undefined, state: ClientState): ClientStreamState {
  return { streamSeq: (current?.streamSeq ?? 0) + 1, lastState: state };
}

function collectConversationIds(
  prev: ClientState | null,
  next: ClientState,
  streams: Record<string, ClientStreamState>,
  requested: ReadonlySet<string>,
  sourceChanged: boolean,
  changedTableKeys: readonly ClientStateTableKey[] | undefined,
  changedConversationIds: ReadonlySet<string> | undefined
): string[] {
  const ids = new Set<string>(requested);
  if (prev === null) {
    for (const conversation of next.conversations) ids.add(conversation.id);
    for (const streamId of Object.keys(streams)) {
      const conversationId = conversationIdFromClientStateStreamId(streamId);
      if (conversationId) ids.add(conversationId);
    }
    return [...ids];
  }

  if (sourceChanged) {
    for (const conversationId of changedConversationIds ?? collectChangedClientStateConversationIds(prev, next, changedTableKeys)) {
      ids.add(conversationId);
    }
  }

  const subscribedConversationIds = new Set<string>();
  for (const streamId of Object.keys(streams)) {
    const conversationId = conversationIdFromClientStateStreamId(streamId);
    if (conversationId) subscribedConversationIds.add(conversationId);
  }
  return [...ids].filter((conversationId) => requested.has(conversationId) || subscribedConversationIds.has(conversationId));
}

function changedClientStateTableKeys(contributors: readonly ClientStateContributor[], changedContributorKeys: readonly string[]): readonly ClientStateTableKey[] | undefined {
  if (changedContributorKeys.length === 0) return undefined;
  const byKey = new Map(contributors.map((contributor) => [contributor.key, contributor]));
  const tableKeys = new Set<ClientStateTableKey>();
  for (const key of changedContributorKeys) {
    const tables = byKey.get(key)?.tables;
    if (!tables || tables.length === 0) return undefined;
    for (const tableKey of tables) tableKeys.add(tableKey);
  }
  return [...tableKeys];
}

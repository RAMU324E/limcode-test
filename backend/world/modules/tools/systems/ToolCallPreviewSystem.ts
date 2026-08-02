import { defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { LlmRequest, Message, Conversation } from '../../chat/components';
import {
  LlmEventType,
  type LlmRetryPayload,
  type LlmStreamEpochPayload,
  type LlmToolCallDeltaPayload,
  type LlmToolCallPreviewDonePayload
} from '../../llm/events';
import { ToolCallPreviewBundle } from '../bundles';
import {
  ToolCallPreview,
  ToolCallPreviewTargetLink,
  type ToolCallPreviewData,
  type ToolCallPreviewTargetLinkData
} from '../components';
import {
  conversationClientStateStreamId,
  type ClientPatchOp,
  type ToolCallPreviewRecord,
  type ToolCallPreviewTargetLinkRecord
} from '../../../../../shared/protocol';
import { ClientSyncFastPatchStateKey, type ClientSyncFastPatchBatch } from '../../../clientSync/resources';
import type { TransientStreamEpoch } from '../../../../../shared/conversationReliability';
import type { AttemptId, RequestId } from '../../../../../shared/stableIds';
import { appendToolCallPreviewArguments } from '../../../../../shared/toolCallPreview';

interface WorkingPreview {
  previewEntity: Entity;
  linkEntity: Entity;
  preview: ToolCallPreviewData;
  link: ToolCallPreviewTargetLinkData;
  created: boolean;
  epoch?: LlmStreamEpochPayload;
}

interface PreviewRemoval {
  previewEntity: Entity;
  linkEntities: Entity[];
  previewId: string;
  linkIds: string[];
  requestId: string;
  conversationId: string;
  epoch?: LlmStreamEpochPayload;
  restart?: WorkingPreview;
}

export const ToolCallPreviewSystem = defineSystem({
  name: 'ToolCallPreviewSystem',
  shouldRun({ world, events }) {
    return events.some((event) =>
      event.type === LlmEventType.ToolCallDelta
      || event.type === LlmEventType.ToolCallPreviewDone
      || event.type === LlmEventType.RetryStarted
    ) || world.query(ToolCallPreviewTargetLink).some((entity) => {
      const link = world.get(entity, ToolCallPreviewTargetLink);
      return !!link && !world.has(link.request, LlmRequest);
    });
  },
  access: {
    reads: { components: [LlmRequest, Message, Conversation] },
    writes: {
      components: [ToolCallPreview, ToolCallPreviewTargetLink],
      mutationMode: 'update'
    },
    resources: {
      read: [ClientSyncFastPatchStateKey],
      write: [ClientSyncFastPatchStateKey],
      mutationMode: 'update'
    },
    events: { read: [LlmEventType.ToolCallDelta, LlmEventType.ToolCallPreviewDone, LlmEventType.RetryStarted] },
    bundles: [ToolCallPreviewBundle]
  },
  run({ world, cmd, events }) {
    const working = new Map<string, WorkingPreview>();
    const removals = new Map<string, PreviewRemoval>();

    for (const event of events) {
      if (event.type === LlmEventType.ToolCallDelta) {
        const payload = event.payload as LlmToolCallDeltaPayload;
        const target = previewTargetForRequest(world, payload);
        if (!target) continue;
        for (const delta of payload.calls) {
          const key = previewKey(payload.requestId, delta.id);
          let current = working.get(key);
          if (!current) {
            const pendingRemoval = removals.get(key);
            current = pendingRemoval?.restart
              ? restartPreview(pendingRemoval.restart, target, delta.id, delta.name, delta.streamIndex)
              : existingOrNewPreview(world, cmd, target, delta.id, delta.name, delta.streamIndex);
            if (pendingRemoval) removals.delete(key);
            working.set(key, current);
          }
          current.epoch = payload;
          current.preview = appendPreviewArguments(current.preview, delta.argumentsDelta, delta.replace === true, delta.name, delta.streamIndex);
        }
        continue;
      }

      if (event.type === LlmEventType.RetryStarted) {
        const payload = event.payload as LlmRetryPayload;
        if (!admitsRetryBoundary(world, payload)) continue;
        const cleanupPayload: LlmToolCallPreviewDonePayload = { ...payload, all: true };
        for (const removal of previewRemovals(world, cleanupPayload, true)) {
          removals.set(removal.previewId, { ...removal, epoch: payload });
          working.delete(removal.previewId);
        }
        for (const [key, current] of working) {
          if (current.link.requestId !== payload.requestId) continue;
          removals.set(current.preview.id, {
            previewEntity: current.previewEntity,
            linkEntities: [current.linkEntity],
            previewId: current.preview.id,
            linkIds: [current.link.id],
            requestId: current.link.requestId,
            conversationId: current.link.conversationId,
            epoch: payload,
            restart: current
          });
          working.delete(key);
        }
        continue;
      }

      if (event.type !== LlmEventType.ToolCallPreviewDone) continue;
      const payload = event.payload as LlmToolCallPreviewDonePayload;
      const allowedCallIds = payload.all ? undefined : new Set(payload.callIds ?? []);
      for (const [key, current] of working) {
        if (current.link.requestId !== payload.requestId || (allowedCallIds && !allowedCallIds.has(current.preview.callId))) continue;
        removals.set(current.preview.id, {
          previewEntity: current.previewEntity,
          linkEntities: [current.linkEntity],
          previewId: current.preview.id,
          linkIds: [current.link.id],
          requestId: current.link.requestId,
          conversationId: current.link.conversationId,
          epoch: payload,
          restart: current
        });
        working.delete(key);
      }
      for (const removal of previewRemovals(world, payload)) {
        removals.set(removal.previewId, { ...removal, epoch: payload });
        working.delete(removal.previewId);
      }
    }

    for (const removal of orphanPreviewRemovals(world)) removals.set(removal.previewId, removal);

    const fastBatches: ClientSyncFastPatchBatch[] = [];
    for (const current of working.values()) {
      cmd.add(current.previewEntity, ToolCallPreview, current.preview);
      cmd.add(current.linkEntity, ToolCallPreviewTargetLink, current.link);
      fastBatches.push({
        streamId: conversationClientStateStreamId(conversationIdForLink(world, current.link)),
        patches: [
          { kind: 'toolCallPreview.upsert', preview: toPreviewRecord(current.preview) },
          ...(current.created
            ? [{ kind: 'toolCallPreviewTargetLink.upsert', link: toPreviewTargetLinkRecord(world, current.link, current.preview.id) } as ClientPatchOp]
            : [])
        ],
        ...(reliableEpoch(current.epoch) ? { transientStreamEpoch: reliableEpoch(current.epoch)! } : {})
      });
    }

    for (const removal of removals.values()) {
      for (const linkEntity of removal.linkEntities) cmd.despawn(linkEntity);
      cmd.despawn(removal.previewEntity);
      fastBatches.push({
        streamId: conversationClientStateStreamId(removal.conversationId),
        patches: [
          ...removal.linkIds.map((id): ClientPatchOp => ({ kind: 'toolCallPreviewTargetLink.remove', id })),
          { kind: 'toolCallPreview.remove', id: removal.previewId }
        ],
        ...(reliableEpoch(removal.epoch) ? { transientStreamEpoch: reliableEpoch(removal.epoch)! } : {})
      });
    }

    if (fastBatches.length > 0) appendFastPatchBatches(world, cmd, fastBatches);
  }
});

interface PreviewTarget {
  request: Entity;
  requestId: string;
  message: Entity;
  messageId: string;
  conversation: Entity;
  conversationId: string;
  epoch?: LlmStreamEpochPayload;
}

function previewTargetForRequest(world: WorldReader, payload: LlmToolCallDeltaPayload): PreviewTarget | undefined {
  const request = world.entityByRecordId(LlmRequest, payload.requestId);
  if (request === undefined) return undefined;
  const requestData = world.get(request, LlmRequest);
  if (!requestData || !admitsPreviewEpoch(requestData.reliableStreamEpoch, payload)) return undefined;
  const message = world.get(requestData.modelMessage, Message);
  const conversation = world.get(requestData.conversation, Conversation);
  if (!message || !conversation) return undefined;
  return {
    request,
    requestId: requestData.id,
    message: requestData.modelMessage,
    messageId: message.id,
    conversation: requestData.conversation,
    conversationId: conversation.id,
    epoch: payload
  };
}

function existingOrNewPreview(
  world: WorldReader,
  cmd: CommandSink,
  target: PreviewTarget,
  callId: string,
  name?: string,
  streamIndex?: string
): WorkingPreview {
  const id = toolCallPreviewId(target.requestId, callId);
  const existing = world.entityByRecordId(ToolCallPreview, id);
  const now = Date.now();
  if (existing !== undefined) {
    const preview = world.get(existing, ToolCallPreview);
    const linkEntry = world.query(ToolCallPreviewTargetLink)
      .map((entity) => ({ entity, link: world.get(entity, ToolCallPreviewTargetLink) }))
      .find((entry) => entry.link?.preview === existing && entry.link.requestId === target.requestId);
    if (preview && linkEntry?.link) {
      return {
        previewEntity: existing,
        linkEntity: linkEntry.entity,
        preview,
        link: linkEntry.link,
        created: false,
        epoch: target.epoch
      };
    }
  }

  const previewEntity = cmd.spawn();
  const linkEntity = cmd.spawn();
  return {
    previewEntity,
    linkEntity,
    preview: {
      id,
      callId,
      ...(name ? { name } : {}),
      ...(streamIndex ? { streamIndex } : {}),
      argumentsText: '',
      receivedChars: 0,
      createdAt: now,
      updatedAt: now
    },
    link: {
      id: toolCallPreviewTargetLinkId(id),
      preview: previewEntity,
      request: target.request,
      requestId: target.requestId,
      message: target.message,
      messageId: target.messageId,
      conversation: target.conversation,
      conversationId: target.conversationId,
      createdAt: now,
      updatedAt: now
    },
    created: true,
    epoch: target.epoch
  };
}

function restartPreview(
  current: WorkingPreview,
  target: PreviewTarget,
  callId: string,
  name?: string,
  streamIndex?: string
): WorkingPreview {
  const now = Date.now();
  return {
    ...current,
    preview: {
      id: current.preview.id,
      callId,
      ...(name ? { name } : {}),
      ...(streamIndex ? { streamIndex } : {}),
      argumentsText: '',
      receivedChars: 0,
      createdAt: now,
      updatedAt: now
    },
    link: {
      ...current.link,
      request: target.request,
      requestId: target.requestId,
      message: target.message,
      messageId: target.messageId,
      conversation: target.conversation,
      conversationId: target.conversationId,
      updatedAt: now
    },
    epoch: target.epoch
  };
}

function appendPreviewArguments(
  current: ToolCallPreviewData,
  delta: string,
  replace: boolean,
  name?: string,
  streamIndex?: string
): ToolCallPreviewData {
  const now = Date.now();
  return {
    ...current,
    ...(name ? { name } : {}),
    ...(streamIndex ? { streamIndex } : {}),
    ...appendToolCallPreviewArguments(current, delta, replace),
    updatedAt: now
  };
}

function previewRemovals(
  world: WorldReader,
  payload: LlmToolCallPreviewDonePayload,
  allowCurrentEpoch = false
): PreviewRemoval[] {
  const allowedCallIds = payload.all ? undefined : new Set(payload.callIds ?? []);
  const grouped = new Map<Entity, PreviewRemoval>();
  for (const linkEntity of world.query(ToolCallPreviewTargetLink)) {
    const link = world.get(linkEntity, ToolCallPreviewTargetLink);
    if (!link || link.requestId !== payload.requestId) continue;
    const preview = world.get(link.preview, ToolCallPreview);
    if (!preview || (allowedCallIds && !allowedCallIds.has(preview.callId))) continue;
    const expectedEpoch = world.get(link.request, LlmRequest)?.reliableStreamEpoch;
    if (!(allowCurrentEpoch
      ? admitsPreviewBoundaryEpoch(expectedEpoch, payload)
      : admitsPreviewEpoch(expectedEpoch, payload))) continue;
    const current = grouped.get(link.preview) ?? {
      previewEntity: link.preview,
      linkEntities: [],
      previewId: preview.id,
      linkIds: [],
      requestId: link.requestId,
      conversationId: link.conversationId,
      restart: {
        previewEntity: link.preview,
        linkEntity,
        preview,
        link,
        created: false,
        epoch: payload
      }
    };
    current.linkEntities.push(linkEntity);
    current.linkIds.push(link.id);
    grouped.set(link.preview, current);
  }
  return [...grouped.values()];
}

function orphanPreviewRemovals(world: WorldReader): PreviewRemoval[] {
  const grouped = new Map<Entity, PreviewRemoval>();
  for (const linkEntity of world.query(ToolCallPreviewTargetLink)) {
    const link = world.get(linkEntity, ToolCallPreviewTargetLink);
    if (!link || world.has(link.request, LlmRequest)) continue;
    const preview = world.get(link.preview, ToolCallPreview);
    if (!preview) continue;
    const current = grouped.get(link.preview) ?? {
      previewEntity: link.preview,
      linkEntities: [],
      previewId: preview.id,
      linkIds: [],
      requestId: link.requestId,
      conversationId: link.conversationId
    };
    current.linkEntities.push(linkEntity);
    current.linkIds.push(link.id);
    grouped.set(link.preview, current);
  }
  return [...grouped.values()];
}

function admitsRetryBoundary(world: WorldReader, payload: LlmRetryPayload): boolean {
  const request = world.entityByRecordId(LlmRequest, payload.requestId);
  if (request === undefined) return false;
  return admitsPreviewBoundaryEpoch(world.get(request, LlmRequest)?.reliableStreamEpoch, payload);
}

function admitsPreviewBoundaryEpoch(
  expected: { attemptId: string; generation: number; streamSeq: number } | undefined,
  payload: LlmStreamEpochPayload
): boolean {
  const epoch = reliableEpoch(payload);
  if (!expected) return !epoch;
  return !!epoch
    && epoch.attemptId === expected.attemptId
    && epoch.generation === expected.generation
    && epoch.streamSeq >= expected.streamSeq;
}

function admitsPreviewEpoch(
  expected: { attemptId: string; generation: number; streamSeq: number } | undefined,
  payload: LlmStreamEpochPayload
): boolean {
  const epoch = reliableEpoch(payload);
  if (!expected) return !epoch;
  return !!epoch
    && epoch.attemptId === expected.attemptId
    && epoch.generation === expected.generation
    && epoch.streamSeq > expected.streamSeq;
}

function reliableEpoch(payload: LlmStreamEpochPayload | undefined): TransientStreamEpoch | undefined {
  return payload?.attemptId && payload.generation !== undefined && payload.streamSeq !== undefined
    ? {
        requestId: ('requestId' in payload && typeof payload.requestId === 'string' ? payload.requestId : '') as RequestId,
        attemptId: payload.attemptId as AttemptId,
        generation: payload.generation,
        streamSeq: payload.streamSeq
      }
    : undefined;
}

function appendFastPatchBatches(world: WorldReader, cmd: CommandSink, batches: ClientSyncFastPatchBatch[]): void {
  const current = world.getResource(ClientSyncFastPatchStateKey);
  cmd.setResource(ClientSyncFastPatchStateKey, {
    patches: [...current.patches, ...batches],
    deferFullSync: true,
    requireFullSync: current.requireFullSync
  });
}

function conversationIdForLink(_world: WorldReader, link: ToolCallPreviewTargetLinkData): string {
  return link.conversationId;
}

function toPreviewRecord(preview: ToolCallPreviewData): ToolCallPreviewRecord {
  return { ...preview };
}

function toPreviewTargetLinkRecord(world: WorldReader, link: ToolCallPreviewTargetLinkData, previewId: string): ToolCallPreviewTargetLinkRecord {
  return {
    id: link.id,
    previewId,
    requestId: link.requestId,
    messageId: link.messageId,
    conversationId: link.conversationId,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

export function toolCallPreviewId(requestId: string, callId: string): string {
  return `tool-preview:${encodeURIComponent(requestId)}:${encodeURIComponent(callId)}`;
}

export function toolCallPreviewTargetLinkId(previewId: string): string {
  return `${previewId}:target`;
}

function previewKey(requestId: string, callId: string): string {
  return toolCallPreviewId(requestId, callId);
}

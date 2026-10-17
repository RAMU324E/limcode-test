import { markRaw, toRaw } from 'vue';
import type { ReliableKernelBoundedClientState, ReliableKernelCollaborationHistoryCursor } from '@shared/reliableKernelClientFeed';

type RecordBuckets = ReliableKernelBoundedClientState['records'];
export type ReliableRecordMembership = Record<string, Record<string, true>>;
export interface ReliableMessageCursor { messageSeq: string; id: string }

/** A page owns membership, never another copy of its committed facts or bodies.
 * The canonical root is replaced atomically; its immutable records need no deep Vue observers. */
export interface ReliableResidentHistoryPage {
  id: string;
  members: ReliableRecordMembership;
  messageIds: string[];
  before: ReliableMessageCursor;
  after: ReliableMessageCursor;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ReliableResidentCollaborationPage {
  id: string;
  members: ReliableRecordMembership;
  before?: ReliableKernelCollaborationHistoryCursor;
  after?: ReliableKernelCollaborationHistoryCursor;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

export interface ReliableHistoryResidency {
  records: RecordBuckets;
  committedRecords: RecordBuckets;
  historyPages: ReliableResidentHistoryPage[];
  historyCurrentPageId: string | null;
  collaborationHistoryPages: ReliableResidentCollaborationPage[];
  collaborationHistoryCurrentPageId: string | null;
}

export interface ReleasedReliableRecord { type: string; id: string; record: RecordBuckets[string][string] }

export function reliablePageOwnsRecord(state: ReliableHistoryResidency, type: string, id: string): boolean {
  return state.historyPages.some(page => page.members[type]?.[id])
    || state.collaborationHistoryPages.some(page => page.members[type]?.[id]);
}

/** Applies only this committed changes batch. Live eviction is distinct from record deletion. */
export function applyReliableCommittedChanges(
  state: ReliableHistoryResidency,
  changes: readonly Record<string, unknown>[]
): ReleasedReliableRecord[] {
  let next = state.committedRecords;
  const copied = new Set<string>();
  const released: ReleasedReliableRecord[] = [];
  const bucket = (type: string): RecordBuckets[string] => {
    if (next === state.committedRecords) next = { ...next };
    if (!copied.has(type)) {
      next[type] = { ...(next[type] ?? {}) };
      copied.add(type);
    }
    return next[type]!;
  };
  for (const change of changes) {
    const type = typeof change.type === 'string' ? change.type : '';
    const id = typeof change.id === 'string' ? change.id : '';
    if (!type || !id || type === 'ConversationTaskList' || type === 'ConversationExecutionBoundary') continue;
    if (change.operation === 'upsert') {
      const record = state.records[type]?.[id] ?? change.record as RecordBuckets[string][string] | undefined;
      if (record) bucket(type)[id] = toRaw(record);
      continue;
    }
    if (change.operation !== 'remove') continue;
    if (change.removalCause === 'window-eviction' && reliablePageOwnsRecord(state, type, id)) continue;
    if (change.removalCause !== 'window-eviction') {
      for (const page of [...state.historyPages, ...state.collaborationHistoryPages]) delete page.members[type]?.[id];
    }
    const record = next[type]?.[id];
    if (record) {
      released.push({ type, id, record });
      delete bucket(type)[id];
    }
  }
  state.committedRecords = markRaw(next);
  return released;
}

/** A full snapshot replaces live membership while the resident reading pages keep their facts. */
export function replaceReliableCommittedLive(state: ReliableHistoryResidency): ReleasedReliableRecord[] {
  const next: RecordBuckets = {};
  const released: ReleasedReliableRecord[] = [];
  for (const [type, records] of Object.entries(state.committedRecords)) {
    for (const [id, record] of Object.entries(records)) {
      if (state.records[type]?.[id]) continue;
      if (reliablePageOwnsRecord(state, type, id)) (next[type] ??= {})[id] = record;
      else released.push({ type, id, record });
    }
  }
  for (const [type, records] of Object.entries(state.records)) {
    const bucket = next[type] ??= {};
    for (const [id, record] of Object.entries(records)) bucket[id] = toRaw(record);
  }
  state.committedRecords = markRaw(next);
  return released;
}

export function admitReliableHistoryRecords(state: ReliableHistoryResidency, records: RecordBuckets): ReliableRecordMembership {
  const members: ReliableRecordMembership = {};
  const next = { ...state.committedRecords };
  for (const [type, bucket] of Object.entries(records)) {
    const target = { ...(next[type] ?? {}) };
    const ids: Record<string, true> = {};
    for (const [id, record] of Object.entries(bucket)) {
      ids[id] = true;
      target[id] = toRaw(state.records[type]?.[id] ?? record);
    }
    members[type] = ids;
    next[type] = target;
  }
  state.committedRecords = markRaw(next);
  return members;
}

export function reliableHistoryPageForMessage(
  state: ReliableHistoryResidency,
  messageId: string | undefined
): ReliableResidentHistoryPage | undefined {
  if (!messageId) return undefined;
  return state.historyPages.find(page => page.members.Message?.[messageId]);
}

/** Current reading page and its immediate neighbours, plus the independently bounded live tail. */
export function retainReliableReadingPages(
  state: ReliableHistoryResidency,
  currentPageId: string | null
): ReleasedReliableRecord[] {
  state.historyCurrentPageId = currentPageId;
  const current = currentPageId === null ? state.historyPages.length
    : state.historyPages.findIndex(page => page.id === currentPageId);
  const lower = Math.max(0, current - 1);
  const upper = current < 0 ? state.historyPages.length : current + 2;
  const removed = state.historyPages.filter((_, position) => position < lower || position >= upper);
  state.historyPages = state.historyPages.filter((_, position) => position >= lower && position < upper);
  return releaseReliablePageMembers(state, removed);
}

export function reliableCollaborationPageForCard(
  state: ReliableHistoryResidency,
  card: { messageId: string; acceptedAnswerId?: string }
): ReliableResidentCollaborationPage | undefined {
  return state.collaborationHistoryPages.find(page => card.acceptedAnswerId
    ? page.members.RuntimeDeliveryAnswerPresentation?.[card.acceptedAnswerId]
    : card.messageId.startsWith('answer:')
      ? page.members.AnswerSubmission?.[card.messageId.slice('answer:'.length)]
      : page.members.CollaborationMessage?.[card.messageId]);
}

/** Collaboration is an independent keyset inventory; retain the same reading neighbourhood. */
export function retainReliableCollaborationPages(
  state: ReliableHistoryResidency,
  currentPageId: string | null
): ReleasedReliableRecord[] {
  state.collaborationHistoryCurrentPageId = currentPageId;
  const current = currentPageId === null ? state.collaborationHistoryPages.length
    : state.collaborationHistoryPages.findIndex(page => page.id === currentPageId);
  const lower = Math.max(0, current - 1), upper = current < 0 ? state.collaborationHistoryPages.length : current + 2;
  const removed = state.collaborationHistoryPages.filter((_, position) => position < lower || position >= upper);
  state.collaborationHistoryPages = state.collaborationHistoryPages.filter((_, position) => position >= lower && position < upper);
  return releaseReliablePageMembers(state, removed);
}

export function releaseReliablePageMembers(
  state: ReliableHistoryResidency,
  pages: readonly { members: ReliableRecordMembership }[]
): ReleasedReliableRecord[] {
  let next = state.committedRecords;
  const copied = new Set<string>();
  const released: ReleasedReliableRecord[] = [];
  for (const page of pages) {
    for (const [type, ids] of Object.entries(page.members)) {
      for (const id of Object.keys(ids)) {
        const record = next[type]?.[id];
        if (!record || state.records[type]?.[id] || reliablePageOwnsRecord(state, type, id)) continue;
        if (next === state.committedRecords) next = { ...next };
        if (!copied.has(type)) {
          next[type] = { ...next[type] };
          copied.add(type);
        }
        released.push({ type, id, record });
        delete next[type]![id];
      }
    }
  }
  state.committedRecords = markRaw(next);
  return released;
}

export function compareReliableMessageCursors(left: ReliableMessageCursor, right: ReliableMessageCursor): number {
  const leftSeq = BigInt(left.messageSeq), rightSeq = BigInt(right.messageSeq);
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : left.id.localeCompare(right.id);
}

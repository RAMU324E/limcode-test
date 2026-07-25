import { STORAGE_VERSION } from '../../capabilities/vscodeStorage/constants';
import type { AnswerBridgeRecord, DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type { ConversationId } from '../../../shared/stableIds';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { compileRecordStore } from './recordStoreCompiler';

interface AnswerBridgeIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: Array<{ id: string; file: string; updatedAt: string }>;
}

interface AnswerBridgeRecordFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  bridge: AnswerBridgeRecord;
}

export async function loadAnswerBridgeRecords(files: DurableFileSystem): Promise<AnswerBridgeRecord[]> {
  const index = await files.readJson<AnswerBridgeIndexFile>('answer-bridge-links/index.json');
  if (!index) return [];
  if (index.schemaVersion !== STORAGE_VERSION || !Array.isArray(index.records)) throw new Error('Invalid AnswerBridge link index.');
  const ids = new Set<string>();
  const recordFiles = new Set<string>();
  const bridges: AnswerBridgeRecord[] = [];
  for (const entry of index.records) {
    if (!entry.id || ids.has(entry.id) || !entry.file.startsWith('records/') || recordFiles.has(entry.file)) {
      throw new Error(`Invalid AnswerBridge link index entry: ${entry.id || '<empty>'}`);
    }
    ids.add(entry.id);
    recordFiles.add(entry.file);
    const file = await files.readJson<AnswerBridgeRecordFile>(`answer-bridge-links/${entry.file}`);
    if (!file || file.schemaVersion !== STORAGE_VERSION || file.bridge?.id !== entry.id) {
      throw new Error(`AnswerBridge link record is missing or invalid: ${entry.id}`);
    }
    validateAnswerBridge(file.bridge);
    bridges.push(file.bridge);
  }
  return bridges.sort((left, right) => left.id.localeCompare(right.id));
}

export async function compileAnswerBridgePostimages(input: {
  files: DurableFileSystem;
  scopes: readonly ConversationId[];
  currentFacts: readonly DurableConversationFacts[];
  nextFacts: readonly DurableConversationFacts[];
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const touchedIds = touchedAnswerBridgeIds(input.mutations);
  if (touchedIds.size === 0) return [];
  const currentRecords = await loadAnswerBridgeRecords(input.files);
  const currentById = new Map<string, AnswerBridgeRecord>(currentRecords.map((record) => [record.id, record]));
  const scopeSet = new Set(input.scopes);
  const scopedCurrent = input.currentFacts.flatMap((facts) => facts.answerBridges);
  const indexedScopedCurrent = currentRecords.filter((bridge) => scopeSet.has(bridge.sourceConversationId));
  if (canonicalBridges(scopedCurrent) !== canonicalBridges(indexedScopedCurrent)) {
    throw new Error('Leased AnswerBridge facts disagree with the authoritative link resource.');
  }

  const nextScopedById = new Map<string, AnswerBridgeRecord>(input.nextFacts.flatMap((facts) => facts.answerBridges).map((bridge) => [bridge.id, bridge]));
  const nextById = new Map(currentById);
  for (const id of touchedIds) {
    const next = nextScopedById.get(id);
    if (next) {
      validateAnswerBridge(next);
      if (!scopeSet.has(next.sourceConversationId)) throw new Error(`AnswerBridge mutation escaped the leased source scope: ${id}`);
      nextById.set(id, next);
    } else {
      const current = currentById.get(id);
      if (!current || !scopeSet.has(current.sourceConversationId)) throw new Error(`AnswerBridge removal escaped the leased source scope: ${id}`);
      nextById.delete(id);
    }
  }

  return (await compileRecordStore({
    files: input.files,
    rootRelativePath: 'answer-bridge-links',
    recordKey: 'bridge',
    currentRecords,
    nextRecords: [...nextById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    touchedIds,
    now: input.now,
    labelForRecord: (bridge) => `${bridge.sourceConversationId}-${bridge.targetConversationId}`
  })).postimages;
}

function touchedAnswerBridgeIds(mutations: readonly RecordMutation[]): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.family !== 'answerBridges') continue;
    if (mutation.kind === 'remove_many') {
      for (const id of mutation.ids) ids.add(id);
    } else {
      ids.add(mutation.id);
    }
  }
  return ids;
}

function validateAnswerBridge(bridge: AnswerBridgeRecord): void {
  if (!bridge.id || !bridge.sourceConversationId || !bridge.targetConversationId || !bridge.ownerRunId
    || !Number.isInteger(bridge.ownerGeneration) || bridge.ownerGeneration < 0
    || !Number.isInteger(bridge.rowVersion) || bridge.rowVersion <= 0
    || !['open', 'closed', 'cancelled'].includes(bridge.lifecycle)) {
    throw new Error(`Invalid AnswerBridge link record: ${bridge.id || '<empty>'}`);
  }
}

function canonicalBridges(bridges: readonly AnswerBridgeRecord[]): string {
  return JSON.stringify([...bridges].sort((left, right) => left.id.localeCompare(right.id)));
}

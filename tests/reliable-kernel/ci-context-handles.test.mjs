import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import {
  createConfigurationRoot, Database, kernel, kernelFile, compiled, MESSAGE_TYPE,
  modelRequestAggregate, NOW, removeConfigurationRoot, repo, SHARED_PROJECT, SHARED_TEXT,
  messageText, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';
import * as memory from './fixtures/ci-context-handle-memory.mjs';
import { registerContextHandleBoundaryTests } from './fixtures/ci-context-handle-boundaries.mjs';

const require = createRequire(import.meta.url);
const load = file => require(path.join(compiled, file));
const state = kernelFile('conversationContextHandleState.js');
const { readConversationContextHandleState } = kernelFile('conversationChildHandles.js');
const { upgradePendingConversationContextHandles } = kernelFile('conversationContextHandleUpgrade.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION: contract } = kernelFile('modelHandleCatalog.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const CONVERSATION = 'ci_handle_import_owner';
const INACTIVE_CONVERSATION = 'ci_handle_inactive_owner';
const IMPORT_CATALOG = { identityContractRevision: contract,
  entries: [{ kind: 'process', ref: 'P1', target: 'frozen_process' }], retiredRefs: [] };
let configuration, database, store;
async function openRuntime() {
  database = await kernel.RuntimeDatabase.open(configuration.current.authority);
  store = kernel.ContentAddressedStore.forDatabase(configuration.current.authority, database);
}
before(async () => {
  configuration = await createConfigurationRoot();
  await withRuntime(configuration.alpha, async (sourceDatabase, sourceStore) => {
    await seedHandleConversations(sourceDatabase, sourceStore);
    await sourceDatabase.transaction([
      ...state.pendingConversationContextHandleStateSteps(CONVERSATION, NOW),
      ...state.pendingConversationContextHandleStateSteps(INACTIVE_CONVERSATION, NOW)
    ]);
    await seedHandleRequest(sourceDatabase, sourceStore, 'selected_handle_request', 1n, true);
    await seedHandleRequest(sourceDatabase, sourceStore, 'other_selected_request', 1n, true, INACTIVE_CONVERSATION);
    await seedHandleRequest(sourceDatabase, sourceStore, 'inactive_handle_request', 2n, false, INACTIVE_CONVERSATION);
  });
  await openRuntime();
  await seedHandleConversations(database, store);
  await database.transaction([
    state.emptyConversationContextHandleStateStep(CONVERSATION, NOW),
    state.emptyConversationContextHandleStateStep(INACTIVE_CONVERSATION, NOW)
  ]);
  await seedHandleRequest(database, store, 'other_selected_request', 1n, true, INACTIVE_CONVERSATION);
  const current = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  await database.transaction(await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
    conversationId: INACTIVE_CONVERSATION, current, contextRootId: 'other_selected_request_root',
    catalog: IMPORT_CATALOG, requiresNativeReset: false, now: NOW }));
});
after(async () => {
  await database?.close();
  if (configuration) await removeConfigurationRoot(configuration.root);
});
async function rows(domain, where = {}) {
  return (await database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
}
async function createTurn(id) {
  const conversationId = id + '_conversation';
  await database.transaction([
    repo('Conversation').insert({ id: conversationId, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: id + '_termination', turn_id: id, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    state.emptyConversationContextHandleStateStep(conversationId, NOW)
  ]);
  return { conversationId, turnId: id };
}
async function directory(name) {
  const result = path.join(configuration.root, name);
  await fs.mkdir(result, { recursive: true });
  return result;
}
async function reopen() {
  await database.close();
  await openRuntime();
}
async function seedHandleConversations(target, contentStore) {
  const shared = await contentStore.ingest(target, SHARED_TEXT, MESSAGE_TYPE);
  for (const conversationId of [CONVERSATION, INACTIVE_CONVERSATION]) {
    const own = await contentStore.ingest(target, messageText(conversationId, 0), MESSAGE_TYPE);
    const turnId = conversationId + '_turn';
    const steps = [
      repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW }),
      ...projectFolderAssignmentSteps({ conversationId, folder: SHARED_PROJECT, now: NOW }),
      repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
      repo('TurnTermination').insert({ id: conversationId + '_termination', turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
    ];
    for (const [index, contentId] of [own.id, shared.id].entries()) {
      const messageId = conversationId + '_message_' + index;
      steps.push(
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: messageId + '_revision', message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: contentId, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: messageId + '_current', message_id: messageId, revision_id: messageId + '_revision', updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: messageId + '_member', conversation_id: conversationId, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW })
      );
    }
    await target.transaction(steps);
  }
}
async function seedHandleRequest(target, contentStore, id, sequence, represented, conversationId = CONVERSATION) {
  const recipe = await contentStore.ingest(target, JSON.stringify({
    kind: 'reliable-agent-turn', modelHandleCatalog: IMPORT_CATALOG
  }), 'application/json');
  const body = await contentStore.ingest(target, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
  const steps = modelRequestAggregate(conversationId + '_turn', id, sequence,
    { recipe: recipe.id, body: body.id, checkpoints: 1 });
  steps.push(
    repo('Message').insert({ id: id + '_message', created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: id + '_revision', message_id: id + '_message', revision_seq: 1n,
      role: 'model', content_object_id: body.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: id + '_current', message_id: id + '_message', revision_id: id + '_revision', updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: id + '_member', conversation_id: conversationId,
      message_id: id + '_message', message_seq: sequence + 2n, created_at: NOW }),
    repo('ModelRequestMessageLink').insert({ id: id + '_output', model_request_id: id, message_id: id + '_message', created_at: NOW }),
    repo('ContextSegment').insert({ id: id + '_segment', content_object_id: body.id, segment_kind: 'message', created_at: NOW }),
    repo('ContextSegmentSource').insert({ id: id + '_source', segment_id: id + '_segment', source_kind: 'message_revision',
      source_id: id + '_revision', source_revision: 1n, created_at: NOW }),
    repo('ContextSequenceNode').insert({ id: id + '_node', parent_node_id: null, segment_id: id + '_segment', created_at: NOW }),
    repo('ContextSequenceRoot').insert({ id: id + '_root', conversation_id: conversationId, root_seq: sequence,
      root_node_id: id + '_node', tail_node_id: null, tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 1n, created_at: NOW })
  );
  if (represented) {
    steps.push(repo('ConversationContextHeadLink').insert({ id: id + '_head', conversation_id: conversationId,
      root_id: id + '_root', updated_at: NOW }));
    const current = await state.readConversationContextHandleStateRow(target, conversationId);
    steps.push(...state.pendingConversationContextHandleStateSteps(conversationId, NOW, current, id + '_root'));
  }
  await target.transaction(steps);
}
async function mergeSource() {
  const report = await mergeHistoricalDataSetsOnline(configuration.paths,
    { configurationRootPath: configuration.root, database }, { candidateIds: [configuration.alpha.id], requested: true });
  assert.deepEqual(report.deferred, []);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.failures, []);
  assert.equal(report.merged.length, 1);
  return report;
}

test('H1 only admitted bindings publish; private allocations reserve ordinals and stale head plans roll back', async () => {
  const seeded = memory.fixture();
  await memory.seedReady(seeded, memory.catalog(memory.processHandle(1)));
  const f = memory.fixture(seeded.shared);
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries,
    [memory.processHandle(1)]);
  assert.equal(f.metrics.reads.length, 1);
  assert.ok(f.metrics.queries.every(read =>
    [state.CONTEXT_HANDLE_STATE_DOMAIN, 'ConversationContextHeadLink', 'ContentObject'].includes(read.domain)));
  const frozen = structuredClone(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0]);
  const privateSteps = await memory.prepare(f, memory.catalog(memory.processHandle(1), memory.processHandle(50)), 'native');
  assert.equal(privateSteps.length, 1);
  assert.equal(privateSteps[0].kind, 'assert');
  await f.database.transaction(privateSteps);
  assert.deepEqual(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0], frozen);
  assert.equal(f.metrics.reads.length, 1);
  assert.equal(f.metrics.prepares, 0);
  const second = memory.addModelOccurrence(f, 'second', memory.catalog(memory.processHandle(1), memory.processHandle(2), memory.processHandle(99)), null, 'P2');
  const third = memory.addModelOccurrence(f, 'third', memory.catalog(memory.processHandle(1), memory.processHandle(3)), null, 'P3');
  const root2 = memory.addRoot(f, 'root-2', second.nodeId, 1n);
  const root3 = memory.addRoot(f, 'root-3', third.nodeId, 1n);
  const admitted = await memory.transition(f, 'root-2', 'append', { rootShape: root2, occurrence: second.occurrence });
  const stale = await memory.transition(f, 'root-3', 'append', { rootShape: root3, occurrence: third.occurrence });
  await memory.commitTransition(f, admitted);
  await assert.rejects(memory.commitTransition(f, stale), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
  const current = await state.readCurrentConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(current.catalog.entries, [memory.processHandle(1), memory.processHandle(2)]);
  assert.equal(current.catalog.allocationHighWater.process, 99);
  assert.equal(f.table('ContextRootHandleCatalog').some(row => row.context_root_id === 'root-3'), false);
  assert.equal(f.metrics.historicalFrontiers, 0);
});

test('H2 retry branches bind the same process ref independently and reactivate exact immutable catalogs', async () => {
  const f = memory.fixture();
  await memory.seedReady(f, memory.catalog());
  const a = { kind: 'process', ref: 'P3520', target: 'branch-A' };
  const b = { kind: 'process', ref: 'P3520', target: 'branch-B' };
  const occurrenceA = memory.addModelOccurrence(f, 'branch-A', memory.catalog(a));
  const shapeA = memory.addRoot(f, 'root-A', occurrenceA.nodeId, 1n);
  await memory.commitTransition(f, await memory.transition(f, 'root-A', 'append', { rootShape: shapeA, occurrence: occurrenceA.occurrence }));
  const snapshotA = structuredClone(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'));
  const bytesA = Buffer.from(f.shared.contents.get(snapshotA.content_object_id));
  const prefix = memory.addRoot(f, 'retry-prefix');
  await memory.commitTransition(f, await memory.transition(f, 'retry-prefix', 'rewrite', { rootShape: prefix }));
  const occurrenceB = memory.addModelOccurrence(f, 'branch-B', memory.catalog(b));
  const shapeB = memory.addRoot(f, 'root-B', occurrenceB.nodeId, 1n);
  await memory.commitTransition(f, await memory.transition(f, 'root-B', 'append', { rootShape: shapeB, occurrence: occurrenceB.occurrence }));
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries, [b]);
  await memory.commitTransition(f, await memory.transition(f, 'root-A', 'activate'));
  const restored = await readConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(restored.catalog.entries, [a]);
  assert.equal(restored.requiresNativeReset, true);
  assert.deepEqual(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'), snapshotA);
  assert.deepEqual(f.shared.contents.get(snapshotA.content_object_id), bytesA);
  assert.deepEqual(restored.catalog.retiredRefs, []);
});

test('H3 selected-root upgrade resumes 65 occurrences across 32 and 64 checkpoints without replaying discarded history', async () => {
  const f = memory.fixture();
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'),
    { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
  assert.equal(f.metrics.reads.length, 0);
  f.table('Conversation').push({ id: 'conversation', title: 'checkpoint', status: 'active', created_at: NOW, updated_at: NOW });
  let parent = null;
  for (let index = 0; index < 65; index++) {
    const legacy = { entries: [{ kind: 'process', ref: 'P1', target: index === 64 ? 'old-b' : 'old-a' }] };
    parent = memory.addModelOccurrence(f, 'checkpoint-' + index, legacy, parent, index === 40 ? 'P1 P9000' : 'P1').nodeId;
  }
  memory.addRoot(f, 'legacy-root', parent, 65n);
  memory.selectHead(f, 'legacy-root');
  memory.addModelOccurrence(f, 'discarded', memory.catalog({ kind: 'process', ref: 'P1', target: 'discarded-process' }));
  await f.database.transaction(state.pendingConversationContextHandleStateSteps('conversation', NOW, undefined, 'legacy-root'));
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'), { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING' });
  const abort = new AbortController();
  let ticked = false;
  const tick = new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
  await assert.rejects(upgradePendingConversationContextHandles(f.database, f.store, {
    signal: abort.signal, onProgress(value) {
      if (value.completedRequests === 33) { assert.equal(ticked, true); abort.abort(); }
    }
  }), { name: 'AbortError' });
  await tick;
  const pending = f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0];
  const checkpoint = JSON.parse(f.shared.contents.get(pending.content_object_id));
  assert.equal(pending.state, 'pending');
  assert.equal(checkpoint.nextOccurrence, 32);
  assert.equal(checkpoint.facts.reduce((count, value) => count + value.entries.length, 0), 1);
  assert.ok(JSON.stringify(checkpoint).length < 1_000);
  const reopened = memory.fixture(f.shared), progress = [];
  assert.deepEqual(await upgradePendingConversationContextHandles(reopened.database, reopened.store,
    { onProgress: value => progress.push(value.completedRequests) }), []);
  assert.equal(progress[0], 32);
  assert.equal(reopened.metrics.reads.filter(id => id.startsWith('recipe-checkpoint-')).length, 33);
  assert.ok(reopened.metrics.prepares <= 2);
  assert.equal(reopened.metrics.reads.includes('recipe-discarded'), false);
  const ready = await readConversationContextHandleState(reopened.database, reopened.store, 'conversation');
  assert.deepEqual(ready.catalog.entries.map(entry => entry.ref), ['P9001', 'P9002']);
  assert.deepEqual(ready.catalog.retiredRefs, ['P1']);
  assert.equal(ready.requiresNativeReset, true);
  assert.equal(reopened.metrics.historicalFrontiers, 0);
});

test('H4 one real merge invalidates selected evidence and preserves the inactive ready branch until explicit activation', async () => {
  const rootId = 'selected_handle_request_root';
  const empty = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
  const source = new Database(configuration.alpha.binding.paths.databasePath, { readonly: true });
  source.defaultSafeIntegers(true);
  try {
    const steps = [];
    for (const domain of ['Message', 'MessageRevision', 'MessageCurrentRevisionLink', 'MessagePartOfConversation',
      'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode', 'ContextSequenceRoot', 'ConversationContextHeadLink']) {
      const schema = RUNTIME_DOMAIN_SCHEMAS.find(item => item.key === domain);
      for (const raw of source.prepare('SELECT * FROM ' + schema.table + " WHERE id LIKE 'selected_handle_request_%'").all()) {
        steps.push(repo(domain).insert(repo(domain).codec.decode(raw)));
      }
    }
    await database.transaction([...steps,
      ...state.pendingConversationContextHandleStateSteps(CONVERSATION, NOW, empty, rootId)]);
  } finally { source.close(); }
  const initial = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  await database.transaction(await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
    conversationId: CONVERSATION, current: initial, contextRootId: rootId,
    catalog: { ...IMPORT_CATALOG, entries: [{ kind: 'process', ref: 'P1', target: 'stale-derived-process' }] },
    requiresNativeReset: false, now: NOW }));
  const before = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  const inactiveBefore = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  const [metadata] = await rows('ContentObject', { id: before.content_object_id });
  const oldBytes = await store.read(metadata);
  await mergeSource();
  const inactiveImported = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  assert.equal(inactiveImported.state, 'ready');
  assert.equal(inactiveImported.context_root_id, inactiveBefore.context_root_id);
  assert.equal(inactiveImported.content_object_id, inactiveBefore.content_object_id);
  assert.equal(inactiveImported.requires_native_reset, inactiveBefore.requires_native_reset);
  assert.equal(inactiveImported.provenance_revision, inactiveBefore.provenance_revision + 1n);
  const pending = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.context_root_id, rootId);
  assert.equal(pending.provenance_revision, before.provenance_revision + 1n);
  assert.deepEqual(await upgradePendingConversationContextHandles(database, store), []);
  const ready = await state.readCurrentConversationContextHandleState(database, store, CONVERSATION);
  assert.deepEqual(ready.catalog.entries, IMPORT_CATALOG.entries);
  assert.equal(ready.row.context_root_id, rootId);
  assert.equal(ready.requiresNativeReset, true);
  const [oldScope] = await rows(state.CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, {
    id: state.contextRootHandleCatalogId(CONVERSATION, rootId, before.provenance_revision)
  });
  assert.equal(oldScope.content_object_id, before.content_object_id);
  assert.deepEqual(await store.read(metadata), oldBytes);
  const switchPlan = await state.prepareContextHandleHeadTransition({ database, contentStore: store,
    conversationId: INACTIVE_CONVERSATION, previousRootId: inactiveImported.context_root_id,
    nextRootId: 'inactive_handle_request_root', mode: 'activate', now: NOW });
  await database.transaction([...switchPlan.steps, repo('ConversationContextHeadLink').update('other_selected_request_head',
    { root_id: 'inactive_handle_request_root', updated_at: NOW })]);
  assert.equal((await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION)).state, 'pending');
  assert.deepEqual(await upgradePendingConversationContextHandles(database, store), []);
  const selected = await state.readCurrentConversationContextHandleState(database, store, INACTIVE_CONVERSATION);
  assert.deepEqual(selected.catalog.entries, IMPORT_CATALOG.entries);
  assert.equal(selected.row.context_root_id, 'inactive_handle_request_root');
});

test('retry and edit after compression restore the original prefix catalog without expanding summary sources', async () => {
  const { ContextSequenceControlPlane, contextSequenceNodeId } = kernelFile('contextSequence.js');
  const { ContextCompressionControlPlane } = kernelFile('contextCompression.js');
  for (const [nested, firstTail, imported, edited = false] of [[false, false, false], [true, false, false],
    [false, true, false], [false, false, true], [false, true, false, true], [false, false, false, true],
    [true, false, false, true], [false, true, true, true]]) {
    const key = `compressed-retry-${nested}-${firstTail}-${imported}-${edited}`, { conversationId, turnId } = await createTurn(key);
    const context = new ContextSequenceControlPlane(database, store);
    const compression = new ContextCompressionControlPlane(database, store);
    const authority = await store.ingest(database, JSON.stringify({ modelProfile: {
      compressionThresholdTokens: 10000, contextWindowTokens: 20000,
      tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
    } }), 'application/json');
    await database.transaction([repo('AuthoritySnapshot').insert({ id: key + '-authority', turn_id: turnId,
      content_object_id: authority.id, created_at: NOW })]);
    for (const [index, role] of ['user', 'model', 'user', edited ? 'user' : 'model', 'tool'].entries()) {
      const content = await store.ingest(database, JSON.stringify({ role, parts: [{ text: `message ${index}` }] }), MESSAGE_TYPE);
      const messageId = `${key}-message-${index}`, revisionId = messageId + '-revision';
      await database.transaction([
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: revisionId, message_id: messageId, revision_seq: 1n, role,
          content_object_id: content.id, created_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: messageId + '-member', conversation_id: conversationId,
          message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW })
      ]);
      const current = await state.readConversationContextHandleStateRow(database, conversationId);
      const base = current.context_root_id ? await context.materializeStructure(current.context_root_id) : null;
      const compressedBase = base?.records[0]?.segment.segment_kind === 'compression';
      const segmentId = messageId + '-segment';
      const nodeId = contextSequenceNodeId(compressedBase ? base.root.tail_node_id : base?.root.root_node_id ?? null, segmentId);
      const root = { id: `${key}-root-${index}`, conversation_id: conversationId, root_seq: (base?.root.root_seq ?? 0n) + 1n,
        root_node_id: compressedBase ? base.root.root_node_id : nodeId, tail_node_id: compressedBase ? nodeId : null,
        tail_segment_count: compressedBase ? base.root.tail_segment_count + 1n : 0n,
        segment_count: (base?.root.segment_count ?? 0n) + 1n, estimated_tokens: 10n, created_at: NOW };
      // The discarded suffix introduces P8. P9 must survive because the new summary uses it.
      const entries = [{ kind: 'process', ref: 'P7', target: key + '-retained' },
        ...(index >= 3 ? [{ kind: 'process', ref: 'P8', target: key + '-discarded' }] : []),
        ...(index === 4 ? [{ kind: 'process', ref: 'P9', target: key + '-summary' }] : [])];
      const head = (await rows('ConversationContextHeadLink', { conversation_id: conversationId }))[0];
      await database.transaction([
        repo('ContextSegment').insert({ id: segmentId, content_object_id: content.id, segment_kind: 'message', created_at: NOW }),
        repo('ContextSegmentSource').insert({ id: messageId + '-source', segment_id: segmentId, source_kind: 'message_revision',
          source_id: revisionId, source_revision: 1n, created_at: NOW }),
        repo('ContextSequenceNode').insert({ id: nodeId, parent_node_id: compressedBase ? base.root.tail_node_id : base?.root.root_node_id ?? null,
          segment_id: segmentId, created_at: NOW }), repo('ContextSequenceRoot').insert(root),
        ...await state.prepareReadyConversationContextHandleState({ database, contentStore: store, conversationId,
          current, contextRootId: root.id, catalog: { identityContractRevision: contract, retiredRefs: ['P1'], entries },
          requiresNativeReset: false, now: NOW, rootShape: { rootNodeId: root.root_node_id,
            tailNodeId: root.tail_node_id, tailSegmentCount: root.tail_segment_count, segmentCount: root.segment_count } }),
        head ? repo('ConversationContextHeadLink').update(head.id, { root_id: root.id, updated_at: NOW })
          : repo('ConversationContextHeadLink').insert({ id: key + '-head', conversation_id: conversationId, root_id: root.id, updated_at: NOW })]);
      if (index === 1 && nested) await compression.create({ conversationId,
        headRootId: root.id, authoritySnapshotId: key + '-authority', compressSegmentCount: 1,
        title: 'earlier summary', summary: 'earlier summary', idempotencyKey: 'first' });
    }
    const originalRootId = await context.currentHeadRootId(conversationId);
    const original = await context.materializeStructure(originalRootId);
    const compressed = await compression.create({ conversationId, headRootId: originalRootId,
      authoritySnapshotId: key + '-authority', compressSegmentCount: nested ? 1 : 2,
      title: 'new summary', summary: 'retained summary P7 P9', idempotencyKey: 'second' });
    if (imported) {
      const current = await state.readConversationContextHandleStateRow(database, conversationId);
      await database.transaction(state.importConversationContextHandleStateSteps(conversationId, NOW, current, compressed.rootId, false));
    }
    await reopen();
    const reads = [], queries = [], originalRead = store.read.bind(store), originalSnapshot = database.snapshot.bind(database);
    store.read = async metadata => { reads.push(metadata.id); return originalRead(metadata); };
    database.snapshot = async requests => { queries.push(...requests); return originalSnapshot(requests); };
    try {
      const editedRevisionId = key + '-edited-user';
      const edit = edited ? await store.ingest(database,
        JSON.stringify({ role: 'user', parts: [{ text: 'Changed input P7 P8 P9' }] }), MESSAGE_TYPE) : undefined;
      const plan = await new ContextSequenceControlPlane(database, store).prepareMessageTruncateMutation({ conversationId,
        messageRevisionId: key + `-message-${firstTail ? 2 : 3}-revision`, idempotencyKey: key,
        ...(edit ? { replacement: { messageRevisionId: editedRevisionId, contentObjectId: edit.id,
          contentByteLength: edit.byte_length, contentEstimatedTokens: 5 } } : {}) });
      await database.transaction([
        ...(edit ? [repo('MessageRevision').insertWithNextSequence({ id: editedRevisionId,
          message_id: key + `-message-${firstTail ? 2 : 3}`, role: 'user', content_object_id: edit.id, created_at: NOW
        }, { column: 'revision_seq', scope: { message_id: key + `-message-${firstTail ? 2 : 3}` } })] : []),
        ...plan.steps
      ]);
      assert.equal((await state.readConversationContextHandleStateRow(database, conversationId)).state, imported ? 'pending' : 'ready');
      if (imported) continue; // Older generations cannot supply a directory for the imported scope.
      const ready = await state.readCurrentConversationContextHandleState(database, store, conversationId);
      assert.deepEqual(ready.catalog.entries, [{ kind: 'process', ref: 'P7', target: key + '-retained' },
        { kind: 'process', ref: 'P9', target: key + '-summary' }]);
      assert.deepEqual(ready.catalog.retiredRefs, ['P1']);
      assert.ok(ready.catalog.allocationHighWater.process >= 9);
      assert.ok(ready.requiresNativeReset);
      const selected = await new ContextSequenceControlPlane(database, store).materializeStructure(ready.row.context_root_id);
      assert.equal(selected.records[0].segment.id, compressed.summarySegmentId);
      if (firstTail) assert.equal(selected.records.length, edited ? 2 : 1);
      else assert.equal(selected.records.at(edited ? -2 : -1).node.id, original.records.at(-3).node.id);
      if (edited) assert.equal(selected.records.at(-1).segment.content_object_id, edit.id);
      assert.equal(queries.some(query => query.domain === 'CompressionBlockSource' || query.domain === 'ModelRequest'), false);
      const hiddenContent = original.records.slice(0, nested ? 1 : 2).map(record => record.segment.content_object_id);
      assert.equal(reads.some(id => hiddenContent.includes(id)), false, 'compressed source bodies are never opened');
    } finally { store.read = originalRead; database.snapshot = originalSnapshot; }
  }
});

registerContextHandleBoundaryTests({
  kernel, kernelFile, load, compiled, require, Database, repo, NOW, modelRequestAggregate,
  temporary: () => configuration.root, database: () => database, store: () => store,
  authority: () => configuration.current.authority, binding: () => database.binding,
  createTurn, directory, rows, reopen
});

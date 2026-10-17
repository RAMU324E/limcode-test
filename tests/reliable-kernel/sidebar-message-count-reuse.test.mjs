import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createHistoryFixture, projectionDatabase, projection } from './ui-history-fixture.mjs';
import { createBehaviorRuntime } from './fixtures/runtime-behavior-fixture.mjs';

const require = createRequire(import.meta.url);
const kernel = require(`${process.cwd()}/dist/extension/backend/reliableKernel/index.js`);
const Database = require('better-sqlite3');
const now = '2026-10-15T00:00:00.000Z';
const nativeContent = require(`${process.cwd()}/dist/extension/backend/reliableKernel/logicalMessageContent.js`);
const { preparedContentObjectSteps } = require(`${process.cwd()}/dist/extension/backend/reliableKernel/contentObjectTransaction.js`);

test('sidebar status refresh reuses counts, and changed messages recount only their own conversation', t => {
  const f = projectionDatabase(t);
  f.conversation('long'); f.conversation('quiet'); f.conversation('empty');
  f.db.transaction(() => { for (let i = 1; i <= 1000; i++) f.message(`m-${i}`, 'long', i); })();
  f.message('quiet-message', 'quiet', 1);
  const cache = new projection.ConversationHistoryMessageCounts(f.db);
  const read = () => projection.executeConversationHistoryProjection(f.db, { scopeKind: 'all', pageIndex: 0, limit: 50 }, cache);
  const counts = result => Object.fromEntries(result.messageSummaries.map(row => [row.conversation_id, Number(row.message_count)]));
  const aggregates = () => f.queries.filter(sql => sql.includes('COUNT(*) AS message_count'));
  assert.deepEqual(counts(read()), { long: 1000, quiet: 1 });
  assert.equal(aggregates().length, 1);
  for (const mutation of [
    { kind: 'update', domain: 'Conversation', id: 'long', patch: { title: 'renamed' } },
    { kind: 'update', domain: 'Turn', id: 'running', patch: { status: 'active' } },
    { kind: 'update', domain: 'ExecutionLease', id: 'lease', patch: { expires_at: now } }
  ]) {
    cache.beforeMutation(mutation);
    assert.deepEqual(counts(read()), { long: 1000, quiet: 1 });
  }
  assert.equal(aggregates().length, 1, 'status changes must not scan old message history');
  cache.beforeMutation({ kind: 'insert', domain: 'MessagePartOfConversation', row: { conversation_id: 'empty' } });
  f.message('new', 'empty', 1);
  assert.deepEqual(counts(read()), { long: 1000, quiet: 1, empty: 1 });
  assert.equal(aggregates().length, 2);
  assert.match(aggregates().at(-1), /IN \(@conversation0\)/, 'only the changed conversation is recounted');
  f.insert('message_revision', { id: 'edited', message_id: 'quiet-message', revision_seq: 2, role: 'model', content_object_id: 'body', created_at: now });
  const edit = { kind: 'update', domain: 'MessageCurrentRevisionLink', id: 'c-quiet-message', patch: { revision_id: 'edited' } };
  cache.beforeMutation(edit);
  f.db.prepare('UPDATE message_current_revision_link SET revision_id=? WHERE id=?').run('edited', edit.id);
  read(); assert.equal(aggregates().length, 2, 'editing visible text does not change its count');
  cache.beforeMutation({ kind: 'update', domain: 'Message', id: 'quiet-message', patch: { deleted_at: now } });
  f.db.prepare('UPDATE message SET deleted_at=? WHERE id=?').run(now, 'quiet-message');
  assert.deepEqual(counts(read()), { long: 1000, empty: 1 });
  assert.equal(aggregates().length, 3);
});

test('worker count invalidation preserves edits, role changes, deletion and external commits', async t => {
  const fixture = await createBehaviorRuntime('sidebar-count');
  t.after(() => fixture.close());
  const h = await fixture.scope('messages');
  const database = fixture.app.database;
  const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
  const body = await fixture.app.contentStore.ingest(database, 'count-body', 'text/plain');
  await database.transaction([
    repo('Message').insert({ id: 'count-message', created_at: now, updated_at: now, deleted_at: null }),
    repo('MessageRevision').insert({ id: 'count-r1', message_id: 'count-message', revision_seq: 1n, role: 'user', content_object_id: body.id, created_at: now }),
    repo('MessageCurrentRevisionLink').insert({ id: 'count-current', message_id: 'count-message', revision_id: 'count-r1', updated_at: now }),
    repo('MessagePartOfConversation').insert({ id: 'count-member', conversation_id: h.id, message_id: 'count-message', message_seq: 1n, created_at: now })
  ]);
  const count = async () => Number((await database.conversationHistoryProjection({ scopeKind: 'all', pageIndex: 0, limit: 50 }))
    .messageSummaries.find(row => row.conversation_id === h.id)?.message_count ?? 0);
  assert.equal(await count(), 1);
  await database.transaction([repo('Conversation').update(h.id, { title: 'renamed' })]);
  assert.equal(await count(), 1);
  await database.transaction([
    repo('MessageRevision').insert({ id: 'count-r2', message_id: 'count-message', revision_seq: 2n, role: 'system', content_object_id: body.id, created_at: now }),
    repo('MessageCurrentRevisionLink').update('count-current', { revision_id: 'count-r2' })
  ]);
  assert.equal(await count(), 0);
  await database.transaction([repo('MessageCurrentRevisionLink').update('count-current', { revision_id: 'count-r1' })]);
  assert.equal(await count(), 1);
  await database.transaction([repo('Message').update('count-message', { deleted_at: now })]);
  assert.equal(await count(), 0);
  const external = new Database(database.binding.paths.databasePath);
  try { external.prepare('UPDATE message SET deleted_at=NULL WHERE id=?').run('count-message'); }
  finally { external.close(); }
  assert.equal(await count(), 1, 'a peer commit invalidates cached message counts');
});

test('sidebar native previews reuse every old item body across 200 committed revisions', async t => {
  const h = await nativeHistoryPreview(t, 'growth');
  let expected;
  for (let index = 0; index < 200; index++) {
    const before = new Map(h.reads);
    const { preview, itemId } = await h.append({ text: ` 思考 ${index} \n ${'界😀'.repeat(320)} `, thought: true });
    expected ??= preview;
    assert.equal(preview, expected);
    assert.equal(h.reads.get(itemId), 1, 'the new immutable item is decoded once');
    for (const [id, count] of before) assert.equal(h.reads.get(id), count, 'a later revision must not read an old item body');
  }
  assert.equal(h.reads.size, 200, 'thought-only output must still inspect each new item for higher-priority visible text');
  assert.ok(expected.startsWith('思考：思考 0 界😀'));
  assert.ok(expected.endsWith('…'));
});

test('sidebar native preview changes from thought and tools to later Unicode text with exact truncation', async t => {
  const h = await nativeHistoryPreview(t, 'priority');
  assert.equal((await h.append({ text: ' \n  思考  😀\n计划 \t', thought: true })).preview, '思考：思考 😀 计划');
  assert.equal((await h.append({ functionResponse: { name: ' analyze ', response: {} } })).preview, '工具结果：analyze');
  assert.equal((await h.append({ functionCall: { name: ' inspect ', args: {} } })).preview, '调用工具：inspect');
  assert.equal((await h.append({ functionCall: { name: 'inspect', args: { repeated: true } } })).preview, '调用工具：inspect');
  assert.equal((await h.append({ functionCall: { name: 'look  up', args: {} } })).preview, '调用工具：inspect、look up');
  assert.equal((await h.append({ functionCall: { name: 'look up', args: {} } })).preview, '调用工具：inspect、look up、look up');
  assert.equal((await h.append({ text: ' \n\t ' })).preview, '调用工具：inspect、look up、look up');
  const first = '答案 😀';
  assert.equal((await h.append({ text: ` \n ${first} \t ` })).preview, first);
  const second = '界'.repeat(180 - first.length - 1);
  const visible = `${first} ${second}`;
  assert.equal(visible.length, 180);
  assert.equal((await h.append({ text: second })).preview, visible, 'exactly 180 normalized characters are not truncated');
  assert.equal((await h.append({ text: ' \t ' })).preview, visible);
  const truncated = `${visible.slice(0, 177)}…`;
  assert.equal((await h.append({ text: '新正文' })).preview, truncated,
    'the 181st normalized character is the inter-item space; it still proves truncation');
  const bodyReads = new Map(h.reads);
  for (let index = 0; index < 40; index++) {
    assert.equal((await h.append({ text: `后来 ${index} ${'正文😀'.repeat(500)}` })).preview, truncated);
  }
  assert.deepEqual(h.reads, bodyReads, 'after visible text fills the preview, later bodies are not read');
});

async function nativeHistoryPreview(t, label) {
  const h = await createHistoryFixture(t);
  const conversationId = `preview-${label}`, messageId = `${conversationId}-message`;
  await h.create(conversationId, 'p');
  const writerReader = new nativeContent.LogicalMessageContentReader(h.database, h.contentStore);
  const itemIds = new Set(), reads = new Map();
  h.facade.product.application.contentStore = new Proxy(h.contentStore, { get(target, key) {
    if (key === 'read' || key === 'readChunk' || key === 'readMany') return async (...args) => {
      for (const metadata of key === 'readMany' ? args[0] : [args[0]]) {
        if (itemIds.has(metadata.id)) reads.set(metadata.id, (reads.get(metadata.id) ?? 0) + 1);
      }
      return target[key](...args);
    };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
  let previous = null, sequence = 0;
  return { reads, async append(part) {
    sequence++;
    const itemRevisionId = `${messageId}-item-${sequence}`, displayRevisionId = `${messageId}-display-${sequence}`;
    const serialized = nativeContent.serializeNativeMessageItem({ ...part, outputItem: {
      id: `${messageId}-output-${sequence}`, ordinal: (sequence - 1) % 4,
      providerResponseId: `${messageId}-response-${Math.floor((sequence - 1) / 4)}`
    } });
    const item = await h.contentStore.prepare(h.database, serialized.content, nativeContent.MESSAGE_CONTENT_TYPE);
    itemIds.add(item.metadata.id);
    const composition = await nativeContent.prepareNativeMessageComposition(h.database, h.contentStore, previous, {
      revisionId: itemRevisionId, contentObjectId: item.metadata.id, partByteLength: serialized.partByteLength,
      partByteOffset: serialized.partByteOffset, outputItem: serialized.outputItem
    }, [], writerReader);
    await h.database.transaction([
      ...preparedContentObjectSteps([item, ...composition.relatedContentObjects, composition.content]),
      ...(sequence === 1 ? [repo('Message').insert({ id: messageId, created_at: now, updated_at: now, deleted_at: null })] : []),
      repo('MessageRevision').insert({ id: itemRevisionId, message_id: messageId, revision_seq: BigInt(sequence * 2 - 1),
        role: 'model', content_object_id: item.metadata.id, created_at: now }),
      repo('MessageRevision').insert({ id: displayRevisionId, message_id: messageId, revision_seq: BigInt(sequence * 2),
        role: 'model', content_object_id: composition.content.metadata.id, created_at: now }),
      ...(sequence === 1 ? [
        repo('MessageCurrentRevisionLink').insert({ id: `${messageId}-current`, message_id: messageId, revision_id: displayRevisionId, updated_at: now }),
        repo('MessagePartOfConversation').insert({ id: `${messageId}-member`, conversation_id: conversationId,
          message_id: messageId, message_seq: 1n, created_at: now })
      ] : [repo('MessageCurrentRevisionLink').update(`${messageId}-current`, { revision_id: displayRevisionId, updated_at: now }),
        repo('Message').update(messageId, { updated_at: now })]),
      repo('Conversation').update(conversationId, { updated_at: now })
    ]);
    previous = composition.content.metadata;
    const page = await h.facade.getConversationHistoryPage({ scopeKind: 'all', limit: 50 });
    return { itemId: item.metadata.id, preview: page.entries.find(entry => entry.id === conversationId)?.preview };
  } };
}

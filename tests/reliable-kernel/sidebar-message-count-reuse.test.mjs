import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { projectionDatabase, projection } from './ui-history-fixture.mjs';
import { createBehaviorRuntime } from './fixtures/runtime-behavior-fixture.mjs';

const require = createRequire(import.meta.url);
const kernel = require(`${process.cwd()}/dist/extension/backend/reliableKernel/index.js`);
const Database = require('better-sqlite3');
const now = '2026-10-15T00:00:00.000Z';

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

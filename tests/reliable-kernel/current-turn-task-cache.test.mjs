import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createTaskRuntime } from './ui-task-feed-fixture.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { CurrentTurnTaskCardCache } = require(path.join(compiled, 'backend/reliableKernel/currentTurnTaskSnapshot.js'));
const { readCurrentTurnTaskCard } = require(path.join(compiled, 'backend/reliableKernel/currentTurnTaskProjection.js'));
const { toSqliteFilePath } = require(path.join(compiled, 'backend/reliableKernel/sqliteFilePath.js'));
const { DOMAIN_REPOSITORIES } = require(path.join(compiled, 'backend/reliableKernel/repositories.js'));
const Database = require('better-sqlite3');
const at = '2026-10-15T12:00:00.000Z';

test('unchanged task cards, including empty cards, reuse facts across ordinary commits and Turns', async t => {
  const runtime = await createTaskRuntime();
  let reader, unsubscribe;
  t.after(async () => { unsubscribe?.(); reader?.close(); await runtime.close(); });
  let candidateReads = 0, bodyReads = 0, taskChanges = 0;
  reader = new Database(toSqliteFilePath(runtime.database.binding.paths.databasePath), {
    readonly: true, verbose(sql) { if (sql.includes('source_message_seq')) candidateReads += 1; }
  });
  reader.defaultSafeIntegers(true);
  const cache = new CurrentTurnTaskCardCache();
  unsubscribe = runtime.database.onCommit(commit => {
    cache.invalidate(commit.changes);
    taskChanges += commit.changes.filter(change => change.domain === 'ConversationTaskList').length;
  });
  const read = (turnId = 'task-feed-turn') => reader.transaction(() => cache.read(reader, turnId, metadata => {
    bodyReads += 1; return runtime.contentBytes.get(metadata.id);
  }))().card;

  const first = read();
  assert.equal(first.sourceToolCallId, 'task-feed-base');
  const firstReads = [candidateReads, bodyReads];
  for (let round = 0; round < 5; round += 1) assert.deepEqual(read(), first);
  assert.deepEqual([candidateReads, bodyReads], firstReads, 'unchanged rounds must not query candidates or read artifacts');
  t.diagnostic(`first read plus 5 unchanged rounds: candidate queries=${candidateReads}, body reads=${bodyReads}`);
  assert.equal(read('task-feed-foreign-turn'), undefined);
  const emptyReads = [candidateReads, bodyReads];
  for (let round = 0; round < 5; round += 1) assert.equal(read('task-feed-foreign-turn'), undefined);
  assert.deepEqual([candidateReads, bodyReads], emptyReads, 'an empty card must also avoid another historical query');
  t.diagnostic(`empty first read plus 5 unchanged rounds: additional candidate queries=${candidateReads - firstReads[0]}, body reads=${bodyReads - firstReads[1]}`);

  await runtime.appendMessages(0, 8);
  await runtime.database.transaction([DOMAIN_REPOSITORIES.domain('Conversation').update('task-feed-conversation', { title: 'Renamed', updated_at: at })]);
  await runtime.startTurn();
  assert.equal(taskChanges, 0, 'ordinary messages, titles and active-Turn state must not project task history');
  const next = read('task-feed-active-turn');
  assert.equal(next.turnId, 'task-feed-active-turn');
  assert.equal(next.sourceTurnId, 'task-feed-turn');
  assert.deepEqual([candidateReads, bodyReads], emptyReads);

  const frozen = await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn');
  await runtime.database.transaction([DOMAIN_REPOSITORIES.domain('Conversation').update('task-feed-conversation', { title: 'Renamed again', updated_at: at })]);
  const later = await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn');
  assert.equal(later.card, frozen.card);
  assert.equal(later.turnId, 'task-feed-active-turn');
  assert.ok(BigInt(later.frozenAtCommitSeq) > BigInt(frozen.frozenAtCommitSeq), 'each recipe freezes the current read frontier');

  await runtime.settle('task-feed-update-one', { detail: { kind: 'task-list', operation: { mode: 'update', items: [{ title: 'Write tests', status: 'in_progress' }] } } });
  assert.equal(read().counts.inProgress, 1);
  assert.equal((await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn')).sourceToolCallId, 'task-feed-update-one');
  await runtime.settle('task-feed-plan', { detail: { output: { kind: 'submit_plan.result', proposalId: 'task-feed-proposal', status: 'approved', executionTarget: 'current_conversation' } } });
  const approved = read();
  assert.equal(approved.sourceToolCallId, 'task-feed-plan');
  assert.equal(approved.counts.completed, 1);
  const beforeForeign = [candidateReads, bodyReads];
  await runtime.settle('task-feed-foreign-plan', { detail: { output: { kind: 'submit_plan.result', proposalId: 'foreign', status: 'approved', executionTarget: 'current_conversation' } } });
  assert.deepEqual(read(), approved);
  assert.deepEqual([candidateReads, bodyReads], beforeForeign, 'another local Conversation must not invalidate this card');
  assert.equal(read('task-feed-foreign-turn').sourceToolCallId, 'task-feed-foreign-plan');

  await runtime.database.transaction([DOMAIN_REPOSITORIES.domain('Message').update('task-feed-native-message', { deleted_at: at, updated_at: at })]);
  assert.equal(read().sourceToolCallId, 'task-feed-base');
  assert.equal((await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn')).counts.pending, 1);
  await runtime.database.transaction([DOMAIN_REPOSITORIES.domain('Message').update('task-feed-native-message', { deleted_at: null, updated_at: at })]);
  assert.equal(read().sourceToolCallId, 'task-feed-plan');
  assert.equal((await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn')).counts.completed, 1);

  // A real peer connection changes ordering of a previously superseded source. No local commit
  // notification reaches the worker, so its next read must invalidate through data_version.
  const peer = new Database(toSqliteFilePath(runtime.database.binding.paths.databasePath));
  try {
    peer.prepare('UPDATE message_part_of_conversation SET message_seq = 100 WHERE message_id = ?').run('task-feed-old-message');
  } finally { peer.close(); }
  const reordered = await readCurrentTurnTaskCard(runtime.database, 'task-feed-active-turn');
  assert.equal(reordered.sourceToolCallId, 'task-feed-base');
  assert.equal(reordered.counts.pending, 1);
});

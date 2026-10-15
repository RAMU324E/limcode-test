import assert from 'node:assert/strict';
import test from 'node:test';
import { createBehaviorRuntime, load, NOW, repo } from './fixtures/runtime-behavior-fixture.mjs';

const { TURN_INTENT_ENVELOPE_CONTENT_TYPE: ENVELOPE } = load('backend/reliableKernel/guidanceIntent.js');

test('tool boundaries read only queued intents and their child links while retaining FIFO, hold and revision facts', async () => {
  const fixture = await createBehaviorRuntime('queued-boundary');
  try {
    const { app } = fixture, own = await fixture.scope('own'), foreign = await fixture.scope('foreign');
    const message = await app.contentStore.ingest(app.database, 'queued input', 'text/plain');
    const envelope = async (position, hold = 'none') => app.contentStore.ingest(app.database,
      JSON.stringify({ kind: 'input', version: 1, messageContentObjectId: message.id, guidance: { position, hold } }), ENVELOPE);
    const [older, latest, paused, continuation] = await Promise.all([
      envelope('30'), envelope('2'), envelope('1', 'paused'), app.contentStore.ingest(app.database,
        JSON.stringify({ kind: 'runtime_continuation', version: 1, sourceTurnId: null }), ENVELOPE)
    ]);
    const intent = (id, conversationId, state = 'queued') => repo('TurnIntent').insert({
      id, conversation_id: conversationId, turn_id: null, state, created_at: NOW, updated_at: NOW });
    const revision = (id, intentId, content, seq = 1n) => repo('TurnIntentRevision').insert({
      id, intent_id: intentId, revision_seq: seq, content_object_id: content.id, created_at: NOW });
    await app.database.transaction([
      ...Array.from({ length: 120 }, (_, index) => intent(`boundary-history-${index}`, own.id, 'cancelled')),
      intent('boundary-guidance', own.id), revision('boundary-old', 'boundary-guidance', older),
      revision('boundary-latest', 'boundary-guidance', latest, 2n),
      intent('boundary-paused', own.id), revision('boundary-held', 'boundary-paused', paused),
      intent('boundary-runtime', own.id), revision('boundary-runtime-revision', 'boundary-runtime', continuation),
      intent('boundary-child-intent', own.id), intent('boundary-foreign-intent', foreign.id),
      ...[[own, 'boundary-child-intent'], [foreign, 'boundary-foreign-intent']].flatMap(([scope, intentId]) => [
        repo('ChildExecution').insert({ id: intentId + '-child', child_conversation_id: scope.id,
          status: 'idle', created_at: NOW, updated_at: NOW }),
        repo('ChildExecutionIntentLink').insert({ id: intentId + '-link', child_execution_id: intentId + '-child',
          intent_seq: 1n, turn_intent_id: intentId, state: 'pending', created_at: NOW, updated_at: NOW })
      ])
    ]);
    const snapshot = app.database.snapshot.bind(app.database), snapshotAll = app.database.snapshotAll.bind(app.database);
    let returnedIntents = 0, returnedChildLinks = 0;
    const childQueries = [];
    app.database.snapshotAll = async read => {
      const result = await snapshotAll(read);
      if (read.domain === 'TurnIntent') returnedIntents += result.snapshot.length;
      return result;
    };
    app.database.snapshot = async reads => {
      const result = await snapshot(reads);
      reads.forEach((read, index) => {
        if (read.domain !== 'ChildExecutionIntentLink') return;
        childQueries.push(read);
        returnedChildLinks += result.snapshot[index].length;
      });
      return result;
    };
    try {
      const selected = await app.agentLoop.oldestQueuedBoundaryIntent(own.id);
      assert.equal(selected.intent.id, 'boundary-guidance');
      assert.equal(selected.kind, 'guidance');
      assert.deepEqual(new Set(selected.revisionIds), new Set(['boundary-old', 'boundary-latest']));
      assert.equal(returnedIntents, 4, 'completed or cancelled history is not copied out for a boundary check');
      assert.equal(returnedChildLinks, 1, 'other conversations do not contribute child-link facts');
      assert.equal(childQueries.length, 4);
      assert.ok(childQueries.every(read => read.where?.turn_intent_id && read.limit === 1));
      await app.database.transaction([repo('TurnIntent').update('boundary-guidance', { state: 'cancelled', updated_at: NOW })]);
      assert.equal((await app.agentLoop.oldestQueuedBoundaryIntent(own.id)).kind, 'runtime_continuation');
      await app.database.transaction(['boundary-runtime', 'boundary-paused', 'boundary-child-intent']
        .map(id => repo('TurnIntent').update(id, { state: 'cancelled', updated_at: NOW })));
      childQueries.length = 0;
      assert.equal(await app.agentLoop.oldestQueuedBoundaryIntent(own.id), null);
      assert.equal(childQueries.length, 0, 'an empty queue does not look for child intents');
    } finally { app.database.snapshot = snapshot; app.database.snapshotAll = snapshotAll; }
  } finally { await fixture.close(); }
});

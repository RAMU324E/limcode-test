import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import NativeDatabase from 'better-sqlite3';
import { createBatchFixture, compiled, repo, NOW } from './fixtures/runtime-behavior-fixture.mjs';

test('context reads look up only the selected chain through the existing primary keys', async () => {
  const fixture = await createBatchFixture();
  let reader;
  try {
    await fixture.segments(['chain-first', 'chain-last', 'unrelated']);
    await fixture.database.transaction([
      repo('Conversation').insert({ id: 'chain-conversation', title: 'chain', status: 'active',
        created_at: NOW, updated_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'chain-node-first', parent_node_id: null,
        segment_id: 'chain-first', created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: 'chain-node-last', parent_node_id: 'chain-node-first',
        segment_id: 'chain-last', created_at: NOW }),
      repo('ContextSequenceRoot').insert({ id: 'chain-root', conversation_id: 'chain-conversation',
        root_seq: 1n, root_node_id: 'chain-node-last', tail_node_id: null, tail_segment_count: 0n,
        segment_count: 2n, estimated_tokens: 2n, created_at: NOW })
    ]);
    const structure = await fixture.database.materializeContext('chain-root');
    const content = await fixture.database.materializeContextContent('chain-root');
    for (const result of [structure, content]) {
      assert.deepEqual(result.snapshot.records.map(record => record.segment.id), ['chain-first', 'chain-last']);
    }
    for (const record of content.snapshot.records) {
      assert.equal(Buffer.from(record.content).toString('utf8'), 'shared context batch body');
    }
    // Explain the production query itself, so a join regression fails without a wall-clock threshold.
    const worker = await fs.readFile(path.join(compiled, 'backend/reliableKernel/databaseWorker.js'), 'utf8');
    const query = worker.split('function readContextChain(')[1]
      .split('function readContextRecord(')[0].match(/`([\s\S]*?)`\)\.all/)[1];
    await fixture.database.close();
    reader = new NativeDatabase(fixture.binding.paths.databasePath);
    reader.exec('ANALYZE');
    // Reproduce a populated store's planner estimates without creating thousands of test bodies.
    for (const [table, count] of [['context_sequence_node', 60000], ['context_segment', 50000], ['content_object', 300000]]) {
      reader.prepare("UPDATE sqlite_stat1 SET stat = ? || substr(stat, instr(stat, ' ')) WHERE tbl = ?")
        .run(String(count), table);
    }
    reader.exec('ANALYZE sqlite_schema');
    const plan = reader.prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all({ startNodeId: 'chain-node-last', segmentCount: 2n }).map(row => row.detail).join(' | ');
    assert.match(plan, /SEARCH segment USING .*\(id=\?\)/);
    assert.match(plan, /SEARCH content USING .*\(id=\?\)/);
    assert.doesNotMatch(plan, /SCAN (?:segment|content)\b/);
  } finally {
    reader?.close();
    await fixture.close();
  }
});

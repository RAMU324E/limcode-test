import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRoot, removeConfigurationRoot, withRuntime, kernelFile, repo, NOW, modelRequestAggregate } from './fixtures/runtime-merge-fixture.mjs';

test('token calibration reads bounded recent pages, keeps request sequence order and stops at the first incompatible prefix', async () => {
  const configuration = await createConfigurationRoot();
  try {
    await withRuntime(configuration.current, async (database, store) => {
      const cid = 'token-anchor-conversation', latest = 'latest-turn';
      const content = await store.ingest(database, '{}', 'application/json');
      const steps = [repo('Conversation').insert({ id: cid, title: cid, status: 'active', created_at: NOW, updated_at: NOW })];
      for (let i = 0; i < 65; i++) {
        const id = i === 64 ? latest : `old-turn-${i}`, at = i === 64 ? '2026-09-27T00:00:00.000Z' : NOW;
        steps.push(repo('Turn').insert({ id, conversation_id: cid, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
          repo('TurnTermination').insert({ id: `${id}-end`, turn_id: id, terminal_status: 'completed', reason: 'fixture', created_at: at }));
      }
      steps.push(repo('Message').insert({ id: 'output', created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: 'output-revision', message_id: 'output', revision_seq: 1n, role: 'model', content_object_id: content.id, created_at: NOW }),
        repo('ContextSequenceRoot').insert({ id: 'anchor-root', conversation_id: cid, root_seq: 1n, root_node_id: null,
          tail_node_id: null, tail_segment_count: 0n, segment_count: 0n, estimated_tokens: 0n, created_at: NOW }));
      for (let sequence = 1; sequence <= 35; sequence++) {
        const id = `request-${sequence}`;
        const aggregate = modelRequestAggregate(latest, id, BigInt(sequence), { recipe: content.id, body: content.id, checkpoints: 0 });
        const request = aggregate.find(step => step.domain === 'ModelRequest' && step.kind === 'insert');
        if (sequence === 3) request.row.usage_json = { prompt_tokens: 100, total_tokens: 120 };
        steps.push(...aggregate,
          ...(sequence === 3 ? [repo('ModelRequestMessageLink').insert({ id: `${id}-output`, model_request_id: id, message_id: 'output', created_at: NOW })] : []),
          repo('ModelContextProjection').insert({ id: `${id}-projection`, owner_kind: 'model_request', owner_id: id,
            root_id: 'anchor-root', purpose: 'model_request', created_at: NOW }));
      }
      await database.transaction(steps);
      const { ReliableContextTokenEstimator } = kernelFile('contextTokenEstimator.js');
      const estimator = new ReliableContextTokenEstimator(database, store);
      let compatible = true;
      estimator.context.materializeStructure = async () => ({ records: [{ segment: { id: compatible ? 'prefix' : 'other' } }] });
      const pages = [], originalSnapshot = database.snapshot.bind(database), originalAll = database.snapshotAll.bind(database);
      database.snapshotAll = async read => {
        assert.ok(!['Turn', 'ModelRequest'].includes(read.domain), 'calibration must not load an entire historical set');
        return originalAll(read);
      };
      database.snapshot = async reads => {
        const result = await originalSnapshot(reads);
        reads.forEach((read, index) => {
          if (read.kind === 'list' && ['Turn', 'ModelRequest'].includes(read.domain)) pages.push({ read, rows: result.snapshot[index] });
        });
        return result;
      };
      const current = [{ segmentId: 'prefix' }];
      const anchor = await estimator.findObservedPrefix(cid, current);
      assert.equal(anchor.modelRequestId, 'request-3');
      assert.equal(anchor.promptTokens, 100);
      assert.ok(pages.every(page => page.rows.length <= 16));
      assert.equal(pages.filter(page => page.read.domain === 'Turn').length, 1);
      assert.equal(pages.filter(page => page.read.domain === 'ModelRequest').length, 3);
      assert.ok(pages.every(page => page.read.orderBy.direction === 'desc'));
      compatible = false;
      assert.equal(await estimator.findObservedPrefix(cid, current), null);
    });
  } finally { await removeConfigurationRoot(configuration.root); }
});

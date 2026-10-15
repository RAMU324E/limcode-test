import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigurationRoot, kernelFile, NOW, removeConfigurationRoot, repo, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const { historicalProcessHandleCard } = kernelFile('historicalProcessHandleCard.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION: contract } = kernelFile('modelHandleCatalog.js');

test('historical process repair cards read only recent sources and reuse commands while refreshing status', async () => {
  const configuration = await createConfigurationRoot();
  try {
    await withRuntime(configuration.current, async (database, store) => {
      const conversationId = 'process-card-conversation', turnId = 'process-card-turn';
      const args = await store.ingest(database, JSON.stringify({ command: 'echo process card' }), 'application/json');
      await database.transaction([
        repo('Conversation').insert({ id: conversationId, title: 'process card', status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: 'process-card-end', turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
        ...Array.from({ length: 40 }, (_, index) => {
          const id = `process-card-${index + 1}`, createdAt = new Date(Date.parse(NOW) + index * 1000).toISOString();
          return [
            repo('ToolCall').insert({ id: id + '-call', turn_id: turnId, call_seq: BigInt(index + 1), tool_name: 'bash',
              status: 'completed', arguments_object_id: args.id, created_at: createdAt, updated_at: createdAt }),
            repo('Process').insert({ id, status: 'running', wrapper_nonce: id + '-nonce', wrapper_pid: 0n,
              child_pid: null, process_group_id: null, start_fingerprint: id, command_digest: id, spool_locator: id,
              retained_bytes: 0n, retained_chunks: 0n, dropped_bytes: 0n, truncated: 0n,
              started_at: createdAt, updated_at: createdAt, completed_at: null }),
            repo('ProcessCompletionSourceLink').insert({ id: id + '-source', process_id: id,
              conversation_id: conversationId, source_turn_id: turnId, source_tool_call_id: id + '-call', created_at: createdAt })
          ];
        }).flat()
      ]);
      const catalog = { identityContractRevision: contract, entries: Array.from({ length: 40 }, (_, index) => ({
        kind: 'process', ref: `P${index + 1}`, target: `process-card-${index + 1}` })), retiredRefs: ['P99'] };
      let bodies = 0;
      const requests = [], originalSnapshot = database.snapshot.bind(database), originalRead = store.read.bind(store);
      const originalSnapshotAll = database.snapshotAll.bind(database);
      database.snapshot = async reads => { requests.push(reads); return originalSnapshot(reads); };
      database.snapshotAll = async () => { throw new Error('A process card must not enumerate historical sources'); };
      store.read = async metadata => { bodies++; return originalRead(metadata); };
      const readCard = async value => JSON.parse((await historicalProcessHandleCard(database, store, conversationId, value)).split('\n').at(-1));
      try {
        assert.equal(await historicalProcessHandleCard(database, store, conversationId, { ...catalog, retiredRefs: [] }), undefined);
        assert.equal(requests.length, 0);
        const first = await readCard(catalog);
        assert.equal(first.processes.length, 32);
        assert.deepEqual(first.processes.map(row => row.processRef), Array.from({ length: 32 }, (_, i) => `P${40 - i}`));
        assert.equal(first.processes[0].command, 'echo process card');
        assert.equal(bodies, 1, 'the same immutable command is decoded only once');
        assert.equal(requests.length, 3, 'source, batched facts and uncached metadata use three worker requests');
        assert.deepEqual(requests[0][0].orderBy, { column: 'created_at', direction: 'desc' });
        assert.equal(requests[0][0].limit, 32);
        await database.transaction([repo('Process').update('process-card-40', {
          status: 'exited', completed_at: NOW, updated_at: NOW })]);
        requests.length = 0;
        const next = await readCard(catalog);
        assert.equal(next.processes[0].status, 'exited');
        assert.equal(next.processes[0].command, 'echo process card');
        assert.equal(bodies, 1, 'a later round does not reopen command bodies');
        assert.equal(requests.length, 2);
        const scoped = await readCard({ ...catalog, entries: catalog.entries.slice(0, -1) });
        assert.equal(scoped.processes.length, 31);
        assert.equal(scoped.processes[0].processRef, 'P39');
        assert.equal(scoped.processes.some(row => row.processRef === 'P8'), false, 'missing recent refs do not trigger a historical search');
      } finally {
        database.snapshot = originalSnapshot; database.snapshotAll = originalSnapshotAll; store.read = originalRead;
      }
    });
  } finally { await removeConfigurationRoot(configuration.root); }
});

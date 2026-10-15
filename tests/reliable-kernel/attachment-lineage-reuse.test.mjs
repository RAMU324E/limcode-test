import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { createConfigurationRoot, removeConfigurationRoot, withRuntime, kernelFile, repo, NOW, Database, compiled } from './fixtures/runtime-merge-fixture.mjs';

async function withPeerRuntime(database, run) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const path = require('node:path');
    const { RuntimeDatabase } = require(path.join(workerData.compiled, 'backend/reliableKernel/runtimeDatabase.js'));
    const { RootAuthority } = require(path.join(workerData.compiled, 'backend/reliableKernel/rootAuthority.js'));
    RuntimeDatabase.open(new RootAuthority(() => workerData.dataRootPath), { hostBootId: 'attachment-peer' }).then(database => {
      parentPort.on('message', async steps => {
        try {
          if (steps === null) { await database.close(); parentPort.postMessage({ ok: true }); parentPort.close(); }
          else { await database.transaction(steps); parentPort.postMessage({ ok: true }); }
        } catch (error) { parentPort.postMessage({ error: String(error.stack) }); }
      });
      parentPort.postMessage({ ok: true });
    }).catch(error => { throw error; });
  `, { eval: true, workerData: { compiled, dataRootPath: database.binding.paths.dataRootPath } });
  const exited = once(worker, 'exit');
  const send = async steps => {
    const response = once(worker, 'message');
    worker.postMessage(steps);
    const [result] = await response;
    if (result.error) throw new Error(result.error);
  };
  try {
    await once(worker, 'message');
    await run({ transaction: send });
  } finally { await send(null); await exited; }
}

test('attachment catalogs reuse compressed history after writes and window growth, and refresh changed old relationships', async () => {
  const configuration = await createConfigurationRoot();
  try {
    await withRuntime(configuration.current, async (database, store) => {
      const { AttachmentCatalogProjection } = kernelFile('attachmentCatalogProjection.js');
      const content = await store.ingest(database, 'fixture', 'text/plain');
      const cid = 'attachment-cache-conversation';
      await database.transaction([repo('Conversation').insert({ id: cid, title: cid, status: 'active', created_at: NOW, updated_at: NOW })]);
      const attachment = id => ({ attachmentId: id, name: id, mimeType: 'text/plain', sizeBytes: 7 });
      const attach = (id, revision, position = 0n) => [
        repo('Attachment').insert({ id, name: id, mime_type: 'text/plain', byte_length: 7n,
          sha256: content.sha256, storage_mode: 'cas', content_object_id: content.id, created_at: NOW }),
        repo('AttachmentLink').insert({ id: `${id}-link`, attachment_id: id, message_revision_id: revision, position, created_at: NOW })
      ];
      const message = (id, sequence) => [
        repo('Message').insert({ id, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: `${id}-revision`, message_id: id, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: `${id}-member`, conversation_id: cid, message_id: id, message_seq: sequence, created_at: NOW }),
        repo('ContextSegment').insert({ id: `${id}-segment`, content_object_id: content.id, segment_kind: 'message', created_at: NOW }),
        repo('ContextSegmentSource').insert({ id: `${id}-source`, segment_id: `${id}-segment`, source_kind: 'message_revision', source_id: `${id}-revision`, source_revision: 1n, created_at: NOW })
      ];
      const compression = (id, children) => [
        repo('CompressionBlock').insert({ id, conversation_id: cid, status: 'completed', authority_snapshot_id: 'fixture-authority',
          title_object_id: content.id, summary_object_id: content.id, created_at: NOW, updated_at: NOW }),
        repo('ContextSegment').insert({ id: `${id}-segment`, content_object_id: content.id, segment_kind: 'compression', created_at: NOW }),
        repo('ContextSegmentSource').insert({ id: `${id}-source`, segment_id: `${id}-segment`, source_kind: 'compression_block', source_id: id, source_revision: 0n, created_at: NOW }),
        ...children.map((segmentId, i) => repo('CompressionBlockSource').insert({ id: `${id}-child-${i}`, compression_block_id: id,
          segment_id: segmentId, position: BigInt(i), created_at: NOW }))
      ];
      await database.transaction([...message('old', 1n), ...attach('old-image', 'old-revision'),
        ...compression('summary-1', ['old-segment']), ...compression('summary-2', ['summary-1-segment'])]);
      const reads = [], links = [];
      const originalSegments = database.attachmentProjectionSegments.bind(database), originalLinks = database.attachmentProjectionLinks.bind(database);
      database.attachmentProjectionSegments = async (conversation, ids) => { reads.push(...ids); return originalSegments(conversation, ids); };
      database.attachmentProjectionLinks = async ids => { links.push(...ids); return originalLinks(ids); };
      const project = (...ids) => new AttachmentCatalogProjection(database).projectState(cid, ids.map(segmentId => ({ segmentId })));
      await withPeerRuntime(database, async peer => {
      assert.deepEqual((await project('summary-2-segment')).catalog, [attachment('old-image')]);
      const beforeExternal = (await database.inspect()).attachmentScopeCache;
      await database.externalClientChanges(true);
      await peer.transaction([repo('Conversation').update(cid, { title: 'a peer changed only the title', updated_at: NOW })]);
      await database.externalClientChanges();
      reads.length = links.length = 0;
      assert.deepEqual((await project('summary-2-segment')).catalog, [attachment('old-image')]);
      assert.deepEqual(reads, [], 'a peer title update does not expand historical compression, even after the feed consumes it');
      await originalSegments(cid, ['old-segment']);
      const afterExternal = (await database.inspect()).attachmentScopeCache;
      assert.equal(afterExternal.externalInvalidations, beforeExternal.externalInvalidations,
        'the worker source proofs also survive unrelated peer commits');
      assert.ok(afterExternal.hits > beforeExternal.hits);
      reads.length = links.length = 0;
      await database.transaction([repo('CommandReceipt').insert({ id: 'ordinary-write', source_kind: 'fixture', source_key: 'ordinary',
        conversation_id: cid, turn_id: null, created_at: NOW })]);
      await project('summary-2-segment');
      assert.deepEqual(reads, [], 'an unrelated commit does not expand historical compression');
      await database.transaction([...message('new', 2n), ...attach('new-image', 'new-revision')]);
      assert.deepEqual((await project('summary-2-segment', 'new-segment')).catalog, [attachment('old-image'), attachment('new-image')]);
      assert.deepEqual(reads, ['new-segment']);
      assert.deepEqual(links, ['new-revision']);
      reads.length = links.length = 0;
      await database.transaction(compression('summary-3', ['summary-2-segment', 'new-segment']));
      assert.deepEqual((await project('summary-3-segment')).catalog, [attachment('old-image'), attachment('new-image')]);
      assert.deepEqual(reads, ['summary-3-segment'], 'a new compression reuses already prepared children');
      assert.deepEqual(links, []);
      await database.transaction(attach('late-image', 'old-revision', 1n));
      assert.deepEqual((await project('summary-3-segment')).catalog,
        [attachment('old-image'), attachment('late-image'), attachment('new-image')]);
      reads.length = links.length = 0;
      let race = true;
      database.attachmentProjectionLinks = async ids => {
        const result = await originalLinks(ids);
        if (race && ids.includes('old-revision')) {
          race = false;
          await database.transaction(attach('race-image', 'old-revision', 2n));
        }
        return result;
      };
      const external = new Database(database.binding.paths.databasePath);
      try { external.prepare('DELETE FROM attachment_link WHERE attachment_id = ?').run('late-image'); } finally { external.close(); }
      assert.deepEqual((await project('summary-3-segment')).catalog, [attachment('old-image'), attachment('new-image')]);
      assert.ok(reads.includes('old-segment'), 'an external relationship change refreshes the compressed catalog');
      assert.deepEqual((await project('summary-3-segment')).catalog,
        [attachment('old-image'), attachment('race-image'), attachment('new-image')], 'a cold in-flight read must not cache relationships changed during its read');
      reads.length = links.length = 0;
      await peer.transaction(attach('external-image', 'old-revision', 3n));
      await database.externalClientChanges();
      assert.deepEqual((await project('summary-3-segment')).catalog,
        [attachment('old-image'), attachment('race-image'), attachment('external-image'), attachment('new-image')]);
      assert.ok(reads.includes('old-segment'), 'an external relationship insert refreshes the old compressed catalog');
      });
    });
  } finally { await removeConfigurationRoot(configuration.root); }
});

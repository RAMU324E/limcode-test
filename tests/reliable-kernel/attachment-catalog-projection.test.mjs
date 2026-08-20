import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as kernel from '../../dist/extension/backend/reliableKernel/index.js';

const NOW = '2026-08-20T00:00:00.000Z';

async function withRuntime(label, body) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${label}-`));
  let database;
  try {
    const candidate = await kernel.resetCandidateRuntimeRoot(parent);
    database = await kernel.RuntimeDatabase.open(candidate.authority, { hostBootId: label });
    const store = new kernel.ContentAddressedStore(candidate.authority, candidate.binding);
    const fixtureContent = await store.ingest(
      database,
      JSON.stringify({ role: 'user', parts: [{ text: 'fixture' }] }),
      'application/vnd.limcode.message+json'
    );
    await body(database, fixtureContent, store);
  } finally {
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

test('20 rounds and nested compression rebuild one request-local attachment catalog without durable copies', async () => {
  await withRuntime('attachment-catalog-lineage', async (database, fixtureContent, store) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const steps = [
      repository('Conversation').insert({
        id: 'conversation-main', title: 'main', status: 'active', created_at: NOW, updated_at: NOW
      }),
      repository('Turn').insert({
        id: 'turn-main', conversation_id: 'conversation-main', status: 'active',
        created_at: NOW, updated_at: NOW, terminal_at: null
      }),
      repository('Attachment').insert({
        id: 'attachment-only-source',
        sha256: 'a'.repeat(64),
        byte_length: 45678n,
        mime_type: 'application/pdf',
        name: 'source.pdf',
        storage_mode: 'managed',
        content_object_id: null,
        created_at: NOW
      })
    ];
    const segments = [];
    for (let index = 0; index < 20; index += 1) {
      const contentId = fixtureContent.id;
      const messageId = `message-${index}`;
      const revisionId = `revision-${index}`;
      const segmentId = `segment-${index}`;
      segments.push({ segmentId });
      steps.push(
        repository('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repository('MessageRevision').insert({
          id: revisionId,
          message_id: messageId,
          revision_seq: 0n,
          role: index % 2 === 0 ? 'user' : 'model',
          content_object_id: contentId,
          created_at: NOW
        }),
        repository('ContextSegment').insert({
          id: segmentId,
          content_object_id: contentId,
          segment_kind: 'message',
          created_at: NOW
        }),
        repository('ContextSegmentSource').insert({
          id: `segment-source-${index}`,
          segment_id: segmentId,
          source_kind: 'message_revision',
          source_id: revisionId,
          source_revision: 0n,
          created_at: NOW
        })
      );
    }
    steps.push(
      repository('AttachmentLink').insert({
        id: 'attachment-link-only-source',
        message_revision_id: 'revision-0',
        attachment_id: 'attachment-only-source',
        position: 0n,
        created_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'compression-block-main',
        conversation_id: 'conversation-main',
        status: 'active',
        authority_snapshot_id: 'authority-main',
        title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id,
        created_at: NOW,
        updated_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-compression-main',
        content_object_id: fixtureContent.id,
        segment_kind: 'compression',
        created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'segment-compression-main-source',
        segment_id: 'segment-compression-main',
        source_kind: 'compression_block',
        source_id: 'compression-block-main',
        source_revision: 0n,
        created_at: NOW
      }),
      ...segments.map((segment, index) => repository('CompressionBlockSource').insert({
        id: `compression-block-source-${index}`,
        compression_block_id: 'compression-block-main',
        segment_id: segment.segmentId,
        position: BigInt(index),
        created_at: NOW
      }))
    );
    await database.transaction(steps);

    const originalSnapshot = database.snapshot.bind(database);
    let projectionSnapshotCalls = 0;
    database.snapshot = async (...args) => {
      projectionSnapshotCalls += 1;
      return originalSnapshot(...args);
    };
    const projection = new kernel.AttachmentCatalogProjection(database);
    const expected = [{
      attachmentId: 'attachment-only-source',
      name: 'source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 45678
    }];
    for (let round = 0; round < 20; round += 1) {
      assert.deepEqual(await projection.project(segments), expected);
    }
    const relationCatalog = await projection.project([{ segmentId: 'segment-compression-main' }]);
    assert.deepEqual(relationCatalog, expected);
    const handles = kernel.buildModelHandleCatalog([relationCatalog]);
    assert.deepEqual(handles.entries, [{
      kind: 'attachment',
      ref: 'F1',
      target: 'attachment-only-source',
      name: 'source.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 45678
    }]);
    assert.deepEqual(
      kernel.resolveModelToolArguments('read', { attachmentRef: 'F1' }, handles),
      { attachmentId: 'attachment-only-source' }
    );
    const loop = Object.create(kernel.ReliableAgentLoop.prototype);
    loop.database = database;
    loop.contentStore = store;
    loop.context = {
      materialize: async () => ({
        segments: [{ segmentId: 'segment-compression-main', content: Buffer.from('{"kind":"fixture"}') }]
      })
    };
    loop.modelProvider = { projectAttachmentCatalog: async () => relationCatalog };
    loop.readCurrentTurnInputReference = async () => ({});
    loop.readRuntimeStatusCard = async () => undefined;
    const frozenRecipe = await loop.freezeOrdinaryRequestRecipe({
      turnId: 'turn-main',
      round: '1',
      headRootId: 'root-main',
      tools: [],
      includeOpenTaskCompletionCheck: false
    });
    assert.deepEqual(frozenRecipe.attachmentCatalog, expected);
    assert.deepEqual(frozenRecipe.modelHandleCatalog.entries, handles.entries);
    assert.ok(
      projectionSnapshotCalls <= 100,
      `cached 20-round + nested projection should use batched reads, observed ${projectionSnapshotCalls}`
    );
    database.snapshot = originalSnapshot;

    const [concurrentCatalog, concurrentEmpty] = await Promise.all([
      projection.project([{ segmentId: 'segment-compression-main' }]),
      projection.project([{ segmentId: 'segment-1' }])
    ]);
    assert.deepEqual(concurrentCatalog, expected);
    assert.deepEqual(concurrentEmpty, []);

    assert.deepEqual(await projection.project([{ segmentId: 'segment-1' }]), []);
    await database.transaction([
      repository('Attachment').insert({
        id: 'attachment-late-link',
        sha256: 'b'.repeat(64),
        byte_length: 12n,
        mime_type: 'text/plain',
        name: 'late.txt',
        storage_mode: 'managed',
        content_object_id: null,
        created_at: NOW
      }),
      repository('AttachmentLink').insert({
        id: 'attachment-link-late',
        message_revision_id: 'revision-1',
        attachment_id: 'attachment-late-link',
        position: 0n,
        created_at: NOW
      })
    ]);
    assert.deepEqual(await projection.project([{ segmentId: 'segment-1' }]), [{
      attachmentId: 'attachment-late-link',
      name: 'late.txt',
      mimeType: 'text/plain',
      sizeBytes: 12
    }]);

    const [attachments, links, compressionSources] = await Promise.all([
      database.snapshotAll(repository('Attachment').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 })),
      database.snapshotAll(repository('AttachmentLink').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 })),
      database.snapshotAll(repository('CompressionBlockSource').list({ orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))
    ]);
    assert.equal(attachments.snapshot.length, 2);
    assert.equal(links.snapshot.length, 2);
    assert.equal(compressionSources.snapshot.length, 20);
  });
});

test('message segment content mismatch fails closed before relation attachments are projected', async () => {
  await withRuntime('attachment-catalog-content-mismatch', async (database, fixtureContent, store) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    const otherContent = await store.ingest(
      database,
      JSON.stringify({ role: 'user', parts: [{ text: 'different durable content' }] }),
      'application/vnd.limcode.message+json'
    );
    await database.transaction([
      repository('Message').insert({
        id: 'message-content-mismatch', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      repository('MessageRevision').insert({
        id: 'revision-content-mismatch', message_id: 'message-content-mismatch', revision_seq: 0n,
        role: 'user', content_object_id: fixtureContent.id, created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-content-mismatch', content_object_id: otherContent.id,
        segment_kind: 'message', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'source-content-mismatch', segment_id: 'segment-content-mismatch',
        source_kind: 'message_revision', source_id: 'revision-content-mismatch',
        source_revision: 0n, created_at: NOW
      })
    ]);
    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project([{ segmentId: 'segment-content-mismatch' }]),
      /content does not match MessageRevision/
    );
  });
});

test('message source revision mismatch fails closed', async () => {
  await withRuntime('attachment-catalog-revision-mismatch', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    await database.transaction([
      repository('Message').insert({
        id: 'message-mismatch', created_at: NOW, updated_at: NOW, deleted_at: null
      }),
      repository('MessageRevision').insert({
        id: 'revision-mismatch', message_id: 'message-mismatch', revision_seq: 1n,
        role: 'user', content_object_id: fixtureContent.id, created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'segment-mismatch', content_object_id: fixtureContent.id,
        segment_kind: 'message', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'source-mismatch', segment_id: 'segment-mismatch',
        source_kind: 'message_revision', source_id: 'revision-mismatch',
        source_revision: 0n, created_at: NOW
      })
    ]);
    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project([{ segmentId: 'segment-mismatch' }]),
      /source_revision does not match revision_seq/
    );
  });
});

test('compression lineage cycles fail closed without damaging the original expandable source', async () => {
  await withRuntime('attachment-catalog-cycle', async (database, fixtureContent) => {
    const repository = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
    await database.transaction([
      repository('Conversation').insert({
        id: 'conversation-cycle', title: 'cycle', status: 'active', created_at: NOW, updated_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'cycle-block-a', conversation_id: 'conversation-cycle', status: 'active',
        authority_snapshot_id: 'authority-cycle', title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id, created_at: NOW, updated_at: NOW
      }),
      repository('CompressionBlock').insert({
        id: 'cycle-block-b', conversation_id: 'conversation-cycle', status: 'active',
        authority_snapshot_id: 'authority-cycle', title_object_id: fixtureContent.id,
        summary_object_id: fixtureContent.id, created_at: NOW, updated_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'cycle-segment-a', content_object_id: fixtureContent.id, segment_kind: 'compression', created_at: NOW
      }),
      repository('ContextSegment').insert({
        id: 'cycle-segment-b', content_object_id: fixtureContent.id, segment_kind: 'compression', created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'cycle-source-a', segment_id: 'cycle-segment-a', source_kind: 'compression_block',
        source_id: 'cycle-block-a', source_revision: 0n, created_at: NOW
      }),
      repository('ContextSegmentSource').insert({
        id: 'cycle-source-b', segment_id: 'cycle-segment-b', source_kind: 'compression_block',
        source_id: 'cycle-block-b', source_revision: 0n, created_at: NOW
      }),
      repository('CompressionBlockSource').insert({
        id: 'cycle-block-source-a', compression_block_id: 'cycle-block-a',
        segment_id: 'cycle-segment-b', position: 0n, created_at: NOW
      }),
      repository('CompressionBlockSource').insert({
        id: 'cycle-block-source-b', compression_block_id: 'cycle-block-b',
        segment_id: 'cycle-segment-a', position: 0n, created_at: NOW
      })
    ]);

    const projection = new kernel.AttachmentCatalogProjection(database);
    await assert.rejects(
      projection.project([{ segmentId: 'cycle-segment-a' }]),
      /Compression lineage cycle detected/
    );
    const sources = await database.snapshotAll(repository('CompressionBlockSource').list({
      orderBy: { column: 'id', direction: 'asc' }, limit: 10
    }));
    assert.deepEqual(
      sources.snapshot.map((row) => row.id).sort(),
      ['cycle-block-source-a', 'cycle-block-source-b']
    );
  });
});

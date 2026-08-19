import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);

async function createWebviewTestServer() {
  return createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
}

test('process stream detail pages every CAS chunk beyond the projection window', async () => {
  const processId = 'process-detail-regression';
  const buffers = new Map();
  const rows = [];
  const expectedParts = [];
  for (let index = 0; index < 301; index += 1) {
    const bytes = index === 149
      ? Buffer.from([0xf0, 0x9f])
      : index === 150
        ? Buffer.from([0x99, 0x82])
        : Buffer.from(`${index.toString().padStart(3, '0')}|`, 'utf8');
    const objectId = `content-${index}`;
    buffers.set(objectId, bytes);
    rows.push({
      id: `chunk-${index.toString().padStart(4, '0')}`,
      process_id: processId,
      chunk_seq: BigInt(index + 1),
      stream_kind: 'stdout',
      content_object_id: objectId,
      byte_length: BigInt(bytes.length),
      created_at: '2026-08-04T00:00:00.000Z'
    });
    expectedParts.push(bytes);
  }
  const expected = Buffer.concat(expectedParts);
  const processRow = {
    id: processId,
    retained_bytes: BigInt(expected.length),
    retained_chunks: BigInt(rows.length)
  };
  let chunkIndexReads = 0;
  const database = {
    async snapshot(reads) {
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => {
          if (read.kind !== 'get') throw new Error(`unexpected read ${read.kind}`);
          if (read.domain === 'Process' && read.id === processId) return processRow;
          if (read.domain === 'ContentObject' && buffers.has(read.id)) {
            const bytes = buffers.get(read.id);
            return { id: read.id, byte_length: BigInt(bytes.length) };
          }
          return null;
        })
      };
    },
    async snapshotAll(read) {
      chunkIndexReads += 1;
      assert.equal(read.domain, 'ProcessOutputChunk');
      assert.deepEqual(read.where, { process_id: processId });
      return { snapshotCommitSeq: '1', snapshot: rows };
    }
  };
  const contentStore = {
    async readChunk(metadata, offset, maxBytes) {
      const bytes = buffers.get(metadata.id);
      assert.ok(bytes);
      return {
        chunk: bytes.subarray(offset, Math.min(bytes.length, offset + maxBytes)),
        totalBytes: bytes.length
      };
    }
  };
  const reader = new kernel.ClientDetailReader(database, contentStore);
  reader.setProcessOutputReconciler(async () => ({
    retainedBytes: String(expected.length),
    retainedChunks: String(rows.length),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  }));
  const pages = [];
  let offset = 0;
  for (;;) {
    const page = await reader.read({
      kind: 'process-stdout', recordId: processId, offset, maxBytes: 257
    });
    pages.push(Buffer.from(page.chunk, 'base64'));
    if (!page.hasMore) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  const actual = Buffer.concat(pages);
  assert.deepEqual(actual, expected);
  assert.equal(actual.toString('utf8').includes('�'), false);
  assert.equal(chunkIndexReads, 1, 'page reads reuse the rebuildable metadata index instead of rescanning every chunk');
});

test('concurrent Message detail reads batch immutable Revision and ContentObject metadata', async () => {
  const revisionIds = Array.from({ length: 4 }, (_, index) => `revision-batch-${index}`);
  const bodies = new Map(revisionIds.map((revisionId, index) => [
    `content-batch-${index}`,
    Buffer.from(`${revisionId}:${'x'.repeat(160)}`, 'utf8')
  ]));
  const snapshotCalls = [];
  const database = {
    async snapshot(reads) {
      snapshotCalls.push(reads.map((read) => `${read.domain}:${read.id}`));
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => {
          if (read.domain === 'MessageRevision') {
            const index = revisionIds.indexOf(read.id);
            return index < 0 ? null : { id: read.id, content_object_id: `content-batch-${index}` };
          }
          if (read.domain === 'ContentObject' && bodies.has(read.id)) return { id: read.id };
          return null;
        })
      };
    }
  };
  const contentStore = {
    async readChunk(metadata, offset, maxBytes) {
      const bytes = bodies.get(metadata.id);
      assert.ok(bytes);
      const end = Math.min(bytes.length, offset + maxBytes);
      return { chunk: bytes.subarray(offset, end), totalBytes: bytes.length };
    }
  };
  const reader = new kernel.ClientDetailReader(database, contentStore);
  const firstPages = await Promise.all(revisionIds.map((recordId) => reader.read({
    kind: 'message-content', recordId, offset: 0, maxBytes: 64
  })));
  assert.equal(firstPages.every((page) => page.hasMore), true);
  assert.equal(snapshotCalls.length, 2);
  assert.deepEqual(snapshotCalls[0], revisionIds.map((id) => `MessageRevision:${id}`));
  assert.deepEqual(snapshotCalls[1], revisionIds.map((_, index) => `ContentObject:content-batch-${index}`));

  await Promise.all(firstPages.map((page, index) => reader.read({
    kind: 'message-content', recordId: revisionIds[index], offset: page.nextOffset, maxBytes: 64
  })));
  assert.equal(snapshotCalls.length, 2,
    'continuation pages reuse immutable metadata instead of issuing two more worker reads each');
});

test('client summary keeps a long provider_call_id byte-for-byte', async () => {
  const providerCallId = `provider-${'identity'.repeat(600)}`;
  const projection = {
    navigationSummary: { conversations: [] },
    activeConversationWindow: {
      conversationId: 'conversation-provider-id', messages: [], visibleMessageCount: '0',
      lastMessageSeq: '0', projectContexts: [], conversationProjectLinks: [],
      conversationReuseLinks: [], conversationBranchLinks: [], conversationOriginLinks: [],
      agentConversationLinks: [], queuedTurnIntents: [], compressionBlocks: [], conversationContextStatuses: [], taskList: []
    },
    activeTurnSummary: {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [],
      modelRequests: [], modelRequestMessageLinks: []
    },
    activeToolAndInteractionSummary: {
      messageTurnLinks: [], toolCalls: [],
      toolCallSourceLinks: [{
        id: 'source-link', tool_call_id: 'tool-call', model_request_id: 'model-request',
        provider_call_id: providerCallId, provider_ordinal: '0',
        display_text: 'x'.repeat(8_000)
      }],
      toolCallPolicySnapshots: [], toolCallEvents: [], toolExecutions: [], toolOutcomes: [],
      toolModelResults: [], toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [],
      interactionToolCallLinks: [], interactionResponses: [], fileChangeSets: [], fileChangeSetMembers: [],
      fileChangeDecisions: [], fileMutationReceipts: [], fileMutationReceiptMembers: [], processes: [],
      processOriginLinks: [], processOutputChunks: [], processReceipts: []
    },
    subagentDeliverySummary: {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childExecutionLeases: [],
      childTurnTerminations: [], childTurnExecutorLinks: [], answerBridges: [], answerSubmissions: [],
      runtimeInboxItems: [], runtimeDeliveries: []
    }
  };
  const sent = [];
  const database = {
    hostBootId: 'provider-id-boot',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe() {
      return {
        barrier: { snapshotCommitSeq: '1', snapshot: projection },
        unsubscribe() {}
      };
    }
  };
  const feed = new kernel.BoundedClientFeed(database);
  const connection = await feed.connect({
    activeConversationId: 'conversation-provider-id',
    send(message) { sent.push(message); }
  });
  const link = sent[0].projections.activeToolAndInteractionSummary.toolCallSourceLinks[0];
  assert.equal(link.provider_call_id, providerCallId);
  assert.equal(link.summary_truncated, true);
  feed.disconnect(connection.sessionId);
});

test('streaming tool preview coalesces updates by animation frame and commits final immediately', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const frames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 1;
  let app;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    }
  };
  context.after(async () => {
    app?.unmount();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const vue = await import('vue');
  const { default: StreamingToolCallPreview } = await server.ssrLoadModule(
    '/src/components/content/parts/StreamingToolCallPreview.vue'
  );
  // ssrLoadModule only emits ssrRender; this test exercises setup/watch scheduling, not the template.
  StreamingToolCallPreview.render = () => null;
  const previewState = (updatedAt, final = false) => ({
    id: 'preview:call-frame',
    callId: 'call-frame',
    name: 'custom_tool',
    argumentsText: '',
    receivedChars: 0,
    final,
    createdAt: 1,
    updatedAt
  });
  const preview = vue.ref(previewState(1));
  const renderer = vue.createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement() { return {}; },
    createText() { return {}; },
    createComment() { return {}; },
    setText() {},
    setElementText() {},
    parentNode() { return null; },
    nextSibling() { return null; },
    querySelector() { return null; },
    setScopeId() {},
    cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  app = renderer.createApp(vue.defineComponent({
    setup() {
      return () => vue.h(StreamingToolCallPreview, {
        preview: preview.value,
        active: true
      });
    }
  }));
  app.provide(vue.ssrContextKey, { modules: new Set() });
  app.mount({});
  await vue.nextTick();
  assert.equal(frames.size, 0, 'the initial preview is visible without waiting for a frame');

  preview.value = previewState(2);
  await vue.nextTick();
  assert.equal(frames.size, 1);
  const firstFrameId = [...frames.keys()][0];

  preview.value = previewState(3);
  await vue.nextTick();
  assert.deepEqual([...frames.keys()], [firstFrameId], 'fast updates share one pending frame');

  const firstFrame = frames.get(firstFrameId);
  frames.delete(firstFrameId);
  firstFrame(performance.now());
  await vue.nextTick();
  preview.value = previewState(4);
  await vue.nextTick();
  assert.equal(frames.size, 1, 'an update after the prior frame schedules the next natural frame');
  const finalFrameId = [...frames.keys()][0];

  preview.value = previewState(5, true);
  await vue.nextTick();
  assert.equal(frames.size, 0, 'final state does not wait for the pending animation frame');
  assert.deepEqual(cancelledFrames, [finalFrameId]);
});

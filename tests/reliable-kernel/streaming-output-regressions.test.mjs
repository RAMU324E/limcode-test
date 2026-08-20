import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);
const clientFeedShared = await import(pathToFileURL(path.join(
  root,
  'dist/extension/shared/reliableKernelClientFeed.js'
)).href);

function emptyClientProjection() {
  return {
    navigationSummary: { conversations: [] },
    activeConversationWindow: {
      conversationId: '', messages: [], visibleMessageCount: '0', lastMessageSeq: '0',
      projectContexts: [], conversationProjectLinks: [], conversationReuseLinks: [],
      conversationBranchLinks: [], conversationOriginLinks: [], agentConversationLinks: [],
      queuedTurnIntents: [], compressionBlocks: [], conversationContextStatuses: [], taskList: []
    },
    activeTurnSummary: {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [],
      modelRequests: [], modelContextProjections: [], modelRequestMessageLinks: []
    },
    activeToolAndInteractionSummary: {
      messageTurnLinks: [], toolCalls: [], toolCallSourceLinks: [], toolCallPolicySnapshots: [],
      toolCallEvents: [], toolExecutions: [], toolOutcomes: [], toolModelResults: [],
      toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [],
      interactionToolCallLinks: [], interactionResponses: [], fileChangeSets: [],
      fileChangeSetMembers: [], fileChangeDecisions: [], fileMutationReceipts: [],
      fileMutationReceiptMembers: [], processes: [], processOriginLinks: [], processOutputChunks: [],
      processReceipts: []
    },
    subagentDeliverySummary: {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childExecutionLeases: [],
      childTurnTerminations: [], childTurnExecutorLinks: [], childExecutionActivities: [],
      answerBridges: [], answerSubmissions: [], runtimeInboxItems: [], runtimeDeliveries: []
    }
  };
}

async function createWebviewTestServer() {
  return createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
}

test('detail load errors use bounded backoff, manual reset, and durable invalidation', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const posted = [];
  let persistedState;
  let nextTimerId = 1;
  const timers = new Map();
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(performance.now());
      return 1;
    },
    cancelAnimationFrame() {},
    acquireVsCodeApi() {
      return {
        postMessage(message) { posted.push(message); },
        getState() { return persistedState; },
        setState(value) { persistedState = value; }
      };
    }
  };
  context.after(async () => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule(
    '/src/stores/useReliableKernelClientFeedStore.ts'
  );
  pinia.setActivePinia(pinia.createPinia());
  const store = useReliableKernelClientFeedStore();
  store.observe({
    type: 'reliable-kernel.snapshot',
    sessionId: 'detail-retry-session',
    hostBootId: 'detail-retry-boot',
    messageSeq: '1',
    snapshotCommitSeq: '1',
    projections: {}
  });

  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };

  const memberId = 'member-detail-retry';
  const detailKey = `file-change-diff:${memberId}`;
  const detailRequests = () => posted.filter((message) => message.type === 'reliable-kernel.detail-request');
  const failLatest = (message) => {
    const request = detailRequests().at(-1);
    assert.ok(request);
    store.observe({
      type: 'reliable-kernel.detail-error',
      requestId: request.requestId,
      sessionId: 'detail-retry-session',
      message
    });
  };
  const runTimer = (delay) => {
    const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(timer, `expected a ${delay}ms retry timer`);
    timers.delete(timer[0]);
    timer[1].callback();
  };

  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 1);
  failLatest('first failure');
  assert.equal(store.details[detailKey].retryCount, 1);
  runTimer(250);
  assert.equal(detailRequests().length, 2);
  failLatest('second failure');
  runTimer(750);
  assert.equal(detailRequests().length, 3);
  failLatest('third failure');
  runTimer(2_000);
  assert.equal(detailRequests().length, 4);
  failLatest('fourth failure');
  assert.equal(store.details[detailKey].status, 'error');
  assert.equal(store.details[detailKey].retryCount, 4);
  assert.equal([...timers.values()].some((timer) => timer.delay < 20_000), false,
    'automatic retries stop after the three configured retry admissions');

  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 4, 'ordinary demand must not bypass an exhausted retry budget');
  store.retryDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 5, 'manual retry resets the exhausted budget immediately');
  assert.equal(store.details[detailKey].status, 'loading');
  failLatest('manual attempt failure');
  assert.equal(store.details[detailKey].retryCount, 1);

  store.observe({
    type: 'reliable-kernel.changes',
    sessionId: 'detail-retry-session',
    hostBootId: 'detail-retry-boot',
    messageSeq: '2',
    commitSeq: '2',
    changes: [{
      type: 'FileChangeSetMember',
      operation: 'upsert',
      id: memberId,
      record: { id: memberId, change_set_id: 'change-set-detail-retry' }
    }]
  });
  assert.equal(store.details[detailKey], undefined, 'a durable member revision invalidates its stale error cache');
  assert.equal([...timers.values()].some((timer) => timer.delay === 250), false,
    'durable invalidation also cancels the pending retry timer');
  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 6, 'fresh demand is admitted after durable invalidation');
});

test('completed transient tool preview remains authoritative until message body and tool facts are ready', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());
  const { reconcileReliableTransientRequests } = await server.ssrLoadModule(
    '/src/domain/reliableTransientLifecycle.ts'
  );
  const requests = {
    'request-tool-handoff': {
      conversationId: 'conversation-tool-handoff',
      turnId: 'turn-tool-handoff',
      modelRequestId: 'request-tool-handoff',
      requestSeq: '1',
      providerId: 'provider',
      modelId: 'model',
      afterCommitSeq: '1',
      streamSeq: '3',
      text: '',
      thought: '',
      outputParts: [{ id: 'provider-call-handoff', functionCall: { name: 'read', args: { path: 'a.ts' } } }],
      toolCalls: [{
        id: 'preview:provider-call-handoff',
        callId: 'provider-call-handoff',
        name: 'read',
        argumentsText: '{"path":"a.ts"}',
        receivedChars: 15,
        final: true,
        createdAt: 1,
        updatedAt: 2
      }],
      status: 'completed',
      startedAt: 1,
      updatedAt: 2
    }
  };
  const records = {
    ModelRequest: {
      'request-tool-handoff': {
        id: 'request-tool-handoff',
        turn_id: 'turn-tool-handoff',
        request_seq: '1',
        status: 'terminal',
        terminal_state: 'completed'
      }
    },
    ModelRequestMessageLink: {
      link: {
        id: 'link',
        model_request_id: 'request-tool-handoff',
        message_id: 'message-tool-handoff'
      }
    },
    Message: {
      'message-tool-handoff': {
        id: 'message-tool-handoff',
        revision_id: 'revision-tool-handoff'
      }
    },
    ToolCall: {
      'tool-call-handoff': {
        id: 'tool-call-handoff',
        turn_id: 'turn-tool-handoff',
        tool_name: 'read'
      }
    },
    ToolCallSourceLink: {
      source: {
        id: 'source',
        tool_call_id: 'tool-call-handoff',
        model_request_id: 'request-tool-handoff',
        message_id: 'message-tool-handoff',
        provider_call_id: 'provider-call-handoff',
        provider_ordinal: 0
      }
    }
  };

  reconcileReliableTransientRequests(requests, records, {});
  assert.ok(requests['request-tool-handoff'], 'durable shell/tool rows alone cannot retire the visible preview');
  reconcileReliableTransientRequests(requests, records, {
    'message-content:revision-tool-handoff': { status: 'ready', text: '{}', totalBytes: 2 }
  });
  assert.equal(requests['request-tool-handoff'], undefined,
    'the preview retires once the durable message body and matching tool facts can render');

  const component = fs.readFileSync(path.join(
    root,
    'webview/src/components/content/parts/FunctionCallPartView.vue'
  ), 'utf8');
  assert.match(component, /if \(!partId \|\| !props\.messageId\) return undefined;/);
  assert.doesNotMatch(component, /!props\.messageId \|\| toolCall\.value/,
    'a newly visible durable ToolCall must not prematurely hide the retained preview');
});

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

test('slow ACK compacts unsent visible commits without allocating wire sequence gaps or snapshot fallback', async () => {
  let onCommit;
  const projection = emptyClientProjection();
  const database = {
    hostBootId: 'backpressure-boot',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe(_conversationId, listener) {
      onCommit = listener;
      return {
        barrier: { snapshotCommitSeq: '0', snapshot: projection },
        unsubscribe() {}
      };
    },
    async clientProjectionSnapshot() {
      return { snapshotCommitSeq: '0', snapshot: projection };
    }
  };
  const sent = [];
  const feed = new kernel.BoundedClientFeed(database);
  const connection = await feed.connect({ send(message) { sent.push(message); } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageSeq, '1');

  for (let index = 1; index <= 50; index += 1) {
    onCommit({
      commitSeq: String(index),
      changes: [{
        domain: 'Conversation',
        kind: 'upsert',
        id: 'conversation-backpressure',
        record: {
          id: 'conversation-backpressure',
          title: `latest-${index}`,
          status: 'active',
          created_at: '2026-08-20T00:00:00.000Z',
          updated_at: `2026-08-20T00:00:${String(index % 60).padStart(2, '0')}.000Z`
        }
      }]
    });
  }

  const queued = feed.inspectSession(connection.sessionId);
  assert.equal(queued.snapshotRequired, false);
  assert.equal(queued.queuedBatches, 1);
  assert.equal(queued.nextMessageSeq, '2', 'unsent compacted batches do not consume transport sequence ids');

  feed.acknowledge({
    sessionId: connection.sessionId,
    hostBootId: connection.hostBootId,
    messageSeq: '1'
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'reliable-kernel.changes');
  assert.equal(sent[1].messageSeq, '2');
  assert.equal(sent[1].commitSeq, '50');
  assert.equal(sent[1].changes.length, 1);
  assert.equal(sent[1].changes[0].record.title, 'latest-50');

  let state = clientFeedShared.createEmptyReliableKernelClientState();
  let applied = clientFeedShared.applyReliableKernelDataMessage(state, sent[0]);
  assert.equal(applied.snapshotRequired, false);
  state = applied.state;
  applied = clientFeedShared.applyReliableKernelDataMessage(state, sent[1]);
  assert.equal(applied.snapshotRequired, false, applied.reason);
  assert.equal(applied.state.records.Conversation['conversation-backpressure'].title, 'latest-50');
  feed.disconnect(connection.sessionId);
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

test('retry activity disappears as soon as the current attempt renders model output', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());
  const { reliableRetryStreamingActivityLabel } = await server.ssrLoadModule(
    '/src/domain/reliableTransientActivity.ts'
  );

  assert.equal(reliableRetryStreamingActivityLabel({
    retryAttempt: 1,
    retryMaxAttempts: 3,
    hasVisibleOutput: false
  }), '第 1/3 次自动恢复已启动，正在连接并等待 LLM 输出');
  assert.equal(reliableRetryStreamingActivityLabel({
    retryAttempt: 1,
    retryMaxAttempts: 3,
    hasVisibleOutput: true
  }), undefined);
});

test('streaming tool preview coalesces updates by frame and preserves pending partial before final', async (context) => {
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
  const partialFrameId = [...frames.keys()][0];

  preview.value = previewState(5, true);
  await vue.nextTick();
  assert.deepEqual([...frames.keys()], [partialFrameId], 'final keeps the pending partial frame');
  assert.deepEqual(cancelledFrames, []);

  const partialFrame = frames.get(partialFrameId);
  frames.delete(partialFrameId);
  partialFrame(performance.now());
  await vue.nextTick();
  assert.equal(frames.size, 1, 'final is scheduled for the frame after the pending partial');
  const finalFrameId = [...frames.keys()][0];
  assert.notEqual(finalFrameId, partialFrameId);

  const finalFrame = frames.get(finalFrameId);
  frames.delete(finalFrameId);
  finalFrame(performance.now());
  await vue.nextTick();
  assert.equal(frames.size, 0);

  preview.value = previewState(6, true);
  await vue.nextTick();
  assert.equal(frames.size, 0, 'final without a pending partial is still committed immediately');
});

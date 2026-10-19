import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import http from 'node:http';

import os from 'node:os';

import path from 'node:path';

import test from 'node:test';

import { once } from 'node:events';

import { setTimeout as delay } from 'node:timers/promises';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { applyReliableKernelDataMessage, createEmptyReliableKernelClientState } =
  require(path.join(compiledRoot, 'shared/reliableKernelClientFeed.js'));
const { LogicalMessageContentReader, MESSAGE_CONTENT_TYPE, NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE,
  NATIVE_MESSAGE_BLOCK_CONTENT_TYPE, prepareNativeMessageComposition,
  serializeNativeMessageItem } = require(path.join(compiledRoot, 'backend/reliableKernel/logicalMessageContent.js'));
const { AcceptedAnswerTextPages } = require(path.join(compiledRoot, 'backend/reliableKernel/acceptedAnswerTextPages.js'));
const { preparedContentObjectSteps } = require(path.join(compiledRoot, 'backend/reliableKernel/contentObjectTransaction.js'));

const { emptyConversationContextHandleStateStep } = require(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js'));

const { createLlmProviderCapability } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));

const MODEL = 'gpt-6-astra';

const CONVERSATION = 'native-http-context-completeness';

const NATIVE = { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(read, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function contextParts(app) {
  const [head] = await rows(app, 'ConversationContextHeadLink', { conversation_id: CONVERSATION });
  const window = await app.context.materialize(head.root_id);
  return window.segments.flatMap(segment => {
    const contentType = segment.contentObject.content_type;
    if (!contentType.endsWith('+json') && contentType !== 'application/json') return [];
    const payload = JSON.parse(segment.content.toString('utf8'));
    return payload.parts ?? [payload];
  });
}

function assertOnce(value, markers, label) {
  const serialized = JSON.stringify(value);
  for (const marker of markers) {
    assert.equal(serialized.split(marker).length - 1, 1, `${label} must contain ${marker} exactly once`);
  }
}

async function aggregateParts(app, modelRequestId) {
  const [link] = await rows(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId });
  const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: link.message_id });
  const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
  const [content] = await rows(app, 'ContentObject', { id: revision.content_object_id });
  return JSON.parse((await new LogicalMessageContentReader(app.database, app.contentStore).read(content)).toString('utf8')).parts;
}

// Deliberately use the real HTTP provider, Runtime writer, SQLite and CAS. Mocked provider events
// would skip the SSE decoder whose missing item completion caused this regression.
async function withHttpRuntime(run, { providerAdapter, retryPolicy = { enabled: false, maxRetries: 0 },
  modelProfile = { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
    tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } } } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-http-context-'));
  const slowTool = deferred();
  const frames = [];
  const drives = [];
  const transients = [];
  let app;
  let executionCount = 0;
  let sequence = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      frames.push({ response, body: JSON.parse(body) });
      response.flushHeaders();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const configuration = {
    id: 'native-http-context-provider', name: 'Native HTTP Context', provider: 'openai-responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: MODEL,
    models: [{ id: MODEL, name: MODEL }], apiKey: 'offline-test-key',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', nativeResponses: NATIVE,
    stream: true, retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
  const adapter = providerAdapter ?? new kernel.LlmCapabilityFullRequestAdapter(configuration.id,
    createLlmProviderCapability({ settings: configuration }));
  const tool = {
    declaration: {
      name: 'native_probe', description: 'Run an isolated native HTTP test probe.',
      parameters: { type: 'object', properties: { slow: { type: 'boolean' } }, additionalProperties: false },
      source: { kind: 'builtin' },
      metadata: { readonly: true, defaultAutoApproveExecution: true, defaultAutoSubmitResult: true }
    },
    execution: 'runtime',
    async execute(arguments_, _dependencies, context) {
      executionCount += 1;
      if (arguments_.slow === true) await slowTool.promise;
      context.signal.throwIfAborted();
      return { ok: true, output: arguments_.slow === true ? 'slow-probe-result' : 'fast-probe-result' };
    }
  };
  const dependencies = {
    transientObserver: { observe(event) { transients.push(event); } },
    authorityCompiler: { async compile(request) {
      return {
        turnId: request.turnId, executorAgentId: request.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: configuration.id, modelId: MODEL }) },
        authoritySnapshot: { content: JSON.stringify({
          kind: 'effective-turn-authority', turnId: request.turnId,
          conversationId: request.conversationId, executorAgentId: request.executorAgentId,
          model: { providerConfigId: configuration.id, provider: configuration.provider, modelId: MODEL,
            baseUrl: configuration.baseUrl, openaiResponsesTransport: 'http', nativeResponses: NATIVE,
            retryPolicy },
          modelProfile,
          planReviewPolicy: { mode: 'never' },
          toolPolicy: { id: 'native-http-context-policy', allowedTools: ['native_probe'], preset: 'custom',
            toolConfigs: { native_probe: { nativeAsync: true, autoApproveExecution: true,
              autoSubmitResult: true, config: {} } }, sourceConfigs: {} },
          systemPrompt: { id: 'native-http-context-prompt', text: '' },
          runtimeContext: { id: null, name: '', template: '' },
          workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [],
            defaultWorkEnvironmentId: null }
        }) }
      };
    } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('not an MCP tool'); } },
    mcpPolicyGate: { async authorize() { assert.fail('not an MCP tool'); } },
    attachmentSettings: { async loadGlobalSettings() {
      return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
    } },
    providers: { resolve(providerId) { assert.equal(providerId, configuration.id); return adapter; } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects,
        files, fileMutations, processes, mcp, interactions, host: {
          definitions() { return [tool]; },
          executeNoEffect(definition, input, _authority, emit, signal) {
            return definition.execute(input.arguments, undefined, { signal, emit });
          }
        } })
  };
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  function send(response, event) {
    response.write(`data: ${JSON.stringify({ sequence_number: ++sequence, ...event })}\n\n`);
  }
  function done(response, responseId, index, item) {
    send(response, { type: 'response.output_item.done', response_id: responseId, output_index: index, item });
  }
  function content(response, responseId, index, value, { thought = false, delta = true, close = true, signature = true } = {}) {
    const item = thought
      ? { type: 'reasoning', id: `${responseId}-reasoning-${index}`,
          summary: [{ type: 'summary_text', text: value }], ...(signature ? { encrypted_content: `signature-${value}` } : {}) }
      : { type: 'message', id: `${responseId}-message-${index}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: value, annotations: [] }] };
    if (delta) {
      send(response, { type: 'response.output_item.added', response_id: responseId, output_index: index,
        item: thought ? { type: 'reasoning', id: item.id, summary: [] }
          : { ...item, status: 'in_progress', content: [] } });
      send(response, { type: thought ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta',
        response_id: responseId, item_id: item.id, output_index: index,
        ...(thought ? { summary_index: 0 } : { content_index: 0 }), delta: value });
    }
    if (close) done(response, responseId, index, item);
    return item;
  }
  function completed(response, responseId, output) {
    send(response, { type: 'response.completed', response: { id: responseId, status: 'completed',
      model: MODEL, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    response.end('data: [DONE]\n\n');
  }
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: CONVERSATION,
        title: 'Native HTTP Context', status: 'active', created_at: now, updated_at: now }),
      emptyConversationContextHandleStateStep(CONVERSATION, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'native-http-context-agent',
        conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    await run({
      get app() { return app; }, frames, send, done, content, completed, until, transients,
      releaseTool: () => slowTool.resolve(), executions: () => executionCount,
      created(response, responseId) {
        send(response, { type: 'response.created', response: { id: responseId,
          status: 'in_progress', model: MODEL, output: [] } });
      },
      async startTurn(key) {
        const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: CONVERSATION,
          leaseOwnerId: 'native-http-context-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: `HTTP completeness ${key}.` });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
        assert.ok(lease, 'the test drives under its actual execution lease');
        const completion = kernel.runWithExecutionLeaseFence({ id: lease.id, conversationId: lease.conversation_id,
          turnId: lease.turn_id, ownerId: lease.owner_id, hostBootId: lease.host_boot_id,
          generation: BigInt(lease.generation) }, () => app.agentLoop.drive(started.turnId));
        void completion.catch(() => {});
        drives.push(completion);
        return { ...started, completion };
      },
      async reopen() {
        await app.close();
        app = await kernel.ReliableKernelApplication.open(authority, dependencies);
      }
    });
  } finally {
    slowTool.resolve();
    for (const frame of frames) frame.response.destroy();
    if (app) await app.close();
    await Promise.allSettled(drives);
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function registerCases(test) {

test('a published noncanonical native prefix appends bounded blocks from recovered items without rereading old bodies',
  { timeout: 15_000 }, async () => {
    await withHttpRuntime(async h => {
      const parts = Array.from({ length: 35 }, (_, index) => ({ text: `旧项 ${index} 🙂\n`,
        outputItem: { id: `old-item-${index}`, ordinal: index, providerResponseId: 'old-response' } }));
      const oldItems = await h.app.contentStore.prepareBatch(h.app.database, parts.map(part => ({
        content: JSON.stringify({ role: 'model', parts: [part] }, null, 2), contentType: MESSAGE_CONTENT_TYPE
      })));
      const previous = await h.app.contentStore.prepare(h.app.database,
        JSON.stringify({ role: 'model', parts }, null, 2), MESSAGE_CONTENT_TYPE);
      const next = serializeNativeMessageItem({ text: '新项追加 🙂',
        outputItem: { id: 'new-item', ordinal: 0, providerResponseId: 'new-response', previousResponseId: 'old-response' } });
      const nextItem = await h.app.contentStore.prepare(h.app.database, next.content, MESSAGE_CONTENT_TYPE);
      const store = {
        prepare: h.app.contentStore.prepare.bind(h.app.contentStore),
        read: async () => assert.fail('prefix append must reuse recovered descriptors without reading prior body CAS'),
        readChunk: async () => assert.fail('prefix append must not scan prior body ranges'),
        readMany: async () => assert.fail('prefix append must not batch-read prior bodies')
      };
      const composition = await prepareNativeMessageComposition(h.app.database, store, previous.metadata,
        { revisionId: 'new-item-revision', contentObjectId: nextItem.metadata.id, partByteLength: next.partByteLength,
          partByteOffset: next.partByteOffset, outputItem: next.outputItem },
        oldItems.map((item, index) => ({ revisionId: `published-item-revision-${index}`, contentObjectId: item.metadata.id,
          partByteLength: serializeNativeMessageItem(parts[index]).partByteLength, outputItem: parts[index].outputItem })));
      assert.equal(composition.relatedContentObjects.length, 2, '35 recovered items plus the new item prepare two blocks once');
      await h.app.database.transaction(preparedContentObjectSteps(
        [...oldItems, previous, nextItem, ...composition.relatedContentObjects, composition.content], 'legacy_native_fixture'));
      assert.equal((await rows(h.app, 'MessageRevision', { id: 'published-item-revision-0' })).length, 0);
      const reader = new LogicalMessageContentReader(h.app.database, h.app.contentStore);
      const full = await reader.read(composition.content.metadata);
      assert.deepEqual(JSON.parse(full.toString('utf8')), { role: 'model', parts: [...parts, next.part] });
      const textAt = full.indexOf(Buffer.from('旧项')) + 1;
      assert.deepEqual((await reader.readChunk(composition.content.metadata, textAt, 17)).chunk,
        full.subarray(textAt, textAt + 17), 'noncanonical old items preserve Unicode byte addressing');
      const page = await reader.readNativeItems(composition.content.metadata, { afterSequence: 31, limit: 5 });
      assert.deepEqual(page.items.map(item => item.sequence), [32, 33, 34, 35, 36]);
      assert.deepEqual(page.items.at(-1).outputItem, next.outputItem);
    });
  });

test('native final item pages follow terminal output order after reversed done events and cached reads stop with Runtime',
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('reversed-item-completion');
      const frame = await h.until(() => h.frames[0], 'reversed item request');
      const responseId = 'http-reversed-items';
      h.created(frame.response, responseId);
      const items = Array.from({ length: 35 });
      for (let index = items.length - 1; index >= 0; index -= 1) {
        items[index] = h.content(frame.response, responseId, index, `片段 ${index} 🙂`, { delta: false });
      }
      h.completed(frame.response, responseId, items);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      const [request] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      const aggregate = await aggregateParts(h.app, request.id);
      assert.deepEqual(aggregate.map(part => part.outputItem.ordinal), items.map((_, index) => index));
      const messageId = kernel.assistantMessageIdFor(turn.turnId, request.id);
      const feed = new kernel.BoundedClientFeed(h.app.database);
      let indexRevisionId;
      try {
        const frames = [];
        await feed.connect({ activeConversationId: CONVERSATION, send(value) { frames.push(value); } });
        const state = applyReliableKernelDataMessage(createEmptyReliableKernelClientState(), frames[0]).state;
        indexRevisionId = state.records.Message[messageId].item_index_revision_id;
      } finally { feed.close(); }
      assert.equal(indexRevisionId, `${kernel.assistantMessageRevisionIdFor(turn.turnId, request.id)}:items`);
      const [indexRevision] = await rows(h.app, 'MessageRevision', { id: indexRevisionId });
      const [metadata] = await rows(h.app, 'ContentObject', { id: indexRevision.content_object_id });
      const reader = new LogicalMessageContentReader(h.app.database, h.app.contentStore);
      const first = await reader.readNativeItems(metadata, { afterSequence: 0, limit: 32 });
      const last = await reader.readNativeItems(metadata, { afterSequence: first.nextSequence, limit: 32 });
      assert.deepEqual([...first.items, ...last.items].map(item => item.outputItem.ordinal), aggregate.map(part => part.outputItem.ordinal));
      assert.deepEqual(JSON.parse((await reader.read(metadata)).toString('utf8')).parts, aggregate);
      const accepted = new AcceptedAnswerTextPages(reader);
      const acceptedText = await accepted.readMessageContent(metadata, 0, 65536);
      await h.app.close();
      await assert.rejects(reader.readChunk(metadata, 0, 1), /CAS root owner is closing/);
      await assert.rejects(reader.readChunk(metadata, first.totalBytes, 1), /CAS root owner is closing/);
      await assert.rejects(reader.readNativeItems(metadata, { afterSequence: first.totalItems, limit: 1 }), /CAS root owner is closing/);
      await assert.rejects(accepted.readMessageContent(metadata, acceptedText.totalBytes, 1), /CAS root owner is closing/);
    });
  });

test('native item composition reads committed Unicode ranges and stable pages after the producer is deleted',
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('logical-composition');
      const frame = await h.until(() => h.frames[0], 'composition request');
      const responseId = 'http-composition';
      h.created(frame.response, responseId);
      const texts = Array.from({ length: 70 }, (_, index) => `${String(index).padStart(3, '0')}:${'中🙂'.repeat(292)}`);
      const items = texts.map((value, index) => h.content(frame.response, responseId, index, value, { delta: false }));
      const [request] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      const messageId = kernel.assistantMessageIdFor(turn.turnId, request.id);
      await h.until(async () => (await rows(h.app, 'MessageRevision', { message_id: messageId })).length === texts.length * 2,
        'all item and composition revisions');
      const [current] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: messageId });
      const [revision] = await rows(h.app, 'MessageRevision', { id: current.revision_id });
      const [metadata] = await rows(h.app, 'ContentObject', { id: revision.content_object_id });
      assert.equal(metadata.content_type, NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE);
      assert.ok(Number(metadata.byte_length) < 512, 'the current pointer owns only a fixed-size composition root');
      const reader = new LogicalMessageContentReader(h.app.database, h.app.contentStore);
      const full = await reader.read(metadata);
      const decoded = JSON.parse(full.toString('utf8'));
      assert.deepEqual(decoded.parts.map(part => part.text), texts);
      assert.equal(await reader.byteLength(metadata), full.length);
      assert.ok(full.length > Number(metadata.byte_length));
      const chunks = [];
      for (let offset = 0; offset < full.length;) {
        const page = await reader.readChunk(metadata, offset, 7919);
        assert.equal(page.totalBytes, full.length);
        chunks.push(page.chunk);
        offset += page.chunk.length;
        assert.equal(page.hasMore, offset < full.length);
      }
      assert.deepEqual(Buffer.concat(chunks), full, 'byte pages may split a UTF-8 scalar or item boundary');

      const readTypes = [];
      const observedStore = {
        read: async object => { readTypes.push(object.content_type); return h.app.contentStore.read(object); },
        readChunk: h.app.contentStore.readChunk.bind(h.app.contentStore),
        readMany: h.app.contentStore.readMany.bind(h.app.contentStore)
      };
      const pageReader = new LogicalMessageContentReader(h.app.database, observedStore);
      const tail = await pageReader.readNativeItems(metadata, { limit: 32 });
      assert.deepEqual(tail.items.map(item => item.sequence), Array.from({ length: 32 }, (_, index) => index + 39));
      assert.equal(tail.totalItems, 70);
      assert.equal(tail.totalBytes, full.length);
      assert.ok(readTypes.every(type => type === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE || type === NATIVE_MESSAGE_BLOCK_CONTENT_TYPE),
        'an item metadata page does not read any item body');
      const middle = await pageReader.readNativeItems(metadata, { afterSequence: 31, limit: 4 });
      assert.deepEqual(middle.items.map(item => item.sequence), [32, 33, 34, 35]);
      const head = await pageReader.readNativeItems(metadata, { afterSequence: 0, limit: 32 });
      assert.equal(head.items[0].id, kernel.nativeItemRevisionId(turn.turnId, request.id, `content:${responseId}:0`));
      assert.deepEqual(head.items[0].outputItem, decoded.parts[0].outputItem);
      const accepted = new AcceptedAnswerTextPages(reader);
      const expectedText = Buffer.from(texts.join('\n'));
      const textChunks = [];
      for (let offset = 0; offset < expectedText.length;) {
        const page = await accepted.readMessageContent(metadata, offset, 5003);
        assert.equal(page.totalBytes, expectedText.length);
        textChunks.push(page.chunk); offset += page.chunk.length;
      }
      assert.deepEqual(Buffer.concat(textChunks), expectedText, 'accepted-answer text uses logical length, not root CAS size');
      const done = h.transients.filter(entry => entry.event.kind === 'output_item_done'
        && entry.event.content.committedRevisionId);
      assert.equal(done.length, texts.length);
      const itemObjects = new Map((await rows(h.app, 'ContentObject')).map(object => [object.id, object]));
      for (const entry of done) {
        const content = entry.event.content;
        const stored = JSON.parse((await h.app.contentStore.read(itemObjects.get(content.committedContentObjectId))).toString('utf8'));
        assert.deepEqual(stored, { role: 'model', parts: [content.committedPart] });
        assert.equal(content.outputItem.id, content.committedPart.outputItem.id);
        assert.equal(content.completedItem, undefined, 'the done event carries only one normalized body');
      }

      h.completed(frame.response, responseId, items);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      assert.deepEqual(h.transients.filter(entry => entry.event.kind === 'completed').map(entry => entry.event.content),
        [{ type: 'native_completed' }], 'native completion sends a small UI marker while durable final content remains complete');
      assert.deepEqual(await aggregateParts(h.app, request.id), decoded.parts);
      const revisions = await rows(h.app, 'MessageRevision', { message_id: messageId });
      assert.equal(revisions.length, texts.length * 2 + 1, 'normal completion creates one aggregate revision');
      const [contextHead] = await rows(h.app, 'ConversationContextHeadLink', { conversation_id: CONVERSATION });
      const structure = await h.app.context.materializeStructure(contextHead.root_id);
      const [final] = await rows(h.app, 'MessageCurrentRevisionLink', { message_id: messageId });
      const fork = await h.app.runtime.conversationFork.fork({
        idempotencyKey: 'composition-fork', reuseKey: 'composition-fork',
        sourceConversationId: CONVERSATION, sourceContextRootId: contextHead.root_id,
        sourceContextEndSegmentId: structure.records.at(-1).segment.id,
        sourceMessageRevisionId: final.revision_id, expectedCurrentMessageRevisionId: final.revision_id,
        targetTitle: 'Composition fork', targetAgentId: 'agent-main'
      });
      const copiedIndexes = (await rows(h.app, 'MessageRevision', { content_object_id: metadata.id }))
        .filter(value => value.message_id !== messageId);
      assert.equal(copiedIndexes.length, 1, 'fork keeps the final small item-index revision as well as its ordinary aggregate');
      const [copiedIndex] = copiedIndexes;
      assert.equal(copiedIndex.revision_seq, revision.revision_seq);
      assert.notEqual(copiedIndex.id, revision.id);
      await h.app.conversationDeletion.delete(CONVERSATION);
      assert.equal((await rows(h.app, 'Conversation', { id: CONVERSATION })).length, 0);
      assert.equal((await rows(h.app, 'Conversation', { id: fork.targetConversationId })).length, 1);
      await h.reopen();
      const feed = new kernel.BoundedClientFeed(h.app.database);
      try {
        const frames = [];
        await feed.connect({ activeConversationId: fork.targetConversationId, send(frame) { frames.push(frame); } });
        const projection = applyReliableKernelDataMessage(createEmptyReliableKernelClientState(), frames[0]);
        const copiedMessage = projection.state.records.Message[copiedIndex.message_id];
        assert.ok(copiedMessage, 'the real target Feed contains the copied model Message');
        assert.equal(copiedMessage.content_type, MESSAGE_CONTENT_TYPE, 'completion keeps its ordinary aggregate current');
        assert.equal(copiedMessage.item_index_revision_id, copiedIndex.id, 'the target Feed owns its retained item index after producer deletion');
        assert.notEqual(copiedMessage.revision_id, copiedIndex.id);
        const details = new kernel.ClientDetailReader(h.app.database, h.app.contentStore);
        const page = await details.read({ kind: 'message-content-items', recordId: copiedMessage.item_index_revision_id,
          offset: 0, maxBytes: 65536, itemAfterSequence: 0, itemLimit: 32, conversationId: fork.targetConversationId });
        assert.equal(page.hasMore, false);
        const indexPage = JSON.parse(Buffer.from(page.chunk, 'base64').toString('utf8'));
        assert.equal(indexPage.totalItems, 70);
        assert.equal(indexPage.items.length, 32);
        assert.equal(indexPage.items[0].id, head.items[0].id, 'immutable item identities retain the source identity carried by CAS');
        const itemDetails = new kernel.ClientDetailReader({ snapshot(reads) {
          assert.ok(reads.every(read => read.domain === 'ContentObject'), 'item detail needs only its immutable CAS metadata');
          return h.app.database.snapshot(reads);
        } }, h.app.contentStore);
        const item = await itemDetails.read({ kind: 'message-content-item', recordId: indexPage.items[0].contentObjectId,
          offset: 0, maxBytes: 65536, conversationId: fork.targetConversationId });
        assert.deepEqual(JSON.parse(Buffer.from(item.chunk, 'base64').toString('utf8')).parts, [decoded.parts[0]]);
      } finally { feed.close(); }
      const reopenedReader = new LogicalMessageContentReader({
        snapshot(reads) {
          assert.ok(reads.every(read => read.domain === 'ContentObject'),
            'a frozen copied item is readable with only CAS metadata, without any producing revision row');
          return h.app.database.snapshot(reads);
        }
      }, h.app.contentStore);
      const [retained] = await rows(h.app, 'ContentObject', { id: metadata.id });
      assert.deepEqual(await reopenedReader.read(retained), full);
      assert.deepEqual((await reopenedReader.readChunk(retained, 7917, 23)).chunk, full.subarray(7917, 7940));
      const retainedPage = await reopenedReader.readNativeItems(retained, { afterSequence: 0, limit: 1 });
      const [retainedItem] = await rows(h.app, 'ContentObject', { id: retainedPage.items[0].contentObjectId });
      assert.equal(retainedItem.content_type, MESSAGE_CONTENT_TYPE);
      assert.deepEqual(JSON.parse((await reopenedReader.read(retainedItem)).toString('utf8')).parts, [decoded.parts[0]]);
    }, { modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
      tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } } });
  });

test('native HTTP closes done-only and terminal-only items once, including late duplicate done and reopen',
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('item-closure');
      const first = await h.until(() => h.frames[0], 'item closure request');
      h.created(first.response, 'http-closure');
      const alpha = h.content(first.response, 'http-closure', 0, 'CLOSED-ALPHA');
      const doneOnly = h.content(first.response, 'http-closure', 1, 'CLOSED-DONE-ONLY', { delta: false });
      const reasoning = h.content(first.response, 'http-closure', 2, 'CLOSED-REASONING', { thought: true, delta: false });
      const multiReasoning = { type: 'reasoning', id: 'http-closure-multi-summary',
        summary: [{ type: 'summary_text', text: 'CLOSED-MULTI-ONE' }, { type: 'summary_text', text: 'CLOSED-MULTI-TWO' }],
        encrypted_content: 'signature-multi-summary' };
      h.send(first.response, { type: 'response.output_item.added', response_id: 'http-closure', output_index: 3,
        item: { type: 'reasoning', id: multiReasoning.id, summary: [] } });
      for (const [summary_index, part] of multiReasoning.summary.entries()) {
        h.send(first.response, { type: 'response.reasoning_summary_text.delta', response_id: 'http-closure',
          item_id: multiReasoning.id, output_index: 3, summary_index, delta: part.text });
      }
      h.done(first.response, 'http-closure', 3, multiReasoning);
      await h.until(async () => {
        const parts = await contextParts(h.app);
        return ['CLOSED-ALPHA', 'CLOSED-DONE-ONLY', 'CLOSED-REASONING']
          .every(marker => parts.some(part => part.text === marker))
          && parts.some(part => part.text === 'CLOSED-MULTI-ONE\nCLOSED-MULTI-TWO');
      }, 'each completed item persisted before response.completed');
      const [request] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      assert.equal(request.status, 'streaming', 'item durability must precede the response terminal');
      assert.equal((await rows(h.app, 'ModelRequestMessageLink', { model_request_id: request.id })).length, 1);
      // A late duplicate arrives after other items changed the cumulative current revision.
      h.done(first.response, 'http-closure', 0, alpha);
      h.done(first.response, 'http-closure', 2, reasoning);
      const terminalOnly = h.content(first.response, 'http-closure', 4, 'CLOSED-TERMINAL-ONLY', { delta: false, close: false });
      const terminalReasoning = h.content(first.response, 'http-closure', 5, 'CLOSED-TERMINAL-REASONING',
        { thought: true, delta: false, close: false });
      h.completed(first.response, 'http-closure', [alpha, doneOnly, reasoning, multiReasoning, terminalOnly, terminalReasoning]);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      const markers = ['CLOSED-ALPHA', 'CLOSED-DONE-ONLY', 'CLOSED-REASONING',
        'CLOSED-MULTI-ONE', 'CLOSED-MULTI-TWO', 'CLOSED-TERMINAL-ONLY', 'CLOSED-TERMINAL-REASONING'];
      const texts = async () => (await contextParts(h.app)).filter(part => typeof part.text === 'string').map(part => part.text);
      assertOnce(await texts(), markers, 'completed item Context');
      assertOnce((await aggregateParts(h.app, request.id)).map(part => part.text ?? ''), markers, 'final CAS');
      const before = await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision' });
      await h.reopen();
      assertOnce(await texts(), markers, 'reopened Context');
      assert.deepEqual(await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision' }), before,
        'reopen must not append an aggregate alongside the already closed items');
      const next = await h.startTurn('after-item-closure-reopen');
      const frame = await h.until(() => h.frames[1], 'request after reopen');
      const wireTexts = frame.body.input.flatMap(item => (item.content ?? item.summary ?? [])
        .filter(part => typeof part.text === 'string').map(part => part.text));
      assertOnce(wireTexts, markers, 'reopened next HTTP request');
      for (const marker of ['CLOSED-REASONING', 'CLOSED-TERMINAL-REASONING']) {
        assert.equal(frame.body.input.filter(item => item.encrypted_content === `signature-${marker}`).length, 1);
      }
      assert.equal(frame.body.input.filter(item => item.encrypted_content === 'signature-multi-summary').length, 1);
      h.created(frame.response, 'http-after-reopen');
      h.completed(frame.response, 'http-after-reopen', [h.content(frame.response, 'http-after-reopen', 0, 'REOPEN-FINISHED')]);
      assert.equal((await next.completion).terminalStatus, 'completed');
      assert.equal(h.executions(), 0);
    });
  });
}

export { registerCases };

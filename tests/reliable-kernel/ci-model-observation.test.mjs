import assert from 'node:assert/strict';
import { before, after, afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { kernel, load, llm, sse, compatDelta, geminiChunk, claudeSse } from './fixtures/ci-model-provider-support.mjs';
import { openProviderRuntimeFixture } from './fixtures/ci-model-provider-runtime.mjs';
import { registerExtraObservationTests } from './fixtures/ci-model-extra-observation.mjs';

let fixture;
before(async () => { fixture = await openProviderRuntimeFixture(); });
after(async () => { await fixture?.close(); });
afterEach(() => fixture.setFetch(() => sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')])));

test('A1 活跃请求按确切 Turn 读取三种状态，跨千条完整分页；完整历史按 request_seq 和 id 排序', async () => {
  const local = await openProviderRuntimeFixture();
  let raw;
  try {
    const database = local.app.database;
    const seeds = [];
    for (const conversationId of ['active-page-a', 'active-page-b']) {
      await local.createConversation(conversationId);
      const { turnId } = await local.input(conversationId, 'fixture input');
      const created = await local.request(conversationId, turnId, `${conversationId}-request`);
      seeds.push({ turnId, requestId: created.modelRequestId });
    }
    raw = new Database(database.binding.paths.databasePath);
    raw.defaultSafeIntegers(true);
    raw.pragma('foreign_keys = ON');
    const expected = [];
    // Reuse real request/Operation/Attempt rows. Only bulk population bypasses the writer;
    // the observations below all use the production Runtime reader and its keyset traversal.
    const templates = seeds.map(seed => {
      const request = raw.prepare('SELECT * FROM model_request WHERE id = ?').get(seed.requestId);
      const operation = raw.prepare("SELECT * FROM operation WHERE owner_kind = 'model_request' AND owner_id = ?")
        .get(seed.requestId);
      const attempt = raw.prepare('SELECT * FROM attempt WHERE operation_id = ?').get(operation.id);
      expected.push({ id: request.id, turnId: seed.turnId, seq: 1n, status: 'prepared' });
      return { request, operation, attempt };
    });
    const inserts = Object.fromEntries(Object.entries({ model_request: templates[0].request,
      operation: templates[0].operation, attempt: templates[0].attempt }).map(([table, row]) => {
      const names = Object.keys(row);
      return [table, raw.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(name => `@${name}`).join(', ')})`)];
    }));
    const seedRequest = (scope, seq, status) => {
      const template = templates[scope];
      const id = `scope-${scope}-${String(2000 - seq).padStart(4, '0')}`;
      const operationId = `${id}-operation`;
      const retrying = status === 'retrying';
      const terminal = status === 'terminal';
      const operationStatus = terminal ? 'cancelled' : status === 'prepared' ? 'pending' : 'running';
      const streamStats = { attemptSeq: retrying ? '2' : '1', socketGeneration: status === 'streaming' ? '1' : '0',
        retryReason: null, ...(retrying ? { retryMaxAttempts: 1, retryDelayMs: 1, retryNotBeforeAt: Date.now() } : {}) };
      inserts.operation.run({ ...template.operation, id: operationId, owner_id: id, status: operationStatus });
      inserts.attempt.run({ ...template.attempt, id: `${id}-attempt-1`, operation_id: operationId,
        status: retrying ? 'transient_failed' : operationStatus,
        completed_at: retrying || terminal ? template.attempt.created_at : null });
      if (retrying) inserts.attempt.run({ ...template.attempt, id: `${id}-attempt-2`, operation_id: operationId,
        attempt_seq: 2n, status: 'pending', completed_at: null });
      inserts.model_request.run({ ...template.request, id, request_seq: BigInt(seq), status,
        terminal_state: terminal ? 'fixture-cancelled' : null, stream_stats_json: JSON.stringify(streamStats) });
      expected.push({ id, turnId: seeds[scope].turnId, seq: BigInt(seq), status });
    };
    raw.transaction(() => {
      for (let seq = 2; seq <= 1006; seq++) seedRequest(0, seq, 'prepared');
      seedRequest(0, 1007, 'streaming'); seedRequest(0, 1008, 'streaming');
      seedRequest(0, 1009, 'retrying'); seedRequest(0, 1010, 'retrying');
      seedRequest(0, 1011, 'terminal'); seedRequest(0, 1012, 'terminal');
      seedRequest(1, 2, 'streaming'); seedRequest(1, 3, 'retrying'); seedRequest(1, 4, 'terminal');
      // The global 1000-row page ends between the two owners' request_seq=996 rows.
      seedRequest(1, 996, 'prepared');
    })();
    expected.sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id.localeCompare(b.id));
    for (const seed of seeds) {
      const active = (await database.activeModelRequests(seed.turnId)).snapshot;
      assert.deepEqual(active.map(row => [row.id, row.status, row.turn_id]),
        expected.filter(row => row.turnId === seed.turnId && row.status !== 'terminal')
          .map(row => [row.id, row.status, row.turnId]));
    }
    assert.equal((await database.activeModelRequests('no-such-turn')).snapshot.length, 0);
    const { listAllDomainRows } = load('backend/reliableKernel/repositoryPagination.js');
    const all = await listAllDomainRows(database, 'ModelRequest');
    assert.deepEqual(all.map(row => row.id), expected.map(row => row.id));
    const selected = await listAllDomainRows(database, 'ModelRequest', { turn_id: seeds[0].turnId });
    assert.deepEqual(selected.map(row => row.id), expected.filter(row => row.turnId === seeds[0].turnId).map(row => row.id));
    assert.equal(selected.length, 1012);
  } finally { raw?.close(); await local.close(); }
});

test('A3 终态 Turn 元数据不重审历史请求，本事务触及的坏 request 或 Operation 仍回滚', async () => {
  const local = await openProviderRuntimeFixture();
  let raw;
  const operations = [];
  try {
    await local.createConversation('terminal-metadata');
    const terminalTurnId = await local.turn('terminal-metadata', 'completed input');
    const [completed] = await local.rows('ModelRequest', { turn_id: terminalTurnId });
    await local.createConversation('touched-aggregate');
    const { turnId } = await local.input('touched-aggregate', 'prepared input');
    const prepared = await local.request('touched-aggregate', turnId, 'prepared-aggregate');
    for (const id of [completed.id, prepared.modelRequestId]) {
      operations.push((await local.rows('Operation', { owner_kind: 'model_request', owner_id: id }))[0]);
    }
    raw = new Database(local.app.database.binding.paths.databasePath);
    // A bad historical aggregate makes a broad Turn audit observable; the prepared one also
    // proves that narrowing the Turn scope has not removed checks for a touched request.
    raw.prepare("UPDATE operation SET status = 'running' WHERE id IN (?, ?)")
      .run(operations[0].id, operations[1].id);
    const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
    const metadataTime = '2026-10-18T00:00:00.000Z';
    const rollbackTime = '2026-10-19T00:00:00.000Z';
    await local.app.database.transaction([repo('Turn').update(terminalTurnId, { updated_at: metadataTime })]);
    assert.equal((await local.rows('Turn', { id: terminalTurnId }))[0].updated_at, metadataTime);
    for (const [domain, id, error] of [
      ['ModelRequest', prepared.modelRequestId, /Prepared ModelRequest .* aggregate is inconsistent/],
      ['Operation', operations[0].id, /Completed ModelRequest .* aggregate is inconsistent/]
    ]) {
      const [before] = await local.rows(domain, { id });
      await assert.rejects(local.app.database.transaction([
        repo('Turn').update(terminalTurnId, { updated_at: rollbackTime }),
        repo(domain).update(id, { updated_at: rollbackTime })
      ]), error);
      assert.equal((await local.rows('Turn', { id: terminalTurnId }))[0].updated_at, metadataTime);
      assert.equal((await local.rows(domain, { id }))[0].updated_at, before.updated_at);
    }
  } finally {
    if (raw) {
      for (const operation of operations) raw.prepare('UPDATE operation SET status = ? WHERE id = ?')
        .run(operation.status, operation.id);
      raw.close();
    }
    await local.close();
  }
});

test('普通请求冻结、预算和发送共用一次 Context 读取，发送前释放准备结果，下一轮不复用旧根', async () => {
  await fixture.createConversation('one-context-read');
  const database = fixture.app.database;
  const provider = fixture.app.modelProvider;
  const materialize = database.materializeContextContent.bind(database);
  const prepare = provider.prepareOrdinaryRequestContext.bind(provider);
  const reads = [];
  const holders = [];
  database.materializeContextContent = async rootId => { reads.push(rootId); return materialize(rootId); };
  provider.prepareOrdinaryRequestContext = (...args) => {
    const holder = prepare(...args);
    assert.ok(holder.value.segments.every(segment => !('content' in segment)));
    holders.push(holder);
    return holder;
  };
  const sentRoots = [];
  fixture.setFetch(() => {
    assert.equal(reads.length, 1, 'freeze, preview and initial dispatch must read this root only once');
    assert.equal(holders.at(-1).value, undefined, 'the waiting Agent loop must not retain the provider body');
    sentRoots.push(reads[0]);
    return sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')]);
  });
  try {
    await fixture.turn('one-context-read', 'first');
    reads.length = 0;
    await fixture.turn('one-context-read', 'second');
    assert.notEqual(sentRoots[0], sentRoots[1]);
    const persisted = fixture.requests.at(-1).request;
    const replay = await provider.replay(persisted.modelRequestId);
    assert.deepEqual(replay.context, persisted.context);
    assert.equal(holders.every(holder => holder.value === undefined), true);
  } finally {
    database.materializeContextContent = materialize;
    provider.prepareOrdinaryRequestContext = prepare;
  }
});

test('压缩源准备释放旧 Context 后，普通发送按冻结根重读而不使用空准备结果', async () => {
  await fixture.createConversation('discard-context');
  const database = fixture.app.database;
  const coordinator = fixture.app.compressionCoordinator;
  const materialize = database.materializeContextContent.bind(database);
  const coordinate = coordinator.coordinate.bind(coordinator);
  let reads = 0;
  database.materializeContextContent = (...args) => { reads++; return materialize(...args); };
  coordinator.coordinate = command => {
    command.beforeSourceMaterialization();
    return coordinate(command);
  };
  fixture.setFetch(() => {
    assert.equal(reads, 2, 'a released preparation must be rebuilt at the frozen request root');
    return sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')]);
  });
  try { await fixture.turn('discard-context', 'input'); }
  finally { database.materializeContextContent = materialize; coordinator.coordinate = coordinate; }
});

test('自动总结判断借用当前 Context，普通预算投影直接交给首次发送且下一次请求重新准备', async () => {
  const local = await openProviderRuntimeFixture();
  const capabilities = load('shared/modelCapabilities.js');
  const compiler = local.app.turns.authorityCompiler;
  const compile = compiler.compile.bind(compiler);
  const resolved = capabilities.resolveModelCapabilities({ provider: 'openai-compatible', modelId: 'model-a', transport: 'http' });
  compiler.compile = async input => {
    const result = await compile(input);
    const document = JSON.parse(result.authoritySnapshot.content);
    document.compression = { enabled: true, methodKind: 'llm_summary', thresholdTokens: 100000,
      executionPlan: capabilities.resolveCompressionExecutionPlan({ kind: 'llm_summary', fallbacks: [] }, resolved),
      config: { id: 'automatic', name: 'automatic', kind: 'llm_summary',
        trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 100000 }, llmSummary: { targetTokens: 8000 } },
      provider: { providerConfigId: 'compatible', provider: 'openai-compatible', modelId: 'model-a', capabilities: resolved,
        summaryReasoning: capabilities.resolveSummaryReasoning({ mode: 'provider_default', capabilities: resolved }),
        contextWindowTokens: 128000, maxOutputTokens: 16000 } };
    result.authoritySnapshot.content = JSON.stringify(document);
    return result;
  };
  const database = local.app.database;
  const materialize = database.materializeContextContent.bind(database);
  let reads = 0;
  database.materializeContextContent = (...args) => { reads++; return materialize(...args); };
  const adapter = local.provider('compatible');
  local.app.agentLoop.providers.resolve = () => adapter;
  const projected = [];
  const prepare = adapter.prepareProjectedOrdinaryRequest.bind(adapter);
  adapter.prepareProjectedOrdinaryRequest = (value, ...args) => {
    projected.push(value);
    return prepare(value, ...args);
  };
  const holders = [];
  const prepareContext = local.app.modelProvider.prepareOrdinaryRequestContext.bind(local.app.modelProvider);
  local.app.modelProvider.prepareOrdinaryRequestContext = (...args) => {
    const holder = prepareContext(...args); holders.push(holder); return holder;
  };
  let sent = 0;
  local.setFetch(entry => {
    assert.equal(reads, 1, 'automatic below-threshold evaluation must not read Context again');
    assert.equal(projected.length, 2);
    assert.equal(projected[0], projected[1], 'planning and first dispatch transfer the same model projection');
    assert.equal(holders.at(-1).value, undefined, 'no raw or projected request remains in the waiting Agent holder');
    assert.ok(entry.body.messages.some(message => message.content === (sent ? 'second' : 'first')));
    sent++;
    return sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')]);
  });
  try {
    await local.createConversation('automatic-shared-context');
    await local.turn('automatic-shared-context', 'first');
    const first = projected[0];
    reads = 0; projected.length = 0;
    await local.turn('automatic-shared-context', 'second');
    assert.notEqual(projected[0], first, 'a new request cannot reuse the old projection');
    assert.equal(sent, 2);
  } finally { await local.close(); }
});

test('Claude 绑定与 Gemini 文本尾签名各自提交，共享重启后首次请求保持正确回放', async () => {
  const claudeBodies = [];
  const geminiBodies = [];
  fixture.setFetch(entry => {
    if (entry.body.contents) {
      geminiBodies.push(entry.body);
      return sse([geminiChunk([{ text: 'answer' }]),
        geminiChunk([{ text: '', thoughtSignature: 'TEXT_TAIL_SIGNATURE' }], 'STOP')]);
    }
    claudeBodies.push(entry.body);
    const hasThinking = entry.body.messages.some(message => Array.isArray(message.content)
      && message.content.some(block => block.type === 'thinking'));
    if (hasThinking) return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message:
      'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
      + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } }),
    { status: 400, headers: { 'content-type': 'application/json' } });
    return claudeSse([{ text: 'thinking', thought: true }, { text: 'answer' }]);
  });
  await fixture.createConversation('binding-persistence', 'claude');
  await fixture.turn('binding-persistence', 'first');
  const second = await fixture.turn('binding-persistence', 'second');
  assert.equal(claudeBodies.length, 4);
  assert.equal(claudeBodies[2].thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
  const [learned] = await fixture.rows('ModelRequest', { turn_id: second });
  assert.equal(learned.stream_stats_json.claudeThinkingBinding, 'strip_thinking');
  await fixture.createConversation('gemini-signature', 'gemini');
  await fixture.turn('gemini-signature', 'first');
  await fixture.restart();
  const third = await fixture.turn('binding-persistence', 'third');
  assert.equal(claudeBodies.length, 5);
  assert.equal(JSON.stringify(claudeBodies[4]).includes('"type":"thinking"'), false);
  assert.equal((await fixture.rows('ModelRequest', { turn_id: third }))[0].stream_stats_json.claudeThinkingBinding,
    'strip_thinking');
  await fixture.turn('gemini-signature', 'second');
  assert.deepEqual(geminiBodies[1].contents.find(content => content.role === 'model').parts,
    [{ text: 'answer' }, { text: '', thoughtSignature: 'TEXT_TAIL_SIGNATURE' }]);
  const replay = fixture.requests.at(-1).request.context.find(segment => segment.messageRole === 'model');
  assert.deepEqual(JSON.parse(replay.content).parts,
    [{ text: 'answer' }, { text: '', thoughtSignature: 'gemini:TEXT_TAIL_SIGNATURE' }]);
});

test('真实 Gemini SDK 断流替换 durable Attempt，不执行失败流里的工具', async () => {
  let calls = 0;
  const bodies = [];
  fixture.setFetch(entry => {
    bodies.push(entry.body);
    if (++calls > 1) return sse([geminiChunk([{ text: 'recovered' }], 'STOP')]);
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(geminiChunk([
          { text: 'discarded', thought: true },
          { functionCall: { name: 'edit', args: { path: 'a', mode: 'hunk', hunks: [] }, id: 'partial-call' } }
        ]))}\n\n`));
      } else controller.error(new TypeError('terminated'));
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  await fixture.createConversation('sdk-retry', 'gemini');
  const turnId = await fixture.turn('sdk-retry', 'input', {
    retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: 1 }
  });
  const [request] = await fixture.rows('ModelRequest', { turn_id: turnId });
  assert.equal(request.terminal_state, 'completed');
  assert.equal(calls, 2);
  assert.equal(request.stream_stats_json.lastRetryFailure.phase, 'after_output');
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual((await fixture.app.modelProvider.completedEvent(request.id)).content,
    { role: 'model', parts: [{ text: 'recovered' }] });
  const [operation] = await fixture.rows('Operation', { owner_kind: 'model_request', owner_id: request.id });
  assert.deepEqual((await fixture.rows('Attempt', { operation_id: operation.id })).map(attempt => attempt.status).sort(),
    ['completed', 'transient_failed']);
  assert.equal((await fixture.rows('ToolCall', { turn_id: turnId })).length, 0);
});

test('重试等待来源按冻结策略持久化，强制重试只采用本地间隔或自动退避', async () => {
  for (const [label, forceAllErrors, configuredDelay, expectedDelay] of [
    ['normal', false, 3000, 300_000], ['forced', true, 3000, 3000], ['automatic', true, 0, 0]
  ]) {
    const cid = `retry-source-${label}`;
    await fixture.createConversation(cid);
    const input = await fixture.input(cid, 'input', {
      retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: configuredDelay, forceAllErrors }
    });
    const created = await fixture.request(cid, input.turnId, label);
    let epoch = Date.now();
    const control = new kernel.ModelProviderControlPlane(fixture.app.database, fixture.app.contentStore,
      { epochNow: () => epoch, retryDelaysMs: [0] });
    let scheduled, committedStats;
    const unsubscribe = fixture.app.database.onCommit(commit => {
      const change = commit.changes.find(change => change.domain === 'ModelRequest'
        && change.id === created.modelRequestId && change.record?.status === 'retrying');
      if (change) committedStats = change.record.stream_stats_json;
    });
    let calls = 0;
    const adapter = { providerId: 'compatible', async sendFullRequest(_request, controls) {
      if (++calls === 1) throw new kernel.ProviderTransientError('temporary_service_error', 'try later', true,
        { retryAfterMs: 300_000 });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'ok' }] } });
    } };
    try { await control.dispatch(created.modelRequestId, adapter, { onTransientTerminal(observation) {
      if (!observation.event.content.retrying) return;
      scheduled = observation.event.content;
      epoch = scheduled.retryNotBeforeAt; // Advance the test clock; never sleep for the configured wait.
    } }); } finally { unsubscribe(); }
    assert.equal(scheduled.retryDelayMs, expectedDelay);
    assert.equal(committedStats.retryConfiguredDelayMs, configuredDelay);
    assert.equal(committedStats.retryProviderDelayMs, forceAllErrors ? 0 : 300_000);
    assert.equal(committedStats.retryForced, forceAllErrors);
    const { projectModelRequestSummary } = load('backend/reliableKernel/clientModelRequestSummary.js');
    const projected = projectModelRequestSummary({ id: created.modelRequestId, stream_stats_json: JSON.stringify(committedStats) });
    assert.equal(projected.stream_stats_json.retryConfiguredDelayMs, configuredDelay);
    assert.equal(projected.stream_stats_json.retryProviderDelayMs, forceAllErrors ? 0 : 300_000);
    assert.equal(projected.stream_stats_json.retryForced, forceAllErrors);
    assert.equal(calls, 2);
    const row = (await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0];
    assert.equal(row.terminal_state, 'completed');
    assert.equal(row.stream_stats_json.retryConfiguredDelayMs, undefined, 'wait labels retire when the next attempt starts');
  }
});

test('普通重试保留最近一次具体错误，成功、投影与重开后仍可追查', async () => {
  let calls = 0;
  const seenFailures = [];
  const message = 'gateway timeout at https://relay.invalid/v1?key=url-secret '
    + '{"api_key":"json-secret"} Bearer bearer-secret';
  fixture.setFetch(async () => {
    calls += 1;
    const [request] = await fixture.rows('ModelRequest', { turn_id: input.turnId });
    seenFailures.push(request.stream_stats_json.lastRetryFailure);
    if (calls === 1) return Response.json({ error: { code: 'upstream_busy', message: 'service unavailable' } }, { status: 503 });
    if (calls === 2) return Response.json({ error: { code: 'upstream_timeout', message } }, { status: 504 });
    return sse([compatDelta({ content: 'recovered' }), compatDelta({}, 'stop')]);
  });
  await fixture.createConversation('retry-diagnostics');
  const input = await fixture.input('retry-diagnostics', 'input', {
    retryPolicy: { enabled: true, maxRetries: 2, retryDelayMs: 1 }
  });
  const created = await fixture.request('retry-diagnostics', input.turnId, 'diagnostics');
  await fixture.app.modelProvider.dispatch(created.modelRequestId, fixture.provider('compatible'));
  const [request] = await fixture.rows('ModelRequest', { id: created.modelRequestId });
  assert.equal(calls, 3);
  assert.equal(request.terminal_state, 'completed');
  assert.equal(seenFailures[0], undefined);
  assert.equal(seenFailures[1].error.status, 503);
  const last = request.stream_stats_json.lastRetryFailure;
  assert.equal(last.attemptSeq, '2');
  assert.equal(last.error.status, 504);
  assert.equal(last.error.code, 'upstream_timeout');
  assert.equal(last.error.reason, 'temporary_service_error');
  assert.equal(last.phase, 'before_output');
  assert.ok(last.failedAt >= Date.parse(request.created_at));
  assert.ok(last.elapsedMs >= 0);
  assert.match(last.error.message, /gateway timeout/);
  assert.doesNotMatch(JSON.stringify(last), /relay\.invalid|url-secret|json-secret|bearer-secret/);
  assert.deepEqual(seenFailures[2], last);
  assert.equal(request.stream_stats_json.failure, undefined, 'diagnostic must not become a repair-policy marker');
  const { projectModelRequestSummary } = load('backend/reliableKernel/clientModelRequestSummary.js');
  assert.deepEqual(projectModelRequestSummary({ ...request,
    stream_stats_json: JSON.stringify(request.stream_stats_json) }).stream_stats_json.lastRetryFailure, last);
  await fixture.restart();
  assert.deepEqual((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0].stream_stats_json.lastRetryFailure, last);
});

test('伪思考进度不续命，持久重试等待经接手仍保持并可取消', async context => {
  await fixture.createConversation('watchdog-handoff');
  const input = await fixture.input('watchdog-handoff', 'input', {
    retryPolicy: { enabled: true, maxRetries: 1, retryDelayMs: 60_000 }
  });
  const created = await fixture.request('watchdog-handoff', input.turnId, 'watchdog');
  const schedule = globalThis.setTimeout;
  const timers = [];
  let retryWaiting = () => {};
  context.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 7 || milliseconds === 11 || milliseconds === 60_000) {
      // Keep native clearTimeout handles; only the fixture fires watchdog callbacks.
      const handle = schedule(() => {}, 60_000).unref();
      timers.push({ milliseconds, handle, fire() { clearTimeout(handle); callback(...args); } });
      if (milliseconds === 60_000) retryWaiting();
      return handle;
    }
    return schedule(callback, milliseconds, ...args);
  });
  const epoch = Date.now();
  const options = { epochNow: () => epoch, semanticTimeouts: { firstSemanticMs: 7, semanticIdleMs: 11 },
    retryDelaysMs: [0], adapterDrainTimeoutMs: 20 };
  const first = new kernel.ModelProviderControlPlane(fixture.app.database, fixture.app.contentStore, options);
  let progressSeen;
  const progressed = new Promise(resolve => { progressSeen = resolve; });
  let retryCommitted;
  const persistedRetry = new Promise(resolve => { retryCommitted = resolve; });
  let calls = 0;
  const adapter = { providerId: 'compatible', async sendFullRequest(request, controls) {
    calls += 1;
    await controls.onEvent({ kind: 'output_delta', streamSeq: '1', semanticProgress: false, content: {
      type: 'thought_progress', thoughtStartedAt: Date.now(), thoughtElapsedMs: 10
    } });
    progressSeen();
    await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
  } };
  const running = first.dispatch(created.modelRequestId, adapter, { onTransientTerminal(observation) {
    if (observation.event.content.retrying) retryCommitted();
  } });
  const interrupted = assert.rejects(running, /handoff/);
  try {
    await progressed;
    assert.deepEqual(timers.map(timer => timer.milliseconds), [7]);
    timers.find(timer => timer.milliseconds === 7).fire();
    await persistedRetry;
    const [retrying] = await fixture.rows('ModelRequest', { id: created.modelRequestId });
    assert.equal(retrying.status, 'retrying');
    assert.equal(retrying.stream_stats_json.attemptSeq, '2');
    assert.equal(retrying.stream_stats_json.retryDelayMs, 60_000);
    assert.equal(retrying.stream_stats_json.retryConfiguredDelayMs, 60_000);
    assert.equal(retrying.stream_stats_json.retryProviderDelayMs, 0);
    assert.equal(retrying.stream_stats_json.retryForced, false);
    assert.equal(retrying.stream_stats_json.retryNotBeforeAt, epoch + 60_000);
    const failure = retrying.stream_stats_json.lastRetryFailure;
    assert.equal(failure.error.reason, 'first_semantic_timeout');
    assert.equal(failure.phase, 'before_output');
    assert.equal(failure.attemptSeq, '1');
    await first.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture handoff'));
    await interrupted;
    const caller = new AbortController();
    const second = new kernel.ModelProviderControlPlane(fixture.app.database, fixture.app.contentStore, options);
    const nextWaitArmed = new Promise(resolve => { retryWaiting = resolve; });
    const resumed = second.dispatch(created.modelRequestId, adapter, { reconnect: true, signal: caller.signal });
    const cancelled = assert.rejects(resumed, /cancelled/);
    await nextWaitArmed;
    assert.equal(calls, 1);
    assert.equal((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0]
      .stream_stats_json.retryNotBeforeAt, retrying.stream_stats_json.retryNotBeforeAt);
    caller.abort();
    await cancelled;
    assert.equal(calls, 1);
    assert.equal((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0].terminal_state,
      'cancelled-during-provider-retry-delay');
    assert.deepEqual((await fixture.rows('ModelRequest', { id: created.modelRequestId }))[0]
      .stream_stats_json.lastRetryFailure, failure);
  } finally {
    await first.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture cleanup'));
    for (const timer of timers) clearTimeout(timer.handle);
  }
});

test('可靠错误递归脱敏认证信息，同时保留 cause 和非秘密诊断', () => {
  const error = Object.assign(new Error('closed'), { transport: 'websocket', closeCode: 1011,
    apiKey: 'top-key', headers: { Authorization: 'Bearer top-secret', 'x-request-id': 'request' },
    cause: { message: 'socket reset', api_key: 'nested-key', headers: { 'x-request-id': 'cause' } } });
  const raw = llm.rawErrorFromUnknown(error, { rawResponse: { headers: new Headers({
    'content-type': 'application/json', authorization: 'Bearer response-secret', 'set-cookie': 'cookie-secret'
  }), body: { error: { code: 'closed' }, password: 'body-secret' } } });
  assert.equal(raw.transport, 'websocket');
  assert.equal(raw.closeCode, 1011);
  assert.deepEqual(raw.headers, { 'x-request-id': 'request' });
  assert.deepEqual(raw.cause, { message: 'socket reset', headers: { 'x-request-id': 'cause' } });
  assert.deepEqual(raw.rawResponse, { headers: { 'content-type': 'application/json' }, body: { error: { code: 'closed' } } });
  assert.doesNotMatch(JSON.stringify(raw), /top-key|top-secret|nested-key|response-secret|cookie-secret|body-secret/);
});

registerExtraObservationTests(test, { getFixture: () => fixture, kernel });

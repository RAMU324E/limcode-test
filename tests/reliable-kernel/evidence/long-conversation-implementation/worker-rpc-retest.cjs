#!/usr/bin/env node
// Extends the original Worker benchmark with non-empty active work and semantic child selection.
// Run once per compiled tree; no production source or compiled module is rewritten.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');

const flags = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const [name, inline] = process.argv[index].split('=', 2);
  if (!name.startsWith('--')) throw new Error(`Unexpected argument ${name}`);
  flags[name.slice(2)] = inline ?? process.argv[++index];
}
const sourceRoot = path.resolve(flags['source-root'] ?? process.cwd());
const compiledRoot = path.resolve(flags.compiled ?? path.join(sourceRoot, 'dist/extension'));
const mode = flags.mode ?? 'current';
if (!['current', 'baseline'].includes(mode)) throw new Error('--mode must be current or baseline');
const size = Number(flags.size ?? 18000);
const agentCount = Number(flags.agents ?? 16);
const repeats = Number(flags.repeats ?? 5);
const mixedHistory = Number(flags['mixed-history'] ?? Math.ceil(size / agentCount));
for (const [name, value] of Object.entries({ size, agentCount, repeats, mixedHistory })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}
if (size < 10) throw new Error('--size must be at least 10 for old-source and old-answer evidence');
const projectRequire = createRequire(path.join(sourceRoot, 'package.json'));
const Database = projectRequire('better-sqlite3');
const load = name => projectRequire(path.join(compiledRoot, 'backend/reliableKernel', name));
const kernel = load('index.js');
const { configureWriterConnection } = load('databaseSchema.js');
const { emptyConversationContextHandleStateStep } = load('conversationContextHandleState.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const outputPath = path.resolve(flags.output ?? path.join(__dirname, `worker-rpc-retest-${mode}.json`));
const now = '2026-10-17T00:00:00.000Z';
const at = sequence => new Date(Date.parse(now) + sequence * 1000).toISOString();
const padded = value => String(value).padStart(8, '0');
const childTurnId = sequence => `short-turn-${padded(sequence)}`;
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
const bytes = value => Buffer.byteLength(json(value));
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
    min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, total: sorted.reduce((a, b) => a + b, 0), raw: values };
};
const factRows = value => Array.isArray(value) ? value.length : Object.values(value).reduce((count, item) =>
  count + (Array.isArray(item) ? item.length : item && typeof item === 'object' && typeof item.id === 'string' ? 1 : 0), 0);

async function seed(authority) {
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `bench-seed-${process.pid}` });
  const contents = {};
  try {
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    for (const [name, content, type] of [
      ['message', json({ role: 'user', parts: [{ text: 'Short historical task' }] }), 'application/vnd.limcode.message+json'],
      ['source', 'Original continuation source from Turn 5', 'text/plain'],
      ['continuation', json({ version: 1, kind: 'runtime_continuation', sourceTurnId: childTurnId(5) }), 'application/vnd.limcode.turn-intent+json'],
      ['queued', 'Queued next task', 'text/plain'],
      ['oldAnswer', 'Older answer awaiting parent handling', 'text/plain'],
      ['currentAnswer', 'Current answer from Turn 8', 'text/plain'],
      ['arguments', json({ path: '/synthetic/read' }), 'application/json']
    ]) contents[name] = await store.ingest(database, content, type);
  } finally { await database.close(); }
  const binding = await authority.current();
  const raw = new Database(binding.paths.databasePath);
  configureWriterConnection(raw);
  const statements = new Map();
  const counts = {};
  const put = (domain, id, changes = {}) => {
    const schema = repo(domain).schema;
    const row = {};
    for (const column of schema.columns) row[column.name] = column.name === 'id' ? id
      : column.nullable ? null : column.type === 'INTEGER' ? 1n : column.json ? '{}'
        : column.references?.table === 'content_object' ? contents.arguments.id
          : column.name.endsWith('_at') ? now : 'synthetic';
    Object.assign(row, changes);
    let statement = statements.get(domain);
    if (!statement) {
      const names = schema.columns.map(column => column.name);
      statement = raw.prepare(`INSERT INTO ${schema.table} (${names.join(',')}) VALUES (${names.map(name => '@' + name).join(',')})`);
      statements.set(domain, statement);
    }
    statement.run(row);
    counts[domain] = (counts[domain] ?? 0) + 1;
  };
  const conversation = (id, agentId) => {
    put('Conversation', id, { title: id, status: 'active' });
    put('AgentConversationLink', `${id}-agent`, { conversation_id: id, agent_id: agentId, role: 'default' });
    const step = emptyConversationContextHandleStateStep(id, now);
    put(step.domain, step.row.id, step.row);
  };
  const turn = (id, conversationId, status, sequence = 0) => {
    put('Turn', id, { conversation_id: conversationId, status, created_at: at(sequence), updated_at: at(sequence),
      terminal_at: status === 'active' ? null : at(sequence) });
    put('TurnExecutorLink', `${id}-executor`, { turn_id: id, agent_id: `${conversationId}-agent` });
    if (status !== 'active') put('TurnTermination', `${id}-terminal`, { turn_id: id, terminal_status: 'completed', reason: 'fixture' });
  };
  const request = (turnId, id, sequence, status = 'terminal') => {
    const terminal = status === 'terminal', retrying = status === 'retrying';
    const operationStatus = terminal ? 'cancelled' : status === 'prepared' ? 'pending' : 'running';
    put('Operation', `${id}-operation`, { owner_kind: 'model_request', owner_id: id, operation_seq: 1n, status: operationStatus });
    put('Attempt', `${id}-attempt-1`, { operation_id: `${id}-operation`, attempt_seq: 1n,
      status: retrying ? 'transient_failed' : operationStatus, completed_at: terminal || retrying ? now : null });
    if (retrying) put('Attempt', `${id}-attempt-2`, { operation_id: `${id}-operation`, attempt_seq: 2n, status: 'pending' });
    put('ModelRequest', id, { turn_id: turnId, request_seq: BigInt(sequence), status,
      terminal_state: terminal ? 'fixture-cancelled' : null, provider_id: 'synthetic', model_id: 'synthetic',
      context_window_tokens: 128000n, compression_threshold_tokens: 100000n, estimated_context_tokens: 1000n,
      authority_snapshot_id: 'fixture-authority', recipe_object_id: contents.arguments.id,
      usage_json: '{"inputTokens":1000,"outputTokens":100}', stream_stats_json: json({
        attemptSeq: retrying ? '2' : '1', socketGeneration: status === 'streaming' ? '1' : '0', retryReason: null,
        ...(retrying ? { retryMaxAttempts: 1, retryDelayMs: 1, retryNotBeforeAt: Date.parse(now) } : {}) }) });
  };
  const activeRequests = (turnId, start = 1) => ['prepared', 'streaming', 'retrying'].forEach((status, index) =>
    request(turnId, `${turnId}-active-${status}`, start + index, status));
  const message = (id, content, role = 'user') => {
    put('Message', id);
    put('MessageRevision', `${id}-revision`, { message_id: id, revision_seq: 1n, role, content_object_id: content.id });
    put('MessageCurrentRevisionLink', `${id}-current`, { message_id: id, revision_id: `${id}-revision` });
  };
  const tool = (turnId, id, sequence, status = 'terminal') => put('ToolCall', id,
    { turn_id: turnId, call_seq: BigInt(sequence), tool_name: 'read', status, arguments_object_id: contents.arguments.id });
  try {
    console.log(json({ phase: 'seed-short-turns', size }));
    raw.transaction(() => {
      conversation('child-owner', 'parent-agent'); turn('parent-turn', 'child-owner', 'active');
      tool('parent-turn', 'spawn-call', 1); conversation('short-turns', 'child-agent');
      put('ChildExecution', 'child-execution', { child_conversation_id: 'short-turns', status: 'active' });
      put('ChildExecutionParentLink', 'child-parent', { child_execution_id: 'child-execution', source_tool_call_id: 'spawn-call', parent_turn_id: 'parent-turn' });
      put('AnswerBridge', 'answer-bridge', { child_execution_id: 'child-execution', current_submission_id: 'answer-8', status: 'submitted' });
      for (let sequence = 1; sequence <= size; sequence++) {
        const id = childTurnId(sequence), active = sequence === size;
        turn(id, 'short-turns', active ? 'active' : 'terminated', sequence);
        put('ChildExecutionTurnLink', `${id}-member`, { child_execution_id: 'child-execution', turn_id: id, turn_seq: BigInt(sequence) });
        if (active) activeRequests(id); else request(id, `${id}-request`, 1);
        if (!active) {
          const messageId = `${id}-input`;
          message(messageId, sequence === 5 ? contents.source : contents.message);
          put('MessageTurnLink', `${messageId}-turn`, { message_id: messageId, turn_id: id, role: 'input' });
          put('MessagePartOfConversation', `${messageId}-member`, { message_id: messageId, conversation_id: 'short-turns', message_seq: BigInt(sequence) });
        }
      }
      put('ChildExecutionActiveTurnLink', 'active-child', { child_execution_id: 'child-execution', turn_id: childTurnId(size) });
      for (const [id, turnId, state, content] of [
        ['continuation', childTurnId(size), 'admitted', contents.continuation], ['queued', null, 'queued', contents.queued]
      ]) {
        put('TurnIntent', id, { conversation_id: 'short-turns', turn_id: turnId, state });
        put('TurnIntentRevision', `${id}-revision`, { intent_id: id, revision_seq: 1n, content_object_id: content.id });
      }
      for (const [index, sequence] of [3, 8].entries()) {
        const id = `answer-${sequence}`, content = index ? contents.currentAnswer : contents.oldAnswer;
        put('AnswerSubmission', id, { answer_bridge_id: 'answer-bridge', submission_seq: BigInt(index + 1), turn_id: childTurnId(sequence), interrupted: 0n });
        put('AnswerPayload', `${id}-payload`, { submission_id: id, content_object_id: content.id, byte_length: content.byte_length });
        put('RuntimeInboxItem', `${id}-inbox`, { dedupe_key: `${id}-inbox`, source_kind: 'answer_submission', source_id: id, state: 'available' });
        put('RuntimeInboxPayloadLink', `${id}-inbox-body`, { inbox_item_id: `${id}-inbox`, content_object_id: content.id });
      }
      put('RuntimeDelivery', 'old-answer-delivery', { inbox_item_id: 'answer-3-inbox', target_conversation_id: 'child-owner',
        target_turn_id: 'parent-turn', state: 'pending', phase: 'current_turn', attempt_seq: 1n });
    })();
    console.log(json({ phase: 'seed-long-request-and-ordinary-tools', size }));
    raw.transaction(() => {
      conversation('long-requests', 'long-agent'); turn('long-turn', 'long-requests', 'active');
      for (let sequence = 1; sequence <= size; sequence++) {
        request('long-turn', `long-request-${padded(sequence)}`, sequence);
        const id = `ordinary-${padded(sequence)}`;
        tool('long-turn', id, sequence);
        put('ToolCallEvent', `${id}-event`, { tool_call_id: id, event_seq: 1n, event_kind: 'progress' });
      }
      activeRequests('long-turn', size + 1);
      tool('long-turn', 'ordinary-open', size + 1, 'running');
    })();
    console.log(json({ phase: 'seed-native-pending-facts', closedCalls: size, pendingCalls: 1 }));
    raw.transaction(() => {
      conversation('native-history', 'native-agent'); turn('native-turn', 'native-history', 'active');
      request('native-turn', 'native-request', 1, 'streaming');
      message('native-carrier', contents.message, 'model');
      put('ModelRequestMessageLink', 'native-carrier-source', { model_request_id: 'native-request', message_id: 'native-carrier' });
      for (let sequence = 1; sequence <= size + 1; sequence++) {
        const id = `native-call-${padded(sequence)}`, pending = sequence === size + 1;
        tool('native-turn', id, sequence, pending ? 'running' : 'terminal');
        put('ToolCallSourceLink', `${id}-source`, { tool_call_id: id, model_request_id: 'native-request', message_id: 'native-carrier',
          provider_call_id: `${id}-provider`, provider_ordinal: BigInt(sequence - 1), batch_id: 'native-batch', batch_ordinal: BigInt(sequence - 1) });
        put('ToolCallEvent', `${id}-admission`, { tool_call_id: id, event_seq: 1n, event_kind: 'native_admission', content_object_id: contents.arguments.id });
        if (pending) continue;
        const resultId = `${id}-result`, messageId = `${id}-result-message`, segmentId = `${id}-pair`;
        message(messageId, contents.arguments);
        put('ToolModelResult', resultId, { tool_call_id: id, message_revision_id: `${messageId}-revision` });
        put('ToolCallEvent', `${id}-delivery`, { tool_call_id: id, event_seq: 2n, event_kind: 'native_delivery', content_object_id: contents.arguments.id });
        put('ContextSegment', segmentId, { segment_kind: 'tool_pair', content_object_id: contents.arguments.id });
        put('ContextSegmentSource', `${id}-call-context`, { segment_id: segmentId, source_kind: 'tool_call', source_id: id, source_revision: 0n });
        put('ContextSegmentSource', `${id}-result-context`, { segment_id: segmentId, source_kind: 'tool_model_result', source_id: resultId, source_revision: 0n });
      }
    })();
    console.log(json({ phase: 'seed-distinct-agents', agentCount, historicalRequestsPerAgent: mixedHistory }));
    raw.transaction(() => {
      for (let agent = 0; agent < agentCount; agent++) {
        const conversationId = `mixed-conversation-${agent}`, turnId = `mixed-turn-${agent}`;
        conversation(conversationId, `mixed-agent-${agent}`); turn(turnId, conversationId, 'active');
        for (let sequence = 1; sequence <= mixedHistory; sequence++) request(turnId, `${turnId}-request-${padded(sequence)}`, sequence);
        activeRequests(turnId, mixedHistory + 1);
      }
    })();
    raw.pragma('wal_checkpoint(TRUNCATE)');
    return { counts, fileBytes: fs.statSync(binding.paths.databasePath).size };
  } finally { raw.close(); }
}

(async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'limcode-rpc-retest-'));
  const authority = new kernel.RootAuthority(() => path.join(fixtureRoot, 'runtime'));
  const events = [];
  let database;
  try {
    await kernel.initializeEmptyRuntimeRoot(authority);
    const seedStarted = performance.now();
    const fixture = await seed(authority);
    const seedMs = performance.now() - seedStarted;
    database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `rpc-retest-${mode}-${process.pid}`,
      performanceMetrics: { record(event) { if (event.kind === 'database.request' && event.phase === 'finished') events.push(event); } } });
    const metricSummary = () => ({ rpcCount: events.length,
      byKind: Object.fromEntries([...new Set(events.map(event => event.requestKind))].map(kind => [kind, events.filter(event => event.requestKind === kind).length])),
      workerQueueWaitMs: summary(events.map(event => event.workerQueueWaitMs ?? 0)),
      workerExecuteMs: summary(events.map(event => event.workerExecuteDurationMs ?? 0)),
      workerRoundTripMs: summary(events.map(event => event.roundTripDurationMs)) });
    const results = {};
    const measure = async (name, read, observe) => {
      await read();
      events.length = 0;
      const samples = []; let response;
      for (let index = 0; index < repeats; index++) {
        const started = performance.now(); response = await read(); samples.push(performance.now() - started);
      }
      const value = response.snapshot;
      const details = observe ? observe(value) : {};
      results[name] = { apiMs: summary(samples), returnedFactRows: factRows(value), responseJsonBytes: bytes(response),
        ...details, metrics: metricSummary() };
      console.log(json({ phase: name, medianMs: results[name].apiMs.median, rows: results[name].returnedFactRows,
        responseJsonBytes: results[name].responseJsonBytes, ...details }));
    };
    const fullRequests = turnId => database.snapshotAll(repo('ModelRequest').list({ where: { turn_id: turnId },
      orderBy: { column: mode === 'current' ? 'request_seq' : 'id', direction: 'asc' }, limit: 1000 }));
    const active = turnId => mode === 'current' ? database.activeModelRequests(turnId) : fullRequests(turnId);
    const activeCount = rows => rows.filter(row => ['prepared', 'streaming', 'retrying'].includes(row.status)).length;
    await measure('shortTurnsCurrentObservation', () => mode === 'current' ? database.currentConversationTurns('short-turns', true)
      : database.snapshotAll(repo('Turn').list({ where: { conversation_id: 'short-turns' }, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 })),
    value => { const activeTurns = Array.isArray(value) ? value.filter(turn => turn.status === 'active') : value.activeTurns;
      assert.deepEqual(activeTurns.map(turn => turn.id), [childTurnId(size)]); return { activeTurns: activeTurns.length }; });
    await measure('longTurnActiveRequests', () => active('long-turn'), rows => {
      assert.equal(activeCount(rows), 3); return { retainedActiveRows: activeCount(rows) };
    });
    await measure('longTurnCompleteHistory', () => fullRequests('long-turn'), rows => {
      assert.equal(rows.length, size + 3); return { historyRows: rows.length };
    });
    const childRead = () => mode === 'current' ? database.conversationChildTaskSnapshot('child-owner', { kind: 'runtime', limit: 32 })
      : database.conversationChildTaskSnapshot('child-owner');
    await measure('semanticChildCurrentSnapshot', childRead, value => {
      const expected = [1, 3, 5, 8, size].map(childTurnId);
      for (const id of expected) assert.ok(value.turns.some(turn => turn.id === id), `Missing required child Turn ${id}`);
      assert.ok(value.answerSubmissions.some(answer => answer.id === 'answer-3'));
      assert.ok(value.answerSubmissions.some(answer => answer.id === 'answer-8'));
      if (mode === 'current') {
        assert.equal(value.turns.length, 5);
        assert.equal(value.taskStates[0].queuedInputCount, 1);
        assert.equal(value.taskStates[0].awaitingHandling, true);
      } else assert.equal(value.turns.length, size, 'baseline must use the original complete historical reader');
      return { selectedTurns: value.turns.length, requiredTurnIds: expected,
        answers: value.answerSubmissions.length, queuedIntents: value.turnIntents.filter(row => row.state === 'queued').length };
    });
    await measure('ordinaryToolsPendingProbe', () => database.nativePendingWork({ conversationId: 'long-requests', turnId: 'long-turn', includeUndelivered: true }), rows => {
      assert.equal(rows.length, 0); return { ordinaryClosedCalls: size, ordinaryOpenCalls: 1, pendingNative: rows.length };
    });
    await measure('nativeToolsPendingProbe', () => database.nativePendingWork({ conversationId: 'native-history', turnId: 'native-turn', includeUndelivered: true }), rows => {
      assert.equal(rows.length, 1); assert.equal(rows[0].settled, false);
      return { nativeClosedCalls: size, nativePendingCalls: rows.length };
    });
    const wall = [], latency = [], rowCounts = [], responseBytes = [], mixedMetrics = [];
    for (let round = -1; round < repeats; round++) {
      events.length = 0;
      const started = performance.now();
      const responses = await Promise.all(Array.from({ length: agentCount }, async (_value, agent) => {
        const turnId = `mixed-turn-${agent}`, agentStarted = performance.now();
        const first = await active(turnId);
        assert.equal(activeCount(first.snapshot), 3);
        let write;
        if ((agent + round) % 4 === 0) write = await database.transaction([
          repo('Turn').update(turnId, { updated_at: at(size + round + 1) })
        ]);
        const last = await active(turnId);
        assert.equal(activeCount(last.snapshot), 3);
        return { latencyMs: performance.now() - agentStarted, responses: [first, last, ...(write ? [write] : [])] };
      }));
      const elapsed = performance.now() - started;
      if (round < 0) continue;
      wall.push(elapsed);
      mixedMetrics.push(metricSummary());
      // Payload sizing is outside the timed interval; these are JSON-size proxies for Worker IPC.
      latency.push(...responses.map(entry => entry.latencyMs));
      rowCounts.push(responses.reduce((count, entry) => count + entry.responses.reduce((n, response) =>
        n + (response.snapshot === undefined ? 0 : factRows(response.snapshot)), 0), 0));
      responseBytes.push(responses.reduce((count, entry) => count + entry.responses.reduce((n, response) => n + bytes(response), 0), 0));
    }
    results.distinctAgentReadWrite = { agents: agentCount, distinctTurns: agentCount,
      historicalRequestsPerTurn: mixedHistory, activeRequestsPerTurn: 3,
      readsPerRound: 2 * agentCount, writesPerRound: Array.from({ length: repeats }, (_v, round) =>
        Array.from({ length: agentCount }, (_a, agent) => (agent + round) % 4 === 0).filter(Boolean).length),
      wallMs: summary(wall), perAgentLatencyMs: summary(latency), returnedRowsPerRound: rowCounts,
      responseJsonBytesPerRound: responseBytes, metricsPerRound: mixedMetrics };
    console.log(json({ phase: 'distinctAgentReadWrite', medianWallMs: summary(wall).median,
      medianAgentMs: summary(latency).median, rowsPerRound: rowCounts, responseJsonBytesPerRound: responseBytes }));
    const report = { kind: 'limcode-worker-rpc-retest', measuredAt: new Date().toISOString(), mode,
      label: flags.label ?? mode, sourceRoot, compiledRoot, node: process.version,
      platform: `${process.platform}/${process.arch}`, cpu: os.cpus()[0]?.model, epoch: kernel.RUNTIME_KERNEL_EPOCH,
      size, agentCount, repeats, fixture: { ...fixture, seedMs }, method: [
        'Actual RuntimeDatabase Worker, normal RootBinding and existing timing sink; one warmup and timed samples.',
        'Synthetic rows use production DDL and complete request aggregates; CAS content used by structural readers is registered by the production store.',
        'Current child selection retains first task, current Turn, Turn 5 continuation origin, Turn 8 current answer and Turn 3 pending answer.',
        'Native pending sample includes admission, result, Context source and delivery rows; shared placeholder event bodies are not read by this metadata-only API. It is not a provider/tool lifecycle benchmark.',
        'responseJsonBytes is UTF-8 JSON of returned responses with decimal BigInts, measured after timing; it is a transport-size proxy, not binary structured-clone byte accounting.',
        'The 16-agent sample uses distinct Agent/Conversation/Turn identities, 2 reads each and one quarter of agents writing Turn metadata per round.'
      ], results };
    const sqliteReader = new Database(database.binding.paths.databasePath, { readonly: true });
    try { report.sqlite = sqliteReader.prepare('SELECT sqlite_version() AS version').get().version; }
    finally { sqliteReader.close(); }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
    console.log(json({ phase: 'complete', output: outputPath }));
  } finally {
    await database?.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

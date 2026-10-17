'use strict';
// Run from the project root with the same Node used for the baseline:
// node --expose-gc /path/to/ui-projection-bench.cjs
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const repo = process.cwd();
const nativeRequire = createRequire(path.join(repo, 'package.json'));
const ts = nativeRequire('typescript');
const { reactive, computed, effectScope, markRaw } = nativeRequire('vue');
if (!global.gc) throw new Error('Run with node --expose-gc.');

function loadProject(variant, stats) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    if (!path.extname(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '/index.ts';
    if (cache.has(file)) return cache.get(file).exports;
    const relative = path.relative(repo, file).split(path.sep).join('/');
    const source = variant === 'baseline'
      ? execFileSync('git', ['show', `HEAD:${relative}`], { cwd: repo, encoding: 'utf8' })
      : fs.readFileSync(file, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} }; cache.set(file, module);
    function localRequire(specifier) {
      if (specifier.startsWith('@shared/')) return load(path.join(repo, 'shared', specifier.slice(8)));
      if (specifier.startsWith('@webview/')) return load(path.join(repo, 'webview/src', specifier.slice(9)));
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(file), specifier));
      return nativeRequire(specifier);
    }
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + output + '\n})', { filename: file })(
      localRequire, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  const projection = load(path.join(repo, 'webview/src/domain/reliableConversationProjection.ts'));
  if (variant === 'baseline') return { project: input => {
    stats.committedCalls++; stats.historicalMessageProjections += stats.messageCount - 1;
    return projection.projectReliableConversation(input);
  } };
  const original = projection.projectReliableCommittedConversation;
  projection.projectReliableCommittedConversation = input => {
    stats.committedCalls++;
    stats.historicalMessageProjections += Object.values(input.records.Message ?? {}).filter(row => row.id !== stats.tailId).length;
    return original(input);
  };
  const { ReliableConversationProjector } = load(path.join(repo, 'webview/src/domain/reliableConversationProjector.ts'));
  const projector = new ReliableConversationProjector();
  const assemble = projector.assemble.bind(projector);
  projector.assemble = inputs => {
    stats.assemblyCalls++; const start = performance.now();
    try { return assemble(inputs); } finally { stats.assemblyMs += performance.now() - start; }
  };
  return { projector };
}
function fixture(count, stats) {
  const records = {}, details = {};
  const add = (type, row) => ((records[type] ??= {})[row.id] = row);
  const turns = count / 2, date = '2026-10-17T00:00:00.000Z';
  for (let i = 0; i < turns; i++) {
    const tid = 'turn-' + i, rid = 'request-' + i, cid = 'tool-' + i;
    const uid = 'message-' + (i * 2 + 1), mid = 'message-' + (i * 2 + 2);
    add('Turn', { id: tid, conversation_id: 'conversation', status: i === turns - 1 ? 'active' : 'terminated', source_message_id: uid, created_at: date, updated_at: date });
    for (const [id, role, seq] of [[uid, 'user', i * 2 + 1], [mid, 'model', i * 2 + 2]]) {
      add('Message', { id, conversation_id: 'conversation', revision_id: 'revision-' + id, revision_seq: '1', message_seq: String(seq), display_seq: String(seq), role, deleted_at: null, created_at: date, updated_at: date });
      add('MessageTurnLink', { id: 'link-' + id, message_id: id, turn_id: tid, role: role === 'user' ? 'input' : 'model' });
      if (seq > count - 30 && seq < count) {
        const parts = role === 'user' ? [{ text: 'input ' + i }] : [{ text: 'output ' + i }, { id: cid, functionCall: { name: 'read_file', args: { path: 'file.ts' } } }];
        const text = JSON.stringify({ role, parts });
        details['message-content:revision-' + id] = { status: 'ready', totalBytes: Buffer.byteLength(text), get text() { stats.historicalBodyReads++; return text; } };
      }
    }
    add('ModelRequest', { id: rid, turn_id: tid, request_seq: '1', model_id: 'synthetic', status: i === turns - 1 ? 'streaming' : 'terminal', terminal_state: 'completed', created_at: date });
    add('ModelRequestMessageLink', { id: 'requestlink-' + i, model_request_id: rid, message_id: mid });
    add('ToolCall', { id: cid, turn_id: tid, tool_name: 'read_file', call_seq: '1', status: 'terminal', created_at: date, updated_at: date });
    add('ToolCallSourceLink', { id: 'sourcelink-' + i, tool_call_id: cid, message_id: mid, model_request_id: rid, provider_call_id: cid, provider_ordinal: 0 });
    add('ToolOutcome', { id: 'outcome-' + i, tool_call_id: cid, status: 'succeeded' });
  }
  const modelRequestId = 'request-' + (turns - 1);
  const transient = { conversationId: 'conversation', turnId: 'turn-' + (turns - 1), modelRequestId, requestSeq: '1', providerId: 'synthetic', modelId: 'synthetic', streamSeq: '1', text: 'tick', thought: '', outputParts: [{ text: 'tick' }], toolCalls: [], status: 'streaming', startedAt: 1, updatedAt: 1 };
  return { conversationId: 'conversation', records, details, transientModelRequests: { [modelRequestId]: transient }, lastCommitSeq: '1', lastSnapshotCommitSeq: '1' };
}
function resetCounts(stats) {
  for (const key of ['committedCalls', 'historicalMessageProjections', 'historicalBodyReads', 'assemblyCalls', 'assemblyMs']) stats[key] = 0;
}
function benchmark(variant, count) {
  const stats = { messageCount: count, tailId: 'message-' + count }; resetCounts(stats);
  const loaded = loadProject(variant, stats), raw = fixture(count, stats);
  if (variant === 'current') raw.records = markRaw(raw.records); // Production canonical Feed facts are immutable per atomic batch.
  const input = reactive(raw);
  const scope = effectScope();
  const value = scope.run(() => {
    if (variant === 'baseline') return computed(() => loaded.project(input));
    const details = computed(() => ({ ...input.details }));
    const committed = computed(() => loaded.projector.projectCommitted({ conversationId: input.conversationId, records: input.records, details: details.value }));
    return computed(() => { committed.value; return loaded.projector.projectTransient({ transientModelRequests: input.transientModelRequests, lastCommitSeq: input.lastCommitSeq, lastSnapshotCommitSeq: input.lastSnapshotCommitSeq }); });
  });
  global.gc(); const beforeHeap = process.memoryUsage().heapUsed, initialStart = performance.now();
  let result = value.value;
  const initialMs = performance.now() - initialStart;
  const initial = { milliseconds: +initialMs.toFixed(3), committedCalls: stats.committedCalls, assemblyCalls: stats.assemblyCalls,
    assemblyMs: +stats.assemblyMs.toFixed(3), heapIncreaseMiB: +((process.memoryUsage().heapUsed - beforeHeap) / 1048576).toFixed(3) };
  const initialMessages = result.messages, initialTools = result.toolCalls;
  const samples = [], counts = [];
  let maxDeltaHeap = 0;
  for (let repeat = 0; repeat < 3; repeat++) {
    global.gc(); const heap = process.memoryUsage().heapUsed; resetCounts(stats);
    const key = 'request-' + (count / 2 - 1), tail = input.transientModelRequests[key];
    input.transientModelRequests[key] = { ...tail, outputParts: [{ text: 'tick-' + repeat }], streamSeq: String(repeat + 2) };
    const start = performance.now(); result = value.value; samples.push(performance.now() - start);
    maxDeltaHeap = Math.max(maxDeltaHeap, process.memoryUsage().heapUsed - heap);
    counts.push({ committedCalls: stats.committedCalls, historicalMessageProjections: stats.historicalMessageProjections,
      historicalBodyReads: stats.historicalBodyReads, assemblyCalls: stats.assemblyCalls, assemblyMs: +stats.assemblyMs.toFixed(3) });
  }
  if (result.messages.length !== count || result.toolCalls.length !== count / 2) throw new Error('Unexpected projection cardinality');
  const reusedHistoricalMessages = result.messages.slice(0, -1).filter((message, index) => message === initialMessages[index]).length;
  const reusedTools = result.toolCalls.filter((call, index) => call === initialTools[index]).length;
  scope.stop();
  return { variant, messages: count, tools: count / 2, feedRecords: Object.values(input.records).reduce((sum, bucket) => sum + Object.keys(bucket).length, 0),
    hydratedBodies: 29, initial, tailSamplesMs: samples.map(value => +value.toFixed(3)), tailMedianMs: +[...samples].sort((a, b) => a - b)[1].toFixed(3),
    tailCounts: counts, reusedHistoricalMessages, reusedTools, reusedToolArray: result.toolCalls === initialTools,
    maxTailHeapIncreaseMiB: +(maxDeltaHeap / 1048576).toFixed(3),
    retainedArrayContract: variant === 'current' ? 'One shallow message-array copy per delta; no full lookup/dictionary copy or sort.' : 'Original complete projection.' };
}
async function retention() {
  const { createUiWorkflowFixture } = await import(pathToFileURL(path.join(repo, 'tests/reliable-kernel/ui-workflow-fixture.mjs')).href);
  const ui = await createUiWorkflowFixture(), cleanup = [];
  const h = ui.stores({ after: fn => cleanup.push(fn) }), feed = h.feed;
  const rows = first => Array.from({ length: 20 }, (_, offset) => ({ id: 'resident-' + (first + offset), revision_id: 'revision-' + (first + offset), role: 'user',
    conversation_id: h.conversationId, message_seq: String(first + offset), display_seq: String(first + offset), created_at: '2026-10-17T00:00:00Z' }));
  try {
    feed.observe({ type: 'reliable-kernel.snapshot', sessionId: 'bench-session', hostBootId: 'bench-host', messageSeq: '1', snapshotCommitSeq: '1',
      projections: { activeConversationWindow: { conversationId: h.conversationId, visibleMessageCount: '2020', messages: rows(2001) } } });
    let maximumRecords = 0, maximumBodies = 0, maximumPages = 0;
    for (let index = 0; index < 80; index++) {
      if (!feed.requestEarlierHistory(h.conversationId)) throw new Error('History page not admitted');
      const request = ui.posted.at(-1), first = 1981 - index * 20, page = rows(first);
      for (const row of page) {
        const text = JSON.stringify({ role: 'user', parts: [{ text: row.id + ' ' + 'x'.repeat(2048) }] });
        feed.details['message-content:' + row.revision_id] = { status: 'ready', text, totalBytes: Buffer.byteLength(text) };
      }
      feed.observeHistoryPageResult({ sessionId: feed.sessionId, requestId: request.requestId, conversationId: h.conversationId,
        page: { records: { Message: page }, hasMoreBefore: first > 1, hasMoreAfter: true, nextBeforeMessageSeq: String(first), nextBeforeId: page[0].id,
          nextAfterMessageSeq: String(first + 19), nextAfterId: page.at(-1).id } });
      maximumRecords = Math.max(maximumRecords, Object.keys(feed.committedRecords.Message).length);
      maximumBodies = Math.max(maximumBodies, Object.keys(feed.details).filter(key => key.startsWith('message-content:')).length);
      maximumPages = Math.max(maximumPages, feed.historyPages.length);
    }
    return { pagesVisited: 80, messagesVisited: 1600, liveMessages: 20, maximumResidentPages: maximumPages,
      maximumResidentMessages: maximumRecords, maximumResidentBodies: maximumBodies,
      finalResidentMessages: Object.keys(feed.committedRecords.Message).length,
      finalResidentBodies: Object.keys(feed.details).filter(key => key.startsWith('message-content:')).length };
  } finally { for (const close of cleanup.reverse()) close(); await ui.close(); }
}
(async () => {
  const report = { node: process.version, architecture: process.arch, baseline: 'git HEAD source', current: 'working tree production projector',
    fixture: '18k/200 messages; one user + model per Turn; one tool per model; 29 ready bodies; 3 exact tail replacements', results: [] };
  for (const count of [200, 18000]) for (const variant of ['baseline', 'current']) {
    const result = benchmark(variant, count); report.results.push(result); console.log(JSON.stringify(result));
  }
  report.retention = await retention(); console.log(JSON.stringify({ retention: report.retention }));
  fs.writeFileSync(path.join(__dirname, 'ui-projector-results.json'), JSON.stringify(report, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });

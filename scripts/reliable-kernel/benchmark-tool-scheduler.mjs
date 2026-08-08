import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);
const iterations = integerArgument('--iterations', 3);
const scenario = textArgument('--scenario', 'all');
const outputPath = optionalTextArgument('--output');

const report = {
  kind: 'limcode-tool-scheduler-phase0-benchmark',
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  iterations,
  instrumentation: typeof kernel.RuntimeDatabase.prototype.attachPerformanceMetrics === 'function'
    ? 'runtime-metadata-observer'
    : 'legacy-runtime-method-probe',
  caveats: [
    'read capability start is the injected dispatcher entry immediately before a real fs.readFile of a 1KiB file; it does not instantiate VS Code or VscodeReliableToolHost',
    'withWebview uses the real Client Feed subscription with a no-op send callback; it does not render a browser Webview',
    'legacy before instrumentation can measure request/validate/listener wall time but cannot split worker queue wait from SQLite execute time',
    'worker request started count is the capability-boundary count; asynchronous recovery work can make validation completion events straddle that boundary',
    'duration totals are cumulative work and may overlap under concurrency; they must not be treated as wall-clock decomposition',
    'short process commands are intentionally not measured here because raw child_process spawn time would not represent the reliable process control plane'
  ]
};

if (scenario === 'all' || scenario === 'read') report.read1KiB = await benchmarkReads();
if (scenario === 'all' || scenario === 'provider') report.providerEvents = await benchmarkProviderEvents();
if (scenario === 'all' || scenario === 'database') report.database = await benchmarkDatabase();
report.shortCommands = {
  measured: false,
  commands: ['true', 'printf x', 'rg'],
  reason: 'process spawn/identity/output-import/receipt instrumentation is owned by the process control-plane benchmark; no raw-spawn surrogate is reported'
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await fs.writeFile(path.resolve(root, outputPath), serialized, 'utf8');
process.stdout.write(serialized);

async function benchmarkReads() {
  const variants = [];
  for (const withWebview of [false, true]) {
    const cold = [];
    const warm = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const pair = await runReadPair(withWebview, iteration);
      cold.push(pair.cold);
      warm.push(pair.warm);
    }
    variants.push({
      withWebview,
      coldCas: { raw: cold, summary: summarizeSamples(cold) },
      warmCas: { raw: warm, summary: summarizeSamples(warm) }
    });
  }
  return {
    fileBytes: 1024,
    capabilityBoundary: 'dispatcher entry before fs.readFile',
    variants
  };
}

async function runReadPair(withWebview, iteration) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-phase0-read-${withWebview ? 'feed' : 'headless'}-`));
  const workspace = path.join(parent, 'workspace');
  const filePath = path.join(workspace, 'fixture-1k.txt');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(1024, 0x72));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  let activeCapture;
  const provider = {
    providerId: 'phase0-provider',
    async sendFullRequest(request, controls) {
      if (Number(request.recipe.round) === 1) {
        activeCapture.mark = activeCapture.recorder.mark();
        activeCapture.startedAtMs = performance.now();
        await controls.onEvent({
          kind: 'completed',
          streamSeq: '1',
          content: {
            text: '',
            thought: '',
            toolCalls: [{ id: 'phase0-read-call', ordinal: 0, name: 'read', arguments: { path: 'fixture-1k.txt' } }]
          }
        });
        return;
      }
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: { text: 'read complete', thought: '', toolCalls: [] }
      });
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(authority, applicationDependencies(provider, {
      definitions() {
        return [{
          name: 'read',
          description: 'Read one local fixture',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          metadata: { readonly: true }
        }];
      },
      async dispatch(input) {
        if (!activeCapture || activeCapture.sample) throw new Error('read capability capture is not active');
        activeCapture.sample = summarizeWindow(
          activeCapture.recorder.since(activeCapture.mark),
          performance.now() - activeCapture.startedAtMs
        );
        const bytes = await fs.readFile(filePath);
        if (bytes.byteLength !== 1024) throw new Error('read fixture changed length');
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `phase0-read:${input.toolCallId}` },
          toolCallId: input.toolCallId,
          status: 'succeeded',
          detail: { byteLength: bytes.byteLength, digestProbe: bytes[0] }
        });
        return settled.terminal ?? await app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
    }));
    const recorder = attachRecorder(app.database, authority);
    try {
      const cold = await runReadTurn(app, recorder, withWebview, `cold-${iteration}`);
      const warm = await runReadTurn(app, recorder, withWebview, `warm-${iteration}`);
      return { cold, warm };
    } finally {
      recorder.detach();
    }
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }

  async function runReadTurn(currentApp, recorder, useFeed, label) {
    const conversationId = `phase0-read-${label}`;
    const now = new Date().toISOString();
    await currentApp.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Phase 0 read benchmark',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`,
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);
    let feed;
    if (useFeed) {
      feed = await currentApp.runtime.clientFeed.connect({
        activeConversationId: conversationId,
        send() {}
      });
    }
    await delay(20);
    activeCapture = { recorder, mark: 0, startedAtMs: 0, sample: undefined };
    try {
      const result = await currentApp.agentLoop.runInput({
        source: { kind: 'command', key: `phase0-read-input:${label}` },
        conversationId,
        leaseOwnerId: 'phase0-read-benchmark',
        hostBootId: currentApp.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        content: 'Read the 1KiB fixture.'
      });
      if (result.terminalStatus !== 'completed') throw new Error(`read benchmark did not complete: ${result.terminalStatus}`);
      if (!activeCapture.sample) throw new Error('read capability boundary was not observed');
      return activeCapture.sample;
    } finally {
      if (feed) currentApp.runtime.clientFeed.disconnect(feed.sessionId);
      activeCapture = undefined;
    }
  }
}

async function benchmarkProviderEvents() {
  const eventCounts = [1, 10, 33, 100];
  const rows = [];
  for (const eventCount of eventCounts) {
    const samples = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      samples.push(await runProviderEventSample(eventCount, iteration));
    }
    rows.push({ eventCount, raw: samples, summary: summarizeSamples(samples) });
  }
  return {
    outputDeltaCountExcludesOneTerminalEvent: true,
    rows
  };
}

async function runProviderEventSample(eventCount, iteration) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase0-provider-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  let recorder;
  let sample;
  const provider = {
    providerId: 'phase0-provider',
    async sendFullRequest(_request, controls) {
      const mark = recorder.mark();
      const startedAtMs = performance.now();
      for (let index = 0; index < eventCount; index += 1) {
        await controls.onEvent({
          kind: 'output_delta',
          streamSeq: String(index + 1),
          content: { type: 'text_delta', text: 'x' }
        });
      }
      await controls.onEvent({
        kind: 'completed',
        streamSeq: String(eventCount + 1),
        content: { text: 'x', thought: '', toolCalls: [] }
      });
      sample = summarizeWindow(recorder.since(mark), performance.now() - startedAtMs);
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(authority, applicationDependencies(provider, {
      definitions() { return []; },
      async dispatch() { throw new Error('provider event benchmark must not dispatch tools'); }
    }));
    recorder = attachRecorder(app.database, authority);
    const conversationId = `phase0-provider-${eventCount}-${iteration}`;
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: 'Provider event benchmark', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`, conversation_id: conversationId, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    await delay(20);
    const result = await app.agentLoop.runInput({
      source: { kind: 'command', key: `phase0-provider-input:${eventCount}:${iteration}` },
      conversationId,
      leaseOwnerId: 'phase0-provider-benchmark',
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'Stream benchmark output.'
    });
    if (result.terminalStatus !== 'completed' || !sample) throw new Error('provider event benchmark did not complete');
    return sample;
  } finally {
    if (recorder) recorder.detach();
    if (app) await app.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function benchmarkDatabase() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-phase0-database-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let database;
  let recorder;
  try {
    database = await kernel.RuntimeDatabase.open(authority, { hostBootId: 'phase0-database' });
    recorder = attachRecorder(database, authority);
    const conversations = kernel.DOMAIN_REPOSITORIES.domain('Conversation');
    const now = new Date().toISOString();
    await database.transaction([conversations.insert({
      id: 'phase0-database-conversation', title: 'database', status: 'active', created_at: now, updated_at: now
    })]);
    await delay(10);
    recorder.reset();
    const sequentialDurations = [];
    for (let index = 0; index < 25; index += 1) {
      const startedAtMs = performance.now();
      await database.snapshot([conversations.get('phase0-database-conversation')]);
      sequentialDurations.push(round(performance.now() - startedAtMs));
    }
    const parallelStartedAtMs = performance.now();
    await Promise.all(Array.from({ length: 25 }, () =>
      database.snapshot([conversations.get('phase0-database-conversation')])
    ));
    const parallelWallMs = performance.now() - parallelStartedAtMs;
    const window = summarizeWindow(recorder.since(0), sequentialDurations.reduce((sum, value) => sum + value, 0) + parallelWallMs);
    return {
      sequential: { rawDurationMs: sequentialDurations, summary: summarizeNumbers(sequentialDurations) },
      parallel: { requestCount: 25, wallMs: round(parallelWallMs) },
      combinedMetrics: window
    };
  } finally {
    if (recorder) recorder.detach();
    if (database) await database.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function applicationDependencies(provider, toolDispatcher) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'phase0-provider', modelId: 'phase0-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              executorAgentId: request.executorAgentId,
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              model: { providerConfigId: 'phase0-provider', modelId: 'phase0-model' },
              policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: { resolve() { return provider; } },
    toolDispatcher
  };
}

function attachRecorder(database, authority) {
  const events = [];
  if (typeof database.attachPerformanceMetrics === 'function') {
    const detach = database.attachPerformanceMetrics({ record(event) { events.push({ ...event }); } });
    return recorder(events, detach);
  }

  const originalSendRequest = database.sendRequest;
  const originalValidate = authority.validate;
  const originalOnMessage = database.onMessage;
  authority.validate = async function measuredValidate(binding) {
    const startedAtMs = performance.now();
    try {
      const result = await originalValidate.call(this, binding);
      events.push({ kind: 'database.root_validate', requestKind: 'legacy_unknown', durationMs: performance.now() - startedAtMs, outcome: 'ok' });
      return result;
    } catch (error) {
      events.push({ kind: 'database.root_validate', requestKind: 'legacy_unknown', durationMs: performance.now() - startedAtMs, outcome: 'error' });
      throw error;
    }
  };
  database.sendRequest = function measuredSendRequest(request) {
    const startedAtMs = performance.now();
    events.push({ kind: 'database.request', phase: 'started', requestKind: request.kind });
    return originalSendRequest.call(this, request).then(
      (result) => {
        events.push({
          kind: 'database.request', phase: 'finished', requestKind: request.kind, outcome: 'ok',
          roundTripDurationMs: performance.now() - startedAtMs
        });
        return result;
      },
      (error) => {
        events.push({
          kind: 'database.request', phase: 'finished', requestKind: request.kind, outcome: 'error',
          roundTripDurationMs: performance.now() - startedAtMs
        });
        throw error;
      }
    );
  };
  database.onMessage = function measuredOnMessage(message) {
    if (message?.type !== 'commit') return originalOnMessage.call(this, message);
    const startedAtMs = performance.now();
    try {
      return originalOnMessage.call(this, message);
    } finally {
      events.push({
        kind: 'database.commit_listeners',
        listenerCount: this.commitListeners?.size ?? 0,
        durationMs: performance.now() - startedAtMs
      });
    }
  };
  return recorder(events, () => {
    database.sendRequest = originalSendRequest;
    database.onMessage = originalOnMessage;
    authority.validate = originalValidate;
  });
}

function recorder(events, detach) {
  return {
    mark() { return events.length; },
    since(mark) { return events.slice(mark); },
    reset() { events.length = 0; },
    detach
  };
}

function summarizeWindow(events, wallMs) {
  const requestStarts = events.filter((event) => event.kind === 'database.request' && event.phase === 'started');
  const requestFinishes = events.filter((event) => event.kind === 'database.request' && event.phase === 'finished');
  const validates = events.filter((event) => event.kind === 'database.root_validate');
  const listeners = events.filter((event) => event.kind === 'database.commit_listeners');
  const byKind = {};
  for (const event of requestStarts) byKind[event.requestKind] = (byKind[event.requestKind] ?? 0) + 1;
  return {
    wallMs: round(wallMs),
    workerRequestCount: requestStarts.length,
    workerRequestKinds: byKind,
    rootValidateCount: validates.length,
    rootValidateTotalMs: round(sum(validates, 'durationMs')),
    workerRoundTripTotalMs: round(sum(requestFinishes, 'roundTripDurationMs')),
    workerQueueWaitTotalMs: optionalSum(requestFinishes, 'workerQueueWaitMs'),
    workerExecuteTotalMs: optionalSum(requestFinishes, 'workerExecuteDurationMs'),
    syncCommitListenerCount: listeners.length,
    syncCommitListenerTotalMs: round(sum(listeners, 'durationMs')),
    modelStreamEventRequests: byKind.modelStreamEvent ?? 0,
    transactionRequests: byKind.transaction ?? 0
  };
}

function summarizeSamples(samples) {
  return {
    workerRequestCount: summarizeNumbers(samples.map((sample) => sample.workerRequestCount)),
    rootValidateCount: summarizeNumbers(samples.map((sample) => sample.rootValidateCount)),
    wallMs: summarizeNumbers(samples.map((sample) => sample.wallMs)),
    rootValidateTotalMs: summarizeNumbers(samples.map((sample) => sample.rootValidateTotalMs)),
    workerRoundTripTotalMs: summarizeNumbers(samples.map((sample) => sample.workerRoundTripTotalMs)),
    workerQueueWaitTotalMs: summarizeOptionalNumbers(samples.map((sample) => sample.workerQueueWaitTotalMs)),
    workerExecuteTotalMs: summarizeOptionalNumbers(samples.map((sample) => sample.workerExecuteTotalMs)),
    syncCommitListenerTotalMs: summarizeNumbers(samples.map((sample) => sample.syncCommitListenerTotalMs)),
    modelStreamEventRequests: summarizeNumbers(samples.map((sample) => sample.modelStreamEventRequests)),
    transactionRequests: summarizeNumbers(samples.map((sample) => sample.transactionRequests))
  };
}

function summarizeOptionalNumbers(values) {
  return values.every((value) => value === null) ? null : summarizeNumbers(values.filter((value) => value !== null));
}

function summarizeNumbers(values) {
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.50)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values))
  };
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function sum(events, key) {
  return events.reduce((total, event) => total + (typeof event[key] === 'number' ? event[key] : 0), 0);
}

function optionalSum(events, key) {
  return events.some((event) => typeof event[key] === 'number') ? round(sum(events, key)) : null;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function integerArgument(name, fallback) {
  const raw = optionalTextArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function textArgument(name, fallback) {
  return optionalTextArgument(name) ?? fallback;
}

function optionalTextArgument(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

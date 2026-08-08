import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const compiledRoot = path.resolve(root, option('compiled-root') ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);
const { createWorkEnvironmentRuntimeCapability } = await import(pathToFileURL(path.join(
  compiledRoot,
  'backend/capabilities/workEnvironmentTransfer.js'
)).href);
const samples = positiveInteger(option('samples') ?? '5', 'samples');
const transferFileCount = positiveInteger(option('transfer-files') ?? '1000', 'transfer-files');
const outputPath = option('output');

const report = {
  kind: 'limcode-model-independent-hotpaths',
  measuredAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  samples,
  caveats: [
    're-drive calls the real ReliableAgentLoop audit against real SQLite/CAS after fixture creation; independent convergence is disabled so its requests do not enter the foreground window',
    're-drive preserves full physical sequence, ordinary round, stable id and recipe-kind validation; it is not a latest-row shortcut',
    'transfer measures the capability event source only; it does not multiply event count by ToolCallEvent durability cost and call that direct measurement',
    'all payloads are synthetic and the report contains counts/timings only'
  ],
  redrive: await benchmarkRedrive(),
  transfer: await benchmarkTransfer()
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await fs.writeFile(path.resolve(root, outputPath), serialized, 'utf8');
process.stdout.write(serialized);

async function benchmarkRedrive() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-redrive-benchmark-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(authority, applicationDependencies());
    app.scheduleRuntimeConvergence = () => {};
    const rows = [];
    for (const historyLength of [1, 10, 100, 500]) {
      const conversationId = `redrive-${historyLength}`;
      const now = new Date().toISOString();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
          id: conversationId,
          title: 're-drive benchmark',
          status: 'active',
          created_at: now,
          updated_at: now
        }),
        kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
          id: `${conversationId}:agent`,
          conversation_id: conversationId,
          agent_id: 'agent-main',
          role: 'default',
          created_at: now,
          updated_at: now
        })
      ]);
      const started = await app.turns.input({
        source: { kind: 'command', key: `redrive-input:${historyLength}` },
        conversationId,
        leaseOwnerId: 'redrive-benchmark',
        hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        content: 'synthetic re-drive fixture'
      });
      const authoritySnapshot = await app.database.snapshot([
        kernel.DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({
          where: { turn_id: started.turnId },
          limit: 2
        })
      ]);
      const authorityRows = authoritySnapshot.snapshot[0];
      if (!Array.isArray(authorityRows) || authorityRows.length !== 1) {
        throw new Error('Re-drive fixture has an invalid AuthoritySnapshot count.');
      }
      const contextRootId = await app.context.currentHeadRootId(conversationId);
      for (let round = 1; round <= historyLength; round += 1) {
        await app.modelProvider.createModelRequest({
          turnId: started.turnId,
          contextRootId,
          authoritySnapshotId: authorityRows[0].id,
          recipe: { kind: 'reliable-agent-turn', round: String(round), tools: [] },
          idempotencyKey: `agent-loop:${started.turnId}:round:${round}`
        });
      }
      const measurements = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const requestKinds = [];
        const detach = app.database.attachPerformanceMetrics({
          record(event) {
            if (event.kind === 'database.request' && event.phase === 'finished') {
              requestKinds.push(event.requestKind);
            }
          }
        });
        const startedAt = performance.now();
        let sequence;
        try {
          sequence = await app.agentLoop.resumeRequestSequence(started.turnId);
        } finally {
          detach();
        }
        measurements.push({
          wallMs: performance.now() - startedAt,
          sequence: sequence.toString(),
          requestCount: requestKinds.length,
          requestKinds
        });
      }
      rows.push({
        historyLength,
        measurements,
        wallMs: distribution(measurements.map((entry) => entry.wallMs)),
        requestCount: distribution(measurements.map((entry) => entry.requestCount))
      });
    }
    return { rows };
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function benchmarkTransfer() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-transfer-progress-benchmark-'));
  const sourceRoot = path.join(parent, 'source');
  const targetRoot = path.join(parent, 'target');
  const sourceBatch = path.join(sourceRoot, 'batch');
  try {
    await fs.mkdir(sourceBatch, { recursive: true });
    await fs.mkdir(targetRoot, { recursive: true });
    for (let offset = 0; offset < transferFileCount; offset += 100) {
      const count = Math.min(100, transferFileCount - offset);
      await Promise.all(Array.from({ length: count }, (_unused, index) => {
        const ordinal = offset + index;
        return fs.writeFile(
          path.join(sourceBatch, `file-${String(ordinal).padStart(6, '0')}.txt`),
          'x',
          'utf8'
        );
      }));
    }
    const source = environment('source', sourceRoot);
    const target = environment('target', targetRoot);
    const progress = [];
    const startedAt = performance.now();
    const result = await createWorkEnvironmentRuntimeCapability().transferFiles({
      transfers: [{
        fromEnvironment: source.id,
        fromPath: 'batch',
        toEnvironment: target.id,
        toPath: 'copied',
        type: 'directory'
      }]
    }, {
      onEvent(event) {
        if (event.kind === 'progress') progress.push(event.payload);
      }
    }, {
      activeWorkEnvironment: source,
      availableWorkEnvironments: [source, target]
    });
    return {
      fileCount: transferFileCount,
      capabilityWallMs: performance.now() - startedAt,
      progressEventCount: progress.length,
      percents: progress.map((event) => event?.percent),
      filesTransferred: progress.map((event) => event?.filesTransferred),
      resultFiles: result.results[0]?.files,
      copiedFiles: (await fs.readdir(path.join(targetRoot, 'copied'))).length
    };
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
}

function applicationDependencies() {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'audit-provider', modelId: 'audit-model' }) },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: { providerConfigId: 'audit-provider', modelId: 'audit-model' },
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: { id: 'audit-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              planReviewPolicy: { mode: 'off', allowReadonlyBeforeApproval: true, requireForToolRiskLevels: [] },
              systemPrompt: { id: null, text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
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
    providers: {
      resolve() {
        return { providerId: 'audit-provider', async sendFullRequest() { throw new Error('not dispatched'); } };
      }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('not dispatched'); }
    }
  };
}

function environment(id, rootPath) {
  return {
    id,
    name: id,
    kind: 'localFolder',
    source: 'workspaceFolder',
    available: true,
    uri: `file://${rootPath}`,
    rootPath,
    displayPath: rootPath,
    createdAt: 1,
    updatedAt: 1
  };
}

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
  return { min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1) };
}

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return parsed;
}

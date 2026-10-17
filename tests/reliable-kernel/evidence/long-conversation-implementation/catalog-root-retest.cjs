#!/usr/bin/env node
// A narrow cold catalog / active frozen-request benchmark. No production module is rewritten.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { performance } = require('node:perf_hooks');

const flags = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const [key, inline] = process.argv[index].split('=', 2);
  if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
  flags[key.slice(2)] = inline ?? process.argv[++index];
}
const sourceRoot = path.resolve(flags['source-root'] ?? process.cwd());
const compiledRoot = path.resolve(flags.compiled ?? path.join(sourceRoot, 'dist/extension'));
const mode = flags.mode ?? 'current';
if (!['current', 'baseline'].includes(mode)) throw new Error('--mode must be current or baseline');
const outputPath = path.resolve(flags.output ?? path.join(__dirname, `catalog-root-retest-${mode}.json`));
const size = Number(flags.size ?? 18000);
const repeats = Number(flags.repeats ?? 5);
const resolutionsPerTrial = Number(flags.hot ?? 4);
for (const [key, value] of Object.entries({ size, repeats, resolutionsPerTrial })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
}
const projectRequire = createRequire(path.join(sourceRoot, 'package.json'));
const load = name => projectRequire(path.join(compiledRoot, 'backend/reliableKernel', name));
const kernel = load('index.js');
const handles = load('modelHandleCatalog.js');
const frozen = load('frozenModelHandleCatalog.js');
// Explicit modes keep the published epoch-6 tree independent of every new epoch-7 module.
const storage = mode === 'current' ? load('contextHandleCatalogStorage.js') : undefined;
const plain = load('plainJson.js');
const { preparedContentObjectSteps } = load('contentObjectTransaction.js');
const { ModelProviderControlPlane } = load('modelProviderControlPlane.js');
assert.equal(kernel.RUNTIME_KERNEL_EPOCH, mode === 'current' ? 7 : 6, 'label the actual compiled epoch with the matching benchmark mode');
const summarize = raw => {
  const sorted = [...raw].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted.at(-1), raw };
};
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const conversationId = 'catalog-benchmark';
const rootContentType = mode === 'current' ? storage.CONTEXT_HANDLE_CATALOG_CONTENT_TYPE : frozen.CONTEXT_HANDLE_STATE_CONTENT_TYPE;
const blockContentType = storage?.CONTEXT_HANDLE_CATALOG_BLOCK_CONTENT_TYPE;
const blockCount = mode === 'current' ? Math.ceil(size / storage.CONTEXT_HANDLE_CATALOG_BLOCK_LIMIT) : 0;

function observeReads(database, store) {
  let metrics;
  const reset = () => { metrics = { snapshotCalls: 0, metadataRows: 0, storeReadCalls: 0, storeReadBytes: 0,
    recipeReads: 0, rootReads: 0, blockReads: 0 }; };
  reset();
  const snapshot = database.snapshot.bind(database);
  database.snapshot = async reads => {
    const result = await snapshot(reads);
    metrics.snapshotCalls += 1;
    metrics.metadataRows += result.snapshot.filter(row => row && !Array.isArray(row)).length;
    return result;
  };
  const read = store.read.bind(store);
  store.read = async metadata => {
    const bytes = await read(metadata);
    metrics.storeReadCalls += 1; metrics.storeReadBytes += bytes.length;
    if (metadata.content_type === rootContentType) metrics.rootReads += 1;
    else if (metadata.content_type === blockContentType) metrics.blockReads += 1;
    else if (metadata.content_type === 'application/vnd.limcode.model-request-recipe+json') metrics.recipeReads += 1;
    return bytes;
  };
  return { reset, value: () => ({ ...metrics }) };
}

async function run() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-catalog-retest-')));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  let database;
  try {
    await kernel.initializeEmptyRuntimeRoot(authority);
    const seedStarted = performance.now();
    database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `catalog-seed-${process.pid}` });
    const store = kernel.ContentAddressedStore.forDatabase(authority, database);
    const catalog = { identityContractRevision: handles.CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
      entries: Array.from({ length: size }, (_, index) => ({ kind: 'process', ref: `P${index + 1}`,
        target: `rk_process_${String(index + 1).padStart(32, '0')}` })), retiredRefs: [], allocationHighWater: { process: size } };
    let prepared;
    if (mode === 'current') {
      prepared = await storage.prepareStoredHandleCatalog({ database, contentStore: store,
        conversationId, kind: 'context', catalog });
    } else {
      // Exact published prepareCatalogContent spelling: preserve its one legacy inline object.
      const payload = { kind: 'conversation-context-handle-state', conversationId,
        catalog: handles.normalizeModelHandleCatalog(catalog) };
      const content = await store.prepare(database,
        plain.canonicalPlainJson(plain.normalizePlainJson(payload, 'Current Context reference state')), rootContentType);
      prepared = { stored: { metadata: content.metadata, storedByteLength: content.metadata.byte_length },
        contents: [content], steps: preparedContentObjectSteps([content], 'catalog_benchmark') };
    }
    await database.transaction(prepared.steps);
    const recipeValue = { kind: 'reliable-agent-turn',
      contextHandleScope: { conversationId, rootId: 'catalog-benchmark-context', provenanceRevision: '0', resetFence: '0' },
      modelHandleCatalogReference: { baseContentObjectId: prepared.stored.metadata.id,
        attachmentEntries: [], addedEntries: [], metadataExtensions: [] } };
    const recipe = await store.ingest(database, JSON.stringify(recipeValue), 'application/vnd.limcode.model-request-recipe+json');
    const request = { id: 'catalog-benchmark-request', turn_id: 'catalog-benchmark-turn', status: 'prepared', recipe_object_id: recipe.id };
    const seed = { elapsedMs: performance.now() - seedStarted, entries: size,
      blocks: prepared.contents.filter(item => item.metadata.content_type === blockContentType).length,
      roots: prepared.contents.filter(item => item.metadata.content_type === rootContentType).length,
      rootBytes: Number(prepared.stored.metadata.byte_length),
      reachablePhysicalBytes: Number(prepared.stored.storedByteLength), recipeBytes: Number(recipe.byte_length),
      largestBlockBytes: Math.max(0, ...prepared.contents.filter(item => item.metadata.content_type === blockContentType)
        .map(item => Number(item.metadata.byte_length))) };
    assert.equal(seed.blocks, blockCount);
    assert.equal(seed.roots, 1);
    await database.close(); database = undefined;
    const trials = [];
    for (let trial = 0; trial < repeats; trial += 1) {
      const openStarted = performance.now();
      database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `catalog-read-${process.pid}-${trial}` });
      const runtimeOpenMs = performance.now() - openStarted;
      const freshStore = kernel.ContentAddressedStore.forDatabase(authority, database);
      const reads = observeReads(database, freshStore);
      const provider = new ModelProviderControlPlane(database, freshStore);
      const coldStarted = performance.now();
      const holder = await provider.readModelRequestRecipe(request);
      const firstCatalog = mode === 'current' ? holder.modelHandleCatalog
        : await frozen.resolveFrozenModelHandleCatalog(database, freshStore, holder.recipe);
      const firstFrozenRequestMs = performance.now() - coldStarted;
      assert.equal(firstCatalog.entries.length, size);
      assert.equal(reads.value().blockReads, blockCount);
      assert.equal(reads.value().rootReads, 1);
      assert.equal(reads.value().recipeReads, 1);
      if (mode === 'current') assert.ok(frozen.preparedModelHandleBase(database, freshStore, holder.modelHandleCatalog, prepared.stored.metadata.id),
        'the active prepared request retains its persistent base even above the idle-cache byte limit');
      const cold = reads.value();
      reads.reset();
      const heldObjects = [], resolvedObjects = [];
      const hotStarted = performance.now();
      for (let pass = 0; pass < resolutionsPerTrial; pass += 1) {
        // Baseline keeps its already-parsed immutable recipe, avoiding unrelated recipe rereads.
        const held = mode === 'current' ? await provider.readModelRequestRecipe(request) : holder;
        heldObjects.push(held);
        resolvedObjects.push(await frozen.resolveFrozenModelHandleCatalog(database, freshStore, held.recipe));
      }
      const hotResolutionsMs = performance.now() - hotStarted;
      assert.ok(heldObjects.every(value => value === holder));
      assert.ok(resolvedObjects.every(value => value.entries.length === size));
      if (mode === 'current') {
        assert.ok(resolvedObjects.every(value => value === holder.modelHandleCatalog));
        assert.equal(reads.value().storeReadCalls, 0);
        assert.equal(reads.value().snapshotCalls, 0);
      }
      const hot = reads.value();
      let afterReleaseMs = null, released = null;
      if (mode === 'current') {
        provider.releasePreparedTurnRecipes(request.turn_id);
        reads.reset();
        const releasedStarted = performance.now();
        const reloaded = await provider.readModelRequestRecipe(request);
        afterReleaseMs = performance.now() - releasedStarted;
        assert.notEqual(reloaded, holder);
        released = reads.value();
        provider.releasePreparedTurnRecipes(request.turn_id);
      }
      trials.push({ runtimeOpenMs, firstFrozenRequestMs, cold, hotResolutionsMs, resolutions: resolutionsPerTrial, hot,
        afterReleaseMs, released });
      await database.close(); database = undefined;
      console.log(json({ trial: trial + 1, firstFrozenRequestMs, blockReads: cold.blockReads, hotResolutionsMs, extraHotReads: hot.storeReadCalls }));
    }
    const output = { kind: 'catalog-root-retest', mode, measuredAt: new Date().toISOString(), sourceRoot, compiledRoot,
      node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model,
      epoch: kernel.RUNTIME_KERNEL_EPOCH, size, repeats, resolutionsPerTrial, seed,
      method: { construction: mode === 'current'
        ? 'One actual prepareStoredHandleCatalog call writes the 32-operation CAS blocks and fixed root; registrations commit through the real Worker. This is not 18000 admissions.'
        : 'The published epoch-6 inline catalog uses its exact canonicalPlainJson(normalizePlainJson(payload)) spelling and CAS registration. Generated entries match the current-mode fixture.',
        cold: 'Each trial reopens RuntimeDatabase and creates a new ContentAddressedStore/provider; its first prepared request reads the registered recipe/root/selected blocks. OS filesystem cache is not flushed.',
        request: 'A captured synthetic prepared-request descriptor uses real registered recipe CAS and the production ModelProviderControlPlane holder; no provider/network or model execution is started.',
        hot: mode === 'current'
          ? 'Four calls reuse the same active request holder and resolve its prepared recipe. Returned object identity and zero additional metadata/body reads are checked outside timing.'
          : 'Four calls to the published resolveFrozenModelHandleCatalog use the same already-parsed immutable recipe. There is no active catalog holder in this implementation; recipe rereads are excluded.',
        writes: 'Use the already-passed C2 65-admission test for bounded tail/root publication. This script measures one bulk construction and cold versus held reads only.',
        instrumentation: 'Script-local wrapper counts existing snapshot/store.read calls; production source and compiled code are unchanged.' },
      idleCacheLimits: frozen.FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS,
      summary: { runtimeOpenMs: summarize(trials.map(value => value.runtimeOpenMs)),
        firstFrozenRequestMs: summarize(trials.map(value => value.firstFrozenRequestMs)),
        hotResolutionsMs: summarize(trials.map(value => value.hotResolutionsMs)),
        ...(mode === 'current' ? { afterReleaseMs: summarize(trials.map(value => value.afterReleaseMs)) } : {}),
        coldBlockReadsPerTrial: trials.map(value => value.cold.blockReads), hotExtraReads: trials.reduce((sum, value) => sum + value.hot.storeReadCalls, 0),
        hotResolutions: repeats * resolutionsPerTrial }, trials };
    await fs.writeFile(outputPath, json(output) + '\n');
    console.log(json({ completed: true, outputPath, seed, summary: output.summary }));
  } finally {
    await database?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });

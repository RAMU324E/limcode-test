import type { ContentAddressedStore, ContentObjectMetadata, PreparedContentObject } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, isPersistentContextHandle,
  normalizeModelHandleCatalog, prepareModelHandleCatalog, prepareModelHandleCatalogOverlay,
  type ModelHandleCatalog, type ModelHandleCatalogOperation, type ModelHandleEntry,
  type ModelHandleKind, type PreparedModelHandleCatalog } from './modelHandleCatalog';
import { canonicalPlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type RepositoryTransactionStep } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Published epoch 6 bytes have one exact reader; all new catalog writes use the epoch 7 types. */
export const LEGACY_CONTEXT_HANDLE_STATE_CONTENT_TYPE = 'application/vnd.limcode.conversation-context-handle-state+json';
export const CONTEXT_HANDLE_CATALOG_CONTENT_TYPE = 'application/vnd.limcode.context-handle-catalog+json';
export const CONTEXT_HANDLE_CATALOG_BLOCK_CONTENT_TYPE = 'application/vnd.limcode.context-handle-catalog-block+json';
export const NATIVE_PRIVATE_HANDLE_CATALOG_CONTENT_TYPE = 'application/vnd.limcode.native-private-handle-catalog+json';
export const CONTEXT_HANDLE_CATALOG_BLOCK_LIMIT = 32;
export const STORED_HANDLE_CATALOG_CACHE_LIMITS = Object.freeze({ entries: 8, bytes: 8 * 1024 * 1024 });

export type ContextHandleCatalogOperation = ModelHandleCatalogOperation;

export interface ContextHandleCatalogRoot {
  kind: 'context-handle-catalog';
  conversationId: string;
  identityContractRevision: string;
  tailBlockContentObjectId: string | null;
  allocationHighWater: Partial<Record<ModelHandleKind, number>>;
}

export interface NativePrivateHandleCatalogRoot {
  kind: 'native-private-handle-catalog';
  conversationId: string;
  /** Exact immutable producer base; never the current Conversation pointer. */
  baseContentObjectId: string | null;
  identityContractRevision: string | null;
  tailBlockContentObjectId: string | null;
  allocationHighWater: Partial<Record<ModelHandleKind, number>>;
}

export interface ContextHandleCatalogBlock {
  kind: 'context-handle-catalog-block';
  previousBlockContentObjectId: string | null;
  operations: readonly ContextHandleCatalogOperation[];
}

export interface StoredHandleCatalog {
  metadata: ContentObjectMetadata;
  conversationId: string;
  catalog: PreparedModelHandleCatalog;
  root?: ContextHandleCatalogRoot | NativePrivateHandleCatalogRoot;
  /** A private view shares its producer's exact persistent base across all later deltas. */
  persistentBase?: StoredHandleCatalog;
  tail?: { metadata: ContentObjectMetadata; block: ContextHandleCatalogBlock };
  /** Reachable physical lengths, captured while reading/preparing; cache accounting never serializes. */
  storedByteLength: bigint;
}

interface StoredCatalogCache {
  origins: WeakMap<object, StoredHandleCatalog>;
  active: Map<string, { stored: StoredHandleCatalog; holders: number }>;
  idle: Map<string, { stored: StoredHandleCatalog; bytes: number }>;
  idleBytes: number;
  reads: Map<string, Promise<StoredHandleCatalog>>;
}
const storedCatalogs = new WeakMap<RuntimeDatabase, WeakMap<ContentAddressedStore, StoredCatalogCache>>();

function cacheFor(database: RuntimeDatabase, store: ContentAddressedStore): StoredCatalogCache {
  let stores = storedCatalogs.get(database);
  if (!stores) { stores = new WeakMap(); storedCatalogs.set(database, stores); }
  let cache = stores.get(store);
  if (!cache) {
    cache = { origins: new WeakMap(), active: new Map(), idle: new Map(), idleBytes: 0, reads: new Map() };
    stores.set(store, cache);
  }
  return cache;
}

function rememberIdle(cache: StoredCatalogCache, stored: StoredHandleCatalog): void {
  const id = stored.metadata.id;
  const old = cache.idle.get(id);
  if (old) { cache.idle.delete(id); cache.idleBytes -= old.bytes; }
  if (cache.active.has(id)) return;
  const bytes = 512 + id.length * 2 + stored.conversationId.length * 2 + Number(stored.storedByteLength) * 8;
  if (!Number.isSafeInteger(bytes) || bytes > STORED_HANDLE_CATALOG_CACHE_LIMITS.bytes) return;
  cache.idle.set(id, { stored, bytes }); cache.idleBytes += bytes;
  while (cache.idle.size > STORED_HANDLE_CATALOG_CACHE_LIMITS.entries
    || cache.idleBytes > STORED_HANDLE_CATALOG_CACHE_LIMITS.bytes) {
    const oldest = cache.idle.keys().next().value!;
    cache.idleBytes -= cache.idle.get(oldest)!.bytes; cache.idle.delete(oldest);
  }
}

/** Active views retain their exact shared base; released history uses the bounded idle LRU. */
export function retainStoredHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  stored: StoredHandleCatalog): () => void {
  const releaseBase = stored.persistentBase && retainStoredHandleCatalog(database, store, stored.persistentBase);
  const cache = cacheFor(database, store);
  const id = stored.metadata.id;
  let active = cache.active.get(id);
  if (!active) {
    const idle = cache.idle.get(id);
    if (idle) { cache.idle.delete(id); cache.idleBytes -= idle.bytes; }
    active = { stored, holders: 0 }; cache.active.set(id, active);
  }
  active.holders += 1;
  return () => {
    if (!active) return;
    if (--active.holders === 0) { cache.active.delete(id); rememberIdle(cache, active.stored); }
    active = undefined;
    releaseBase?.();
  };
}

export function cachedStoredHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  contentObjectId: string): StoredHandleCatalog | undefined {
  const cache = cacheFor(database, store);
  const active = cache.active.get(contentObjectId);
  if (active) return active.stored;
  const idle = cache.idle.get(contentObjectId);
  if (idle) { cache.idle.delete(contentObjectId); cache.idle.set(contentObjectId, idle); }
  return idle?.stored;
}

export function storedHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  catalog: ModelHandleCatalog): StoredHandleCatalog | undefined {
  return cacheFor(database, store).origins.get(catalog);
}

export function rememberStoredHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  value: StoredHandleCatalog): StoredHandleCatalog {
  const cache = cacheFor(database, store);
  const origins = cache.origins;
  const previous = origins.get(value.catalog);
  // An empty private delta may share the prepared base object. Keep the persistent origin for
  // later Context admission; the live native holder already owns its distinct private root.
  if (value.root?.kind !== 'native-private-handle-catalog' || !previous
    || previous.root?.kind === 'native-private-handle-catalog') origins.set(value.catalog, value);
  rememberIdle(cache, value);
  return value;
}

export async function readNativePrivateHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  contentObjectId: string): Promise<StoredHandleCatalog> {
  const metadata = await metadataFor(database, contentObjectId);
  if (metadata.content_type !== NATIVE_PRIVATE_HANDLE_CATALOG_CONTENT_TYPE) throw invalid('Native frozen catalog reference has an incorrect content type.');
  return readStoredHandleCatalog(database, store, metadata);
}

function pointer(value: unknown, label: string): string | null {
  if (value === null || typeof value === 'string' && value.length > 0) return value;
  throw invalid(`${label} requires an immutable CAS id or null.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) {
    throw invalid(`${label} has an invalid shape.`);
  }
}

export function parseContextHandleCatalogRoot(value: unknown): ContextHandleCatalogRoot {
  const root = record(value, 'Context handle catalog root');
  fields(root, ['kind', 'conversationId', 'identityContractRevision', 'tailBlockContentObjectId', 'allocationHighWater'], 'Context handle catalog root');
  if (root.kind !== 'context-handle-catalog' || typeof root.conversationId !== 'string' || !root.conversationId
    || root.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION) throw invalid('Context handle catalog root has invalid ownership or identity contract.');
  return { kind: root.kind, conversationId: root.conversationId, identityContractRevision: root.identityContractRevision,
    tailBlockContentObjectId: pointer(root.tailBlockContentObjectId, 'Catalog tail'), allocationHighWater: allocationFloor(root.allocationHighWater) };
}

export function parseNativePrivateHandleCatalogRoot(value: unknown): NativePrivateHandleCatalogRoot {
  const root = record(value, 'Native private handle catalog root');
  fields(root, ['kind', 'conversationId', 'baseContentObjectId', 'identityContractRevision', 'tailBlockContentObjectId', 'allocationHighWater'], 'Native private handle catalog root');
  if (root.kind !== 'native-private-handle-catalog' || typeof root.conversationId !== 'string' || !root.conversationId
    || !(root.identityContractRevision === null || root.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION)) throw invalid('Native private catalog has invalid ownership or identity contract.');
  return { kind: root.kind, conversationId: root.conversationId,
    baseContentObjectId: pointer(root.baseContentObjectId, 'Private catalog base'), identityContractRevision: root.identityContractRevision,
    tailBlockContentObjectId: pointer(root.tailBlockContentObjectId, 'Private catalog tail'), allocationHighWater: allocationFloor(root.allocationHighWater) };
}

function allocationFloor(value: unknown): Partial<Record<ModelHandleKind, number>> {
  record(value, 'Catalog allocation high-water');
  return normalizeModelHandleCatalog({ entries: [], retiredRefs: [],
    identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, allocationHighWater: value }).allocationHighWater ?? {};
}

export function parseContextHandleCatalogBlock(value: unknown): ContextHandleCatalogBlock {
  const block = record(value, 'Context handle catalog block');
  fields(block, ['kind', 'previousBlockContentObjectId', 'operations'], 'Context handle catalog block');
  if (block.kind !== 'context-handle-catalog-block' || !Array.isArray(block.operations)
    || block.operations.length < 1 || block.operations.length > CONTEXT_HANDLE_CATALOG_BLOCK_LIMIT) throw invalid('Catalog blocks require 1 to 32 operations.');
  const operations = block.operations.map((value): ContextHandleCatalogOperation => {
    const operation = record(value, 'Catalog operation');
    if (operation.kind === 'retire') {
      fields(operation, ['kind', 'ref'], 'Catalog retire operation');
      const retired = normalizeModelHandleCatalog({ entries: [], retiredRefs: [operation.ref], identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
      return { kind: 'retire' as const, ref: retired.retiredRefs![0] };
    }
    if (operation.kind !== 'bind' && operation.kind !== 'extend-metadata') throw invalid('Unknown catalog operation.');
    fields(operation, ['kind', 'entry'], 'Catalog binding operation');
    const entry = normalizeModelHandleCatalog({ entries: [operation.entry] }).entries[0];
    return { kind: operation.kind, entry };
  });
  return { kind: block.kind, previousBlockContentObjectId: pointer(block.previousBlockContentObjectId, 'Previous catalog block'), operations };
}

/** Domain descriptor edges only; callers dispatch by ContentObject.content_type before decoding. */
export function contextHandleCatalogReferences(contentType: string, value: unknown): string[] | undefined {
  if (contentType === CONTEXT_HANDLE_CATALOG_CONTENT_TYPE) {
    const root = parseContextHandleCatalogRoot(value);
    return root.tailBlockContentObjectId ? [root.tailBlockContentObjectId] : [];
  }
  if (contentType === CONTEXT_HANDLE_CATALOG_BLOCK_CONTENT_TYPE) {
    const block = parseContextHandleCatalogBlock(value);
    return block.previousBlockContentObjectId ? [block.previousBlockContentObjectId] : [];
  }
  if (contentType === NATIVE_PRIVATE_HANDLE_CATALOG_CONTENT_TYPE) {
    const root = parseNativePrivateHandleCatalogRoot(value);
    return [root.baseContentObjectId, root.tailBlockContentObjectId].filter((id): id is string => id !== null);
  }
  return undefined;
}

async function metadataFor(database: RuntimeDatabase, contentObjectId: string): Promise<ContentObjectMetadata> {
  const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(contentObjectId)])).snapshot[0];
  if (!row || Array.isArray(row)) throw invalid(`Catalog CAS object ${contentObjectId} is not registered.`);
  return row as unknown as ContentObjectMetadata;
}

/** Cold materialization follows only the chosen immutable chain and builds one final index. */
export async function readStoredHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  metadata: ContentObjectMetadata, controls: { signal?: AbortSignal; checkpoint?: () => void | Promise<void> } = {}): Promise<StoredHandleCatalog> {
  controls.signal?.throwIfAborted();
  const cached = cachedStoredHandleCatalog(database, store, metadata.id);
  if (cached) return cached;
  // Cancellation/checkpoints belong to their caller. Uncontrolled readers of the same immutable
  // root share the cold preparation, including its base and index, instead of racing full rebuilds.
  if (controls.signal || controls.checkpoint) return materializeStoredHandleCatalog(database, store, metadata, controls);
  const cache = cacheFor(database, store);
  const reading = cache.reads.get(metadata.id);
  if (reading) return reading;
  const pending = materializeStoredHandleCatalog(database, store, metadata, controls);
  cache.reads.set(metadata.id, pending);
  try { return await pending; } finally { cache.reads.delete(metadata.id); }
}

async function materializeStoredHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  metadata: ContentObjectMetadata, controls: { signal?: AbortSignal; checkpoint?: () => void | Promise<void> }): Promise<StoredHandleCatalog> {
  const value = record(JSON.parse((await store.read(metadata)).toString('utf8')), 'Stored handle catalog');
  if (metadata.content_type === LEGACY_CONTEXT_HANDLE_STATE_CONTENT_TYPE) {
    fields(value, ['kind', 'conversationId', 'catalog'], 'Published Context handle state');
    if (value.kind !== 'conversation-context-handle-state' || typeof value.conversationId !== 'string' || !value.conversationId) throw invalid('Published Context handle state has invalid ownership.');
    const catalog = prepareModelHandleCatalog(value.catalog);
    requirePersistent(catalog);
    return rememberStoredHandleCatalog(database, store, { metadata, conversationId: value.conversationId, catalog, storedByteLength: metadata.byte_length });
  }
  const root = metadata.content_type === CONTEXT_HANDLE_CATALOG_CONTENT_TYPE ? parseContextHandleCatalogRoot(value)
    : metadata.content_type === NATIVE_PRIVATE_HANDLE_CATALOG_CONTENT_TYPE ? parseNativePrivateHandleCatalogRoot(value) : undefined;
  if (!root) throw invalid('Stored catalog has an unsupported content type.');
  const base = root.kind === 'native-private-handle-catalog' && root.baseContentObjectId
    ? await readStoredHandleCatalog(database, store, await metadataFor(database, root.baseContentObjectId), controls) : undefined;
  if (base?.root?.kind === 'native-private-handle-catalog') throw invalid('Private catalogs require a persistent Context base.');
  let storedByteLength = metadata.byte_length + (base?.storedByteLength ?? 0n);
  const blocks: ContextHandleCatalogBlock[] = [];
  let tail: StoredHandleCatalog['tail'];
  for (let id = root.tailBlockContentObjectId; id !== null;) {
    if (controls.signal?.aborted) throw controls.signal.reason;
    const blockMetadata = await metadataFor(database, id);
    if (blockMetadata.content_type !== CONTEXT_HANDLE_CATALOG_BLOCK_CONTENT_TYPE) throw invalid('Catalog tail references an incorrectly typed block.');
    const block = parseContextHandleCatalogBlock(JSON.parse((await store.read(blockMetadata)).toString('utf8')));
    tail ??= { metadata: blockMetadata, block };
    blocks.push(block); storedByteLength += blockMetadata.byte_length;
    id = block.previousBlockContentObjectId;
    if (blocks.length % 32 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); await controls.checkpoint?.(); }
  }
  let catalog: PreparedModelHandleCatalog;
  if (root.kind === 'native-private-handle-catalog') {
    const operations: ContextHandleCatalogOperation[] = [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      for (const operation of blocks[index].operations) operations.push(operation);
    }
    catalog = prepareModelHandleCatalogOverlay(base?.catalog ?? prepareModelHandleCatalog({ entries: [] }), operations,
      { header: { identityContractRevision: root.identityContractRevision, allocationHighWater: root.allocationHighWater } });
  } else {
    // A cold persistent root builds its one complete base index. Private readers layer only
    // their own operations over that prepared base and never invalidate its materialized entries.
    const entries = new Map<string, Readonly<ModelHandleEntry>>(), retired = new Set<string>();
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      for (const operation of blocks[index].operations) applyOperation(entries, retired, operation);
    }
    catalog = prepareModelHandleCatalog({ entries: [...entries.values()], identityContractRevision: root.identityContractRevision,
      retiredRefs: [...retired], allocationHighWater: root.allocationHighWater });
    requirePersistent(catalog);
  }
  return rememberStoredHandleCatalog(database, store, { metadata, conversationId: root.conversationId,
    catalog, root, persistentBase: base, tail, storedByteLength });
}

function applyOperation(entries: Map<string, Readonly<ModelHandleEntry>>, retired: Set<string>, operation: ContextHandleCatalogOperation): void {
  if (operation.kind === 'retire') { entries.delete(operation.ref); retired.add(operation.ref); return; }
  const entry = operation.entry;
  const previous = entries.get(entry.ref);
  if (retired.has(entry.ref)) throw invalid('A retired catalog reference cannot be rebound.');
  if (operation.kind === 'bind') {
    if (previous) throw invalid('A catalog binding cannot replace an existing reference.');
  } else {
    if (!previous || previous.kind !== entry.kind || previous.target !== entry.target) throw invalid('Catalog metadata extension changed its identity.');
    for (const key of ['name', 'mimeType', 'sizeBytes'] as const) {
      if (previous[key] !== undefined && previous[key] !== entry[key]) throw invalid('Catalog metadata extension replaced established metadata.');
    }
  }
  entries.set(entry.ref, entry);
}

export function contextHandleCatalogOperations(base: ModelHandleCatalog | undefined, next: ModelHandleCatalog): ContextHandleCatalogOperation[] {
  const previous = new Map(base?.entries.map(entry => [entry.ref, entry]));
  const retired = new Set(base?.retiredRefs ?? []);
  const nextRetired = new Set(next.retiredRefs ?? []);
  const operations: ContextHandleCatalogOperation[] = [];
  for (const ref of nextRetired) if (!retired.has(ref)) operations.push({ kind: 'retire', ref });
  for (const entry of next.entries) {
    const old = previous.get(entry.ref);
    previous.delete(entry.ref);
    if (!old) { operations.push({ kind: 'bind', entry }); continue; }
    if (old.kind !== entry.kind || old.target !== entry.target) throw invalid('A catalog update changed an established binding.');
    let extended = false;
    for (const key of ['name', 'mimeType', 'sizeBytes'] as const) {
      if (old[key] === entry[key]) continue;
      if (old[key] !== undefined) throw invalid('A catalog update replaced established metadata.');
      extended = true;
    }
    if (extended) operations.push({ kind: 'extend-metadata', entry });
  }
  for (const ref of previous.keys()) if (!nextRetired.has(ref)) throw invalid('A catalog update removed an unretired binding.');
  return operations;
}

export async function prepareStoredHandleCatalog(input: {
  database: RuntimeDatabase; contentStore: ContentAddressedStore; conversationId: string;
  kind: 'context' | 'native-private'; catalog: ModelHandleCatalog;
  base?: StoredHandleCatalog;
  /** Native discovery supplies only this result's new facts, avoiding a cumulative catalog diff. */
  operations?: readonly ContextHandleCatalogOperation[];
}): Promise<{ stored: StoredHandleCatalog; steps: RepositoryTransactionStep[]; contents: readonly PreparedContentObject[] }> {
  const { database, contentStore } = input;
  const catalog = prepareModelHandleCatalog(input.catalog);
  if (input.kind === 'context') requirePersistent(catalog);
  const origin = input.base ?? storedHandleCatalog(database, contentStore, input.catalog);
  const matchingKind = origin?.root?.kind === (input.kind === 'context' ? 'context-handle-catalog' : 'native-private-handle-catalog');
  const persistentBase = input.kind === 'native-private'
    ? origin?.root?.kind === 'native-private-handle-catalog' ? origin.persistentBase : origin : undefined;
  const baseContentObjectId = input.kind === 'native-private'
    ? origin?.root?.kind === 'native-private-handle-catalog' ? origin.root.baseContentObjectId : origin?.metadata.id ?? null : null;
  const operations = input.operations ?? contextHandleCatalogOperations(matchingKind || input.kind === 'native-private' ? origin?.catalog : undefined, catalog);
  let tail = matchingKind ? origin?.tail : undefined;
  let tailBlockContentObjectId = matchingKind ? origin!.root!.tailBlockContentObjectId : null;
  let blockBytes = matchingKind ? origin!.storedByteLength - origin!.metadata.byte_length
    : input.kind === 'native-private' ? origin?.storedByteLength ?? 0n : 0n;
  const prepared: PreparedContentObject[] = [];
  for (let offset = 0; offset < operations.length;) {
    const reuseTail = tail && tail.block.operations.length < CONTEXT_HANDLE_CATALOG_BLOCK_LIMIT;
    const previousOperations = reuseTail ? tail!.block.operations : [];
    const take = Math.min(CONTEXT_HANDLE_CATALOG_BLOCK_LIMIT - previousOperations.length, operations.length - offset);
    const block: ContextHandleCatalogBlock = { kind: 'context-handle-catalog-block',
      previousBlockContentObjectId: reuseTail ? tail!.block.previousBlockContentObjectId : tailBlockContentObjectId,
      operations: [...previousOperations, ...operations.slice(offset, offset + take)] };
    const content = await contentStore.prepare(database, canonicalPlainJson(block), CONTEXT_HANDLE_CATALOG_BLOCK_CONTENT_TYPE);
    prepared.push(content);
    blockBytes += content.metadata.byte_length - (reuseTail ? tail!.metadata.byte_length : 0n);
    tail = { metadata: content.metadata, block }; tailBlockContentObjectId = content.metadata.id;
    offset += take;
  }
  const common = { conversationId: input.conversationId, tailBlockContentObjectId,
    allocationHighWater: { ...catalog.allocationHighWater } };
  const root: ContextHandleCatalogRoot | NativePrivateHandleCatalogRoot = input.kind === 'context'
    ? { kind: 'context-handle-catalog', ...common, identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION }
    : { kind: 'native-private-handle-catalog', ...common, baseContentObjectId, identityContractRevision: catalog.identityContractRevision ?? null };
  if (!operations.length && matchingKind && origin!.conversationId === input.conversationId
    && sameFloor(origin!.root!.allocationHighWater, root.allocationHighWater)) return { stored: origin!, steps: [], contents: [] };
  const content = await contentStore.prepare(database, canonicalPlainJson(root), input.kind === 'context'
    ? CONTEXT_HANDLE_CATALOG_CONTENT_TYPE : NATIVE_PRIVATE_HANDLE_CATALOG_CONTENT_TYPE);
  prepared.push(content);
  const stored = rememberStoredHandleCatalog(database, contentStore, { metadata: content.metadata,
    conversationId: input.conversationId, catalog, root, persistentBase, tail,
    storedByteLength: content.metadata.byte_length + blockBytes });
  return { stored, steps: preparedContentObjectSteps(prepared, 'context_handle_catalog'), contents: prepared };
}

function sameFloor(left: Partial<Record<ModelHandleKind, number>>, right: Partial<Record<ModelHandleKind, number>>): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => right[key as ModelHandleKind] === value);
}

function requirePersistent(catalog: ModelHandleCatalog): void {
  if (catalog.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    || catalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) throw invalid('Context catalog requires current persistent identities.');
}

function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' }); }

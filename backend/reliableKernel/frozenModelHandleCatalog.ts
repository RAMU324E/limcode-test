import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  modelHandleAllocationFrontier, normalizeModelHandleCatalog, prepareModelHandleCatalog,
  prepareModelHandleCatalogOverlay, type ModelHandleCatalog,
  type ModelHandleEntry, type PreparedModelHandleCatalog } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { CONTEXT_HANDLE_CATALOG_CONTENT_TYPE, LEGACY_CONTEXT_HANDLE_STATE_CONTENT_TYPE,
  STORED_HANDLE_CATALOG_CACHE_LIMITS, cachedStoredHandleCatalog, rememberStoredHandleCatalog,
  readStoredHandleCatalog, retainStoredHandleCatalog, storedHandleCatalog, type StoredHandleCatalog } from './contextHandleCatalogStorage';

export const CONTEXT_HANDLE_STATE_CONTENT_TYPE = LEGACY_CONTEXT_HANDLE_STATE_CONTENT_TYPE;
export const FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS = STORED_HANDLE_CATALOG_CACHE_LIMITS;

/** Only request-local facts are embedded; the base is an immutable CAS identity, never a pointer. */
export interface FrozenModelHandleCatalogReference {
  baseContentObjectId: string | null;
  attachmentEntries: readonly ModelHandleEntry[];
  addedEntries: readonly ModelHandleEntry[];
  metadataExtensions: readonly ModelHandleEntry[];
}

const preparedRecipes = new WeakMap<object, PreparedModelHandleCatalog>();
const preparedBases = new WeakMap<object, { database: RuntimeDatabase; store: ContentAddressedStore; base: StoredHandleCatalog }>();
const emptyBase = prepareModelHandleCatalog({ entries: [], retiredRefs: [],
  identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });

/** Charged from already-known immutable byte_length; never walk/stringify/hash a warm catalog. */
export function rememberFrozenContextHandleCatalogBase(database: RuntimeDatabase, store: ContentAddressedStore,
  metadata: ContentObjectMetadata, conversationId: string, catalog: ModelHandleCatalog): PreparedModelHandleCatalog {
  const prepared = prepareModelHandleCatalog(catalog);
  const stored = storedHandleCatalog(database, store, prepared);
  rememberStoredHandleCatalog(database, store, stored?.metadata.id === metadata.id ? stored
    : { metadata: { ...metadata }, conversationId, catalog: prepared,
      storedByteLength: stored?.storedByteLength ?? metadata.byte_length });
  return prepared;
}

/**
 * ContentObject registrations and CAS bytes are retained until explicit dataset reset. Conversation
 * deletion removes neither; online/streamed merge and whole-dataset copy transfer every registered
 * ContentObject, including this base after its producer is deleted. A future reachability GC MUST
 * follow recipe.modelHandleCatalogReference.baseContentObjectId as a strong CAS edge before it may
 * collect bases. No current Conversation/ContextRoot row is required to replay a copied recipe.
 */
export async function readFrozenContextHandleCatalogBase(database: RuntimeDatabase, store: ContentAddressedStore,
  contentObjectId: string | null, conversationId: string): Promise<PreparedModelHandleCatalog> {
  if (contentObjectId === null) return emptyBase;
  // The cache belongs to this live RuntimeDatabase/store pair. Validate that binding once, then
  // consume the immutable catalog already prepared by Context admission. The ContentObject row is
  // committed in the same transaction as the pointer; forcing a separate reader snapshot first can
  // reject a valid warm catalog during the tiny writer/reader handoff window.
  await database.assertUsableBinding('snapshot');
  const cached = cachedStoredHandleCatalog(database, store, contentObjectId);
  if (cached) {
    if (cached.conversationId !== conversationId) throw invalid('Frozen catalog belongs to another producer Conversation.');
    if (![CONTEXT_HANDLE_STATE_CONTENT_TYPE, CONTEXT_HANDLE_CATALOG_CONTENT_TYPE].includes(cached.metadata.content_type)
      || typeof cached.metadata.byte_length !== 'bigint' || cached.metadata.byte_length < 0n) {
      throw invalid('Frozen Context catalog has no correctly typed registered CAS base.');
    }
    return cached.catalog;
  }
  const metadata = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(contentObjectId)])).snapshot[0];
  if (!metadata || Array.isArray(metadata) || metadata.id !== contentObjectId
    || ![CONTEXT_HANDLE_STATE_CONTENT_TYPE, CONTEXT_HANDLE_CATALOG_CONTENT_TYPE].includes(String(metadata.content_type))
    || typeof metadata.byte_length !== 'bigint' || metadata.byte_length < 0n) {
    throw invalid('Frozen Context catalog has no correctly typed registered CAS base.');
  }
  const stored = await readStoredHandleCatalog(database, store, metadata as ContentObjectMetadata);
  if (stored.conversationId !== conversationId) throw invalid('Frozen Context catalog belongs to another producer Conversation.');
  return rememberFrozenContextHandleCatalogBase(database, store, stored.metadata, conversationId, stored.catalog);
}

/** Published inline recipes retain their original bytes; no replay substitutes the current state. */
export async function resolveFrozenModelHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  recipeValue: unknown): Promise<PreparedModelHandleCatalog> {
  const recipe = record(recipeValue, 'Frozen recipe');
  const prepared = preparedRecipes.get(recipe);
  if (prepared) return prepared;
  if (!('modelHandleCatalogReference' in recipe)) return prepareModelHandleCatalog(recipe.modelHandleCatalog);
  const reference = readReference(recipe);
  const scope = record(recipe.contextHandleScope, 'Frozen Context handle scope');
  if (typeof scope.conversationId !== 'string' || !scope.conversationId
    || !(scope.rootId === null || typeof scope.rootId === 'string' && scope.rootId.length > 0)
    || typeof scope.provenanceRevision !== 'string' || !/^(0|[1-9]\d*)$/.test(scope.provenanceRevision)
    || typeof scope.resetFence !== 'string' || !/^(0|[1-9]\d*)$/.test(scope.resetFence)) {
    throw invalid('Frozen catalog reference requires its exact producer scope.');
  }
  const base = await readFrozenContextHandleCatalogBase(database, store, reference.baseContentObjectId, scope.conversationId);
  const floors = { ...modelHandleAllocationFrontier(base) };
  for (const entry of reference.addedEntries) {
    const ordinal = Number(entry.ref.slice(1));
    if (ordinal !== (floors[entry.kind] ?? 0) + 1) throw invalid('Frozen catalog addition does not follow the reserved allocation frontier.');
    floors[entry.kind] = ordinal;
  }
  const catalog = prepareModelHandleCatalogOverlay(base, [
    ...reference.metadataExtensions.map(entry => ({ kind: 'extend-metadata' as const, entry })),
    ...reference.addedEntries.map(entry => ({ kind: 'bind' as const, entry }))
  ], { leadingEntries: reference.attachmentEntries });
  rememberPreparedModelHandleBase(database, store, catalog, base);
  return catalog;
}

/** The live request retains the exact persistent base even when it exceeds the idle LRU budget. */
export function rememberPreparedModelHandleBase(database: RuntimeDatabase, store: ContentAddressedStore,
  catalog: PreparedModelHandleCatalog, baseCatalog: ModelHandleCatalog): void {
  const base = storedHandleCatalog(database, store, baseCatalog);
  if (base) preparedBases.set(catalog, { database, store, base });
}

export function preparedModelHandleBase(database: RuntimeDatabase, store: ContentAddressedStore,
  catalog: ModelHandleCatalog, contentObjectId: string | null | undefined): StoredHandleCatalog | undefined {
  const retained = preparedBases.get(catalog);
  return retained?.database === database && retained.store === store && retained.base.metadata.id === contentObjectId
    ? retained.base : undefined;
}

/** Request holders publish their already-prepared base to all readers of that immutable CAS id. */
export function retainPreparedModelHandleBase(database: RuntimeDatabase, store: ContentAddressedStore,
  catalog: ModelHandleCatalog): (() => void) | undefined {
  const retained = preparedBases.get(catalog);
  return retained?.database === database && retained.store === store
    ? retainStoredHandleCatalog(database, store, retained.base) : undefined;
}

/** Producer-owned immutable recipes carry their prepared lookup through preview, commit and use. */
export function rememberPreparedFrozenModelHandleCatalog(recipe: object, catalog: unknown): PreparedModelHandleCatalog {
  const prepared = prepareModelHandleCatalog(catalog);
  preparedRecipes.set(recipe, prepared);
  return prepared;
}

export function preparedFrozenModelHandleCatalog(recipe: unknown): PreparedModelHandleCatalog | undefined {
  return recipe !== null && typeof recipe === 'object' ? preparedRecipes.get(recipe) : undefined;
}

/** Synchronous projection consumes a resolved catalog, or an unchanged published inline recipe. */
export function providerRequestModelHandleCatalog(request: { recipe: unknown; resolvedModelHandleCatalog?: ModelHandleCatalog }): ModelHandleCatalog {
  if (request.resolvedModelHandleCatalog !== undefined) return request.resolvedModelHandleCatalog;
  const recipe = record(request.recipe, 'Provider recipe');
  if ('modelHandleCatalogReference' in recipe) throw invalid('Provider request has not resolved its frozen catalog reference.');
  return normalizeModelHandleCatalog(recipe.modelHandleCatalog);
}

/** Attachment-only historical reminders need no cumulative persistent base or current registry. */
export function frozenRecipeAttachmentHandles(recipeValue: unknown): ModelHandleCatalog {
  const recipe = record(recipeValue, 'Frozen recipe');
  if (!('modelHandleCatalogReference' in recipe)) return normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  return normalizeModelHandleCatalog({ entries: readReference(recipe).attachmentEntries });
}

function readReference(recipe: Record<string, unknown>): FrozenModelHandleCatalogReference {
  if (recipe.kind !== 'reliable-agent-turn' || 'modelHandleCatalog' in recipe) {
    throw invalid('Frozen catalog reference requires an ordinary recipe with no inline catalog.');
  }
  const reference = record(recipe.modelHandleCatalogReference, 'Frozen model handle catalog reference');
  if (Object.keys(reference).some(key => !['baseContentObjectId', 'attachmentEntries', 'addedEntries', 'metadataExtensions'].includes(key))
    || !(reference.baseContentObjectId === null || typeof reference.baseContentObjectId === 'string' && reference.baseContentObjectId.length > 0)) {
    throw invalid('Frozen catalog reference has an invalid base or shape.');
  }
  const entries = (key: string, attachment: boolean): readonly ModelHandleEntry[] => {
    if (!Array.isArray(reference[key])) throw invalid(`Frozen catalog reference requires ${key}.`);
    const catalog = normalizeModelHandleCatalog({ entries: reference[key] });
    if (catalog.entries.some(entry => (entry.kind === 'attachment') !== attachment)) {
      throw invalid(`Frozen catalog ${key} has an invalid handle kind.`);
    }
    return catalog.entries;
  };
  return { baseContentObjectId: reference.baseContentObjectId as string | null,
    attachmentEntries: entries('attachmentEntries', true), addedEntries: entries('addedEntries', false),
    metadataExtensions: entries('metadataExtensions', false) };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' }); }

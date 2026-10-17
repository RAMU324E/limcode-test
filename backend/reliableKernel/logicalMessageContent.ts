import type { ModelOutputItemReference } from '../../shared/protocol';
import { ContentAddressedStore, type ContentObjectMetadata, type PreparedContentObject } from './contentAddressedStore';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';
export const NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE = 'application/vnd.limcode.native-message-composition+json';
export const NATIVE_MESSAGE_BLOCK_CONTENT_TYPE = 'application/vnd.limcode.native-message-block+json';
export const NATIVE_MESSAGE_BLOCK_CAPACITY = 32;
const PREFIX = Buffer.from('{"parts":[');
const SUFFIX = Buffer.from('],"role":"model"}');
const COMMA = Buffer.from(',');

export interface NativeMessageItem {
  revisionId: string;
  contentObjectId: string;
  partByteLength: number;
  /** Offset of the canonical part in the unchanged item CAS, when that CAS is canonical. */
  partByteOffset?: number;
  outputItem?: ModelOutputItemReference;
}

export interface NativeMessageComposition {
  kind: 'native_message_composition';
  tailBlockContentObjectId: string;
  itemCount: number;
  partsByteLength: number;
  logicalByteLength: number;
}

export interface NativeMessageBlock {
  kind: 'native_message_block';
  previousBlockContentObjectId: string | null;
  firstSequence: number;
  precedingPartsByteLength: number;
  items: NativeMessageItem[];
}

export interface NativeMessageItemsPage {
  totalItems: number;
  totalBytes: number;
  items: Array<NativeMessageItem & { id: string; sequence: number }>;
  nextSequence?: number;
}

export function logicalMessageContentType(contentType: string): string {
  return contentType === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE ? MESSAGE_CONTENT_TYPE : contentType;
}

export function parseNativeMessageComposition(value: unknown): NativeMessageComposition {
  const root = record(value, 'Native Message composition');
  if (root.kind !== 'native_message_composition') throw new TypeError('Unsupported native Message composition.');
  const partsByteLength = integer(root.partsByteLength, 'partsByteLength');
  const logicalByteLength = integer(root.logicalByteLength, 'logicalByteLength');
  if (logicalByteLength !== PREFIX.length + partsByteLength + SUFFIX.length) throw new TypeError('Native Message composition has inconsistent logical length.');
  return { kind: 'native_message_composition', tailBlockContentObjectId: id(root.tailBlockContentObjectId),
    itemCount: integer(root.itemCount, 'itemCount', 1), partsByteLength, logicalByteLength };
}

export function parseNativeMessageBlock(value: unknown): NativeMessageBlock {
  const block = record(value, 'Native Message block');
  if (block.kind !== 'native_message_block'
    || !Array.isArray(block.items) || block.items.length === 0 || block.items.length > NATIVE_MESSAGE_BLOCK_CAPACITY) {
    throw new TypeError('Unsupported native Message block.');
  }
  const firstSequence = integer(block.firstSequence, 'firstSequence', 1);
  const precedingPartsByteLength = integer(block.precedingPartsByteLength, 'precedingPartsByteLength');
  const previousBlockContentObjectId = block.previousBlockContentObjectId === null ? null : id(block.previousBlockContentObjectId);
  if ((firstSequence === 1) !== (previousBlockContentObjectId === null) || (firstSequence === 1 && precedingPartsByteLength !== 0)) {
    throw new TypeError('Native Message block has an inconsistent predecessor.');
  }
  return { kind: 'native_message_block', previousBlockContentObjectId, firstSequence, precedingPartsByteLength,
    items: block.items.map(value => {
      const item = record(value, 'Native Message item');
      return { revisionId: id(item.revisionId), contentObjectId: id(item.contentObjectId), partByteLength: integer(item.partByteLength, 'partByteLength', 1),
        ...(item.partByteOffset === undefined ? {} : { partByteOffset: integer(item.partByteOffset, 'partByteOffset') }),
        ...(item.outputItem === undefined ? {} : { outputItem: outputItemReference(item.outputItem) }) };
    }) };
}

export interface SerializedNativeMessageItem {
  content: string;
  part: Record<string, PlainJsonValue>;
  partByteLength: number;
  partByteOffset: number;
  outputItem?: ModelOutputItemReference;
}

/** One serialization of the new part supplies both its item body and its logical range. */
export function serializeNativeMessageItem(part: unknown): SerializedNativeMessageItem {
  const value = record(part, 'Native Message part');
  const normalized = normalizePlainJson(value, 'Native Message part') as Record<string, PlainJsonValue>;
  const content = JSON.stringify(normalized);
  return { content: PREFIX.toString('utf8') + content + SUFFIX.toString('utf8'),
    part: normalized,
    partByteLength: Buffer.byteLength(content), partByteOffset: PREFIX.length,
    ...(value.outputItem === undefined ? {} : { outputItem: outputItemReference(value.outputItem) }) };
}

/** One MessageContent reader for transcript, preview, recovery, copying and explicit full reads. */
export class LogicalMessageContentReader {
  private readonly metadataCache = new Map<string, ContentObjectMetadata>();
  private readonly blockCache = new Map<string, NativeMessageBlock>();
  private readonly compositionCache = new Map<string, NativeMessageComposition>();
  private readonly navigationCache = new Map<string, {
    rootTailId: string; blockId: string; firstSequence: number; endSequence: number; partsEnd: number
  }>();
  public constructor(private readonly database: Pick<RuntimeDatabase, 'snapshot'>,
    private readonly contentStore: Pick<ContentAddressedStore, 'read' | 'readMany' | 'readChunk'>) {}

  public async read(metadata: ContentObjectMetadata): Promise<Buffer> {
    if (metadata.content_type !== NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) return this.contentStore.read(metadata);
    const root = await this.readComposition(metadata);
    return this.readCompositionRange(root, 0, root.logicalByteLength);
  }

  public async readMany(metadata: readonly ContentObjectMetadata[]): Promise<Buffer[]> {
    const ordinary = metadata.flatMap((value, index) => value.content_type === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE ? [] : [{ value, index }]);
    const result: Buffer[] = new Array(metadata.length);
    if (ordinary.length) {
      const bytes = await this.contentStore.readMany(ordinary.map(entry => entry.value));
      ordinary.forEach((entry, index) => { result[entry.index] = bytes[index]!; });
    }
    for (let index = 0; index < metadata.length; index += 1) {
      if (metadata[index]!.content_type === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) result[index] = await this.read(metadata[index]!);
    }
    return result;
  }

  public async readChunk(metadata: ContentObjectMetadata, offset: number, maxBytes: number): Promise<{
    chunk: Buffer; totalBytes: number; nextOffset?: number; hasMore: boolean
  }> {
    integer(offset, 'Message offset'); integer(maxBytes, 'Message range length', 1);
    if (metadata.content_type !== NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) return this.contentStore.readChunk(metadata, offset, maxBytes);
    const root = await this.readComposition(metadata);
    if (offset > root.logicalByteLength) throw new RangeError('Message range offset exceeds logical content length.');
    const end = Math.min(root.logicalByteLength, offset + maxBytes);
    const chunk = await this.readCompositionRange(root, offset, end);
    const hasMore = end < root.logicalByteLength;
    return { chunk, totalBytes: root.logicalByteLength, hasMore, ...(hasMore ? { nextOffset: end } : {}) };
  }

  public async byteLength(metadata: ContentObjectMetadata): Promise<number> {
    return metadata.content_type === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE
      ? (await this.readComposition(metadata)).logicalByteLength : integer(Number(metadata.byte_length), 'Message byte length');
  }

  public async readNativeItems(metadata: ContentObjectMetadata, input: {
    afterSequence?: number; limit: number
  }): Promise<NativeMessageItemsPage> {
    const limit = integer(input.limit, 'Native item page limit', 1);
    if (limit > 256) throw new RangeError('Native item page limit exceeds 256.');
    const root = await this.readComposition(metadata);
    const after = input.afterSequence === undefined ? Math.max(0, root.itemCount - limit)
      : integer(input.afterSequence, 'Native item cursor');
    if (after > root.itemCount) throw new RangeError('Native item cursor exceeds committed items.');
    const end = Math.min(root.itemCount, after + limit);
    if (after === end) return { totalItems: root.itemCount, totalBytes: root.logicalByteLength, items: [] };
    const blocks = await this.blocks(root, block => block.firstSequence <= end,
      block => block.firstSequence > after + 1, point => point.endSequence >= end);
    const items = blocks.reverse().flatMap(block => block.items.flatMap((item, index) => {
      const sequence = block.firstSequence + index;
      return sequence > after && sequence <= end ? [{ ...item, id: item.revisionId, sequence }] : [];
    }));
    return { totalItems: root.itemCount, totalBytes: root.logicalByteLength, items,
      ...(end < root.itemCount ? { nextSequence: end } : {}) };
  }

  public async readComposition(metadata: ContentObjectMetadata): Promise<NativeMessageComposition> {
    if (metadata.content_type !== NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) throw new TypeError('Message content is not a native composition.');
    return this.readParsedContent(metadata, this.compositionCache, parseNativeMessageComposition, 64);
  }

  public async readBlock(contentObjectId: string): Promise<NativeMessageBlock> {
    const metadata = (await this.metadata([contentObjectId]))[0]!;
    if (metadata.content_type !== NATIVE_MESSAGE_BLOCK_CONTENT_TYPE) throw new TypeError('Native Message predecessor is not an item block.');
    return this.readParsedContent(metadata, this.blockCache, parseNativeMessageBlock, 128);
  }

  private async readParsedContent<T>(metadata: ContentObjectMetadata, cache: Map<string, T>,
    parse: (value: unknown) => T, limit: number): Promise<T> {
    const cached = cache.get(metadata.id);
    // The same CAS range read owns file/root checks on both paths; a parsed hit needs one byte.
    const bytes = await this.readStoredContent(metadata, cached === undefined ? undefined : 1);
    if (cached !== undefined) return cached;
    const parsed = parse(JSON.parse(bytes.toString('utf8')));
    this.remember(cache, metadata.id, parsed, limit);
    return parsed;
  }

  private async readStoredContent(metadata: ContentObjectMetadata, maxBytes = Number(metadata.byte_length)): Promise<Buffer> {
    return (await this.contentStore.readChunk(metadata, 0, Math.max(1, maxBytes))).chunk;
  }

  private async blocks(root: NativeMessageComposition, select: (block: NativeMessageBlock) => boolean,
    older: (block: NativeMessageBlock) => boolean,
    coversEnd: (point: { endSequence: number; partsEnd: number }) => boolean): Promise<NativeMessageBlock[]> {
    const selected: NativeMessageBlock[] = [];
    let next: string | null = root.tailBlockContentObjectId;
    let nextSequence = root.itemCount + 1;
    // Reuse only links already traversed from this exact immutable tail. A nearby page need not
    // walk every newer block again; the cache holds bounded addressing metadata, never bodies.
    for (const point of this.navigationCache.values()) {
      if (point.rootTailId === root.tailBlockContentObjectId && coversEnd(point)
        && point.endSequence + 1 < nextSequence) {
        next = point.blockId;
        nextSequence = point.endSequence + 1;
      }
    }
    while (next) {
      const block = await this.readBlock(next);
      if (block.firstSequence + block.items.length !== nextSequence) throw new TypeError('Native Message block sequence is discontinuous.');
      this.remember(this.navigationCache, `${root.tailBlockContentObjectId}:${next}`, {
        rootTailId: root.tailBlockContentObjectId, blockId: next, firstSequence: block.firstSequence,
        endSequence: nextSequence - 1,
        partsEnd: block.precedingPartsByteLength + block.items.reduce((bytes, item) => bytes + item.partByteLength + 1, 0)
          - (block.firstSequence === 1 ? 1 : 0)
      }, 256);
      if (select(block)) selected.push(block);
      if (!older(block)) break;
      nextSequence = block.firstSequence;
      next = block.previousBlockContentObjectId;
    }
    return selected;
  }

  private async readCompositionRange(root: NativeMessageComposition, start: number, end: number): Promise<Buffer> {
    if (start === end) return Buffer.alloc(0);
    const segments: Array<{ offset: number; bytes?: Buffer; item?: NativeMessageItem }> = [];
    const addBytes = (offset: number, bytes: Buffer) => {
      if (offset < end && offset + bytes.length > start) segments.push({ offset, bytes });
    };
    addBytes(0, PREFIX);
    if (end > PREFIX.length && start < PREFIX.length + root.partsByteLength) {
      const blocks = await this.blocks(root, block => PREFIX.length + block.precedingPartsByteLength < end,
        block => PREFIX.length + block.precedingPartsByteLength > start,
        point => PREFIX.length + point.partsEnd >= Math.min(end, PREFIX.length + root.partsByteLength));
      for (const block of blocks) {
        let offset = PREFIX.length + block.precedingPartsByteLength;
        block.items.forEach((item, index) => {
          if (block.firstSequence + index > 1) { addBytes(offset, COMMA); offset += 1; }
          if (offset < end && offset + item.partByteLength > start) segments.push({ offset, item });
          offset += item.partByteLength;
        });
      }
    }
    addBytes(PREFIX.length + root.partsByteLength, SUFFIX);
    segments.sort((a, b) => a.offset - b.offset);
    const ids = [...new Set(segments.flatMap(segment => segment.item ? [segment.item.contentObjectId] : []))];
    const metadata = new Map((await this.metadata(ids)).map(value => [value.id, value]));
    const chunks: Buffer[] = [];
    for (const segment of segments) {
      const localStart = Math.max(0, start - segment.offset);
      const length = Math.min(end - segment.offset, segment.item?.partByteLength ?? segment.bytes!.length) - localStart;
      if (segment.bytes) chunks.push(segment.bytes.subarray(localStart, localStart + length));
      else {
        const item = segment.item!, object = metadata.get(item.contentObjectId)!;
        if (object.content_type !== MESSAGE_CONTENT_TYPE) throw new TypeError('Native Message item is not MessageContent.');
        if (item.partByteOffset !== undefined) {
          chunks.push((await this.contentStore.readChunk(object, item.partByteOffset + localStart, length)).chunk);
        } else {
          // Published non-canonical item CAS remains unchanged; only an explicitly read item is decoded.
          const message = record(JSON.parse((await this.readStoredContent(object)).toString('utf8')), 'Native Message item');
          if (message.role !== 'model' || !Array.isArray(message.parts) || message.parts.length !== 1) throw new TypeError('Native Message item must contain one model part.');
          const bytes = Buffer.from(canonicalPlainJson(message.parts[0], 'Native Message part'));
          chunks.push(bytes.subarray(localStart, localStart + length));
        }
      }
    }
    return Buffer.concat(chunks, end - start);
  }

  private async metadata(ids: readonly string[]): Promise<ContentObjectMetadata[]> {
    if (ids.length === 0) return [];
    const rows = new Map<string, ContentObjectMetadata>();
    const missing = [...new Set(ids)].filter(id => {
      const row = this.metadataCache.get(id);
      if (row) rows.set(id, row);
      return !row;
    });
    for (let offset = 0; offset < missing.length; offset += 256) {
      const batch = missing.slice(offset, offset + 256);
      const result = await this.database.snapshot(batch.map(value => DOMAIN_REPOSITORIES.domain('ContentObject').get(value)));
      result.snapshot.forEach((row, index) => {
        if (!row || Array.isArray(row)) throw new Error(`Native Message ContentObject ${batch[index]} is unavailable.`);
        rows.set(batch[index]!, row as ContentObjectMetadata);
        this.remember(this.metadataCache, batch[index]!, row as ContentObjectMetadata, 256);
      });
    }
    return ids.map(id => rows.get(id)!);
  }

  private remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
    cache.set(key, value);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
  }
}

/** Prepare only the bounded tail and its fixed-size root; the caller's existing transaction owns registration. */
export async function prepareNativeMessageComposition(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  previous: ContentObjectMetadata | null, item: NativeMessageItem, recoveredItems: readonly NativeMessageItem[] = [],
  reader = new LogicalMessageContentReader(database, contentStore)): Promise<{
    content: PreparedContentObject; relatedContentObjects: PreparedContentObject[]
  }> {
  const prepared: PreparedContentObject[] = [];
  let root: NativeMessageComposition | undefined;
  let tail: NativeMessageBlock | undefined;
  let tailId: string | undefined;
  if (previous?.content_type === NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) {
    root = await reader.readComposition(previous);
    tailId = root.tailBlockContentObjectId;
    tail = await reader.readBlock(tailId);
  } else if (previous) {
    if (recoveredItems.length === 0) throw new Error('Published native Message prefix requires its recovered immutable item facts.');
    return prepareNativeMessageCompositionIndex(database, contentStore, [...recoveredItems, item]);
  }
  const append = async (nextItems: readonly NativeMessageItem[]) => {
    const itemCount = root?.itemCount ?? 0;
    const partsByteLength = (root?.partsByteLength ?? 0)
      + nextItems.reduce((bytes, entry) => bytes + entry.partByteLength + 1, 0) - (itemCount === 0 ? 1 : 0);
    tail = tail && tail.items.length + nextItems.length <= NATIVE_MESSAGE_BLOCK_CAPACITY ? { ...tail, items: [...tail.items, ...nextItems] }
      : { kind: 'native_message_block', previousBlockContentObjectId: tailId ?? null,
          firstSequence: itemCount + 1, precedingPartsByteLength: root?.partsByteLength ?? 0, items: [...nextItems] };
    const block = await contentStore.prepare(database, canonicalPlainJson(tail), NATIVE_MESSAGE_BLOCK_CONTENT_TYPE);
    prepared.push(block);
    tailId = block.metadata.id;
    root = { kind: 'native_message_composition', tailBlockContentObjectId: tailId,
      itemCount: itemCount + nextItems.length, partsByteLength, logicalByteLength: PREFIX.length + partsByteLength + SUFFIX.length };
  };
  await append([item]);
  const content = await contentStore.prepare(database, canonicalPlainJson(root!), NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE);
  return { content, relatedContentObjects: prepared };
}

/** Final output supplies canonical item order once; individual item bodies remain shared. */
export async function prepareNativeMessageCompositionIndex(database: RuntimeDatabase,
  contentStore: ContentAddressedStore, items: readonly NativeMessageItem[]): Promise<{
    content: PreparedContentObject; relatedContentObjects: PreparedContentObject[]
  }> {
  if (items.length === 0) throw new TypeError('Native Message index requires at least one item.');
  const relatedContentObjects: PreparedContentObject[] = [];
  let previousBlockContentObjectId: string | null = null;
  let partsByteLength = 0;
  for (let offset = 0; offset < items.length; offset += NATIVE_MESSAGE_BLOCK_CAPACITY) {
    const entries = items.slice(offset, offset + NATIVE_MESSAGE_BLOCK_CAPACITY);
    const block: NativeMessageBlock = { kind: 'native_message_block', previousBlockContentObjectId,
      firstSequence: offset + 1, precedingPartsByteLength: partsByteLength, items: entries };
    const prepared = await contentStore.prepare(database, canonicalPlainJson(block), NATIVE_MESSAGE_BLOCK_CONTENT_TYPE);
    relatedContentObjects.push(prepared);
    previousBlockContentObjectId = prepared.metadata.id;
    partsByteLength += entries.reduce((bytes, item) => bytes + item.partByteLength + 1, 0) - (offset === 0 ? 1 : 0);
  }
  const root: NativeMessageComposition = { kind: 'native_message_composition', tailBlockContentObjectId: previousBlockContentObjectId!,
    itemCount: items.length, partsByteLength, logicalByteLength: PREFIX.length + partsByteLength + SUFFIX.length };
  const content = await contentStore.prepare(database, canonicalPlainJson(root), NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE);
  return { content, relatedContentObjects };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Native Message identity must be non-empty.');
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} must be an integer at least ${minimum}.`);
  return value;
}

function outputItemReference(value: unknown): ModelOutputItemReference {
  const item = record(value, 'Native output item reference');
  if (item.phase !== undefined && item.phase !== 'commentary' && item.phase !== 'final_answer') throw new TypeError('Native output item phase is invalid.');
  return { id: id(item.id), ordinal: integer(item.ordinal, 'Native output ordinal'),
    ...(item.phase === undefined ? {} : { phase: item.phase }),
    ...(item.providerResponseId === undefined ? {} : { providerResponseId: id(item.providerResponseId) }),
    ...(item.previousResponseId === undefined ? {} : { previousResponseId: id(item.previousResponseId) }),
    ...(item.steeringSuccessorResponseId === undefined ? {} : { steeringSuccessorResponseId: id(item.steeringSuccessorResponseId) }) };
}

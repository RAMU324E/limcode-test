import { attachmentSourceBelongsToConversation } from './attachmentProjectionEvidence';
import type { AttachmentCatalogEntry } from '../../shared/protocol';
import {
  AttachmentCatalogAccumulator,
  mergeAttachmentCatalog,
  normalizeAttachmentCatalogState,
  type AttachmentCatalogPlacement,
  type AttachmentCatalogState
} from './attachmentCatalog';
import {
  type ContextSegmentKind,
  type ContextSourceOccurrence,
  classifyToolPairSources,
  validateScopedContextSegmentSources
} from './contextSequence';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AttachmentCatalogProjectionSegment {
  segmentId: string;
}

interface PreparedAttachmentSegment {
  readonly segmentId: string;
  readonly segmentKind: ContextSegmentKind;
  readonly catalog: readonly AttachmentCatalogEntry[];
}

/** Immutable prepared facts only: no database, source-row caches, or attachment bodies are retained. */
export class PreparedAttachmentCatalogProjection {
  public constructor(
    private readonly segments: readonly PreparedAttachmentSegment[],
    private readonly additionalCatalog: readonly AttachmentCatalogEntry[]
  ) {}

  public projectState(): AttachmentCatalogState {
    return this.reduceRange(0, this.segments.length, this.additionalCatalog);
  }

  /** Replays a half-open range from an empty catalog, without current-Turn additions. */
  public projectRange(start: number, end: number): AttachmentCatalogState {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > this.segments.length) {
      throw new RangeError('Attachment catalog range must be within the prepared segment sequence.');
    }
    return this.reduceRange(start, end, []);
  }

  private reduceRange(
    start: number,
    end: number,
    additionalCatalog: readonly AttachmentCatalogEntry[]
  ): AttachmentCatalogState {
    const accumulated = new AttachmentCatalogAccumulator();
    const append = (entries: readonly AttachmentCatalogEntry[]): ReadonlySet<string> => {
      const addedIds = new Set<string>();
      for (const candidate of entries) {
        const addedId = accumulated.add(candidate);
        if (addedId !== undefined) addedIds.add(addedId);
      }
      return addedIds;
    };
    // Match membership before each append, including repeated/noncanonical input ids. Keep
    // raw deltas for the final state normalizer's validation order and independent copies.
    const deltaFrom = (entries: readonly AttachmentCatalogEntry[], addedIds: ReadonlySet<string>): AttachmentCatalogEntry[] =>
      entries.filter((entry) => !accumulated.has(entry.attachmentId) || addedIds.has(entry.attachmentId));
    const placements: AttachmentCatalogPlacement[] = [];
    for (let index = start; index < end; index += 1) {
      const segment = this.segments[index];
      const addedIds = append(segment.catalog);
      if (segment.segmentKind === 'compression') {
        // A checkpoint owns this prefix array; later appends must not extend it.
        const catalog = accumulated.snapshot();
        if (catalog.length > 0) {
          placements.push({
            kind: 'attachment_catalog_checkpoint',
            afterSegmentId: segment.segmentId,
            entries: catalog
          });
        }
        continue;
      }
      const delta = deltaFrom(segment.catalog, addedIds);
      if (delta.length > 0) {
        placements.push({
          kind: 'attachment_catalog_delta',
          afterSegmentId: segment.segmentId,
          entries: delta
        });
      }
    }
    const currentTurnDelta = deltaFrom(additionalCatalog, append(additionalCatalog));
    if (currentTurnDelta.length > 0) {
      placements.push({ kind: 'current_turn_delta', entries: currentTurnDelta });
    }
    // Normalization also gives each caller independent mutable result objects.
    return normalizeAttachmentCatalogState({ catalog: accumulated.snapshot(), placements }, 'projected attachmentCatalogState');
  }
}

// Cache individual immutable segments, so growing a window does not expand its old compression.
const PREPARED_PROJECTION_CACHE_LIMITS = { conversations: 8, bytes: 32 * 1024 * 1024 };
const preparedProjectionCaches = new WeakMap<RuntimeDatabase, PreparedProjectionCache>();
interface ProjectionDependencies {
  segments: Set<string>; blocks: Set<string>; revisions: Set<string>; messages: Set<string>;
}
interface PreparedProjectionEntry {
  segments: Map<string, PreparedAttachmentSegment>;
  dependencies: ProjectionDependencies;
  bytes: number;
  pending: number;
}
interface PreparedProjectionRead {
  value: PreparedAttachmentCatalogProjection;
  segments: PreparedAttachmentSegment[];
  dependencies: ProjectionDependencies;
  reused: boolean;
}

class PreparedProjectionCache {
  private readonly entries = new Map<string, PreparedProjectionEntry>();
  private bytes = 0;
  private externalVersion?: string;

  public constructor(private readonly database: RuntimeDatabase) {
    database.onCommit(commit => {
      const changed = commit.attachmentProjectionChanges;
      if (!changed) return;
      if (changed.reset) { this.clear(); return; }
      for (const [conversationId, entry] of this.entries) {
        if (entry.pending > 0 || changed.segments.some(id => entry.dependencies.segments.has(id))
          || changed.blocks.some(id => entry.dependencies.blocks.has(id))
          || changed.revisions.some(id => entry.dependencies.revisions.has(id))
          || changed.messages.some(id => entry.dependencies.messages.has(id))) {
          this.entries.delete(conversationId); this.bytes -= entry.bytes;
        }
      }
    });
  }

  private clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  private synchronizeVersion(version: string): void {
    if (version !== this.externalVersion) {
      this.clear();
      this.externalVersion = version;
    }
  }

  public async read(conversationId: string,
    prepare: (known: ReadonlyMap<string, PreparedAttachmentSegment>) => Promise<PreparedProjectionRead>): Promise<PreparedAttachmentCatalogProjection> {
    // This worker request revalidates the root binding, including on a cache hit or after close.
    const version = await this.database.externalDataVersion();
    this.synchronizeVersion(version);
    let entry = this.entries.get(conversationId);
    if (!entry) {
      entry = { segments: new Map(), dependencies: { segments: new Set(), blocks: new Set(), revisions: new Set(), messages: new Set() }, bytes: 256, pending: 0 };
      this.entries.set(conversationId, entry); this.bytes += entry.bytes;
    }
    this.entries.delete(conversationId); this.entries.set(conversationId, entry);
    let result: PreparedProjectionRead;
    entry.pending++;
    try { result = await prepare(entry.segments); } finally { entry.pending--; }
    const after = await this.database.externalDataVersion();
    if (after !== version || this.entries.get(conversationId) !== entry) {
      this.synchronizeVersion(after);
      return result.reused ? (await prepare(new Map())).value : result.value;
    }
    let addedBytes = 0;
    for (const segment of result.segments) if (!entry.segments.has(segment.segmentId)) {
      entry.segments.set(segment.segmentId, segment);
      addedBytes += 160 + 2 * segment.segmentId.length + segment.catalog.reduce((sum, item) =>
        sum + 192 + 2 * (item.attachmentId.length + item.name.length + item.mimeType.length), 0);
    }
    for (const kind of ['segments', 'blocks', 'revisions', 'messages'] as const) {
      for (const id of result.dependencies[kind]) if (!entry.dependencies[kind].has(id)) {
        entry.dependencies[kind].add(id); addedBytes += 96 + 2 * id.length;
      }
    }
    entry.bytes += addedBytes; this.bytes += addedBytes;
    while (this.entries.size > PREPARED_PROJECTION_CACHE_LIMITS.conversations || this.bytes > PREPARED_PROJECTION_CACHE_LIMITS.bytes) {
      const [id, oldest] = this.entries.entries().next().value!;
      this.entries.delete(id); this.bytes -= oldest.bytes;
    }
    return result.value;
  }

}

/**
 * Rebuilds the model-only attachment directory from immutable Context lineage and AttachmentLink
 * relations. It never reads attachment bodies or trusts convenience metadata embedded in CAS JSON.
 */
export class AttachmentCatalogProjection {
  private readonly segmentCache = new Map<string, DomainRow>();
  private readonly sourceCache = new Map<string, DomainRow[]>();
  private readonly compressionBlockCache = new Map<string, DomainRow>();
  private readonly blockSourceCache = new Map<string, DomainRow[]>();
  private readonly revisionLinkCache = new Map<string, DomainRow[]>();
  private readonly messageRevisionCache = new Map<string, DomainRow>();
  private readonly messageMembershipCache = new Map<string, DomainRow[]>();
  private readonly toolCallCache = new Map<string, DomainRow>();
  private readonly toolResultCache = new Map<string, DomainRow>();
  private readonly turnCache = new Map<string, DomainRow>();
  private readonly attachmentCache = new Map<string, DomainRow>();
  private reusedSegments = false;

  public constructor(private readonly database: RuntimeDatabase) {}

  public async project(
    conversationId: string,
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<AttachmentCatalogEntry[]> {
    return (await this.projectState(conversationId, segments, additionalMessageRevisionIds)).catalog;
  }

  public async projectState(
    conversationId: string,
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<AttachmentCatalogState> {
    return (await this.prepare(conversationId, segments, additionalMessageRevisionIds)).projectState();
  }

  public prepare(
    conversationId: string,
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<PreparedAttachmentCatalogProjection> {
    const selectedConversationId = requireId(conversationId, 'conversationId');
    const prepare = (): Promise<PreparedAttachmentCatalogProjection> => new AttachmentCatalogProjection(this.database).prepareIsolated(
      selectedConversationId,
      segments,
      additionalMessageRevisionIds
    );
    // Invalid runtime inputs keep the original reader's validation order. Maintenance has no
    // commit stream, and repository test doubles must not claim freshness they cannot prove.
    if (this.database.maintenance || typeof this.database.onCommit !== 'function'
      || typeof this.database.externalDataVersion !== 'function'
      || !Array.isArray(segments) || !segments.every(segment => segment && typeof segment.segmentId === 'string')
      || !Array.isArray(additionalMessageRevisionIds) || !additionalMessageRevisionIds.every(id => typeof id === 'string')) return prepare();
    // Snapshot the declared readonly input before the first asynchronous freshness fence. A
    // caller retaining its arrays must not be able to publish facts under a different key.
    const selectedSegments = segments.map(segment => ({ segmentId: segment.segmentId }));
    const selectedRevisions = [...additionalMessageRevisionIds];
    let cache = preparedProjectionCaches.get(this.database);
    if (!cache) { cache = new PreparedProjectionCache(this.database); preparedProjectionCaches.set(this.database, cache); }
    return cache.read(selectedConversationId, async known => {
      const reader = new AttachmentCatalogProjection(this.database);
      const value = await reader.prepareIsolated(selectedConversationId, selectedSegments, selectedRevisions, known);
      return { value, segments: reader.preparedSegments, reused: reader.reusedSegments, dependencies: {
        segments: new Set(reader.segmentCache.keys()), blocks: new Set(reader.compressionBlockCache.keys()),
        revisions: new Set(reader.messageRevisionCache.keys()), messages: new Set(reader.messageMembershipCache.keys())
      } };
    });
  }

  private preparedSegments: PreparedAttachmentSegment[] = [];

  private async prepareIsolated(
    conversationId: string,
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[],
    known: ReadonlyMap<string, PreparedAttachmentSegment> = new Map()
  ): Promise<PreparedAttachmentCatalogProjection> {
    const segmentIds = segments.map((segment) => requireId(segment.segmentId, 'segmentId'));
    const missing = segmentIds.filter(id => !known.has(id));
    await this.primeCompressionLineage(conversationId, missing, known);
    const revisionsBySegment: Array<Array<string | readonly AttachmentCatalogEntry[]>> = [];
    for (const segmentId of segmentIds) {
      const revisions: Array<string | readonly AttachmentCatalogEntry[]> = [];
      await this.collectSegmentRevisions(conversationId, segmentId, revisions, new Set<string>(), known);
      revisionsBySegment.push(revisions);
    }
    const additionalRevisionIds = additionalMessageRevisionIds.map((revisionId) =>
      requireId(revisionId, 'messageRevisionId')
    );
    await this.primeMessageRevisionOwners(additionalRevisionIds);
    for (const revisionId of additionalRevisionIds) {
      if (!this.messageRevisionBelongsToConversation(revisionId, conversationId)) {
        throw new Error(`MessageRevision ${revisionId} does not belong to Conversation ${conversationId}.`);
      }
    }

    const uniqueRevisions = [...new Set([...revisionsBySegment.flat().filter((id): id is string => typeof id === 'string'), ...additionalRevisionIds])];
    await this.primeDomainRows('MessageRevision', uniqueRevisions, this.messageRevisionCache);
    for (const [segmentId] of this.sourceCache) {
      for (const source of this.scopedSources(segmentId, conversationId)) {
        if (source.source_kind !== 'message_revision') continue;
        const revisionId = requireId(source.source_id, 'ContextSegmentSource.source_id');
        const revision = this.messageRevisionCache.get(revisionId);
        if (!revision) throw new Error(`MessageRevision ${revisionId} cache was not primed.`);
        if (requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq')
          !== requireBigInt(source.source_revision, 'ContextSegmentSource.source_revision')) {
          throw new Error(`MessageRevision ${revisionId} source_revision does not match revision_seq.`);
        }
        const segment = this.segmentCache.get(segmentId);
        if (!segment) throw new Error(`ContextSegment ${segmentId} cache was not primed.`);
        if (requireId(segment.content_object_id, 'ContextSegment.content_object_id')
          !== requireId(revision.content_object_id, 'MessageRevision.content_object_id')) {
          throw new Error(`Message segment ${segmentId} content does not match MessageRevision ${revisionId}.`);
        }
      }
    }
    await this.primeRevisionLinks(uniqueRevisions);
    await this.primeAttachments(uniqueRevisions.flatMap((revisionId) =>
      (this.revisionLinkCache.get(revisionId) ?? []).map((link) =>
        requireId(link.attachment_id, 'AttachmentLink.attachment_id')
      )
    ));
    const catalogByRevision = new Map<string, AttachmentCatalogEntry[]>();
    for (const revisionId of uniqueRevisions) {
      catalogByRevision.set(revisionId, await this.catalogForRevision(revisionId));
    }

    // Preserve every occurrence before cumulative deduplication: an output-only view must still
    // contain an attachment that also appeared earlier in the full Context.
    const preparedSegments = segmentIds.map((segmentId, index): PreparedAttachmentSegment => {
      const cached = known.get(segmentId);
      if (cached) return cached;
      const segmentCatalog = mergeAttachmentCatalog(...revisionsBySegment[index].map((revisionId) =>
        typeof revisionId === 'string' ? catalogByRevision.get(revisionId) ?? [] : revisionId
      ));
      const segment = this.segmentCache.get(segmentId);
      if (!segment) throw new Error(`ContextSegment ${segmentId} cache was not primed.`);
      return Object.freeze({
        segmentId,
        segmentKind: requireSegmentKind(segment.segment_kind),
        catalog: Object.freeze(segmentCatalog.map((entry) => Object.freeze(entry)))
      });
    });
    this.preparedSegments = preparedSegments.filter(segment => !known.has(segment.segmentId));
    const additionalCatalog = mergeAttachmentCatalog(...additionalRevisionIds.map((revisionId) =>
      catalogByRevision.get(revisionId) ?? []
    ));
    return new PreparedAttachmentCatalogProjection(
      Object.freeze(preparedSegments),
      Object.freeze(additionalCatalog.map((entry) => Object.freeze(entry)))
    );
  }

  private async collectSegmentRevisions(
    conversationId: string,
    segmentId: string,
    revisions: Array<string | readonly AttachmentCatalogEntry[]>,
    path: Set<string>,
    known: ReadonlyMap<string, PreparedAttachmentSegment>
  ): Promise<void> {
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    const cached = known.get(segmentId);
    if (cached) { revisions.push(cached.catalog); this.reusedSegments = true; return; }
    const segment = await this.segment(segmentId);
    const segmentKind = requireSegmentKind(segment.segment_kind);
    const sources = this.scopedSources(segmentId, conversationId);
    const occurrences = sources.map(contextSourceOccurrence);
    if (segmentKind !== 'tool_pair') validateScopedContextSegmentSources(segmentKind, occurrences);

    if (segmentKind === 'compression') {
      const blockId = occurrences[0].sourceId;
      const block = this.compressionBlockCache.get(blockId);
      if (!block) throw new Error(`CompressionBlock ${blockId} cache was not primed.`);
      if (requireId(segment.content_object_id, 'ContextSegment.content_object_id')
        !== requireId(block.summary_object_id, 'CompressionBlock.summary_object_id')) {
        throw new Error(`Compression segment ${segmentId} does not reference CompressionBlock ${blockId} summary content.`);
      }
      const blockSources = this.compressionBlockSources(blockId);
      if (blockSources.length === 0) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
      // Children run sequentially, so one active path preserves repeated DAG occurrences
      // without copying every ancestor at each compression depth.
      path.add(segmentId);
      try {
        const childSegmentIds = blockSources.map((source) =>
          requireId(source.segment_id, 'CompressionBlockSource.segment_id')
        );
        for (const childSegmentId of childSegmentIds) {
          await this.collectSegmentRevisions(conversationId, childSegmentId, revisions, path, known);
        }
      } finally {
        path.delete(segmentId);
      }
      return;
    }

    if (segmentKind === 'message') {
      revisions.push(occurrences[0].sourceId);
      return;
    }
    if (segmentKind === 'tool_pair') {
      const shape = classifyToolPairSources(occurrences);
      if (shape.kind === 'native_call') {
        const call = await this.cachedDomain('ToolCall', shape.call.sourceId, this.toolCallCache);
        if (requireBigInt(call.call_seq, 'ToolCall.call_seq') !== shape.call.sourceRevision) {
          throw new Error(`ToolCall ${shape.call.sourceId} source_revision does not match call_seq.`);
        }
        return;
      }
      const resultSource = shape.result;
      const result = await this.cachedDomain('ToolModelResult', resultSource.sourceId, this.toolResultCache);
      const toolCallId = shape.kind === 'atomic'
        ? shape.call.sourceId
        : requireId(result.tool_call_id, 'ToolModelResult.tool_call_id');
      const call = await this.cachedDomain('ToolCall', toolCallId, this.toolCallCache);
      if (requireBigInt(call.call_seq, 'ToolCall.call_seq') !== resultSource.sourceRevision) {
        throw new Error(`ToolCall ${toolCallId} source_revision does not match call_seq.`);
      }
      if (requireId(result.tool_call_id, 'ToolModelResult.tool_call_id') !== toolCallId) {
        throw new Error(`ToolModelResult ${resultSource.sourceId} does not belong to ToolCall ${toolCallId}.`);
      }
      const revisionId = requireId(result.message_revision_id, 'ToolModelResult.message_revision_id');
      revisions.push(revisionId);
    }
  }

  private async catalogForRevision(revisionId: string): Promise<AttachmentCatalogEntry[]> {
    const links = this.revisionLinkCache.get(revisionId);
    if (!links) throw new Error(`AttachmentLink cache was not primed for MessageRevision ${revisionId}.`);
    const entries: AttachmentCatalogEntry[] = [];
    for (const link of links) {
      const attachmentId = requireId(link.attachment_id, 'AttachmentLink.attachment_id');
      const attachment = this.attachmentCache.get(attachmentId);
      if (!attachment) throw new Error(`Attachment cache was not primed for ${attachmentId}.`);
      entries.push({
        attachmentId,
        name: requireText(attachment.name, 'Attachment.name'),
        mimeType: requireText(attachment.mime_type, 'Attachment.mime_type'),
        sizeBytes: requireSafeInteger(attachment.byte_length, 'Attachment.byte_length')
      });
    }
    return entries;
  }

  private async primeCompressionLineage(
    conversationId: string,
    rootSegmentIds: readonly string[],
    known: ReadonlyMap<string, PreparedAttachmentSegment>
  ): Promise<void> {
    const expanded = new Set<string>();
    let frontier = [...new Set(rootSegmentIds)];
    while (frontier.length > 0) {
      await this.primeSegments(conversationId, frontier);
      const compressionSegments: Array<{ segmentId: string; blockId: string }> = [];
      for (const segmentId of frontier) {
        if (expanded.has(segmentId)) continue;
        expanded.add(segmentId);
        const segment = this.segmentCache.get(segmentId);
        if (!segment) throw new Error(`ContextSegment ${segmentId} cache was not primed.`);
        const segmentKind = requireSegmentKind(segment.segment_kind);
        const sources = this.scopedSources(segmentId, conversationId);
        const occurrences = sources.map(contextSourceOccurrence);
        if (segmentKind === 'tool_pair') classifyToolPairSources(occurrences);
        else validateScopedContextSegmentSources(segmentKind, occurrences);
        if (segmentKind === 'compression') {
          compressionSegments.push({ segmentId, blockId: occurrences[0].sourceId });
        }
      }
      if (compressionSegments.length === 0) break;
      const blockIds = compressionSegments.map((entry) => entry.blockId);
      await Promise.all([
        this.primeDomainRows('CompressionBlock', blockIds, this.compressionBlockCache),
        this.primeCompressionBlockSources(blockIds)
      ]);
      const next: string[] = [];
      for (const { segmentId, blockId } of compressionSegments) {
        const segment = this.segmentCache.get(segmentId);
        const block = this.compressionBlockCache.get(blockId);
        const blockSources = this.blockSourceCache.get(blockId);
        if (!segment) throw new Error(`ContextSegment ${segmentId} cache was not primed.`);
        if (!block) throw new Error(`CompressionBlock ${blockId} cache was not primed.`);
        if (!blockSources) throw new Error(`CompressionBlockSource cache was not primed for ${blockId}.`);
        if (requireId(segment.content_object_id, 'ContextSegment.content_object_id')
          !== requireId(block.summary_object_id, 'CompressionBlock.summary_object_id')) {
          throw new Error(`Compression segment ${segmentId} does not reference CompressionBlock ${blockId} summary content.`);
        }
        next.push(...blockSources.map((row) => requireId(row.segment_id, 'CompressionBlockSource.segment_id')));
      }
      frontier = [...new Set(next)].filter((segmentId) => !expanded.has(segmentId) && !known.has(segmentId));
    }
  }

  private async primeCompressionBlockSources(blockIds: readonly string[]): Promise<void> {
    const missing = [...new Set(blockIds)].filter((blockId) => !this.blockSourceCache.has(blockId));
    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const result = await this.database.snapshot(batch.map((blockId) =>
        DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
          where: { compression_block_id: blockId },
          limit: 257
        })
      ));
      for (const [index, blockId] of batch.entries()) {
        const rows = result.snapshot[index];
        if (!Array.isArray(rows)) throw new Error(`CompressionBlockSource snapshot for ${blockId} is invalid.`);
        const complete = rows.length < 257
          ? rows
          : await listAllDomainRows(this.database, 'CompressionBlockSource', { compression_block_id: blockId });
        const ordered = [...complete].sort(compareCompressionSource);
        ordered.forEach((row, position) => {
          if (requireSafeInteger(row.position, 'CompressionBlockSource.position') !== position) {
            throw new Error(`CompressionBlock ${blockId} source positions are not contiguous.`);
          }
        });
        if (ordered.length === 0) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
        this.blockSourceCache.set(blockId, ordered);
      }
    }
  }

  private async primeSegments(conversationId: string, segmentIds: readonly string[]): Promise<void> {
    const missing = [...new Set(segmentIds)].filter((segmentId) =>
      !this.segmentCache.has(segmentId) || !this.sourceCache.has(segmentId)
    );
    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const { snapshot } = await this.database.attachmentProjectionSegments(conversationId, batch);
      for (const segment of snapshot.segments) this.segmentCache.set(requireId(segment.id, 'ContextSegment.id'), segment);
      for (const segmentId of batch) this.sourceCache.set(segmentId, []);
      for (const source of snapshot.sources) {
        this.sourceCache.get(requireId(source.segment_id, 'ContextSegmentSource.segment_id'))!.push(source);
      }
      for (const revision of snapshot.messageRevisions) {
        this.messageRevisionCache.set(requireId(revision.id, 'MessageRevision.id'), revision);
        this.messageMembershipCache.set(requireId(revision.message_id, 'MessageRevision.message_id'), []);
      }
      for (const membership of snapshot.memberships) {
        this.messageMembershipCache.get(requireId(membership.message_id, 'MessagePartOfConversation.message_id'))!.push(membership);
      }
      for (const [records, cache] of [
        [snapshot.toolResults, this.toolResultCache], [snapshot.toolCalls, this.toolCallCache],
        [snapshot.turns, this.turnCache], [snapshot.compressionBlocks, this.compressionBlockCache]
      ] as const) for (const row of records) cache.set(requireId(row.id, 'row.id'), row);
    }
  }

  private async primeMessageRevisionOwners(revisionIds: readonly string[]): Promise<void> {
    await this.primeDomainRows('MessageRevision', revisionIds, this.messageRevisionCache);
    const messageIds = revisionIds.map((revisionId) => requireId(
      this.messageRevisionCache.get(revisionId)?.message_id,
      `MessageRevision ${revisionId}.message_id`
    ));
    const missing = [...new Set(messageIds)].filter((messageId) =>
      !this.messageMembershipCache.has(messageId)
    );
    for (let offset = 0; offset < missing.length; offset += 128) {
      const batch = missing.slice(offset, offset + 128);
      const result = await this.database.snapshot(batch.map((messageId) =>
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
          where: { message_id: messageId },
          limit: 2
        })
      ));
      batch.forEach((messageId, index) => {
        const memberships = result.snapshot[index];
        if (!Array.isArray(memberships)) {
          throw new Error(`MessagePartOfConversation snapshot for ${messageId} is invalid.`);
        }
        if (memberships.length > 1) {
          throw new Error(`Message ${messageId} belongs to multiple Conversations.`);
        }
        this.messageMembershipCache.set(messageId, memberships);
      });
    }
  }

  private scopedSources(segmentId: string, conversationId: string): DomainRow[] {
    const sources = this.sourceCache.get(segmentId);
    if (!sources) throw new Error(`ContextSegmentSource cache was not primed for ${segmentId}.`);
    return sources.filter((source) => this.sourceBelongsToConversation(source, conversationId));
  }

  private sourceBelongsToConversation(source: DomainRow, conversationId: string): boolean {
    const sourceId = requireId(source.source_id, 'ContextSegmentSource.source_id');
    const revision = this.messageRevisionCache.get(sourceId);
    const result = this.toolResultCache.get(sourceId);
    const call = this.toolCallCache.get(source.source_kind === 'tool_model_result' && result
      ? requireId(result.tool_call_id, `ToolModelResult ${sourceId}.tool_call_id`) : sourceId);
    return attachmentSourceBelongsToConversation(source, conversationId, {
      messageRevision: revision,
      memberships: revision ? this.messageMembershipCache.get(requireId(revision.message_id, `MessageRevision ${sourceId}.message_id`)) : undefined,
      toolResult: result,
      toolCall: call,
      turn: call ? this.turnCache.get(requireId(call.turn_id, `ToolCall ${call.id}.turn_id`)) : undefined,
      compressionBlock: this.compressionBlockCache.get(sourceId)
    });
  }

  private messageRevisionBelongsToConversation(revisionId: string, conversationId: string): boolean {
    const revision = this.messageRevisionCache.get(revisionId);
    if (!revision) throw new Error(`MessageRevision ${revisionId} cache was not primed.`);
    const messageId = requireId(revision.message_id, `MessageRevision ${revisionId}.message_id`);
    const memberships = this.messageMembershipCache.get(messageId);
    if (!memberships) throw new Error(`MessagePartOfConversation cache was not primed for ${messageId}.`);
    return memberships.length === 1 && memberships[0].conversation_id === conversationId;
  }

  private async primeRevisionLinks(revisionIds: readonly string[]): Promise<void> {
    const missing = [...new Set(revisionIds)].filter((revisionId) => !this.revisionLinkCache.has(revisionId));
    for (let offset = 0; offset < missing.length; offset += 128) {
      const batch = missing.slice(offset, offset + 128);
      const { snapshot } = await this.database.attachmentProjectionLinks(batch);
      for (const revisionId of batch) this.revisionLinkCache.set(revisionId, []);
      for (const link of snapshot.links) {
        this.revisionLinkCache.get(requireId(link.message_revision_id, 'AttachmentLink.message_revision_id'))!.push(link);
      }
      for (const revisionId of batch) this.revisionLinkCache.get(revisionId)!.sort(compareAttachmentLink);
      for (const attachment of snapshot.attachments) this.attachmentCache.set(requireId(attachment.id, 'Attachment.id'), attachment);
    }
  }

  private async primeDomainRows(
    domain: string,
    ids: readonly string[],
    cache: Map<string, DomainRow>,
    required = true
  ): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    for (let offset = 0; offset < missing.length; offset += 128) {
      const batch = missing.slice(offset, offset + 128);
      const result = await this.database.snapshot(batch.map((id) =>
        DOMAIN_REPOSITORIES.domain(domain).get(id)
      ));
      batch.forEach((id, index) => {
        const row = result.snapshot[index];
        if (!row || Array.isArray(row)) {
          if (required) throw new Error(`${domain} ${id} does not exist.`);
          return;
        }
        cache.set(id, row);
      });
    }
  }

  private async cachedDomain(
    domain: string,
    id: string,
    cache: Map<string, DomainRow>
  ): Promise<DomainRow> {
    const cached = cache.get(id);
    if (cached) return cached;
    const row = await this.requireDomain(domain, id);
    cache.set(id, row);
    return row;
  }

  private primeAttachments(attachmentIds: readonly string[]): Promise<void> {
    return this.primeDomainRows('Attachment', attachmentIds, this.attachmentCache);
  }

  private async segment(segmentId: string): Promise<DomainRow> {
    const cached = this.segmentCache.get(segmentId);
    if (cached) return cached;
    const row = await this.requireDomain('ContextSegment', segmentId);
    this.segmentCache.set(segmentId, row);
    return row;
  }

  private compressionBlockSources(blockId: string): DomainRow[] {
    const cached = this.blockSourceCache.get(blockId);
    if (!cached) throw new Error(`CompressionBlockSource cache was not primed for ${blockId}.`);
    return cached;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function contextSourceOccurrence(row: DomainRow): ContextSourceOccurrence {
  return {
    sourceKind: requireText(row.source_kind, 'ContextSegmentSource.source_kind') as ContextSourceOccurrence['sourceKind'],
    sourceId: requireId(row.source_id, 'ContextSegmentSource.source_id'),
    sourceRevision: requireBigInt(row.source_revision, 'ContextSegmentSource.source_revision')
  };
}

function requireSegmentKind(value: unknown): ContextSegmentKind {
  if (!['system', 'message', 'tool_pair', 'compression', 'runtime_context'].includes(String(value))) {
    throw new TypeError(`Unsupported Context segment kind: ${String(value)}`);
  }
  return value as ContextSegmentKind;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  }
  return value;
}

function compareAttachmentLink(left: DomainRow, right: DomainRow): number {
  return compareIntegerThenId(left.position, right.position, left.id, right.id, 'AttachmentLink.position');
}

function compareCompressionSource(left: DomainRow, right: DomainRow): number {
  return compareIntegerThenId(left.position, right.position, left.id, right.id, 'CompressionBlockSource.position');
}

function compareIntegerThenId(
  leftValue: unknown,
  rightValue: unknown,
  leftId: unknown,
  rightId: unknown,
  label: string
): number {
  const left = requireSafeInteger(leftValue, label);
  const right = requireSafeInteger(rightValue, label);
  return left !== right
    ? left - right
    : requireId(leftId, 'row.id').localeCompare(requireId(rightId, 'row.id'));
}

function requireSafeInteger(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return number;
}

function requireId(value: unknown, label: string): string {
  return requireText(value, label);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

import type { AttachmentCatalogEntry } from '../../shared/protocol';
import { mergeAttachmentCatalog } from './attachmentCatalog';
import {
  type ContextSegmentKind,
  type ContextSourceOccurrence,
  validateContextSegmentSources
} from './contextSequence';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AttachmentCatalogProjectionSegment {
  segmentId: string;
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
  private readonly toolCallCache = new Map<string, DomainRow>();
  private readonly toolResultCache = new Map<string, DomainRow>();
  private readonly attachmentCache = new Map<string, DomainRow>();

  public constructor(private readonly database: RuntimeDatabase) {}

  public project(
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<AttachmentCatalogEntry[]> {
    // One worker per projection keeps caches bounded and prevents concurrent freezes from clearing or
    // mixing each other's lineage state. Late append-only AttachmentLink rows remain visible too.
    return new AttachmentCatalogProjection(this.database).projectIsolated(
      segments,
      additionalMessageRevisionIds
    );
  }

  private async projectIsolated(
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[]
  ): Promise<AttachmentCatalogEntry[]> {
    const segmentIds = segments.map((segment) => requireId(segment.segmentId, 'segmentId'));
    await this.primeSegments(segmentIds);
    await this.primeCompressionLineage(segmentIds);
    const revisions: string[] = [];
    for (const segmentId of segmentIds) {
      await this.collectSegmentRevisions(segmentId, revisions, new Set<string>());
    }
    for (const revisionId of additionalMessageRevisionIds) {
      revisions.push(requireId(revisionId, 'messageRevisionId'));
    }

    const uniqueRevisions = [...new Set(revisions)];
    await this.primeDomainRows('MessageRevision', uniqueRevisions, this.messageRevisionCache);
    for (const [segmentId, sources] of this.sourceCache) {
      for (const source of sources) {
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
    return mergeAttachmentCatalog(...await Promise.all(
      uniqueRevisions.map((revisionId) => this.catalogForRevision(revisionId))
    ));
  }

  private async collectSegmentRevisions(
    segmentId: string,
    revisions: string[],
    path: Set<string>
  ): Promise<void> {
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    const segment = await this.segment(segmentId);
    const segmentKind = requireSegmentKind(segment.segment_kind);
    const sources = this.sourceCache.get(segmentId);
    if (!sources) throw new Error(`ContextSegmentSource cache was not primed for ${segmentId}.`);
    const occurrences = sources.map(contextSourceOccurrence);
    validateContextSegmentSources(segmentKind, occurrences);

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
      const nextPath = new Set(path);
      nextPath.add(segmentId);
      const childSegmentIds = blockSources.map((source) =>
        requireId(source.segment_id, 'CompressionBlockSource.segment_id')
      );
      await this.primeSegments(childSegmentIds);
      for (const childSegmentId of childSegmentIds) {
        await this.collectSegmentRevisions(childSegmentId, revisions, nextPath);
      }
      return;
    }

    if (segmentKind === 'message') {
      revisions.push(occurrences[0].sourceId);
      return;
    }
    if (segmentKind === 'tool_pair') {
      const callSource = occurrences[0];
      const resultSource = occurrences[1];
      const call = await this.cachedDomain('ToolCall', callSource.sourceId, this.toolCallCache);
      if (requireBigInt(call.call_seq, 'ToolCall.call_seq') !== callSource.sourceRevision) {
        throw new Error(`ToolCall ${callSource.sourceId} source_revision does not match call_seq.`);
      }
      const result = await this.cachedDomain('ToolModelResult', resultSource.sourceId, this.toolResultCache);
      if (requireId(result.tool_call_id, 'ToolModelResult.tool_call_id') !== callSource.sourceId) {
        throw new Error(`ToolModelResult ${resultSource.sourceId} does not belong to ToolCall ${callSource.sourceId}.`);
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

  private async primeCompressionLineage(rootSegmentIds: readonly string[]): Promise<void> {
    const expanded = new Set<string>();
    let frontier = [...new Set(rootSegmentIds)];
    while (frontier.length > 0) {
      await this.primeSegments(frontier);
      const compressionSegments: Array<{ segmentId: string; blockId: string }> = [];
      for (const segmentId of frontier) {
        if (expanded.has(segmentId)) continue;
        expanded.add(segmentId);
        const segment = this.segmentCache.get(segmentId);
        if (!segment) throw new Error(`ContextSegment ${segmentId} cache was not primed.`);
        const segmentKind = requireSegmentKind(segment.segment_kind);
        const sources = this.sourceCache.get(segmentId);
        if (!sources) throw new Error(`ContextSegmentSource cache was not primed for ${segmentId}.`);
        const occurrences = sources.map(contextSourceOccurrence);
        validateContextSegmentSources(segmentKind, occurrences);
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
      frontier = [...new Set(next)].filter((segmentId) => !expanded.has(segmentId));
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

  private async primeSegments(segmentIds: readonly string[]): Promise<void> {
    const missing = [...new Set(segmentIds)].filter((segmentId) =>
      !this.segmentCache.has(segmentId) || !this.sourceCache.has(segmentId)
    );
    const primedSources: DomainRow[] = [];
    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const result = await this.database.snapshot([
        ...batch.map((segmentId) => DOMAIN_REPOSITORIES.domain('ContextSegment').get(segmentId)),
        ...batch.map((segmentId) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
          where: { segment_id: segmentId },
          limit: 3
        }))
      ]);
      batch.forEach((segmentId, index) => {
        const segment = result.snapshot[index];
        if (segment && !Array.isArray(segment)) this.segmentCache.set(segmentId, segment);
        const sources = result.snapshot[batch.length + index];
        if (!Array.isArray(sources)) throw new Error(`ContextSegmentSource snapshot for ${segmentId} is invalid.`);
        const sorted = [...sources].sort(compareSegmentSource);
        this.sourceCache.set(segmentId, sorted);
        primedSources.push(...sorted);
      });
    }
    await this.primeDomainRows(
      'ToolCall',
      primedSources.filter((source) => source.source_kind === 'tool_call')
        .map((source) => requireId(source.source_id, 'ContextSegmentSource.source_id')),
      this.toolCallCache
    );
    await this.primeDomainRows(
      'ToolModelResult',
      primedSources.filter((source) => source.source_kind === 'tool_model_result')
        .map((source) => requireId(source.source_id, 'ContextSegmentSource.source_id')),
      this.toolResultCache
    );
  }

  private async primeRevisionLinks(revisionIds: readonly string[]): Promise<void> {
    const missing = [...new Set(revisionIds)].filter((revisionId) => !this.revisionLinkCache.has(revisionId));
    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const result = await this.database.snapshot(batch.map((revisionId) =>
        DOMAIN_REPOSITORIES.domain('AttachmentLink').list({
          where: { message_revision_id: revisionId },
          limit: 257
        })
      ));
      for (const [index, revisionId] of batch.entries()) {
        const rows = result.snapshot[index];
        if (!Array.isArray(rows)) throw new Error(`AttachmentLink snapshot for ${revisionId} is invalid.`);
        const complete = rows.length < 257
          ? rows
          : await listAllDomainRows(this.database, 'AttachmentLink', { message_revision_id: revisionId });
        this.revisionLinkCache.set(revisionId, [...complete].sort(compareAttachmentLink));
      }
    }
  }

  private async primeDomainRows(
    domain: string,
    ids: readonly string[],
    cache: Map<string, DomainRow>
  ): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !cache.has(id));
    for (let offset = 0; offset < missing.length; offset += 128) {
      const batch = missing.slice(offset, offset + 128);
      const result = await this.database.snapshot(batch.map((id) =>
        DOMAIN_REPOSITORIES.domain(domain).get(id)
      ));
      batch.forEach((id, index) => {
        const row = result.snapshot[index];
        if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
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

function compareSegmentSource(left: DomainRow, right: DomainRow): number {
  const leftRevision = requireBigInt(left.source_revision, 'ContextSegmentSource.source_revision');
  const rightRevision = requireBigInt(right.source_revision, 'ContextSegmentSource.source_revision');
  if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
  const kind = requireText(left.source_kind, 'ContextSegmentSource.source_kind')
    .localeCompare(requireText(right.source_kind, 'ContextSegmentSource.source_kind'));
  if (kind !== 0) return kind;
  return requireId(left.id, 'ContextSegmentSource.id').localeCompare(requireId(right.id, 'ContextSegmentSource.id'));
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

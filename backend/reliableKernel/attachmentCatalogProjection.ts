import type { AttachmentCatalogEntry } from '../../shared/protocol';
import { mergeAttachmentCatalog } from './attachmentCatalog';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AttachmentCatalogProjectionSegment {
  segmentId: string;
  segmentKind: string;
}

/**
 * Rebuilds the model-only attachment directory from immutable Context lineage and AttachmentLink
 * relations. It never reads attachment bodies or trusts convenience metadata embedded in CAS JSON.
 */
export class AttachmentCatalogProjection {
  private readonly segmentCache = new Map<string, DomainRow>();
  private readonly sourceCache = new Map<string, DomainRow[]>();
  private readonly blockSourceCache = new Map<string, DomainRow[]>();
  private readonly revisionLinkCache = new Map<string, DomainRow[]>();
  private readonly attachmentCache = new Map<string, DomainRow>();

  public constructor(private readonly database: RuntimeDatabase) {}

  public async project(
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<AttachmentCatalogEntry[]> {
    const revisions: string[] = [];
    for (const segment of segments) {
      await this.collectSegmentRevisions(
        requireId(segment.segmentId, 'segmentId'),
        requireText(segment.segmentKind, 'segmentKind'),
        revisions,
        new Set<string>()
      );
    }
    for (const revisionId of additionalMessageRevisionIds) {
      revisions.push(requireId(revisionId, 'messageRevisionId'));
    }

    const catalogs: AttachmentCatalogEntry[][] = [];
    for (const revisionId of revisions) catalogs.push(await this.catalogForRevision(revisionId));
    return mergeAttachmentCatalog(...catalogs);
  }

  private async collectSegmentRevisions(
    segmentId: string,
    segmentKind: string,
    revisions: string[],
    path: Set<string>
  ): Promise<void> {
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    const sources = await this.segmentSources(segmentId);
    if (sources.length === 0) throw new Error(`ContextSegment ${segmentId} has no registered source lineage.`);

    if (segmentKind === 'compression') {
      const compressionSources = sources.filter((source) => source.source_kind === 'compression_block');
      if (compressionSources.length !== 1) {
        throw new Error(`Compression segment ${segmentId} must have exactly one CompressionBlock source.`);
      }
      const blockId = requireId(compressionSources[0].source_id, 'ContextSegmentSource.source_id');
      await this.requireDomain('CompressionBlock', blockId);
      const blockSources = await this.compressionBlockSources(blockId);
      if (blockSources.length === 0) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
      const nextPath = new Set(path);
      nextPath.add(segmentId);
      for (const source of blockSources) {
        const childId = requireId(source.segment_id, 'CompressionBlockSource.segment_id');
        const child = await this.segment(childId);
        await this.collectSegmentRevisions(
          childId,
          requireText(child.segment_kind, 'ContextSegment.segment_kind'),
          revisions,
          nextPath
        );
      }
      return;
    }

    for (const source of sources) {
      const sourceKind = requireText(source.source_kind, 'ContextSegmentSource.source_kind');
      const sourceId = requireId(source.source_id, 'ContextSegmentSource.source_id');
      if (sourceKind === 'message_revision') {
        await this.requireDomain('MessageRevision', sourceId);
        revisions.push(sourceId);
      } else if (sourceKind === 'tool_model_result') {
        const result = await this.requireDomain('ToolModelResult', sourceId);
        revisions.push(requireId(result.message_revision_id, 'ToolModelResult.message_revision_id'));
      }
    }
  }

  private async catalogForRevision(revisionId: string): Promise<AttachmentCatalogEntry[]> {
    let links = this.revisionLinkCache.get(revisionId);
    if (!links) {
      links = await listAllDomainRows(this.database, 'AttachmentLink', { message_revision_id: revisionId });
      links = [...links].sort(compareAttachmentLink);
      this.revisionLinkCache.set(revisionId, links);
    }
    const entries: AttachmentCatalogEntry[] = [];
    for (const link of links) {
      const attachmentId = requireId(link.attachment_id, 'AttachmentLink.attachment_id');
      const attachment = await this.attachment(attachmentId);
      entries.push({
        attachmentId,
        name: requireText(attachment.name, 'Attachment.name'),
        mimeType: requireText(attachment.mime_type, 'Attachment.mime_type'),
        sizeBytes: requireSafeInteger(attachment.byte_length, 'Attachment.byte_length')
      });
    }
    return entries;
  }

  private async segment(segmentId: string): Promise<DomainRow> {
    const cached = this.segmentCache.get(segmentId);
    if (cached) return cached;
    const row = await this.requireDomain('ContextSegment', segmentId);
    this.segmentCache.set(segmentId, row);
    return row;
  }

  private async segmentSources(segmentId: string): Promise<DomainRow[]> {
    const cached = this.sourceCache.get(segmentId);
    if (cached) return cached;
    const rows = await listAllDomainRows(this.database, 'ContextSegmentSource', { segment_id: segmentId });
    const sorted = [...rows].sort(compareSegmentSource);
    this.sourceCache.set(segmentId, sorted);
    return sorted;
  }

  private async compressionBlockSources(blockId: string): Promise<DomainRow[]> {
    const cached = this.blockSourceCache.get(blockId);
    if (cached) return cached;
    const rows = [...await listAllDomainRows(this.database, 'CompressionBlockSource', {
      compression_block_id: blockId
    })].sort(compareCompressionSource);
    rows.forEach((row, index) => {
      if (requireSafeInteger(row.position, 'CompressionBlockSource.position') !== index) {
        throw new Error(`CompressionBlock ${blockId} source positions are not contiguous.`);
      }
    });
    this.blockSourceCache.set(blockId, rows);
    return rows;
  }

  private async attachment(attachmentId: string): Promise<DomainRow> {
    const cached = this.attachmentCache.get(attachmentId);
    if (cached) return cached;
    const row = await this.requireDomain('Attachment', attachmentId);
    this.attachmentCache.set(attachmentId, row);
    return row;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function compareAttachmentLink(left: DomainRow, right: DomainRow): number {
  return compareIntegerThenId(left.position, right.position, left.id, right.id, 'AttachmentLink.position');
}

function compareCompressionSource(left: DomainRow, right: DomainRow): number {
  return compareIntegerThenId(left.position, right.position, left.id, right.id, 'CompressionBlockSource.position');
}

function compareSegmentSource(left: DomainRow, right: DomainRow): number {
  const leftRevision = requireSafeInteger(left.source_revision, 'ContextSegmentSource.source_revision');
  const rightRevision = requireSafeInteger(right.source_revision, 'ContextSegmentSource.source_revision');
  if (leftRevision !== rightRevision) return leftRevision - rightRevision;
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

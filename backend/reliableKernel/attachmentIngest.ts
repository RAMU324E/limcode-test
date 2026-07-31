import { createHash } from 'node:crypto';
import type { AttachmentSettingsRecord } from '../../shared/protocol';
import {
  ContentAddressedStore,
  type ContentObjectMetadata
} from './contentAddressedStore';
import { preparedContentSteps, stablePhaseDId } from './effectControlPlane';
import { DOMAIN_REPOSITORIES, savepoint, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AttachmentSettingsAuthority {
  loadGlobalSettings(section: 'attachments'): Promise<{
    section: string;
    settings: unknown;
    filePath: string;
  }>;
}

export interface AttachmentIngestResult {
  attachmentId: string;
  attachmentLinkId: string;
  contentObjectId: string;
  byteLength: string;
  position: string;
  deduplicated: boolean;
  commitSeq?: string;
}

/** Reads the existing settings authority; attachment bytes never enter Runtime SQLite. */
export class AttachmentIngestService {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly settingsAuthority: AttachmentSettingsAuthority,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async ingest(input: {
    messageRevisionId: string;
    position: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AttachmentIngestResult> {
    const messageRevisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const position = requireDecimalString(input.position, 'AttachmentLink.position');
    const name = requireText(input.name, 'attachment name');
    const mimeType = requireText(input.mimeType, 'attachment mimeType');
    const bytes = Buffer.from(input.bytes);
    const settings = await this.loadSettings();
    const maxBytes = BigInt(settings.maxStoredInlineFileMb) * 1024n * 1024n;
    if (BigInt(bytes.byteLength) > maxBytes) {
      throw new AttachmentSizeLimitError(
        `Attachment is ${bytes.byteLength} bytes; settings allow at most ${maxBytes.toString()} bytes.`
      );
    }
    await this.requireExisting('MessageRevision', messageRevisionId);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const attachmentId = stablePhaseDId('attachment', JSON.stringify([sha256, mimeType, name]));
    const attachmentLinkId = stablePhaseDId(
      'attachment_link',
      JSON.stringify([messageRevisionId, attachmentId, position])
    );
    const existingLink = await this.maybeGet('AttachmentLink', attachmentLinkId);
    if (existingLink) return this.replay(existingLink, attachmentId, position);

    // prepare() atomically publishes CAS bytes before it returns any SQLite mutation.
    const prepared = await this.contentStore.prepare(this.database, bytes, mimeType);
    const now = this.timestamp();
    try {
      const committed = await this.database.transaction([
        ...preparedContentSteps([prepared], 'attachment_content'),
        savepoint('attachment_identity', [
          DOMAIN_REPOSITORIES.domain('Attachment').insert({
            id: attachmentId,
            sha256,
            byte_length: String(bytes.byteLength),
            mime_type: mimeType,
            name,
            storage_mode: 'cas',
            content_object_id: prepared.metadata.id,
            created_at: now
          })
        ], {
          kind: 'rollback-and-continue-on-unique',
          constraints: [{ domain: 'Attachment', columns: ['id'] }]
        }),
        DOMAIN_REPOSITORIES.domain('Attachment').assert(attachmentId, {
          sha256,
          byte_length: String(bytes.byteLength),
          mime_type: mimeType,
          name,
          storage_mode: 'cas',
          content_object_id: prepared.metadata.id
        }),
        DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
          id: attachmentLinkId,
          message_revision_id: messageRevisionId,
          attachment_id: attachmentId,
          position,
          created_at: now
        })
      ]);
      return {
        attachmentId,
        attachmentLinkId,
        contentObjectId: prepared.metadata.id,
        byteLength: String(bytes.byteLength),
        position,
        deduplicated: false,
        commitSeq: committed.commitSeq
      };
    } catch (error) {
      if (!matchesAttachmentLinkUnique(error)) throw error;
      const raced = await this.maybeGet('AttachmentLink', attachmentLinkId);
      if (!raced) throw error;
      return this.replay(raced, attachmentId, position);
    }
  }

  public async read(attachmentIdInput: string): Promise<Buffer> {
    const attachmentId = requireId(attachmentIdInput, 'attachmentId');
    const attachment = await this.requireExisting('Attachment', attachmentId);
    if (attachment.storage_mode !== 'cas') throw new Error(`Attachment ${attachmentId} is not CAS-backed.`);
    const contentObjectId = requireId(attachment.content_object_id, 'Attachment.content_object_id');
    const metadata = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    const bytes = await this.contentStore.read(metadata);
    if (
      createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      || BigInt(bytes.byteLength) !== requireBigInt(attachment.byte_length, 'Attachment.byte_length')
    ) throw new Error(`Attachment ${attachmentId} CAS content does not match its immutable metadata.`);
    return bytes;
  }

  private async loadSettings(): Promise<AttachmentSettingsRecord> {
    const loaded = await this.settingsAuthority.loadGlobalSettings('attachments');
    const settings = loaded.settings as Partial<AttachmentSettingsRecord> | undefined;
    const value = Number(settings?.maxStoredInlineFileMb);
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
      throw new Error('Attachment settings authority returned invalid maxStoredInlineFileMb.');
    }
    return { maxStoredInlineFileMb: value };
  }

  private async replay(link: DomainRow, attachmentId: string, position: string): Promise<AttachmentIngestResult> {
    if (link.attachment_id !== attachmentId || requireBigInt(link.position, 'AttachmentLink.position').toString() !== position) {
      throw new Error('AttachmentLink stable identity conflicts with requested attachment.');
    }
    const attachment = await this.requireExisting('Attachment', attachmentId);
    return {
      attachmentId,
      attachmentLinkId: link.id as string,
      contentObjectId: requireId(attachment.content_object_id, 'Attachment.content_object_id'),
      byteLength: requireBigInt(attachment.byte_length, 'Attachment.byte_length').toString(),
      position,
      deduplicated: true
    };
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new TypeError(`${domain} get returned a list.`);
    return row;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

export class AttachmentSizeLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AttachmentSizeLimitError';
  }
}

function matchesAttachmentLinkUnique(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message.slice(index + marker.length).split(',').map((entry) => entry.trim()).filter(Boolean).sort();
  const expected = [
    ['attachment_link.id'],
    ['attachment_link.message_revision_id', 'attachment_link.attachment_id', 'attachment_link.position']
  ];
  return expected.some((columns) => {
    const wanted = [...columns].sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

import type {
  AttachmentCatalogEntry,
  MessageContent
} from '../../shared/protocol';

export const ATTACHMENT_CATALOG_HEADER = [
  '[LimCode 托管附件目录：仅包含不可变元数据，不包含附件正文。]',
  '仅在确实需要查看历史附件时调用 read，参数为 {"attachmentId":"目录中的精确编号"}。',
  'attachmentId 只能使用下方目录里的真实编号；不要留空、不要编造，也不要把文件名或 MIME 类型当作编号。'
].join('\n');

export const ATTACHMENT_PAGE_RANGE_GUIDANCE = [
  'TXT 或 PDF 可选 pages 范围，例如 {"attachmentId":"目录中的精确编号","pages":"1-4"}。',
  'pages 省略时默认第 1 页，每次最多连续读取 4 页；如需继续，复制 read 结果中的 nextPages。图片不要填写 pages。'
].join('\n');

export interface AttachmentCatalogStoredItem {
  content: string;
  contentType?: string;
}

/**
 * Collects immutable managed attachment references from durable JSON envelopes. Attachment bytes,
 * hashes and local paths are deliberately excluded from the resulting directory.
 */
export function collectAttachmentCatalog(value: unknown): AttachmentCatalogEntry[] {
  const entries: AttachmentCatalogEntry[] = [];
  collect(value, entries, new Set<object>());
  return mergeAttachmentCatalog(entries);
}

export function collectAttachmentCatalogFromStoredItems(
  items: readonly AttachmentCatalogStoredItem[]
): AttachmentCatalogEntry[] {
  return mergeAttachmentCatalog(...items.map((item) => {
    if (!isJsonContentType(item.contentType)) return [];
    try {
      return collectAttachmentCatalog(JSON.parse(item.content) as unknown);
    } catch {
      return [];
    }
  }));
}

/** Merges catalogs in first-model-visible-appearance order and rejects immutable metadata drift. */
export function mergeAttachmentCatalog(
  ...catalogs: ReadonlyArray<readonly AttachmentCatalogEntry[]>
): AttachmentCatalogEntry[] {
  const merged: AttachmentCatalogEntry[] = [];
  const byId = new Map<string, AttachmentCatalogEntry>();
  for (const catalog of catalogs) {
    for (const candidate of catalog) {
      const entry = normalizeEntry(candidate, 'attachmentCatalog entry');
      const existing = byId.get(entry.attachmentId);
      if (existing) {
        if (existing.name !== entry.name
          || existing.mimeType !== entry.mimeType
          || existing.sizeBytes !== entry.sizeBytes) {
          throw new Error(`Attachment catalog metadata changed for immutable attachment ${entry.attachmentId}.`);
        }
        continue;
      }
      byId.set(entry.attachmentId, entry);
      merged.push(entry);
    }
  }
  return merged;
}

export function normalizeAttachmentCatalog(
  value: unknown,
  label = 'attachmentCatalog'
): AttachmentCatalogEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
  return mergeAttachmentCatalog(value.map((entry, index) => normalizeEntry(entry, `${label}[${index}]`)));
}

export function renderAttachmentCatalog(catalog: readonly AttachmentCatalogEntry[]): MessageContent | undefined {
  const normalized = mergeAttachmentCatalog(catalog);
  if (normalized.length === 0) return undefined;
  const rows = normalized.map((entry) => JSON.stringify({
    attachmentId: entry.attachmentId,
    name: entry.name,
    mimeType: entry.mimeType,
    sizeBytes: entry.sizeBytes
  }));
  const includesPagedAttachment = normalized.some((entry) =>
    entry.mimeType === 'text/plain' || entry.mimeType === 'application/pdf');
  return {
    role: 'user',
    parts: [{
      text: [
        ATTACHMENT_CATALOG_HEADER,
        ...(includesPagedAttachment ? [ATTACHMENT_PAGE_RANGE_GUIDANCE] : []),
        ...rows
      ].join('\n')
    }]
  };
}

function collect(value: unknown, entries: AttachmentCatalogEntry[], seen: Set<object>): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const entry of value) collect(entry, entries, seen);
    return;
  }
  const record = asRecord(value);
  if (!record || seen.has(record)) return;
  seen.add(record);

  const inlineData = asRecord(record.inlineData);
  if (inlineData) {
    const entry = optionalInlineDataEntry(inlineData);
    if (entry) entries.push(entry);
  }
  if (record.kind === 'compression_contents' && record.attachmentCatalog !== undefined) {
    entries.push(...normalizeAttachmentCatalog(record.attachmentCatalog));
  }
  for (const [key, child] of Object.entries(record)) {
    // Base64 bodies and provider-native ciphertext can be enormous and can never contain directory
    // structure. Skipping them also guarantees catalog collection is independent of payload size.
    if (key === 'data' || key === 'encryptedContent' || key === 'attachmentCatalog') continue;
    if (key === 'result' && typeof child === 'string') {
      collectNestedJson(child, entries, seen);
      continue;
    }
    collect(child, entries, seen);
  }
}

function collectNestedJson(value: string, entries: AttachmentCatalogEntry[], seen: Set<object>): void {
  const trimmed = value.trim();
  if ((!trimmed.startsWith('{') && !trimmed.startsWith('[')) || trimmed.length > 16 * 1024 * 1024) return;
  try {
    collect(JSON.parse(trimmed) as unknown, entries, seen);
  } catch {
    // Tool result text may start with JSON punctuation without being a JSON envelope.
  }
}

function optionalInlineDataEntry(value: Record<string, unknown>): AttachmentCatalogEntry | undefined {
  const attachmentId = optionalText(value.attachmentId);
  const name = optionalText(value.name);
  const mimeType = optionalText(value.mimeType);
  const sizeBytes = nonNegativeInteger(value.sizeBytes);
  if (!attachmentId || !name || !mimeType || sizeBytes === undefined) return undefined;
  return { attachmentId, name, mimeType, sizeBytes };
}

function normalizeEntry(value: unknown, label: string): AttachmentCatalogEntry {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  const attachmentId = requireText(record.attachmentId, `${label}.attachmentId`);
  const name = requireText(record.name, `${label}.name`);
  const mimeType = requireText(record.mimeType, `${label}.mimeType`);
  const sizeBytes = nonNegativeInteger(record.sizeBytes);
  if (sizeBytes === undefined) throw new TypeError(`${label}.sizeBytes must be a non-negative safe integer.`);
  return { attachmentId, name, mimeType, sizeBytes };
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${label} must be non-empty text.`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

import { normalizeHistoryImageSettings, type HistoryImageSettings } from '../../shared/historyImages';
import { isInlineDataPart, type ContentPart, type InlineDataPart } from '../../shared/protocol';

// Immutable attachment IDs already identify the source. Cache only derived model inputs, never rewrite attachments.
const resizedImages = new Map<string, InlineDataPart>();
const CACHE_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

export interface HistoryImagePreparation {
  settings: HistoryImageSettings;
  currentAttachmentIds: ReadonlySet<string>;
  bytes: number;
}

export function createHistoryImagePreparation(
  settings?: HistoryImageSettings,
  currentAttachmentIds: readonly string[] = []
): HistoryImagePreparation {
  return { settings: normalizeHistoryImageSettings(settings), currentAttachmentIds: new Set(currentAttachmentIds), bytes: 0 };
}

export async function prepareHistoryImage(
  source: InlineDataPart,
  resolve: () => Promise<ContentPart>,
  preparation: HistoryImagePreparation
): Promise<ContentPart> {
  if (!source.inlineData.mimeType.startsWith('image/')) return resolve();
  const { maxDimension, maxMB } = preparation.settings;
  const id = source.inlineData.attachmentId;
  const resize = maxDimension > 0 && !(id && preparation.currentAttachmentIds.has(id));
  const key = resize && id ? `${id}:${maxDimension}` : undefined;
  let result: ContentPart | undefined = key ? resizedImages.get(key) : undefined;
  if (!result) {
    result = await resolve();
    if (resize && isInlineDataPart(result) && result.inlineData.data
      && ['image/png', 'image/jpeg', 'image/webp'].includes(result.inlineData.mimeType)) {
      result = await resizeImage(result, maxDimension);
      if (key && isInlineDataPart(result)) remember(key, result);
    }
  }
  if (isInlineDataPart(result)) {
    // Base64 is ASCII: length is its exact wire byte count. No request serialization or hashing.
    preparation.bytes += result.inlineData.data?.length ?? 0;
    if (maxMB > 0 && preparation.bytes > maxMB * 1_000_000) {
      throw Object.assign(new Error(
        `本次发送的图片超过 ${maxMB} MB 上限。请降低“历史图片长边”、提高“图片发送上限”，或压缩历史后重发。原始图片仍保留。`
      ), { code: 'image_budget_exceeded' });
    }
  }
  return result;
}

async function resizeImage(part: InlineDataPart, maxDimension: number): Promise<InlineDataPart> {
  const { default: sharp } = await import('sharp');
  const source = Buffer.from(part.inlineData.data!, 'base64');
  const image = sharp(source);
  const metadata = await image.metadata();
  // Animated images retain all frames. They still count toward the sending budget.
  if ((metadata.pages ?? 1) > 1 || Math.max(metadata.width ?? 0, metadata.height ?? 0) <= maxDimension) return part;
  const resized = image.rotate().resize({
    width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true
  });
  if (part.inlineData.mimeType === 'image/png') resized.png({ compressionLevel: 9, adaptiveFiltering: true });
  const bytes = await resized.toBuffer();
  if (bytes.length >= source.length) return part;
  return { inlineData: {
    mimeType: part.inlineData.mimeType, data: bytes.toString('base64'),
    ...(part.inlineData.name ? { name: part.inlineData.name } : {}),
    sizeBytes: bytes.length, storage: 'embedded', status: 'available'
  } };
}

function remember(key: string, part: InlineDataPart): void {
  const bytes = part.inlineData.data?.length ?? 0;
  if (bytes > CACHE_BYTES) return;
  const existing = resizedImages.get(key);
  if (existing) cachedBytes -= existing.inlineData.data?.length ?? 0;
  resizedImages.delete(key);
  while (cachedBytes + bytes > CACHE_BYTES && resizedImages.size) {
    const oldest = resizedImages.keys().next().value!;
    cachedBytes -= resizedImages.get(oldest)!.inlineData.data?.length ?? 0;
    resizedImages.delete(oldest);
  }
  resizedImages.set(key, part);
  cachedBytes += bytes;
}

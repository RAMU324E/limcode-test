import { normalizeHistoryImageSettings, type HistoryImageSettings } from '../../shared/historyImages';
import { isInlineDataPart, type ContentPart, type InlineDataPart } from '../../shared/protocol';

// Immutable attachment IDs already identify the source. Cache only derived model inputs, never rewrite attachments.
const resizedImages = new Map<string, InlineDataPart>();
const preparingImages = new Map<string, Promise<ContentPart>>();
const CACHE_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

export interface HistoryImagePreparation {
  settings: HistoryImageSettings;
  currentAttachmentIds: ReadonlySet<string>;
  currentImages: WeakSet<InlineDataPart>;
  bytes: number;
}

export function createHistoryImagePreparation(
  settings?: HistoryImageSettings,
  currentAttachmentIds: readonly string[] = []
): HistoryImagePreparation {
  return { settings: normalizeHistoryImageSettings(settings), currentAttachmentIds: new Set(currentAttachmentIds),
    currentImages: new WeakSet(), bytes: 0 };
}

export async function prepareHistoryImage(
  source: InlineDataPart,
  resolve: () => Promise<ContentPart>,
  preparation: HistoryImagePreparation
): Promise<ContentPart> {
  if (!source.inlineData.mimeType.startsWith('image/')) return resolve();
  const { resizeEnabled, limitEnabled, maxDimension, maxMB } = preparation.settings;
  const id = source.inlineData.attachmentId;
  const current = !!id && preparation.currentAttachmentIds.has(id);
  const resize = resizeEnabled && maxDimension > 0 && !current;
  const key = resize && id ? `${id}:${maxDimension}` : undefined;
  let result: ContentPart | undefined = key ? resizedImages.get(key) : undefined;
  if (!result) {
    let pending = key ? preparingImages.get(key) : undefined;
    if (!pending) {
      pending = (async () => {
        let prepared = await resolve();
        if (resize && isInlineDataPart(prepared) && prepared.inlineData.data
          && ['image/png', 'image/jpeg', 'image/webp'].includes(prepared.inlineData.mimeType)) {
          prepared = await resizeImage(prepared, maxDimension);
          if (key && isInlineDataPart(prepared)) remember(key, prepared);
        }
        return prepared;
      })();
      if (key) {
        const imageKey = key;
        pending = pending.finally(() => preparingImages.delete(imageKey));
        preparingImages.set(key, pending);
      }
    }
    result = await pending;
  }
  if (limitEnabled && maxMB > 0 && isInlineDataPart(result)) {
    // Resolver results need not repeat the source attachment ID.
    if (current) preparation.currentImages.add(result);
    // Base64 is ASCII: length is its exact wire byte count. No request serialization or hashing.
    preparation.bytes += result.inlineData.data?.length ?? 0;
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

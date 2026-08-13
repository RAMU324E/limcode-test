const BASE64_BLOCK_CHARACTERS = 4;
const BASE64_BLOCK_BYTES = 3;

export interface CanonicalBase64DecodeOptions {
  /** Reject decoded payloads larger than this exact raw-byte ceiling before allocating the Buffer. */
  maxBytes?: number;
}

/** Maximum canonical base64 string length that can encode at most maxBytes raw bytes. */
export function canonicalBase64MaxCharacters(maxBytesInput: number): number {
  const maxBytes = requireNonNegativeSafeInteger(maxBytesInput, 'maxBytes');
  return Math.ceil(maxBytes / BASE64_BLOCK_BYTES) * BASE64_BLOCK_CHARACTERS;
}

/**
 * Decodes RFC 4648 canonical base64 without applying an unbounded RegExp to the full payload.
 * Buffer's decoder is permissive, so the encode round trip remains the canonical alphabet/padding
 * authority. The optional raw-byte ceiling is checked from encoded length before allocation and
 * checked again against the exact decoded length.
 */
export function decodeCanonicalBase64(
  value: string,
  options: CanonicalBase64DecodeOptions = {}
): Buffer {
  if (typeof value !== 'string' || value.length % BASE64_BLOCK_CHARACTERS !== 0) {
    throw new TypeError('Value must be canonical base64.');
  }
  const maxBytes = options.maxBytes === undefined
    ? undefined
    : requireNonNegativeSafeInteger(options.maxBytes, 'maxBytes');
  if (maxBytes !== undefined && value.length > canonicalBase64MaxCharacters(maxBytes)) {
    throw new RangeError(`Decoded base64 exceeds ${maxBytes} bytes.`);
  }

  const bytes = Buffer.from(value, 'base64');
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new RangeError(`Decoded base64 exceeds ${maxBytes} bytes.`);
  }
  if (bytes.toString('base64') !== value) {
    throw new TypeError('Value must be canonical base64.');
  }
  return bytes;
}

export function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    decodeCanonicalBase64(value);
    return true;
  } catch {
    return false;
  }
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

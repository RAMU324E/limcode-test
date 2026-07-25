export function canonicalAttachmentBase64(value: string, label = 'Attachment'): string {
  const normalized = value.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${label} contains invalid base64 data.`);
  }
  const unpadded = normalized.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) throw new Error(`${label} contains invalid base64 data.`);
  const canonical = Buffer.from(normalized, 'base64').toString('base64');
  if (canonical.replace(/=+$/, '') !== unpadded) throw new Error(`${label} contains invalid base64 data.`);
  return canonical;
}

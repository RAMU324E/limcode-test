import type { MessageContent } from '../../shared/protocol';

/** Extracts managed attachment IDs from canonical durable contents; this is not a persisted index. */
export function managedAttachmentIdsFromContents(contents: Iterable<MessageContent>): string[] {
  const ids = new Set<string>();
  for (const content of contents) visit(content.parts, ids);
  return [...ids].sort();
}

function visit(value: unknown, target: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, target);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const attachmentId = record.attachmentId;
  if (typeof attachmentId === 'string' && attachmentId.startsWith('attachment-')) target.add(attachmentId);
  for (const nested of Object.values(record)) visit(nested, target);
}

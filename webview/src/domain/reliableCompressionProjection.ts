export interface ReliableCompressionTimelineProjection {
  byAnchor: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Places a reliable CompressionBlock only when its server-derived anchor is present in the
 * bounded Message window. Missing historical anchors remain in reliable history but are not
 * rendered in the current window; moving them to the latest row would falsify their chronology.
 */
export function projectReliableCompressionTimeline(
  blocks: readonly Record<string, unknown>[],
  messageIds: readonly string[]
): ReliableCompressionTimelineProjection {
  const visibleMessageIds = new Set(messageIds.filter(Boolean));
  const byAnchor: ReliableCompressionTimelineProjection['byAnchor'] = {};
  for (const block of blocks) {
    const anchor = text(block.anchor_message_id ?? block.anchorMessageId);
    if (!anchor || !visibleMessageIds.has(anchor)) continue;
    (byAnchor[anchor] ??= []).push(block);
  }
  return { byAnchor };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

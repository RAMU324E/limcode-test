/** A bounded render window keeps even 10,000-floor conversations at roughly constant DOM cost. */
export const TIMELINE_MOUNT_LIMIT = 30;
export const TIMELINE_SEGMENT_STEP = 20;
export const PENDING_TIMELINE_MOUNT_LIMIT = 8;

export function clampTimelineSegmentStart(totalRows: number, requestedStart: number): number {
  if (!Number.isSafeInteger(totalRows) || totalRows < 0) throw new RangeError('totalRows must be non-negative.');
  if (!Number.isSafeInteger(requestedStart)) throw new RangeError('requestedStart must be an integer.');
  return Math.max(0, Math.min(requestedStart, Math.max(0, totalRows - TIMELINE_MOUNT_LIMIT)));
}

export function latestTimelineSegmentStart(totalRows: number): number {
  return clampTimelineSegmentStart(totalRows, totalRows - TIMELINE_MOUNT_LIMIT);
}

export function mountedTimelineRowCount(totalRows: number, pendingRows = 0): number {
  return Math.min(totalRows, TIMELINE_MOUNT_LIMIT) + Math.min(pendingRows, PENDING_TIMELINE_MOUNT_LIMIT);
}

/**
 * The reliable snapshot intentionally contains only the newest bounded message window. Its local
 * array index therefore stops being the transcript floor once a conversation exceeds that window.
 */
export function absoluteTimelineFloor(messageSeq: number, fallbackFloor: number): number {
  if (Number.isFinite(messageSeq) && messageSeq > 0) {
    const projectedFloor = Math.ceil(messageSeq);
    if (Number.isSafeInteger(projectedFloor)) return projectedFloor;
  }
  if (!Number.isSafeInteger(fallbackFloor) || fallbackFloor <= 0) {
    throw new RangeError('fallbackFloor must be a positive integer.');
  }
  return fallbackFloor;
}

export const TIMELINE_MOUNT_LIMIT = 80;
export const TIMELINE_SEGMENT_STEP = 60;
export const PENDING_TIMELINE_MOUNT_LIMIT = 20;

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

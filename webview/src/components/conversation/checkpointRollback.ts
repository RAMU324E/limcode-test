import type { CheckpointRecord, CheckpointTimelineAnchorRecord } from '@shared/protocol';

export function checkpointBeforeMessageFloor(
  checkpoints: readonly CheckpointRecord[],
  checkpointAnchors: readonly CheckpointTimelineAnchorRecord[],
  messageId: string
): CheckpointRecord | undefined {
  const checkpointsById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  return checkpointAnchors
    .filter((anchor) => anchor.floorMessageId === messageId && anchor.position === 'before')
    .map((anchor) => ({ anchor, checkpoint: checkpointsById.get(anchor.checkpointId) }))
    .filter((item): item is { anchor: CheckpointTimelineAnchorRecord; checkpoint: CheckpointRecord } =>
      item.checkpoint?.status === 'created' && !!item.checkpoint.commitSha
    )
    .sort((left, right) => right.anchor.order - left.anchor.order || right.checkpoint.createdAt - left.checkpoint.createdAt || right.checkpoint.id.localeCompare(left.checkpoint.id))
    [0]?.checkpoint;
}

export function rollbackConfirmActionTitle(checkpoint: CheckpointRecord | undefined): string {
  return checkpoint
    ? '先恢复到此消息之前的存档点，再执行确认操作。'
    : '此消息之前没有可恢复的存档点。';
}

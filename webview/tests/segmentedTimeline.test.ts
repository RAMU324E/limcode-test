import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIMELINE_FOREGROUND_DETAIL_LIMIT,
  TIMELINE_MOUNT_LIMIT,
  absoluteTimelineFloor,
  latestTimelineSegmentStart,
  mountedTimelineRowCount,
  prioritizedTimelineDetailDemand
} from '../src/components/conversation/segmentedTimeline.ts';

test('60 through 10,000-floor conversations retain a constant mounted row budget', () => {
  for (const total of [60, 100, 200, 1_000, 10_000]) {
    assert.equal(mountedTimelineRowCount(total), TIMELINE_MOUNT_LIMIT);
    assert.equal(mountedTimelineRowCount(total, 100), 38);
    assert.equal(latestTimelineSegmentStart(total), total - TIMELINE_MOUNT_LIMIT);
  }
});

test('bounded snapshots preserve absolute transcript floors after the first 200 messages', () => {
  const newestWindow = Array.from({ length: 200 }, (_, index) => 9_801 + index);
  assert.equal(absoluteTimelineFloor(newestWindow[0], 1), 9_801);
  assert.equal(absoluteTimelineFloor(newestWindow.at(-1), 200), 10_000);
  assert.equal(absoluteTimelineFloor(116.5, 89), 117, 'transient sort anchors use the next absolute floor');
  assert.equal(absoluteTimelineFloor(0, 17), 17);
  assert.throws(() => absoluteTimelineFloor(0, 0), /positive integer/);
});

test('timeline detail demand always admits the last row first and backgrounds the old prefix', () => {
  const ids = Array.from({ length: TIMELINE_MOUNT_LIMIT }, (_, index) => `message-${index + 1}`);
  const demand = prioritizedTimelineDetailDemand(ids);
  assert.deepEqual(demand.critical, ['message-30']);
  assert.deepEqual(demand.visible, ['message-29', 'message-28', 'message-27', 'message-26', 'message-25', 'message-24', 'message-23']);
  assert.equal(demand.visible.length + demand.critical.length, TIMELINE_FOREGROUND_DETAIL_LIMIT);
  assert.deepEqual(demand.background, Array.from({ length: 22 }, (_, index) => `message-${22 - index}`));
  assert.deepEqual(prioritizedTimelineDetailDemand([]), { critical: [], visible: [], background: [] });
});

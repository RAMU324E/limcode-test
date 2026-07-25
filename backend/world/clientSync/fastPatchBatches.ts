import type { ClientSyncFastPatchBatch } from './resources';

/**
 * Coalesces only adjacent patches from the same state stream and transient Attempt epoch.
 * Keeping epoch boundaries intact lets the Webview reject a late reliable stream without
 * discarding unrelated patches that happened to target the same conversation stream.
 */
export function mergeFastPatchBatches(batches: readonly ClientSyncFastPatchBatch[]): ClientSyncFastPatchBatch[] {
  const merged: ClientSyncFastPatchBatch[] = [];
  for (const batch of batches) {
    const previous = merged[merged.length - 1];
    if (!previous
      || previous.streamId !== batch.streamId
      || !sameTransientStreamEpoch(previous.transientStreamEpoch, batch.transientStreamEpoch)) {
      merged.push(cloneBatch(batch));
      continue;
    }

    const previousEpoch = previous.transientStreamEpoch;
    const nextEpoch = batch.transientStreamEpoch;
    merged[merged.length - 1] = {
      streamId: batch.streamId,
      patches: [...previous.patches, ...batch.patches],
      ...(previousEpoch && nextEpoch
        ? { transientStreamEpoch: { ...nextEpoch, streamSeq: Math.max(previousEpoch.streamSeq, nextEpoch.streamSeq) } }
        : {})
    };
  }
  return merged;
}

function cloneBatch(batch: ClientSyncFastPatchBatch): ClientSyncFastPatchBatch {
  return {
    streamId: batch.streamId,
    patches: [...batch.patches],
    ...(batch.transientStreamEpoch ? { transientStreamEpoch: { ...batch.transientStreamEpoch } } : {})
  };
}

function sameTransientStreamEpoch(
  left: ClientSyncFastPatchBatch['transientStreamEpoch'],
  right: ClientSyncFastPatchBatch['transientStreamEpoch']
): boolean {
  if (!left || !right) return left === right;
  return left.requestId === right.requestId
    && left.attemptId === right.attemptId
    && left.generation === right.generation;
}

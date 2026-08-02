/**
 * Executes values with bounded concurrency and rejects as soon as the first worker fails.
 *
 * Every worker receives a shared child signal. A worker failure aborts its siblings before the
 * returned promise is rejected; the caller never waits for an abort-insensitive sibling to settle.
 */
export function mapWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    return Promise.reject(new TypeError('concurrency must be a positive integer.'));
  }
  if (values.length === 0) return Promise.resolve([]);

  const siblingController = new AbortController();
  const results = new Array<R>(values.length);

  return new Promise<R[]>((resolve, reject) => {
    let nextIndex = 0;
    let completed = 0;
    let settled = false;

    const cleanup = () => parentSignal?.removeEventListener('abort', onParentAbort);
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      siblingController.abort(error);
      reject(error);
    };
    const onParentAbort = () => fail(abortReason(parentSignal));

    const launchNext = () => {
      if (settled) return;
      if (nextIndex >= values.length) {
        if (completed === values.length) {
          settled = true;
          cleanup();
          resolve(results);
        }
        return;
      }

      const index = nextIndex;
      nextIndex += 1;
      // Attach both fulfillment and rejection handlers immediately. A sibling is allowed to ignore
      // cancellation forever without delaying the caller or producing an unhandled rejection later.
      void Promise.resolve()
        .then(() => {
          if (settled) return undefined as R;
          return worker(values[index], index, siblingController.signal);
        })
        .then((result) => {
          if (settled) return;
          results[index] = result;
          completed += 1;
          launchNext();
        }, fail);
    };

    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal?.aborted) {
      onParentAbort();
      return;
    }
    const workerCount = Math.min(concurrency, values.length);
    for (let index = 0; index < workerCount; index += 1) launchNext();
  });
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
}

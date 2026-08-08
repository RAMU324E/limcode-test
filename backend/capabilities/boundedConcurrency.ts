export interface BoundedAdmissionControl {
  /** Releases only the admission slot. The worker and its cancellation signal remain active. */
  release(): void;
}

/**
 * Executes independent values with bounded admission rather than bounded lifetime.
 *
 * A worker may release its slot after crossing a durable handoff boundary while its returned
 * Promise keeps waiting. This is useful for child-agent startup: creating the ChildExecution is
 * bounded, but a foreground answer wait must not prevent the next child from starting. Parent
 * cancellation still aborts every started worker, including workers which already released their
 * admission slot, and queued work is never started after cancellation.
 */
export function mapSettledWithBoundedAdmissionConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (
    value: T,
    index: number,
    signal: AbortSignal,
    admission: BoundedAdmissionControl
  ) => Promise<R>,
  parentSignal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    return Promise.reject(new TypeError('concurrency must be a positive integer.'));
  }
  if (values.length === 0) return Promise.resolve([]);

  const results = new Array<PromiseSettledResult<R>>(values.length);
  const activeControllers = new Map<number, AbortController>();
  const heldAdmissionSlots = new Set<number>();

  return new Promise<PromiseSettledResult<R>[]>((resolve, reject) => {
    let nextIndex = 0;
    let completed = 0;
    let finished = false;

    const cleanup = () => parentSignal?.removeEventListener('abort', onParentAbort);
    const finishAborted = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const reason = abortReason(parentSignal);
      for (const controller of activeControllers.values()) controller.abort(reason);
      activeControllers.clear();
      heldAdmissionSlots.clear();
      reject(reason);
    };
    const onParentAbort = () => finishAborted();

    const launchAvailable = () => {
      while (!finished && nextIndex < values.length && heldAdmissionSlots.size < concurrency) {
        const index = nextIndex;
        nextIndex += 1;
        const controller = new AbortController();
        activeControllers.set(index, controller);
        heldAdmissionSlots.add(index);
        let admissionReleased = false;
        const releaseAdmission = () => {
          if (finished || admissionReleased) return;
          admissionReleased = true;
          heldAdmissionSlots.delete(index);
          launchAvailable();
        };
        void Promise.resolve()
          .then(() => {
            if (finished) return undefined as R;
            return worker(values[index], index, controller.signal, { release: releaseAdmission });
          })
          .then(
            (value) => settleWorker(index, { status: 'fulfilled', value }, releaseAdmission),
            (reason) => settleWorker(index, { status: 'rejected', reason }, releaseAdmission)
          );
      }
    };

    const settleWorker = (
      index: number,
      outcome: PromiseSettledResult<R>,
      releaseAdmission: () => void
    ) => {
      if (finished) return;
      activeControllers.delete(index);
      releaseAdmission();
      results[index] = outcome;
      completed += 1;
      if (completed === values.length) {
        finished = true;
        cleanup();
        resolve(results);
      }
    };

    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    if (parentSignal?.aborted) {
      onParentAbort();
      return;
    }
    launchAvailable();
  });
}

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

/**
 * Executes independent values with bounded concurrency and records each outcome in input order.
 *
 * A worker failure releases only its own slot, so unrelated work continues and immediately refills
 * the available capacity. Every active worker owns a distinct child controller. Parent cancellation
 * aborts all of those controllers and rejects the batch without waiting for abort-insensitive work;
 * fulfillment/rejection handlers stay attached to every started Promise to prevent late unhandled
 * rejections.
 */
export function mapSettledWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number, signal: AbortSignal) => Promise<R>,
  parentSignal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    return Promise.reject(new TypeError('concurrency must be a positive integer.'));
  }
  if (values.length === 0) return Promise.resolve([]);

  const results = new Array<PromiseSettledResult<R>>(values.length);
  const activeControllers = new Map<number, AbortController>();

  return new Promise<PromiseSettledResult<R>[]>((resolve, reject) => {
    let nextIndex = 0;
    let completed = 0;
    let finished = false;

    const cleanup = () => parentSignal?.removeEventListener('abort', onParentAbort);
    const finishAborted = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const reason = abortReason(parentSignal);
      for (const controller of activeControllers.values()) controller.abort(reason);
      activeControllers.clear();
      reject(reason);
    };
    const onParentAbort = () => finishAborted();

    const settleWorker = (index: number, outcome: PromiseSettledResult<R>) => {
      if (finished) return;
      activeControllers.delete(index);
      results[index] = outcome;
      completed += 1;
      if (completed === values.length) {
        finished = true;
        cleanup();
        resolve(results);
        return;
      }
      launchNext();
    };

    const launchNext = () => {
      if (finished || nextIndex >= values.length) return;
      const index = nextIndex;
      nextIndex += 1;
      const controller = new AbortController();
      activeControllers.set(index, controller);
      // Attach both handlers before invoking user work. A parent abort may return immediately even
      // when a worker ignores its child signal, and a late rejection must remain observed.
      void Promise.resolve()
        .then(() => {
          if (finished) return undefined as R;
          return worker(values[index], index, controller.signal);
        })
        .then(
          (value) => settleWorker(index, { status: 'fulfilled', value }),
          (reason) => settleWorker(index, { status: 'rejected', reason })
        );
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

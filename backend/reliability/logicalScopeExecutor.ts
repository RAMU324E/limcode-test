export type ExecutionKey = string;

interface KeyTail {
  readonly entered: Promise<void>;
  release(): void;
}

/**
 * Acquires source, conversation and physical-resource keys in one global lexical order.
 * A caller never holds one scope while trying to acquire another, so multi-conversation commands
 * cannot deadlock with callbacks or shared-index writers.
 */
export class LogicalScopeExecutor {
  private readonly tails = new Map<ExecutionKey, Promise<void>>();

  public async run<T>(keys: Iterable<ExecutionKey>, action: () => Promise<T>): Promise<T> {
    const normalized = normalizeExecutionKeys(keys);
    if (normalized.length === 0) throw new Error('A durable transition must own at least one execution key.');

    const predecessors: Promise<void>[] = [];
    const leases: Array<{ key: ExecutionKey; tail: KeyTail }> = [];
    for (const key of normalized) {
      const predecessor = this.tails.get(key) ?? Promise.resolve();
      predecessors.push(predecessor.catch(() => undefined));
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { release = resolve; });
      const tail: KeyTail = { entered, release };
      this.tails.set(key, predecessor.catch(() => undefined).then(() => entered));
      leases.push({ key, tail });
    }

    await Promise.all(predecessors);
    try {
      return await action();
    } finally {
      for (const lease of leases) lease.tail.release();
      for (const lease of leases) {
        const current = this.tails.get(lease.key);
        const installed = lease.tail.entered;
        // The map stores predecessor.then(() => installed), not installed itself. It is safe to
        // remove only after the chain settles and only if no later waiter replaced it.
        if (!current) continue;
        void current.finally(() => {
          if (this.tails.get(lease.key) === current) this.tails.delete(lease.key);
        });
        void installed;
      }
    }
  }

  /** Waits for every lease already registered by callers; callers must stop admitting new work first. */
  public async drain(): Promise<void> {
    const tails = [...this.tails.values()];
    await Promise.all(tails.map((tail) => tail.catch(() => undefined)));
  }

  public pendingKeyCount(): number {
    return this.tails.size;
  }
}

export function normalizeExecutionKeys(keys: Iterable<ExecutionKey>): ExecutionKey[] {
  const unique = new Set<string>();
  for (const raw of keys) {
    const key = raw.trim();
    if (!key) throw new Error('Execution keys cannot be empty.');
    unique.add(key);
  }
  return [...unique].sort((left, right) => left.localeCompare(right));
}

export function sourceExecutionKey(sourceKey: string): ExecutionKey { return `source:${sourceKey}`; }
export function commandExecutionKey(commandId: string): ExecutionKey { return sourceExecutionKey(`command:${commandId}`); }
export function eventExecutionKey(eventId: string): ExecutionKey { return sourceExecutionKey(`event:${eventId}`); }
export function internalExecutionKey(key: string): ExecutionKey { return sourceExecutionKey(`internal:${key}`); }
export function recoveryExecutionKey(key: string): ExecutionKey { return sourceExecutionKey(`recovery:${key}`); }
export function conversationExecutionKey(conversationId: string): ExecutionKey { return `scope:conversation:${conversationId}`; }
export function storageExecutionKey(resourceKey: string): ExecutionKey { return `storage:${resourceKey}`; }

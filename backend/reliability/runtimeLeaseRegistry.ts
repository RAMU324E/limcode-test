export type RuntimeLeaseKind = 'llm' | 'compression' | 'tool';

export interface RuntimeLease {
  key: string;
  ownerId: string;
  generation: number;
  kind: RuntimeLeaseKind;
  externalIds: string[];
  abort(reason: string): void;
}

/**
 * Process-local capability lease registry. Durable runtime.cleanup effects address leases by the
 * persisted source Attempt ID; the registry only owns live abort handles and never domain state.
 */
export class RuntimeLeaseRegistry {
  private readonly leases = new Map<string, RuntimeLease>();

  public register(lease: RuntimeLease): void {
    const current = this.leases.get(lease.key);
    if (current && (current.ownerId !== lease.ownerId || current.generation !== lease.generation || current.kind !== lease.kind)) {
      throw new Error(`Runtime lease key collision: ${lease.key}`);
    }
    this.leases.set(lease.key, {
      ...lease,
      externalIds: [...new Set(lease.externalIds)].sort()
    });
  }

  public release(key: string): void {
    this.leases.delete(key);
  }

  public abortOwned(
    ownerId: string,
    options: { kinds?: readonly RuntimeLeaseKind[]; externalIds?: readonly string[]; reason: string }
  ): number {
    const kinds = options.kinds ? new Set(options.kinds) : undefined;
    const externalIds = new Set(options.externalIds ?? []);
    const matches = [...this.leases.values()].filter((lease) => lease.ownerId === ownerId
      && (!kinds || kinds.has(lease.kind))
      && (externalIds.size === 0 || lease.externalIds.some((id) => externalIds.has(id))));
    for (const lease of matches) {
      this.leases.delete(lease.key);
      lease.abort(options.reason);
    }
    return matches.length;
  }

  public abortAll(reason: string): void {
    const leases = [...this.leases.values()];
    this.leases.clear();
    for (const lease of leases) lease.abort(reason);
  }

  public size(): number {
    return this.leases.size;
  }
}

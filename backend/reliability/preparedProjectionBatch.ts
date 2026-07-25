import type { ConversationId } from '../../shared/stableIds';
import type { PreparedProjectionBatch, StorageHead } from '../../shared/conversationReliability';
import type { PreparedIndexDelta, StableEntityIndex } from './stableEntityIndex';

export interface ProjectionBatchHooks {
  currentVersion(conversationId: ConversationId): number;
  apply(): void | Promise<void>;
  evictAndRehydrate(scopes: readonly ConversationId[], heads: ReadonlyMap<string, StorageHead>): void | Promise<void>;
}

/**
 * Projection overlay prepared before file commit and applied only at a scheduler safe point.
 * Durable storage remains authoritative if the loaded World changed while the file transaction ran.
 */
export class PreparedWorldProjectionBatch implements PreparedProjectionBatch {
  private state: 'prepared' | 'committed' | 'discarded' = 'prepared';

  public constructor(
    public readonly batchId: string,
    public readonly scopes: readonly ConversationId[],
    public readonly expectedProjectionVersions: ReadonlyMap<ConversationId, number>,
    public readonly committedStorageHeads: ReadonlyMap<string, StorageHead>,
    public readonly touchedStableIds: readonly string[],
    private readonly hooks: ProjectionBatchHooks,
    private readonly stableIndex?: StableEntityIndex,
    private readonly indexDelta?: PreparedIndexDelta
  ) {}

  public async commitAtSchedulerSafePoint(): Promise<void> {
    this.requirePrepared();
    const changed = this.scopes.some((scope) => this.hooks.currentVersion(scope) !== this.expectedProjectionVersions.get(scope));
    if (changed) {
      this.discard();
      await this.rehydrateCommittedState();
      return;
    }

    try {
      await this.hooks.apply();
      if (this.stableIndex && this.indexDelta) this.stableIndex.commit(this.indexDelta);
      this.state = 'committed';
    } catch (error) {
      if (this.stableIndex && this.indexDelta) this.stableIndex.discard(this.indexDelta);
      this.state = 'discarded';
      throw error;
    }
  }

  public async rehydrateCommittedState(): Promise<void> {
    if (this.state === 'prepared' && this.stableIndex && this.indexDelta) this.stableIndex.discard(this.indexDelta);
    await this.hooks.evictAndRehydrate(this.scopes, this.committedStorageHeads);
    this.state = 'committed';
  }

  public discard(): void {
    this.requirePrepared();
    if (this.stableIndex && this.indexDelta) this.stableIndex.discard(this.indexDelta);
    this.state = 'discarded';
  }

  public currentState(): 'prepared' | 'committed' | 'discarded' { return this.state; }

  private requirePrepared(): void {
    if (this.state !== 'prepared') throw new Error(`Projection batch ${this.batchId} is ${this.state}.`);
  }
}

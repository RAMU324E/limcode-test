import type { Entity } from '../ecs/types';

export type StableBindingDelta =
  | { kind: 'bind'; componentId: symbol; stableId: string; entity: Entity }
  | { kind: 'unbind'; componentId: symbol; stableId: string; entity: Entity };

export interface PreparedIndexDelta {
  readonly batchId: string;
  readonly changes: readonly StableBindingDelta[];
  readonly state: 'prepared' | 'committed' | 'discarded';
}

interface MutablePreparedIndexDelta {
  batchId: string;
  changes: StableBindingDelta[];
  state: 'prepared' | 'committed' | 'discarded';
}

/** Unique loaded Stable ID → Entity index. It never answers durable existence questions. */
export class StableEntityIndex {
  private readonly byComponent = new Map<symbol, Map<string, Entity>>();
  private readonly byEntity = new Map<Entity, Array<{ componentId: symbol; stableId: string }>>();
  private readonly prepared = new Map<string, MutablePreparedIndexDelta>();

  public resolveLoaded(componentId: symbol, stableId: string): Entity | undefined {
    return this.byComponent.get(componentId)?.get(stableId);
  }

  public requireLoaded(componentId: symbol, stableId: string): Entity {
    const entity = this.resolveLoaded(componentId, stableId);
    if (entity === undefined) throw new Error(`Stable ID is not loaded: ${stableId}`);
    return entity;
  }

  public prepare(batchId: string, bindings: readonly StableBindingDelta[]): PreparedIndexDelta {
    const normalizedBatchId = batchId.trim();
    if (!normalizedBatchId) throw new Error('StableEntityIndex batchId cannot be empty.');
    if (this.prepared.has(normalizedBatchId)) throw new Error(`StableEntityIndex batch already exists: ${normalizedBatchId}`);

    const overlay = cloneComponentMaps(this.byComponent);
    const seen = new Set<string>();
    const changes: StableBindingDelta[] = [];
    for (const change of bindings) {
      const stableId = change.stableId.trim();
      if (!stableId) throw new Error('StableEntityIndex cannot bind an empty Stable ID.');
      const key = `${String(change.componentId)}\u0000${stableId}`;
      if (seen.has(key)) throw new Error(`StableEntityIndex batch contains duplicate binding: ${stableId}`);
      seen.add(key);
      const map = getOrCreate(overlay, change.componentId);
      const current = map.get(stableId);
      if (change.kind === 'bind') {
        if (current !== undefined && current !== change.entity) {
          throw new Error(`Stable ID conflict: ${stableId} is loaded as Entity ${current}, cannot bind Entity ${change.entity}.`);
        }
        map.set(stableId, change.entity);
      } else {
        if (current !== undefined && current !== change.entity) {
          throw new Error(`Stable ID unbind conflict: ${stableId} belongs to Entity ${current}, not ${change.entity}.`);
        }
        map.delete(stableId);
      }
      changes.push({ ...change, stableId });
    }

    const prepared: MutablePreparedIndexDelta = { batchId: normalizedBatchId, changes, state: 'prepared' };
    this.prepared.set(normalizedBatchId, prepared);
    return prepared;
  }

  public commit(delta: PreparedIndexDelta): void {
    const prepared = this.requirePrepared(delta);
    for (const change of prepared.changes) {
      if (change.kind === 'bind') this.bind(change.componentId, change.stableId, change.entity);
      else this.unbind(change.componentId, change.stableId, change.entity);
    }
    prepared.state = 'committed';
    this.prepared.delete(prepared.batchId);
  }

  public discard(delta: PreparedIndexDelta): void {
    const prepared = this.requirePrepared(delta);
    prepared.state = 'discarded';
    this.prepared.delete(prepared.batchId);
  }

  public unbindEntity(entity: Entity): void {
    const bindings = this.byEntity.get(entity) ?? [];
    for (const binding of bindings) this.byComponent.get(binding.componentId)?.delete(binding.stableId);
    this.byEntity.delete(entity);
  }

  public entries(): Array<{ componentId: symbol; stableId: string; entity: Entity }> {
    const result: Array<{ componentId: symbol; stableId: string; entity: Entity }> = [];
    for (const [componentId, bindings] of this.byComponent) {
      for (const [stableId, entity] of bindings) result.push({ componentId, stableId, entity });
    }
    return result.sort((left, right) => left.stableId.localeCompare(right.stableId) || left.entity - right.entity);
  }

  private bind(componentId: symbol, stableId: string, entity: Entity): void {
    const map = getOrCreate(this.byComponent, componentId);
    const current = map.get(stableId);
    if (current !== undefined && current !== entity) throw new Error(`Stable ID conflict at commit: ${stableId}.`);
    map.set(stableId, entity);
    const entityBindings = this.byEntity.get(entity) ?? [];
    if (!entityBindings.some((binding) => binding.componentId === componentId && binding.stableId === stableId)) {
      entityBindings.push({ componentId, stableId });
      this.byEntity.set(entity, entityBindings);
    }
  }

  private unbind(componentId: symbol, stableId: string, entity: Entity): void {
    const map = this.byComponent.get(componentId);
    if (map?.get(stableId) === entity) map.delete(stableId);
    const entityBindings = this.byEntity.get(entity);
    if (!entityBindings) return;
    const next = entityBindings.filter((binding) => binding.componentId !== componentId || binding.stableId !== stableId);
    if (next.length > 0) this.byEntity.set(entity, next); else this.byEntity.delete(entity);
  }

  private requirePrepared(delta: PreparedIndexDelta): MutablePreparedIndexDelta {
    const prepared = this.prepared.get(delta.batchId);
    if (!prepared || prepared !== delta || prepared.state !== 'prepared') {
      throw new Error(`StableEntityIndex batch is not prepared: ${delta.batchId}`);
    }
    return prepared;
  }
}

function getOrCreate(maps: Map<symbol, Map<string, Entity>>, componentId: symbol): Map<string, Entity> {
  let map = maps.get(componentId);
  if (!map) {
    map = new Map();
    maps.set(componentId, map);
  }
  return map;
}

function cloneComponentMaps(source: ReadonlyMap<symbol, ReadonlyMap<string, Entity>>): Map<symbol, Map<string, Entity>> {
  return new Map([...source].map(([componentId, bindings]) => [componentId, new Map(bindings)]));
}

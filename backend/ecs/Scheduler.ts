import { CommandBuffer } from './CommandBuffer';
import { deserializeWorldCommands } from './WireCommand';
import { SystemWorkerPool } from './SystemWorkerPool';
import {
  ComponentType,
  MutationMode,
  QueryAccess,
  ResourceKey,
  SchedulerWorld,
  System,
  SystemAccess,
  SystemContext,
  WorldCommand,
  WorldReader,
  WorldSnapshotFilter
} from './types';

const MAX_ITER = 10_000;
const EVENT_LOOP_YIELD_INTERVAL_MS = 8;

type TokenKey = symbol | string;
type WriteModeMap = Map<TokenKey, Set<MutationMode>>;

interface SchedulerHooks {
  /** System 通过 cmd.effect 产出的 effect 会在 wave commit 时交给 Imperative Shell 收集。 */
  applyEffect?(effect: unknown): void;
  /** 每轮 schedule pass 后调用。适合 flush client patch 等实时、只读外部副作用。 */
  afterPass?(): void | Promise<void>;
  /** 每次 tick 达到不动点后调用。用于 Imperative Shell 执行稳定阶段 effects。 */
  afterTick?(): void | Promise<void>;
}

export interface SchedulerOptions {
  /** true 时，带 system.worker 的 system 会放进 Node worker_threads 真并行执行。 */
  readonly parallelWorkers?: boolean;
  /** 每个会 spawn 的 worker system 预留的 entity id 段大小；system 内 spawn 数超过该值会抛错。 */
  readonly workerEntityBlockSize?: number;
  /** worker pool 最大并发数；未配置时按 CPU 数保守推导。 */
  readonly workerPoolSize?: number;
}

interface RegisteredSystem {
  readonly system: System;
  readonly order: number;
}

interface SystemNode {
  readonly registered: RegisteredSystem;
  readonly access: AccessSummary;
}

interface AccessSummary {
  /** 参与拓扑依赖的数据读取。 */
  readonly topoReads: Set<TokenKey>;
  /** 参与并行冲突判断的读取。 */
  readonly conflictReads: Set<TokenKey>;
  /** 参与拓扑/冲突判断的写入。 */
  readonly writes: Set<TokenKey>;
  /** token 的稳定可读名称，用于输出可操作的拓扑诊断。 */
  readonly tokenLabels: Map<TokenKey, string>;
  readonly mutationModes: WriteModeMap;
  readonly snapshotComponents: Set<ComponentType<unknown>>;
  readonly snapshotResources: Set<ResourceKey<unknown>>;
  readonly maySpawn: boolean;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

interface SystemRunResult {
  readonly order: number;
  readonly buffer?: CommandBuffer;
  readonly commands?: readonly WorldCommand[];
}

interface CompiledSchedule {
  readonly order: readonly SystemNode[];
  readonly waves: readonly SystemNode[][];
}

export type SchedulerHealth = 'initializing' | 'ready' | 'failed' | 'disposed';

export interface SchedulerHealthSnapshot {
  readonly status: SchedulerHealth;
  readonly error?: Error;
}

export class SchedulerCompileError extends Error {
  public readonly code = 'scheduler_compile_failed';
  public readonly originalCause: unknown;

  public constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'SchedulerCompileError';
    this.originalCause = options.cause;
  }
}

export class SchedulerDependencyCycleError extends SchedulerCompileError {
  public readonly cycleSystems: readonly string[];
  public readonly dependencyEdges: readonly string[];

  public constructor(cycleSystems: readonly string[], dependencyEdges: readonly string[]) {
    super(`[ECS] system dependency cycle detected: ${cycleSystems.join(' -> ')}. Edges: ${dependencyEdges.join('; ')}`);
    this.name = 'SchedulerDependencyCycleError';
    this.cycleSystems = cycleSystems;
    this.dependencyEdges = dependencyEdges;
  }
}

/**
 * 事件驱动调度器。
 * - 入队事件 → wake() → microtask 中 tick()。
 * - tick() 反复跑编译后的 system waves，直到"不动点"（一整轮系统跑完后 version 不再变化）。
 * - System 不直接写 World，而是产出 CommandBuffer；Scheduler 在 wave 边界统一 commit。
 * - System 顺序由显式 access 声明编译出的拓扑图决定；无依赖关系时保持注册顺序。
 * - 同一 wave 内系统在 access 上无读写/写写冲突；带 worker spec 的 system 可在 Node worker_threads 中真并行运行。
 */
export class Scheduler {
  private readonly systems: RegisteredSystem[] = [];
  private running = false;
  private scheduled = false;
  private stopped = false;
  private health: SchedulerHealth = 'initializing';
  private failure: Error | undefined;
  private nextOrder = 0;
  private readonly idleWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  private readonly safePointRequests: Array<{
    action: () => unknown | Promise<unknown>;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];
  private readonly workerPool?: SystemWorkerPool;

  public constructor(
    private readonly world: SchedulerWorld,
    private readonly hooks: SchedulerHooks = {},
    private readonly options: SchedulerOptions = {}
  ) {
    world.setWake(() => this.wake());
    if (options.parallelWorkers) {
      this.workerPool = new SystemWorkerPool({ size: options.workerPoolSize });
    }
  }

  public add(system: System): this {
    if (this.stopped) throw new Error('Cannot register a system after Scheduler disposal.');
    if (this.health === 'failed') throw this.failure ?? new SchedulerCompileError('Scheduler is in a failed state.');
    if (this.systems.some((item) => item.system.name === system.name)) {
      throw new Error(`[ECS] Duplicate system name: ${system.name}`);
    }
    this.systems.push({ system, order: this.nextOrder++ });
    this.health = 'initializing';
    return this;
  }

  public addMany(systems: System[]): this {
    for (const system of systems) {
      this.add(system);
    }
    return this;
  }

  public dispose(): void {
    this.stopped = true;
    this.health = 'disposed';
    this.workerPool?.dispose();
    const error = new Error('Scheduler disposed before safe-point work completed.');
    for (const request of this.safePointRequests.splice(0)) request.reject(error);
    this.resolveIdleWaiters(true);
  }

  /** 在开放业务命令前编译完整生产图；失败会使 Scheduler 永久进入 failed。 */
  public prepare(): void {
    if (this.stopped) throw new Error('Scheduler is stopped.');
    if (this.health === 'failed') throw this.failure;
    try {
      this.compileSchedule();
      this.health = 'ready';
    } catch (error) {
      const failure = this.fail(error);
      throw failure;
    }
  }

  public healthSnapshot(): SchedulerHealthSnapshot {
    return this.failure ? { status: this.health, error: this.failure } : { status: this.health };
  }

  /** 等待当前已排队事件及其派生事件达到稳定状态；不会停止 Scheduler。 */
  public waitForIdle(): Promise<void> {
    if (this.health === 'failed') return Promise.reject(this.failure);
    if (this.stopped || (!this.running && !this.scheduled && this.world.pendingCount() === 0 && this.safePointRequests.length === 0)) return Promise.resolve();
    if (!this.running && !this.scheduled && this.world.pendingCount() > 0) this.wake();
    return new Promise((resolve, reject) => {
      this.idleWaiters.push({ resolve, reject });
    });
  }

  public async stopAndDrain(): Promise<void> {
    if (this.stopped) return;
    for (;;) {
      if (this.health === 'failed') break;
      if (!this.running && !this.scheduled && this.world.pendingCount() === 0 && this.safePointRequests.length === 0) break;
      if (!this.running && !this.scheduled && this.world.pendingCount() > 0) this.wake();
      await yieldToEventLoop();
    }
    this.stopped = true;
    this.health = 'disposed';
    this.workerPool?.dispose();
  }

  /**
   * 在 system wave 之外、Scheduler 持有单线程写权时执行投影切换。
   * 文件事务在 storage_committed 后通过这里提交 ECS projection，避免与 CommandBuffer 交错。
   */
  public runAtSafePoint<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.health === 'failed') return Promise.reject(this.failure);
    if (this.stopped) return Promise.reject(new Error('Scheduler is stopped.'));
    const result = new Promise<T>((resolve, reject) => {
      this.safePointRequests.push({
        action,
        resolve: (value) => resolve(value as T),
        reject
      });
    });
    this.wake();
    return result;
  }

  /** 供调试/测试查看当前拓扑结果。 */
  public getSystemOrder(): string[] {
    return this.compileSchedule().order.map((node) => node.registered.system.name);
  }

  /** 供调试/测试查看当前可并行 wave。 */
  public getSystemWaves(): string[][] {
    return this.compileSchedule().waves.map((wave) => wave.map((node) => node.registered.system.name));
  }

  private wake(): void {
    if (this.stopped || this.health === 'failed') return;
    // 运行期间的同步入队由不动点循环消化；空闲时才安排下一次 tick。
    if (this.scheduled || this.running) {
      return;
    }
    this.scheduled = true;
    scheduleSchedulerTask(() => {
      this.scheduled = false;
      this.tick();
    });
  }

  private tick(): void {
    if (this.stopped || this.health === 'failed') return;
    this.running = true;
    let schedule: CompiledSchedule;
    try {
      schedule = this.compileSchedule();
      this.health = 'ready';
    } catch (error) {
      this.fail(error);
      return;
    }
    void this.runTick(schedule).catch((error) => this.fail(error));
  }

  private async runTick(schedule: CompiledSchedule): Promise<void> {
    try {
      let guard = 0;
      let lastYieldAt = Date.now();
      for (;;) {
        const before = this.world.version();
        const events = this.world.drainQueue();
        const ctx: SystemContext = { events };

        await this.runSchedule(schedule, ctx);

        try {
          await this.hooks.afterPass?.();
        } catch (error) {
          console.error('[ECS] afterPass hook threw:', error);
        }

        guard += 1;
        const reachedFixedPoint = this.world.version() === before;
        let drainedSafePointBatch = false;
        if (reachedFixedPoint) {
          if (this.safePointRequests.length === 0) break;
          await this.drainSafePointRequests();
          drainedSafePointBatch = true;
          // Safe-point projection may change components without enqueuing an event. Run another
          // pass so progress systems observe the committed projection before Ack is released.
        }
        if (guard >= MAX_ITER) {
          console.warn(`[ECS] scheduler hit MAX_ITER(${MAX_ITER}); forcing break.`);
          // A completed pass is a legal safe-point boundary: every wave command buffer has been
          // committed and afterPass has finished. Drain one snapshot even without a fixed point so
          // continuously changing systems cannot leave projection/Ack work stranded indefinitely.
          if (!drainedSafePointBatch && this.safePointRequests.length > 0) {
            await this.drainSafePointRequests();
          }
          break;
        }

        const now = Date.now();
        if (now - lastYieldAt >= EVENT_LOOP_YIELD_INTERVAL_MS) {
          await yieldToEventLoop();
          lastYieldAt = Date.now();
        }
      }
    } finally {
      this.running = false;
    }

    try {
      await this.hooks.afterTick?.();
    } catch (error) {
      console.error('[ECS] afterTick hook threw:', error);
    }

    // 兜底：若运行期间仍有未处理事件或 safe-point 请求，安排下一次 tick。
    // drainSafePointRequests 使用批次快照；action 期间追加的请求由下一合法边界处理。
    if (this.world.pendingCount() > 0 || this.safePointRequests.length > 0) {
      this.wake();
    }
    this.resolveIdleWaiters();
  }

  private async drainSafePointRequests(): Promise<void> {
    const requests = this.safePointRequests.splice(0);
    for (const request of requests) {
      try { request.resolve(await request.action()); }
      catch (error) { request.reject(error); }
    }
  }

  private resolveIdleWaiters(force = false): void {
    if (!force && (this.running || this.scheduled || this.world.pendingCount() > 0 || this.safePointRequests.length > 0)) return;
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  private fail(error: unknown): Error {
    const failure = normalizeSchedulerFailure(error);
    if (this.health !== 'failed') {
      console.error(failure.message, failure instanceof SchedulerCompileError ? failure.originalCause ?? '' : '');
    }
    this.failure = failure;
    this.health = 'failed';
    this.running = false;
    this.scheduled = false;
    for (const request of this.safePointRequests.splice(0)) request.reject(failure);
    for (const waiter of this.idleWaiters.splice(0)) waiter.reject(failure);
    return failure;
  }

  private async runSchedule(schedule: CompiledSchedule, ctx: SystemContext): Promise<void> {
    for (const wave of schedule.waves) {
      const results = await Promise.all(wave.map((node) => this.runSystemNode(node, ctx)));

      for (const result of results.filter((item): item is SystemRunResult => item !== undefined).sort((a, b) => a.order - b.order)) {
        const commands = result.commands ?? result.buffer?.commands() ?? [];
        if (commands.length > 0) {
          this.world.commit(commands, (effect) => this.applyEffect(effect));
        }
      }
    }
  }

  private async runSystemNode(node: SystemNode, ctx: SystemContext): Promise<SystemRunResult | undefined> {
    const { system, order } = node.registered;
    if (!this.shouldRunSystem(system, ctx)) {
      return undefined;
    }

    if (this.options.parallelWorkers && system.worker) {
      return this.runSystemInWorker(node, ctx);
    }

    const buffer = new CommandBuffer(this.world);
    try {
      system.run({ ...ctx, world: this.world, cmd: buffer });
      return { order, buffer };
    } catch (error) {
      // 丢弃该 system 的未提交 buffer，避免部分命令污染 world。
      console.error(`[ECS] system "${system.name}" threw:`, error);
      return undefined;
    }
  }

  private shouldRunSystem(system: System, ctx: SystemContext): boolean {
    if (!system.shouldRun) return true;
    try {
      return system.shouldRun({ ...ctx, world: this.world });
    } catch (error) {
      console.error(`[ECS] system "${system.name}" shouldRun threw:`, error);
      return false;
    }
  }

  private async runSystemInWorker(node: SystemNode, ctx: SystemContext): Promise<SystemRunResult | undefined> {
    const { system, order } = node.registered;
    if (!system.worker) return undefined;
    if (!this.workerPool) {
      console.error(`[ECS] worker system "${system.name}" cannot run because worker pool is not configured.`);
      return undefined;
    }

    const blockSize = node.access.maySpawn ? (this.options.workerEntityBlockSize ?? 1_000) : 0;
    const entityBase = this.reserveEntityBlock(blockSize);
    const filter = snapshotFilter(node.access);
    const snapshot = this.world.snapshot(filter);
    const payload = system.worker.payload?.({ world: this.world, events: ctx.events, snapshot }) ?? { snapshot, events: ctx.events };

    try {
      const message = await this.workerPool.run({
        modulePath: system.worker.modulePath,
        exportName: system.worker.exportName,
        events: ctx.events,
        entityBase,
        entityLimit: blockSize,
        payload
      });
      if (!message.ok) {
        console.error(`[ECS] worker system "${system.name}" threw:`, message.stack ?? message.error);
        return undefined;
      }
      return { order, commands: deserializeWorldCommands(message.commands) };
    } catch (error) {
      console.error(`[ECS] worker system "${system.name}" failed:`, error);
      return undefined;
    }
  }

  private reserveEntityBlock(size: number): number {
    if (size <= 0) return 0;
    const base = this.world.reserveEntity();
    for (let i = 1; i < size; i += 1) {
      this.world.reserveEntity();
    }
    return base;
  }

  private applyEffect(effect: unknown): void {
    if (!this.hooks.applyEffect) {
      console.error('[ECS] system produced an effect but SchedulerHooks.applyEffect is not configured:', effect);
      return;
    }
    this.hooks.applyEffect(effect);
  }

  private compileSchedule(): CompiledSchedule {
    const nodes = this.systems
      .map((registered): SystemNode => ({ registered, access: summarizeAccess(resolveAccess(registered.system, this.world)) }))
      .sort((a, b) => a.registered.order - b.registered.order);

    const byName = new Map(nodes.map((node) => [node.registered.system.name, node]));
    const outgoing = new Map<SystemNode, Set<SystemNode>>();
    const edgeReasons = new Map<SystemNode, Map<SystemNode, Set<string>>>();
    const indegree = new Map<SystemNode, number>();

    for (const node of nodes) {
      outgoing.set(node, new Set());
      edgeReasons.set(node, new Map());
      indegree.set(node, 0);
    }

    const addEdge = (from: SystemNode, to: SystemNode, reason: string): void => {
      if (from === to) return;
      const reasonsByTarget = edgeReasons.get(from)!;
      let reasons = reasonsByTarget.get(to);
      if (!reasons) {
        reasons = new Set();
        reasonsByTarget.set(to, reasons);
      }
      reasons.add(reason);
      const edges = outgoing.get(from)!;
      if (edges.has(to)) return;
      edges.add(to);
      indegree.set(to, indegree.get(to)! + 1);
    };

    for (const producer of nodes) {
      for (const consumer of nodes) {
        if (producer === consumer) continue;
        // 自动 write->read 依赖只把已注册在前的 producer 推到后续 consumer 之前。
        // 如果 consumer 注册顺序更早，说明这是一个反馈读取；由固定注册顺序 + 不动点多 pass 在下一 pass 消化，
        // 否则互相读写同一 component 的系统会形成无法拓扑排序的静态环。
        if (producer.registered.order > consumer.registered.order) continue;
        for (const token of intersectionValues(producer.access.writes, consumer.access.topoReads)) {
          const label = producer.access.tokenLabels.get(token) ?? consumer.access.tokenLabels.get(token) ?? String(token);
          addEdge(producer, consumer, `write->read:${label}`);
        }
      }
    }

    for (const node of nodes) {
      for (const targetName of node.access.before) {
        const target = byName.get(targetName);
        if (!target) throw new Error(`[ECS] system "${node.registered.system.name}" declares before unknown system "${targetName}".`);
        addEdge(node, target, `before:${targetName}`);
      }
      for (const targetName of node.access.after) {
        const target = byName.get(targetName);
        if (!target) throw new Error(`[ECS] system "${node.registered.system.name}" declares after unknown system "${targetName}".`);
        addEdge(target, node, `after:${targetName}`);
      }
    }

    return buildWaves(nodes, outgoing, indegree, edgeReasons);
  }
}

function resolveAccess(system: System, world: WorldReader): SystemAccess {
  if (!system.access) return {};
  return typeof system.access === 'function' ? system.access(world) : system.access;
}

function summarizeAccess(access: SystemAccess): AccessSummary {
  const topoReads = new Set<TokenKey>();
  const conflictReads = new Set<TokenKey>();
  const writes = new Set<TokenKey>();
  const tokenLabels = new Map<TokenKey, string>();
  const mutationModes: WriteModeMap = new Map();
  const snapshotComponents = new Set<ComponentType<unknown>>();
  const snapshotResources = new Set<ResourceKey<unknown>>();
  let maySpawn = false;

  const addComponentReads = (components: readonly ComponentType<unknown>[] | undefined, topology: boolean): void => {
    for (const component of components ?? []) {
      const key = componentToken(component);
      tokenLabels.set(key, `component:${component.name}`);
      conflictReads.add(key);
      snapshotComponents.add(component);
      if (topology) topoReads.add(key);
    }
  };
  const addComponentWrites = (components: readonly ComponentType<unknown>[] | undefined, mode: MutationMode = 'update'): void => {
    for (const component of components ?? []) {
      const key = componentToken(component);
      tokenLabels.set(key, `component:${component.name}`);
      writes.add(key);
      addWriteMode(mutationModes, key, mode);
      snapshotComponents.add(component);
    }
  };
  const addResourceReads = (resources: readonly ResourceKey<unknown>[] | undefined, topology: boolean): void => {
    for (const resource of resources ?? []) {
      const key = resourceToken(resource);
      tokenLabels.set(key, `resource:${resource.name}`);
      conflictReads.add(key);
      snapshotResources.add(resource);
      if (topology) topoReads.add(key);
    }
  };
  const addResourceWrites = (resources: readonly ResourceKey<unknown>[] | undefined, mode: MutationMode = 'update'): void => {
    for (const resource of resources ?? []) {
      const key = resourceToken(resource);
      tokenLabels.set(key, `resource:${resource.name}`);
      writes.add(key);
      addWriteMode(mutationModes, key, mode);
      snapshotResources.add(resource);
    }
  };
  const addEventReads = (events: readonly string[] | undefined): void => {
    for (const event of events ?? []) {
      const key = eventToken(event);
      tokenLabels.set(key, `event:${event}`);
      conflictReads.add(key);
    }
  };

  for (const query of access.queries ?? []) {
    summarizeQuery(query, addComponentReads, addComponentWrites);
  }

  addComponentReads(access.reads?.components, true);
  addResourceReads(access.reads?.resources, true);
  addEventReads(access.reads?.events);

  addComponentWrites(access.writes?.components, access.writes?.mutationMode);
  addResourceWrites(access.writes?.resources, access.writes?.mutationMode);

  addResourceReads(access.resources?.read, true);
  addResourceWrites(access.resources?.write, access.resources?.mutationMode);
  addEventReads(access.events?.read);

  for (const bundle of access.bundles ?? []) {
    addComponentReads(bundle.reads, false);
    addComponentWrites(bundle.writes, bundle.mutationMode);
    maySpawn = maySpawn || bundle.spawns === true;
  }

  return {
    topoReads,
    conflictReads,
    writes,
    tokenLabels,
    mutationModes,
    snapshotComponents,
    snapshotResources,
    maySpawn,
    before: access.before ?? [],
    after: access.after ?? []
  };
}

function summarizeQuery(
  query: QueryAccess,
  addReads: (components: readonly ComponentType<unknown>[] | undefined, topology: boolean) => void,
  addWrites: (components: readonly ComponentType<unknown>[] | undefined, mode?: MutationMode) => void
): void {
  const role = query.role ?? 'work';
  const defaultReads = [...(query.all ?? []), ...(query.any ?? [])];
  const reads = query.read ?? defaultReads;
  addReads(reads, role === 'work');
  // none 是 guard/过滤条件，参与冲突判断，但默认不制造拓扑边，避免把 guard read 误判为数据流依赖。
  addReads(query.none, false);
  addWrites(query.write, query.mutationMode);
  addWrites(query.add, query.mutationMode);
  addWrites(query.remove, query.mutationMode ?? (query.remove && query.remove.length > 0 ? 'delete' : undefined));
}

function buildWaves(
  nodes: SystemNode[],
  outgoing: Map<SystemNode, Set<SystemNode>>,
  indegree: Map<SystemNode, number>,
  edgeReasons: Map<SystemNode, Map<SystemNode, Set<string>>>
): CompiledSchedule {
  const remaining = new Set(nodes);
  const order: SystemNode[] = [];
  const waves: SystemNode[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((node) => (indegree.get(node) ?? 0) === 0)
      .sort((a, b) => a.registered.order - b.registered.order);

    if (ready.length === 0) {
      const cycleNodes = [...remaining].sort((a, b) => a.registered.order - b.registered.order);
      const dependencyEdges = cycleNodes.flatMap((from) => [...(outgoing.get(from) ?? [])]
        .filter((to) => remaining.has(to))
        .map((to) => {
          const reasons = [...(edgeReasons.get(from)?.get(to) ?? [])].sort().join(',');
          return `${from.registered.system.name} -[${reasons || 'dependency'}]-> ${to.registered.system.name}`;
        }));
      throw new SchedulerDependencyCycleError(
        cycleNodes.map((node) => node.registered.system.name),
        dependencyEdges
      );
    }

    const wave: SystemNode[] = [];
    for (const candidate of ready) {
      if (wave.every((accepted) => !hasConflict(accepted.access, candidate.access))) {
        wave.push(candidate);
      }
    }

    waves.push(wave);
    for (const node of wave) {
      remaining.delete(node);
      order.push(node);
      for (const to of outgoing.get(node) ?? []) {
        indegree.set(to, (indegree.get(to) ?? 0) - 1);
      }
    }
  }

  return { order, waves };
}

function hasConflict(a: AccessSummary, b: AccessSummary): boolean {
  return (
    writeWriteConflict(a.mutationModes, b.mutationModes) ||
    writeReadConflict(a, b) ||
    writeReadConflict(b, a)
  );
}

function writeReadConflict(writer: AccessSummary, reader: AccessSummary): boolean {
  for (const [token, modes] of writer.mutationModes) {
    if (!reader.conflictReads.has(token)) continue;
    // create 只写本 wave 内新实体；lookup read 基于 wave 前 snapshot，看不到新实体，因此不冲突。
    // append 语义也是可合并写；真正需要看到 append 结果的 work read 会通过 topo edge 分到后续 wave。
    if (![...modes].every((mode) => mode === 'create' || mode === 'append')) return true;
  }
  return false;
}

function writeWriteConflict(a: WriteModeMap, b: WriteModeMap): boolean {
  for (const [token, aModes] of a) {
    const bModes = b.get(token);
    if (!bModes) continue;
    for (const left of aModes) {
      for (const right of bModes) {
        if (mutationModesConflict(left, right)) return true;
      }
    }
  }
  return false;
}

function mutationModesConflict(a: MutationMode, b: MutationMode): boolean {
  if (a === 'create' || b === 'create') return false;
  if (a === 'append' && b === 'append') return false;
  return true;
}

function addWriteMode(map: WriteModeMap, token: TokenKey, mode: MutationMode): void {
  let modes = map.get(token);
  if (!modes) {
    modes = new Set<MutationMode>();
    map.set(token, modes);
  }
  modes.add(mode);
}

function intersects<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return intersectionValues(a, b).length > 0;
}

function intersectionValues<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const values: T[] = [];
  for (const item of small) {
    if (large.has(item)) values.push(item);
  }
  return values;
}

function normalizeSchedulerFailure(error: unknown): Error {
  if (error instanceof SchedulerCompileError) return error;
  if (error instanceof Error) {
    return new SchedulerCompileError(`[ECS] scheduler failed: ${error.message}`, { cause: error });
  }
  return new SchedulerCompileError(`[ECS] scheduler failed: ${String(error)}`, { cause: error });
}

function componentToken(component: ComponentType<unknown>): TokenKey {
  return component.id;
}

function resourceToken(resource: ResourceKey<unknown>): TokenKey {
  return resource.id;
}

function eventToken(type: string): TokenKey {
  return `event:${type}`;
}

function snapshotFilter(access: AccessSummary): WorldSnapshotFilter {
  return {
    components: [...access.snapshotComponents],
    resources: [...access.snapshotResources]
  };
}

function scheduleSchedulerTask(callback: () => void): void {
  if (typeof setImmediate === 'function') {
    setImmediate(callback);
    return;
  }

  setTimeout(callback, 0);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => scheduleSchedulerTask(resolve));
}

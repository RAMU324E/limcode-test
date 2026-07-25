import type { Scheduler } from '../ecs/Scheduler';
import type { Entity, World } from '../ecs/types';
import { hydrateConversationDetail } from '../application/clientStateHydration';
import { evictConversationDetail } from '../application/conversationDetailEviction';
import { ClientSyncEventType } from '../world/clientSync/events';
import { AgentRun } from '../world/modules/agentRun/components';
import {
  Conversation,
  ConversationFullContextLoaded,
  ConversationTimeline,
  InFlight,
  LlmRequest,
  Message,
  Streaming,
  type InFlightData,
  type LlmRequestData,
  type MessageData
} from '../world/modules/chat/components';
import { LlmInvocation } from '../world/modules/llm/components';
import { ToolCall, ToolState } from '../world/modules/tools/components';
import type { CommittedConversationHead, PreparedProjectionBatch, StorageHead, TransitionPlan } from '../../shared/conversationReliability';
import type { ConversationId } from '../../shared/stableIds';
import type { DurableConversationFacts } from './domain/types';
import { factsToClientState } from './runtimeAuthorityStore';
import { CommittedConversationHeadsKey } from '../world/clientSync/resources';

/** Full authoritative projection swap; no durable fact is reconstructed from the live World. */
export class CommittedConversationWorldProjection implements PreparedProjectionBatch {
  public readonly scopes: readonly ConversationId[];
  public readonly expectedProjectionVersions: ReadonlyMap<ConversationId, number>;
  public readonly committedStorageHeads: ReadonlyMap<string, StorageHead> = new Map();
  public readonly touchedStableIds: readonly string[];
  private state: 'prepared' | 'committed' | 'discarded' = 'prepared';
  private readonly conversationHeads: Readonly<Record<string, CommittedConversationHead>>;

  public constructor(
    public readonly batchId: string,
    private readonly world: World,
    private readonly scheduler: Scheduler,
    private readonly facts: DurableConversationFacts,
    plan: TransitionPlan,
    baseStorageHeads: ReadonlyMap<string, StorageHead>
  ) {
    this.scopes = [...plan.scopes];
    this.conversationHeads = conversationHeadsFromPlan(plan, baseStorageHeads);
    this.expectedProjectionVersions = new Map(this.scopes.map((scope) => [scope, world.version()]));
    this.touchedStableIds = [...new Set([
      ...plan.generatedIds,
      ...plan.recordMutations.flatMap((mutation) => mutation.kind === 'remove_many' ? mutation.ids : [mutation.id])
    ])];
  }

  public async commitAtSchedulerSafePoint(): Promise<void> {
    this.requirePrepared();
    await this.applyCommittedState();
  }

  public async rehydrateCommittedState(): Promise<void> {
    await this.applyCommittedState();
  }

  public discard(): void {
    this.requirePrepared();
    this.state = 'discarded';
  }

  public currentState(): 'prepared' | 'committed' | 'discarded' { return this.state; }

  private async applyCommittedState(): Promise<void> {
    await this.scheduler.runAtSafePoint(async () => {
      await rehydrateCommittedFacts(this.world, this.facts);
      installCommittedConversationHeads(this.world, this.conversationHeads);
    });
    this.state = 'committed';
  }

  private requirePrepared(): void {
    if (this.state !== 'prepared') throw new Error(`Projection batch ${this.batchId} is ${this.state}.`);
  }
}

export class CommittedHeadOnlyWorldProjection implements PreparedProjectionBatch {
  public readonly scopes: readonly ConversationId[];
  public readonly expectedProjectionVersions: ReadonlyMap<ConversationId, number>;
  public readonly committedStorageHeads: ReadonlyMap<string, StorageHead> = new Map();
  public readonly touchedStableIds: readonly string[] = [];
  private state: 'prepared' | 'committed' | 'discarded' = 'prepared';
  private readonly conversationHeads: Readonly<Record<string, CommittedConversationHead>>;

  public constructor(
    public readonly batchId: string,
    private readonly world: World,
    private readonly scheduler: Scheduler,
    plan: TransitionPlan,
    baseStorageHeads: ReadonlyMap<string, StorageHead>
  ) {
    this.scopes = [...plan.scopes];
    this.conversationHeads = conversationHeadsFromPlan(plan, baseStorageHeads);
    this.expectedProjectionVersions = new Map(this.scopes.map((scope) => [scope, world.version()]));
  }

  public commitAtSchedulerSafePoint(): Promise<void> { return this.applyCommittedHeads(); }
  public rehydrateCommittedState(): Promise<void> { return this.applyCommittedHeads(); }
  public discard(): void { this.requirePrepared(); this.state = 'discarded'; }

  private async applyCommittedHeads(): Promise<void> {
    this.requirePrepared();
    await this.scheduler.runAtSafePoint(() => installCommittedConversationHeads(this.world, this.conversationHeads));
    this.state = 'committed';
  }

  private requirePrepared(): void {
    if (this.state !== 'prepared') throw new Error(`Projection batch ${this.batchId} is ${this.state}.`);
  }
}

export class CommittedMultiConversationWorldProjection implements PreparedProjectionBatch {
  public readonly scopes: readonly ConversationId[];
  public readonly expectedProjectionVersions: ReadonlyMap<ConversationId, number>;
  public readonly committedStorageHeads: ReadonlyMap<string, StorageHead> = new Map();
  public readonly touchedStableIds: readonly string[];
  private state: 'prepared' | 'committed' | 'discarded' = 'prepared';
  private readonly conversationHeads: Readonly<Record<string, CommittedConversationHead>>;

  public constructor(
    public readonly batchId: string,
    private readonly world: World,
    private readonly scheduler: Scheduler,
    private readonly facts: readonly DurableConversationFacts[],
    plan: TransitionPlan,
    baseStorageHeads: ReadonlyMap<string, StorageHead>
  ) {
    this.scopes = [...plan.scopes];
    this.conversationHeads = conversationHeadsFromPlan(plan, baseStorageHeads);
    this.expectedProjectionVersions = new Map(this.scopes.map((scope) => [scope, world.version()]));
    this.touchedStableIds = [...new Set([
      ...plan.generatedIds,
      ...plan.recordMutations.flatMap((mutation) => mutation.kind === 'remove_many' ? mutation.ids : [mutation.id])
    ])];
  }

  public async commitAtSchedulerSafePoint(): Promise<void> {
    this.requirePrepared();
    await this.applyCommittedState();
  }

  public async rehydrateCommittedState(): Promise<void> {
    await this.applyCommittedState();
  }

  public discard(): void { this.requirePrepared(); this.state = 'discarded'; }

  private async applyCommittedState(): Promise<void> {
    await this.scheduler.runAtSafePoint(async () => {
      for (const facts of [...this.facts].sort((left, right) => left.conversation.id.localeCompare(right.conversation.id))) {
        await rehydrateCommittedFacts(this.world, facts);
      }
      installCommittedConversationHeads(this.world, this.conversationHeads);
    });
    this.state = 'committed';
  }

  private requirePrepared(): void {
    if (this.state !== 'prepared') throw new Error(`Projection batch ${this.batchId} is ${this.state}.`);
  }
}

function conversationHeadsFromPlan(
  plan: TransitionPlan,
  baseStorageHeads: ReadonlyMap<string, StorageHead>
): Readonly<Record<string, CommittedConversationHead>> {
  const result: Record<string, CommittedConversationHead> = {};
  for (const conversationId of plan.scopes) {
    const base = [...baseStorageHeads.values()].find((head) => head.headKind === 'conversation-control' && head.conversationId === conversationId);
    const version = plan.nextVersions.find((candidate) => candidate.conversationId === conversationId)?.version;
    if (!base || version === undefined) throw new Error(`Projection HEAD input is incomplete for ${conversationId}.`);
    const patchNextSeq = plan.patches
      .filter((patch) => patch.conversationId === conversationId)
      .reduce((next, patch) => Math.max(next, patch.nextSeq), base.streamNextSeq);
    result[conversationId] = {
      conversationId,
      version,
      streamId: `conversation:${conversationId}:state`,
      patchNextSeq
    };
  }
  return result;
}

function installCommittedConversationHeads(world: World, heads: Readonly<Record<string, CommittedConversationHead>>): void {
  world.setResource(CommittedConversationHeadsKey, {
    ...world.getResource(CommittedConversationHeadsKey),
    ...heads
  });
}

export async function rehydrateCommittedFacts(world: World, facts: DurableConversationFacts): Promise<void> {
  const conversationId = facts.conversation.id;
  let conversation = world.entityByRecordId(Conversation, conversationId);
  const transientLlmRequests = conversation === undefined ? [] : captureTransientLlmRequests(world, conversation);
  if (conversation === undefined) {
    conversation = world.spawn();
    world.add(conversation, Conversation, {
      id: conversationId,
      title: facts.conversation.title,
      visibility: facts.conversation.visibility
    });
    world.add(conversation, ConversationTimeline, {
      createdAt: facts.conversation.createdAt,
      lastActivityAt: facts.conversation.lastActivityAt
    });
  } else {
    evictConversationDetail(world, conversation);
    const current = world.get(conversation, Conversation);
    if (current) {
      world.add(conversation, Conversation, {
        ...current,
        title: facts.conversation.title,
        visibility: facts.conversation.visibility
      });
      world.add(conversation, ConversationTimeline, {
        createdAt: facts.conversation.createdAt,
        lastActivityAt: facts.conversation.lastActivityAt
      });
    }
  }

  const hydrated = await hydrateConversationDetail(world, factsToClientState(facts), conversationId);
  if (!hydrated) throw new Error(`Committed conversation projection could not be hydrated: ${conversationId}`);
  restoreTransientLlmRequests(world, facts, conversation, transientLlmRequests);
  world.add(conversation, ConversationFullContextLoaded, { loadedAt: Date.now() });

  for (const run of facts.turns) {
    const entity = world.entityByRecordId(AgentRun, run.id);
    if (entity === undefined) throw new Error(`Committed Run is missing from projection: ${run.id}`);
  }

  for (const execution of facts.toolExecutions) {
    const operation = facts.operations.find((candidate) => candidate.id === execution.operationId);
    const attempt = operation ? facts.attempts.find((candidate) => candidate.operationId === operation.id && candidate.generation === operation.currentGeneration) : undefined;
    if (!operation || !attempt || (attempt.state !== 'pending' && attempt.state !== 'dispatched')) continue;
    if (!operation.kind.startsWith('tool.')) continue;
    const entity = world.entityByRecordId(ToolCall, execution.id);
    const state = entity === undefined ? undefined : world.get(entity, ToolState);
    if (entity === undefined || !state) throw new Error(`Committed ToolCall is missing from projection: ${execution.id}`);
    world.add(entity, ToolState, { ...state, reliableExecutionEpoch: { attemptId: attempt.id, generation: attempt.generation } });
    world.add(entity, InFlight, { kind: 'tool', startedAt: attempt.dispatchedAt ?? 0 });
  }

  world.enqueue({ type: ClientSyncEventType.Resync, payload: { conversationId } });
}

interface TransientLlmRequestSnapshot {
  entity: Entity;
  requestId: string;
  runId: string;
  modelMessageId: string;
  invocationId?: string;
  reliableStreamEpoch?: NonNullable<LlmRequestData['reliableStreamEpoch']>;
  inFlight?: InFlightData;
  streaming: boolean;
  message: MessageData;
}

function captureTransientLlmRequests(world: World, conversation: Entity): TransientLlmRequestSnapshot[] {
  const snapshots: TransientLlmRequestSnapshot[] = [];
  for (const entity of world.query(LlmRequest)) {
    const request = world.get(entity, LlmRequest);
    if (!request || request.conversation !== conversation) continue;
    const run = world.get(request.run, AgentRun);
    const message = world.get(request.modelMessage, Message);
    const invocation = request.invocation === undefined ? undefined : world.get(request.invocation, LlmInvocation);
    if (!run || !message) throw new Error(`Transient LLM Request ${request.id} has dangling projection references.`);
    snapshots.push({
      entity,
      requestId: request.id,
      runId: run.id,
      modelMessageId: message.id,
      ...(invocation ? { invocationId: invocation.id } : {}),
      ...(request.reliableStreamEpoch ? { reliableStreamEpoch: { ...request.reliableStreamEpoch } } : {}),
      ...(world.get(entity, InFlight) ? { inFlight: { ...world.get(entity, InFlight)! } } : {}),
      streaming: world.has(request.modelMessage, Streaming),
      message: JSON.parse(JSON.stringify(message)) as MessageData
    });
  }
  return snapshots;
}

function restoreTransientLlmRequests(
  world: World,
  facts: DurableConversationFacts,
  conversation: Entity,
  snapshots: readonly TransientLlmRequestSnapshot[]
): void {
  for (const snapshot of snapshots) {
    const request = facts.requests.find((candidate) => candidate.id === snapshot.requestId);
    const operation = request ? facts.operations.find((candidate) => candidate.id === request.operationId) : undefined;
    const attempt = operation
      ? facts.attempts.find((candidate) => candidate.operationId === operation.id
        && candidate.generation === operation.currentGeneration
        && (candidate.state === 'pending' || candidate.state === 'dispatched'))
      : undefined;
    const active = !!request && (request.state === 'pending' || request.state === 'streaming')
      && !!operation && (operation.state === 'pending' || operation.state === 'running') && !!attempt;
    if (!active) {
      world.despawn(snapshot.entity);
      continue;
    }

    if (!snapshot.reliableStreamEpoch
      || snapshot.reliableStreamEpoch.attemptId !== attempt!.id
      || snapshot.reliableStreamEpoch.generation !== attempt!.generation) {
      throw new Error(`Transient LLM Request ${snapshot.requestId} is bound to a stale durable Attempt.`);
    }
    const run = world.entityByRecordId(AgentRun, snapshot.runId);
    const modelMessage = world.entityByRecordId(Message, snapshot.modelMessageId);
    const invocation = snapshot.invocationId ? world.entityByRecordId(LlmInvocation, snapshot.invocationId) : undefined;
    if (run === undefined || modelMessage === undefined || (snapshot.invocationId && invocation === undefined)) {
      throw new Error(`Committed projection cannot rebind active LLM Request ${snapshot.requestId}.`);
    }
    world.add(snapshot.entity, LlmRequest, {
      id: snapshot.requestId,
      run,
      conversation,
      modelMessage,
      ...(invocation !== undefined ? { invocation } : {}),
      reliableStreamEpoch: { ...snapshot.reliableStreamEpoch }
    });
    if (snapshot.inFlight) world.add(snapshot.entity, InFlight, snapshot.inFlight);

    const durableMessage = facts.messages.find((candidate) => candidate.id === snapshot.modelMessageId);
    if (durableMessage?.status === 'streaming' && snapshot.message.status === 'streaming') {
      world.add(modelMessage, Message, JSON.parse(JSON.stringify(snapshot.message)) as MessageData);
      if (snapshot.streaming) world.add(modelMessage, Streaming, true);
    }
  }
}

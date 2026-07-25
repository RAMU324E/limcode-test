import type { ComponentType, WorldReader } from '../ecs/types';
import type { StorageCapability } from '../capabilities/types';
import { StorageStateContributorsKey } from '../world/storageProjection/resources';
import { projectStorageStateWithCache, type StorageContributorProjectionState } from '../world/storageProjection/projection';
import type { ClientState } from '../../shared/protocol';
import { createEmptyClientState } from '../../shared/clientStateSchema';
import { Agent, AgentConversationLink, AgentKind, AgentStatus, ConversationAgentSelection } from '../world/modules/agent/components';
import { Conversation, ConversationBranchLink, ConversationOriginLink, ConversationReuseLink } from '../world/modules/chat/components';
import { ConversationWorkflowSelection, ModelProfile, ModelProfileScopeLink, SystemPrompt, SystemPromptScopeLink, ToolPolicy, Workflow } from '../world/modules/workflow/components';
import { PlanReviewPolicy, PlanReviewPolicyScopeLink } from '../world/modules/plan/components';
import { ToolPolicyScopeLink } from '../world/modules/tools/components';
import { SkillPolicy, SkillPolicyScopeLink } from '../world/modules/skill/components';
import { RuntimeContext, RuntimeContextScopeLink } from '../world/modules/runtimeContext/components';
import { ConversationProjectLink, ProjectContext } from '../world/modules/project/components';
import { ConversationWorkEnvironmentLink, WorkEnvironment, WorkEnvironmentPolicy, WorkEnvironmentPolicyScopeLink } from '../world/modules/workEnvironment/components';
import { CheckpointPolicy, CheckpointPolicyScopeLink, ShadowRepository } from '../world/modules/checkpoint/components';

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

/**
 * Exact version gate for the independent-domain skeleton below. It intentionally excludes
 * Message/Streaming/ToolCall/AgentRun and other conversation-runtime facts: those are committed by
 * FileConversationTransactionBackend and must not schedule a full skeleton projection per delta.
 *
 * Entity identities referenced by a Link are immutable. Creating/repointing such a relation writes
 * the Link itself, so runtime source entities used only to resolve a cold id do not belong here.
 */
const SKELETON_PERSISTENCE_COMPONENTS: readonly ComponentType<unknown>[] = [
  Agent,
  AgentConversationLink,
  ConversationAgentSelection,
  AgentKind,
  AgentStatus,
  Conversation,
  ConversationReuseLink,
  ConversationBranchLink,
  ConversationOriginLink,
  Workflow,
  ToolPolicy,
  SystemPrompt,
  SystemPromptScopeLink,
  ModelProfile,
  ModelProfileScopeLink,
  ConversationWorkflowSelection,
  PlanReviewPolicy,
  PlanReviewPolicyScopeLink,
  ToolPolicyScopeLink,
  SkillPolicy,
  SkillPolicyScopeLink,
  RuntimeContext,
  RuntimeContextScopeLink,
  ProjectContext,
  ConversationProjectLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink,
  ConversationWorkEnvironmentLink,
  CheckpointPolicy,
  CheckpointPolicyScopeLink,
  ShadowRepository
];

/**
 * Persists only independent, non-conversation aggregate records and links.
 *
 * Conversation control/runtime/timeline/compression facts are committed exclusively by
 * FileConversationTransactionBackend. Run History and conversation history are derived read models
 * and therefore do not enter this writer.
 */
export class ClientStatePersistence {
  private enabled = false;
  private lastPersistedSkeletonJson = '';
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private persistInFlight = false;
  private persistPendingAfterInFlight = false;
  private readonly persistIdleWaiters: Array<() => void> = [];
  private projectionClock = '';
  private contributorStates: Record<string, StorageContributorProjectionState> = {};
  private lastProjectedState: ClientState | undefined;
  private lastAdmittedSkeletonClock = '';

  public constructor(
    private readonly world: WorldReader,
    private readonly storage: StorageCapability,
    private readonly debounceMs = DEFAULT_PERSIST_DEBOUNCE_MS
  ) {}

  public enable(): void { this.enabled = true; }

  /** Stops new debounce admission and waits for any active independent-domain write. */
  public async suspend(): Promise<void> {
    this.enabled = false;
    this.clearPersistTimer();
    this.persistPendingAfterInFlight = false;
    await this.waitForPersistIdle();
  }

  public rememberPersistedState(state: ClientState): void {
    this.lastPersistedSkeletonJson = JSON.stringify(skeletonPersistenceSlice(state));
    this.lastProjectedState = state;
    this.projectionClock = '';
    this.contributorStates = {};
    this.lastAdmittedSkeletonClock = skeletonPersistenceVersionClock(this.world);
  }

  /** Explicit mutation path: always performs one debounced equality check. */
  public queuePersist(): void {
    if (!this.enabled) return;
    this.lastAdmittedSkeletonClock = skeletonPersistenceVersionClock(this.world);
    this.schedulePersistCheck();
  }

  /** Scheduler path: transient conversation ticks are rejected before allocating a timer/projection. */
  public queuePersistIfSkeletonChanged(): void {
    if (!this.enabled) return;
    const clock = skeletonPersistenceVersionClock(this.world);
    if (clock === this.lastAdmittedSkeletonClock) return;
    this.lastAdmittedSkeletonClock = clock;
    this.schedulePersistCheck();
  }

  public async persistImmediately(options: {
    force?: boolean;
    ensurePersisted?: boolean;
    throwOnError?: boolean;
  } = {}): Promise<void> {
    this.clearPersistTimer();
    if (this.persistInFlight) {
      this.persistPendingAfterInFlight = true;
      await this.waitForPersistIdle();
      return this.persistImmediately(options);
    }

    const latest = this.projectLatestState();
    const latestState = latest?.state ?? this.lastProjectedState;
    if (!this.enabled || !latestState) return;
    const skeleton = skeletonPersistenceSlice(latestState);
    const skeletonJson = JSON.stringify(skeleton);
    if (!options.force && !options.ensurePersisted && skeletonJson === this.lastPersistedSkeletonJson) return;

    this.persistInFlight = true;
    try {
      await this.storage.saveClientStateSkeleton(skeleton);
      this.lastPersistedSkeletonJson = skeletonJson;
    } catch (error) {
      // Re-admit the current version on the next scheduler tick instead of permanently suppressing
      // retries merely because the failed version had already crossed the cheap gate.
      this.lastAdmittedSkeletonClock = '';
      console.error('[LimCode] Failed to persist independent client-state domains:', error);
      if (options.throwOnError) throw error;
    } finally {
      this.persistInFlight = false;
      this.resolvePersistIdleWaiters();
      if (this.persistPendingAfterInFlight) {
        this.persistPendingAfterInFlight = false;
        this.schedulePersistCheck();
      }
    }
  }

  private schedulePersistCheck(): void {
    if (this.persistTimer) return;
    if (this.persistInFlight) {
      this.persistPendingAfterInFlight = true;
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistImmediately();
    }, this.debounceMs);
  }

  private clearPersistTimer(): void {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
  }

  private waitForPersistIdle(): Promise<void> {
    if (!this.persistInFlight) return Promise.resolve();
    return new Promise((resolve) => this.persistIdleWaiters.push(resolve));
  }

  private resolvePersistIdleWaiters(): void {
    const waiters = this.persistIdleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  private projectLatestState(): { state: ClientState; changed: boolean } | undefined {
    const previousState = this.lastProjectedState;
    const registry = this.world.tryGetResource(StorageStateContributorsKey);
    if (!registry) return previousState ? { state: previousState, changed: false } : undefined;

    const projection = projectStorageStateWithCache(this.world, registry.list(), {
      projectionClock: this.projectionClock,
      contributorStates: this.contributorStates
    });
    this.projectionClock = projection.projectionClock;
    this.contributorStates = projection.contributorStates;
    this.lastProjectedState = projection.state;
    return { state: projection.state, changed: projection.changed };
  }
}

/**
 * Explicit allow-list: adding a new ClientState table never makes it durable through this writer by
 * accident. Conversation aggregates and all Run/timeline/compression tables remain empty.
 */
function skeletonPersistenceSlice(state: ClientState): ClientState {
  const skeleton = createEmptyClientState();
  skeleton.agents = state.agents;
  skeleton.agentConversationLinks = state.agentConversationLinks;
  skeleton.conversationAgentSelections = state.conversationAgentSelections;

  skeleton.workflows = state.workflows;
  skeleton.conversationWorkflowSelections = state.conversationWorkflowSelections;
  skeleton.planReviewPolicies = state.planReviewPolicies;
  skeleton.planReviewPolicyScopeLinks = state.planReviewPolicyScopeLinks.filter(notRunScoped);
  skeleton.toolPolicies = state.toolPolicies;
  skeleton.toolPolicyScopeLinks = state.toolPolicyScopeLinks.filter(notRunScoped);
  skeleton.skillPolicies = state.skillPolicies;
  skeleton.skillPolicyScopeLinks = state.skillPolicyScopeLinks.filter(notRunScoped);
  skeleton.systemPrompts = state.systemPrompts;
  skeleton.systemPromptScopeLinks = state.systemPromptScopeLinks.filter(notRunScoped);
  skeleton.runtimeContexts = state.runtimeContexts;
  skeleton.runtimeContextScopeLinks = state.runtimeContextScopeLinks.filter(notRunScoped);
  skeleton.modelProfiles = state.modelProfiles;
  skeleton.modelProfileScopeLinks = state.modelProfileScopeLinks.filter(notRunScoped);

  skeleton.conversationReuseLinks = state.conversationReuseLinks;
  skeleton.conversationBranchLinks = state.conversationBranchLinks;
  skeleton.conversationOriginLinks = state.conversationOriginLinks;
  skeleton.projectContexts = state.projectContexts;
  skeleton.conversationProjectLinks = state.conversationProjectLinks;

  skeleton.workEnvironments = state.workEnvironments;
  skeleton.workEnvironmentPolicies = state.workEnvironmentPolicies;
  skeleton.workEnvironmentPolicyScopeLinks = state.workEnvironmentPolicyScopeLinks.filter(notRunScoped);
  skeleton.conversationWorkEnvironmentLinks = state.conversationWorkEnvironmentLinks;

  skeleton.checkpointPolicies = state.checkpointPolicies;
  skeleton.checkpointPolicyScopeLinks = state.checkpointPolicyScopeLinks.filter(notRunScoped);
  skeleton.shadowRepositories = state.shadowRepositories;
  return skeleton;
}

function notRunScoped<TRecord extends { scopeKind: string }>(record: TRecord): boolean {
  return record.scopeKind !== 'run';
}

export function skeletonPersistenceVersionClock(world: WorldReader): string {
  return SKELETON_PERSISTENCE_COMPONENTS
    .map((component) => `${component.name}:${world.componentVersion(component)}`)
    .join('|');
}

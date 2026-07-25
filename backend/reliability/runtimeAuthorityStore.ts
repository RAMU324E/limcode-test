import * as fs from 'node:fs/promises';
import { createEmptyClientState, GENERIC_CLIENT_STATE_DIFF_TABLE_KEYS } from '../../shared/clientStateSchema';
import {
  SUBMIT_PLAN_TOOL_NAME,
  type AgentRunRecord,
  type ClientPatchOp,
  type ClientState,
  type MessageContent,
  type MessageRecord
} from '../../shared/protocol';
import { normalizeSubmitPlanToolRequest, submitPlanOutputFromResult } from '../../shared/planReview';
import { ANSWER_BRIDGE_LINKS_RESOURCE_KEY } from '../../shared/conversationReliability';
import type {
  DurableAggregateView,
  DurablePostimage,
  DurableViewSpec,
  JsonValue,
  PlannedPatchBatch,
  PreparedProjectionBatch,
  RecordMutation,
  RunGraphClosureMode,
  StorageHead,
  TransitionPlan
} from '../../shared/conversationReliability';
import type { AnswerBridgeId, AnswerSubmissionId, ConversationId, MessageId, MessageRevisionId, RunId } from '../../shared/stableIds';
import { conversationShardName } from '../capabilities/vscodeStorage/naming';
import { diffClientStateTables, diffUpsertRemove } from '../world/clientSync/diff';
import { canonicalSha256 } from './canonicalJson';
import { applyRecordMutation, cloneFacts, durableRecordId } from './domain/applyMutations';
import { validateDurableFactsGraph } from './domain/durableFactsValidator';
import { canonicalDurableRecordsEqual, isCanonicalSharedDurableFamily } from './domain/durableFamilySemantics';
import { emptyDurableConversationFacts } from './domain/facts';
import { validatePlannedConversationState } from './domain/handlers';
import type { DurableConversationFacts, DurableRecordFamily, MultiConversationDurableFacts } from './domain/types';
import { DurableFileSystem, sha256Bytes } from './fileDurability';
import type { CompiledFileTransition, FileCompileContext, FileTransactionAdapter } from './fileTransactionTypes';
import {
  StoragePathAuthorityRegistry,
  conversationControlHeadKey,
  storageHeadKey,
  storageResourceHeadKey
} from './storagePathAuthority';
import { compileAttachmentRecordPostimages } from './storageCompilers/attachmentCompiler';
import { compileAnswerBridgePostimages, loadAnswerBridgeRecords } from './storageCompilers/answerBridgeCompiler';
import { compileCompressionPostimages } from './storageCompilers/compressionCompiler';
import { compileInteractionPostimages } from './storageCompilers/interactionCompiler';
import { compileTurnControlPostimages } from './storageCompilers/turnControlCompiler';
import { compileTimelinePostimages } from './storageCompilers/timelineCompiler';
import { compileToolCallEventPostimages } from './storageCompilers/toolCallEventCompiler';
import { compileToolCallPostimages } from './storageCompilers/toolCallCompiler';
import { compileToolResultPostimages } from './storageCompilers/toolResultCompiler';
import { loadCanonicalCompressionState } from './compressionResource';
import { loadCanonicalInteractionState, type CanonicalInteractionState } from './interactionResource';
import { loadCanonicalTimelineState } from './timelineResource';
import { loadCanonicalTurnControlState, type CanonicalTurnControlState } from './turnControlResource';
import { loadCanonicalToolCallEvents } from './toolCallEventResource';
import { loadCanonicalToolCalls } from './toolCallResource';
import { loadCanonicalToolResultState } from './toolResultResource';
import {
  resolveRunGraphClosure as resolveCanonicalRunGraphClosure,
  type ResolvedRunGraphClosure,
  type RunGraphReadAccess
} from './runGraphClosureResolver';
const RUNTIME_FILE_NAME = 'runtime-authority.json';
export const ANSWER_BRIDGE_RESOURCE_KEY = ANSWER_BRIDGE_LINKS_RESOURCE_KEY;
const RUNTIME_SCHEMA_VERSION = 4;

interface RuntimeAuthorityFile {
  schemaVersion: typeof RUNTIME_SCHEMA_VERSION;
  conversationId: ConversationId;
  savedAt: string;
  facts: RuntimeOwnedFacts;
}

export interface AnswerBridgeLookupEntry {
  bridgeId: string;
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  ownerRunId: RunId;
  ownerGeneration: number;
  lifecycle: 'open' | 'closed' | 'cancelled';
  rowVersion: number;
}

export interface AnswerBridgeLookupProjection {
  bridges: AnswerBridgeLookupEntry[];
}

type TimelineOwnedFacts = Pick<DurableConversationFacts,
  | 'messages'
  | 'messageRevisions'
  | 'messageCurrentRevisionLinks'
  | 'projectContexts'
  | 'shadowRepositories'
  | 'conversationCheckpointRepositoryLinks'
  | 'checkpoints'
  | 'checkpointTimelineAnchors'
>;

type ToolCallOwnedFacts = Pick<DurableConversationFacts, 'toolCalls'>;
type ToolCallEventOwnedFacts = Pick<DurableConversationFacts, 'toolCallEvents'>;
type ToolResultOwnedFacts = Pick<DurableConversationFacts, 'toolResultArtifacts' | 'toolCallResultLinks'>;
type InteractionOwnedFacts = Pick<DurableConversationFacts, 'interactionRequests' | 'interactionOwnerLinks' | 'interactionResponses'>;
type TurnControlOwnedFacts = CanonicalTurnControlState;

type CompressionOwnedFacts = Pick<DurableConversationFacts,
  | 'compressionBlocks'
  | 'compressionBlockSourceLinks'
  | 'compressionContextVariants'
  | 'compressionBlockLlmInvocationLinks'
>;

const RUNTIME_FORBIDDEN_FACT_KEYS = [
  'messages',
  'messageRevisions',
  'messageCurrentRevisionLinks',
  'toolCalls',
  'toolCallEvents',
  'toolResultArtifacts',
  'toolCallResultLinks',
  'interactionRequests',
  'interactionOwnerLinks',
  'interactionResponses',
  'turns',
  'turnIntents',
  'turnIntentRevisions',
  'turnExecutionPresetRevisions',
  'pendingTurnInputs',
  'executionLeases',
  'authoritySnapshots',
  'authorityDerivationLinks',
  'runtimeInboxItems',
  'runtimeDeliveryLinks',
  'childTurnLinks',
  'messageTurnLinks',
  'projectContexts',
  'shadowRepositories',
  'conversationCheckpointRepositoryLinks',
  'checkpoints',
  'checkpointTimelineAnchors',
  'compressionBlocks',
  'compressionBlockSourceLinks',
  'compressionContextVariants',
  'compressionBlockLlmInvocationLinks',
  'answerBridges'
] as const;


type RuntimeOwnedFacts = Omit<DurableConversationFacts,
  | keyof TimelineOwnedFacts
  | keyof ToolCallOwnedFacts
  | keyof ToolCallEventOwnedFacts
  | keyof ToolResultOwnedFacts
  | keyof InteractionOwnedFacts
  | keyof TurnControlOwnedFacts
  | keyof CompressionOwnedFacts
  | 'answerBridges'
>;

export class DurableScopeIncompleteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DurableScopeIncompleteError';
  }
}

export interface RuntimeAuthorityReadAccess extends RunGraphReadAccess {
  loadFacts(conversationId: ConversationId): Promise<DurableConversationFacts>;
  readAnswerBridgeLookup(): Promise<AnswerBridgeLookupProjection>;
}

export interface RuntimeAuthorityAdapterOptions {
  files: DurableFileSystem;
  projectionFactory?: (
    next: readonly DurableConversationFacts[],
    plan: TransitionPlan,
    baseStorageHeads: ReadonlyMap<string, StorageHead>
  ) => PreparedProjectionBatch | undefined;
  afterCommit?(plan: TransitionPlan): void | Promise<void>;
}

/** Maps pure durable facts to the existing chunked timeline plus a small authoritative runtime file. */
export class RuntimeAuthorityAdapter implements FileTransactionAdapter {
  private readonly mergedCommandViews = new WeakMap<object, Map<ConversationId, DurableConversationFacts>>();
  private readonly validatedConversationIds = new Set<ConversationId>();
  private readonly committedFacts = new Map<ConversationId, { headGeneration: number; facts: DurableConversationFacts }>();
  private readonly preloadedFacts = new Map<ConversationId, DurableConversationFacts>();
  private readonly knownRuntimeConversationIds = new Set<ConversationId>();

  public constructor(private readonly options: RuntimeAuthorityAdapterOptions) {}

  public async load<TView>(spec: DurableViewSpec<TView>, heads: ReadonlyMap<string, StorageHead>): Promise<DurableAggregateView<TView>> {
    const scopes = [...new Set(spec.conversations)].sort();
    if (scopes.length === 0) throw new Error('RuntimeAuthorityAdapter requires at least one conversation scope.');
    if (!heads.has(storageResourceHeadKey(ANSWER_BRIDGE_LINKS_RESOURCE_KEY))) {
      throw new Error('RuntimeAuthorityAdapter requires the AnswerBridge link resource HEAD lease.');
    }
    const createMissing = new Set(spec.createMissingConversations ?? []);
    if ([...createMissing].some((conversationId) => !scopes.includes(conversationId))) {
      throw new Error('DurableViewSpec may only create conversations included in its requested scope.');
    }
    const conversationHeads = new Map(scopes.map((conversationId) => {
      const head = heads.get(conversationControlHeadKey(conversationId));
      if (!head || head.headKind !== 'conversation-control') throw new Error(`Conversation control HEAD is unavailable: ${conversationId}`);
      return [conversationId, head] as const;
    }));
    const facts = await Promise.all(scopes.map(async (conversationId) => {
      const head = conversationHeads.get(conversationId)!;
      const cached = this.committedFacts.get(conversationId);
      if (cached?.headGeneration === head.generation) return cached.facts;
      const preloaded = this.preloadedFacts.get(conversationId);
      if (preloaded) {
        this.preloadedFacts.delete(conversationId);
        this.committedFacts.set(conversationId, { headGeneration: head.generation, facts: preloaded });
        return preloaded;
      }
      const runtime = await this.readRuntime(conversationId);
      if (runtime) {
        const loaded = await this.loadCommittedFacts(conversationId, runtime);
        this.preloadedFacts.delete(conversationId);
        this.committedFacts.set(conversationId, { headGeneration: head.generation, facts: loaded });
        return loaded;
      }
      if (createMissing.has(conversationId)) return emptyDurableConversationFacts(conversationId);
      throw new Error(`Committed Conversation has no runtime authority file: ${conversationId}`);
    }));
    const baseVersions = new Map<ConversationId, number>();
    for (const conversationId of scopes) baseVersions.set(conversationId, conversationHeads.get(conversationId)!.controlVersion);
    if (facts.length > 1) validateScopedConversationStates(facts);
    const byConversation = new Map(facts.map((item) => [item.conversation.id, item] as const));
    const aggregateFacts: DurableConversationFacts | MultiConversationDurableFacts = spec.mergeConversationFacts
      ? mergeCommandFacts(byConversation, spec.aggregateRootConversationId ?? scopes[0])
      : facts.length === 1
        ? facts[0]
        : { kind: 'multi_conversation', byConversation: Object.fromEntries(facts.map((item) => [item.conversation.id, item])) };
    const closedRunGraphModes = normalizeRunGraphModes(spec.closedRunGraphModes);
    if (spec.closedRunGraphRoots?.length) validateClosedRunGraph(aggregateFacts, spec.closedRunGraphRoots, closedRunGraphModes);
    const result: DurableAggregateView<TView> = {
      scopes,
      baseVersions,
      storageHeads: heads,
      completeness: {
        timelineRanges: facts.map((item) => ({
          conversationId: item.conversation.id,
          startSeq: item.messages[0]?.seq ?? 0,
          endSeq: item.messages[item.messages.length - 1]?.seq ?? 0,
          throughTail: true
        })),
        closedRunGraphRoots: [...(spec.closedRunGraphRoots ?? [])],
        closedRunGraphModes,
        includedRelationFamilies: [...spec.relationFamilies],
        storageHeadKeys: [...heads.keys()]
      },
      facts: aggregateFacts as unknown as TView
    };
    if (spec.mergeConversationFacts) this.mergedCommandViews.set(result as object, new Map(byConversation));
    return result;
  }

  public async compile<TResult extends JsonValue>(
    view: DurableAggregateView<unknown>,
    plan: TransitionPlan<TResult>,
    context: FileCompileContext
  ): Promise<CompiledFileTransition<TResult>> {
    const currentById = this.mergedCommandViews.get(view as object) ?? factsByConversation(view.facts, plan.scopes);
    this.mergedCommandViews.delete(view as object);
    const { nextById, mutationsByConversation } = applyScopedMutations(currentById, plan);
    for (const facts of nextById.values()) compactTerminalEffectArtifacts(facts);
    const currentFacts = plan.scopes.map((conversationId) => requireConversationFacts(currentById, conversationId));
    const nextFacts = plan.scopes.map((conversationId) => requireConversationFacts(nextById, conversationId));
    validateScopedConversationStates(nextFacts);

    const committedCacheEntries = nextFacts.map((facts) => {
      const previousHead = view.storageHeads.get(conversationControlHeadKey(facts.conversation.id));
      if (!previousHead || previousHead.headKind !== 'conversation-control') {
        throw new Error(`Conversation control HEAD is unavailable while compiling ${facts.conversation.id}.`);
      }
      return { conversationId: facts.conversation.id, headGeneration: previousHead.generation + 1, facts };
    });

    const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
    for (const conversationId of plan.scopes) {
      const current = requireConversationFacts(currentById, conversationId);
      const next = requireConversationFacts(nextById, conversationId);
      const mutations = mutationsByConversation.get(conversationId) ?? [];
      if (canonicalSha256(projectRuntimeOwnedFacts(current)) !== canonicalSha256(projectRuntimeOwnedFacts(next))
        || !await this.readRuntime(conversationId)) {
        postimages.push(runtimePostimage(conversationId, projectRuntimeOwnedFacts(next), context.now));
      }
      postimages.push(...await compileToolCallPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileToolCallEventPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileToolResultPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileInteractionPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileTurnControlPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileTimelinePostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
      postimages.push(...await compileCompressionPostimages({
        files: this.options.files,
        conversationId,
        current,
        next,
        mutations,
        now: context.now
      }));
    }
    postimages.push(...await compileAttachmentRecordPostimages({
      files: this.options.files,
      nextFacts,
      now: context.now
    }));
    postimages.push(...await compileAnswerBridgePostimages({
      files: this.options.files,
      scopes: plan.scopes,
      currentFacts,
      nextFacts,
      mutations: plan.recordMutations,
      now: context.now
    }));
    assertUniqueCompiledTargets(postimages);

    return {
      postimages: postimages.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath)),
      postimageHeadKeys: classifyPostimageHeadKeys(postimages, plan.scopes),
      patches: authoritativeClientPatches(plan, currentById, nextById),
      projection: this.options.projectionFactory?.(nextFacts, plan, view.storageHeads),
      validate: () => validateScopedConversationStates(nextFacts),
      afterCommit: async () => {
        for (const entry of committedCacheEntries) {
          this.knownRuntimeConversationIds.add(entry.conversationId);
          this.preloadedFacts.delete(entry.conversationId);
          this.committedFacts.set(entry.conversationId, { headGeneration: entry.headGeneration, facts: entry.facts });
        }
        await this.options.afterCommit?.(plan);
      }
    };
  }



  /** Caller must hold the Conversation domain HEADs and AnswerBridge resource HEAD for this read. */
  public async loadCommittedFacts(conversationId: ConversationId, knownRuntime?: RuntimeAuthorityFile): Promise<DurableConversationFacts> {
    const runtime = knownRuntime ?? await this.readRuntime(conversationId);
    if (!runtime) throw new Error(`Committed Conversation has no runtime authority file: ${conversationId}`);
    const [timelineState, toolCalls, toolCallEvents, toolResults, interactionState, turnControlState, compressionState] = await Promise.all([
      loadCanonicalTimelineState(this.options.files, conversationId),
      loadCanonicalToolCalls(this.options.files, conversationId),
      loadCanonicalToolCallEvents(this.options.files, conversationId),
      loadCanonicalToolResultState(this.options.files, conversationId),
      loadCanonicalInteractionState(this.options.files, conversationId),
      loadCanonicalTurnControlState(this.options.files, conversationId),
      loadCanonicalCompressionState(this.options.files, conversationId)
    ]);
    const facts = mergeOwnedFacts(runtime.facts, timelineState, toolCalls, toolCallEvents, toolResults, interactionState, turnControlState, compressionState);
    facts.answerBridges = (await loadAnswerBridgeRecords(this.options.files))
      .filter((bridge) => bridge.sourceConversationId === conversationId);
    compactTerminalEffectArtifacts(facts);
    await resolveStreamCheckpointContents(facts, this.options.files);
    if (!this.validatedConversationIds.has(conversationId)) {
      validateScopedConversationStates([facts]);
      this.validatedConversationIds.add(conversationId);
    }
    this.knownRuntimeConversationIds.add(conversationId);
    this.preloadedFacts.set(conversationId, facts);
    return facts;
  }

  public hasKnownRuntime(conversationId: ConversationId): boolean {
    return this.knownRuntimeConversationIds.has(conversationId);
  }

  public async readRuntime(conversationId: ConversationId): Promise<RuntimeAuthorityFile | undefined> {
    const file = await this.options.files.readJson<RuntimeAuthorityFile>(runtimeRelativePath(conversationId));
    if (!file) return undefined;
    if (file.schemaVersion !== RUNTIME_SCHEMA_VERSION
      || file.conversationId !== conversationId
      || RUNTIME_FORBIDDEN_FACT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(file.facts, key))
      || !Array.isArray(file.facts?.runTerminations)
      || !Array.isArray(file.facts?.runContextPolicies)
      || !Array.isArray(file.facts?.runContextPolicyLinks)
      || !Array.isArray(file.facts?.modelContextProjections)
      || !Array.isArray(file.facts?.modelContextProjectionSourceLinks)
      || !Array.isArray(file.facts?.requestModelContextProjectionLinks)
      || !Array.isArray(file.facts?.compressionModelContextProjectionLinks)) {
      throw new Error(`Invalid runtime authority file: ${conversationId}`);
    }
    this.knownRuntimeConversationIds.add(conversationId);
    return file;
  }

  /** Discovers committed runtime authorities directly from their canonical runtime files. */
  public async listRuntimeConversationIds(): Promise<ConversationId[]> {
    const ids = new Set<ConversationId>();
    for (const relativePath of await this.options.files.listFilesRecursive('conversations/details')) {
      if (!relativePath.endsWith(`/${RUNTIME_FILE_NAME}`)) continue;
      const identity = await readRuntimeIdentity(this.options.files, relativePath);
      if (!identity || identity.schemaVersion !== RUNTIME_SCHEMA_VERSION || !identity.conversationId
        || runtimeRelativePath(identity.conversationId) !== relativePath) {
        throw new Error(`Invalid runtime authority discovery entry: ${relativePath}`);
      }
      if (ids.has(identity.conversationId)) throw new Error(`Duplicate runtime authority: ${identity.conversationId}`);
      ids.add(identity.conversationId);
      this.knownRuntimeConversationIds.add(identity.conversationId);
    }
    return [...ids].sort();
  }

  /** Startup validation of a HEAD-guarded AnswerBridge lookup projection. */
  public validateCrossScopeLinksForStartup(
    conversationIds: readonly ConversationId[],
    lookup: AnswerBridgeLookupProjection
  ): void {
    validateAnswerBridgeLookup(lookup);
    const conversations = new Set(conversationIds);
    for (const bridge of lookup.bridges) {
      if (!conversations.has(bridge.sourceConversationId) || !conversations.has(bridge.targetConversationId)) {
        throw new Error(`AnswerBridge ${bridge.bridgeId} references a conversation outside committed runtime authority.`);
      }
    }
  }

  public resolveForegroundRunGraphScope(
    rootConversationId: ConversationId,
    readAccess: RuntimeAuthorityReadAccess
  ): Promise<{ conversationIds: ConversationId[]; rootRunIds: RunId[] }> {
    return this.resolveRunGraphScope(rootConversationId, {}, readAccess);
  }

  public async resolveRunGraphScope(
    rootConversationId: ConversationId,
    options: { rootRunIds?: readonly RunId[]; includeBackground?: boolean },
    readAccess: RuntimeAuthorityReadAccess
  ): Promise<{ conversationIds: ConversationId[]; rootRunIds: RunId[] }> {
    const root = await readAccess.loadFacts(rootConversationId);
    const rootRunIds = options.rootRunIds
      ? [...new Set(options.rootRunIds)]
      : root.turns.filter((run) => run.phase !== 'terminal').map((run) => run.id);
    if (rootRunIds.length === 0) return { conversationIds: [rootConversationId], rootRunIds: [] };
    const closure = await this.resolveRunGraphClosure(rootConversationId, rootRunIds, options.includeBackground === true, readAccess);
    return { conversationIds: closure.conversationIds, rootRunIds };
  }

  public resolveRunGraphClosure(
    rootConversationId: ConversationId,
    rootRunIds: readonly RunId[],
    includeBackground: boolean,
    readAccess: RuntimeAuthorityReadAccess
  ): Promise<ResolvedRunGraphClosure> {
    return resolveCanonicalRunGraphClosure(
      rootRunIds.map((runId) => ({ conversationId: rootConversationId, runId })),
      { modes: includeBackground ? ['foreground', 'background'] : ['foreground'] },
      readAccess
    );
  }

  public async resolveAnswerBridge(
    bridgeId: string,
    readAnswerBridgeLookup: () => Promise<AnswerBridgeLookupProjection>
  ): Promise<AnswerBridgeLookupEntry | undefined> {
    const matches = (await readAnswerBridgeLookup()).bridges.filter((entry) => entry.bridgeId === bridgeId);
    if (matches.length > 1) throw new Error(`AnswerBridge lookup contains duplicate ownership: ${bridgeId}`);
    return matches[0];
  }

  /** Caller must hold the AnswerBridge resource HEAD; this method performs no independent locking. */
  public async readAnswerBridgeLookup(): Promise<AnswerBridgeLookupProjection> {
    const projection: AnswerBridgeLookupProjection = {
      bridges: (await loadAnswerBridgeRecords(this.options.files)).map((bridge) => ({
        bridgeId: bridge.id,
        sourceConversationId: bridge.sourceConversationId,
        targetConversationId: bridge.targetConversationId,
        ownerRunId: bridge.ownerRunId,
        ownerGeneration: bridge.ownerGeneration,
        lifecycle: bridge.lifecycle,
        rowVersion: bridge.rowVersion
      }))
    };
    validateAnswerBridgeLookup(projection);
    return projection;
  }

}

function mergeCommandFacts(
  factsById: ReadonlyMap<ConversationId, DurableConversationFacts>,
  rootConversationId: ConversationId
): DurableConversationFacts {
  const root = factsById.get(rootConversationId);
  if (!root) throw new DurableScopeIncompleteError(`Merged command view has no root conversation ${rootConversationId}.`);
  const merged = cloneFacts(root);
  for (const [conversationId, source] of [...factsById].sort(([left], [right]) => left.localeCompare(right))) {
    if (conversationId === rootConversationId) continue;
    for (const family of Object.keys(merged) as Array<keyof DurableConversationFacts>) {
      if (family === 'conversation' || !Array.isArray(merged[family])) continue;
      const durableFamily = family as DurableRecordFamily;
      const target = merged[family] as unknown as Array<Record<string, unknown>>;
      const additions = source[family] as unknown as Array<Record<string, unknown>>;
      const byId = new Map<string, Record<string, unknown>>();
      for (const record of target) {
        const id = durableRecordId(durableFamily, record);
        if (byId.has(id)) throw new Error(`Durable ${family}:${id} is duplicated within one conversation scope.`);
        byId.set(id, record);
      }
      const sourceIds = new Set<string>();
      for (const record of additions) {
        const id = durableRecordId(durableFamily, record);
        if (sourceIds.has(id)) throw new Error(`Durable ${family}:${id} is duplicated within one conversation scope.`);
        sourceIds.add(id);
        const existing = byId.get(id);
        if (existing) {
          if (!isCanonicalSharedDurableFamily(durableFamily)) {
            throw new Error(`Durable ${family}:${id} is owned by more than one conversation.`);
          }
          if (!canonicalDurableRecordsEqual(existing, record)) {
            throw new Error(`Durable shared ${family}:${id} has conflicting canonical content across conversations.`);
          }
          continue;
        }
        const cloned = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
        byId.set(id, cloned);
        target.push(cloned);
      }
    }
  }
  return merged;
}

function validateClosedRunGraph(
  facts: DurableConversationFacts | MultiConversationDurableFacts,
  rootRunIds: readonly RunId[],
  modes: readonly RunGraphClosureMode[]
): void {
  const merged = (() => {
    if (!isMultiConversationFacts(facts)) return facts;
    const values = Object.values(facts.byConversation);
    const first = values[0];
    if (!first) throw new DurableScopeIncompleteError('Closed Run graph view is empty.');
    return mergeCommandFacts(new Map(values.map((item) => [item.conversation.id, item])), first.conversation.id);
  })();
  const runs = new Set(merged.turns.map((run) => run.id));
  const includedModes = new Set(modes);
  const queue = [...new Set(rootRunIds)];
  const visited = new Set<RunId>();
  while (queue.length > 0) {
    const runId = queue.shift()!;
    if (visited.has(runId)) continue;
    if (!runs.has(runId)) throw new DurableScopeIncompleteError(`Closed Run graph root is absent from the leased view: ${runId}`);
    visited.add(runId);
    for (const child of merged.childTurnLinks.filter((link) => link.parentTurnId === runId && includedModes.has(link.mode as RunGraphClosureMode))) {
      if (!runs.has(child.childTurnId)) {
        throw new DurableScopeIncompleteError(`${child.mode} child Turn is outside the leased execution scope: ${child.childTurnId}`);
      }
      queue.push(child.childTurnId);
    }
  }
}

function normalizeRunGraphModes(modes: readonly RunGraphClosureMode[] | undefined): RunGraphClosureMode[] {
  const normalized = [...new Set<RunGraphClosureMode>(modes ?? ['foreground'])];
  if (normalized.length === 0) throw new DurableScopeIncompleteError('Closed Run graph must name at least one child-edge mode.');
  return normalized.sort();
}

function validateScopedConversationStates(facts: readonly DurableConversationFacts[]): void {
  if (facts.length === 0) throw new Error('Cannot validate an empty durable scope.');
  validateDurableFactsGraph(facts);
  if (facts.length === 1) {
    validatePlannedConversationState(facts[0]);
    return;
  }
  const byConversation = new Map(facts.map((item) => [item.conversation.id, item] as const));
  if (byConversation.size !== facts.length) throw new Error('Durable scope contains duplicate conversation identities.');
  validatePlannedConversationState(mergeCommandFacts(byConversation, facts[0].conversation.id));
}

function factsByConversation(value: unknown, scopes: readonly ConversationId[]): Map<ConversationId, DurableConversationFacts> {
  const result = new Map<ConversationId, DurableConversationFacts>();
  if (isMultiConversationFacts(value)) {
    for (const conversationId of scopes) {
      const facts = value.byConversation[conversationId];
      if (!facts) throw new Error(`Multi-scope durable view is missing conversation ${conversationId}.`);
      result.set(conversationId, facts);
    }
    return result;
  }
  const facts = value as DurableConversationFacts;
  if (scopes.length !== 1 || facts?.conversation?.id !== scopes[0]) throw new Error('Single-scope durable view does not match TransitionPlan scopes.');
  result.set(scopes[0], facts);
  return result;
}

function applyScopedMutations(
  currentById: ReadonlyMap<ConversationId, DurableConversationFacts>,
  plan: TransitionPlan
): {
  nextById: Map<ConversationId, DurableConversationFacts>;
  mutationsByConversation: Map<ConversationId, RecordMutation[]>;
} {
  const nextById = new Map([...currentById].map(([id, facts]) => [id, forkFacts(facts)]));
  const mutationsByConversation = new Map<ConversationId, RecordMutation[]>();
  for (const mutation of plan.recordMutations) {
    const scopedMutations = mutation.kind === 'remove_many'
      ? splitRemoveManyByOwner(mutation, currentById)
      : [[mutationOwner(mutation, mutation.kind === 'remove' ? currentById : nextById), mutation] as const];
    for (const [owner, scopedMutation] of scopedMutations) {
      if (!plan.scopes.includes(owner)) throw new Error(`Transition ${plan.transitionId} mutates conversation ${owner} outside its leased scope.`);
      const facts = requireConversationFacts(nextById, owner);
      applyRecordMutation(facts, scopedMutation);
      const mutations = mutationsByConversation.get(owner) ?? [];
      mutations.push(scopedMutation);
      mutationsByConversation.set(owner, mutations);
    }
  }
  return { nextById, mutationsByConversation };
}

/** Forks record tables while preserving immutable record identity for incremental projection. */
function forkFacts(facts: DurableConversationFacts): DurableConversationFacts {
  return Object.fromEntries(Object.entries(facts).map(([key, value]) => [
    key,
    Array.isArray(value) ? [...value] : value
  ])) as unknown as DurableConversationFacts;
}

function splitRemoveManyByOwner(
  mutation: Extract<RecordMutation, { kind: 'remove_many' }>,
  originalFactsById: ReadonlyMap<ConversationId, DurableConversationFacts>
): Array<readonly [ConversationId, RecordMutation]> {
  const grouped = new Map<ConversationId, string[]>();
  for (const id of mutation.ids) {
    const owner = ownerByRecord(mutation.family as DurableRecordFamily, id, originalFactsById);
    const ids = grouped.get(owner) ?? [];
    ids.push(id);
    grouped.set(owner, ids);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([owner, ids]) => [owner, { ...mutation, ids }] as const);
}

function mutationOwner(mutation: Exclude<RecordMutation, { kind: 'remove_many' }>, factsById: ReadonlyMap<ConversationId, DurableConversationFacts>): ConversationId {
  if (mutation.kind === 'remove') return ownerByRecord(mutation.family as DurableRecordFamily, mutation.id, factsById);
  const record = mutation.record as unknown as Record<string, unknown>;
  const family = mutation.family as DurableRecordFamily;
  if (family === 'conversation') return requireConversationId(record.id, mutation);
  const direct = stringField(record, 'conversationId');
  if (direct && factsById.has(direct as ConversationId)) return direct as ConversationId;
  if (family === 'answerBridges') {
    const source = stringField(record, 'sourceConversationId');
    if (source && factsById.has(source as ConversationId)) return source as ConversationId;
  }
  if (family === 'childTurnLinks') {
    const parent = stringField(record, 'parentConversationId');
    if (parent && factsById.has(parent as ConversationId)) return parent as ConversationId;
  }
  if (family === 'authorityDerivationLinks') {
    const child = stringField(record, 'childConversationId');
    if (child && factsById.has(child as ConversationId)) return child as ConversationId;
  }
  if (family === 'runtimeDeliveryLinks') {
    const destination = stringField(record, 'destinationConversationId');
    if (destination && factsById.has(destination as ConversationId)) return destination as ConversationId;
  }
  if (family === 'runtimeInboxItems') {
    const inboxItemId = stringField(record, 'id');
    if (!inboxItemId) throw new Error(`RuntimeInboxItem mutation ${mutation.id} has no identity.`);
    const owners = [...factsById].filter(([, facts]) => facts.runtimeDeliveryLinks.some((link) => link.inboxItemId === inboxItemId));
    if (owners.length !== 1) throw new Error(`RuntimeInboxItem ${inboxItemId} has ${owners.length} destination owners.`);
    return owners[0][0];
  }
  const runId = stringField(record, 'turnId') ?? stringField(record, 'runId') ?? stringField(record, 'ownerRunId') ?? stringField(record, 'parentRunId');
  if (runId) return ownerByRunId(runId, factsById);
  const bridgeId = stringField(record, 'bridgeId');
  if (bridgeId) return ownerByRecord('answerBridges', bridgeId, factsById);
  const operationId = stringField(record, 'operationId');
  if (operationId) return ownerByRecord('operations', operationId, factsById);
  const requestId = stringField(record, 'requestId');
  if (requestId) return ownerByRecord('requests', requestId, factsById);
  const projectionId = stringField(record, 'projectionId');
  if (projectionId) return ownerByRecord('modelContextProjections', projectionId, factsById);
  const messageId = stringField(record, 'messageId');
  if (messageId) return ownerByRecord('messages', messageId, factsById);
  const toolCallId = stringField(record, 'toolCallId');
  if (toolCallId) return ownerByRecord('toolCalls', toolCallId, factsById);
  const invocationId = stringField(record, 'invocationId');
  if (invocationId) return ownerByRecord('invocations', invocationId, factsById);
  const blockId = stringField(record, 'blockId');
  if (blockId) return ownerByRecord('compressionBlocks', blockId, factsById);
  const checkpointId = stringField(record, 'checkpointId');
  if (checkpointId) return ownerByRecord('checkpoints', checkpointId, factsById);
  const revisionId = stringField(record, 'revisionId');
  if (revisionId) return ownerByRecord('messageRevisions', revisionId, factsById);
  throw new Error(`Cannot prove conversation ownership for ${mutation.family}:${mutation.id}.`);
}

function ownerByRunId(runId: string, factsById: ReadonlyMap<ConversationId, DurableConversationFacts>): ConversationId {
  return ownerByRecord('turns', runId, factsById);
}

function ownerByRecord(family: DurableRecordFamily, id: string, factsById: ReadonlyMap<ConversationId, DurableConversationFacts>): ConversationId {
  const owners: ConversationId[] = [];
  for (const [conversationId, facts] of factsById) {
    if (family === 'conversation') {
      if (facts.conversation.id === id) owners.push(conversationId);
      continue;
    }
    const records = facts[family];
    if (!Array.isArray(records)) continue;
    if ((records as unknown as Array<Record<string, unknown>>).some((record) => durableRecordId(family, record) === id)) owners.push(conversationId);
  }
  if (owners.length !== 1) throw new Error(`Stable ownership for ${family}:${id} is ${owners.length === 0 ? 'missing' : 'ambiguous'}.`);
  return owners[0];
}

function requireConversationFacts(map: ReadonlyMap<ConversationId, DurableConversationFacts>, conversationId: ConversationId): DurableConversationFacts {
  const facts = map.get(conversationId);
  if (!facts) throw new Error(`Durable facts are unavailable for ${conversationId}.`);
  return facts;
}

function authoritativeClientPatches(
  plan: TransitionPlan,
  currentById: ReadonlyMap<ConversationId, DurableConversationFacts>,
  nextById: ReadonlyMap<ConversationId, DurableConversationFacts>
): PlannedPatchBatch[] {
  const previousStates = new Map<ConversationId, ClientState>();
  const nextStates = new Map<ConversationId, ClientState>();
  return plan.patches.map((batch) => {
    const previousFacts = requireConversationFacts(currentById, batch.conversationId);
    const nextFacts = requireConversationFacts(nextById, batch.conversationId);
    const previous = previousStates.get(batch.conversationId) ?? factsToClientState(previousFacts, { cloneRecords: false });
    const next = nextStates.get(batch.conversationId) ?? factsToClientState(nextFacts, { cloneRecords: false });
    previousStates.set(batch.conversationId, previous);
    nextStates.set(batch.conversationId, next);
    const operations: ClientPatchOp[] = [
      ...diffClientStateTables(previous, next, GENERIC_CLIENT_STATE_DIFF_TABLE_KEYS),
      ...diffUpsertRemove(
        previous.messages,
        next.messages,
        (message): ClientPatchOp => ({ kind: 'message.upsert', message }),
        (id): ClientPatchOp => ({ kind: 'message.remove', id })
      )
    ];
    const previousFences = new Map(previousFacts.terminalStreamFences.map((fence) => [fence.id, JSON.stringify(fence)]));
    const terminalStreamFences = nextFacts.terminalStreamFences
      .filter((fence) => previousFences.get(fence.id) !== JSON.stringify(fence))
      .map((fence) => ({ ...fence }));
    return {
      ...batch,
      ...(terminalStreamFences.length > 0 ? { terminalStreamFences } : {}),
      operations: operations.map((operation) => JSON.parse(JSON.stringify(operation)) as JsonValue)
    };
  });
}

function projectAuthorityBindings(state: ClientState, facts: DurableConversationFacts): void {
  for (const snapshot of facts.authoritySnapshots) {
    const authority = snapshot.authority;
    const toolPolicy = objectRecord(authority.toolPolicy);
    if (!toolPolicy || !Array.isArray(toolPolicy.allowedTools)) {
      throw new Error(`AuthoritySnapshot ${snapshot.id} has no projectable ToolPolicy.`);
    }
    const toolPolicyId = `authority-tool-policy:${snapshot.id}`;
    state.toolPolicies.push({
      ...(cloneValue(toolPolicy) as unknown as ClientState['toolPolicies'][number]),
      id: toolPolicyId,
      name: `Frozen Tool Policy ${snapshot.turnId}`
    });
    state.runToolPolicyLinks.push({
      id: `authority-run-tool-policy:${snapshot.turnId}`,
      runId: snapshot.turnId,
      toolPolicyId,
      role: 'active'
    });

    const systemPrompt = objectRecord(authority.systemPrompt);
    const systemPromptText = typeof systemPrompt?.text === 'string' ? systemPrompt.text : '';
    const systemPromptId = `authority-system-prompt:${snapshot.id}`;
    state.systemPrompts.push({ id: systemPromptId, name: `Frozen System Prompt ${snapshot.turnId}`, text: systemPromptText });
    state.runSystemPromptLinks.push({
      id: `authority-run-system-prompt:${snapshot.turnId}`,
      runId: snapshot.turnId,
      systemPromptId,
      role: 'active'
    });

    const model = objectRecord(authority.model);
    const profile = objectRecord(model?.profile);
    if (profile && typeof profile.model === 'string' && profile.model.trim()) {
      const modelProfileId = `authority-model-profile:${snapshot.id}`;
      state.modelProfiles.push({
        ...(cloneValue(profile) as unknown as ClientState['modelProfiles'][number]),
        id: modelProfileId,
        name: `Frozen Model Profile ${snapshot.turnId}`
      });
      state.runModelProfileLinks.push({
        id: `authority-run-model-profile:${snapshot.turnId}`,
        runId: snapshot.turnId,
        modelProfileId,
        role: 'active'
      });
    }

    const skillPolicy = objectRecord(authority.skillPolicy);
    if (skillPolicy) {
      const skillPolicyId = `authority-skill-policy:${snapshot.id}`;
      state.skillPolicies.push({
        ...(cloneValue(skillPolicy) as unknown as ClientState['skillPolicies'][number]),
        id: skillPolicyId,
        name: `Frozen Skill Policy ${snapshot.turnId}`
      });
      state.skillPolicyScopeLinks.push({
        id: `authority-run-skill-policy:${snapshot.turnId}`,
        scopeKind: 'run',
        scopeId: snapshot.turnId,
        skillPolicyId,
        role: 'active',
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt
      });
    }

    const approvalPolicy = objectRecord(authority.approvalPolicy);
    const planReview = objectRecord(approvalPolicy?.planReview);
    if (planReview && (planReview.mode === 'off' || planReview.mode === 'before_mutation')) {
      const policyId = `authority-plan-review:${snapshot.id}`;
      state.planReviewPolicies.push({
        ...(cloneValue(planReview) as unknown as ClientState['planReviewPolicies'][number]),
        id: policyId,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt
      });
      state.planReviewPolicyScopeLinks.push({
        id: `authority-run-plan-review:${snapshot.turnId}`,
        scopeKind: 'run',
        scopeId: snapshot.turnId,
        planReviewPolicyId: policyId,
        role: 'active',
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt
      });
    }

    const runtimeContext = objectRecord(authority.runtimeContext);
    const runtimeText = typeof runtimeContext?.text === 'string' ? runtimeContext.text : '';
    const runtimeSnapshotId = `authority-runtime-context:${snapshot.id}`;
    state.runtimeContextSnapshots.push({
      id: runtimeSnapshotId,
      name: `Frozen Runtime Context ${snapshot.turnId}`,
      text: runtimeText,
      template: runtimeText,
      conversationId: snapshot.conversationId,
      sourceHash: canonicalSha256(authority.runtimeContext),
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
      refreshedAt: snapshot.createdAt
    });
    state.runRuntimeContextSnapshotLinks.push({
      id: `authority-run-runtime-context:${snapshot.turnId}`,
      runId: snapshot.turnId,
      runtimeContextSnapshotId: runtimeSnapshotId,
      role: 'context',
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt
    });

    const workflow = objectRecord(authority.workflow);
    if (typeof workflow?.id === 'string' && workflow.id !== 'none') {
      state.runWorkflowLinks.push({
        id: `authority-run-workflow:${snapshot.turnId}`,
        runId: snapshot.turnId,
        workflowId: workflow.id,
        role: 'active'
      });
    }
    const workEnvironment = objectRecord(authority.workEnvironment);
    if (typeof workEnvironment?.activeId === 'string' && workEnvironment.activeId) {
      state.runWorkEnvironmentLinks.push({
        id: `authority-run-work-environment:${snapshot.turnId}`,
        runId: snapshot.turnId,
        workEnvironmentId: workEnvironment.activeId,
        role: 'active',
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt
      });
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireConversationId(value: unknown, mutation: RecordMutation): ConversationId {
  if (typeof value !== 'string' || !value) throw new Error(`Conversation mutation ${mutation.kind} has no conversation ID.`);
  return value as ConversationId;
}

function isMultiConversationFacts(value: unknown): value is MultiConversationDurableFacts {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as { kind?: unknown }).kind === 'multi_conversation';
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function factsToClientState(
  facts: DurableConversationFacts,
  options: { cloneRecords?: boolean } = {}
): ClientState {
  const copy = <T>(value: T): T => options.cloneRecords === false ? value : cloneValue(value);
  const state = createEmptyClientState();
  state.conversations = [{
    id: facts.conversation.id,
    title: facts.conversation.title,
    visibility: facts.conversation.visibility,
    createdAt: facts.conversation.createdAt,
    lastActivityAt: facts.conversation.lastActivityAt
  }];
  state.messages = copy(facts.messages);
  state.messageRevisions = copy(facts.messageRevisions);
  state.messageCurrentRevisionLinks = copy(facts.messageCurrentRevisionLinks);
  state.toolCalls = copy(facts.toolCalls);
  state.toolCallEvents = copy(facts.toolCallEvents);
  state.toolResultArtifacts = facts.toolResultArtifacts.map((artifact) => {
    const { modelResponse: _modelResponse, ...clientArtifact } = artifact;
    return copy(clientArtifact);
  });
  state.toolCallResultLinks = copy(facts.toolCallResultLinks);
  state.interactionRequests = copy(facts.interactionRequests);
  state.interactionOwnerLinks = copy(facts.interactionOwnerLinks);
  state.interactionResponses = copy(facts.interactionResponses);
  for (const tool of facts.toolCalls.filter((candidate) => candidate.name === SUBMIT_PLAN_TOOL_NAME)) {
    const request = normalizeSubmitPlanToolRequest(tool.args);
    const proposalId = `plan-proposal:${tool.id}`;
    const finalLink = facts.toolCallResultLinks.find((link) => link.toolCallId === tool.id && link.role === 'final');
    const finalArtifact = finalLink ? facts.toolResultArtifacts.find((artifact) => artifact.id === finalLink.artifactId) : undefined;
    const output = submitPlanOutputFromResult(finalArtifact?.inlineContent ?? finalArtifact?.modelResponse);
    state.planProposals.push({
      id: proposalId,
      body: request.plan,
      ...(request.taskList ? { taskList: cloneValue(request.taskList) } : {}),
      status: output?.status ?? (tool.status === 'error' ? 'rejected' : 'pending'),
      createdAt: tool.createdAt,
      updatedAt: tool.updatedAt
    });
    const runLink = facts.toolRunLinks.find((candidate) => candidate.toolCallId === tool.id);
    if (runLink) {
      state.runPlanProposalLinks.push({
        id: `run-plan-proposal:${runLink.runId}:${proposalId}`,
        runId: runLink.runId,
        planProposalId: proposalId,
        role: 'active',
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt
      });
    }
  }
  state.projectContexts = copy(facts.projectContexts);
  state.shadowRepositories = copy(facts.shadowRepositories);
  state.conversationCheckpointRepositoryLinks = copy(facts.conversationCheckpointRepositoryLinks);
  state.checkpoints = copy(facts.checkpoints);
  state.checkpointTimelineAnchors = copy(facts.checkpointTimelineAnchors);
  state.compressionBlocks = copy(facts.compressionBlocks);
  state.compressionBlockSourceLinks = copy(facts.compressionBlockSourceLinks);
  state.compressionContextVariants = copy(facts.compressionContextVariants);
  state.compressionBlockLlmInvocationLinks = copy(facts.compressionBlockLlmInvocationLinks);
  state.runCompressionBlockLinks = copy(facts.runCompressionBlockLinks);
  state.agentRuns = facts.turns.map((run): AgentRunRecord => ({
    id: run.id,
    kind: 'chat',
    status: projectedRunStatus(run.lifecycle, run.phase),
    lifecycle: run.lifecycle,
    phase: run.phase,
    rowVersion: run.rowVersion,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    retryOfRunId: run.retryOfRunId,
    outcomeUnknownOperations: facts.pauses
      .filter((pause) => pause.runId === run.id && pause.reason === 'outcome_unknown')
      .map((pause) => ({
        operationId: pause.operationId,
        reason: 'outcome_unknown' as const,
        allowedResolutions: [...pause.allowedResolutions],
        createdAt: pause.createdAt
      }))
  }));
  state.turns = copy(facts.turns);
  state.turnIntents = copy(facts.turnIntents);
  state.turnIntentRevisions = copy(facts.turnIntentRevisions);
  state.pendingTurnInputs = copy(facts.pendingTurnInputs);
  state.executionLeases = copy(facts.executionLeases);
  state.authoritySnapshots = copy(facts.authoritySnapshots);
  projectAuthorityBindings(state, facts);
  state.runtimeDeliveryLinks = copy(facts.runtimeDeliveryLinks);
  state.modelContextProjections = copy(facts.modelContextProjections);
  state.modelContextProjectionSourceLinks = copy(facts.modelContextProjectionSourceLinks);
  state.requestModelContextProjectionLinks = copy(facts.requestModelContextProjectionLinks);
  state.compressionModelContextProjectionLinks = copy(facts.compressionModelContextProjectionLinks);
  state.runTerminations = copy(facts.runTerminations);
  state.agentRunSourceLinks = facts.runSources.map((source) => ({ ...source }));
  state.agentRunTargetLinks = facts.runTargets.map((target) => ({ ...target }));
  for (const bridge of facts.answerBridges) {
    if (!bridge.currentSubmissionId) continue;
    const submission = requireMatching(facts.answerSubmissions, (candidate) => candidate.id === bridge.currentSubmissionId, `AnswerBridge ${bridge.id} current submission`);
    const payload = requireMatching(facts.answerPayloads, (candidate) => candidate.id === submission.payloadRef, `AnswerSubmission ${submission.id} payload`);
    const child = facts.childTurnLinks.find((candidate) => candidate.answerBridgeId === bridge.id && candidate.parentTurnId === bridge.ownerRunId);
    const target = facts.runTargets.find((candidate) => candidate.runId === bridge.ownerRunId && candidate.role === 'executor');
    const submissionInboxIds = new Set(facts.runtimeInboxItems
      .filter((item) => runtimeInboxSubmissionId(item.payload) === submission.id)
      .map((item) => item.id));
    const updatedAt = facts.runtimeDeliveryLinks
      .filter((delivery) => submissionInboxIds.has(delivery.inboxItemId))
      .reduce((latest, delivery) => Math.max(latest, delivery.updatedAt), submission.createdAt);
    state.agentAnswers.push({
      id: bridge.id,
      submissionId: submission.id,
      title: payload.title,
      content: payload.content,
      createdAt: submission.createdAt,
      updatedAt
    });
    state.agentAnswerSubmissionLinks.push({
      id: `agent-answer-submission:${bridge.id}:${submission.id}`,
      answerId: bridge.id,
      ...(child ? { submitterRunId: child.childTurnId } : {}),
      submitterConversationId: bridge.targetConversationId,
      createdAt: submission.createdAt,
      updatedAt
    });
    state.agentAnswerTargetLinks.push({
      id: `agent-answer-target:${bridge.id}:${submission.id}`,
      answerId: bridge.id,
      targetRunId: bridge.ownerRunId,
      ...(target ? { targetAgentId: target.agentId } : {}),
      targetConversationId: bridge.sourceConversationId,
      ...(child?.sourceToolCallId ? { sourceToolCallId: child.sourceToolCallId } : {}),
      createdAt: submission.createdAt,
      updatedAt
    });
  }
  const slot = optionalMatching(
    facts.executionLeases,
    (candidate) => candidate.conversationId === facts.conversation.id && candidate.state !== 'released',
    'Conversation execution lease'
  );
  const slotRunId = slot?.turnId;
  const slotTarget = slotRunId
    ? requireMatching(facts.runTargets, (target) => target.runId === slotRunId && target.role === 'executor', `Run ${slotRunId} executor target`)
    : undefined;
  const targetAgentIds = [...new Set(facts.runTargets
    .filter((target) => target.conversationId === facts.conversation.id && target.role === 'executor')
    .map((target) => target.agentId))];
  const selectedAgentId = slotTarget?.agentId ?? (targetAgentIds.length === 1 ? targetAgentIds[0] : undefined);
  if (selectedAgentId) {
    const selectedRun = slotRunId
      ? requireMatching(facts.turns, (run) => run.id === slotRunId, `Selected Run ${slotRunId}`)
      : facts.turns.reduce<(typeof facts.turns)[number] | undefined>(
          (latest, run) => !latest || run.updatedAt > latest.updatedAt || (run.updatedAt === latest.updatedAt && run.id > latest.id) ? run : latest,
          undefined
        );
    if (!selectedRun) throw new Error(`Selected Agent ${selectedAgentId} has no owning Run.`);
    const at = selectedRun.updatedAt;
    state.agentConversationLinks = [{
      id: `agent-conversation:${selectedAgentId}:${facts.conversation.id}`,
      agentId: selectedAgentId,
      conversationId: facts.conversation.id,
      role: 'default'
    }];
    state.conversationAgentSelections = [{
      id: `conversation-agent-selection:${facts.conversation.id}`,
      conversationId: facts.conversation.id,
      agentId: selectedAgentId,
      role: 'active',
      createdAt: at,
      updatedAt: at
    }];
  }
  state.messageTurnLinks = facts.messageTurnLinks.map((link) => ({ ...link }));
  state.toolCallRunLinks = facts.toolRunLinks.map((link) => ({ ...link }));
  state.agentRunInputRevisions = facts.inputRevisions.map((input) => ({ id: input.id, runId: input.runId, conversationId: input.conversationId, revisionId: input.revisionId }));

  state.runConversationPolicies = facts.turns.map((run) => ({
    id: `run-conversation-policy:${run.id}`,
    mode: 'same_conversation',
    conversationId: run.conversationId,
    visibility: facts.conversation.visibility
  }));
  state.runContextPolicies = facts.runContextPolicies.map(({ conversationId: _conversationId, ...policy }) => copy(policy));
  state.runDeliveryPolicies = facts.turns.map((run) => ({ id: `run-delivery-policy:${run.id}`, mode: 'direct_reply', includeTranscript: 'summary' }));
  state.runEditPolicies = facts.turns.map((run) => ({ id: `run-edit-policy:${run.id}`, onSourceEdited: 'mark_stale', onNewUserMessageWhileRunning: 'queue_next_run' }));
  state.runConversationPolicyLinks = facts.turns.map((run) => ({ id: `run-conversation-policy-link:${run.id}`, runId: run.id, policyId: `run-conversation-policy:${run.id}`, role: 'active' }));
  state.runContextPolicyLinks = copy(facts.runContextPolicyLinks);
  state.runDeliveryPolicyLinks = facts.turns.map((run) => ({ id: `run-delivery-policy-link:${run.id}`, runId: run.id, policyId: `run-delivery-policy:${run.id}`, role: 'active' }));
  state.runEditPolicyLinks = facts.turns.map((run) => ({ id: `run-edit-policy-link:${run.id}`, runId: run.id, policyId: `run-edit-policy:${run.id}`, role: 'active' }));

  state.llmInvocations = facts.invocations.map((invocation) => ({
    id: invocation.id,
    requestId: invocation.requestId,
    status: invocation.status === 'interrupted' ? 'cancelled' : invocation.status,
    ...(invocation.settings ? { settings: copy(invocation.settings) } : {}),
    createdAt: invocation.createdAt,
    ...(invocation.resolvedAt !== undefined ? { resolvedAt: invocation.resolvedAt } : {}),
    ...(invocation.startedAt !== undefined ? { startedAt: invocation.startedAt } : {}),
    ...(invocation.completedAt !== undefined ? { completedAt: invocation.completedAt } : {}),
    ...(invocation.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: invocation.streamOutputDurationMs } : {}),
    ...(invocation.usageMetadata ? { usageMetadata: copy(invocation.usageMetadata) } : {}),
    ...(invocation.error ? { error: invocation.error } : {})
  }));
  state.runLlmInvocationLinks = facts.invocations.map((invocation) => ({
    id: `run-invocation:${invocation.runId}:${invocation.id}`,
    runId: invocation.runId,
    invocationId: invocation.id,
    role: 'primary',
    createdAt: invocation.createdAt,
    updatedAt: invocation.completedAt ?? invocation.startedAt ?? invocation.resolvedAt ?? invocation.createdAt
  }));
  state.messageLlmInvocationLinks = facts.invocations.flatMap((invocation) => {
    const request = facts.requests.find((candidate) => candidate.invocationId === invocation.id
      && (!invocation.requestId || candidate.id === invocation.requestId));
    const modelMessageId = request?.modelMessageId;
    return modelMessageId ? [{
      id: `message-invocation:${modelMessageId}:${invocation.id}`,
      messageId: modelMessageId,
      invocationId: invocation.id,
      role: 'modelOutput' as const,
      createdAt: invocation.createdAt,
      updatedAt: invocation.completedAt ?? invocation.startedAt ?? invocation.resolvedAt ?? invocation.createdAt
    }] : [];
  });
  return state;
}

export function projectRuntimeOwnedFacts(facts: DurableConversationFacts): RuntimeOwnedFacts {
  const {
    messages: _messages,
    messageRevisions: _messageRevisions,
    messageCurrentRevisionLinks: _messageCurrentRevisionLinks,
    toolCalls: _toolCalls,
    toolCallEvents: _toolCallEvents,
    toolResultArtifacts: _toolResultArtifacts,
    toolCallResultLinks: _toolCallResultLinks,
    interactionRequests: _interactionRequests,
    interactionOwnerLinks: _interactionOwnerLinks,
    interactionResponses: _interactionResponses,
    turns: _turns,
    turnIntents: _turnIntents,
    turnIntentRevisions: _turnIntentRevisions,
    turnExecutionPresetRevisions: _turnExecutionPresetRevisions,
    pendingTurnInputs: _pendingTurnInputs,
    executionLeases: _executionLeases,
    authoritySnapshots: _authoritySnapshots,
    authorityDerivationLinks: _authorityDerivationLinks,
    runtimeInboxItems: _runtimeInboxItems,
    runtimeDeliveryLinks: _runtimeDeliveryLinks,
    childTurnLinks: _childTurnLinks,
    messageTurnLinks: _messageTurnLinks,
    projectContexts: _projectContexts,
    shadowRepositories: _shadowRepositories,
    conversationCheckpointRepositoryLinks: _conversationCheckpointRepositoryLinks,
    checkpoints: _checkpoints,
    checkpointTimelineAnchors: _checkpointTimelineAnchors,
    compressionBlocks: _compressionBlocks,
    compressionBlockSourceLinks: _compressionBlockSourceLinks,
    compressionContextVariants: _compressionContextVariants,
    compressionBlockLlmInvocationLinks: _compressionBlockLlmInvocationLinks,
    answerBridges: _answerBridges,
    ...owned
  } = facts;
  return {
    ...owned,
    streamCheckpointHeads: owned.streamCheckpointHeads.map(({ resolvedContent: _resolvedContent, ...head }) => head)
  } as RuntimeOwnedFacts;
}

/** Primary-effect payloads are recovery state, not an append-only execution transcript. */
function compactTerminalEffectArtifacts(facts: DurableConversationFacts): void {
  const recoverableOperations = new Map(facts.operations
    .filter((operation) => operation.state === 'pending' || operation.state === 'running' || operation.state === 'outcome_unknown')
    .map((operation) => [operation.id, operation] as const));
  const currentAttempts = new Map(facts.attempts
    .filter((attempt) => recoverableOperations.get(attempt.operationId)?.currentGeneration === attempt.generation)
    .map((attempt) => [attempt.id, attempt] as const));
  facts.primaryEffects = facts.primaryEffects.flatMap((effect) => {
    const operation = recoverableOperations.get(effect.operationId);
    if (!operation || effect.generation !== operation.currentGeneration) return [];
    const attempt = currentAttempts.get(effect.attemptId);
    if (effect.kind === 'llm.request' && attempt?.state === 'dispatched' && effect.payloadRef.kind !== 'released') {
      return [{ ...effect, payloadRef: { ...effect.payloadRef, kind: 'released' as const } }];
    }
    return [effect];
  });
  const referencedPayloadIds = new Set(facts.primaryEffects
    .filter((effect) => effect.payloadRef.kind !== 'released')
    .map((effect) => effect.payloadRef.id));
  facts.effectPayloads = facts.effectPayloads.filter((payload) => referencedPayloadIds.has(payload.id));
}

function mergeOwnedFacts(
  runtime: RuntimeOwnedFacts,
  timeline: ClientState,
  toolCalls: ToolCallOwnedFacts['toolCalls'],
  toolCallEvents: ToolCallEventOwnedFacts['toolCallEvents'],
  toolResults: { artifacts: ToolResultOwnedFacts['toolResultArtifacts']; links: ToolResultOwnedFacts['toolCallResultLinks'] },
  interactions: CanonicalInteractionState,
  turnControl: TurnControlOwnedFacts,
  detail: ClientState
): DurableConversationFacts {
  const facts = emptyDurableConversationFacts(runtime.conversation.id);
  Object.assign(facts, runtime);
  copyTimelineFacts(facts, timeline);
  facts.toolCalls = JSON.parse(JSON.stringify(toolCalls));
  facts.toolCallEvents = JSON.parse(JSON.stringify(toolCallEvents));
  facts.toolResultArtifacts = JSON.parse(JSON.stringify(toolResults.artifacts));
  facts.toolCallResultLinks = JSON.parse(JSON.stringify(toolResults.links));
  facts.interactionRequests = JSON.parse(JSON.stringify(interactions.interactionRequests));
  facts.interactionOwnerLinks = JSON.parse(JSON.stringify(interactions.interactionOwnerLinks));
  facts.interactionResponses = JSON.parse(JSON.stringify(interactions.interactionResponses));
  Object.assign(facts, JSON.parse(JSON.stringify(turnControl)) as TurnControlOwnedFacts);
  copyCompressionFacts(facts, detail);
  return facts;
}

interface ImmutableStreamCheckpoint {
  requestId: string;
  attemptId: string;
  generation: number;
  streamSeq: number;
  content: MessageContent;
  toolCalls: JsonValue[];
}

async function resolveStreamCheckpointContents(facts: DurableConversationFacts, files: DurableFileSystem): Promise<void> {
  for (const head of facts.streamCheckpointHeads) {
    const snapshot = await files.readJson<ImmutableStreamCheckpoint>(head.file);
    if (!snapshot
      || snapshot.requestId !== head.requestId
      || snapshot.attemptId !== head.attemptId
      || snapshot.generation !== head.generation
      || snapshot.streamSeq !== head.streamSeq
      || snapshot.content?.role !== 'model'
      || !Array.isArray(snapshot.content.parts)
      || !Array.isArray(snapshot.toolCalls)
      || canonicalSha256(snapshot) !== head.payloadHash) {
      throw new Error(`Committed stream checkpoint is missing or corrupt: ${head.id}`);
    }
    head.resolvedContent = JSON.parse(JSON.stringify(snapshot.content)) as MessageContent;
  }
}

function copyTimelineFacts(target: DurableConversationFacts, state: ClientState): void {
  target.messages = JSON.parse(JSON.stringify(state.messages)) as MessageRecord[];
  target.messageRevisions = JSON.parse(JSON.stringify(state.messageRevisions));
  target.messageCurrentRevisionLinks = JSON.parse(JSON.stringify(state.messageCurrentRevisionLinks));
  target.projectContexts = JSON.parse(JSON.stringify(state.projectContexts));
  target.shadowRepositories = JSON.parse(JSON.stringify(state.shadowRepositories));
  target.conversationCheckpointRepositoryLinks = JSON.parse(JSON.stringify(state.conversationCheckpointRepositoryLinks));
  target.checkpoints = JSON.parse(JSON.stringify(state.checkpoints));
  target.checkpointTimelineAnchors = JSON.parse(JSON.stringify(state.checkpointTimelineAnchors));
}

function copyCompressionFacts(target: DurableConversationFacts, state: ClientState): void {
  target.compressionBlocks = JSON.parse(JSON.stringify(state.compressionBlocks));
  target.compressionBlockSourceLinks = JSON.parse(JSON.stringify(state.compressionBlockSourceLinks));
  target.compressionContextVariants = JSON.parse(JSON.stringify(state.compressionContextVariants));
  target.compressionBlockLlmInvocationLinks = JSON.parse(JSON.stringify(state.compressionBlockLlmInvocationLinks));
}


function runtimeFileBytes(conversationId: ConversationId, facts: RuntimeOwnedFacts, now: number): Buffer {
  if (!Number.isFinite(now)) throw new Error(`Runtime compiler timestamp is invalid: ${now}`);
  return Buffer.from(`${JSON.stringify({
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    conversationId,
    savedAt: new Date(now).toISOString(),
    facts
  } satisfies RuntimeAuthorityFile)}\n`, 'utf8');
}

function runtimePostimage(
  conversationId: ConversationId,
  facts: RuntimeOwnedFacts,
  now: number
): Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'> {
  const bytes = runtimeFileBytes(conversationId, facts, now);
  return {
    operation: 'write',
    targetRelativePath: runtimeRelativePath(conversationId),
    postimageHash: sha256Bytes(bytes),
    bytes
  };
}


function validateAnswerBridgeLookup(projection: AnswerBridgeLookupProjection): void {
  if (!Array.isArray(projection.bridges)) throw new Error('AnswerBridge lookup projection is invalid.');
  const seen = new Set<string>();
  for (const bridge of projection.bridges) {
    if (!bridge.bridgeId || !bridge.sourceConversationId || !bridge.targetConversationId || !bridge.ownerRunId) {
      throw new Error('AnswerBridge lookup projection contains an incomplete entry.');
    }
    if (seen.has(bridge.bridgeId)) throw new Error(`AnswerBridge lookup projection contains duplicate ${bridge.bridgeId}.`);
    seen.add(bridge.bridgeId);
  }
}

function assertUniqueCompiledTargets(
  postimages: readonly Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>[]
): void {
  const targets = new Set<string>();
  for (const postimage of postimages) {
    if (targets.has(postimage.targetRelativePath)) throw new Error(`Storage compilers produced a duplicate target: ${postimage.targetRelativePath}`);
    targets.add(postimage.targetRelativePath);
  }
}

function classifyPostimageHeadKeys(
  postimages: readonly Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>[],
  scopes: readonly ConversationId[],
  explicitTargetHeadKeys: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  const registry = new StoragePathAuthorityRegistry(scopes);
  const result: Record<string, string> = {};
  for (const postimage of postimages) {
    const authority = registry.requireClassified(postimage.targetRelativePath);
    if (authority.durabilityClass !== 'authoritative-mutable' || !authority.owner) {
      throw new Error(`Compiler produced a non-authoritative business postimage: ${postimage.targetRelativePath} (${authority.durabilityClass}).`);
    }
    const registered = storageHeadKey(authority.owner);
    const explicit = explicitTargetHeadKeys[postimage.targetRelativePath];
    if (explicit && explicit !== registered) {
      throw new Error(`Explicit Storage HEAD owner disagrees with the registry: ${postimage.targetRelativePath}.`);
    }
    result[postimage.targetRelativePath] = registered;
  }
  return result;
}

async function readRuntimeIdentity(
  files: DurableFileSystem,
  relativePath: string
): Promise<{ schemaVersion: number; conversationId: ConversationId } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(files.resolve(relativePath), 'r');
    const prefix = Buffer.allocUnsafe(4096);
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    const text = prefix.subarray(0, bytesRead).toString('utf8');
    const schema = /"schemaVersion"\s*:\s*(\d+)/.exec(text);
    const conversation = /"conversationId"\s*:\s*"([^"]+)"/.exec(text);
    if (!schema || !conversation) return undefined;
    return { schemaVersion: Number(schema[1]), conversationId: conversation[1] as ConversationId };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function runtimeRelativePath(conversationId: ConversationId): string {
  return `conversations/details/${conversationShardName(conversationId)}/${RUNTIME_FILE_NAME}`;
}

function projectedRunStatus(lifecycle: import('../../shared/runLifecycle').RunLifecycleStatus, phase: import('../../shared/runLifecycle').RunExecutionPhase): AgentRunRecord['status'] {
  if (lifecycle !== 'active' && lifecycle !== 'queued') return lifecycle;
  switch (phase) {
    case 'queued': return 'queued';
    case 'loading_context':
    case 'waiting_compression':
    case 'resolving_invocation':
    case 'waiting_checkpoint_before_llm':
    case 'llm_request_pending': return 'preparing';
    case 'llm_streaming': return 'running';
    case 'waiting_tools': return 'waiting_tool';
    case 'waiting_child_run': return 'waiting_child_run';
    case 'delivering':
    case 'waiting_checkpoint_after_llm': return 'delivering';
    case 'paused':
    case 'waiting_user':
    case 'waiting_plan_review': return 'paused';
    case 'terminal': return lifecycle === 'queued' || lifecycle === 'active' ? 'interrupted' : lifecycle;
  }
}

function runtimeInboxSubmissionId(payload: unknown): string | undefined {
  const record = objectRecord(payload);
  return record && typeof record.submissionId === 'string' ? record.submissionId : undefined;
}

function optionalMatching<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(`${label} is ambiguous; found ${matches.length} records.`);
  return matches[0];
}

function requireMatching<T>(records: readonly T[], predicate: (record: T) => boolean, label: string): T {
  const match = optionalMatching(records, predicate, label);
  if (!match) throw new Error(`${label} is missing.`);
  return match;
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

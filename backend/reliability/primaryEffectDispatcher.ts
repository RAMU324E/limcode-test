import type { RuntimeEnv } from '../application/RuntimeEnv';
import type { Scheduler } from '../ecs/Scheduler';
import type { World, WorldEvent } from '../ecs/types';
import {
  ASK_USER_TOOL_NAME,
  BridgeMessageType,
  READ_AGENT_ANSWER_TOOL_NAME,
  SUBMIT_AGENT_ANSWER_TOOL_NAME,
  conversationClientStateStreamId,
  createMessageId,
  isFunctionResponsePart,
  isTextPart,
  type CheckpointRecord,
  type ContentPart,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageContent,
  type ToolConfigRecord,
  type WorkEnvironmentRecord
} from '../../shared/protocol';
import { CHECKPOINT_FEATURE_ENABLED } from '../../shared/featureFlags';
import {
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
  TOOL_RESULT_BLOBS_RESOURCE_KEY,
  type AttemptRecord,
  type CleanupHint,
  type InternalCommandEnvelope,
  type JsonValue,
  type PrimaryEffectDescriptor
} from '../../shared/conversationReliability';
import type {
  AttemptId,
  CallbackEventId,
  ConversationId,
  InvocationId,
  OperationId,
  RequestId,
  RunId,
  ToolCallId
} from '../../shared/stableIds';
import { Agent, AgentKind, AgentStatus } from '../world/modules/agent/components';
import { AgentRun } from '../world/modules/agentRun/components';
import { modelContextTurnFactsFromWorld } from '../world/modules/agentRun/modelContextWorldFacts';
import {
  backgroundProcessDeliverySourceKey,
  type BackgroundProcessDeliveryEnvelope
} from '../capabilities/backgroundProcessTypes';
import { Conversation, InFlight, LlmRequest, Message, Streaming } from '../world/modules/chat/components';
import { OpenConversationPanelIdsKey } from '../world/modules/chat/resources';
import { buildLlmStartRequestForRun } from '../world/modules/chat/llmRequestPlanning';
import { LlmInvocation } from '../world/modules/llm/components';
import {
  LlmEventType,
  type LlmCompactDonePayload,
  type LlmCompactErrorPayload,
  type LlmDeltaPayload,
  type LlmDonePayload,
  type LlmErrorPayload,
  type LlmInvocationResolvedPayload,
  type LlmInvocationResolveErrorPayload,
  type LlmRetryPayload,
  type LlmStartedPayload,
  type LlmThoughtDeltaPayload,
  type LlmThoughtDonePayload,
  type LlmThoughtProgressPayload,
  type LlmToolCallPayload
} from '../world/modules/llm/events';
import type { LlmResolveInvocationRequest, LlmStartRequest } from '../world/modules/llm/contracts';
import { ToolCall } from '../world/modules/tools/components';
import { ToolEventType, type ToolStatePayload } from '../world/modules/tools/events';
import { toolSchedulingDecisionForCall } from '../world/modules/tools/scheduling';
import {
  planReliableChildAgentRun,
  planReliableToolExecution,
  type ReliableChildContinuationTarget
} from '../world/modules/tools/reliablePlanning';
import type { ToolResultOut, ToolRuntimeEvent } from '../world/modules/tools/registry';
import { canonicalSha256 } from './canonicalJson';
import {
  modelResponseForToolResult,
  prepareToolResultContent,
  type PreparedToolResultContent
} from './toolResultPayload';
import { projectModelContext } from '../modelContext/modelContextProjector';
import { buildModelContextProjectionCommitData } from '../modelContext/projectionRecords';
import { canonicalFunctionCallId } from '../modelContext/toolCallIdentity';
import type { ModelContextProjection } from '../modelContext/types';
import { modelContextFactsFromDurable } from './modelContextDurableFacts';
import { createSubmitPlanToolOutput } from '../../shared/planReview';
import { BACKGROUND_ASK_USER_AUTO_ANSWER } from '../../shared/askUser';
import {
  ResolveInteractionCommandHandler,
  interactionResolutionIds,
  type ResolveInteractionCommandPayload
} from './domain/interactionHandlers';
import { uniqueInteractionOwner } from './domain/interactionState';
import { DurableFileSystem, jsonBytes } from './fileDurability';
import { FileConversationTransactionBackend } from './fileConversationTransactionBackend';
import { ANSWER_BRIDGE_RESOURCE_KEY, DurableScopeIncompleteError, RuntimeAuthorityAdapter } from './runtimeAuthorityStore';
import { RuntimeStableIdFactory, stableIdFromSeed } from './stableIdFactory';
import { LogicalScopeExecutor } from './logicalScopeExecutor';
import { normalizeBackgroundProcessCompletionPayload } from './domain/backgroundProcessPayload';
import {
  AdmitTurnIntentHandler,
  BackgroundProcessExitNotificationHandler,
  CommitStreamCheckpointHandler,
  CompleteCheckpointBarrierHandler,
  CompleteCompressionBarrierHandler,
  CompleteContextBuildHandler,
  CompleteContextLoadHandler,
  CompleteInvocationResolveHandler,
  CompleteLlmRequestHandler,
  CompletePostLlmCheckpointHandler,
  CompleteToolOperationBatchHandler,
  committedReadView,
  FailInvocationResolveHandler,
  fullView,
  MarkAttemptBatchDispatchedHandler,
  MarkLlmStartedHandler,
  policyNumber,
  RejectDispatchedAttemptHandler,
  RestartReconciliationHandler,
  WatchdogTimeoutHandler,
  type AdmitTurnIntentPayload,
  type BackgroundProcessExitNotificationPayload,
  type CheckpointBarrierCallbackPayload,
  type CompressionBarrierCallbackPayload,
  type ContextLoadedPayload,
  type ContextRequestBuiltPayload,
  type DispatchAttemptBatchPayload,
  type InvocationResolveFailedPayload,
  type InvocationResolvedPayload,
  type LlmFinalCallbackPayload,
  type LlmStartedCallbackPayload,
  type PlannedToolCall,
  type PostLlmCheckpointCallbackPayload,
  type RejectDispatchedAttemptPayload,
  type StreamCheckpointPayload,
  type ToolCompletedBatchCallbackPayload,
  type ToolCompletedCallbackPayload,
  type WatchdogPayload
} from './domain/internalHandlers';
import {
  ForegroundChildWaitElapsedHandler,
  InterruptChildRunsHandler,
  OpenAnswerBridgeHandler,
  SubmitAnswerHandler,
  type ForegroundChildWaitElapsedPayload,
  type InterruptChildRunsPayload,
  type OpenAnswerBridgePayload,
  type SubmitAnswerPayload
} from './domain/answerDeliveryHandlers';
import type { DurableConversationFacts } from './domain/types';
import {
  ReconcileRuntimeDeliveryHandler,
  RecordChildTerminalInboxHandler,
  type ReconcileRuntimeDeliveryPayload,
  type RecordChildTerminalPayload
} from './domain/runtimeInboxHandlers';
import { pendingRuntimeDeliveries } from './domain/runtimeInbox';
import { contextPolicyForRun, runContextPolicyId } from './domain/runContextPolicy';
import {
  CompleteStandaloneCompressionHandler,
  StartAutoCompressionHandler,
  type CompleteStandaloneCompressionPayload,
  type StartAutoCompressionPayload
} from './domain/conversationMaintenanceHandlers';
import { matchCurrentAttempt, primaryEffectKinds } from './domain/operationStateMachine';
import { isConversationOperationOwner } from './domain/operationOwner';
import type { ReliableBarrierEffectPayload, ReliableContextBuildInput } from './domain/preflightTypes';
import { isReliableBarrierEffectPayload } from './domain/preflightTypes';
import { dispatchableToolOperationIds } from './domain/toolSchedule';
import { resolveAnswerBridgeChildOwnership } from './domain/childRunOwnership';
import { runGraphCascadeForPolicy } from './domain/cancellationIntent';
import { normalizeRuntimeCleanupPayload } from './domain/runtimeCleanup';
import { CompleteRuntimeCleanupHandler, type CompleteRuntimeCleanupPayload } from './domain/runtimeCleanupHandlers';
import { planReliableCheckpointBarrier, planReliableLlmPreflight } from './llmPreflightPlanner';
import {
  inspectReliablePostResponseAutoCompression,
  planReliablePostResponseAutoCompression
} from './reliableAutoCompressionPlanner';
import { discoverOrphanedAttachmentBlobTargets } from './attachmentResource';
import { discoverOrphanedToolResultBlobTargets } from './toolResultResource';
import { RuntimeLeaseRegistry } from './runtimeLeaseRegistry';
import { fileChangeResolutionPayload, hydrateFileChangeResolutionPayload, isAutomaticFileChangeInteractionDue } from './interactionResolution';
import { compileChildTurnAuthorityProfile } from './authorityCompiler';
import { projectClientState } from '../world/clientSync/projection';
import { ClientStateContributorsKey } from '../world/clientSync/resources';

const SCAN_INTERVAL_MS = 1_000;
const STREAM_CHECKPOINT_DELTA_INTERVAL = 32;
const STREAM_CHECKPOINT_MIN_CHARS = 64 * 1024;
const STREAM_CHECKPOINT_ROOT = 'operations/stream-checkpoints';
const STREAM_CHECKPOINT_GC_INTERVAL_MS = 5 * 60_000;
const MANAGED_ATTACHMENT_GC_INTERVAL_MS = 5 * 60_000;
const TOOL_RESULT_BLOB_GC_INTERVAL_MS = 5 * 60_000;
const SLOW_TOOL_PHASE_LOG_THRESHOLD_MS = 250;
const TOOL_COMPLETION_COALESCE_MS = 8;

export interface PrimaryEffectDispatcherOptions {
  backend: FileConversationTransactionBackend;
  adapter: RuntimeAuthorityAdapter;
  files: DurableFileSystem;
  world: World;
  scheduler: Scheduler;
  env: RuntimeEnv;
  conversationIds(): Iterable<string>;
  ensureConversationLoaded(conversationId: string): Promise<void>;
  prepareConversationOwnership(conversationId: ConversationId): Promise<void>;
  adoptCommittedConversation(conversationId: ConversationId): Promise<void>;
  cleanupCheckpointGarbage?(): void;
  onCommitted?(conversationIds: readonly ConversationId[]): void;
  onIntegrityError?(conversationId: string, error: unknown): void;
}

interface PendingToolCompletion {
  payload: ToolCompletedCallbackPayload;
  preparedResult: PreparedToolResultContent;
  ownerRunId?: RunId;
  resolve(): void;
  reject(error: unknown): void;
}

interface ToolToModelPreparationTiming {
  conversationId: ConversationId;
  runId: RunId;
  toolCallIds: ToolCallId[];
  toolsCompletedAt: number;
  finalizationCommittedAt: number;
}

interface ActiveEffect {
  facts: DurableConversationFacts;
  attempt: AttemptRecord;
  descriptor: PrimaryEffectDescriptor;
  payload: JsonValue;
}

interface AttemptToken {
  conversationId: ConversationId;
  ownerKind: 'run' | 'conversation';
  ownerRunId?: RunId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
  kind: string;
}

interface BufferedToolCall {
  functionCallId?: string;
  name: string;
  argsJson: string;
  thoughtSignature?: string;
}

interface LlmStreamPipelineTiming {
  callbackEventCount: number;
  callbackQueueDelayTotalMs: number;
  callbackQueueDelayMaxMs: number;
  firstCallbackReceivedAt?: number;
  lastCallbackHandledAt?: number;
  transientWorldEnqueueCount: number;
}

interface LlmStreamBuffer {
  token: AttemptToken;
  requestId: RequestId;
  invocationId?: InvocationId;
  content: MessageContent;
  toolCalls: BufferedToolCall[];
  streamSeq: number;
  deltaCountSinceCheckpoint: number;
  checkpointChars: number;
  lastCheckpointChars: number;
  startedAt?: number;
  lastCheckpointAt: number;
  pipelineTiming?: LlmStreamPipelineTiming;
}

/**
 * Level-triggered dispatcher for committed PrimaryEffectDescriptor records.
 * It never crosses an external boundary until Attempt=dispatched is storage_committed.
 */
export class PrimaryEffectDispatcher {
  private readonly ids = new RuntimeStableIdFactory();
  private readonly inFlight = new Set<string>();
  private readonly crossingBoundary = new Set<string>();
  private readonly callbackQueues = new Map<string, Promise<void>>();
  private readonly toolCompletionQueues = new Map<ConversationId, PendingToolCompletion[]>();
  private readonly toolCompletionFlushes = new Map<ConversationId, Promise<void>>();
  private readonly toolToModelPreparationTimings = new Map<RunId, ToolToModelPreparationTiming>();
  private readonly emittedChildTerminalKeys = new Set<string>();
  private readonly effectTasks = new Set<Promise<void>>();
  private readonly scanTasks = new Set<Promise<void>>();
  private readonly streamCheckpointTasks = new Set<Promise<void>>();
  private readonly streamCheckpointFileExecutor = new LogicalScopeExecutor();
  private readonly streams = new Map<string, LlmStreamBuffer>();
  private readonly toolControllers = new Map<string, AbortController>();
  private readonly compressionRequests = new Map<string, string>();
  private readonly runtimeLeases = new RuntimeLeaseRegistry();
  private lastStreamCheckpointGcAt = 0;
  private lastManagedAttachmentGcAt = 0;
  private managedAttachmentGcRequested = true;
  private lastToolResultBlobGcAt = 0;
  private toolResultBlobGcRequested = true;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private scanRequested = false;
  private scanAllRequested = false;
  private readonly scanConversationIds = new Set<ConversationId>();
  private scanning = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  private readonly dispatchBatchHandler = new MarkAttemptBatchDispatchedHandler();
  private readonly queueAdmissionHandler = new AdmitTurnIntentHandler();
  private readonly backgroundProcessExitHandler = new BackgroundProcessExitNotificationHandler();
  private readonly runtimeDeliveryReconcileHandler = new ReconcileRuntimeDeliveryHandler();
  private readonly childTerminalInboxHandler = new RecordChildTerminalInboxHandler();
  private readonly contextLoadedHandler = new CompleteContextLoadHandler();
  private readonly compressionBarrierHandler = new CompleteCompressionBarrierHandler();
  private readonly standaloneCompressionHandler = new CompleteStandaloneCompressionHandler();
  private readonly autoCompressionHandler = new StartAutoCompressionHandler();
  private readonly checkpointBarrierHandler = new CompleteCheckpointBarrierHandler();
  private readonly postLlmCheckpointHandler = new CompletePostLlmCheckpointHandler();
  private readonly invocationResolvedHandler = new CompleteInvocationResolveHandler();
  private readonly invocationFailedHandler = new FailInvocationResolveHandler();
  private readonly contextBuiltHandler = new CompleteContextBuildHandler();
  private readonly llmStartedHandler = new MarkLlmStartedHandler();
  private readonly llmFinalHandler = new CompleteLlmRequestHandler();
  private readonly toolFinalBatchHandler = new CompleteToolOperationBatchHandler();
  private readonly checkpointHandler = new CommitStreamCheckpointHandler();
  private readonly watchdogHandler = new WatchdogTimeoutHandler();
  private readonly restartHandler = new RestartReconciliationHandler();
  private readonly rejectedAttemptHandler = new RejectDispatchedAttemptHandler();
  private readonly openBridgeHandler = new OpenAnswerBridgeHandler();
  private readonly interruptChildHandler = new InterruptChildRunsHandler();
  private readonly submitAnswerHandler = new SubmitAnswerHandler();
  private readonly foregroundWaitElapsedHandler = new ForegroundChildWaitElapsedHandler();
  private readonly resolveInteractionHandler = new ResolveInteractionCommandHandler();
  private readonly completeRuntimeCleanupHandler = new CompleteRuntimeCleanupHandler();

  public constructor(private readonly options: PrimaryEffectDispatcherOptions) {}

  public start(): void {
    if (this.disposed) throw new Error('PrimaryEffectDispatcher is disposed.');
    this.wake();
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.runtimeLeases.abortAll('dispatcher_disposed');
    for (const controller of this.toolControllers.values()) controller.abort();
    for (const requestId of new Set([
      ...[...this.streams.values()].map((buffer) => buffer.requestId),
      ...this.compressionRequests.values()
    ])) this.options.env.llm.abort(requestId);
    this.streams.clear();
    this.compressionRequests.clear();
    this.toolToModelPreparationTimings.clear();
    this.disposePromise = this.drainActiveWork();
    return this.disposePromise;
  }

  public wake(conversationIds?: readonly ConversationId[]): void {
    if (this.disposed) return;
    this.scanRequested = true;
    if (conversationIds === undefined) this.scanAllRequested = true;
    else for (const conversationId of conversationIds) this.scanConversationIds.add(conversationId);
    if (this.scanning) return;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      this.launchScan();
    }, 0);
  }

  public requestManagedAttachmentCleanup(): void {
    if (this.disposed) return;
    this.managedAttachmentGcRequested = true;
    this.toolResultBlobGcRequested = true;
    this.wake([]);
  }

  public async reconcileStartup(): Promise<void> {
    const writerEpoch = this.options.backend.writerEpoch();
    for (const rawId of uniqueSorted(this.options.conversationIds())) {
      const conversationId = rawId as ConversationId;
      if (!this.options.adapter.hasKnownRuntime(conversationId) && !await this.options.adapter.readRuntime(conversationId)) continue;
      const resolved = await this.options.adapter.resolveForegroundRunGraphScope(conversationId, this.runtimeReadAccess());
      const base = fullView('restart.reconcile', conversationId);
      const executionViewSpec = {
        ...base,
        conversations: resolved.conversationIds,
        timeline: resolved.conversationIds.map((id) => ({ conversationId: id, throughTail: true })),
        closedRunGraphRoots: resolved.rootRunIds,
        storageResourceKeys: [
          ANSWER_BRIDGE_RESOURCE_KEY,
          CONVERSATION_ATTACHMENTS_RESOURCE_KEY
        ],
        mergeConversationFacts: true,
        aggregateRootConversationId: conversationId
      };
      await this.executeInternal(
        {
          sourceKey: `recovery:restart:${conversationId}:${writerEpoch}`,
          type: 'restart.reconcile',
          scope: { kind: 'conversation', id: conversationId },
          occurredAt: Date.now(),
          payload: { conversationId }
        },
        this.restartHandler,
        executionViewSpec
      );
    }
    await this.sweepStreamCheckpoints();
    await this.sweepManagedAttachmentBlobs();
    await this.sweepToolResultBlobs();
  }

  public handleCleanupHint(hint: CleanupHint): void {
    switch (hint.kind) {
      case 'llm_abort':
        this.abortLlmCleanup(hint.ownerId);
        return;
      case 'tool_abort':
        this.abortToolCleanup(hint.ownerId);
        return;
      case 'blob_gc':
        this.requestManagedAttachmentCleanup();
        return;
      case 'checkpoint_gc':
        this.options.cleanupCheckpointGarbage?.();
        return;
      case 'detached_delivery':
        this.wake([hint.conversationId]);
        return;
      default:
        assertNeverCleanupHint(hint.kind);
    }
  }

  private abortToolCleanup(ownerId: string): void {
    this.runtimeLeases.abortOwned(ownerId, { kinds: ['tool'], reason: 'tool_attempt_cancelled' });
    const matching = [...this.toolControllers.entries()].filter(([key]) => key.startsWith(`${ownerId}:`) || key === ownerId);
    for (const [key, controller] of matching) {
      this.toolControllers.delete(key);
      controller.abort();
    }
  }

  private abortLlmCleanup(ownerId: string): void {
    this.runtimeLeases.abortOwned(ownerId, { kinds: ['llm', 'compression'], reason: 'llm_attempt_cancelled' });
    const streams = [...this.streams.entries()].filter(([, buffer]) => buffer.token.attemptId === ownerId || buffer.requestId === ownerId);
    for (const [key, buffer] of streams) {
      this.streams.delete(key);
      this.options.env.llm.abort(buffer.requestId);
    }
    const compression = [...this.compressionRequests.entries()].filter(([key, requestId]) => key.startsWith(`${ownerId}:`) || requestId === ownerId);
    for (const [key, requestId] of compression) {
      this.compressionRequests.delete(key);
      this.options.env.llm.abort(requestId);
    }
    if (streams.length === 0 && compression.length === 0) this.options.env.llm.abort(ownerId);
  }

  private launchScan(): void {
    if (this.disposed) return;
    const task = this.scan();
    this.scanTasks.add(task);
    void task
      .catch((error) => this.options.onIntegrityError?.('dispatcher', error))
      .finally(() => this.scanTasks.delete(task));
  }

  private async drainActiveWork(): Promise<void> {
    for (;;) {
      const tasks = [...new Set([
        ...this.scanTasks,
        ...this.effectTasks,
        ...this.callbackQueues.values(),
        ...this.toolCompletionFlushes.values(),
        ...this.streamCheckpointTasks
      ])];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
    }
  }

  private async scan(): Promise<void> {
    if (this.disposed || this.scanning) return;
    this.scanning = true;
    try {
      do {
        this.scanRequested = false;
        const scanAll = this.scanAllRequested;
        this.scanAllRequested = false;
        const requested = scanAll
          ? uniqueSorted(this.options.conversationIds())
          : uniqueSorted([...this.scanConversationIds]);
        this.scanConversationIds.clear();
        for (const rawId of requested) {
          if (this.disposed) break;
          try {
            const conversationId = rawId as ConversationId;
            let facts = await this.loadCommittedFacts(conversationId);
            if (await this.runWatchdogs(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runForegroundWaitDeadlines(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runAutomaticHumanWaits(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runAutomaticToolWaits(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runChildTerminalInboxEmission(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runRuntimeDeliveryReconciliation(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runReliableAutoCompression(facts)) facts = await this.loadCommittedFacts(conversationId);
            if (await this.runQueuedAdmission(facts)) facts = await this.loadCommittedFacts(conversationId);
            this.launchDispatchBatch(pendingEffects(facts));
          } catch (error) {
            this.options.onIntegrityError?.(rawId, error);
          }
        }
        if (Date.now() - this.lastStreamCheckpointGcAt >= STREAM_CHECKPOINT_GC_INTERVAL_MS) {
          await this.sweepStreamCheckpoints();
        }
        if (this.managedAttachmentGcRequested || Date.now() - this.lastManagedAttachmentGcAt >= MANAGED_ATTACHMENT_GC_INTERVAL_MS) {
          await this.sweepManagedAttachmentBlobs();
        }
        if (this.toolResultBlobGcRequested || Date.now() - this.lastToolResultBlobGcAt >= TOOL_RESULT_BLOB_GC_INTERVAL_MS) {
          await this.sweepToolResultBlobs();
        }
      } while (this.scanRequested && !this.disposed);
    } finally {
      this.scanning = false;
      if (!this.disposed) {
        this.scanTimer = setTimeout(() => {
          this.scanTimer = undefined;
          this.scanRequested = true;
          this.scanAllRequested = true;
          this.launchScan();
        }, SCAN_INTERVAL_MS);
      }
    }
  }

  private launchDispatchBatch(effects: readonly ActiveEffect[]): void {
    if (this.disposed) return;
    const admitted = effects.filter((effect) => !this.inFlight.has(attemptKey(effect.attempt.id, effect.attempt.generation)));
    if (admitted.length === 0) return;
    for (const effect of admitted) this.inFlight.add(attemptKey(effect.attempt.id, effect.attempt.generation));
    this.trackEffectTask(this.dispatchBatch(admitted), admitted[0]!.attempt.conversationId);
  }

  private async dispatchBatch(effects: readonly ActiveEffect[]): Promise<void> {
    const conversationId = effects[0]!.attempt.conversationId;
    const tokens = effects.map(tokenFor);
    try {
      const attempts: DispatchAttemptBatchPayload['attempts'] = tokens.map((token) => ({
        conversationId: token.conversationId,
        operationId: token.operationId,
        attemptId: token.attemptId,
        generation: token.generation
      }));
      const batchKey = canonicalSha256(attempts.map((attempt) => `${attempt.attemptId}:${attempt.generation}`).sort());
      const marker = await this.executeInternal({
        sourceKey: `internal:dispatch-batch:${conversationId}:${batchKey}`,
        type: 'attempt.dispatch_batch',
        scope: { kind: 'conversation', id: conversationId },
        occurredAt: Date.now(),
        payload: jsonValue({ conversationId, attempts } satisfies DispatchAttemptBatchPayload)
      }, this.dispatchBatchHandler);
      // A replayed marker crosses the crash ambiguity window. Startup reconciliation owns it; only
      // the process that commits the marker may launch the external effects.
      if (marker.status !== 'committed' || this.disposed) return;
      for (let index = 0; index < effects.length; index += 1) {
        const token = tokens[index]!;
        this.crossingBoundary.add(attemptKey(token.attemptId, token.generation));
        this.trackEffectTask(this.executeDispatchedEffect(token, effects[index]!.payload), conversationId);
      }
    } finally {
      // Successfully launched effects retain their keys until their own task/callback cleanup. A
      // non-committed batch did not cross the boundary and releases every reservation immediately.
      for (const token of tokens) {
        const key = attemptKey(token.attemptId, token.generation);
        if (!this.streams.has(key) && !this.toolControllers.has(key) && !this.compressionRequests.has(key)
          && !this.crossingBoundary.has(key)) this.inFlight.delete(key);
      }
    }
  }

  private async executeDispatchedEffect(token: AttemptToken, payload: JsonValue): Promise<void> {
    const key = attemptKey(token.attemptId, token.generation);
    try {
      await this.crossBoundary(token, payload);
    } catch (error) {
      await this.handleSynchronousDispatchFailure(token, error);
    } finally {
      this.crossingBoundary.delete(key);
      if (!this.streams.has(key) && !this.toolControllers.has(key) && !this.compressionRequests.has(key)) this.inFlight.delete(key);
      this.wake([token.conversationId]);
    }
  }

  private trackEffectTask(task: Promise<void>, conversationId: ConversationId): void {
    this.effectTasks.add(task);
    void task
      .catch((error) => this.options.onIntegrityError?.(conversationId, error))
      .finally(() => this.effectTasks.delete(task));
  }


  private async crossBoundary(token: AttemptToken, payload: JsonValue): Promise<void> {
    if (token.kind === 'runtime.cleanup') {
      await this.executeRuntimeCleanup(token, payload);
      return;
    }
    if (token.kind === 'context.load') {
      await this.options.ensureConversationLoaded(token.conversationId);
      const source = callbackSource(this.ids.nextCallbackEventId());
      const commandPayload: ContextLoadedPayload = {
        ...token,
        invocationId: this.ids.nextInvocationId(),
        requestId: this.ids.nextRequestId(),
        nextOperationId: this.ids.nextOperationId(),
        nextAttemptId: this.ids.nextAttemptId(),
        nextEffectIntentId: this.ids.nextEffectIntentId()
      };
      await this.executeCallback(token, source, 'context.loaded', commandPayload, this.contextLoadedHandler);
      return;
    }
    if (token.kind === 'context.build_llm_request') {
      const input = payload as unknown as ReliableContextBuildInput;
      const facts = await this.loadCommittedFacts(token.conversationId);
      const built = await this.buildLlmRequest(token, input, facts);
      const request = built.request;
      const step = planReliableLlmPreflight(this.options.world, facts, runToken(token), input, request);
      const source = callbackSource(this.ids.nextCallbackEventId());
      const commandPayload: ContextRequestBuiltPayload = {
        ...token,
        requestId: request.id as RequestId,
        request,
        contextProjection: buildModelContextProjectionCommitData(built.contextProjection, input.requestId, token.conversationId),
        step
      };
      await this.executeCallback(token, source, 'context.request_built', commandPayload, this.contextBuiltHandler);
      return;
    }
    if (token.kind === 'compression.pre_llm') {
      await this.executeCompressionBarrier(token, payload);
      return;
    }
    if (token.kind === 'compression.manual' || token.kind === 'compression.auto') {
      await this.executeStandaloneCompression(token, payload);
      return;
    }
    if (token.kind === 'checkpoint.before_llm' || token.kind === 'checkpoint.after_llm') {
      await this.executeCheckpointBarrier(token, payload);
      return;
    }
    if (token.kind === 'invocation.resolve') {
      this.options.env.llm.resolveInvocation(payload as unknown as LlmResolveInvocationRequest, (event) => {
        this.enqueueCallback(token, () => this.handleInvocationEvent(token, event));
      });
      return;
    }
    if (token.kind === 'llm.request') {
      const request = payload as unknown as LlmStartRequest;
      await this.installTransientLlmRequest(token, request);
      const buffer = await this.createStreamBuffer(token, request);
      if (this.disposed) return;
      const key = attemptKey(token.attemptId, token.generation);
      this.streams.set(key, buffer);
      this.runtimeLeases.register({
        key,
        ownerId: token.attemptId,
        generation: token.generation,
        kind: 'llm',
        externalIds: [request.id],
        abort: () => {
          if (this.streams.get(key) === buffer) this.streams.delete(key);
          this.options.env.llm.abort(request.id);
        }
      });
      this.options.env.llm.start(request, (event) => {
        const receivedAt = Date.now();
        this.enqueueCallback(token, () => this.handleLlmEvent(buffer, event, receivedAt));
      });
      this.finishToolToModelPreparationTiming(token);
      return;
    }
    if (token.kind === 'tool.write.apply_change') {
      await this.applyToolChange(token, payload);
      return;
    }
    if (token.kind.startsWith('tool.read.') || token.kind.startsWith('tool.write.')) {
      const input = payload as unknown as { name?: string };
      if (input.name === SUBMIT_AGENT_ANSWER_TOOL_NAME) {
        await this.submitAgentAnswer(token, payload);
        return;
      }
      if (input.name === READ_AGENT_ANSWER_TOOL_NAME) {
        await this.readAgentAnswer(token, payload);
        return;
      }
      await this.executeRuntimeTool(token, payload);
      return;
    }
    if (token.kind.startsWith('tool.agent.')) {
      await this.launchAgentChild(token, payload);
      return;
    }
    throw new Error(`No committed primary effect executor for ${token.kind}.`);
  }

  private async executeRuntimeCleanup(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    const cleanup = normalizeRuntimeCleanupPayload(rawPayload);
    for (const target of cleanup.targets) {
      if (target.kind === 'llm_abort') {
        this.abortLlmCleanup(target.sourceAttemptId);
        for (const externalId of target.externalIds) this.options.env.llm.abort(externalId);
      } else {
        this.abortToolCleanup(target.sourceAttemptId);
      }
    }
    const callback: CompleteRuntimeCleanupPayload = {
      conversationId: token.conversationId,
      operationId: token.operationId,
      attemptId: token.attemptId,
      generation: token.generation,
      cleanedTargetCount: cleanup.targets.length
    };
    await this.executeCallback(
      token,
      callbackSource(this.ids.nextCallbackEventId()),
      'runtime.cleanup.completed',
      callback,
      this.completeRuntimeCleanupHandler
    );
  }

  private async executeCompressionBarrier(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    if (!isReliableBarrierEffectPayload(rawPayload) || rawPayload.barrier !== 'compression.pre_llm') {
      throw new Error(`Compression Operation ${token.operationId} has no valid durable barrier payload.`);
    }
    const payload = cloneJson(rawPayload) as unknown as Extract<ReliableBarrierEffectPayload, { barrier: 'compression.pre_llm' }>;
    const request = payload.plan.compactRequest;
    const key = attemptKey(token.attemptId, token.generation);
    this.compressionRequests.set(key, request.id);
    this.runtimeLeases.register({
      key,
      ownerId: token.attemptId,
      generation: token.generation,
      kind: 'compression',
      externalIds: [request.id],
      abort: () => {
        if (this.compressionRequests.get(key) === request.id) this.compressionRequests.delete(key);
        this.options.env.llm.abort(request.id);
      }
    });
    this.options.env.llm.compact(request, (event) => {
      if (this.compressionRequests.get(key) !== request.id) return;
      this.enqueueCallback(token, () => this.handleCompressionEvent(token, payload, event));
    });
  }

  private async handleCompressionEvent(
    token: AttemptToken,
    barrier: Extract<ReliableBarrierEffectPayload, { barrier: 'compression.pre_llm' }>,
    event: WorldEvent
  ): Promise<void> {
    if (this.compressionRequests.get(attemptKey(token.attemptId, token.generation)) !== barrier.plan.compactRequest.id) return;
    if (event.type !== LlmEventType.CompactDone && event.type !== LlmEventType.CompactError) return;
    const terminal = event.payload as LlmCompactDonePayload | LlmCompactErrorPayload;
    if (terminal.requestId !== barrier.plan.compactRequest.id || terminal.blockId !== barrier.plan.block.id || terminal.conversationId !== token.conversationId) {
      throw new Error(`Compression callback identity mismatch for Operation ${token.operationId}.`);
    }
    const completed: CompressionBarrierCallbackPayload = {
      ...token,
      plan: cloneJson(barrier.plan),
      continuation: cloneJson(barrier.continuation),
      outcome: event.type === LlmEventType.CompactDone ? 'succeeded' : 'failed',
      completedAt: terminal.completedAt,
      ...(event.type === LlmEventType.CompactDone
        ? { result: cloneJson((terminal as LlmCompactDonePayload).result) }
        : { error: (terminal as LlmCompactErrorPayload).message })
    };
    const source = callbackSource(this.ids.nextCallbackEventId());
    try {
      await this.executeCallback(token, source, 'compression.pre_llm.completed', completed, this.compressionBarrierHandler);
    } finally {
      this.compressionRequests.delete(attemptKey(token.attemptId, token.generation));
      this.finishAttempt(token);
    }
  }

  private async executeStandaloneCompression(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    if (!isReliableBarrierEffectPayload(rawPayload)
      || rawPayload.barrier !== 'compression.standalone'
      || token.kind !== `compression.${rawPayload.trigger}`) {
      throw new Error(`Standalone Compression Operation ${token.operationId} has no valid durable payload.`);
    }
    const payload = cloneJson(rawPayload) as unknown as Extract<ReliableBarrierEffectPayload, { barrier: 'compression.standalone' }>;
    const request = payload.plan.compactRequest;
    const key = attemptKey(token.attemptId, token.generation);
    this.compressionRequests.set(key, request.id);
    this.runtimeLeases.register({
      key,
      ownerId: token.attemptId,
      generation: token.generation,
      kind: 'compression',
      externalIds: [request.id],
      abort: () => {
        if (this.compressionRequests.get(key) === request.id) this.compressionRequests.delete(key);
        this.options.env.llm.abort(request.id);
      }
    });
    this.options.env.llm.compact(request, (event) => {
      if (this.compressionRequests.get(key) !== request.id) return;
      this.enqueueCallback(token, () => this.handleStandaloneCompressionEvent(token, payload, event));
    });
  }

  private async handleStandaloneCompressionEvent(
    token: AttemptToken,
    payload: Extract<ReliableBarrierEffectPayload, { barrier: 'compression.standalone' }>,
    event: WorldEvent
  ): Promise<void> {
    if (this.compressionRequests.get(attemptKey(token.attemptId, token.generation)) !== payload.plan.compactRequest.id) return;
    if (event.type !== LlmEventType.CompactDone && event.type !== LlmEventType.CompactError) return;
    const terminal = event.payload as LlmCompactDonePayload | LlmCompactErrorPayload;
    if (terminal.requestId !== payload.plan.compactRequest.id
      || terminal.blockId !== payload.plan.block.id
      || terminal.conversationId !== token.conversationId) {
      throw new Error(`Standalone compression callback identity mismatch for Operation ${token.operationId}.`);
    }
    const completed: CompleteStandaloneCompressionPayload = {
      conversationId: token.conversationId,
      operationId: token.operationId,
      attemptId: token.attemptId,
      generation: token.generation,
      plan: cloneJson(payload.plan),
      outcome: event.type === LlmEventType.CompactDone ? 'succeeded' : 'failed',
      completedAt: terminal.completedAt,
      ...(event.type === LlmEventType.CompactDone
        ? { result: cloneJson((terminal as LlmCompactDonePayload).result) }
        : { error: (terminal as LlmCompactErrorPayload).message })
    };
    const source = callbackSource(this.ids.nextCallbackEventId());
    try {
      await this.executeCallback(
        token,
        source,
        payload.trigger === 'auto' ? 'compression.auto.completed' : 'compression.manual.completed',
        completed,
        this.standaloneCompressionHandler
      );
    } finally {
      this.compressionRequests.delete(attemptKey(token.attemptId, token.generation));
      this.finishAttempt(token);
    }
  }

  private async executeCheckpointBarrier(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    if (!isReliableBarrierEffectPayload(rawPayload)
      || (rawPayload.barrier !== 'checkpoint.before_llm' && rawPayload.barrier !== 'checkpoint.after_llm')
      || rawPayload.barrier.slice('checkpoint.'.length) !== token.kind.slice('checkpoint.'.length)) {
      throw new Error(`Checkpoint Operation ${token.operationId} has no valid durable barrier payload.`);
    }
    const payload = cloneJson(rawPayload) as unknown as Extract<ReliableBarrierEffectPayload, { barrier: 'checkpoint.before_llm' | 'checkpoint.after_llm' }>;
    let record: CheckpointRecord;
    if (!CHECKPOINT_FEATURE_ENABLED) {
      const now = Date.now();
      record = {
        ...cloneJson(payload.plan.checkpoint),
        status: 'skipped',
        skipReason: 'disabled',
        message: 'Checkpoint 功能当前已停用。',
        updatedAt: now
      };
    } else {
      try {
        record = await this.options.env.storage.createShadowCheckpoint(payload.plan.createRequest);
      } catch (error) {
        const now = Date.now();
        record = {
          ...cloneJson(payload.plan.checkpoint),
          status: 'failed',
          skipReason: 'io_error',
          message: error instanceof Error ? error.message : String(error),
          updatedAt: now
        };
      }
    }
    const completed = {
      ...token,
      plan: cloneJson(payload.plan),
      continuation: cloneJson(payload.continuation),
      record: cloneJson(record),
      completedAt: record.updatedAt
    } as CheckpointBarrierCallbackPayload | PostLlmCheckpointCallbackPayload;
    const source = callbackSource(this.ids.nextCallbackEventId());
    try {
      if (payload.barrier === 'checkpoint.after_llm') {
        await this.executeCallback(token, source, 'checkpoint.after_llm.completed', completed as PostLlmCheckpointCallbackPayload, this.postLlmCheckpointHandler);
      } else {
        await this.executeCallback(token, source, 'checkpoint.before_llm.completed', completed as CheckpointBarrierCallbackPayload, this.checkpointBarrierHandler);
      }
    } finally {
      this.finishAttempt(token);
    }
  }

  private async handleInvocationEvent(token: AttemptToken, event: WorldEvent): Promise<void> {
    if (event.type === LlmEventType.InvocationResolved) {
      const payload = event.payload as LlmInvocationResolvedPayload;
      const source = callbackSource(this.ids.nextCallbackEventId());
      const commandPayload: InvocationResolvedPayload = {
        ...token,
        invocationId: payload.invocationId as InvocationId,
        requestId: payload.requestId as RequestId,
        settings: payload.settings,
        resolvedAt: payload.resolvedAt,
        modelMessageId: this.ids.nextMessageId(),
        modelRevisionId: this.ids.nextMessageRevisionId(),
        contextOperationId: this.ids.nextOperationId(),
        contextAttemptId: this.ids.nextAttemptId(),
        contextEffectIntentId: this.ids.nextEffectIntentId()
      };
      await this.executeCallback(token, source, 'invocation.resolved', commandPayload, this.invocationResolvedHandler);
      this.finishAttempt(token);
      return;
    }
    if (event.type === LlmEventType.InvocationResolveError) {
      const payload = event.payload as LlmInvocationResolveErrorPayload;
      const source = callbackSource(this.ids.nextCallbackEventId());
      const commandPayload: InvocationResolveFailedPayload = {
        ...token,
        invocationId: payload.invocationId as InvocationId,
        requestId: payload.requestId as RequestId,
        message: payload.message,
        resolvedAt: payload.resolvedAt,
        errorMessageId: this.ids.nextMessageId(),
        errorRevisionId: this.ids.nextMessageRevisionId()
      };
      await this.executeCallback(token, source, 'invocation.resolve_failed', commandPayload, this.invocationFailedHandler);
      this.finishAttempt(token);
    }
  }

  private async handleLlmEvent(buffer: LlmStreamBuffer, event: WorldEvent, receivedAt = Date.now()): Promise<void> {
    recordLlmCallbackTiming(buffer, receivedAt, Date.now());
    const token = buffer.token;
    switch (event.type) {
      case LlmEventType.Started: {
        const payload = event.payload as LlmStartedPayload;
        buffer.startedAt = payload.startedAt ?? Date.now();
        const source = callbackSource(this.ids.nextCallbackEventId());
        const started: LlmStartedCallbackPayload = {
          ...token,
          requestId: buffer.requestId,
          ...(payload.invocationId ? { invocationId: payload.invocationId as InvocationId } : {}),
          ...(payload.model ? { model: payload.model } : {}),
          startedAt: buffer.startedAt
        };
        await this.executeCallback(token, source, 'llm.started', started, this.llmStartedHandler);
        await this.enqueueTransientStreamEvent(buffer, event);
        return;
      }
      case LlmEventType.Delta:
        await this.acceptStreamDelta(buffer, event, () => appendVisibleText(buffer, (event.payload as LlmDeltaPayload).text));
        return;
      case LlmEventType.ThoughtDelta:
        await this.acceptStreamDelta(buffer, event, () => appendThought(buffer, event.payload as LlmThoughtDeltaPayload));
        return;
      case LlmEventType.ThoughtProgress:
        await this.acceptStreamDelta(buffer, event, () => updateThoughtProgress(buffer, event.payload as LlmThoughtProgressPayload));
        return;
      case LlmEventType.ThoughtDone:
        await this.acceptStreamDelta(buffer, event, () => finishThought(buffer, event.payload as LlmThoughtDonePayload));
        return;
      case LlmEventType.ToolCallDelta:
      case LlmEventType.ToolCallPreviewDone:
        await this.acceptTransientSequenceEvent(buffer, event);
        return;
      case LlmEventType.ToolCall:
        await this.withActiveStream(buffer, () => appendToolCalls(buffer, event.payload as LlmToolCallPayload));
        return;
      case LlmEventType.RetryStarted:
        await this.withActiveStream(buffer, () => {
          resetForRetry(buffer);
          this.options.world.enqueue(withTransientStreamEpoch(event, buffer));
        });
        // The reset supersedes every prior provider-attempt checkpoint, even when the retried
        // stream never reaches the ordinary size threshold before interruption.
        await this.checkpointStream(buffer);
        return;
      case LlmEventType.RetryScheduled:
      case LlmEventType.RetryCancelled:
      case LlmEventType.RetryRecovered:
        await this.enqueueTransientStreamEvent(buffer, event);
        return;
      case LlmEventType.Done:
        if (await this.isActiveStream(buffer)) await this.finishLlm(buffer, 'succeeded', event.payload as LlmDonePayload);
        return;
      case LlmEventType.Error:
        if (await this.isActiveStream(buffer)) await this.finishLlm(buffer, 'failed', event.payload as LlmErrorPayload);
        return;
    }
  }

  private async acceptStreamDelta(buffer: LlmStreamBuffer, event: WorldEvent, update: () => void): Promise<void> {
    let checkpoint = false;
    await this.withActiveStream(buffer, () => {
      update();
      buffer.streamSeq += 1;
      buffer.deltaCountSinceCheckpoint += 1;
      buffer.checkpointChars = messageCharacterCount(buffer.content);
      this.options.world.enqueue(withTransientStreamEpoch(event, buffer));
      requireLlmPipelineTiming(buffer).transientWorldEnqueueCount += 1;
      if (shouldCheckpointReliableStream(buffer)) {
        buffer.deltaCountSinceCheckpoint = 0;
        buffer.lastCheckpointChars = buffer.checkpointChars;
        checkpoint = true;
      }
    });
    if (checkpoint) this.startStreamCheckpoint(buffer);
  }

  private async acceptTransientSequenceEvent(buffer: LlmStreamBuffer, event: WorldEvent): Promise<void> {
    await this.withActiveStream(buffer, () => {
      buffer.streamSeq += 1;
      this.options.world.enqueue(withTransientStreamEpoch(event, buffer));
      requireLlmPipelineTiming(buffer).transientWorldEnqueueCount += 1;
    });
  }

  private startStreamCheckpoint(buffer: LlmStreamBuffer): void {
    if (this.disposed) return;
    const task = this.checkpointStream(buffer);
    this.streamCheckpointTasks.add(task);
    void task
      .catch((error) => this.options.onIntegrityError?.(buffer.token.conversationId, error))
      .finally(() => this.streamCheckpointTasks.delete(task));
  }

  private async enqueueTransientStreamEvent(buffer: LlmStreamBuffer, event: WorldEvent): Promise<void> {
    await this.withActiveStream(buffer, () => {
      this.options.world.enqueue(withTransientStreamEpoch(event, buffer));
      requireLlmPipelineTiming(buffer).transientWorldEnqueueCount += 1;
    });
  }

  private async isActiveStream(buffer: LlmStreamBuffer): Promise<boolean> {
    let active = false;
    await this.withActiveStream(buffer, () => { active = true; });
    return active;
  }

  private withActiveStream(buffer: LlmStreamBuffer, action: () => void): Promise<void> {
    const key = attemptKey(buffer.token.attemptId, buffer.token.generation);
    return this.options.backend.withConversationExecutionBarrier(buffer.token.conversationId, () => {
      if (this.streams.get(key) !== buffer) return;
      action();
    });
  }

  private checkpointStream(buffer: LlmStreamBuffer): Promise<void> {
    return this.streamCheckpointFileExecutor.run(['stream-checkpoint-files'], async () => {
      const streamSeq = buffer.streamSeq;
      const content = recoverableStreamContent(buffer.content);
      const toolCalls = cloneJson(buffer.toolCalls);
      const snapshot = {
        requestId: buffer.requestId,
        attemptId: buffer.token.attemptId,
        generation: buffer.token.generation,
        streamSeq,
        content,
        toolCalls
      };
      const payloadHash = canonicalSha256(snapshot);
      const relativePath = `${STREAM_CHECKPOINT_ROOT}/${buffer.requestId}/${buffer.token.attemptId}/${buffer.token.generation}/${streamSeq}-${payloadHash}.json`;
      const payload: StreamCheckpointPayload = {
        ...buffer.token,
        requestId: buffer.requestId,
        streamSeq,
        content,
        toolCalls,
        payloadHash,
        file: relativePath
      };
      await this.executeInternal({
        sourceKey: `internal:stream-checkpoint:${buffer.requestId}:${buffer.token.attemptId}:${buffer.token.generation}:${streamSeq}`,
        type: 'stream.checkpoint',
        scope: { kind: 'conversation', id: buffer.token.conversationId },
        occurredAt: Date.now(),
        payload: payload as unknown as JsonValue
      }, this.checkpointHandler, undefined, async (command) => ({
        ...command,
        payload: jsonValue(await this.prepareStreamCheckpoint(command.payload as unknown as StreamCheckpointPayload))
      }));
      buffer.lastCheckpointAt = Date.now();
    });
  }

  private async prepareStreamCheckpoint(payload: StreamCheckpointPayload): Promise<StreamCheckpointPayload> {
    const content = await this.options.env.storage.ingestMessageContentAttachments(payload.content);
    const snapshot = {
      requestId: payload.requestId,
      attemptId: payload.attemptId,
      generation: payload.generation,
      streamSeq: payload.streamSeq,
      content,
      toolCalls: cloneJson(payload.toolCalls)
    };
    const payloadHash = canonicalSha256(snapshot);
    const file = `${STREAM_CHECKPOINT_ROOT}/${payload.requestId}/${payload.attemptId}/${payload.generation}/${payload.streamSeq}-${payloadHash}.json`;
    const bytes = jsonBytes(snapshot);
    try {
      await this.options.files.atomicWrite(file, bytes, { createOnly: true });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error;
      const existing = await this.options.files.read(file);
      if (!existing || !Buffer.from(existing).equals(Buffer.from(bytes))) throw new Error(`Immutable stream checkpoint conflicts with existing content: ${file}`);
    }
    return { ...payload, content, payloadHash, file };
  }

  private async finishLlm(buffer: LlmStreamBuffer, outcome: 'succeeded' | 'failed', terminal: LlmDonePayload | LlmErrorPayload): Promise<void> {
    const token = buffer.token;
    const completedAt = terminal.createdAt ?? Date.now();
    const facts = outcome === 'succeeded' ? await this.loadCommittedFacts(token.conversationId) : undefined;
    const toolDeadlineMs = facts ? policyNumber(facts, requireTokenRunOwner(token), 'toolDeadlineMs') : undefined;
    const plannedTools = toolDeadlineMs === undefined
      ? []
      : buffer.toolCalls.map((tool, schedulingOrdinal) => this.planTool(token, tool, toolDeadlineMs, schedulingOrdinal));
    let postLlmCheckpoint: LlmFinalCallbackPayload['postLlmCheckpoint'];
    if (facts) {
      const request = facts.requests.find((candidate) => candidate.id === buffer.requestId && candidate.operationId === token.operationId);
      if (request?.modelMessageId) {
        const checkpoint = planReliableCheckpointBarrier(
          this.options.world,
          facts,
          runToken(token),
          request.modelMessageId,
          'llm_response_after',
          `${token.attemptId}:${token.generation}:post-llm`
        );
        if (checkpoint) {
          postLlmCheckpoint = {
            ids: {
              operationId: this.ids.nextOperationId(),
              attemptId: this.ids.nextAttemptId(),
              effectIntentId: this.ids.nextEffectIntentId()
            },
            plan: checkpoint
          };
        }
      }
    }
    const payload: LlmFinalCallbackPayload = {
      ...token,
      requestId: buffer.requestId,
      outcome,
      content: cloneJson(buffer.content),
      completedAt,
      ...('message' in terminal ? { error: terminal.message } : {}),
      ...(terminal.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: terminal.streamOutputDurationMs } : {}),
      ...('usageMetadata' in terminal && terminal.usageMetadata ? { usageMetadata: terminal.usageMetadata } : {}),
      finalStreamSeq: buffer.streamSeq,
      toolCalls: plannedTools,
      ...(postLlmCheckpoint ? { postLlmCheckpoint } : {})
    };
    const source = callbackSource(this.ids.nextCallbackEventId());
    const finalizationStartedAt = Date.now();
    await this.executeCallback(
      token,
      source,
      'llm.final',
      payload,
      this.llmFinalHandler,
      async (current) => ({
        ...current,
        content: await this.options.env.storage.ingestMessageContentAttachments(current.content)
      })
    );
    logLlmStreamPipelineTiming(buffer, terminal, finalizationStartedAt, Date.now());
    this.streams.delete(attemptKey(token.attemptId, token.generation));
    this.finishAttempt(token);
  }

  private planTool(token: AttemptToken, tool: BufferedToolCall, deadlineMs: number, schedulingOrdinal: number): PlannedToolCall {
    const definition = this.options.env.tools.registry.find((candidate) => candidate.declaration.name === tool.name);
    const scheduling = toolSchedulingDecisionForCall(this.options.world, tool.name, tool.argsJson);
    const execution = tool.name === 'ask_user'
      ? 'waiting_user' as const
      : tool.name === 'submit_plan'
        ? 'waiting_plan_review' as const
        : definition?.execution === 'agentRun'
          ? 'agentRun' as const
          : 'runtime' as const;
    const base = {
      toolCallId: this.ids.nextToolCallId(),
      toolCallEventId: this.ids.nextToolCallEventId(),
      ...(tool.functionCallId ? { functionCallId: tool.functionCallId } : {}),
      name: tool.name,
      argsJson: tool.argsJson,
      ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}),
      schedulingOrdinal,
      schedulingMode: scheduling.mode,
      ...(scheduling.reason ? { schedulingReason: scheduling.reason } : {}),
      execution
    };
    if (execution === 'waiting_user' || execution === 'waiting_plan_review') return base;
    const planned = planReliableToolExecution(this.options.world, {
      runId: requireTokenRunOwner(token),
      toolCallId: base.toolCallId,
      name: tool.name,
      argsJson: tool.argsJson,
      createdAt: Date.now()
    });
    const rejected = planned.disposition === 'rejected';
    const readonly = rejected || planned.readonly;
    const recoveryPolicy = execution === 'agentRun' || readonly ? 'resume_pending_if_safe' as const : 'require_resolution' as const;
    const timeoutPolicy = execution === 'agentRun' || readonly ? 'retry_if_safe' as const : 'require_resolution' as const;
    const kind = rejected
      ? 'tool.read.rejected'
      : execution === 'agentRun'
        ? `tool.agent.${tool.name}`
        : readonly
          ? `tool.read.${tool.name}`
          : `tool.write.${tool.name}`;
    const effectPayload = rejected
      ? jsonValue({
          toolCallId: base.toolCallId,
          name: tool.name,
          argsJson: tool.argsJson,
          runId: requireTokenRunOwner(token),
          conversationId: token.conversationId,
          rejectedReason: planned.reason
        })
      : jsonValue(planned.effectPayload);
    if (!rejected && planned.disposition === 'awaiting_approval') {
      return {
        ...base,
        execution: 'waiting_approval',
        approval: { kind, recoveryPolicy, timeoutPolicy, deadlineMs, effectPayload }
      };
    }
    return {
      ...base,
      operationId: this.ids.nextOperationId(),
      attemptId: this.ids.nextAttemptId(),
      effectIntentId: this.ids.nextEffectIntentId(),
      recoveryPolicy,
      timeoutPolicy,
      deadlineMs,
      effectPayload
    };
  }

  private async launchAgentChild(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    const input = rawPayload as unknown as {
      toolCallId: ToolCallId;
      name?: string;
      argsJson: string;
      planDelegation?: { proposalId: string; userMessage: string; agentType: string };
    };
    let args: { mode?: unknown; answerBridgeId?: unknown };
    try { args = input.argsJson ? JSON.parse(input.argsJson) as typeof args : {}; }
    catch (error) {
      const message = `run_agent 参数不是合法 JSON: ${String(error)}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const requestedMode = typeof args.mode === 'string' && args.mode.trim() ? args.mode.trim() : 'run';
    if (requestedMode === 'interrupt') {
      await this.interruptAgentChild(token, input);
      return;
    }

    const requestedBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
    let continuation: ReliableChildContinuationTarget | undefined;
    if (requestedBridgeId) {
      try { continuation = await this.resolveReliableChildContinuation(requestedBridgeId); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
        return;
      }
      if (!continuation) {
        const message = `未找到 answerBridgeId：${requestedBridgeId}`;
        await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
        return;
      }
    }

    let launched: ReturnType<typeof planReliableChildAgentRun> | undefined;
    await this.options.scheduler.runAtSafePoint(() => {
      launched = planReliableChildAgentRun(this.options.world, {
        sourceRunId: requireTokenRunOwner(token),
        sourceToolCallId: input.toolCallId,
        argsJson: input.argsJson,
        ...(continuation ? { continuation } : {}),
        ids: {
          conversationId: this.ids.nextConversationId(),
          answerBridgeId: this.ids.nextAnswerBridgeId(),
          childRunId: this.ids.nextRunId(),
          childMessageId: this.ids.nextMessageId(),
          childRevisionId: this.ids.nextMessageRevisionId(),
          startedAt: Date.now()
        }
      });
      if (launched.ok && launched.value.agentMirror) {
        const mirror = launched.value.agentMirror;
        const existing = this.options.world.entityByRecordId(Agent, mirror.id);
        if (existing === undefined) {
          const entity = this.options.world.spawn();
          this.options.world.add(entity, Agent, {
            id: mirror.id,
            name: mirror.name,
            ...(mirror.description ? { description: mirror.description } : {}),
            source: mirror.source ?? 'builtin'
          });
          this.options.world.add(entity, AgentKind, { kind: mirror.typeId });
          this.options.world.add(entity, AgentStatus, { status: 'idle' });
        } else if (this.options.world.get(existing, AgentKind)?.kind !== mirror.typeId) {
          throw new Error(`Temporary Agent identity has a different type: ${mirror.id}`);
        }
      }
    });
    if (!launched?.ok) {
      const message = launched?.reason ?? 'run_agent child launch did not produce a result.';
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }

    const progress = launched.value.progress;
    if (!progress.agentId || !progress.answerBridgeId || !progress.childRunId || !progress.conversationId
      || progress.startedAt === undefined || progress.foregroundWaitMs === undefined) {
      throw new Error('Reliable child launch returned incomplete stable identity/progress metadata.');
    }
    const targetAgentId = progress.agentId;
    const answerBridgeId = progress.answerBridgeId;
    const childRunId = progress.childRunId;
    const startedAt = progress.startedAt;
    const foregroundWaitMs = progress.foregroundWaitMs;
    const targetConversationId = progress.conversationId as ConversationId;
    await this.options.prepareConversationOwnership(targetConversationId);
    const childAuthorityProfile = compileChildTurnAuthorityProfile(
      projectClientState(
        this.options.world,
        this.options.world.getResource(ClientStateContributorsKey).list()
      ),
      targetAgentId
    );
    const backgroundResult = input.planDelegation
      ? jsonValue({
          ok: true,
          output: createSubmitPlanToolOutput({
            proposalId: input.planDelegation.proposalId,
            status: 'approved',
            userMessage: input.planDelegation.userMessage,
            executionTarget: 'new_conversation',
            delegationStatus: 'backgrounded',
            agentId: progress.agentId,
            agentType: progress.agentType ?? input.planDelegation.agentType,
            runId: progress.runId,
            conversationId: progress.conversationId,
            answerBridgeId: progress.answerBridgeId
          })
        })
      : jsonValue({
          ok: true,
          status: launched.value.background ? 'backgrounded' : 'running',
          agentId: progress.agentId,
          agentType: progress.agentType,
          runId: progress.runId,
          childRunId: progress.childRunId,
          conversationId: progress.conversationId,
          answerBridgeId: progress.answerBridgeId
        });
    const payload: OpenAnswerBridgePayload = {
      ...token,
      sourceConversationId: token.conversationId,
      targetConversationId,
      ...(launched.value.targetConversationTitle ? { targetConversationTitle: launched.value.targetConversationTitle } : {}),
      targetAgentId,
      parentRunId: requireTokenRunOwner(token),
      parentToolCallId: input.toolCallId,
      bridgeId: answerBridgeId as OpenAnswerBridgePayload['bridgeId'],
      childRunId: childRunId as RunId,
      childMessageId: launched.value.childMessageId as OpenAnswerBridgePayload['childMessageId'],
      childRevisionId: launched.value.childRevisionId as OpenAnswerBridgePayload['childRevisionId'],
      childProgressIds: {
        operationId: this.ids.nextOperationId(),
        attemptId: this.ids.nextAttemptId(),
        effectIntentId: this.ids.nextEffectIntentId()
      },
      childContent: cloneJson(launched.value.childContent),
      childAuthorityProfile: cloneJson(childAuthorityProfile),
      childAuthoritySnapshotId: this.ids.nextAuthoritySnapshotId(),
      authorityDerivationLinkId: this.ids.nextRelationId(),
      childContextPolicy: cloneJson(launched.value.contextPolicy),
      mode: launched.value.background ? 'background' : 'foreground',
      ...(!launched.value.background ? { foregroundDeadlineAt: startedAt + foregroundWaitMs } : {}),
      backgroundResult,
      responseMessageId: this.ids.nextMessageId(),
      responseRevisionId: this.ids.nextMessageRevisionId(),
      nextInvocationId: this.ids.nextInvocationId(),
      nextRequestId: this.ids.nextRequestId(),
      nextOperationId: this.ids.nextOperationId(),
      nextAttemptId: this.ids.nextAttemptId(),
      nextEffectIntentId: this.ids.nextEffectIntentId()
    };
    const sourceKey = callbackSource(this.ids.nextCallbackEventId());
    const result = await this.executeInternal({
      sourceKey,
      type: 'answer_bridge.open',
      scope: { kind: 'multi_conversation', ids: [token.conversationId, targetConversationId].sort() as ConversationId[] },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, this.openBridgeHandler);
    if (result.status === 'committed' || result.status === 'already_applied') {
      await this.options.adoptCommittedConversation(targetConversationId);
    } else {
      await this.failCurrentToolCallbackIfRejected(token, input.toolCallId, 'answer_bridge.open', result);
    }
    this.wake([token.conversationId, targetConversationId]);
  }

  private async interruptAgentChild(token: AttemptToken, input: { toolCallId: ToolCallId; argsJson: string }): Promise<void> {
    let answerBridgeId = '';
    try {
      const args = input.argsJson ? JSON.parse(input.argsJson) as { answerBridgeId?: unknown } : {};
      answerBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
    } catch (error) {
      const message = `run_agent 参数不是合法 JSON: ${String(error)}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const bridge = answerBridgeId ? await this.resolveAnswerBridge(answerBridgeId) : undefined;
    if (!bridge) {
      const message = answerBridgeId ? `未找到 answerBridgeId：${answerBridgeId}` : 'run_agent.mode=interrupt 需要 answerBridgeId。';
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const sourceFacts = await this.loadCommittedFacts(bridge.sourceConversationId);
    const ownership = resolveAnswerBridgeChildOwnership(sourceFacts, bridge.bridgeId, {
      expectedOwnerGeneration: bridge.ownerGeneration
    });
    let ownedChild: InterruptChildRunsPayload['ownedChild'];
    let closureConversationIds: ConversationId[] = [bridge.targetConversationId];
    if (ownership.status === 'matched') {
      const closure = await this.options.adapter.resolveRunGraphClosure(
        ownership.ownership.targetConversationId,
        [ownership.ownership.childRunId],
        runGraphCascadeForPolicy('explicit_child_interrupt').cascadeBackgroundChildren,
        this.runtimeReadAccess()
      );
      closureConversationIds = closure.conversationIds;
      ownedChild = {
        childRunId: ownership.ownership.childRunId,
        targetConversationId: ownership.ownership.targetConversationId,
        closureRunIds: closure.nodes.map((node) => node.runId),
        sourceContinuation: {
          toolCallEventId: this.ids.nextToolCallEventId(),
          responseMessageId: this.ids.nextMessageId(),
          responseRevisionId: this.ids.nextMessageRevisionId(),
          nextInvocationId: this.ids.nextInvocationId(),
          nextRequestId: this.ids.nextRequestId(),
          nextOperationId: this.ids.nextOperationId(),
          nextAttemptId: this.ids.nextAttemptId(),
          nextEffectIntentId: this.ids.nextEffectIntentId()
        }
      };
    }
    const resultPayload = asInterruptResult(bridge.bridgeId, bridge.targetConversationId);
    const payload: InterruptChildRunsPayload = {
      ...token,
      bridgeId: bridge.bridgeId as InterruptChildRunsPayload['bridgeId'],
      callerToolCallId: input.toolCallId,
      result: resultPayload,
      expectedOwnerGeneration: bridge.ownerGeneration,
      ...(ownedChild ? { ownedChild } : {}),
      responseMessageId: this.ids.nextMessageId(),
      responseRevisionId: this.ids.nextMessageRevisionId(),
      nextInvocationId: this.ids.nextInvocationId(),
      nextRequestId: this.ids.nextRequestId(),
      nextOperationId: this.ids.nextOperationId(),
      nextAttemptId: this.ids.nextAttemptId(),
      nextEffectIntentId: this.ids.nextEffectIntentId()
    };
    const scopes = [...new Set([token.conversationId, bridge.sourceConversationId, ...closureConversationIds])].sort() as ConversationId[];
    const sourceKey = callbackSource(this.ids.nextCallbackEventId());
    const command: InternalCommandEnvelope<JsonValue> = {
      sourceKey,
      type: 'answer_bridge.interrupt',
      scope: { kind: 'multi_conversation', ids: scopes },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    };
    const declaredView = this.interruptChildHandler.requiredView(command);
    const executionViewSpec = ownedChild ? {
      ...declaredView,
      closedRunGraphRoots: [ownedChild.childRunId],
      closedRunGraphModes: ['foreground', 'background'] as const
    } : declaredView;
    const result = await this.executeInternal(command, this.interruptChildHandler, executionViewSpec);
    await this.failCurrentToolCallbackIfRejected(token, input.toolCallId, 'answer_bridge.interrupt', result);
    this.wake(scopes);
  }

  private async submitAgentAnswer(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    const input = rawPayload as unknown as { toolCallId: ToolCallId; argsJson: string };
    let args: { answerBridgeId?: string; title?: string; content?: string };
    try { args = input.argsJson ? JSON.parse(input.argsJson) as typeof args : {}; }
    catch (error) {
      const message = `submit_agent_answer 参数不是合法 JSON: ${String(error)}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const childFacts = await this.loadCommittedFacts(token.conversationId);
    const defaultBridgeId = childFacts.runSources.find((source) => source.runId === requireTokenRunOwner(token))?.answerBridgeId;
    const bridgeId = args.answerBridgeId?.trim() || defaultBridgeId?.trim();
    const title = args.title?.trim();
    const content = args.content;
    if (!bridgeId || !title || !content?.trim()) {
      const message = 'submit_agent_answer 需要可解析的 answerBridgeId、title 和 content。';
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const bridge = await this.resolveAnswerBridge(bridgeId);
    if (!bridge || bridge.targetConversationId !== token.conversationId) {
      const message = `AnswerBridge 不存在或不属于当前子对话：${bridgeId}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const payload: SubmitAnswerPayload = {
      ...token,
      bridgeId: bridge.bridgeId as SubmitAnswerPayload['bridgeId'],
      submitterToolCallId: input.toolCallId,
      submissionId: this.ids.nextAnswerSubmissionId(),
      title,
      content,
      responseMessageId: this.ids.nextMessageId(),
      responseRevisionId: this.ids.nextMessageRevisionId(),
      nextInvocationId: this.ids.nextInvocationId(),
      nextRequestId: this.ids.nextRequestId(),
      nextOperationId: this.ids.nextOperationId(),
      nextAttemptId: this.ids.nextAttemptId(),
      nextEffectIntentId: this.ids.nextEffectIntentId()
    };
    const sourceKey = callbackSource(this.ids.nextCallbackEventId());
    const result = await this.executeInternal({
      sourceKey,
      type: 'answer.submit',
      scope: { kind: 'multi_conversation', ids: [bridge.sourceConversationId, bridge.targetConversationId].sort() as ConversationId[] },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, this.submitAnswerHandler);
    await this.failCurrentToolCallbackIfRejected(token, input.toolCallId, 'answer.submit', result);
    this.wake([bridge.sourceConversationId, bridge.targetConversationId]);
  }

  private async failCurrentToolCallbackIfRejected(
    token: AttemptToken,
    toolCallId: ToolCallId,
    callbackType: string,
    result: { status: string; result: JsonValue }
  ): Promise<void> {
    if (result.status === 'committed' || result.status === 'already_applied') return;
    const current = matchCurrentAttempt(await this.loadCommittedFacts(token.conversationId), token);
    if (current.status !== 'matched') return;
    const reason = jsonResultReason(result.result) ?? `${callbackType} returned ${result.status}`;
    await this.finishTool(token, toolCallId, { ok: false, output: { error: reason } }, 0, reason);
  }

  private async readAgentAnswer(token: AttemptToken, rawPayload: JsonValue): Promise<void> {
    const input = rawPayload as unknown as { toolCallId: ToolCallId; argsJson: string };
    let answerBridgeId = '';
    try {
      const args = input.argsJson ? JSON.parse(input.argsJson) as { answerBridgeId?: unknown } : {};
      answerBridgeId = typeof args.answerBridgeId === 'string' ? args.answerBridgeId.trim() : '';
    } catch (error) {
      const message = `read_agent_answer 参数不是合法 JSON: ${String(error)}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    if (!answerBridgeId) {
      const message = 'read_agent_answer 缺少 answerBridgeId。';
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const indexed = await this.resolveAnswerBridge(answerBridgeId);
    let output: JsonValue;
    if (!indexed) {
      output = { ok: false, answerBridgeId, status: 'not_found', error: `未找到 answerBridgeId：${answerBridgeId}` };
    } else {
      const [source, target] = await Promise.all([
        this.loadCommittedFacts(indexed.sourceConversationId),
        this.loadCommittedFacts(indexed.targetConversationId)
      ]);
      const bridge = uniqueRecord(source.answerBridges, answerBridgeId, 'AnswerBridge');
      const submission = bridge?.currentSubmissionId ? uniqueRecord(source.answerSubmissions, bridge.currentSubmissionId, 'AnswerSubmission') : undefined;
      const answer = submission ? uniqueRecord(source.answerPayloads, submission.payloadRef, 'AnswerPayload') : undefined;
      if (bridge && submission && answer) {
        output = { ok: true, answerBridgeId, submissionId: submission.id, revisionNo: submission.revisionNo, title: answer.title, content: answer.content };
      } else {
        const active = target.turns.some((turn) => turn.lifecycle === 'active');
        output = active
          ? { ok: false, answerBridgeId, status: 'running', error: '对应子 Agent 仍在运行，尚未提交回答。' }
          : { ok: false, answerBridgeId, status: 'interrupted', error: '对应子 Agent 当前没有活动 Run，也没有已提交回答。' };
      }
    }
    await this.finishTool(token, input.toolCallId, { ok: true, output }, 0);
  }

  private async applyToolChange(token: AttemptToken, payload: JsonValue): Promise<void> {
    const input = payload as unknown as {
      toolCallId: ToolCallId;
      proposal: Parameters<RuntimeEnv['fs']['applyPendingFileChange']>[0];
      workEnvironment?: WorkEnvironmentRecord;
      accessibleWorkEnvironments?: WorkEnvironmentRecord[];
      allowOutsideProjectPaths?: boolean;
    };
    const startedAt = Date.now();
    try {
      let output: Awaited<ReturnType<RuntimeEnv['fs']['applyPendingFileChange']>>;
      try {
        output = await this.options.env.fs.applyPendingFileChange(input.proposal, {
          workEnvironment: input.workEnvironment,
          accessibleWorkEnvironments: input.accessibleWorkEnvironments,
          allowOutsideProjectPaths: input.allowOutsideProjectPaths === true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.finishTimedTool(
          token,
          input.toolCallId,
          'file_change.apply',
          'applying_change',
          { ok: false, output: { error: message } },
          Date.now() - startedAt,
          message
        );
        return;
      }

      const result: ToolResultOut = {
        ok: output.success,
        output,
        ...(output.kind === 'file_edit.result' && output.failed > 0 ? { status: 'warning' } : {})
      };
      const reviewResult = payload !== null && !Array.isArray(payload) && typeof payload === 'object' && payload.autoSubmitResult === false;
      await this.finishTimedTool(
        token,
        input.toolCallId,
        'file_change.apply',
        'applying_change',
        result,
        Date.now() - startedAt,
        output.success ? undefined : '文件变更应用失败。',
        reviewResult
      );
      try {
        await this.options.env.fs.closePendingFileChangeDiff(input.toolCallId, token.conversationId);
      } catch (error) {
        this.options.onIntegrityError?.(token.conversationId, error);
      }
    } finally {
      this.finishAttempt(token);
    }
  }

  private async executeRuntimeTool(token: AttemptToken, payload: JsonValue): Promise<void> {
    const input = payload as unknown as {
      toolCallId: ToolCallId;
      name: string;
      argsJson: string;
      runId?: string;
      conversationId?: string;
      rejectedReason?: string;
      config?: ToolConfigRecord;
      settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
      workEnvironment?: unknown;
      workEnvironments?: unknown[];
      accessibleWorkEnvironments?: unknown[];
      autoApplyChange?: boolean;
      autoSubmitResult?: boolean;
    };
    if (input.rejectedReason) {
      await this.finishTool(token, input.toolCallId, { ok: false, output: { denied: true, reason: input.rejectedReason } }, 0, input.rejectedReason);
      this.finishAttempt(token);
      return;
    }
    const definition = this.options.env.tools.registry.find((candidate) => candidate.declaration.name === input.name);
    if (!definition || definition.execution !== 'runtime') {
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: `Unknown runtime tool: ${input.name}` } }, 0, `Unknown runtime tool: ${input.name}`);
      return;
    }
    let args: unknown;
    try { args = input.argsJson ? JSON.parse(input.argsJson) : {}; }
    catch (error) {
      const message = `Invalid args JSON: ${String(error)}`;
      await this.finishTool(token, input.toolCallId, { ok: false, output: { error: message } }, 0, message);
      return;
    }
    const key = attemptKey(token.attemptId, token.generation);
    const controller = new AbortController();
    this.toolControllers.set(key, controller);
    this.runtimeLeases.register({
      key,
      ownerId: token.attemptId,
      generation: token.generation,
      kind: 'tool',
      externalIds: [input.toolCallId],
      abort: () => {
        if (this.toolControllers.get(key) === controller) this.toolControllers.delete(key);
        controller.abort();
      }
    });
    const startedAt = Date.now();
    const emit = (event: ToolRuntimeEvent): void => {
      if (this.disposed || this.toolControllers.get(key) !== controller) return;
      const state: ToolStatePayload = {
        toolCallId: input.toolCallId,
        status: 'executing',
        attemptId: token.attemptId,
        generation: token.generation,
        eventKind: event.kind,
        ...(event.delta !== undefined ? { delta: event.delta } : {}),
        ...(event.progress !== undefined || event.payload !== undefined ? { progress: event.progress ?? event.payload } : {})
      };
      this.options.world.enqueue({ type: ToolEventType.State, payload: state });
    };
    try {
      let result: ToolResultOut;
      let executionError: string | undefined;
      try {
        result = await definition.execute(
          args,
          {
            fs: this.options.env.fs,
            command: this.options.env.command,
            workEnvironment: this.options.env.workEnvironment,
            storage: this.options.env.storage,
            skills: this.options.env.skills
          },
          {
            toolCallId: input.toolCallId,
            runId: input.runId,
            conversationId: input.conversationId,
            attemptId: token.attemptId,
            generation: token.generation,
            config: input.config,
            settingsSnapshot: input.settingsSnapshot,
            workEnvironment: input.workEnvironment as never,
            workEnvironments: input.workEnvironments as never,
            accessibleWorkEnvironments: input.accessibleWorkEnvironments as never,
            signal: controller.signal,
            emit
          }
        );
      } catch (error) {
        executionError = error instanceof Error ? error.message : String(error);
        result = { ok: false, output: { error: executionError } };
      }
      if (this.disposed || this.toolControllers.get(key) !== controller) return;
      await this.finishTimedTool(
        token,
        input.toolCallId,
        input.name,
        'executing',
        result,
        Date.now() - startedAt,
        executionError,
        input.autoSubmitResult === false && result.status !== 'awaiting_change_apply'
      );
    } finally {
      this.toolControllers.delete(key);
      this.finishAttempt(token);
    }
  }

  /**
   * Delivers one persisted BackgroundProcess exit receipt into the reliable conversation log.
   * This entry point is intentionally independent of toolControllers: the Tool Attempt may have
   * completed long before the process reaches a terminal state.
   */
  public async deliverBackgroundProcessExit(
    envelope: BackgroundProcessDeliveryEnvelope
  ): Promise<{ status: 'delivered' } | { status: 'stale'; reason: string }> {
    if (this.disposed) throw new Error('PrimaryEffectDispatcher is disposed.');
    const { process, origin, receipt, delivery } = envelope;
    const expectedSourceKey = backgroundProcessDeliverySourceKey(process.processId, receipt.terminalRevision);
    if (delivery.sourceKey !== expectedSourceKey
      || delivery.processId !== process.processId
      || receipt.processId !== process.processId
      || origin.processId !== process.processId
      || origin.backgroundProcessId !== process.id
      || receipt.backgroundProcessId !== process.id) {
      throw new Error(`BackgroundProcess delivery identity mismatch: ${delivery.id}`);
    }

    const conversationId = origin.conversationId as ConversationId;
    const sourceKey = delivery.sourceKey;
    const sourceRunId = origin.sourceRunId as RunId;
    const notification: BackgroundProcessExitNotificationPayload = {
      conversationId,
      sourceRunId,
      sourceToolCallId: origin.sourceToolCallId as ToolCallId,
      processId: process.processId,
      terminalRevision: receipt.terminalRevision,
      completion: normalizeBackgroundProcessCompletionPayload({
        processId: process.processId,
        toolName: process.toolName,
        command: receipt.command,
        cwd: receipt.cwd,
        status: receipt.status,
        exitCode: receipt.exitCode,
        killed: receipt.killed,
        stdout: receipt.stdoutTail,
        stderr: receipt.stderrTail,
        ...(receipt.droppedChars > 0 ? { droppedChars: receipt.droppedChars } : {})
      })
    };
    const command: InternalCommandEnvelope<JsonValue> = {
      sourceKey,
      type: 'background_process.exit',
      scope: { kind: 'conversation', id: conversationId },
      occurredAt: receipt.exitedAt,
      payload: jsonValue(notification)
    };

    for (;;) {
      if (this.disposed) throw new Error('PrimaryEffectDispatcher is disposed.');
      try {
        const resolved = await this.options.adapter.resolveForegroundRunGraphScope(conversationId, this.runtimeReadAccess());
        const base = this.backgroundProcessExitHandler.requiredView(command);
        const executionViewSpec = {
          ...base,
          conversations: resolved.conversationIds,
          timeline: resolved.conversationIds.map((id) => ({ conversationId: id, throughTail: true })),
          closedRunGraphRoots: resolved.rootRunIds,
          closedRunGraphModes: ['foreground'] as const,
          storageResourceKeys: [
            ANSWER_BRIDGE_RESOURCE_KEY,
            CONVERSATION_ATTACHMENTS_RESOURCE_KEY
          ],
          mergeConversationFacts: true,
          aggregateRootConversationId: conversationId
        };
        const result = await this.executeInternal(command, this.backgroundProcessExitHandler, executionViewSpec);
        if (result.status === 'stale') {
          const value = result.result;
          const reason = value && !Array.isArray(value) && typeof value === 'object' && typeof value.reason === 'string'
            ? value.reason
            : 'background_process_notification_stale';
          return { status: 'stale', reason };
        }
        this.wake([conversationId]);
        return { status: 'delivered' };
      } catch (error) {
        if (!(error instanceof DurableScopeIncompleteError)) throw error;
      }
    }
  }


  private async finishTimedTool(
    token: AttemptToken,
    toolCallId: ToolCallId,
    toolName: string,
    projectionStatus: 'executing' | 'applying_change',
    result: ToolResultOut,
    executionDurationMs: number,
    error?: string,
    requireResultReview = false
  ): Promise<void> {
    // 仅更新内存 ECS 投影，让 UI 能区分“外部能力仍在执行”和“可靠终态正在提交”。
    // 该 progress 不进入 durable transition，避免观测本身制造额外 I/O。
    this.options.world.enqueue({
      type: ToolEventType.State,
      payload: {
        toolCallId,
        status: projectionStatus,
        attemptId: token.attemptId,
        generation: token.generation,
        eventKind: 'progress',
        progress: { phase: 'finalizing', executionDurationMs }
      }
    });
    const finalizationStartedAt = Date.now();
    const toolEntity = this.options.world.entityByRecordId(ToolCall, toolCallId);
    const toolCreatedAt = toolEntity === undefined ? undefined : this.options.world.get(toolEntity, ToolCall)?.createdAt;
    const preExecutionMs = toolCreatedAt === undefined
      ? 0
      : Math.max(0, finalizationStartedAt - executionDurationMs - toolCreatedAt);
    try {
      await this.finishTool(token, toolCallId, result, executionDurationMs, error, requireResultReview);
    } finally {
      logSlowToolPhases({
        toolName,
        conversationId: token.conversationId,
        toolCallId,
        attemptId: token.attemptId,
        preExecutionMs,
        executionMs: executionDurationMs,
        finalizationMs: Date.now() - finalizationStartedAt,
        outcome: result.status ?? (result.ok ? 'success' : 'error'),
        resultReview: requireResultReview
      });
    }
  }

  private async finishTool(
    token: AttemptToken,
    toolCallId: ToolCallId,
    result: ToolResultOut,
    durationMs: number,
    error?: string,
    requireResultReview = false
  ): Promise<void> {
    const completedAt = Date.now();
    const rawResult = jsonValue(result.output ?? null);
    const finalStatus = result.status === 'warning' ? 'warning' as const : result.ok ? 'success' as const : 'error' as const;
    const preparedResult = prepareToolResultContent(rawResult);
    const staged = preparedResult.staged;
    const toolEntity = this.options.world.entityByRecordId(ToolCall, toolCallId);
    const toolName = toolEntity === undefined ? undefined : this.options.world.get(toolEntity, ToolCall)?.name;
    if (!toolName) throw new Error(`ToolResult cannot resolve ToolCall name: ${toolCallId}`);
    const modelResponse = modelResponseForToolResult({
      toolName,
      status: finalStatus,
      result: rawResult,
      ...(error ? { error } : {})
    });
    const resultArtifactId = this.ids.nextToolResultArtifactId();
    const resultLinkId = this.ids.nextRelationId();
    const payload: ToolCompletedCallbackPayload = {
      ...token,
      toolCallId,
      outcome: result.status === 'awaiting_change_apply'
        ? 'awaiting_change_apply'
        : requireResultReview
          ? 'awaiting_result_submit'
          : result.ok
            ? 'succeeded'
            : 'failed',
      finalStatus,
      resultArtifact: {
        id: resultArtifactId,
        conversationId: token.conversationId,
        ...staged,
        modelResponse,
        createdAt: completedAt
      },
      resultLink: {
        id: resultLinkId,
        conversationId: token.conversationId,
        toolCallId,
        artifactId: resultArtifactId,
        role: 'final',
        createdAt: completedAt,
        updatedAt: completedAt
      },
      modelResponse,
      ...(result.parts?.length ? { responseParts: cloneJson(result.parts) } : {}),
      ...(error ? { error } : {}),
      durationMs,
      completedAt,
      ...(result.status === 'awaiting_change_apply' ? { interactionRequestId: this.ids.nextInteractionRequestId() } : {}),
      responseMessageId: this.ids.nextMessageId(),
      responseRevisionId: this.ids.nextMessageRevisionId(),
      nextInvocationId: this.ids.nextInvocationId(),
      nextRequestId: this.ids.nextRequestId(),
      nextOperationId: this.ids.nextOperationId(),
      nextAttemptId: this.ids.nextAttemptId(),
      nextEffectIntentId: this.ids.nextEffectIntentId()
    };
    await this.enqueueToolCompletion(payload, preparedResult, token.ownerRunId);
  }

  private enqueueToolCompletion(payload: ToolCompletedCallbackPayload, preparedResult: PreparedToolResultContent, ownerRunId?: RunId): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const queue = this.toolCompletionQueues.get(payload.conversationId);
      const entry = { payload, preparedResult, ownerRunId, resolve, reject };
      if (queue) queue.push(entry);
      else this.toolCompletionQueues.set(payload.conversationId, [entry]);
      this.scheduleToolCompletionFlush(payload.conversationId);
    });
  }

  private scheduleToolCompletionFlush(conversationId: ConversationId): void {
    if (this.toolCompletionFlushes.has(conversationId)) return;
    // 让同一模型轮次、同一事件循环附近完成的并行工具共享一个 durable final transaction。
    // 8ms 只位于外部能力已经结束后的提交边界，不会拉长工具实际执行时间。
    const task = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void this.flushToolCompletions(conversationId).then(resolve, reject);
      }, TOOL_COMPLETION_COALESCE_MS);
    });
    this.toolCompletionFlushes.set(conversationId, task);
    void task
      .catch((error) => this.options.onIntegrityError?.(conversationId, error))
      .finally(() => {
        if (this.toolCompletionFlushes.get(conversationId) === task) this.toolCompletionFlushes.delete(conversationId);
        if ((this.toolCompletionQueues.get(conversationId)?.length ?? 0) > 0 && !this.disposed) this.scheduleToolCompletionFlush(conversationId);
      });
  }

  private async flushToolCompletions(conversationId: ConversationId): Promise<void> {
    for (;;) {
      const queue = this.toolCompletionQueues.get(conversationId);
      if (!queue || queue.length === 0) {
        this.toolCompletionQueues.delete(conversationId);
        return;
      }
      const batch = queue.splice(0);
      const payload: ToolCompletedBatchCallbackPayload = {
        conversationId,
        completions: batch.map((entry) => entry.payload)
      };
      try {
        const source = callbackSource(this.ids.nextCallbackEventId());
        const result = await this.executeInternal({
          sourceKey: source,
          type: 'tool.final_batch',
          scope: { kind: 'conversation', id: conversationId },
          occurredAt: Date.now(),
          payload: jsonValue(payload)
        }, this.toolFinalBatchHandler, undefined, async (command) => ({
          ...command,
          payload: jsonValue(await this.prepareToolCompletionBatch(command.payload as unknown as ToolCompletedBatchCallbackPayload, batch))
        }));
        this.beginToolToModelPreparationTiming(result, batch);
        for (const entry of batch) entry.resolve();
        this.wake([conversationId]);
      } catch (error) {
        for (const entry of batch) entry.reject(error);
        this.options.onIntegrityError?.(conversationId, error);
      }
    }
  }

  private beginToolToModelPreparationTiming(
    result: { status: string; result: JsonValue },
    batch: readonly PendingToolCompletion[]
  ): void {
    if (result.status !== 'committed' || !jsonResultBoolean(result.result, 'continued')) return;
    const runIds = [...new Set(batch.map((entry) => entry.ownerRunId).filter((runId): runId is RunId => !!runId))];
    if (runIds.length !== 1) return;
    const runId = runIds[0]!;
    this.toolToModelPreparationTimings.set(runId, {
      conversationId: batch[0]!.payload.conversationId,
      runId,
      toolCallIds: batch.map((entry) => entry.payload.toolCallId),
      toolsCompletedAt: Math.max(...batch.map((entry) => entry.payload.completedAt)),
      finalizationCommittedAt: Date.now()
    });
  }

  private finishToolToModelPreparationTiming(token: AttemptToken): void {
    const runId = token.ownerRunId;
    if (!runId) return;
    const timing = this.toolToModelPreparationTimings.get(runId);
    if (!timing) return;
    this.toolToModelPreparationTimings.delete(runId);
    const llmStartedAt = Date.now();
    const totalMs = Math.max(0, llmStartedAt - timing.toolsCompletedAt);
    const preparationMs = Math.max(0, llmStartedAt - timing.finalizationCommittedAt);
    if (totalMs < SLOW_TOOL_PHASE_LOG_THRESHOLD_MS) return;
    console.info('[ReliabilityPerf] tool to model preparation', {
      conversationId: timing.conversationId,
      runId,
      toolCallIds: timing.toolCallIds,
      toolFinalizationAndPreparationMs: totalMs,
      postFinalizationPreparationMs: preparationMs
    });
  }

  private async prepareToolCompletionBatch(
    payload: ToolCompletedBatchCallbackPayload,
    batch: readonly PendingToolCompletion[]
  ): Promise<ToolCompletedBatchCallbackPayload> {
    if (payload.completions.length !== batch.length) throw new Error('Tool completion admission batch identity changed.');
    for (let index = 0; index < batch.length; index += 1) {
      const completion = payload.completions[index]!;
      const entry = batch[index]!;
      if (completion.toolCallId !== entry.payload.toolCallId
        || completion.resultArtifact.contentHash !== entry.preparedResult.staged.contentHash) {
        throw new Error(`Tool completion admission identity changed: ${completion.toolCallId}`);
      }
      const staged = await this.options.env.storage.stagePreparedToolResultContent(entry.preparedResult);
      if (canonicalSha256(staged) !== canonicalSha256(entry.preparedResult.staged)) {
        throw new Error(`Tool completion admission metadata changed: ${completion.toolCallId}`);
      }
    }

    const withAttachments = payload.completions.filter((completion) => (completion.responseParts?.length ?? 0) > 0);
    if (withAttachments.length === 0) return payload;

    const normalized = await this.options.env.storage.ingestMessageContentAttachments({
      role: 'user',
      parts: withAttachments.map((completion) => ({
        id: completion.toolCallId,
        functionResponse: {
          name: completion.toolCallId,
          response: null,
          parts: cloneJson(completion.responseParts!)
        }
      }))
    });
    const responsePartsByTool = new Map<string, NonNullable<ToolCompletedCallbackPayload['responseParts']>>();
    for (const part of normalized.parts) {
      if (!isFunctionResponsePart(part) || !part.id || !part.functionResponse.parts?.length) {
        throw new Error('Tool completion attachment admission returned an invalid canonical response.');
      }
      responsePartsByTool.set(part.id, cloneJson(part.functionResponse.parts));
    }
    if (responsePartsByTool.size !== withAttachments.length) {
      throw new Error('Tool completion attachment admission lost a response attachment group.');
    }
    return {
      ...payload,
      completions: payload.completions.map((completion) => completion.responseParts?.length
        ? { ...completion, responseParts: responsePartsByTool.get(completion.toolCallId)! }
        : completion)
    };
  }

  private async buildLlmRequest(
    token: AttemptToken,
    input: ReliableContextBuildInput,
    facts: DurableConversationFacts
  ): Promise<{ request: LlmStartRequest; contextProjection: ModelContextProjection }> {
    const run = this.options.world.entityByRecordId(AgentRun, input.runId);
    const conversation = this.options.world.entityByRecordId(Conversation, token.conversationId);
    const modelMessage = this.options.world.entityByRecordId(Message, input.modelMessageId);
    const invocation = this.options.world.entityByRecordId(LlmInvocation, input.invocationId);
    if (run === undefined || conversation === undefined || modelMessage === undefined || invocation === undefined) {
      throw new Error(`Committed context projection is incomplete for Request ${input.requestId}.`);
    }
    const sourceConversationIds = [...new Set(facts.runSources
      .filter((source) => source.runId === input.runId && source.sourceConversationId && source.sourceConversationId !== token.conversationId)
      .map((source) => source.sourceConversationId as ConversationId))];
    const sourceScopes = await Promise.all(sourceConversationIds.map((conversationId) => this.loadCommittedFacts(conversationId)));
    const worldFacts = modelContextTurnFactsFromWorld(this.options.world);
    const frozenContextPolicy = contextPolicyForRun(facts, input.runId);
    if (!frozenContextPolicy) throw new Error(`Run ${input.runId} has no frozen ContextPolicy.`);
    const policy = { id: runContextPolicyId(input.runId), ...frozenContextPolicy };
    const settingsSnapshot = this.options.world.get(invocation, LlmInvocation)?.settings;
    const contextProjection = projectModelContext({
      facts: modelContextFactsFromDurable([facts, ...sourceScopes], {
        runtimeContextSnapshots: worldFacts.runtimeContextSnapshots,
        runRuntimeContextSnapshotLinks: worldFacts.runRuntimeContextSnapshotLinks
      }),
      purpose: {
        kind: 'turn',
        mode: 'fresh',
        turn: {
          conversationId: token.conversationId,
          runId: input.runId,
          modelMessageId: input.modelMessageId,
          requestId: input.requestId,
          invocationId: input.invocationId
        },
        policy: { ...policy },
        ...(settingsSnapshot ? { settingsSnapshot } : {})
      }
    });
    const projectionErrors = contextProjection.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
    if (projectionErrors.length > 0) {
      throw new Error(`Committed context projection failed for Request ${input.requestId}: ${projectionErrors.map((item) => `${item.code}:${item.message}`).join('; ')}`);
    }
    const request = buildLlmStartRequestForRun(this.options.world, {
      run,
      conversation,
      modelMessage,
      invocation,
      requestId: input.requestId,
      contextProjection
    });
    if (!request) throw new Error(`Could not assemble committed LLM Request ${input.requestId}.`);
    return { request: cloneJson(request), contextProjection };
  }

  private async installTransientLlmRequest(token: AttemptToken, request: LlmStartRequest): Promise<void> {
    const durable = await this.loadCommittedFacts(token.conversationId);
    const requestFact = uniqueRecord(durable.requests, request.id, 'Request');
    if (!requestFact?.modelMessageId) throw new Error(`Durable Request ${request.id} has no model Message.`);
    await this.options.scheduler.runAtSafePoint(() => {
      const run = this.options.world.entityByRecordId(AgentRun, requireTokenRunOwner(token));
      const conversation = this.options.world.entityByRecordId(Conversation, token.conversationId);
      const invocationId = request.invocationId;
      const invocation = invocationId ? this.options.world.entityByRecordId(LlmInvocation, invocationId) : undefined;
      const modelMessage = this.options.world.entityByRecordId(Message, requestFact.modelMessageId!);
      if (run === undefined || conversation === undefined || modelMessage === undefined) throw new Error(`Cannot install transient LLM Request ${request.id}.`);
      const reliableStreamEpoch = {
        attemptId: token.attemptId,
        generation: token.generation,
        streamSeq: requestFact.streamSeq ?? 0
      };
      const existing = this.options.world.entityByRecordId(LlmRequest, request.id);
      if (existing !== undefined) {
        const current = this.options.world.get(existing, LlmRequest);
        if (!current || current.run !== run || current.conversation !== conversation || current.modelMessage !== modelMessage
          || current.invocation !== invocation
          || current.reliableStreamEpoch?.attemptId !== token.attemptId
          || current.reliableStreamEpoch?.generation !== token.generation) {
          throw new Error(`Transient LLM Request ${request.id} is already bound to another durable Attempt.`);
        }
        this.options.world.add(existing, LlmRequest, { ...current, reliableStreamEpoch });
        this.options.world.add(existing, InFlight, { kind: 'llm', startedAt: Date.now() });
        this.options.world.add(modelMessage, Streaming, true);
        return;
      }
      const entity = this.options.world.spawn();
      this.options.world.add(entity, LlmRequest, {
        id: request.id,
        run,
        conversation,
        modelMessage,
        ...(invocation !== undefined ? { invocation } : {}),
        reliableStreamEpoch
      });
      this.options.world.add(entity, InFlight, { kind: 'llm', startedAt: Date.now() });
      this.options.world.add(modelMessage, Streaming, true);
    });
  }

  private async createStreamBuffer(token: AttemptToken, request: LlmStartRequest): Promise<LlmStreamBuffer> {
    const facts = await this.loadCommittedFacts(token.conversationId);
    const durableRequest = facts.requests.find((candidate) => candidate.id === request.id);
    const message = durableRequest?.modelMessageId ? facts.messages.find((candidate) => candidate.id === durableRequest.modelMessageId) : undefined;
    if (!durableRequest || !message) throw new Error(`Durable Request projection is incomplete: ${request.id}`);
    const committedChars = messageCharacterCount(message.content);
    return {
      token,
      requestId: request.id as RequestId,
      invocationId: request.invocationId as InvocationId | undefined,
      content: cloneJson(message.content),
      toolCalls: [],
      streamSeq: durableRequest.streamSeq ?? 0,
      deltaCountSinceCheckpoint: 0,
      checkpointChars: committedChars,
      lastCheckpointChars: committedChars,
      lastCheckpointAt: Date.now()
    };
  }

  private sweepStreamCheckpoints(): Promise<void> {
    return this.streamCheckpointFileExecutor.run(['stream-checkpoint-files'], async () => {
      const referenced = new Set<string>();
      for (const rawId of uniqueSorted(this.options.conversationIds())) {
        const conversationId = rawId as ConversationId;
        if (!await this.options.adapter.readRuntime(conversationId)) continue;
        const facts = await this.loadCommittedFacts(conversationId);
        for (const head of facts.streamCheckpointHeads) referenced.add(head.file);
      }
      for (const file of await this.options.files.listFilesRecursive(STREAM_CHECKPOINT_ROOT)) {
        if (!referenced.has(file)) await this.options.files.remove(file);
      }
      this.lastStreamCheckpointGcAt = Date.now();
    });
  }

  private async sweepManagedAttachmentBlobs(): Promise<void> {
    const removed = await this.options.backend.sweepRebuildableGarbage(
      CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
      () => discoverOrphanedAttachmentBlobTargets(this.options.files)
    );
    this.managedAttachmentGcRequested = false;
    this.lastManagedAttachmentGcAt = Date.now();
    if (removed.length > 0) console.info(`[LimCode][Reliability] Removed ${removed.length} interrupted managed attachment blob(s).`);
  }

  private async sweepToolResultBlobs(): Promise<void> {
    const conversationIds = uniqueSorted(this.options.conversationIds()).map((id) => id as ConversationId);
    const removed = await this.options.backend.sweepRebuildableGarbage(
      TOOL_RESULT_BLOBS_RESOURCE_KEY,
      () => discoverOrphanedToolResultBlobTargets(this.options.files, conversationIds)
    );
    this.toolResultBlobGcRequested = false;
    this.lastToolResultBlobGcAt = Date.now();
    if (removed.length > 0) console.info(`[LimCode][Reliability] Removed ${removed.length} orphaned ToolResult blob(s).`);
  }

  private async runForegroundWaitDeadlines(facts: DurableConversationFacts): Promise<boolean> {
    const now = Date.now();
    let changed = false;
    for (const child of facts.childTurnLinks.filter((candidate) => candidate.mode === 'foreground'
      && candidate.foregroundDeadlineAt !== undefined && candidate.foregroundDeadlineAt <= now)) {
      if (facts.turns.some((run) => run.id === child.parentTurnId && run.phase === 'paused')) continue;
      if (!child.sourceToolCallId || child.foregroundDeadlineAt === undefined) {
        throw new Error(`Foreground ChildTurnLink ${child.id} has no ToolCall/deadline ownership.`);
      }
      const deadlineAt = child.foregroundDeadlineAt;
      const sourceKey = `internal:foreground-wait:${child.id}:${deadlineAt}`;
      const payload: ForegroundChildWaitElapsedPayload = {
        conversationId: facts.conversation.id,
        bridgeId: child.answerBridgeId,
        parentRunId: child.parentTurnId,
        parentToolCallId: child.sourceToolCallId,
        deadlineAt,
        backgroundResult: {
          ok: true,
          status: 'backgrounded',
          answerBridgeId: child.answerBridgeId,
          childRunId: child.childTurnId,
          conversationId: child.childConversationId
        },
        responseMessageId: stableIdFromSeed('message', `${sourceKey}:response-message`),
        responseRevisionId: stableIdFromSeed('messageRevision', `${sourceKey}:response-revision`),
        nextInvocationId: stableIdFromSeed('invocation', `${sourceKey}:next-invocation`),
        nextRequestId: stableIdFromSeed('request', `${sourceKey}:next-request`),
        nextOperationId: stableIdFromSeed('operation', `${sourceKey}:next-operation`),
        nextAttemptId: stableIdFromSeed('attempt', `${sourceKey}:next-attempt`),
        nextEffectIntentId: stableIdFromSeed('effectIntent', `${sourceKey}:next-effect`)
      };
      const result = await this.executeInternal({
        sourceKey,
        type: 'answer_bridge.foreground_wait_elapsed',
        scope: { kind: 'conversation', id: facts.conversation.id },
        occurredAt: now,
        payload: jsonValue(payload)
      }, this.foregroundWaitElapsedHandler);
      changed ||= result.status === 'committed';
      this.wake([facts.conversation.id]);
    }
    return changed;
  }

  private async runAutomaticHumanWaits(facts: DurableConversationFacts): Promise<boolean> {
    const openConversationIds = this.options.world.tryGetResource(OpenConversationPanelIdsKey);
    if (!openConversationIds || openConversationIds.includes(facts.conversation.id)) return false;
    let changed = false;
    for (const request of facts.interactionRequests.filter((candidate) => candidate.kind === 'ask_user'
      && candidate.state === 'pending')) {
      const owner = uniqueInteractionOwner(facts, request.id);
      if (!owner || !owner.sourceToolCallId || owner.conversationId !== facts.conversation.id) {
        throw new Error(`AskUser Interaction ${request.id} has no current owner closure.`);
      }
      if (facts.turns.some((run) => run.id === owner.turnId && run.phase === 'paused')) continue;
      const tool = uniqueRecord(facts.toolCalls, owner.sourceToolCallId, 'ToolCall');
      if (!tool || tool.name !== ASK_USER_TOOL_NAME || tool.status !== 'awaiting_user_input') continue;
      const sourceKey = `internal:ask-user-auto:${request.id}:${request.revision}`;
      const completedAt = Date.now();
      const ids = interactionResolutionIds(request.id, request.revision);
      const payload: ResolveInteractionCommandPayload = {
        conversationId: facts.conversation.id,
        interactionRequestId: request.id,
        interactionRevision: request.revision,
        ownerTurnId: owner.turnId,
        responseId: ids.responseId,
        decision: 'submit',
        actor: 'system',
        commandId: sourceKey,
        response: jsonValue({
          answer: {
            selectedOptionIndexes: [],
            customText: BACKGROUND_ASK_USER_AUTO_ANSWER
          }
        }),
        completedAt,
        ...ids.execution,
        ...ids.continuation
      };
      const result = await this.executeInternal({
        sourceKey,
        type: 'interaction.resolve',
        scope: { kind: 'conversation', id: facts.conversation.id },
        occurredAt: completedAt,
        payload: jsonValue(payload)
      }, this.resolveInteractionHandler);
      changed ||= result.status === 'committed';
      this.wake([facts.conversation.id]);
    }
    return changed;
  }

  private async runAutomaticToolWaits(facts: DurableConversationFacts): Promise<boolean> {
    let changed = false;
    for (const request of facts.interactionRequests.filter((candidate) =>
      candidate.kind === 'patch_approval'
      && candidate.state === 'pending'
      && candidate.policySnapshot.autoDecision === 'accept'
      && (candidate.policySnapshot.mode === 'auto_at' || candidate.policySnapshot.mode === 'auto_immediate'))) {
      const owner = uniqueInteractionOwner(facts, request.id);
      if (!owner) throw new Error(`Automatic InteractionRequest ${request.id} has no owner link.`);
      if (facts.turns.some((run) => run.id === owner.turnId && run.phase === 'paused')) continue;
      if (!owner.sourceToolCallId || request.policySnapshot.notBeforeAt === undefined) {
        throw new Error(`Automatic InteractionRequest ${request.id} has no ToolCall/deadline ownership.`);
      }
      const now = Date.now();
      if (!isAutomaticFileChangeInteractionDue(request, now)) continue;
      const sourceKey = `internal:interaction-auto:${request.id}:${request.revision}:${request.policySnapshot.notBeforeAt}`;
      const hydrated = await hydrateFileChangeResolutionPayload(fileChangeResolutionPayload({
        conversationId: facts.conversation.id,
        toolCallId: owner.sourceToolCallId,
        interactionRequestId: request.id,
        interactionRevision: request.revision,
        decision: 'accept',
        actor: 'policy',
        commandId: sourceKey,
        completedAt: now
      }), facts, this.options.env.storage);
      if (!hydrated.proposalArtifactId || !hydrated.proposalContentHash || hydrated.proposal === undefined) {
        throw new Error(`Automatic InteractionRequest ${request.id} has no immutable proposal attestation.`);
      }
      const ids = interactionResolutionIds(request.id, request.revision);
      const payload: ResolveInteractionCommandPayload = {
        conversationId: facts.conversation.id,
        interactionRequestId: request.id,
        interactionRevision: request.revision,
        ownerTurnId: owner.turnId,
        responseId: ids.responseId,
        decision: 'accept',
        actor: 'policy',
        commandId: sourceKey,
        response: jsonValue({ source: 'automatic_policy' }),
        completedAt: now,
        ...ids.execution,
        ...ids.continuation,
        patch: {
          proposalArtifactId: hydrated.proposalArtifactId,
          proposalContentHash: hydrated.proposalContentHash,
          proposal: jsonValue(hydrated.proposal)
        }
      };
      const result = await this.executeInternal({
        sourceKey,
        type: 'interaction.resolve',
        scope: { kind: 'conversation', id: facts.conversation.id },
        occurredAt: now,
        payload: jsonValue(payload)
      }, this.resolveInteractionHandler);
      changed ||= result.status === 'committed';
      this.wake([facts.conversation.id]);
    }
    return changed;
  }

  private async runChildTerminalInboxEmission(facts: DurableConversationFacts): Promise<boolean> {
    const candidate = facts.turns
      .filter((turn) => turn.phase === 'terminal')
      .flatMap((turn) => facts.runSources
        .filter((source) => source.runId === turn.id
          && !!source.answerBridgeId
          && !!source.sourceConversationId
          && !!source.sourceRunId)
        .map((source) => ({ turn, source })))
      .sort((left, right) => (left.turn.completedAt ?? left.turn.updatedAt) - (right.turn.completedAt ?? right.turn.updatedAt)
        || left.turn.id.localeCompare(right.turn.id))
      .find(({ turn, source }) => !this.emittedChildTerminalKeys.has(`${source.answerBridgeId}:${turn.id}:${turn.lifecycle}:${turn.completedAt ?? turn.updatedAt}`));
    if (!candidate) return false;
    const { turn, source } = candidate;
    const key = `${source.answerBridgeId}:${turn.id}:${turn.lifecycle}:${turn.completedAt ?? turn.updatedAt}`;
    const sourceConversationId = source.sourceConversationId as ConversationId;
    await this.options.prepareConversationOwnership(sourceConversationId);
    const payload: RecordChildTerminalPayload = {
      sourceConversationId,
      targetConversationId: facts.conversation.id,
      parentTurnId: source.sourceRunId as RunId,
      childTurnId: turn.id,
      answerBridgeId: source.answerBridgeId!
    };
    const sourceKey = `internal:child-terminal:${key}`;
    const result = await this.executeInternal({
      sourceKey,
      type: 'runtime_inbox.child_terminal',
      scope: { kind: 'multi_conversation', ids: [sourceConversationId, facts.conversation.id].sort() as ConversationId[] },
      occurredAt: turn.completedAt ?? turn.updatedAt,
      payload: jsonValue(payload)
    }, this.childTerminalInboxHandler);
    if (result.status === 'committed' || result.status === 'already_applied') {
      this.emittedChildTerminalKeys.add(key);
      this.wake([sourceConversationId]);
    }
    return result.status === 'committed';
  }

  private async runRuntimeDeliveryReconciliation(observed: DurableConversationFacts): Promise<boolean> {
    if (!observed.runtimeDeliveryLinks.some((delivery) => delivery.state === 'pending')) return false;
    const view = await this.options.backend.readCommittedView(committedReadView('runtime-delivery.reconcile.read', observed.conversation.id));
    const facts = view.facts;
    const pending = pendingRuntimeDeliveries(facts);
    if (pending.length === 0) return false;
    const activeLeases = facts.executionLeases.filter((lease) => lease.conversationId === facts.conversation.id && lease.state !== 'released');
    if (activeLeases.length > 1) throw new Error(`Conversation ${facts.conversation.id} has multiple active ExecutionLeases.`);
    const resumeOwner = pending.find(({ delivery }) => delivery.policy === 'resume_owner');
    let selected;
    if (resumeOwner) {
      selected = [resumeOwner];
    } else if (activeLeases.length === 0) {
      const first = pending.find(({ delivery }) => delivery.policy !== 'defer_until_next_user_turn');
      if (!first) return false;
      selected = pending.filter(({ delivery }) => delivery.ownerTurnId === first.delivery.ownerTurnId
        && delivery.policy !== 'defer_until_next_user_turn');
    } else {
      // inject_current_or_continue is consumed by the next proven LLM/tool continuation boundary.
      return false;
    }
    const controlVersion = view.baseVersions.get(facts.conversation.id);
    if (controlVersion === undefined) throw new Error(`RuntimeDelivery reconciliation view has no controlVersion for ${facts.conversation.id}.`);
    const deliveries = selected.map(({ delivery }) => ({ id: delivery.id, rowVersion: delivery.rowVersion }));
    const sourceKey = `internal:runtime-delivery:${facts.conversation.id}:${controlVersion}:${canonicalSha256(deliveries)}`;
    const payload: ReconcileRuntimeDeliveryPayload = { conversationId: facts.conversation.id, deliveries };
    const result = await this.executeInternal({
      sourceKey,
      type: 'runtime_delivery.reconcile',
      scope: { kind: 'conversation', id: facts.conversation.id },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, this.runtimeDeliveryReconcileHandler);
    const changed = result.status === 'committed';
    if (changed) this.wake([facts.conversation.id]);
    return changed;
  }

  private async runReliableAutoCompression(observed: DurableConversationFacts): Promise<boolean> {
    // `observed` came from the scan's committed view. Most scans cannot possibly start automatic
    // compression, so avoid reacquiring and reloading the same authoritative view unless the cheap
    // pure inspection finds a real candidate. Any concurrent change is level-triggered and wakes a
    // later scan; the leased view below still owns the final decision and source controlVersion.
    if (inspectReliablePostResponseAutoCompression(observed).kind !== 'candidate') return false;
    const view = await this.options.backend.readCommittedView(committedReadView('compression.auto.read', observed.conversation.id));
    const facts = view.facts;
    const decision = planReliablePostResponseAutoCompression(facts, Date.now());
    if (decision.kind !== 'ready') return false;
    const controlVersion = view.baseVersions.get(facts.conversation.id);
    if (controlVersion === undefined) throw new Error(`Auto-compression view has no controlVersion for ${facts.conversation.id}.`);

    const payload: StartAutoCompressionPayload = {
      conversationId: facts.conversation.id,
      invocationId: decision.anchor.invocationId,
      modelMessageId: decision.anchor.modelMessageId,
      seed: decision.anchor.seed,
      operationId: decision.identity.operationId,
      attemptId: decision.identity.attemptId,
      effectIntentId: decision.identity.effectIntentId
    };
    // The reconciliation source is versioned so a temporary CAS loss cannot consume the stable
    // invocation/message anchor forever. All generated domain IDs remain anchored only to seed.
    const sourceKey = `internal:auto-compression:${facts.conversation.id}:${controlVersion}:${decision.anchor.invocationId}:${decision.anchor.modelMessageId}`;
    const result = await this.executeInternal({
      sourceKey,
      type: 'compression.auto.start',
      scope: { kind: 'conversation', id: facts.conversation.id },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, this.autoCompressionHandler);
    this.wake([facts.conversation.id]);
    return result.status === 'committed';
  }

  private async runQueuedAdmission(observed: DurableConversationFacts): Promise<boolean> {
    const observedLease = observed.executionLeases.find((lease) => lease.conversationId === observed.conversation.id);
    if (observedLease && observedLease.state !== 'released') return false;
    if (!observed.turnIntents.some((intent) => intent.state === 'queued' && intent.hold === 'none')) return false;

    // Re-read the exact controlVersion used to derive the level-trigger source key. A stale condition
    // is consumed only for that version; every later intent/lease transition receives a new key.
    const view = await this.options.backend.readCommittedView(committedReadView('turnIntent.admission.read', observed.conversation.id));
    const facts = view.facts;
    const lease = facts.executionLeases.find((candidate) => candidate.conversationId === facts.conversation.id);
    if (lease && lease.state !== 'released') return false;
    const intent = facts.turnIntents
      .filter((candidate) => candidate.conversationId === facts.conversation.id && candidate.state === 'queued' && candidate.hold === 'none')
      .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))[0];
    if (!intent) return false;
    const controlVersion = view.baseVersions.get(facts.conversation.id);
    if (controlVersion === undefined) throw new Error(`TurnIntent admission view has no controlVersion for ${facts.conversation.id}.`);

    const sourceKey = `internal:turn-intent-admit:${facts.conversation.id}:${controlVersion}:${intent.id}:${intent.rowVersion}`;
    const payload: AdmitTurnIntentPayload = {
      conversationId: facts.conversation.id,
      intentId: intent.id,
      intentRowVersion: intent.rowVersion,
      operationId: stableIdFromSeed('operation', `${sourceKey}:operation`),
      attemptId: stableIdFromSeed('attempt', `${sourceKey}:attempt`),
      effectIntentId: stableIdFromSeed('effectIntent', `${sourceKey}:effect`)
    };
    await this.executeInternal({
      sourceKey,
      type: 'turnIntent.admit',
      scope: { kind: 'conversation', id: facts.conversation.id },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, this.queueAdmissionHandler);
    this.wake([facts.conversation.id]);
    return true;
  }

  private async runWatchdogs(facts: DurableConversationFacts): Promise<boolean> {
    const now = Date.now();
    let changed = false;
    for (const attempt of facts.attempts.filter((candidate) => (candidate.state === 'pending' || candidate.state === 'dispatched') && candidate.deadlineAt <= now)) {
      const operation = facts.operations.find((candidate) => candidate.id === attempt.operationId && candidate.currentGeneration === attempt.generation && (candidate.state === 'pending' || candidate.state === 'running'));
      if (!operation) continue;
      const owner = isConversationOperationOwner(operation)
        ? undefined
        : facts.turns.find((candidate) => candidate.id === operation.ownerRunId);
      if (owner?.phase === 'paused' && facts.pauses.some((pause) => pause.runId === owner.id && pause.reason === 'manual')) continue;
      const sourceKey = `internal:watchdog:${attempt.id}:${attempt.generation}:${attempt.deadlineAt}`;
      const payload: WatchdogPayload = {
        conversationId: operation.conversationId,
        operationId: operation.id,
        attemptId: attempt.id,
        generation: attempt.generation,
        replacementAttemptId: stableIdFromSeed('attempt', `${sourceKey}:replacement-attempt`),
        replacementEffectIntentId: stableIdFromSeed('effectIntent', `${sourceKey}:replacement-effect`)
      };
      const result = await this.executeInternal({
        sourceKey,
        type: 'operation.watchdog',
        scope: { kind: 'conversation', id: operation.conversationId },
        occurredAt: now,
        payload: payload as unknown as JsonValue
      }, this.watchdogHandler);
      changed ||= result.status === 'committed';
    }
    return changed;
  }

  private async handleSynchronousDispatchFailure(token: AttemptToken, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Reliability] Primary effect ${token.kind} failed at dispatch boundary:`, error);
    // Non-idempotent writes require explicit outcome resolution. Read/agent tools are safe to close
    // as failed and feed back to the model; leaving their dispatched Attempts alive would create an
    // artificial watchdog-sized scheduling stall.
    if (token.kind.startsWith('tool.read.') || token.kind.startsWith('tool.agent.')) {
      const facts = await this.loadCommittedFacts(token.conversationId);
      if (matchCurrentAttempt(facts, token).status === 'matched') {
        const execution = facts.toolExecutions.find((candidate) => candidate.operationId === token.operationId);
        if (execution) {
          await this.finishTool(token, execution.id, { ok: false, output: { error: message } }, 0, message);
          return;
        }
      }
    }
    if (!token.kind.startsWith('tool.write.')) {
      this.options.onIntegrityError?.(token.conversationId, new Error(`${token.kind}: ${message}`));
    }
  }

  private async failCurrentAttemptCallbackIfRejected(
    token: AttemptToken,
    callbackType: string,
    result: { status: string; result: JsonValue }
  ): Promise<void> {
    if (result.status !== 'stale') return;
    const facts = await this.loadCommittedFacts(token.conversationId);
    const current = matchCurrentAttempt(facts, token);
    if (current.status !== 'matched' || current.attempt.state !== 'dispatched') return;

    const reason = jsonResultReason(result.result) ?? 'callback_handler_rejected_current_attempt';
    const payload: RejectDispatchedAttemptPayload = {
      conversationId: token.conversationId,
      operationId: token.operationId,
      attemptId: token.attemptId,
      generation: token.generation,
      callbackType,
      reason
    };
    const sourceKey = `internal:callback-rejected:${token.attemptId}:${token.generation}:${canonicalSha256({ callbackType, reason })}`;
    const command: InternalCommandEnvelope<JsonValue> = {
      sourceKey,
      type: 'attempt.callback_rejected',
      scope: { kind: 'conversation', id: token.conversationId },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    };
    const resolved = await this.options.adapter.resolveForegroundRunGraphScope(token.conversationId, this.runtimeReadAccess());
    const base = this.rejectedAttemptHandler.requiredView(command);
    const executionViewSpec = {
      ...base,
      conversations: resolved.conversationIds,
      timeline: resolved.conversationIds.map((conversationId) => ({ conversationId, throughTail: true })),
      closedRunGraphRoots: resolved.rootRunIds,
      closedRunGraphModes: ['foreground'] as const,
      storageResourceKeys: [
        ANSWER_BRIDGE_RESOURCE_KEY,
        CONVERSATION_ATTACHMENTS_RESOURCE_KEY
      ],
      mergeConversationFacts: true,
      aggregateRootConversationId: token.conversationId
    };
    await this.executeInternal(command, this.rejectedAttemptHandler, executionViewSpec);
  }

  private enqueueCallback(token: AttemptToken, action: () => Promise<void>): void {
    if (this.disposed) return;
    const key = attemptKey(token.attemptId, token.generation);
    const previous = this.callbackQueues.get(key) ?? Promise.resolve();
    const next = previous.then(action, action).catch((error) => this.options.onIntegrityError?.(token.conversationId, error));
    const tracked = next.finally(() => {
      if (this.callbackQueues.get(key) === tracked) this.callbackQueues.delete(key);
    });
    this.callbackQueues.set(key, tracked);
  }

  private async executeCallback<TPayload extends object>(
    token: AttemptToken,
    sourceKey: string,
    type: string,
    payload: TPayload,
    handler: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['handler'],
    preparePayload?: (payload: TPayload) => Promise<TPayload>
  ): Promise<void> {
    const result = await this.executeInternal({
      sourceKey,
      type,
      scope: { kind: 'conversation', id: token.conversationId },
      occurredAt: Date.now(),
      payload: jsonValue(payload)
    }, handler, undefined, preparePayload
      ? async (command) => ({
          ...command,
          payload: jsonValue(await preparePayload(command.payload as unknown as TPayload))
        })
      : undefined);
    await this.failCurrentAttemptCallbackIfRejected(token, type, result);
    this.wake([token.conversationId]);
  }

  private async loadCommittedFacts(conversationId: ConversationId): Promise<DurableConversationFacts> {
    const view = await this.options.backend.readCommittedView(committedReadView('dispatcher.read', conversationId));
    return view.facts;
  }

  private async resolveReliableChildContinuation(bridgeId: string): Promise<ReliableChildContinuationTarget | undefined> {
    const indexed = await this.resolveAnswerBridge(bridgeId);
    if (!indexed) return undefined;
    await this.options.ensureConversationLoaded(indexed.targetConversationId);
    const target = await this.loadCommittedFacts(indexed.targetConversationId);
    const bridgeRunIds = new Set(target.runSources
      .filter((source) => source.answerBridgeId === bridgeId)
      .map((source) => source.runId));
    const agentIds = new Set(target.runTargets
      .filter((candidate) => bridgeRunIds.has(candidate.runId))
      .map((candidate) => candidate.agentId));
    if (agentIds.size !== 1) {
      throw new Error(`answerBridgeId 无法唯一解析目标 Agent：${bridgeId}`);
    }
    const agentId = [...agentIds][0];
    const agentEntity = this.options.world.entityByRecordId(Agent, agentId);
    const agentType = agentEntity === undefined ? undefined : this.options.world.get(agentEntity, AgentKind)?.kind;
    if (!agentType) throw new Error(`answerBridgeId 目标 Agent 投影不完整：${bridgeId}`);
    return {
      answerBridgeId: bridgeId,
      conversationId: indexed.targetConversationId,
      agentId,
      agentType
    };
  }

  private resolveAnswerBridge(bridgeId: string) {
    return this.options.adapter.resolveAnswerBridge(bridgeId, () => this.readAnswerBridgeLookup());
  }

  private readAnswerBridgeLookup() {
    return this.options.backend.readStorageResource(
      [ANSWER_BRIDGE_RESOURCE_KEY],
      () => this.options.adapter.readAnswerBridgeLookup()
    );
  }

  private runtimeReadAccess() {
    return {
      loadFacts: (conversationId: ConversationId) => this.loadCommittedFacts(conversationId),
      readAnswerBridgeLookup: () => this.readAnswerBridgeLookup()
    };
  }

  private async executeInternal(
    command: InternalCommandEnvelope<JsonValue>,
    handler: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['handler'],
    executionViewSpec?: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['executionViewSpec'],
    prepareCommand?: Parameters<FileConversationTransactionBackend['executeInternal']>[0]['prepareCommand']
  ) {
    const result = await this.options.backend.executeInternal({
      command,
      handler: handler as never,
      executionViewSpec: executionViewSpec as never,
      prepareCommand: prepareCommand as never,
      createPlanningContext: ({ transitionId, now }) => ({ transitionId, now, policySnapshot: null, ids: {} })
    });
    this.publish(result, command.sourceKey);
    return result;
  }

  private publish(result: Awaited<ReturnType<FileConversationTransactionBackend['executeInternal']>>, sourceKey: string): void {
    if (result.status !== 'committed') return;
    this.options.onCommitted?.(result.heads.map((head) => head.conversationId));
    for (const patch of result.patches) {
      const head = result.heads.find((candidate) => candidate.conversationId === patch.conversationId);
      if (!head) continue;
      this.options.env.webview.broadcastToStream(patch.streamId, {
        id: createMessageId(),
        type: BridgeMessageType.ConversationCommittedPatch,
        channel: 'state',
        scope: { kind: 'conversation', id: patch.conversationId },
        payload: {
          conversationId: patch.conversationId,
          streamId: patch.streamId,
          baseSeq: patch.baseSeq,
          nextSeq: patch.nextSeq,
          conversationVersion: head.version,
          commandIds: [],
          causes: [{ kind: sourceKey.startsWith('event:') ? 'callback' : sourceKey.startsWith('recovery:') ? 'recovery' : 'watchdog', id: sourceKey }],
          ...(patch.terminalStreamFences?.length ? { terminalStreamFences: patch.terminalStreamFences.map((fence) => ({ ...fence })) } : {}),
          operations: [...patch.operations]
        }
      });
    }
  }

  private finishAttempt(token: AttemptToken): void {
    const key = attemptKey(token.attemptId, token.generation);
    this.runtimeLeases.release(key);
    this.inFlight.delete(key);
    this.callbackQueues.delete(key);
    this.compressionRequests.delete(key);
    this.wake([token.conversationId]);
  }
}

interface ToolPhaseTimingSample {
  toolName: string;
  conversationId: ConversationId;
  toolCallId: ToolCallId;
  attemptId: AttemptId;
  preExecutionMs: number;
  executionMs: number;
  finalizationMs: number;
  outcome: string;
  resultReview: boolean;
}

function logSlowToolPhases(sample: ToolPhaseTimingSample): void {
  const totalMs = sample.preExecutionMs + sample.executionMs + sample.finalizationMs;
  if (totalMs < SLOW_TOOL_PHASE_LOG_THRESHOLD_MS) return;
  console.info('[ReliabilityPerf] tool phases', {
    toolName: sample.toolName,
    conversationId: sample.conversationId,
    toolCallId: sample.toolCallId,
    attemptId: sample.attemptId,
    outcome: sample.outcome,
    resultReview: sample.resultReview,
    preExecutionMs: sample.preExecutionMs,
    executionMs: sample.executionMs,
    finalizationMs: sample.finalizationMs,
    totalMs
  });
}

function asInterruptResult(answerBridgeId: string, conversationId: ConversationId): JsonValue {
  return {
    ok: true,
    mode: 'interrupt',
    cascadeChildAgents: true,
    answerBridgeId,
    conversationId,
    status: 'interrupt_committed',
    interruptRequested: true
  };
}

function pendingEffects(facts: DurableConversationFacts): ActiveEffect[] {
  const effects: ActiveEffect[] = [];
  const dispatchableTools = dispatchableToolOperationIds(facts);
  for (const attempt of facts.attempts) {
    if (attempt.state !== 'pending') continue;
    const operation = facts.operations.find((candidate) => candidate.id === attempt.operationId && candidate.currentGeneration === attempt.generation && (candidate.state === 'pending' || candidate.state === 'running'));
    if (!operation) continue;
    if (operation.kind.startsWith('tool.') && !dispatchableTools.has(operation.id)) continue;
    if (!isConversationOperationOwner(operation)) {
      const owner = facts.turns.find((candidate) => candidate.id === operation.ownerRunId);
      if (!owner || owner.phase === 'paused' || owner.phase === 'terminal') continue;
    }
    const descriptor = facts.primaryEffects.find((candidate) => candidate.operationId === operation.id && candidate.attemptId === attempt.id && candidate.generation === attempt.generation);
    if (!descriptor) throw new Error(`Pending Attempt ${attempt.id} has no PrimaryEffectDescriptor.`);
    if (descriptor.payloadRef.kind === 'released') throw new Error(`Pending primary effect payload was released before dispatch: ${descriptor.effectIntentId}`);
    const payload = facts.effectPayloads.find((candidate) => candidate.id === descriptor.payloadRef.id && candidate.operationId === operation.id);
    if (!payload || payload.payloadHash !== descriptor.payloadRef.hash || canonicalSha256(payload.payload) !== payload.payloadHash) {
      throw new Error(`Primary effect payload is missing or corrupt: ${descriptor.effectIntentId}`);
    }
    const definition = primaryEffectKinds.require(descriptor.kind);
    if (definition.recoveryPolicy !== descriptor.recoveryPolicy) throw new Error(`Primary effect recovery policy drift: ${descriptor.kind}`);
    effects.push({ facts, attempt, descriptor, payload: payload.payload });
  }
  return effects.sort((left, right) => left.attempt.deadlineAt - right.attempt.deadlineAt || left.attempt.id.localeCompare(right.attempt.id));
}

function tokenFor(effect: ActiveEffect): AttemptToken {
  return {
    conversationId: effect.attempt.conversationId,
    ownerKind: effect.attempt.ownerKind === 'conversation' ? 'conversation' : 'run',
    ...(effect.attempt.ownerRunId ? { ownerRunId: effect.attempt.ownerRunId } : {}),
    operationId: effect.attempt.operationId,
    attemptId: effect.attempt.id,
    generation: effect.attempt.generation,
    kind: effect.descriptor.kind
  };
}

function requireTokenRunOwner(token: AttemptToken): RunId {
  if (token.ownerKind !== 'run' || !token.ownerRunId) throw new Error(`Primary effect ${token.kind} is not owned by a Run.`);
  return token.ownerRunId;
}

function runToken(token: AttemptToken): AttemptToken & { ownerKind: 'run'; ownerRunId: RunId } {
  return { ...token, ownerKind: 'run', ownerRunId: requireTokenRunOwner(token) };
}

function callbackSource(eventId: CallbackEventId): string { return `event:${eventId}`; }

function attemptKey(attemptId: AttemptId, generation: number): string { return `${attemptId}:${generation}`; }

function appendVisibleText(buffer: LlmStreamBuffer, delta: string): void {
  if (!delta) return;
  const parts = [...buffer.content.parts];
  const last = parts[parts.length - 1];
  if (last && isTextPart(last) && last.thought !== true) parts[parts.length - 1] = { ...last, text: last.text + delta };
  else parts.push({ text: delta });
  buffer.content = { ...buffer.content, parts };
}

function appendThought(buffer: LlmStreamBuffer, payload: LlmThoughtDeltaPayload): void {
  if (!payload.text) return;
  const parts = [...buffer.content.parts];
  const last = parts[parts.length - 1];
  if (last && isTextPart(last) && last.thought === true && last.thoughtDurationMs === undefined) {
    parts[parts.length - 1] = { ...last, text: last.text + payload.text, ...(payload.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: payload.thoughtElapsedMs } : {}), ...(payload.thoughtSignature ? { thoughtSignature: payload.thoughtSignature } : {}) };
  } else {
    parts.push({ text: payload.text, thought: true, ...(payload.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: payload.thoughtElapsedMs } : {}), ...(payload.thoughtSignature ? { thoughtSignature: payload.thoughtSignature } : {}) });
  }
  buffer.content = { ...buffer.content, parts };
}

function updateThoughtProgress(buffer: LlmStreamBuffer, payload: LlmThoughtProgressPayload): void {
  const parts = [...buffer.content.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    parts[index] = { ...part, thoughtElapsedMs: payload.thoughtElapsedMs, ...(payload.thoughtSignature ? { thoughtSignature: payload.thoughtSignature } : {}) };
    buffer.content = { ...buffer.content, parts };
    return;
  }
}

function finishThought(buffer: LlmStreamBuffer, payload: LlmThoughtDonePayload): void {
  const parts = [...buffer.content.parts];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !isTextPart(part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    const { thoughtElapsedMs: _elapsed, ...rest } = part;
    parts[index] = { ...rest, thoughtDurationMs: payload.thoughtDurationMs, ...(payload.thoughtSignature ? { thoughtSignature: payload.thoughtSignature } : {}) };
    buffer.content = { ...buffer.content, parts };
    return;
  }
}

function appendToolCalls(buffer: LlmStreamBuffer, payload: LlmToolCallPayload): void {
  for (const call of payload.calls) {
    const functionCallId = canonicalFunctionCallId({
      providerId: call.id,
      requestId: buffer.requestId,
      name: call.name,
      argsJson: call.argsJson,
      ordinal: buffer.toolCalls.length
    });
    if (buffer.toolCalls.some((candidate) => candidate.functionCallId === functionCallId)) continue;
    buffer.toolCalls.push({ functionCallId, name: call.name, argsJson: call.argsJson, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) });
    let args: unknown;
    try { args = call.argsJson ? JSON.parse(call.argsJson) : {}; } catch { args = call.argsJson; }
    const part: ContentPart = { id: functionCallId, functionCall: { name: call.name, args }, ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}) };
    buffer.content = { ...buffer.content, parts: [...buffer.content.parts, part] };
  }
}

function resetForRetry(buffer: LlmStreamBuffer): void {
  buffer.content = { role: 'model', parts: [] };
  buffer.toolCalls = [];
  buffer.streamSeq += 1;
  buffer.deltaCountSinceCheckpoint = 0;
  buffer.checkpointChars = 0;
  buffer.lastCheckpointChars = 0;
}

function messageCharacterCount(content: MessageContent): number {
  return content.parts.reduce((total, part) => total + (isTextPart(part) ? part.text.length : 0), 0);
}

export function shouldCheckpointReliableStream(progress: Pick<LlmStreamBuffer, 'deltaCountSinceCheckpoint' | 'checkpointChars' | 'lastCheckpointChars'>): boolean {
  return progress.deltaCountSinceCheckpoint >= STREAM_CHECKPOINT_DELTA_INTERVAL
    && progress.checkpointChars - progress.lastCheckpointChars >= STREAM_CHECKPOINT_MIN_CHARS;
}

function requireLlmPipelineTiming(buffer: LlmStreamBuffer): LlmStreamPipelineTiming {
  buffer.pipelineTiming ??= {
    callbackEventCount: 0,
    callbackQueueDelayTotalMs: 0,
    callbackQueueDelayMaxMs: 0,
    transientWorldEnqueueCount: 0
  };
  return buffer.pipelineTiming;
}

function recordLlmCallbackTiming(buffer: LlmStreamBuffer, receivedAt: number, handledAt: number): void {
  const timing = requireLlmPipelineTiming(buffer);
  const queueDelayMs = Math.max(0, handledAt - receivedAt);
  timing.callbackEventCount += 1;
  timing.callbackQueueDelayTotalMs += queueDelayMs;
  timing.callbackQueueDelayMaxMs = Math.max(timing.callbackQueueDelayMaxMs, queueDelayMs);
  timing.firstCallbackReceivedAt ??= receivedAt;
  timing.lastCallbackHandledAt = handledAt;
}

function logLlmStreamPipelineTiming(
  buffer: LlmStreamBuffer,
  terminal: LlmDonePayload | LlmErrorPayload,
  finalizationStartedAt: number,
  finalizedAt: number
): void {
  const timing = requireLlmPipelineTiming(buffer);
  const callbackQueueMeanMs = timing.callbackEventCount > 0
    ? timing.callbackQueueDelayTotalMs / timing.callbackEventCount
    : 0;
  console.log('[LimCode][LlmStreamPipeline]', JSON.stringify({
    requestId: buffer.requestId,
    attemptId: buffer.token.attemptId,
    generation: buffer.token.generation,
    outcome: 'message' in terminal ? 'failed' : 'succeeded',
    outputChars: messageCharacterCount(buffer.content),
    finalStreamSeq: buffer.streamSeq,
    callbackEventCount: timing.callbackEventCount,
    transientWorldEnqueueCount: timing.transientWorldEnqueueCount,
    callbackQueueMeanMs: Number(callbackQueueMeanMs.toFixed(3)),
    callbackQueueMaxMs: timing.callbackQueueDelayMaxMs,
    providerStreamMs: terminal.streamOutputDurationMs,
    terminalToFinalizeStartMs: terminal.createdAt === undefined ? undefined : Math.max(0, finalizationStartedAt - terminal.createdAt),
    durableFinalizeMs: Math.max(0, finalizedAt - finalizationStartedAt),
    totalRuntimeMs: buffer.startedAt === undefined ? undefined : Math.max(0, finalizedAt - buffer.startedAt),
    providerAggregation: terminal.streamAggregation
  }));
}

function recoverableStreamContent(content: MessageContent): MessageContent {
  return cloneJson({
    ...content,
    // A ToolCall becomes authoritative only in the final callback that creates its ToolCall record.
    // An interrupted checkpoint must not leave an unpaired function call in future model context.
    parts: content.parts.filter((part) => !('functionCall' in part))
  });
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function jsonResultBoolean(value: JsonValue, key: string): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, JsonValue>)[key] === true;
}

function jsonResultReason(value: JsonValue): string | undefined {
  return value !== null && !Array.isArray(value) && typeof value === 'object' && typeof value.reason === 'string'
    ? value.reason
    : undefined;
}

function uniqueRecord<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} Stable ID conflict: ${id}`);
  return matches[0];
}

function withTransientStreamEpoch(event: WorldEvent, buffer: LlmStreamBuffer): WorldEvent {
  return {
    ...event,
    payload: {
      ...(event.payload as Record<string, unknown>),
      attemptId: buffer.token.attemptId,
      generation: buffer.token.generation,
      streamSeq: buffer.streamSeq
    }
  } as WorldEvent;
}

function assertNeverCleanupHint(value: never): never {
  throw new Error(`Unsupported cleanup hint: ${String(value)}`);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type ContentObjectIdentity,
  type ContentObjectMetadata
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { ContextSequenceControlPlane } from './contextSequence';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT,
  type ModelRequestCancelResult
} from './databaseWorkerProtocol';
import { frozenModelIdentity, readFrozenTurnAuthority } from './frozenAuthority';

export interface CreateModelRequestCommand {
  turnId: string;
  contextRootId: string;
  authoritySnapshotId: string;
  recipe: PlainJsonValue;
  settingsSnapshotContentObjectId?: string;
  idempotencyKey: string;
}

export interface ModelRequestCreationResult {
  modelRequestId: string;
  projectionId: string;
  operationId: string;
  attemptId: string;
  requestSeq: string;
  commitSeq?: string;
  deduplicated: boolean;
}

export interface FullProviderContextItem {
  segmentId: string;
  segmentKind: string;
  messageRole: string | null;
  contentType: string;
  content: string;
}

export interface FullProviderRequest {
  kind: 'full-model-request';
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  providerId: string;
  modelId: string;
  authoritySnapshot: PlainJsonValue;
  settingsSnapshot?: PlainJsonValue;
  recipe: PlainJsonValue;
  context: FullProviderContextItem[];
}

export type ProviderStreamEventKind = 'output_delta' | 'output_item_done' | 'completed';

export interface ProviderStreamEvent {
  kind: ProviderStreamEventKind;
  streamSeq: string | bigint;
  content: PlainJsonValue;
  usage?: PlainJsonValue;
}

export interface ProviderDispatchControls {
  signal?: AbortSignal;
  onEvent(event: ProviderStreamEvent): Promise<StreamEventResult>;
}

export interface FullRequestProviderAdapter {
  /** Identifies the frozen provider configuration this adapter serves. */
  providerId: string;
  sendFullRequest(request: FullProviderRequest, controls: ProviderDispatchControls): Promise<void>;
}

export interface ProviderDispatchOptions {
  signal?: AbortSignal;
  reconnect?: boolean;
}

export interface ProviderDispatchResult {
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  terminalState?: string;
  superseded?: true;
}

export interface StreamEventResult {
  accepted: boolean;
  checkpointed: boolean;
  terminal: boolean;
  ignoredReason?: 'old-attempt' | 'old-socket-generation' | 'terminal' | 'checkpoint-capacity' | 'duplicate';
}

export type ProviderTransientReason = 'connection_interrupted' | 'rate_limited' | 'temporary_service_error';

export class ProviderTransientError extends Error {
  public constructor(public readonly reason: ProviderTransientReason, message: string) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}

interface StreamStats {
  attemptSeq: string;
  socketGeneration: string;
  retryReason: ProviderTransientReason | null;
}

interface StreamIdentity {
  attemptSeq: bigint;
  socketGeneration: bigint;
  stats: StreamStats;
}

interface FrozenAuthority {
  providerId: string;
  modelId: string;
}

interface RequestBundle {
  request: DomainRow;
  operation: DomainRow;
  attempt: DomainRow;
  fence: DomainRow | null;
  turn: DomainRow;
}

interface CreationIdentity {
  turnId: string;
  contextRootId: string;
  authoritySnapshotId: string;
  providerId: string;
  modelId: string;
  settingsSnapshotContentObjectId: string | null;
  recipeIdentity: ContentObjectIdentity;
}

const CONTENT_TYPE_RECIPE = 'application/vnd.limcode.model-request-recipe+json';
const CONTENT_TYPE_CHECKPOINT = 'application/vnd.limcode.model-stream-checkpoint+json';

/** First-release provider path: each socket dispatch is rebuilt from one frozen root and immutable recipe. */
export class ModelProviderControlPlane {
  private readonly context: ContextSequenceControlPlane;
  private readonly now: () => string;
  private readonly activeSockets = new Map<string, Set<AbortController>>();

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
  }

  public async createModelRequest(command: CreateModelRequestCommand): Promise<ModelRequestCreationResult> {
    const turnId = requireId(command.turnId, 'turnId');
    const contextRootId = requireId(command.contextRootId, 'contextRootId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const settingsSnapshotContentObjectId = command.settingsSnapshotContentObjectId === undefined
      ? null
      : requireId(command.settingsSnapshotContentObjectId, 'settingsSnapshotContentObjectId');
    const recipe = normalizePlainJson(command.recipe, 'ModelRequest recipe');
    const recipeBytes = canonicalPlainJson(recipe, 'ModelRequest recipe');
    const recipeIdentity = this.contentStore.identity(recipeBytes, CONTENT_TYPE_RECIPE);
    const modelRequestId = stableId('model_request', turnId, idempotencyKey);
    const projectionId = stableId('model_request_projection', modelRequestId);
    const operationId = stableId('model_request_operation', modelRequestId);
    const attemptId = stableId('model_request_attempt', modelRequestId, '1');

    const frozen = await this.readFrozenAuthority(authoritySnapshotId, turnId);
    if (settingsSnapshotContentObjectId) {
      const settingsRow = await this.requireDomain('ContentObject', settingsSnapshotContentObjectId);
      parsePlainJson(await this.contentStore.read(asContentObjectMetadata(settingsRow)), 'ModelRequest settings snapshot');
    }
    const identity: CreationIdentity = {
      turnId,
      contextRootId,
      authoritySnapshotId,
      providerId: frozen.providerId,
      modelId: frozen.modelId,
      settingsSnapshotContentObjectId,
      recipeIdentity
    };
    const existing = await this.getOptional('ModelRequest', modelRequestId);
    if (existing) {
      return this.replayCreation(existing, modelRequestId, projectionId, operationId, attemptId, identity);
    }

    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(contextRootId)
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${turnId}`);
    const contextRoot = requireRow(snapshot.snapshot[1], `ContextSequenceRoot ${contextRootId}`);
    if (contextRoot.conversation_id !== turn.conversation_id) {
      throw new Error('ContextSequenceRoot belongs to another Conversation.');
    }

    const recipeContent = await this.contentStore.prepare(this.database, recipeBytes, CONTENT_TYPE_RECIPE);
    const now = this.timestamp();
    const initialStats: StreamStats = { attemptSeq: '1', socketGeneration: '0', retryReason: null };
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
      ...preparedContentObjectSteps([recipeContent], 'model_request_recipe'),
      DOMAIN_REPOSITORIES.domain('ModelRequest').insertWithNextSequence({
        id: modelRequestId,
        turn_id: turnId,
        status: 'prepared',
        terminal_state: null,
        provider_id: frozen.providerId,
        model_id: frozen.modelId,
        authority_snapshot_id: authoritySnapshotId,
        settings_snapshot_object_id: settingsSnapshotContentObjectId,
        recipe_object_id: recipeContent.metadata.id,
        usage_json: null,
        stream_stats_json: initialStats,
        created_at: now,
        updated_at: now
      }, { column: 'request_seq', scope: { turn_id: turnId } }),
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: projectionId,
        owner_kind: 'model_request',
        owner_id: modelRequestId,
        root_id: contextRootId,
        purpose: 'provider-request',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
        id: operationId,
        owner_kind: 'model_request',
        owner_id: modelRequestId,
        tool_call_id: null,
        status: 'pending',
        created_at: now,
        updated_at: now
      }, { column: 'operation_seq', scope: { owner_kind: 'model_request', owner_id: modelRequestId } }),
      DOMAIN_REPOSITORIES.domain('Attempt').insertWithNextSequence({
        id: attemptId,
        operation_id: operationId,
        status: 'pending',
        created_at: now,
        updated_at: now,
        completed_at: null
      }, { column: 'attempt_seq', scope: { operation_id: operationId } }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(attemptId, { attempt_seq: 1n })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        modelRequestId,
        projectionId,
        operationId,
        attemptId,
        requestSeq: allocatedValue(commit.allocatedSequences, 'ModelRequest', modelRequestId, 'request_seq'),
        commitSeq: commit.commitSeq,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableProviderRace(error)) throw error;
      const raced = await this.getOptional('ModelRequest', modelRequestId);
      if (!raced) throw error;
      return this.replayCreation(raced, modelRequestId, projectionId, operationId, attemptId, identity);
    }
  }

  private async buildFullRequest(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint
  ): Promise<FullProviderRequest> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const attemptSeq = decimalBigInt(attemptSeqInput, 'attemptSeq');
    const socketGeneration = decimalBigInt(socketGenerationInput, 'socketGeneration');
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const projection = await this.requireDomain('ModelContextProjection', stableId('model_request_projection', modelRequestId));
    if (projection.owner_kind !== 'model_request' || projection.owner_id !== modelRequestId) {
      throw new Error(`ModelRequest ${modelRequestId} has an invalid frozen Context projection.`);
    }
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requireId(request.authority_snapshot_id, 'ModelRequest.authority_snapshot_id'),
      requireId(request.turn_id, 'ModelRequest.turn_id')
    );
    const recipeContent = await this.requireDomain(
      'ContentObject', requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    );
    const settingsId = optionalId(request.settings_snapshot_object_id, 'ModelRequest.settings_snapshot_object_id');
    const settingsContent = settingsId ? await this.requireDomain('ContentObject', settingsId) : null;
    const materialized = await this.context.materialize(requireId(projection.root_id, 'ModelContextProjection.root_id'));
    const contentRows = [recipeContent, ...(settingsContent ? [settingsContent] : [])];
    const bytes = await this.contentStore.readMany(contentRows.map(asContentObjectMetadata));
    const recipe = parsePlainJson(bytes[0], 'ModelRequest recipe');
    const frozenAuthority = frozen.document;
    const settingsSnapshot = settingsContent ? parsePlainJson(bytes[1], 'ModelRequest settings snapshot') : undefined;
    const frozenModel = frozenModelIdentity(frozenAuthority);
    if (frozenModel.providerId !== request.provider_id || frozenModel.modelId !== request.model_id) {
      throw new Error('Persisted ModelRequest provider/model no longer matches its frozen AuthoritySnapshot.');
    }
    return {
      kind: 'full-model-request',
      modelRequestId,
      attemptSeq: attemptSeq.toString(),
      socketGeneration: socketGeneration.toString(),
      providerId: frozenModel.providerId,
      modelId: frozenModel.modelId,
      authoritySnapshot: frozenAuthority,
      ...(settingsSnapshot === undefined ? {} : { settingsSnapshot }),
      recipe,
      context: materialized.segments.map((segment) => ({
        segmentId: segment.segmentId,
        segmentKind: segment.segmentKind,
        messageRole: segment.messageRole,
        contentType: segment.contentObject.content_type,
        content: decodeUtf8Exact(segment.content, `ContextSegment ${segment.segmentId}`)
      }))
    };
  }

  /** Explicit dry-run/replay; it reads only the immutable request projection and CAS objects. */
  public async replay(modelRequestIdInput: string): Promise<FullProviderRequest> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const stats = parseStreamStats(request.stream_stats_json);
    return this.buildFullRequest(modelRequestId, stats.attemptSeq, stats.socketGeneration);
  }

  public async dispatch(
    modelRequestIdInput: string,
    adapter: FullRequestProviderAdapter,
    options: ProviderDispatchOptions = {}
  ): Promise<ProviderDispatchResult> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    if (!adapter || typeof adapter.sendFullRequest !== 'function') {
      throw new TypeError('Provider adapter must implement sendFullRequest.');
    }
    const adapterProviderId = requireText(adapter.providerId, 'Provider adapter.providerId');
    let request = await this.requireDomain('ModelRequest', modelRequestId);
    let stats = parseStreamStats(request.stream_stats_json);
    if (request.status === 'terminal') throw new Error('Terminal ModelRequest cannot be dispatched.');
    if (adapterProviderId !== request.provider_id) {
      throw providerConflict(`Provider adapter ${adapterProviderId} does not match frozen provider ${String(request.provider_id)}.`);
    }
    if (options.reconnect !== true && stats.socketGeneration !== '0') {
      throw new Error('ModelRequest was already dispatched; use reconnect explicitly.');
    }

    let attemptSeq = decimalBigInt(stats.attemptSeq, 'ModelRequest attemptSeq');
    for (;;) {
      if (options.signal?.aborted) {
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-before-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, {
          attemptSeq,
          socketGeneration: decimalBigInt(stats.socketGeneration, 'socketGeneration'),
          stats
        }, cancelled);
      }
      const currentIdentity: StreamIdentity = {
        attemptSeq,
        socketGeneration: decimalBigInt(stats.socketGeneration, 'socketGeneration'),
        stats
      };
      const expectedGeneration = currentIdentity.socketGeneration + 1n;
      let fullRequest: FullProviderRequest;
      try {
        fullRequest = await this.buildFullRequest(modelRequestId, attemptSeq, expectedGeneration);
      } catch (error) {
        await this.failRequest(modelRequestId, currentIdentity, error);
        throw error;
      }
      const identity = await this.openSocketGeneration(modelRequestId, attemptSeq, stats);
      const controller = new AbortController();
      const detachCallerSignal = relayAbort(options.signal, controller);
      const unregister = this.registerActiveSocket(modelRequestId, controller);
      const abortWaiter = createAbortWaiter(controller.signal);
      const adapterOutcome = Promise.resolve()
        .then(() => adapter.sendFullRequest(fullRequest, {
          signal: controller.signal,
          onEvent: (event) => this.recordStreamEvent(
            modelRequestId,
            identity.attemptSeq,
            identity.socketGeneration,
            event
          )
        }))
        .then(
          () => ({ kind: 'resolved' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error })
        );
      let outcome: Awaited<typeof adapterOutcome> | { kind: 'aborted' };
      try {
        outcome = await Promise.race([adapterOutcome, abortWaiter.promise]);
      } finally {
        abortWaiter.dispose();
        detachCallerSignal();
        unregister();
      }
      if (outcome.kind === 'aborted') {
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-during-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, identity, cancelled);
      }
      if (outcome.kind === 'resolved') {
        return this.finishResolvedDispatch(modelRequestId, identity);
      }
      const error = outcome.error;
      if (controller.signal.aborted || isAbortError(error)) {
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-during-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, identity, cancelled);
      }
      if (!(error instanceof ProviderTransientError)) {
        const applied = await this.failRequest(modelRequestId, identity, error);
        if (!applied) return this.finishResolvedDispatch(modelRequestId, identity);
        throw error;
      }
      if (identity.attemptSeq >= 2n) {
        const applied = await this.failRequest(modelRequestId, identity, error);
        if (!applied) return this.finishResolvedDispatch(modelRequestId, identity);
        throw error;
      }
      const retryAttempt = await this.createTransientRetry(modelRequestId, identity, error.reason);
      if (retryAttempt === null) return this.finishResolvedDispatch(modelRequestId, identity);
      request = await this.requireDomain('ModelRequest', modelRequestId);
      stats = parseStreamStats(request.stream_stats_json);
      attemptSeq = retryAttempt;
    }
  }

  /** Persistent request-level cancellation; one writer transaction always targets the latest identity. */
  public async cancel(modelRequestIdInput: string, reason = 'cancelled-by-user'): Promise<boolean> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const result = await this.cancelCurrentRequest(modelRequestId, requireText(reason, 'cancel reason'));
    this.abortActiveSockets(modelRequestId);
    return result.cancelled;
  }

  public async recordStreamEvent(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    eventInput: ProviderStreamEvent
  ): Promise<StreamEventResult> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const attemptSeq = decimalBigInt(attemptSeqInput, 'attemptSeq');
    const socketGeneration = decimalBigInt(socketGenerationInput, 'socketGeneration');
    const event = normalizeStreamEvent(eventInput);
    const checkpointId = stableId(
      'model_stream_checkpoint',
      modelRequestId,
      attemptSeq.toString(),
      socketGeneration.toString(),
      event.streamSeq.toString()
    );
    const completed = event.kind === 'completed';
    const checkpointKind: 'output_delta' | 'output_item_done' | 'terminal_summary' = completed
      ? 'terminal_summary'
      : event.kind as 'output_delta' | 'output_item_done';
    const checkpointBytes = canonicalPlainJson({
      kind: event.kind,
      streamSeq: event.streamSeq.toString(),
      content: event.content,
      ...(event.usage !== undefined ? { usage: event.usage } : {})
    });
    const checkpointIdentity = this.contentStore.identity(checkpointBytes, CONTENT_TYPE_CHECKPOINT);
    const preflight = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelRequest').get(modelRequestId),
      DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({ where: { model_request_id: modelRequestId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').get(checkpointId),
      DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').list({
        where: { model_request_id: modelRequestId }, limit: MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT + 1
      })
    ]);
    const request = requireRow(preflight.snapshot[0], `ModelRequest ${modelRequestId}`);
    const stats = parseStreamStats(request.stream_stats_json);
    const existingCheckpoint = preflight.snapshot[2] as DomainRow | null;
    if (existingCheckpoint) {
      assertExactStreamCheckpoint(existingCheckpoint, {
        modelRequestId,
        attemptSeq,
        socketGeneration,
        streamSeq: event.streamSeq,
        checkpointKind,
        contentObjectId: checkpointIdentity.id
      });
      return { accepted: false, checkpointed: false, terminal: request.status === 'terminal', ignoredReason: 'duplicate' };
    }
    if (request.status === 'terminal' || rows(preflight.snapshot[1]).length > 0) {
      return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
    }
    if (stats.attemptSeq !== attemptSeq.toString()) {
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-attempt' };
    }
    if (stats.socketGeneration !== socketGeneration.toString()) {
      return { accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-socket-generation' };
    }
    if (!completed && rows(preflight.snapshot[3]).length >= MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT) {
      return { accepted: true, checkpointed: false, terminal: false, ignoredReason: 'checkpoint-capacity' };
    }
    const content = await this.contentStore.prepare(this.database, checkpointBytes, CONTENT_TYPE_CHECKPOINT);
    const result = await this.database.commitModelStreamEvent({
      modelRequestId,
      checkpointId,
      attemptSeq,
      socketGeneration,
      streamSeq: event.streamSeq,
      checkpointKind,
      terminalFenceId: completed ? stableId('model_stream_fence', modelRequestId) : null,
      contentObject: content.metadata,
      ...(content.insert ? { contentInsert: content.insert } : {}),
      usage: completed ? (event.usage ?? null) : null,
      terminalStats: completed ? { ...stats } : null,
      now: this.timestamp()
    });
    return {
      accepted: result.accepted,
      checkpointed: result.checkpointed,
      terminal: result.terminal,
      ...(result.ignoredReason ? { ignoredReason: result.ignoredReason } : {})
    };
  }

  private async openSocketGeneration(
    modelRequestId: string,
    attemptSeq: bigint,
    expectedStats: StreamStats
  ): Promise<StreamIdentity> {
    const bundle = await this.readRequestBundle(modelRequestId, attemptSeq);
    if (bundle.request.status === 'terminal' || bundle.fence) throw new Error('Terminal ModelRequest cannot open a socket.');
    if (bundle.turn.status !== 'active') {
      await this.cancelCurrentRequest(modelRequestId, 'turn-not-active');
      throw new Error('ModelRequest parent Turn is not active.');
    }
    const currentStats = parseStreamStats(bundle.request.stream_stats_json);
    if (!sameStats(currentStats, expectedStats) || currentStats.attemptSeq !== attemptSeq.toString()) {
      throw staleStreamError('ModelRequest identity changed before socket open.');
    }
    const socketGeneration = decimalBigInt(currentStats.socketGeneration, 'socketGeneration') + 1n;
    const nextStats: StreamStats = { ...currentStats, socketGeneration: socketGeneration.toString() };
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(requireId(bundle.turn.id, 'Turn.id'), { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
          status: bundle.request.status,
          stream_stats_json: currentStats
        }),
        DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
        DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
          operation_id: bundle.operation.id,
          attempt_seq: attemptSeq
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
          status: 'running', updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(requireId(bundle.operation.id, 'Operation.id'), {
          status: 'running', updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
          status: 'streaming', stream_stats_json: nextStats, updated_at: now
        })
      ]);
    } catch (error) {
      if (!isAssertionFailure(error)) throw error;
      const latest = await this.requireDomain('ModelRequest', modelRequestId);
      const latestTurn = await this.requireDomain('Turn', requireId(latest.turn_id, 'ModelRequest.turn_id'));
      if (latestTurn.status !== 'active' && latest.status !== 'terminal') {
        await this.cancel(modelRequestId, 'turn-not-active');
      }
      throw staleStreamError('ModelRequest identity changed before socket open.');
    }
    return { attemptSeq, socketGeneration, stats: nextStats };
  }

  private async createTransientRetry(
    modelRequestId: string,
    failed: StreamIdentity,
    reason: ProviderTransientReason
  ): Promise<bigint | null> {
    if (failed.attemptSeq !== 1n) throw new Error('Provider transient retry is limited to attempt 2.');
    const bundle = await this.readRequestBundle(modelRequestId, failed.attemptSeq);
    const currentStats = parseStreamStats(bundle.request.stream_stats_json);
    if (
      bundle.request.status === 'terminal'
      || bundle.fence
      || bundle.turn.status !== 'active'
      || !sameStats(currentStats, failed.stats)
    ) return null;
    const attemptId = stableId('model_request_attempt', modelRequestId, '2');
    const now = this.timestamp();
    const nextStats: StreamStats = { attemptSeq: '2', socketGeneration: '0', retryReason: reason };
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(requireId(bundle.turn.id, 'Turn.id'), { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
          status: 'streaming', stream_stats_json: failed.stats
        }),
        DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
        DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
          status: 'running', attempt_seq: failed.attemptSeq
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
          status: 'transient_failed', updated_at: now, completed_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').insertWithNextSequence({
          id: attemptId,
          operation_id: requireId(bundle.operation.id, 'Operation.id'),
          status: 'pending',
          created_at: now,
          updated_at: now,
          completed_at: null
        }, { column: 'attempt_seq', scope: { operation_id: requireId(bundle.operation.id, 'Operation.id') } }),
        DOMAIN_REPOSITORIES.domain('Attempt').assert(attemptId, { attempt_seq: 2n }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
          status: 'retrying', stream_stats_json: nextStats, updated_at: now
        })
      ]);
      return 2n;
    } catch (error) {
      if (!isRecoverableProviderRace(error)) throw error;
      return null;
    }
  }

  private async cancelCurrentRequest(
    modelRequestId: string,
    terminalState: string
  ): Promise<ModelRequestCancelResult> {
    const result = await this.database.cancelCurrentModelRequest({
      modelRequestId,
      terminalState,
      now: this.timestamp()
    });
    this.abortActiveSockets(modelRequestId);
    return result;
  }

  private async finishResolvedDispatch(
    modelRequestId: string,
    identity: StreamIdentity
  ): Promise<ProviderDispatchResult> {
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const current = parseStreamStats(request.stream_stats_json);
    const terminalState = typeof request.terminal_state === 'string' ? request.terminal_state : undefined;
    if (terminalState && isCancellationTerminalState(terminalState)) throw abortError();
    return dispatchResult(modelRequestId, identity, {
      superseded: !sameStats(current, identity.stats),
      terminalState
    });
  }

  private finishCancelledDispatch(
    modelRequestId: string,
    identity: StreamIdentity,
    result: ModelRequestCancelResult
  ): ProviderDispatchResult {
    if (result.terminalState && isCancellationTerminalState(result.terminalState)) throw abortError();
    return dispatchResult(modelRequestId, identity, {
      superseded: result.attemptSeq !== identity.attemptSeq.toString()
        || result.socketGeneration !== identity.socketGeneration.toString(),
      ...(result.terminalState ? { terminalState: result.terminalState } : {})
    });
  }

  private registerActiveSocket(modelRequestId: string, controller: AbortController): () => void {
    const active = this.activeSockets.get(modelRequestId) ?? new Set<AbortController>();
    active.add(controller);
    this.activeSockets.set(modelRequestId, active);
    return () => {
      active.delete(controller);
      if (active.size === 0) this.activeSockets.delete(modelRequestId);
    };
  }

  private abortActiveSockets(modelRequestId: string): void {
    for (const controller of this.activeSockets.get(modelRequestId) ?? []) controller.abort();
  }

  private async failRequest(modelRequestId: string, identity: StreamIdentity, error: unknown): Promise<boolean> {
    return this.terminalizeRequest(modelRequestId, identity, {
      attemptStatus: 'failed',
      operationStatus: 'failed',
      terminalState: error instanceof ProviderTransientError
        ? `provider_transient_${error.reason}`
        : 'provider_failed'
    });
  }

  private async terminalizeRequest(
    modelRequestId: string,
    identity: StreamIdentity,
    terminal: { attemptStatus: string; operationStatus: string; terminalState: string }
  ): Promise<boolean> {
    const bundle = await this.readRequestBundle(modelRequestId, identity.attemptSeq);
    if (bundle.request.status === 'terminal' || bundle.fence) return false;
    const currentStats = parseStreamStats(bundle.request.stream_stats_json);
    if (!sameStats(currentStats, identity.stats)) return false;
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
          status: bundle.request.status, stream_stats_json: identity.stats
        }),
        DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
        DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
          operation_id: bundle.operation.id, attempt_seq: identity.attemptSeq
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
          status: terminal.attemptStatus, updated_at: now, completed_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(requireId(bundle.operation.id, 'Operation.id'), {
          status: terminal.operationStatus, updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
          status: 'terminal', terminal_state: terminal.terminalState, updated_at: now
        })
      ]);
      return true;
    } catch (error) {
      if (!isAssertionFailure(error)) throw error;
      const latest = await this.requireDomain('ModelRequest', modelRequestId);
      const latestStats = parseStreamStats(latest.stream_stats_json);
      if (latest.status === 'terminal' || !sameStats(latestStats, identity.stats)) return false;
      throw error;
    }
  }

  private async readRequestBundle(modelRequestId: string, attemptSeq: bigint): Promise<RequestBundle> {
    const operationId = stableId('model_request_operation', modelRequestId);
    const attemptId = stableId('model_request_attempt', modelRequestId, attemptSeq.toString());
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Operation').get(operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(attemptId),
      DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({ where: { model_request_id: modelRequestId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('Turn').get(requireId(request.turn_id, 'ModelRequest.turn_id'))
    ]);
    return {
      request,
      operation: requireRow(snapshot.snapshot[0], `Operation for ${modelRequestId}`),
      attempt: requireRow(snapshot.snapshot[1], `Attempt ${attemptSeq} for ${modelRequestId}`),
      fence: rows(snapshot.snapshot[2])[0] ?? null,
      turn: requireRow(snapshot.snapshot[3], `Turn for ${modelRequestId}`)
    };
  }

  private async readFrozenAuthority(authoritySnapshotId: string, turnId: string): Promise<FrozenAuthority> {
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      authoritySnapshotId,
      turnId
    );
    return frozenModelIdentity(frozen.document);
  }

  private async replayCreation(
    request: DomainRow,
    modelRequestId: string,
    projectionId: string,
    operationId: string,
    attemptId: string,
    expected: CreationIdentity
  ): Promise<ModelRequestCreationResult> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').get(projectionId),
      DOMAIN_REPOSITORIES.domain('Operation').get(operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(attemptId)
    ]);
    const projection = requireRow(snapshot.snapshot[0], `ModelContextProjection ${projectionId}`);
    const operation = requireRow(snapshot.snapshot[1], `Operation ${operationId}`);
    const attempt = requireRow(snapshot.snapshot[2], `Attempt ${attemptId}`);
    const matches = request.turn_id === expected.turnId
      && request.authority_snapshot_id === expected.authoritySnapshotId
      && request.provider_id === expected.providerId
      && request.model_id === expected.modelId
      && (request.settings_snapshot_object_id ?? null) === expected.settingsSnapshotContentObjectId
      && request.recipe_object_id === expected.recipeIdentity.id
      && projection.owner_kind === 'model_request'
      && projection.owner_id === modelRequestId
      && projection.root_id === expected.contextRootId
      && operation.owner_kind === 'model_request'
      && operation.owner_id === modelRequestId
      && attempt.operation_id === operationId
      && attempt.attempt_seq === 1n;
    if (!matches) {
      throw providerConflict(`ModelRequest idempotency key conflicts with committed immutable request ${modelRequestId}.`);
    }
    return {
      modelRequestId,
      projectionId,
      operationId,
      attemptId,
      requestSeq: requireBigInt(request.request_seq, 'ModelRequest.request_seq').toString(),
      deduplicated: true
    };
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const row = await this.getOptional(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function dispatchResult(
  modelRequestId: string,
  identity: StreamIdentity,
  options: { superseded?: boolean; terminalState?: string } = {}
): ProviderDispatchResult {
  return {
    modelRequestId,
    attemptSeq: identity.attemptSeq.toString(),
    socketGeneration: identity.socketGeneration.toString(),
    ...(options.terminalState ? { terminalState: options.terminalState } : {}),
    ...(options.superseded ? { superseded: true as const } : {})
  };
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort();
  if (source.aborted) target.abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function createAbortWaiter(signal: AbortSignal): {
  promise: Promise<{ kind: 'aborted' }>;
  dispose(): void;
} {
  let listener: (() => void) | null = null;
  const promise = signal.aborted
    ? Promise.resolve({ kind: 'aborted' as const })
    : new Promise<{ kind: 'aborted' }>((resolve) => {
        listener = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', listener, { once: true });
      });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
      listener = null;
    }
  };
}

function isCancellationTerminalState(value: string): boolean {
  return value !== 'completed'
    && value !== 'provider_failed'
    && !value.startsWith('provider_transient_');
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8 and cannot enter a full Provider request.`);
  }
  return value;
}

function assertExactStreamCheckpoint(
  row: DomainRow,
  expected: {
    modelRequestId: string;
    attemptSeq: bigint;
    socketGeneration: bigint;
    streamSeq: bigint;
    checkpointKind: string;
    contentObjectId: string;
  }
): void {
  if (
    row.model_request_id !== expected.modelRequestId
    || row.attempt_seq !== expected.attemptSeq
    || row.socket_generation !== expected.socketGeneration
    || row.stream_seq !== expected.streamSeq
    || row.checkpoint_kind !== expected.checkpointKind
    || row.content_object_id !== expected.contentObjectId
  ) {
    const error = new Error(`ModelStream checkpoint ${String(row.id)} conflicts with an existing event identity.`) as Error & {
      code: string;
    };
    error.code = 'MODEL_STREAM_IDEMPOTENCY_CONFLICT';
    throw error;
  }
}

function normalizeStreamEvent(event: ProviderStreamEvent): {
  kind: ProviderStreamEventKind;
  streamSeq: bigint;
  content: PlainJsonValue;
  usage?: PlainJsonValue;
} {
  if (!event || !['output_delta', 'output_item_done', 'completed'].includes(event.kind)) {
    throw new TypeError(`Unsupported Provider stream event: ${String(event?.kind)}`);
  }
  const streamSeq = decimalBigInt(event.streamSeq, 'streamSeq');
  if (streamSeq <= 0n) throw new TypeError('streamSeq must be positive.');
  return {
    kind: event.kind,
    streamSeq,
    content: normalizePlainJson(event.content, 'Provider stream event content'),
    ...(event.usage !== undefined ? { usage: normalizePlainJson(event.usage, 'Provider stream usage') } : {})
  };
}

function parseStreamStats(value: unknown): StreamStats {
  if (!isRecord(value)) throw new Error('ModelRequest.stream_stats_json must be an object.');
  const attemptSeq = decimalString(value.attemptSeq, 'stream_stats.attemptSeq');
  const socketGeneration = decimalString(value.socketGeneration, 'stream_stats.socketGeneration');
  if (value.retryReason !== null && !isTransientReason(value.retryReason)) {
    throw new Error('ModelRequest.stream_stats_json has an invalid retryReason.');
  }
  return { attemptSeq, socketGeneration, retryReason: value.retryReason as ProviderTransientReason | null };
}

function sameStats(left: StreamStats, right: StreamStats): boolean {
  return left.attemptSeq === right.attemptSeq
    && left.socketGeneration === right.socketGeneration
    && left.retryReason === right.retryReason;
}

function parsePlainJson(bytes: Buffer, label: string): PlainJsonValue {
  try {
    return normalizePlainJson(JSON.parse(bytes.toString('utf8')), label);
  } catch (error) {
    throw new Error(`${label} is not valid plain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function allocatedValue(
  allocated: readonly { domain: string; id: string; column: string; value: string }[],
  domain: string,
  id: string,
  column: string
): string {
  const entry = allocated.find((candidate) =>
    candidate.domain === domain && candidate.id === id && candidate.column === column
  );
  if (!entry) throw new Error(`Missing writer allocation ${domain}.${column} for ${id}.`);
  return entry.value;
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-provider\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function isTransientReason(value: unknown): value is ProviderTransientReason {
  return value === 'connection_interrupted'
    || value === 'rate_limited'
    || value === 'temporary_service_error';
}

function isRecoverableProviderRace(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function isAssertionFailure(error: unknown): boolean {
  return errorCode(error) === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

function providerConflict(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT';
  return error;
}

function staleStreamError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = 'MODEL_STREAM_IDENTITY_STALE';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('Provider request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function optionalId(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : requireId(value, label);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  return value;
}

function decimalBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be non-negative.`);
    return value;
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string or bigint.`);
  }
  return BigInt(value);
}

function decimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

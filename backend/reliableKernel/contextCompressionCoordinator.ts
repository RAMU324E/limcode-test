import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import {
  rebaseAttachmentCatalogState,
  selectAttachmentCatalogStateSegments,
  type AttachmentCatalogState
} from './attachmentCatalog';
import { AttachmentCatalogProjection } from './attachmentCatalogProjection';
import {
  assertAttachmentObservationStateContent,
  attachmentObservationAnalysisProfileSha256,
  completeAttachmentObservationCommits,
  loadAttachmentObservationRequirements
} from './attachmentObservations';
import type { ReliableAgentProviderRegistry } from './agentLoop';
import { ContentAddressedStore } from './contentAddressedStore';
import {
  ContextCompressionControlPlane,
  compressionBlockIdFor,
  compressionSegmentIdFor,
  type CompressionCommitResult
} from './contextCompression';
import { ContextSequenceControlPlane, type StructuralContextRecord } from './contextSequence';
import { frozenCompressionPolicy, frozenContextProfile, readFrozenTurnAuthority } from './frozenAuthority';
import {
  compressionOutputTokens,
  estimateMessageContentsTokens,
  providerPromptTokens
} from './contextTokenEstimator';
import {
  MODEL_BODY_TARGET_TOKENS,
  calculateEffectiveSummaryMaxTokens,
  calculateFullRequestPlanningBudget,
  projectStoredModelFacingWindow,
  selectContinuousAtomicTail,
  type AtomicContextGroup,
  type ContextPlanningFailureCode,
  type FullRequestPlanningBudget
} from './modelFacingContextProjection';
import type { ModelHandleCatalog } from './modelHandleCatalog';
import {
  ModelRequestPreflightError,
  ModelProviderControlPlane,
  modelRequestIdFor,
  type FullRequestProviderAdapter
} from './modelProviderControlPlane';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export type CompressionTrigger = 'auto' | 'manual';
export type CompressionTriggerReason = 'manual' | 'configured_threshold';

export interface CoordinateCompressionCommand {
  turnId: string;
  authoritySnapshotId: string;
  headRootId: string;
  trigger: CompressionTrigger;
  /** Exact frozen ordinary request planning budget. Required for automatic compression; optional for manual. */
  requestBudget?: FullRequestPlanningBudget;
  /** Exact active-Turn input that may need request-level reinjection after this compression. */
  protectedCurrentInputTokens?: number;
  /** Manual callers may freeze an explicit prefix. Automatic text selection uses a continuous token tail. */
  compressSegmentCount?: number;
  title?: string;
}

export type CoordinateCompressionResult =
  | {
      status: 'skipped';
      reason:
        | 'disabled'
        | 'manual_only'
        | 'below_threshold'
        | 'fixed_over_policy'
        | 'finite_tail'
        | 'empty_context'
        | 'non_reducing';
      estimatedTokens?: number;
      thresholdTokens?: number;
    }
  | {
      status: 'error';
      code: ContextPlanningFailureCode;
      message: string;
      estimatedTokens: number;
      limitTokens: number;
    }
  | {
      status: 'compressed';
      trigger: CompressionTrigger;
      triggerReason: CompressionTriggerReason;
      modelRequestId: string;
      sourceRootId: string;
      sourceSegmentCount: number;
      diagnostics?: Array<'native_over_target'>;
      result: CompressionCommitResult;
    };

/**
 * Durable orchestration around ContextCompressionControlPlane.
 *
 * The compression call is itself a ModelRequest, so Operation/Attempt retry, stream fencing,
 * cancellation, Host handoff and reconnect all use the same authority as ordinary model traffic.
 * Request kind/round metadata lives in the immutable recipe to remain compatible with existing
 * current-epoch databases, whose schema is intentionally non-migrating.
 */
export class ReliableContextCompressionCoordinator {
  private readonly context: ContextSequenceControlPlane;
  private readonly attachmentCatalog: AttachmentCatalogProjection;
  private readonly compression: ContextCompressionControlPlane;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    options: { now?: () => string } = {}
  ) {
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.attachmentCatalog = new AttachmentCatalogProjection(database);
    this.compression = new ContextCompressionControlPlane(database, contentStore, options);
  }

  public async coordinate(command: CoordinateCompressionCommand): Promise<CoordinateCompressionResult> {
    const turnId = requireId(command.turnId, 'turnId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const headRootId = requireId(command.headRootId, 'headRootId');
    const trigger = requireTrigger(command.trigger);
    const frozen = await readFrozenTurnAuthority(this.database, this.contentStore, authoritySnapshotId, turnId);
    const policy = frozenCompressionPolicy(frozen.document);
    if (!policy || policy.methodKind === 'disabled') return { status: 'skipped', reason: 'disabled' };
    if (trigger === 'auto' && policy.triggerMode !== 'token_threshold') {
      return { status: 'skipped', reason: 'manual_only' };
    }
    if (trigger === 'auto' && !command.requestBudget) {
      throw new TypeError('Automatic compression requires the exact frozen ordinary request budget.');
    }
    const requestBudget = command.requestBudget
      ? requireFullRequestPlanningBudget(command.requestBudget, policy.thresholdTokens)
      : manualRequestPlanningBudget(frozen.document, policy.thresholdTokens);
    const decision = await this.compression.evaluate(headRootId, authoritySnapshotId);
    if (trigger === 'auto' && !decision.shouldCompress) {
      return {
        status: 'skipped',
        reason: 'below_threshold',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    if (trigger === 'auto' && requestBudget.fixedOverPolicy) {
      return {
        status: 'skipped',
        reason: 'fixed_over_policy',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    if (requestBudget.fixedTokens > requestBudget.planningInputCapacityTokens) {
      return compressionError(
        'fixed_overhead_infeasible',
        'System instructions, tool schemas and provider framing exceed the compression planning capacity.',
        requestBudget.fixedTokens,
        requestBudget.planningInputCapacityTokens
      );
    }
    const triggerReason: CompressionTriggerReason = trigger === 'manual'
      ? 'manual'
      : 'configured_threshold';
    const protectedCurrentInputTokens = command.protectedCurrentInputTokens === undefined
      ? 0
      : requireNonNegativeTokenCount(command.protectedCurrentInputTokens, 'protectedCurrentInputTokens');
    const currentInputAddendumTokens = Math.max(
      requestBudget.breakdown.currentInputTokens,
      protectedCurrentInputTokens
    );
    const irreducibleAddendaTokens = currentInputAddendumTokens
      + requestBudget.breakdown.runtimeDeliveryTokens
      + requestBudget.breakdown.turnReminderTokens;
    if (currentInputAddendumTokens > requestBudget.planningBodyRoomTokens) {
      return compressionError(
        'current_input_too_large',
        'The exact current Turn input cannot fit in the compression planning body room.',
        currentInputAddendumTokens,
        requestBudget.planningBodyRoomTokens
      );
    }
    if (irreducibleAddendaTokens > requestBudget.planningBodyRoomTokens) {
      return compressionError(
        'compressed_context_too_large',
        'Current input, runtime deliveries and the Turn reminder cannot fit even with empty compressed history.',
        irreducibleAddendaTokens,
        requestBudget.planningBodyRoomTokens
      );
    }
    // Materialize source structure/content only after the level-trigger passes. Below-threshold checks
    // are the common path and should pay for one provider-aligned Context read, not three.
    const [materialized, semanticMaterialized] = await Promise.all([
      this.context.materializeStructure(headRootId),
      this.context.materialize(headRootId)
    ]);
    if (materialized.records.length === 0) return { status: 'skipped', reason: 'empty_context' };
    const fullAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      semanticMaterialized.segments.map((segment) => ({ segmentId: segment.segmentId }))
    );
    const fullModelHandleCatalog = await this.modelProvider.ensureAttachmentHandles(
      frozen.conversationId,
      fullAttachmentCatalogState.catalog
    );
    if (
      policy.methodKind === 'openai_responses_compact'
      && command.compressSegmentCount !== undefined
      && command.compressSegmentCount !== materialized.records.length
    ) {
      throw new RangeError('OpenAI native Compact must receive the complete frozen model-visible Context window.');
    }
    const effectiveSummaryMaxTokens = policy.methodKind === 'openai_responses_compact'
      ? undefined
      : calculateEffectiveSummaryMaxTokens(
          policy.config.llmSummary?.targetTokens,
          requestBudget.effectiveBodyTargetTokens
        );
    const textTailPlan = policy.methodKind === 'openai_responses_compact' || command.compressSegmentCount !== undefined
      ? undefined
      : selectCompressionPrefixByTokens(
            materialized.records,
            semanticMaterialized.segments,
            Math.max(0, requestBudget.effectiveBodyTargetTokens
              - irreducibleAddendaTokens
              - (effectiveSummaryMaxTokens ?? 0)),
            fullAttachmentCatalogState,
            fullModelHandleCatalog
          );
    const hardContextRoomTokens = Math.max(
      0,
      requestBudget.planningBodyRoomTokens - irreducibleAddendaTokens
    );
    if (textTailPlan?.newestGroupTokens !== undefined && textTailPlan.newestGroupTokens > hardContextRoomTokens) {
      return compressionError(
        textTailPlan.newestGroupKind === 'tool_exchange' ? 'atomic_group_too_large' : 'finite_tail_too_large',
        'The newest indivisible Context group cannot fit with the frozen request addenda.',
        textTailPlan.newestGroupTokens,
        hardContextRoomTokens
      );
    }
    const requestedSourceSegmentCount = policy.methodKind === 'openai_responses_compact'
      ? materialized.records.length
      : command.compressSegmentCount === undefined
        ? textTailPlan?.sourceSegmentCount ?? 0
        : requirePrefixCount(command.compressSegmentCount, materialized.records.length);
    const sourceSegmentCount = policy.methodKind === 'openai_responses_compact'
      ? requestedSourceSegmentCount
      : closeToolExchangeBoundary(materialized.records, requestedSourceSegmentCount);
    if (sourceSegmentCount <= 0 || sourceSegmentCount > materialized.records.length) {
      return {
        status: 'skipped',
        reason: 'finite_tail',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    const sourceSegments = materialized.records.slice(0, sourceSegmentCount);
    const sourceAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      semanticMaterialized.segments.slice(0, sourceSegmentCount).map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const sourceAttachmentHandles = await this.modelProvider.ensureAttachmentHandles(
      frozen.conversationId,
      sourceAttachmentCatalogState.catalog
    );
    const attachmentObservationProfileSha256 = policy.methodKind !== 'openai_responses_compact'
      && sourceAttachmentCatalogState.catalog.length > 0
        ? attachmentObservationAnalysisProfileSha256(policy.provider)
        : undefined;
    const attachmentObservationRequirements = attachmentObservationProfileSha256
      ? await loadAttachmentObservationRequirements(
          this.database,
          this.contentStore,
          sourceAttachmentCatalogState.catalog,
          sourceAttachmentHandles,
          attachmentObservationProfileSha256
        )
      : [];
    const sourceHash = hashSource(sourceSegments);
    const idempotencyKey = [
      'context-compression', trigger, headRootId, policy.config.id, String(sourceSegmentCount), sourceHash
    ].join(':');
    const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
    const compressionBlockId = compressionBlockIdFor(
      frozen.conversationId,
      headRootId,
      expectedModelRequestId
    );
    let request = await this.optionalDomain('ModelRequest', expectedModelRequestId);
    if (!request) {
      const created = await this.modelProvider.createModelRequest({
        turnId,
        contextRootId: headRootId,
        authoritySnapshotId,
        recipe: normalizePlainJson({
          kind: 'reliable-context-compression',
          requestKind: trigger === 'auto' ? 'context_compression_pre' : 'context_compression_manual',
          trigger,
          triggerReason,
          triggerTokens: decision.estimatedTokens,
          triggerTokenSource: decision.source,
          configuredThresholdTokens: requestBudget.compressionThresholdTokens,
          requestBreakdown: requestBudget.breakdown,
          sourceRootId: headRootId,
          sourceSegmentCount,
          sourceHash,
          blockId: compressionBlockId,
          compressionConfigId: policy.config.id,
          compressionMethodKind: policy.methodKind,
          attachmentCatalogState: sourceAttachmentCatalogState,
          ...(sourceAttachmentHandles.entries.length > 0
            ? { modelHandleCatalog: sourceAttachmentHandles }
            : {}),
          ...(attachmentObservationProfileSha256
            ? {
                attachmentObservationProfileSha256,
                attachmentObservationRequirements
              }
            : {}),
          ...(effectiveSummaryMaxTokens === undefined ? {} : { effectiveSummaryMaxTokens })
        }, 'Reliable compression recipe'),
        idempotencyKey
      });
      if (created.modelRequestId !== expectedModelRequestId) {
        throw new Error('Compression ModelProvider returned an unexpected stable request identity.');
      }
      request = await this.requireDomain('ModelRequest', expectedModelRequestId);
    } else {
      assertFrozenCompressionModelRequestIdentity(
        request,
        turnId,
        authoritySnapshotId,
        policy.provider.providerConfigId,
        policy.provider.modelId
      );
    }
    if (request.status !== 'terminal') {
      const providerId = requireText(request.provider_id, 'ModelRequest.provider_id');
      const adapter = await this.providers.resolve(providerId);
      assertProviderAdapter(adapter, providerId);
      try {
        await this.modelProvider.dispatch(expectedModelRequestId, adapter, { reconnect: true });
      } catch (error) {
        if (error instanceof ModelRequestPreflightError) {
          return compressionError(error.code, error.message, error.estimatedTokens, error.limitTokens);
        }
        throw error;
      }
      request = await this.requireDomain('ModelRequest', expectedModelRequestId);
    }
    if (request.terminal_state !== 'completed') {
      throw new Error(`Compression ModelRequest ${expectedModelRequestId} ended as ${String(request.terminal_state)}.`);
    }
    const completed = await this.modelProvider.completedEvent(expectedModelRequestId);
    const compressionResult = parseCompressionResult(completed.content);
    const summary = compressionResult.contents;
    if (compressionResult.attachmentObservationProfileSha256 !== attachmentObservationProfileSha256) {
      throw new Error('Compression terminal Attachment observation profile conflicts with its frozen recipe.');
    }
    const attachmentObservations = attachmentObservationProfileSha256
      ? completeAttachmentObservationCommits(
          attachmentObservationRequirements,
          compressionResult.attachmentObservations,
          attachmentObservationProfileSha256
        )
      : [];
    if (attachmentObservationProfileSha256) {
      assertAttachmentObservationStateContent(
        summary,
        attachmentObservationRequirements,
        compressionResult.attachmentObservations ?? []
      );
    }
    const tailSegments = semanticMaterialized.segments.slice(sourceSegmentCount);
    const tailAttachmentCatalogState = await this.attachmentCatalog.projectState(
      frozen.conversationId,
      tailSegments.map((segment) => ({
        segmentId: segment.segmentId
      }))
    );
    const summarySegmentId = compressionSegmentIdFor(compressionBlockId);
    const candidateAttachmentCatalogState = rebaseAttachmentCatalogState(
      summarySegmentId,
      sourceAttachmentCatalogState.catalog,
      tailAttachmentCatalogState
    );
    const summaryContextItem = {
      segmentId: summarySegmentId,
      segmentKind: 'compression',
      messageRole: null,
      contentType: 'application/vnd.limcode.compression-contents+json',
      content: JSON.stringify({ kind: 'compression_contents', version: 1, contents: summary })
    };
    const candidateContextItems = [
      summaryContextItem,
      ...tailSegments.map((segment) => ({
        segmentId: segment.segmentId,
        segmentKind: segment.segmentKind,
        messageRole: segment.messageRole,
        contentType: segment.contentObject.content_type,
        content: segment.content.toString('utf8')
      }))
    ];
    const candidateProjection = projectStoredModelFacingWindow(
      candidateContextItems,
      candidateAttachmentCatalogState,
      fullModelHandleCatalog
    );
    const summaryProjectionTokens = projectStoredModelFacingWindow(
      [summaryContextItem],
      { catalog: [], placements: [] },
      fullModelHandleCatalog
    ).tokenCount;
    const providerInputTokens = providerPromptTokens(completed.usage);
    const providerOutputTokens = compressionOutputTokens(completed.usage);
    // The durable replacement may include locally rendered Attachment observation state that is not
    // part of Provider output accounting. Project the complete structured result instead of silently
    // undercounting that model-visible state.
    const summaryEstimatedTokens = estimateMessageContentsTokens(summary);
    const projectedTokens = summaryEstimatedTokens
      + Math.max(0, candidateProjection.tokenCount - summaryProjectionTokens);
    const projectedBodyTokens = projectedTokens + irreducibleAddendaTokens;
    if (projectedBodyTokens > requestBudget.planningBodyRoomTokens) {
      return compressionError(
        'compressed_context_too_large',
        'The candidate compressed history plus frozen request addenda still exceeds the compression planning body room.',
        projectedBodyTokens,
        requestBudget.planningBodyRoomTokens
      );
    }
    if (policy.methodKind !== 'openai_responses_compact' && projectedTokens >= decision.estimatedTokens) {
      // A large protected tail can cross the threshold while the currently eligible prefix is
      // already compact.  The durable ModelRequest makes this decision exact-replayable for this
      // frozen head; treating it as a level-triggered skip keeps the primary Agent Turn alive and
      // lets a later closed prefix become compressible without an infinite same-head retry loop.
      return {
        status: 'skipped',
        reason: 'non_reducing',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    const committed = await this.compression.create({
      conversationId: frozen.conversationId,
      headRootId,
      authoritySnapshotId,
      compressSegmentCount: sourceSegmentCount,
      title: command.title?.trim() || (trigger === 'auto' ? '自动上下文压缩' : '上下文压缩'),
      summary,
      ...(attachmentObservations.length > 0 ? { attachmentObservations } : {}),
      summaryMetadata: {
        trigger,
        triggerReason,
        triggerTokens: decision.estimatedTokens,
        triggerTokenSource: decision.source,
        configuredThresholdTokens: requestBudget.compressionThresholdTokens,
        requestBreakdown: requestBudget.breakdown,
        estimatedTokensBefore: requestBudget.estimatedFullInputTokens,
        estimatedTokensAfter: projectedTokens,
        ...(providerInputTokens === undefined ? {} : { providerInputTokens }),
        ...(providerOutputTokens === undefined ? {} : { providerOutputTokens }),
        methodKind: policy.methodKind,
        estimatedTokens: summaryEstimatedTokens,
        ...(policy.methodKind === 'openai_responses_compact'
          ? { nativeBinding: policy.provider }
          : {})
      },
      projectedEstimatedTokens: projectedTokens,
      idempotencyKey: expectedModelRequestId
    });
    return {
      status: 'compressed',
      trigger,
      triggerReason,
      modelRequestId: expectedModelRequestId,
      sourceRootId: headRootId,
      sourceSegmentCount,
      ...(policy.methodKind === 'openai_responses_compact' && projectedTokens > MODEL_BODY_TARGET_TOKENS
        ? { diagnostics: ['native_over_target' as const] }
        : {}),
      result: committed
    };
  }

  /** Backend entry for the command router; all root/authority facts are resolved server-side. */
  public async manualCurrentTurn(input: {
    turnId: string;
    compressSegmentCount?: number;
    title?: string;
  }): Promise<CoordinateCompressionResult> {
    const turnId = requireId(input.turnId, 'turnId');
    const turn = await this.requireDomain('Turn', turnId);
    if (turn.status !== 'active') {
      throw new Error(`Manual provider compression requires an active Turn; ${turnId} is ${String(turn.status)}.`);
    }
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: conversationId }, limit: 2
      })
    ]);
    const authorities = rows(snapshot.snapshot[0]);
    const heads = rows(snapshot.snapshot[1]);
    if (authorities.length !== 1 || heads.length !== 1) {
      throw new Error(`Manual compression requires one frozen authority and one current head for Turn ${turnId}.`);
    }
    return this.coordinate({
      turnId,
      authoritySnapshotId: requireId(authorities[0].id, 'AuthoritySnapshot.id'),
      headRootId: requireId(heads[0].root_id, 'ConversationContextHeadLink.root_id'),
      trigger: 'manual',
      ...(input.compressSegmentCount === undefined ? {} : { compressSegmentCount: input.compressSegmentCount }),
      ...(input.title?.trim() ? { title: input.title.trim() } : {})
    });
  }

  private async optionalDomain(domain: string, id: string): Promise<DomainRow | undefined> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new Error(`${domain} ${id} lookup returned a list.`);
    return row ?? undefined;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const row = await this.optionalDomain(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function assertFrozenCompressionModelRequestIdentity(
  request: DomainRow,
  turnId: string,
  authoritySnapshotId: string,
  providerId: string,
  modelId: string
): void {
  if (request.turn_id !== turnId
    || request.authority_snapshot_id !== authoritySnapshotId
    || request.provider_id !== providerId
    || request.model_id !== modelId) {
    throw new Error('Existing compression ModelRequest conflicts with the frozen request identity.');
  }
}

function selectCompressionPrefixByTokens(
  records: readonly StructuralContextRecord[],
  segments: ReadonlyArray<{
    segmentId: string;
    segmentKind: string;
    messageRole: string | null;
    contentObject: { content_type: string };
    content: Buffer;
  }>,
  tailBudgetTokens: number,
  attachmentCatalogState: AttachmentCatalogState,
  modelHandleCatalog: ModelHandleCatalog
): {
  sourceSegmentCount: number;
  newestGroupTokens?: number;
  newestGroupKind?: AtomicContextGroup<number>['kind'];
} {
  if (records.length !== segments.length) {
    throw new Error('Structural and semantic Context materializations disagree on segment count.');
  }
  const groups: AtomicContextGroup<number>[] = [];
  for (let index = 0; index < records.length;) {
    const start = index;
    const items = [index];
    index += 1;
    if (records[start].segment.segment_kind === 'message') {
      while (index < records.length && records[index].segment.segment_kind === 'tool_pair') {
        items.push(index);
        index += 1;
      }
    }
    const functionResponseCount = items.filter((position) =>
      records[position].segment.segment_kind === 'tool_pair'
    ).length;
    const segmentIds = items.map((position) => segments[position].segmentId);
    const groupAttachmentState = selectAttachmentCatalogStateSegments(
      attachmentCatalogState,
      segmentIds
    );
    groups.push({
      kind: functionResponseCount > 0 ? 'tool_exchange' : 'message',
      items,
      startIndex: start,
      endIndexExclusive: index,
      estimatedTokens: projectStoredModelFacingWindow(items.map((position) => ({
        segmentId: segments[position].segmentId,
        segmentKind: segments[position].segmentKind,
        messageRole: segments[position].messageRole,
        contentType: segments[position].contentObject.content_type,
        content: segments[position].content.toString('utf8')
      })), groupAttachmentState, modelHandleCatalog).tokenCount,
      functionCallCount: functionResponseCount > 0 ? 1 : 0,
      functionResponseCount,
      complete: true
    });
  }
  const selected = selectContinuousAtomicTail(groups, tailBudgetTokens);
  const newest = selected.tailGroups[selected.tailGroups.length - 1];
  return {
    sourceSegmentCount: selected.prefixItems.length,
    ...(newest ? { newestGroupTokens: newest.estimatedTokens, newestGroupKind: newest.kind } : {})
  };
}

function manualRequestPlanningBudget(
  document: PlainJsonValue,
  thresholdTokens: number
): FullRequestPlanningBudget {
  const profile = frozenContextProfile(document);
  return calculateFullRequestPlanningBudget({
    contextWindowTokens: profile.contextWindowTokens,
    compressionThresholdTokens: thresholdTokens,
    breakdown: emptyRequestBreakdown()
  });
}

function emptyRequestBreakdown(): FullRequestPlanningBudget['breakdown'] {
  return {
    systemTokens: 0,
    toolSchemaTokens: 0,
    providerFramingTokens: 0,
    contextTokens: 0,
    currentInputTokens: 0,
    runtimeDeliveryTokens: 0,
    turnReminderTokens: 0,
    mediaTokens: 0,
    fixedTokens: 0,
    bodyTokens: 0,
    fullTokens: 0
  };
}

function requireFullRequestPlanningBudget(
  value: FullRequestPlanningBudget,
  expectedThresholdTokens: number
): FullRequestPlanningBudget {
  if (!value || typeof value !== 'object') throw new TypeError('requestBudget must be an object.');
  const integerFields: Array<keyof FullRequestPlanningBudget> = [
    'contextWindowTokens',
    'compressionThresholdTokens',
    'outputReserveTokens',
    'planningInputCapacityTokens',
    'fixedTokens',
    'bodyTokens',
    'estimatedFullInputTokens',
    'planningBodyRoomTokens',
    'policyBodyRoomTokens',
    'effectiveBodyTargetTokens'
  ];
  for (const field of integerFields) {
    const candidate = value[field];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new TypeError(`requestBudget.${field} must be a non-negative safe integer.`);
    }
  }
  if (value.compressionThresholdTokens !== expectedThresholdTokens) {
    throw new Error('requestBudget compression threshold does not match frozen compression authority.');
  }
  if (value.estimatedFullInputTokens !== value.fixedTokens + value.bodyTokens) {
    throw new Error('requestBudget full input total is inconsistent.');
  }
  if (typeof value.fixedOverPolicy !== 'boolean') {
    throw new TypeError('requestBudget.fixedOverPolicy must be boolean.');
  }
  return value;
}

function compressionError(
  code: ContextPlanningFailureCode,
  message: string,
  estimatedTokens: number,
  limitTokens: number
): Extract<CoordinateCompressionResult, { status: 'error' }> {
  return { status: 'error', code, message, estimatedTokens, limitTokens };
}

function closeToolExchangeBoundary(records: readonly StructuralContextRecord[], requestedCount: number): number {
  let count = requestedCount;
  // A tool_pair carries the response to the function call frozen in the immediately preceding
  // model Message. If the requested cut lands between them, move the whole exchange into tail.
  while (count > 0 && records[count]?.segment.segment_kind === 'tool_pair') count -= 1;
  return count;
}

interface ParsedCompressionResult {
  contents: MessageContent[];
  attachmentObservationProfileSha256?: string;
  attachmentObservations?: PlainJsonValue[];
}

function parseCompressionResult(value: PlainJsonValue): ParsedCompressionResult {
  const record = requireRecord(value, 'Compression terminal content');
  if (record.type !== 'compression_result' || !Array.isArray(record.contents) || record.contents.length === 0) {
    throw new TypeError('Compression terminal checkpoint does not contain MessageContent[].');
  }
  const contents = record.contents.map((entry, index) => {
    const content = requireRecord(entry, `Compression terminal content[${index}]`);
    if ((content.role !== 'user' && content.role !== 'model') || !Array.isArray(content.parts)) {
      throw new TypeError(`Compression terminal MessageContent ${index} is invalid.`);
    }
    return content as unknown as MessageContent;
  });
  const rawProfile = record.attachmentObservationProfileSha256;
  const rawObservations = record.attachmentObservations;
  if ((rawProfile === undefined) !== (rawObservations === undefined)) {
    throw new TypeError('Compression terminal Attachment observation contract is incomplete.');
  }
  const attachmentObservationProfileSha256 = rawProfile === undefined
    ? undefined
    : requireSha256(rawProfile, 'Compression terminal attachmentObservationProfileSha256');
  const attachmentObservations = rawObservations === undefined
    ? undefined
    : Array.isArray(rawObservations)
      ? rawObservations
      : (() => { throw new TypeError('Compression terminal attachmentObservations must be an array.'); })();
  return {
    contents,
    ...(attachmentObservationProfileSha256 ? { attachmentObservationProfileSha256, attachmentObservations } : {})
  };
}

function hashSource(records: readonly StructuralContextRecord[]): string {
  return createHash('sha256').update(JSON.stringify(records.map((record) => ({
    segmentId: record.segment.id,
    contentObjectId: record.segment.content_object_id,
    segmentKind: record.segment.segment_kind
  })))).digest('hex');
}

function assertProviderAdapter(adapter: FullRequestProviderAdapter, providerId: string): void {
  if (!adapter || adapter.providerId !== providerId || typeof adapter.sendFullRequest !== 'function') {
    throw new Error(`Provider registry returned an invalid adapter for ${providerId}.`);
  }
}

function requirePrefixCount(value: number, total: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > total) {
    throw new RangeError(`Compression prefix must be from 1 to ${Math.max(1, total)}.`);
  }
  return value;
}

function requireNonNegativeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} must be a SHA-256 hex digest.`);
  return text;
}

function requireTrigger(value: unknown): CompressionTrigger {
  if (value !== 'auto' && value !== 'manual') throw new TypeError('Compression trigger must be auto or manual.');
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list did not return rows.');
  return value;
}

import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import type { ReliableAgentProviderRegistry } from './agentLoop';
import { ContentAddressedStore } from './contentAddressedStore';
import {
  ContextCompressionControlPlane,
  compressionBlockIdFor,
  type CompressionCommitResult
} from './contextCompression';
import { ContextSequenceControlPlane, type StructuralContextRecord } from './contextSequence';
import { frozenCompressionPolicy, frozenContextProfile, readFrozenTurnAuthority } from './frozenAuthority';
import {
  compressionOutputTokens,
  estimateMessageContentsTokens
} from './contextTokenEstimator';
import {
  MODEL_BODY_TARGET_TOKENS,
  calculateEffectiveSummaryMaxTokens,
  calculateFullRequestBudget,
  projectStoredModelFacingWindow,
  selectContinuousAtomicTail,
  type AtomicContextGroup,
  type ContextPlanningFailureCode,
  type FullRequestBudget
} from './modelFacingContextProjection';
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

export interface CoordinateCompressionCommand {
  turnId: string;
  authoritySnapshotId: string;
  headRootId: string;
  trigger: CompressionTrigger;
  /** Exact frozen ordinary request budget. Required for automatic compression; optional for manual. */
  requestBudget?: FullRequestBudget;
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
  private readonly compression: ContextCompressionControlPlane;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    options: { now?: () => string } = {}
  ) {
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
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
      ? requireFullRequestBudget(command.requestBudget, policy.thresholdTokens)
      : manualRequestBudget(frozen.document, policy.thresholdTokens);
    if (requestBudget.fixedTokens > requestBudget.estimatedInputLimitTokens) {
      return compressionError(
        'fixed_overhead_infeasible',
        'System instructions, tool schemas and provider framing exceed the safe input limit.',
        requestBudget.fixedTokens,
        requestBudget.estimatedInputLimitTokens
      );
    }
    if (trigger === 'auto' && requestBudget.fixedOverPolicy && !requestBudget.sendingTrigger) {
      return {
        status: 'skipped',
        reason: 'fixed_over_policy',
        estimatedTokens: requestBudget.estimatedFullInputTokens,
        thresholdTokens: requestBudget.compressionThresholdTokens
      };
    }
    const decision = await this.compression.evaluate(headRootId, authoritySnapshotId);
    if (
      trigger === 'auto'
      && !requestBudget.policyTrigger
      && !requestBudget.sendingTrigger
      && !decision.shouldCompress
    ) {
      return {
        status: 'skipped',
        reason: 'below_threshold',
        estimatedTokens: Math.max(requestBudget.estimatedFullInputTokens, decision.estimatedTokens),
        thresholdTokens: requestBudget.compressionThresholdTokens
      };
    }
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
    if (currentInputAddendumTokens > requestBudget.safeBodyRoomTokens) {
      return compressionError(
        'current_input_too_large',
        'The exact current Turn input cannot fit in the safe model body room.',
        currentInputAddendumTokens,
        requestBudget.safeBodyRoomTokens
      );
    }
    if (irreducibleAddendaTokens > requestBudget.safeBodyRoomTokens) {
      return compressionError(
        'request_still_too_large',
        'Current input, runtime deliveries and the Turn reminder cannot fit even with empty history.',
        irreducibleAddendaTokens,
        requestBudget.safeBodyRoomTokens
      );
    }
    // Materialize source structure/content only after the level-trigger passes. Below-threshold checks
    // are the common path and should pay for one provider-aligned Context read, not three.
    const [materialized, semanticMaterialized] = await Promise.all([
      this.context.materializeStructure(headRootId),
      this.context.materialize(headRootId)
    ]);
    if (materialized.records.length === 0) return { status: 'skipped', reason: 'empty_context' };
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
              - (effectiveSummaryMaxTokens ?? 0))
          );
    const hardContextRoomTokens = Math.max(0, requestBudget.safeBodyRoomTokens - irreducibleAddendaTokens);
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
    const sourceHash = hashSource(sourceSegments);
    const idempotencyKey = [
      'context-compression', trigger, headRootId, policy.config.id, String(sourceSegmentCount), sourceHash
    ].join(':');
    const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
    const created = await this.modelProvider.createModelRequest({
      turnId,
      contextRootId: headRootId,
      authoritySnapshotId,
      recipe: normalizePlainJson({
        kind: 'reliable-context-compression',
        requestKind: trigger === 'auto' ? 'context_compression_pre' : 'context_compression_manual',
        trigger,
        sourceRootId: headRootId,
        sourceSegmentCount,
        sourceHash,
        blockId: compressionBlockIdFor(frozen.conversationId, headRootId, expectedModelRequestId),
        compressionConfigId: policy.config.id,
        compressionMethodKind: policy.methodKind,
        ...(effectiveSummaryMaxTokens === undefined ? {} : { effectiveSummaryMaxTokens })
      }, 'Reliable compression recipe'),
      idempotencyKey
    });
    if (created.modelRequestId !== expectedModelRequestId) {
      throw new Error('Compression ModelProvider returned an unexpected stable request identity.');
    }
    let request = await this.requireDomain('ModelRequest', expectedModelRequestId);
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
    const summary = compressionContents(completed.content);
    const summaryEstimatedTokens = compressionOutputTokens(completed.usage)
      ?? estimateMessageContentsTokens(summary);
    const projectedTokens = summaryEstimatedTokens
      + projectMaterializedSegmentsTokens(semanticMaterialized.segments.slice(sourceSegmentCount));
    const projectedBodyTokens = projectedTokens + irreducibleAddendaTokens;
    if (projectedBodyTokens > requestBudget.safeBodyRoomTokens) {
      return compressionError(
        'request_still_too_large',
        'The candidate compressed history plus frozen request addenda still exceeds the safe body room.',
        projectedBodyTokens,
        requestBudget.safeBodyRoomTokens
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
      summaryMetadata: {
        trigger,
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

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function selectCompressionPrefixByTokens(
  records: readonly StructuralContextRecord[],
  segments: ReadonlyArray<{
    segmentKind: string;
    messageRole: string | null;
    contentObject: { content_type: string };
    content: Buffer;
  }>,
  tailBudgetTokens: number
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
    groups.push({
      kind: functionResponseCount > 0 ? 'tool_exchange' : 'message',
      items,
      startIndex: start,
      endIndexExclusive: index,
      estimatedTokens: projectStoredModelFacingWindow(items.map((position) => ({
        segmentKind: segments[position].segmentKind,
        messageRole: segments[position].messageRole,
        contentType: segments[position].contentObject.content_type,
        content: segments[position].content.toString('utf8')
      }))).tokenCount,
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

function projectMaterializedSegmentsTokens(segments: ReadonlyArray<{
  segmentKind: string;
  messageRole: string | null;
  contentObject: { content_type: string };
  content: Buffer;
}>): number {
  return projectStoredModelFacingWindow(segments.map((segment) => ({
    segmentKind: segment.segmentKind,
    messageRole: segment.messageRole,
    contentType: segment.contentObject.content_type,
    content: segment.content.toString('utf8')
  }))).tokenCount;
}

function manualRequestBudget(document: PlainJsonValue, thresholdTokens: number): FullRequestBudget {
  const profile = frozenContextProfile(document);
  return calculateFullRequestBudget({
    contextWindowTokens: profile.contextWindowTokens,
    compressionThresholdTokens: thresholdTokens,
    breakdown: emptyRequestBreakdown()
  });
}

function emptyRequestBreakdown(): FullRequestBudget['breakdown'] {
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

function requireFullRequestBudget(value: FullRequestBudget, expectedThresholdTokens: number): FullRequestBudget {
  if (!value || typeof value !== 'object') throw new TypeError('requestBudget must be an object.');
  const integerFields: Array<keyof FullRequestBudget> = [
    'contextWindowTokens',
    'compressionThresholdTokens',
    'outputReserveTokens',
    'estimatorSlackTokens',
    'estimatedInputLimitTokens',
    'fixedTokens',
    'bodyTokens',
    'estimatedFullInputTokens',
    'safeBodyRoomTokens',
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
  if (typeof value.policyTrigger !== 'boolean'
    || typeof value.sendingTrigger !== 'boolean'
    || typeof value.fixedOverPolicy !== 'boolean'
    || typeof value.canSend !== 'boolean') {
    throw new TypeError('requestBudget trigger/send flags must be booleans.');
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

function compressionContents(value: PlainJsonValue): MessageContent[] {
  const record = requireRecord(value, 'Compression terminal content');
  if (record.type !== 'compression_result' || !Array.isArray(record.contents) || record.contents.length === 0) {
    throw new TypeError('Compression terminal checkpoint does not contain MessageContent[].');
  }
  return record.contents.map((entry, index) => {
    const content = requireRecord(entry, `Compression terminal content[${index}]`);
    if ((content.role !== 'user' && content.role !== 'model') || !Array.isArray(content.parts)) {
      throw new TypeError(`Compression terminal MessageContent ${index} is invalid.`);
    }
    return content as unknown as MessageContent;
  });
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

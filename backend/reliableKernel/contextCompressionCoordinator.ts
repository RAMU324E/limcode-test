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
import { frozenCompressionPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import {
  compressionOutputTokens,
  estimateMaterializedContextTokens,
  estimateMessageContentsTokens
} from './contextTokenEstimator';
import {
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
  /** Manual callers may freeze an explicit prefix. Automatic selection always uses preserveLatestMessages. */
  compressSegmentCount?: number;
  title?: string;
}

export type CoordinateCompressionResult =
  | {
      status: 'skipped';
      reason: 'disabled' | 'manual_only' | 'below_threshold' | 'finite_tail' | 'empty_context' | 'non_reducing';
      estimatedTokens?: number;
      thresholdTokens?: number;
    }
  | {
      status: 'compressed';
      trigger: CompressionTrigger;
      modelRequestId: string;
      sourceRootId: string;
      sourceSegmentCount: number;
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
    const decision = await this.compression.evaluate(headRootId, authoritySnapshotId);
    if (trigger === 'auto' && !decision.shouldCompress) {
      return {
        status: 'skipped',
        reason: 'below_threshold',
        estimatedTokens: decision.estimatedTokens,
        thresholdTokens: decision.thresholdTokens
      };
    }
    // Materialize source structure/content only after the level-trigger passes. Below-threshold checks
    // are the common path and should pay for one provider-aligned Context read, not three.
    const [materialized, semanticMaterialized] = await Promise.all([
      this.context.materializeStructure(headRootId),
      this.context.materialize(headRootId)
    ]);
    if (materialized.records.length === 0) return { status: 'skipped', reason: 'empty_context' };
    const requestedSourceSegmentCount = command.compressSegmentCount === undefined
      ? selectCompressionPrefix(materialized.records, policy.preserveLatestMessages)
      : requirePrefixCount(command.compressSegmentCount, materialized.records.length);
    const sourceSegmentCount = closeToolExchangeBoundary(materialized.records, requestedSourceSegmentCount);
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
        compressionMethodKind: policy.methodKind
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
      await this.modelProvider.dispatch(expectedModelRequestId, adapter, { reconnect: true });
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
      + estimateMaterializedContextTokens(semanticMaterialized.segments.slice(sourceSegmentCount));
    if (projectedTokens >= decision.estimatedTokens) {
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
      enforceThreshold: trigger === 'auto',
      idempotencyKey: expectedModelRequestId
    });
    return {
      status: 'compressed',
      trigger,
      modelRequestId: expectedModelRequestId,
      sourceRootId: headRootId,
      sourceSegmentCount,
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

function selectCompressionPrefix(records: readonly StructuralContextRecord[], preserveLatestMessages: number): number {
  const preserve = Math.max(0, Math.floor(preserveLatestMessages));
  if (records.length < 2) return 0;
  const messageIndexes = records.flatMap((record, index) =>
    record.segment.segment_kind === 'message' ? [index] : []
  );
  if (messageIndexes.length === 0) return records.length - 1;
  // A finite tail is mandatory. With preserve=0 retain the latest message and every following
  // tool_pair/runtime segment; with preserve=N retain the N latest message boundaries.
  const retainedMessages = Math.max(1, preserve);
  if (messageIndexes.length <= retainedMessages) return 0;
  return messageIndexes[messageIndexes.length - retainedMessages];
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

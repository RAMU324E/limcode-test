import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export type ContextSegmentKind = 'system' | 'message' | 'tool_pair' | 'compression' | 'runtime_context';
export type ContextSourceKind =
  | 'message_revision'
  | 'tool_call'
  | 'tool_model_result'
  | 'compression_block'
  | 'system'
  | 'runtime_context';

export interface ContextSourceOccurrence {
  sourceKind: ContextSourceKind;
  sourceId: string;
  sourceRevision: string | bigint;
}

export interface ContextAppendCommand {
  conversationId: string;
  segmentKind: Exclude<ContextSegmentKind, 'message' | 'tool_pair' | 'compression'>;
  source: ContextSourceOccurrence;
  content: string | Uint8Array;
  contentType: string;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
}

export interface ContextToolPairAppendCommand {
  conversationId: string;
  toolCallId: string;
  toolModelResultId: string;
  providerCallId?: string;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
}

export interface ContextAppendResult {
  segmentId: string;
  nodeId: string;
  rootId: string;
  rootSeq: string;
  commitSeq?: string;
  deduplicated: boolean;
}

export interface MaterializedContextSegment {
  nodeId: string;
  parentNodeId: string | null;
  segmentId: string;
  segmentKind: ContextSegmentKind;
  messageRole: string | null;
  contentObject: ContentObjectMetadata;
  content: Buffer;
}

export interface ContextMutationPlan {
  steps: RepositoryTransactionStep[];
}

export interface FreshConversationMessageContextPlan extends ContextMutationPlan {
  rootId: string;
  headLinkId: string;
}

export interface FreshConversationMessageContextPlanInput {
  conversationId: string;
  messageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
}

export interface MessageContextAppendPlanInput {
  conversationId: string;
  messageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
}

export interface MessageContextEditPlanInput {
  conversationId: string;
  previousMessageRevisionId: string;
  nextMessageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
}

export interface MessageContextDeletePlanInput {
  conversationId: string;
  messageRevisionId: string;
  idempotencyKey: string;
}

export interface MessageContextTruncateReplacement {
  messageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
}

export interface MessageContextTruncatePlanInput extends MessageContextDeletePlanInput {
  replacement?: MessageContextTruncateReplacement;
}

export interface MaterializedContext {
  root: DomainRow;
  segments: MaterializedContextSegment[];
  snapshotCommitSeq: string;
}

export interface ContextOrphanToolPairRepairReport {
  conversationsScanned: number;
  conversationsRepaired: number;
  removedToolPairs: number;
}

interface AppendOccurrencePlan {
  conversationId: string;
  segmentKind: ContextSegmentKind;
  sources: ContextSourceOccurrence[];
  content: PreparedContentObject;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
}

interface BaseShape {
  root: DomainRow | null;
  rootId: string | null;
  rootNodeId: string | null;
  tailNodeId: string | null;
  tailSegmentCount: bigint;
  segmentCount: bigint;
  estimatedTokens: bigint;
  compression: boolean;
}

const CONTENT_TYPE_TOOL_PAIR = 'application/vnd.limcode.context-tool-pair+json';
const EXPECTED_OCCURRENCE_CONSTRAINTS = [
  { domain: 'ContextSegment', columns: ['id'] },
  { domain: 'ContextSegmentSource', columns: ['source_kind', 'source_id', 'source_revision'] }
];
const EXPECTED_NODE_CONSTRAINTS = [
  { domain: 'ContextSequenceNode', columns: ['id'] },
  { domain: 'ContextSequenceNode', columns: ['parent_node_id', 'segment_id'] },
  { domain: 'ContextSequenceNode', columns: ['segment_id'] }
];

/** Stage E Context authority. It never reads current Message state while materializing a frozen root. */
export class ContextSequenceControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async appendContent(command: ContextAppendCommand): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const segmentKind = requireSegmentKind(command.segmentKind);
    if (segmentKind === 'message' || segmentKind === 'tool_pair' || segmentKind === 'compression') {
      throw new TypeError(`appendContent cannot create ${segmentKind} segments.`);
    }
    const sources = [normalizeSource(command.source)];
    validateSegmentSources(segmentKind, sources);
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const content = await this.contentStore.prepare(
      this.database,
      command.content,
      requireText(command.contentType, 'contentType')
    );
    return this.appendOccurrence({
      conversationId,
      segmentKind,
      sources,
      content,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate
    });
  }

  public async appendToolPair(command: ContextToolPairAppendCommand): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const toolCallId = requireId(command.toolCallId, 'toolCallId');
    const toolModelResultId = requireId(command.toolModelResultId, 'toolModelResultId');
    const providerCallId = command.providerCallId === undefined
      ? undefined
      : requireId(command.providerCallId, 'providerCallId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').get(toolModelResultId)
    ]);
    const toolCall = requireRow(snapshot.snapshot[0], `ToolCall ${toolCallId}`);
    const modelResult = requireRow(snapshot.snapshot[1], `ToolModelResult ${toolModelResultId}`);
    if (modelResult.tool_call_id !== toolCallId) throw new Error('ToolModelResult does not belong to ToolCall.');
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const resultRevisionId = requireId(modelResult.message_revision_id, 'ToolModelResult.message_revision_id');
    const related = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(resultRevisionId),
      DOMAIN_REPOSITORIES.domain('ContentObject').get(requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id'))
    ]);
    const turn = requireRow(related.snapshot[0], `Turn ${turnId}`);
    if (turn.conversation_id !== conversationId) throw new Error('ToolCall belongs to another Conversation.');
    const resultRevision = requireRow(related.snapshot[1], `MessageRevision ${resultRevisionId}`);
    const resultContentId = requireId(resultRevision.content_object_id, 'MessageRevision.content_object_id');
    const resultContentSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContentObject').get(resultContentId)
    ]);
    const argumentMetadata = asContentObjectMetadata(requireRow(
      related.snapshot[2],
      `ContentObject ${String(toolCall.arguments_object_id)}`
    ));
    const resultMetadata = asContentObjectMetadata(requireRow(
      resultContentSnapshot.snapshot[0],
      `ContentObject ${resultContentId}`
    ));
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const [argumentsBytes, resultBytes] = await this.contentStore.readMany([argumentMetadata, resultMetadata]);
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    const pair = await this.contentStore.prepare(this.database, JSON.stringify({
      kind: 'tool_pair',
      toolCall: {
        id: toolCallId,
        ...(providerCallId ? { providerCallId } : {}),
        callSeq: callSeq.toString(),
        toolName: requireText(toolCall.tool_name, 'ToolCall.tool_name'),
        argumentsContentType: argumentMetadata.content_type,
        arguments: argumentsBytes.toString('utf8')
      },
      toolModelResult: {
        id: toolModelResultId,
        messageRevisionId: resultRevisionId,
        resultContentType: resultMetadata.content_type,
        result: resultBytes.toString('utf8')
      }
    }), CONTENT_TYPE_TOOL_PAIR);
    return this.appendOccurrence({
      conversationId,
      segmentKind: 'tool_pair',
      sources: [
        { sourceKind: 'tool_call', sourceId: toolCallId, sourceRevision: callSeq },
        { sourceKind: 'tool_model_result', sourceId: toolModelResultId, sourceRevision: callSeq }
      ],
      content: pair,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate
    });
  }

  public async materializeStructure(rootId: string): Promise<MaterializedContextStructure> {
    const barrier = await this.database.materializeContext(requireId(rootId, 'rootId'));
    return {
      root: barrier.snapshot.root,
      records: barrier.snapshot.records,
      snapshotCommitSeq: barrier.snapshotCommitSeq
    };
  }

  public async materialize(rootId: string): Promise<MaterializedContext> {
    const barrier = await this.database.materializeContextContent(requireId(rootId, 'rootId'));
    return {
      root: barrier.snapshot.root,
      segments: barrier.snapshot.records.map((record) => ({
        nodeId: requireId(record.node.id, 'ContextSequenceNode.id'),
        parentNodeId: nullableId(record.node.parent_node_id, 'ContextSequenceNode.parent_node_id'),
        segmentId: requireId(record.segment.id, 'ContextSegment.id'),
        segmentKind: requireSegmentKind(record.segment.segment_kind),
        messageRole: nullableText(record.messageRole, 'Context message role'),
        contentObject: asContentObjectMetadata(record.contentObject),
        content: bufferView(record.content)
      })),
      snapshotCommitSeq: barrier.snapshotCommitSeq
    };
  }

  public async currentHeadRootId(conversationId: string): Promise<string | null> {
    const head = await this.getHead(requireId(conversationId, 'conversationId'));
    return head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
  }

  /**
   * Builds the first Message Context root for a Conversation that is created in the same writer
   * transaction. No database read is performed, so ChildExecution can atomically establish its
   * Conversation, first Turn, input Message, frozen Authority and Context head.
   */
  public prepareFreshConversationMessageMutation(
    input: FreshConversationMessageContextPlanInput
  ): FreshConversationMessageContextPlan {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const contentByteLength = requireBigInt(input.contentByteLength, 'contentByteLength');
    if (contentByteLength < 0n) throw new TypeError('contentByteLength must be non-negative.');
    const segmentId = stableSegmentId([{
      sourceKind: 'message_revision', sourceId: revisionId, sourceRevision: 0n
    }]);
    const nodeId = contextSequenceNodeId(null, segmentId);
    const rootId = stableId('context_root_append', conversationId, '<null>', nodeId);
    const headLinkId = stableId('conversation_context_head', conversationId);
    const now = this.timestamp();
    return {
      rootId,
      headLinkId,
      steps: [
        DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assertNone({ conversation_id: conversationId }),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps([{ id: nodeId, parentNodeId: null, segmentId, now }], 'fresh_message_context_node'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: nodeId,
          tail_node_id: null,
          tail_segment_count: 0n,
          segment_count: 1n,
          estimated_tokens: estimateTokens(contentByteLength),
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
          id: headLinkId,
          conversation_id: conversationId,
          root_id: rootId,
          updated_at: now
        })
      ]
    };
  }

  /** Prepared steps are committed by TurnControlPlane together with the new MessageRevision. */
  public async prepareMessageAppendMutation(input: MessageContextAppendPlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const contentByteLength = requireBigInt(input.contentByteLength, 'contentByteLength');
    if (contentByteLength < 0n) throw new TypeError('contentByteLength must be non-negative.');
    const head = await this.getHead(conversationId);
    const baseRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const base = await this.readBaseShape(conversationId, baseRootId);
    const segmentId = stableSegmentId([{
      sourceKind: 'message_revision', sourceId: revisionId, sourceRevision: 0n
    }]);
    const parentNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
    const nodeId = contextSequenceNodeId(parentNodeId, segmentId);
    const rootId = stableId('context_root_append', conversationId, baseRootId ?? '<null>', nodeId);
    const now = this.timestamp();
    return {
      steps: [
        ...headAssertionSteps(conversationId, head, baseRootId),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps([{ id: nodeId, parentNodeId, segmentId, now }], 'message_append_nodes'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: base.compression ? base.rootNodeId : nodeId,
          tail_node_id: base.compression ? nodeId : null,
          tail_segment_count: base.compression ? base.tailSegmentCount + 1n : 0n,
          segment_count: base.segmentCount + 1n,
          estimated_tokens: base.estimatedTokens + estimateTokens(contentByteLength),
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, head, rootId, now)
      ]
    };
  }

  /** Shares the immutable prefix and rebuilds only the suffix after the edited occurrence. */
  public async prepareMessageEditMutation(input: MessageContextEditPlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const previousRevisionId = requireId(input.previousMessageRevisionId, 'previousMessageRevisionId');
    const nextRevisionId = requireId(input.nextMessageRevisionId, 'nextMessageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const state = await this.currentStructuralState(conversationId);
    const sourceRow = await this.findMessageSource(previousRevisionId);
    if (!sourceRow) {
      throw new Error(`MessageRevision ${previousRevisionId} has no Context occurrence.`);
    }
    const sourceSegmentId = requireId(sourceRow.segment_id, 'ContextSegmentSource.segment_id');
    const targetIndex = state.records.findIndex((record) => record.segment.id === sourceSegmentId);
    if (targetIndex < 0) {
      const expanded = await this.expandCurrentCompressionForTarget(state, sourceSegmentId);
      if (expanded) {
        return this.prepareExpandedCompressionMessageMutation({
          kind: 'edit',
          conversationId,
          state,
          expanded,
          targetSegmentId: sourceSegmentId,
          rootId: stableId('context_root_edit', conversationId, state.rootId, previousRevisionId, nextRevisionId),
          nextRevisionId,
          contentObjectId,
          contentByteLength: input.contentByteLength
        });
      }
      throw new Error(`MessageRevision ${previousRevisionId} is not part of the current Context head.`);
    }
    const source: ContextSourceOccurrence = {
      sourceKind: 'message_revision', sourceId: nextRevisionId, sourceRevision: 0n
    };
    const segmentId = stableSegmentId([source]);
    const now = this.timestamp();
    const rebuilt = rebuildSuffix(state.records, targetIndex, { replacementSegmentId: segmentId, now });
    const rootId = stableId('context_root_edit', conversationId, state.rootId, previousRevisionId, nextRevisionId);
    const compression = state.records[0]?.segment.segment_kind === 'compression';
    return {
      steps: [
        ...headAssertionSteps(conversationId, state.head, state.rootId),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId: nextRevisionId,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps(rebuilt.nodes, 'message_edit_nodes'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: compression ? requireId(state.root.root_node_id, 'ContextSequenceRoot.root_node_id') : rebuilt.lastNodeId,
          tail_node_id: compression ? rebuilt.lastNodeId : null,
          tail_segment_count: compression
            ? requireBigInt(state.root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count')
            : 0n,
          segment_count: requireBigInt(state.root.segment_count, 'ContextSequenceRoot.segment_count'),
          estimated_tokens: requireBigInt(state.root.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, state.head, rootId, now)
      ]
    };
  }

  /**
   * Truncates the current Context at one Message occurrence. The target and every structural
   * segment after it (including tool pairs and runtime context) disappear from the new head.
   * An optional replacement is appended at the exact boundary for edit-and-rerun.
   */
  public async prepareMessageTruncateMutation(input: MessageContextTruncatePlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const replacement = input.replacement
      ? {
          messageRevisionId: requireId(input.replacement.messageRevisionId, 'replacement.messageRevisionId'),
          contentObjectId: requireId(input.replacement.contentObjectId, 'replacement.contentObjectId'),
          contentByteLength: requireBigInt(
            input.replacement.contentByteLength,
            'replacement.contentByteLength'
          )
        }
      : null;
    if (replacement && replacement.contentByteLength < 0n) {
      throw new TypeError('replacement.contentByteLength must be non-negative.');
    }
    const state = await this.currentStructuralState(conversationId);
    const sourceRow = await this.findMessageSource(revisionId);
    if (!sourceRow) {
      throw new Error(`MessageRevision ${revisionId} has no Context occurrence.`);
    }
    const sourceSegmentId = requireId(sourceRow.segment_id, 'ContextSegmentSource.segment_id');
    const targetIndex = state.records.findIndex((record) => record.segment.id === sourceSegmentId);
    let prefix: EditableContextSegment[];
    let blocks: DomainRow[] = [];
    if (targetIndex >= 0) {
      prefix = state.records.slice(0, targetIndex).map((record) => ({
        segment: record.segment,
        contentObject: record.contentObject
      }));
    } else {
      const expanded = await this.expandCurrentCompressionForTarget(state, sourceSegmentId);
      if (!expanded) {
        throw new Error(`MessageRevision ${revisionId} is not part of the current Context head.`);
      }
      const expandedTargetIndex = expanded.segments.findIndex((record) =>
        record.segment.id === sourceSegmentId
      );
      if (expandedTargetIndex < 0) {
        throw new Error('Expanded compression lineage does not contain the truncation target.');
      }
      prefix = expanded.segments.slice(0, expandedTargetIndex);
      blocks = expanded.blocks;
    }

    const now = this.timestamp();
    let replacementSegmentId: string | null = null;
    const occurrenceSteps: RepositoryTransactionStep[] = [];
    if (replacement) {
      replacementSegmentId = stableSegmentId([{
        sourceKind: 'message_revision',
        sourceId: replacement.messageRevisionId,
        sourceRevision: 0n
      }]);
      occurrenceSteps.push(...messageOccurrenceWithAllocatedRevisionSteps({
        segmentId: replacementSegmentId,
        revisionId: replacement.messageRevisionId,
        contentObjectId: replacement.contentObjectId,
        now
      }));
      prefix.push({
        segment: { id: replacementSegmentId, segment_kind: 'message' },
        contentObject: { byte_length: replacement.contentByteLength }
      });
    }

    const retainedSummary = prefix[0]?.segment.segment_kind === 'compression' ? prefix[0] : null;
    const tailSegments = retainedSummary ? prefix.slice(1) : prefix;
    const nodes = buildSequenceNodes(
      tailSegments.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
      now
    );
    const summaryNodeId = retainedSummary
      ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
      : null;
    const estimatedTokens = prefix.reduce((total, record) =>
      total + estimateTokens(requireBigInt(record.contentObject.byte_length, 'ContentObject.byte_length')),
    0n);
    const blockSteps = uniqueRows(blocks).flatMap((block) => {
      if (block.status !== 'enabled') return [];
      const blockId = requireId(block.id, 'CompressionBlock.id');
      return [
        DOMAIN_REPOSITORIES.domain('CompressionBlock').assert(blockId, { status: 'enabled' }),
        DOMAIN_REPOSITORIES.domain('CompressionBlock').update(blockId, {
          status: 'disabled', updated_at: now
        })
      ];
    });
    const rootId = stableId(
      'context_root_truncate',
      conversationId,
      state.rootId,
      revisionId,
      replacement?.messageRevisionId ?? '<delete>',
      idempotencyKey
    );
    return {
      steps: [
        ...headAssertionSteps(conversationId, state.head, state.rootId),
        ...occurrenceSteps,
        ...nodeInsertSteps(nodes, 'message_truncate_nodes'),
        ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
          requireId(summaryNodeId, 'retained compression node id'),
          {
            parent_node_id: null,
            segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
          }
        )] : []),
        ...blockSteps,
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: retainedSummary
            ? summaryNodeId
            : nodes.length ? nodes[nodes.length - 1].id : null,
          tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
          tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
          segment_count: BigInt(prefix.length),
          estimated_tokens: estimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, state.head, rootId, now)
      ]
    };
  }

  /** Deletion is a semantic delete-from operation, not removal of one projected Message row. */
  public async prepareMessageDeleteMutation(input: MessageContextDeletePlanInput): Promise<ContextMutationPlan> {
    return this.prepareMessageTruncateMutation(input);
  }

  /**
   * Startup integrity maintenance for roots produced by the former per-Message delete loop.
   * It removes only explicit tool-pair segments whose source model Message is soft-deleted,
   * preserving every later valid segment. Active Conversations are left untouched.
   */
  public async repairOrphanToolPairs(signal?: AbortSignal): Promise<ContextOrphanToolPairRepairReport> {
    signal?.throwIfAborted();
    const heads = await listAllDomainRows(this.database, 'ConversationContextHeadLink');
    let conversationsRepaired = 0;
    let removedToolPairs = 0;
    for (const observedHead of heads) {
      signal?.throwIfAborted();
      const conversationId = requireId(observedHead.conversation_id, 'ConversationContextHeadLink.conversation_id');
      const activity = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
          where: { conversation_id: conversationId },
          limit: 1
        }),
        DOMAIN_REPOSITORIES.domain('Turn').list({
          where: { conversation_id: conversationId, status: 'active' },
          limit: 1
        })
      ]);
      if (rows(activity.snapshot[0]).length > 0 || rows(activity.snapshot[1]).length > 0) continue;
      const state = await this.currentStructuralState(conversationId);
      const removedSegmentIds = new Set<string>();
      const ownerAssertions: RepositoryTransactionStep[] = [];
      for (const record of state.records) {
        signal?.throwIfAborted();
        if (record.segment.segment_kind !== 'tool_pair') continue;
        const segmentId = requireId(record.segment.id, 'ContextSegment.id');
        const sourceSnapshot = await this.database.snapshotAll(
          DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
            where: { segment_id: segmentId },
            orderBy: { column: 'id', direction: 'asc' },
            limit: 1000
          })
        );
        const callSources = sourceSnapshot.snapshot.filter((source) => source.source_kind === 'tool_call');
        if (callSources.length !== 1) {
          removedSegmentIds.add(segmentId);
          continue;
        }
        const toolCallId = requireId(callSources[0].source_id, 'ContextSegmentSource.source_id');
        const linkSnapshot = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
            where: { tool_call_id: toolCallId },
            limit: 2
          })
        ]);
        const links = rows(linkSnapshot.snapshot[0]);
        if (links.length !== 1) {
          removedSegmentIds.add(segmentId);
          continue;
        }
        const ownerMessageId = requireId(links[0].message_id, 'ToolCallSourceLink.message_id');
        const ownerSnapshot = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('Message').get(ownerMessageId)
        ]);
        const owner = ownerSnapshot.snapshot[0] as DomainRow | null;
        if (!owner || owner.deleted_at === null) continue;
        const deletedAt = requireText(owner.deleted_at, 'Message.deleted_at');
        removedSegmentIds.add(segmentId);
        ownerAssertions.push(DOMAIN_REPOSITORIES.domain('Message').assert(ownerMessageId, {
          deleted_at: deletedAt
        }));
      }
      if (removedSegmentIds.size === 0) continue;

      const retained = state.records.filter((record) =>
        !removedSegmentIds.has(requireId(record.segment.id, 'ContextSegment.id'))
      );
      const retainedSummary = retained[0]?.segment.segment_kind === 'compression' ? retained[0] : null;
      const tailRecords = retainedSummary ? retained.slice(1) : retained;
      const now = this.timestamp();
      const nodes = buildSequenceNodes(
        tailRecords.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
        now
      );
      const summaryNodeId = retainedSummary
        ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
        : null;
      const rootId = stableId(
        'context_root_repair_orphan_tool_pairs',
        conversationId,
        state.rootId,
        ...[...removedSegmentIds].sort()
      );
      const estimatedTokens = retained.reduce((total, record) =>
        total + estimateTokens(requireBigInt(record.contentObject.byte_length, 'ContentObject.byte_length')),
      0n);
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ conversation_id: conversationId }),
          DOMAIN_REPOSITORIES.domain('Turn').assertNone({
            conversation_id: conversationId,
            status: 'active'
          }),
          ...headAssertionSteps(conversationId, state.head, state.rootId),
          ...ownerAssertions,
          ...nodeInsertSteps(nodes, 'repair_orphan_tool_pair_nodes'),
          ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
            requireId(summaryNodeId, 'retained compression node id'),
            {
              parent_node_id: null,
              segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
            }
          )] : []),
          DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
            id: rootId,
            conversation_id: conversationId,
            root_node_id: retainedSummary
              ? summaryNodeId
              : nodes.length ? nodes[nodes.length - 1].id : null,
            tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
            tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
            segment_count: BigInt(retained.length),
            estimated_tokens: estimatedTokens,
            created_at: now
          }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
          ...headMutationSteps(conversationId, state.head, rootId, now),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]);
      } catch (error) {
        // Background startup maintenance may race a real user Turn after the VS Code surface is
        // already usable. The exact head/activity assertions are the authority: losing that CAS
        // means this observed root is stale and must be left to the live mutation or next scan.
        if (!isRecoverableAppendRace(error)) throw error;
        continue;
      }
      conversationsRepaired += 1;
      removedToolPairs += removedSegmentIds.size;
    }
    return {
      conversationsScanned: heads.length,
      conversationsRepaired,
      removedToolPairs
    };
  }

  private async prepareExpandedCompressionMessageMutation(input: {
    kind: 'edit' | 'delete';
    conversationId: string;
    state: Awaited<ReturnType<ContextSequenceControlPlane['currentStructuralState']>>;
    expanded: ExpandedCompressionContext;
    targetSegmentId: string;
    rootId: string;
    nextRevisionId?: string;
    contentObjectId?: string;
    contentByteLength?: bigint;
  }): Promise<ContextMutationPlan> {
    const targetIndex = input.expanded.segments.findIndex((record) =>
      record.segment.id === input.targetSegmentId
    );
    if (targetIndex < 0) throw new Error('Expanded compression lineage does not contain the target segment.');
    const now = this.timestamp();
    let replacementSegmentId: string | null = null;
    const occurrenceSteps: RepositoryTransactionStep[] = [];
    if (input.kind === 'edit') {
      const nextRevisionId = requireId(input.nextRevisionId, 'nextRevisionId');
      const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
      replacementSegmentId = stableSegmentId([{
        sourceKind: 'message_revision', sourceId: nextRevisionId, sourceRevision: 0n
      }]);
      occurrenceSteps.push(...messageOccurrenceWithAllocatedRevisionSteps({
        segmentId: replacementSegmentId,
        revisionId: nextRevisionId,
        contentObjectId,
        now
      }));
    }
    const finalSegments: EditableContextSegment[] = [
      ...input.expanded.segments.slice(0, targetIndex),
      ...(replacementSegmentId ? [{
        segment: { id: replacementSegmentId, segment_kind: 'message' },
        contentObject: {
          byte_length: requireBigInt(input.contentByteLength, 'contentByteLength')
        }
      }] : []),
      ...input.expanded.segments.slice(targetIndex + 1)
    ];
    const retainedSummary = finalSegments[0]?.segment.segment_kind === 'compression'
      ? finalSegments[0]
      : null;
    const tailSegments = retainedSummary ? finalSegments.slice(1) : finalSegments;
    const nodes = buildSequenceNodes(
      tailSegments.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
      now
    );
    const summaryNodeId = retainedSummary
      ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
      : null;
    const estimatedTokens = finalSegments.reduce((total, record) =>
      total + estimateTokens(requireBigInt(record.contentObject.byte_length, 'ContentObject.byte_length')),
    0n);
    const blockSteps = uniqueRows(input.expanded.blocks).flatMap((block) => {
      if (block.status !== 'enabled') return [];
      const blockId = requireId(block.id, 'CompressionBlock.id');
      return [
        DOMAIN_REPOSITORIES.domain('CompressionBlock').assert(blockId, { status: 'enabled' }),
        DOMAIN_REPOSITORIES.domain('CompressionBlock').update(blockId, {
          status: 'disabled', updated_at: now
        })
      ];
    });
    return {
      steps: [
        ...headAssertionSteps(input.conversationId, input.state.head, input.state.rootId),
        ...occurrenceSteps,
        ...nodeInsertSteps(nodes, `compressed_message_${input.kind}_nodes`),
        ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
          requireId(summaryNodeId, 'retained compression node id'),
          {
            parent_node_id: null,
            segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
          }
        )] : []),
        ...blockSteps,
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: input.rootId,
          conversation_id: input.conversationId,
          root_node_id: retainedSummary
            ? summaryNodeId
            : nodes.length ? nodes[nodes.length - 1].id : null,
          tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
          tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
          segment_count: BigInt(finalSegments.length),
          estimated_tokens: estimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: input.conversationId } }),
        ...headMutationSteps(input.conversationId, input.state.head, input.rootId, now)
      ]
    };
  }

  private async expandCurrentCompressionForTarget(
    state: Awaited<ReturnType<ContextSequenceControlPlane['currentStructuralState']>>,
    targetSegmentId: string
  ): Promise<ExpandedCompressionContext | null> {
    const summary = state.records[0];
    if (!summary || summary.segment.segment_kind !== 'compression') return null;
    const expanded = await this.expandCompressionSegmentForTarget(
      requireId(summary.segment.id, 'ContextSegment.id'),
      targetSegmentId,
      new Set()
    );
    if (!expanded.containsTarget) return null;
    return {
      segments: [
        ...expanded.segments,
        ...state.records.slice(1).map((record) => ({
          segment: record.segment,
          contentObject: record.contentObject
        }))
      ],
      blocks: expanded.blocks
    };
  }

  private async expandCompressionSegmentForTarget(
    segmentId: string,
    targetSegmentId: string,
    path: ReadonlySet<string>
  ): Promise<CompressionExpansion> {
    const current = await this.readEditableSegment(segmentId);
    if (segmentId === targetSegmentId) {
      return { containsTarget: true, segments: [current], blocks: [] };
    }
    if (current.segment.segment_kind !== 'compression') {
      return { containsTarget: false, segments: [current], blocks: [] };
    }
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    const sourceSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: {
          segment_id: segmentId,
          source_kind: 'compression_block',
          source_revision: 0n
        },
        limit: 1
      })
    ]);
    const source = rows(sourceSnapshot.snapshot[0])[0];
    if (!source) throw new Error(`Compression segment ${segmentId} has no CompressionBlock source.`);
    const blockId = requireId(source.source_id, 'ContextSegmentSource.source_id');
    const block = await this.getOptional('CompressionBlock', blockId);
    if (!block) throw new Error(`CompressionBlock ${blockId} does not exist.`);
    const sourceRows = await this.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
        where: { compression_block_id: blockId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    );
    const ordered = [...sourceRows.snapshot].sort(compareCompressionSourcePosition);
    ordered.forEach((row, position) => {
      if (requireBigInt(row.position, 'CompressionBlockSource.position') !== BigInt(position)) {
        throw new Error(`CompressionBlock ${blockId} source positions are not contiguous.`);
      }
    });
    if (!ordered.length) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
    const nextPath = new Set(path);
    nextPath.add(segmentId);
    const children = await Promise.all(ordered.map((row) => this.expandCompressionSegmentForTarget(
      requireId(row.segment_id, 'CompressionBlockSource.segment_id'),
      targetSegmentId,
      nextPath
    )));
    if (!children.some((child) => child.containsTarget)) {
      return { containsTarget: false, segments: [current], blocks: [] };
    }
    return {
      containsTarget: true,
      segments: children.flatMap((child) => child.segments),
      blocks: [block, ...children.flatMap((child) => child.blocks)]
    };
  }

  private async readEditableSegment(segmentId: string): Promise<EditableContextSegment> {
    const segment = await this.getOptional('ContextSegment', segmentId);
    if (!segment) throw new Error(`ContextSegment ${segmentId} does not exist.`);
    const contentObjectId = requireId(segment.content_object_id, 'ContextSegment.content_object_id');
    const contentObject = await this.getOptional('ContentObject', contentObjectId);
    if (!contentObject) throw new Error(`ContentObject ${contentObjectId} does not exist.`);
    return { segment, contentObject };
  }

  private async currentStructuralState(conversationId: string): Promise<{
    head: DomainRow;
    rootId: string;
    root: DomainRow;
    records: StructuralContextRecord[];
  }> {
    const head = await this.getHead(conversationId);
    if (!head) throw new Error(`Conversation ${conversationId} has no Context head.`);
    const rootId = requireId(head.root_id, 'ConversationContextHeadLink.root_id');
    const materialized = await this.materializeStructure(rootId);
    if (materialized.root.conversation_id !== conversationId) {
      throw new Error(`Context head ${rootId} belongs to another Conversation.`);
    }
    return { head, rootId, root: materialized.root, records: materialized.records };
  }

  private async findMessageSource(revisionId: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'message_revision', source_id: revisionId },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0] ?? null;
  }

  private async preflightAppendTarget(
    conversationId: string,
    baseRootIdInput: string | null | undefined,
    expectedHeadRootIdInput: string | null | undefined,
    activate: boolean
  ): Promise<void> {
    const head = await this.getHead(conversationId);
    const currentHeadRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const expectedHeadRootId = expectedHeadRootIdInput === undefined
      ? currentHeadRootId
      : nullableId(expectedHeadRootIdInput, 'expectedHeadRootId');
    if (activate && currentHeadRootId !== expectedHeadRootId) throw staleHeadError(conversationId);
    const baseRootId = baseRootIdInput === undefined
      ? expectedHeadRootId
      : nullableId(baseRootIdInput, 'baseRootId');
    await this.readBaseShape(conversationId, baseRootId);
  }

  private async appendOccurrence(planInput: AppendOccurrencePlan): Promise<ContextAppendResult> {
    const conversationId = requireId(planInput.conversationId, 'conversationId');
    const sources = normalizeSources(planInput.sources);
    const segmentKind = requireSegmentKind(planInput.segmentKind);
    validateSegmentSources(segmentKind, sources);
    const activate = planInput.activate !== false;
    const head = await this.getHead(conversationId);
    const currentHeadRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const expectedHeadRootId = planInput.expectedHeadRootId === undefined
      ? currentHeadRootId
      : nullableId(planInput.expectedHeadRootId, 'expectedHeadRootId');
    if (activate && currentHeadRootId !== expectedHeadRootId) throw staleHeadError(conversationId);
    const baseRootId = planInput.baseRootId === undefined
      ? expectedHeadRootId
      : nullableId(planInput.baseRootId, 'baseRootId');
    const base = await this.readBaseShape(conversationId, baseRootId);
    const segmentId = stableSegmentId(sources);
    const parentNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
    const nodeId = contextSequenceNodeId(parentNodeId, segmentId);
    const rootId = stableId('context_root_append', conversationId, baseRootId ?? '<null>', nodeId);
    const existingOccurrence = await this.readOccurrence(sources);
    if (existingOccurrence) {
      assertExistingSegment(existingOccurrence, segmentId, segmentKind, planInput.content.metadata.id);
      const existingNode = await this.getOptional('ContextSequenceNode', nodeId);
      const existingRoot = await this.getOptional('ContextSequenceRoot', rootId);
      if (existingNode && existingRoot) {
        return this.replayOrActivateAppend({
          conversationId, expectedHeadRootId, activate, root: existingRoot, segmentId, nodeId, rootId
        });
      }
      const tipNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
      if (base.root && base.rootId && tipNodeId) {
        const tip = await this.getOptional('ContextSequenceNode', tipNodeId);
        if (tip?.segment_id === segmentId) {
          return this.replayOrActivateAppend({
            conversationId,
            expectedHeadRootId,
            activate,
            root: base.root,
            segmentId,
            nodeId: tipNodeId,
            rootId: base.rootId
          });
        }
      }
      throw sourceParentConflictError(sources, baseRootId);
    }
    const now = this.timestamp();
    const estimated = estimateTokens(planInput.content.metadata.byte_length);
    const rootShape = base.compression
      ? {
          rootNodeId: base.rootNodeId,
          tailNodeId: nodeId,
          tailSegmentCount: base.tailSegmentCount + 1n
        }
      : {
          rootNodeId: nodeId,
          tailNodeId: null,
          tailSegmentCount: 0n
        };
    const steps: RepositoryTransactionStep[] = [
      ...(activate ? headAssertionSteps(conversationId, head, expectedHeadRootId) : []),
      ...preparedContentObjectSteps([planInput.content], 'context_content'),
      ...occurrenceInsertSteps({
        segmentId,
        segmentKind,
        contentObjectId: planInput.content.metadata.id,
        sources,
        now
      }),
      ...nodeInsertSteps([{ id: nodeId, parentNodeId, segmentId, now }], 'context_node_append'),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: rootId,
        conversation_id: conversationId,
        root_node_id: rootShape.rootNodeId,
        tail_node_id: rootShape.tailNodeId,
        tail_segment_count: rootShape.tailSegmentCount,
        segment_count: base.segmentCount + 1n,
        estimated_tokens: base.estimatedTokens + estimated,
        created_at: now
      }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
      ...(activate ? headMutationSteps(conversationId, head, rootId, now) : [])
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        segmentId,
        nodeId,
        rootId,
        rootSeq: allocatedValue(commit.allocatedSequences, 'ContextSequenceRoot', rootId, 'root_seq'),
        commitSeq: commit.commitSeq,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableAppendRace(error)) throw error;
      const racedOccurrence = await this.readOccurrence(sources);
      if (!racedOccurrence) throw error;
      assertExistingSegment(racedOccurrence, segmentId, segmentKind, planInput.content.metadata.id);
      const racedNode = await this.getOptional('ContextSequenceNode', nodeId);
      const racedRoot = await this.getOptional('ContextSequenceRoot', rootId);
      if (!racedNode || !racedRoot) throw sourceParentConflictError(sources, baseRootId);
      return this.replayOrActivateAppend({
        conversationId, expectedHeadRootId, activate, root: racedRoot, segmentId, nodeId, rootId
      });
    }
  }

  private async replayOrActivateAppend(input: {
    conversationId: string;
    expectedHeadRootId: string | null;
    activate: boolean;
    root: DomainRow;
    segmentId: string;
    nodeId: string;
    rootId: string;
  }): Promise<ContextAppendResult> {
    if (!input.activate) return this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId);
    const latestHead = await this.getHead(input.conversationId);
    const latestHeadRootId = latestHead ? requireId(latestHead.root_id, 'ConversationContextHeadLink.root_id') : null;
    if (latestHeadRootId === input.rootId) {
      return this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId);
    }
    if (latestHeadRootId !== input.expectedHeadRootId) throw staleHeadError(input.conversationId);
    const commit = await this.database.transaction([
      ...headAssertionSteps(input.conversationId, latestHead, input.expectedHeadRootId),
      ...headMutationSteps(input.conversationId, latestHead, input.rootId, this.timestamp())
    ]);
    return {
      ...this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId),
      commitSeq: commit.commitSeq
    };
  }

  private async readBaseShape(conversationId: string, rootId: string | null): Promise<BaseShape> {
    const conversation = await this.getOptional('Conversation', conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} does not exist.`);
    if (rootId === null) {
      return {
        root: null,
        rootId: null,
        rootNodeId: null,
        tailNodeId: null,
        tailSegmentCount: 0n,
        segmentCount: 0n,
        estimatedTokens: 0n,
        compression: false
      };
    }
    const root = await this.getOptional('ContextSequenceRoot', rootId);
    if (!root) throw new Error(`ContextSequenceRoot ${rootId} does not exist.`);
    if (root.conversation_id !== conversationId) throw new Error(`ContextSequenceRoot ${rootId} belongs to another Conversation.`);
    const rootNodeId = nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id');
    let compression = false;
    if (rootNodeId) {
      const node = await this.getOptional('ContextSequenceNode', rootNodeId);
      if (!node) throw new Error(`ContextSequenceRoot ${rootId} has a missing root node.`);
      const segment = await this.getOptional('ContextSegment', requireId(node.segment_id, 'ContextSequenceNode.segment_id'));
      if (!segment) throw new Error(`ContextSequenceRoot ${rootId} has a missing root segment.`);
      compression = segment.segment_kind === 'compression';
    }
    return {
      root,
      rootId,
      rootNodeId,
      tailNodeId: nullableId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id'),
      tailSegmentCount: requireBigInt(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count'),
      segmentCount: requireBigInt(root.segment_count, 'ContextSequenceRoot.segment_count'),
      estimatedTokens: requireBigInt(root.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
      compression
    };
  }

  private async readOccurrence(sources: readonly ContextSourceOccurrence[]): Promise<DomainRow | null> {
    const reads = sources.map((source) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
      where: {
        source_kind: source.sourceKind,
        source_id: source.sourceId,
        source_revision: source.sourceRevision
      },
      limit: 1
    }));
    const snapshot = await this.database.snapshot(reads);
    const sourceRows = snapshot.snapshot.map((value) => rows(value)[0] ?? null);
    if (sourceRows.every((row) => row === null)) return null;
    if (sourceRows.some((row) => row === null)) throw new Error('Context source occurrence is partially registered.');
    const normalizedRows = sourceRows as DomainRow[];
    const segmentIds = new Set(normalizedRows.map((row) => requireId(row.segment_id, 'ContextSegmentSource.segment_id')));
    if (segmentIds.size !== 1) throw new Error('Context source occurrence rows point to different segments.');
    const segmentId = [...segmentIds][0];
    const segment = await this.getOptional('ContextSegment', segmentId);
    if (!segment) throw new Error(`Context source occurrence points to missing segment ${segmentId}.`);
    return segment;
  }

  private async getHead(conversationId: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: conversationId },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0] ?? null;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  private replayAppend(root: DomainRow, segmentId: string, nodeId: string, rootId: string): ContextAppendResult {
    return {
      segmentId,
      nodeId,
      rootId,
      rootSeq: requireBigInt(root.root_seq, 'ContextSequenceRoot.root_seq').toString(),
      deduplicated: true
    };
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

export interface StructuralContextRecord {
  node: DomainRow;
  segment: DomainRow;
  contentObject: DomainRow;
}

export interface MaterializedContextStructure {
  root: DomainRow;
  records: StructuralContextRecord[];
  snapshotCommitSeq: string;
}

interface EditableContextSegment {
  segment: DomainRow;
  contentObject: DomainRow;
}

interface ExpandedCompressionContext {
  segments: EditableContextSegment[];
  blocks: DomainRow[];
}

interface CompressionExpansion extends ExpandedCompressionContext {
  containsTarget: boolean;
}

interface PlannedNode {
  id: string;
  parentNodeId: string | null;
  segmentId: string;
  now: string;
}

function messageOccurrenceWithAllocatedRevisionSteps(input: {
  segmentId: string;
  revisionId: string;
  contentObjectId: string;
  now: string;
}): RepositoryTransactionStep[] {
  return [savepoint('edited_message_context_occurrence', [
    DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
      id: input.segmentId,
      content_object_id: input.contentObjectId,
      segment_kind: 'message',
      created_at: input.now
    }),
    DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insertMessageContextSourceForRevision({
      id: stableId('context_segment_source', 'message_revision', input.revisionId),
      segment_id: input.segmentId,
      source_kind: 'message_revision',
      source_id: input.revisionId,
      created_at: input.now
    }, input.revisionId)
  ], {
    kind: 'rollback-and-continue-on-unique',
    constraints: EXPECTED_OCCURRENCE_CONSTRAINTS
  })];
}

function nodeInsertSteps(nodes: readonly PlannedNode[], savepointName: string): RepositoryTransactionStep[] {
  return nodes.flatMap((node, index) => [
    savepoint(`${savepointName}_${index}`, [
      DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: node.id,
        parent_node_id: node.parentNodeId,
        segment_id: node.segmentId,
        created_at: node.now
      })
    ], {
      kind: 'rollback-and-continue-on-unique',
      constraints: EXPECTED_NODE_CONSTRAINTS
    }),
    DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(node.id, {
      parent_node_id: node.parentNodeId,
      segment_id: node.segmentId
    })
  ]);
}

function buildSequenceNodes(segmentIds: readonly string[], now: string): PlannedNode[] {
  const nodes: PlannedNode[] = [];
  let parentNodeId: string | null = null;
  for (const segmentId of segmentIds) {
    const id = contextSequenceNodeId(parentNodeId, segmentId);
    nodes.push({ id, parentNodeId, segmentId, now });
    parentNodeId = id;
  }
  return nodes;
}

function uniqueRows(rowsInput: readonly DomainRow[]): DomainRow[] {
  const rowsById = new Map<string, DomainRow>();
  for (const row of rowsInput) rowsById.set(requireId(row.id, 'row.id'), row);
  return [...rowsById.values()];
}

function compareCompressionSourcePosition(left: DomainRow, right: DomainRow): number {
  const leftPosition = requireBigInt(left.position, 'CompressionBlockSource.position');
  const rightPosition = requireBigInt(right.position, 'CompressionBlockSource.position');
  return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : 0;
}

function rebuildSuffix(
  recordsInput: readonly StructuralContextRecord[],
  targetIndex: number,
  options: { replacementSegmentId: string | null; now: string }
): { nodes: PlannedNode[]; lastNodeId: string | null } {
  const records = [...recordsInput];
  if (targetIndex < 0 || targetIndex >= records.length) throw new RangeError('Context replacement target is outside the root.');
  const compression = records[0]?.segment.segment_kind === 'compression';
  if (compression && targetIndex === 0) throw new Error('A compression summary cannot be edited as a Message occurrence.');
  let parentNodeId: string | null;
  if (compression && targetIndex === 1) {
    parentNodeId = nullableId(records[targetIndex].node.parent_node_id, 'ContextSequenceNode.parent_node_id');
  } else if (targetIndex > 0) {
    parentNodeId = requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id');
  } else {
    parentNodeId = null;
  }
  const segmentIds = [
    ...(options.replacementSegmentId ? [options.replacementSegmentId] : []),
    ...records.slice(targetIndex + 1).map((record) => requireId(record.segment.id, 'ContextSegment.id'))
  ];
  const nodes: PlannedNode[] = [];
  for (const segmentId of segmentIds) {
    const id = contextSequenceNodeId(parentNodeId, segmentId);
    nodes.push({ id, parentNodeId, segmentId, now: options.now });
    parentNodeId = id;
  }
  if (nodes.length > 0) return { nodes, lastNodeId: nodes[nodes.length - 1].id };
  if (compression) {
    return {
      nodes,
      lastNodeId: targetIndex > 1
        ? requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id')
        : null
    };
  }
  return {
    nodes,
    lastNodeId: targetIndex > 0
      ? requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id')
      : null
  };
}

function occurrenceInsertSteps(
  input: {
    segmentId: string;
    segmentKind: ContextSegmentKind;
    contentObjectId: string;
    sources: readonly ContextSourceOccurrence[];
    now: string;
  }
): RepositoryTransactionStep[] {
  return [
    DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
      id: input.segmentId,
      content_object_id: input.contentObjectId,
      segment_kind: input.segmentKind,
      created_at: input.now
    }),
    ...input.sources.map((source) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
      id: stableSourceRowId(source),
      segment_id: input.segmentId,
      source_kind: source.sourceKind,
      source_id: source.sourceId,
      source_revision: source.sourceRevision,
      created_at: input.now
    }))
  ];
}

function headAssertionSteps(
  conversationId: string,
  head: DomainRow | null,
  expectedRootId: string | null
): RepositoryTransactionStep[] {
  if (expectedRootId === null) {
    return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assertNone({ conversation_id: conversationId })];
  }
  if (!head) throw staleHeadError(conversationId);
  return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(
    requireId(head.id, 'ConversationContextHeadLink.id'),
    { conversation_id: conversationId, root_id: expectedRootId }
  )];
}

function headMutationSteps(
  conversationId: string,
  head: DomainRow | null,
  rootId: string,
  now: string
): RepositoryTransactionStep[] {
  if (head) {
    return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update(
      requireId(head.id, 'ConversationContextHeadLink.id'),
      { root_id: rootId, updated_at: now }
    )];
  }
  return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
    id: stableId('conversation_context_head', conversationId),
    conversation_id: conversationId,
    root_id: rootId,
    updated_at: now
  })];
}

function validateSegmentSources(kind: ContextSegmentKind, sources: readonly ContextSourceOccurrence[]): void {
  if (kind === 'tool_pair') {
    if (sources.length !== 2 || sources[0].sourceKind !== 'tool_call' || sources[1].sourceKind !== 'tool_model_result') {
      throw new Error('tool_pair requires tool_call and tool_model_result source rows.');
    }
    if (sources[0].sourceRevision !== sources[1].sourceRevision) {
      throw new Error('tool_pair source rows must share call_seq source_revision.');
    }
    return;
  }
  if (sources.length !== 1) throw new Error(`${kind} segment requires exactly one source occurrence.`);
  const expected: Partial<Record<ContextSegmentKind, ContextSourceKind>> = {
    message: 'message_revision',
    compression: 'compression_block',
    system: 'system',
    runtime_context: 'runtime_context'
  };
  if (expected[kind] && sources[0].sourceKind !== expected[kind]) {
    throw new Error(`${kind} segment requires ${expected[kind]} source kind.`);
  }
  if (
    (sources[0].sourceKind === 'compression_block'
      || sources[0].sourceKind === 'system'
      || sources[0].sourceKind === 'runtime_context')
    && sources[0].sourceRevision !== 0n
  ) {
    throw new Error(`${sources[0].sourceKind} source_revision must be 0.`);
  }
}

function normalizeSources(sources: readonly ContextSourceOccurrence[]): ContextSourceOccurrence[] {
  if (!Array.isArray(sources) || sources.length === 0) throw new TypeError('Context sources must not be empty.');
  return sources.map(normalizeSource);
}

function normalizeSource(source: ContextSourceOccurrence): ContextSourceOccurrence {
  const sourceKind = requireSourceKind(source?.sourceKind);
  const sourceId = requireId(source?.sourceId, 'Context sourceId');
  const sourceRevision = typeof source?.sourceRevision === 'bigint'
    ? source.sourceRevision
    : decimalBigInt(source?.sourceRevision, 'Context sourceRevision');
  if (sourceRevision < 0n) throw new TypeError('Context sourceRevision must be non-negative.');
  return { sourceKind, sourceId, sourceRevision };
}

function stableSegmentId(sources: readonly ContextSourceOccurrence[]): string {
  return stableId(
    'context_segment',
    ...sources.flatMap((source) => source.sourceKind === 'message_revision'
      ? [source.sourceKind, source.sourceId]
      : [source.sourceKind, source.sourceId, source.sourceRevision.toString()])
  );
}

function stableSourceRowId(source: ContextSourceOccurrence): string {
  return source.sourceKind === 'message_revision'
    ? stableId('context_segment_source', source.sourceKind, source.sourceId)
    : stableId('context_segment_source', source.sourceKind, source.sourceId, source.sourceRevision.toString());
}

export function contextSequenceNodeId(parentNodeId: string | null, segmentId: string): string {
  return stableId('context_node', parentNodeId ?? '<null>', requireId(segmentId, 'ContextSegment.id'));
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-context\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

function assertExistingSegment(
  segment: DomainRow,
  expectedId: string,
  expectedKind: ContextSegmentKind,
  expectedContentObjectId: string
): void {
  if (
    segment.id !== expectedId
    || segment.segment_kind !== expectedKind
    || segment.content_object_id !== expectedContentObjectId
  ) throw new Error('Stable Context source occurrence conflicts with immutable segment content.');
}

function isRecoverableAppendRace(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function sourceParentConflictError(
  sources: readonly ContextSourceOccurrence[],
  baseRootId: string | null
): Error & { code: string } {
  const identity = sources.map((source) =>
    `${source.sourceKind}:${source.sourceId}:${source.sourceRevision.toString()}`
  ).join(',');
  const error = new Error(
    `Context source occurrence ${identity} is already attached to another sequence position; base=${baseRootId ?? '<empty>'}.`
  ) as Error & { code: string };
  error.code = 'CONTEXT_SOURCE_PARENT_CONFLICT';
  return error;
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

function estimateTokens(byteLength: bigint): bigint {
  return (byteLength + 3n) / 4n;
}

function staleHeadError(conversationId: string): Error & { code: string } {
  const error = new Error(`Conversation ${conversationId} Context head changed before commit.`) as Error & { code: string };
  error.code = 'CONTEXT_HEAD_STALE';
  return error;
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireSegmentKind(value: unknown): ContextSegmentKind {
  if (!['system', 'message', 'tool_pair', 'compression', 'runtime_context'].includes(String(value))) {
    throw new TypeError(`Unsupported Context segment kind: ${String(value)}`);
  }
  return value as ContextSegmentKind;
}

function requireSourceKind(value: unknown): ContextSourceKind {
  if (!['message_revision', 'tool_call', 'tool_model_result', 'compression_block', 'system', 'runtime_context'].includes(String(value))) {
    throw new TypeError(`Unsupported Context source kind: ${String(value)}`);
  }
  return value as ContextSourceKind;
}

function bufferView(content: Uint8Array): Buffer {
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireText(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireId(value, label);
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
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string or bigint.`);
  }
  return BigInt(value);
}

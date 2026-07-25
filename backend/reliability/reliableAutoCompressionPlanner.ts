import {
  TERMINAL_TOOL_CALL_STATUSES,
  isFunctionCallPart,
  type CompressionBlockRecord,
  type CompressionBlockSourceLinkRecord,
  type LlmInvocationSettingsSnapshotRecord,
  type MessageRecord
} from '../../shared/protocol';
import type {
  AttemptId,
  ConversationId,
  EffectIntentId,
  InvocationId,
  MessageId,
  OperationId,
  RequestId,
  RunId
} from '../../shared/stableIds';
import { projectModelContext } from '../modelContext/modelContextProjector';
import { buildCompressionModelContextProjectionCommitData } from '../modelContext/projectionRecords';
import { modelContextFactsFromDurable } from './modelContextDurableFacts';
import type { ReliableCompressionBarrierPlan } from './domain/preflightTypes';
import type { DurableConversationFacts, DurableInvocationRecord } from './domain/types';
import { stableIdFromSeed } from './stableIdFactory';
import { observedUsageTokenCount, resolveCompressionThreshold } from '../world/modules/llm/usage';

export interface ReliableAutoCompressionAnchor {
  conversationId: ConversationId;
  invocationId: InvocationId;
  requestId: RequestId;
  runId: RunId;
  modelMessageId: MessageId;
  seed: string;
}

export interface ReliableAutoCompressionIdentity {
  operationId: OperationId;
  attemptId: AttemptId;
  effectIntentId: EffectIntentId;
}

export type ReliableAutoCompressionProjectionSkipReason =
  | 'compression_in_progress'
  | 'compression_method_not_automatic'
  | 'compression_config_snapshot_missing'
  | 'compression_config_snapshot_mismatch'
  | 'compression_projection_error'
  | 'compression_selection_empty'
  | 'compression_anchor_already_exists';

export type ReliableAutoCompressionProjectionDecision =
  | { kind: 'ready'; plan: ReliableCompressionBarrierPlan }
  | { kind: 'skip'; reason: ReliableAutoCompressionProjectionSkipReason };

export type ReliablePostResponseAutoCompressionSkipReason =
  | 'conversation_unavailable'
  | 'completed_invocation_missing'
  | 'request_missing'
  | 'model_message_missing'
  | 'model_message_not_final'
  | 'settings_snapshot_missing'
  | 'compression_disabled'
  | 'compression_trigger_disabled'
  | 'usage_metadata_missing'
  | 'below_threshold'
  | 'anchor_already_processed'
  | 'trigger_missing'
  | 'threshold_unit_missing'
  | 'threshold_tokens_missing'
  | 'threshold_percent_missing'
  | 'context_window_missing'
  | ReliableAutoCompressionProjectionSkipReason;

interface PostResponseDecisionBase {
  anchor?: ReliableAutoCompressionAnchor;
  observedTokenCount?: number;
  thresholdTokenCount?: number;
}

export type ReliablePostResponseAutoCompressionDecision =
  | (PostResponseDecisionBase & {
      kind: 'ready';
      anchor: ReliableAutoCompressionAnchor;
      identity: ReliableAutoCompressionIdentity;
      observedTokenCount: number;
      thresholdTokenCount: number;
      plan: ReliableCompressionBarrierPlan;
    })
  | (PostResponseDecisionBase & {
      kind: 'deferred';
      reason: 'tool_calls_unfinished';
      anchor: ReliableAutoCompressionAnchor;
      toolCallIds: string[];
    })
  | (PostResponseDecisionBase & {
      kind: 'skip';
      reason: ReliablePostResponseAutoCompressionSkipReason;
    });

export type ReliablePostResponseAutoCompressionInspection =
  | Extract<ReliablePostResponseAutoCompressionDecision, { kind: 'skip' | 'deferred' }>
  | {
      kind: 'candidate';
      anchor: ReliableAutoCompressionAnchor;
      identity: ReliableAutoCompressionIdentity;
      settings: LlmInvocationSettingsSnapshotRecord;
      observedTokenCount: number;
      thresholdTokenCount: number;
    };

export interface ReliableAutoCompressionProjectionInput {
  settings: LlmInvocationSettingsSnapshotRecord;
  sourceTurn: {
    conversationId: ConversationId;
    runId: RunId;
    invocationId: InvocationId;
    requestId: RequestId;
    modelMessageId: MessageId;
  };
  /** false for preflight's pending model Message; true for a completed post-response anchor. */
  includeSourceTurnMessage: boolean;
  seed: string;
  now: number;
  observedTokenCount?: number;
}

/**
 * Shared pure projection/selection planner for preflight and post-response automatic compression.
 * Threshold admission intentionally stays outside this function so preflight can retain its emergency
 * context-window gate while post-response can use provider-observed usage exclusively.
 */
export function planReliableAutoCompressionProjection(
  facts: DurableConversationFacts,
  input: ReliableAutoCompressionProjectionInput
): ReliableAutoCompressionProjectionDecision {
  if (hasActiveCompression(facts)) return { kind: 'skip', reason: 'compression_in_progress' };

  const methodKind = input.settings.compressionMethodKind;
  if (!methodKind || methodKind === 'disabled' || methodKind === 'manual_summary') {
    return { kind: 'skip', reason: 'compression_method_not_automatic' };
  }
  const methodConfigSnapshot = input.settings.compressionConfigSnapshot;
  if (!methodConfigSnapshot) return { kind: 'skip', reason: 'compression_config_snapshot_missing' };
  if (methodConfigSnapshot.kind !== methodKind) return { kind: 'skip', reason: 'compression_config_snapshot_mismatch' };

  const projection = projectModelContext({
    facts: modelContextFactsFromDurable([facts]),
    purpose: {
      kind: 'compression',
      mode: 'auto',
      conversationId: facts.conversation.id,
      sourceTurn: input.sourceTurn,
      includeSourceTurnMessage: input.includeSourceTurnMessage,
      ...(input.includeSourceTurnMessage ? { endMessageId: input.sourceTurn.modelMessageId } : {}),
      preserveLatestMessages: nonNegativeInteger(input.settings.compressionTrigger?.preserveLatestMessages) ?? 8,
      methodKind
    }
  });
  if (projection.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    return { kind: 'skip', reason: 'compression_projection_error' };
  }
  const compression = projection.compression;
  if (!compression?.anchorMessageId
    || compression.anchorSeq === undefined
    || compression.selectedMessageIds.length === 0
    || projection.contents.length === 0) {
    return { kind: 'skip', reason: 'compression_selection_empty' };
  }

  const selected = compression.selectedMessageIds
    .map((messageId) => facts.messages.find((message) => message.id === messageId))
    .filter((message): message is MessageRecord => !!message)
    .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  if (selected.length === 0) return { kind: 'skip', reason: 'compression_selection_empty' };
  const predecessor = compression.priorBlockId
    ? facts.compressionBlocks.find((block) => block.id === compression.priorBlockId)
    : undefined;
  const anchor = selected[selected.length - 1]!;
  if (facts.compressionBlocks.some((block) => block.anchorMessageId === anchor.id)) {
    return { kind: 'skip', reason: 'compression_anchor_already_exists' };
  }

  const blockId = stableIdFromSeed('compression', `${input.seed}:block:${anchor.id}`);
  if (facts.compressionBlocks.some((block) => block.id === blockId)) {
    return { kind: 'skip', reason: 'compression_anchor_already_exists' };
  }
  const compactRequestId = stableIdFromSeed('request', `${input.seed}:request:${anchor.id}`);
  const compactInvocationId = stableIdFromSeed('invocation', `${input.seed}:invocation:${anchor.id}`);
  const now = Math.max(1, Math.floor(input.now));
  const settingsSnapshot = clone(input.settings);
  const configSnapshot = clone(methodConfigSnapshot);
  const block: CompressionBlockRecord = {
    id: blockId,
    conversationId: facts.conversation.id,
    title: '自动上下文压缩',
    status: 'running',
    trigger: 'auto',
    methodKind,
    ...(input.settings.compressionConfigId ? { methodConfigId: input.settings.compressionConfigId } : {}),
    anchorMessageId: anchor.id,
    anchorSeq: anchor.seq,
    startSeq: predecessor?.startSeq ?? selected[0]!.seq,
    endSeq: anchor.seq,
    sourceMessageCount: (predecessor?.sourceMessageCount ?? 0) + selected.length,
    tokenCountBefore: input.observedTokenCount ?? projection.tokenCount,
    sourceHash: projection.fingerprint,
    providerSettingsSnapshot: settingsSnapshot,
    compressionConfigSnapshot: configSnapshot,
    createdAt: now,
    updatedAt: now
  };
  const sourceLinks: CompressionBlockSourceLinkRecord[] = [];
  if (predecessor) {
    sourceLinks.push({
      id: stableIdFromSeed('relation', `${input.seed}:retained:${predecessor.id}`),
      blockId,
      sourceKind: 'compressionBlock',
      sourceId: predecessor.id,
      role: 'retained',
      order: 0,
      createdAt: now,
      updatedAt: now
    });
  }
  projection.messageSelections.forEach((selection, index) => {
    sourceLinks.push({
      id: stableIdFromSeed('relation', `${input.seed}:source:${selection.messageId}`),
      blockId,
      sourceKind: 'message',
      sourceId: selection.messageId,
      revisionId: selection.revisionId,
      role: selection.messageId === anchor.id ? 'anchor' : 'source',
      order: index + (predecessor ? 1 : 0),
      createdAt: now,
      updatedAt: now
    });
  });

  return {
    kind: 'ready',
    plan: {
      block,
      sourceLinks,
      variantId: stableIdFromSeed('relation', `${input.seed}:variant:${blockId}`),
      compactRequest: {
        id: compactRequestId,
        blockId,
        conversationId: facts.conversation.id,
        invocationId: compactInvocationId,
        ...(input.settings.compressionConfigId ? { methodConfigId: input.settings.compressionConfigId } : {}),
        methodKind,
        methodConfigSnapshot: configSnapshot,
        settingsSnapshot,
        contents: clone(projection.contents),
        ...(methodKind === 'segmented_summary' ? {
          segments: clone(compression.segments),
          ...(compression.priorSummaryContents ? { priorSummaryContents: clone(compression.priorSummaryContents) } : {})
        } : {}),
        sourceHash: projection.fingerprint
      },
      contextProjection: buildCompressionModelContextProjectionCommitData(projection, blockId, facts.conversation.id)
    }
  };
}

/**
 * Cheap level-trigger inspection over an already committed in-memory projection. It deliberately
 * stops before ModelContext projection so the dispatcher can reject the common ineligible case
 * without acquiring the same committed-view lease a second time.
 */
export function inspectReliablePostResponseAutoCompression(
  facts: DurableConversationFacts
): ReliablePostResponseAutoCompressionInspection {
  if (facts.conversation.visibility === 'hidden') return { kind: 'skip', reason: 'conversation_unavailable' };
  const invocation = latestCompletedInvocation(facts.invocations);
  if (!invocation) return { kind: 'skip', reason: 'completed_invocation_missing' };
  const request = facts.requests.find((candidate) => candidate.id === invocation.requestId && candidate.invocationId === invocation.id);
  if (!request?.modelMessageId) return { kind: 'skip', reason: 'request_missing' };
  const message = facts.messages.find((candidate) => candidate.id === request.modelMessageId && candidate.conversationId === facts.conversation.id);
  if (!message) return { kind: 'skip', reason: 'model_message_missing' };

  const anchor = reliableAutoCompressionAnchor(facts.conversation.id, invocation, request.id as RequestId, message.id as MessageId);
  if (message.status !== 'final') return { kind: 'skip', reason: 'model_message_not_final', anchor };
  if (!invocation.settings) return { kind: 'skip', reason: 'settings_snapshot_missing', anchor };
  const settings = invocation.settings;
  if (!settings.compressionMethodKind || settings.compressionMethodKind === 'disabled') {
    return { kind: 'skip', reason: 'compression_disabled', anchor };
  }
  if (settings.compressionMethodKind === 'manual_summary' || settings.compressionTrigger?.mode !== 'token_threshold') {
    return { kind: 'skip', reason: 'compression_trigger_disabled', anchor };
  }

  const threshold = resolveCompressionThreshold(settings);
  if (threshold.kind === 'unavailable') return { kind: 'skip', reason: threshold.reason, anchor };
  const observedTokenCount = invocation.usageMetadata ? observedUsageTokenCount(invocation.usageMetadata) : undefined;
  if (observedTokenCount === undefined) {
    return { kind: 'skip', reason: 'usage_metadata_missing', anchor, thresholdTokenCount: threshold.thresholdTokens };
  }
  if (observedTokenCount < threshold.thresholdTokens) {
    return {
      kind: 'skip',
      reason: 'below_threshold',
      anchor,
      observedTokenCount,
      thresholdTokenCount: threshold.thresholdTokens
    };
  }

  const identity = reliableAutoCompressionIdentity(anchor.seed);
  if (facts.operations.some((operation) => operation.id === identity.operationId)) {
    return {
      kind: 'skip',
      reason: 'anchor_already_processed',
      anchor,
      observedTokenCount,
      thresholdTokenCount: threshold.thresholdTokens
    };
  }

  const messageToolCalls = facts.toolCalls.filter((tool) => tool.messageId === message.id);
  const functionCallCount = message.content.parts.filter(isFunctionCallPart).length;
  const unfinishedToolCalls = messageToolCalls.filter((tool) => !TERMINAL_TOOL_CALL_STATUSES.has(tool.status));
  const runTerminated = facts.runTerminations.some((termination) => termination.runId === invocation.runId);
  if (!runTerminated && (unfinishedToolCalls.length > 0 || messageToolCalls.length < functionCallCount)) {
    return {
      kind: 'deferred',
      reason: 'tool_calls_unfinished',
      anchor,
      observedTokenCount,
      thresholdTokenCount: threshold.thresholdTokens,
      toolCallIds: unfinishedToolCalls.map((tool) => tool.id).sort()
    };
  }

  return {
    kind: 'candidate',
    anchor,
    identity,
    settings,
    observedTokenCount,
    thresholdTokenCount: threshold.thresholdTokens
  };
}

/** Level-triggered post-response decision over a complete committed conversation view. */
export function planReliablePostResponseAutoCompression(
  facts: DurableConversationFacts,
  now: number
): ReliablePostResponseAutoCompressionDecision {
  const inspection = inspectReliablePostResponseAutoCompression(facts);
  if (inspection.kind !== 'candidate') return inspection;
  const { anchor, identity, settings, observedTokenCount, thresholdTokenCount } = inspection;
  const projection = planReliableAutoCompressionProjection(facts, {
    settings,
    sourceTurn: {
      conversationId: facts.conversation.id,
      runId: anchor.runId,
      invocationId: anchor.invocationId,
      requestId: anchor.requestId,
      modelMessageId: anchor.modelMessageId
    },
    includeSourceTurnMessage: true,
    seed: anchor.seed,
    now,
    observedTokenCount
  });
  if (projection.kind === 'skip') {
    return {
      kind: 'skip',
      reason: projection.reason,
      anchor,
      observedTokenCount,
      thresholdTokenCount
    };
  }
  return {
    kind: 'ready',
    anchor,
    identity,
    observedTokenCount,
    thresholdTokenCount,
    plan: projection.plan
  };
}

export function reliableAutoCompressionAnchorSeed(
  conversationId: ConversationId,
  invocationId: InvocationId,
  modelMessageId: MessageId
): string {
  return `auto-compression:${conversationId}:${invocationId}:${modelMessageId}`;
}

export function reliableAutoCompressionIdentity(seed: string): ReliableAutoCompressionIdentity {
  return {
    operationId: stableIdFromSeed('operation', `${seed}:operation`),
    attemptId: stableIdFromSeed('attempt', `${seed}:attempt`),
    effectIntentId: stableIdFromSeed('effectIntent', `${seed}:effect`)
  };
}

function reliableAutoCompressionAnchor(
  conversationId: ConversationId,
  invocation: DurableInvocationRecord,
  requestId: RequestId,
  modelMessageId: MessageId
): ReliableAutoCompressionAnchor {
  return {
    conversationId,
    invocationId: invocation.id,
    requestId,
    runId: invocation.runId,
    modelMessageId,
    seed: reliableAutoCompressionAnchorSeed(conversationId, invocation.id, modelMessageId)
  };
}

function latestCompletedInvocation(invocations: readonly DurableInvocationRecord[]): DurableInvocationRecord | undefined {
  return invocations
    .filter((invocation) => invocation.status === 'complete')
    .sort((left, right) =>
      (right.completedAt ?? right.createdAt) - (left.completedAt ?? left.createdAt)
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id))[0];
}

function hasActiveCompression(facts: DurableConversationFacts): boolean {
  return facts.compressionBlocks.some((block) => block.status === 'pending' || block.status === 'running')
    || facts.operations.some((operation) => operation.kind.startsWith('compression.')
      && (operation.state === 'pending' || operation.state === 'running'));
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

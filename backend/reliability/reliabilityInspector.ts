import type { RunProgressSourceKind } from '../../shared/runLifecycle';
import type { ConversationId } from '../../shared/stableIds';
import type { MapWorld } from '../ecs/World';
import { fullView } from './domain/internalHandlers';
import type { DurableConversationFacts } from './domain/types';
import type {
  FileTransactionStorageInspection,
  ReliabilityDiagnostic,
  ReliabilityDiagnosticSink
} from './fileTransactionTypes';
import type { FileConversationTransactionBackend } from './fileConversationTransactionBackend';
import { collectRunProgressSnapshots } from './runInvariantValidator';
import { TERMINAL_TOOL_CALL_STATUSES, isFunctionResponsePart } from '../../shared/protocol';
import { normalizeToolTurnSequence } from '../modelContext/toolTurnNormalizer';

export class ReliabilityDiagnosticJournal implements ReliabilityDiagnosticSink {
  private readonly events: ReliabilityDiagnostic[] = [];

  public constructor(
    private readonly capacity = 256,
    private readonly forward?: (event: ReliabilityDiagnostic) => void
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Reliability diagnostic journal capacity must be a positive integer.');
  }

  public record(event: ReliabilityDiagnostic): void {
    const retained = { ...event };
    this.events.push(retained);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    this.forward?.(retained);
  }

  public recent(conversationId?: ConversationId): ReliabilityDiagnostic[] {
    return this.events
      .filter((event) => !conversationId || !event.conversationId || event.conversationId === conversationId)
      .map((event) => ({ ...event }));
  }
}

export interface ReliabilityRunInspection {
  id: string;
  conversationId: string;
  lifecycle: string;
  phase: string;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  retryOfRunId?: string;
}

export interface ReliabilityOperationInspection {
  id: string;
  conversationId: string;
  ownerKind: 'run' | 'conversation';
  ownerRunId?: string;
  kind: string;
  state: string;
  currentGeneration: number;
  rowVersion: number;
  timeoutPolicy: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resolutionId?: string;
}

export interface ReliabilityConversationIntegrityInspection {
  timeline: {
    createdAt: number;
    lastActivityAt: number;
    latestUserMessageAt?: number;
    latestMessageAt?: number;
    valid: boolean;
    coversLatestUserMessage: boolean;
    effectiveOrderingAt: number;
  };
  toolPairing: {
    totalToolCalls: number;
    terminalToolCalls: number;
    referencedToolCallIds: string[];
    unreferencedToolCallIds: string[];
    diagnostics: ReturnType<typeof normalizeToolTurnSequence>['diagnostics'];
  };
}

export interface ReliabilityConversationInspection {
  conversationId: ConversationId;
  integrity: ReliabilityConversationIntegrityInspection;
  turns: ReliabilityRunInspection[];
  runTerminations: DurableConversationFacts['runTerminations'];
  executionLeases: DurableConversationFacts['executionLeases'];
  progress: ReturnType<typeof collectRunProgressSnapshots>;
  operations: ReliabilityOperationInspection[];
  attempts: DurableConversationFacts['attempts'];
  primaryEffects: Array<{
    effectIntentId: string;
    ownerKind: 'run' | 'conversation';
    ownerRunId?: string;
    operationId: string;
    attemptId: string;
    generation: number;
    kind: string;
    recoveryPolicy: string;
    deadlineAt: number;
  }>;
  outcomeUnknown: {
    operationIds: string[];
    pauses: Array<{
      id: string;
      runId: string;
      operationId: string;
      allowedResolutions: string[];
      createdAt: number;
    }>;
    resolutions: Array<{
      id: string;
      operationId: string;
      kind: string;
      createdAt: number;
    }>;
  };
  answerBridges: Array<{
    id: string;
    sourceConversationId: string;
    targetConversationId: string;
    ownerRunId: string;
    ownerGeneration: number;
    currentSubmissionId?: string;
    lifecycle: string;
    rowVersion: number;
  }>;
}

export interface ReliabilityCommandTerminalInspection {
  pending: Array<{
    commandId?: string;
    transitionId: string;
    sourceKey: string;
    ageMs: number;
  }>;
  terminalReceipts: Array<{
    commandId: string;
    transitionId: string;
    finalStatus: string;
    createdAt: number;
  }>;
  anomalies: Array<{
    sourceKey: string;
    transitionId: string;
    reason: 'claim_without_wal_or_receipt' | 'committed_wal_without_receipt';
  }>;
}

export interface ReliabilityInspectionSnapshot {
  capturedAt: number;
  storage: FileTransactionStorageInspection;
  commandTerminal: ReliabilityCommandTerminalInspection;
  conversation?: ReliabilityConversationInspection;
  loadedStableEntityIndex: {
    total: number;
    entries: ReturnType<MapWorld['loadedRecordIdEntries']>;
  };
  recentDiagnostics: ReliabilityDiagnostic[];
}

export interface ReliabilityInspectorOptions {
  backend: FileConversationTransactionBackend;
  world: MapWorld;
  diagnostics: ReliabilityDiagnosticJournal;
}

/** Read-only, payload-free development view over committed reliability state and its loaded projection. */
export class ReliabilityInspector {
  public constructor(private readonly options: ReliabilityInspectorOptions) {}

  public async snapshot(conversationId?: ConversationId): Promise<ReliabilityInspectionSnapshot> {
    const capturedAt = Date.now();
    const [storage, conversation] = await Promise.all([
      this.options.backend.inspectStorage(),
      conversationId ? this.inspectConversation(conversationId) : Promise.resolve(undefined)
    ]);
    const entries = this.options.world.loadedRecordIdEntries();
    const scopedStorage = conversationId ? filterStorageInspection(storage, conversationId) : storage;
    return {
      capturedAt,
      storage: scopedStorage,
      commandTerminal: inspectCommandTerminal(scopedStorage, capturedAt),
      ...(conversation ? { conversation } : {}),
      loadedStableEntityIndex: { total: entries.length, entries },
      recentDiagnostics: this.options.diagnostics.recent(conversationId)
    };
  }

  private async inspectConversation(conversationId: ConversationId): Promise<ReliabilityConversationInspection> {
    const view = await this.options.backend.readCommittedView(fullView('reliability.inspect', conversationId));
    const facts = view.facts;
    const additionalProgress = new Map(facts.turns.map((run) => [run.id, {
      ...(run.phase === 'llm_streaming' ? { stream_state: 1 } : {})
    } satisfies Partial<Record<RunProgressSourceKind, number>>]));
    const progress = collectRunProgressSnapshots({
      turns: facts.turns,
      leases: facts.executionLeases,
      operations: facts.operations,
      attempts: facts.attempts,
      interactions: facts.interactionRequests,
      interactionOwners: facts.interactionOwnerLinks,
      childTurnLinks: facts.childTurnLinks,
      pauses: facts.pauses,
      additionalProgress
    });
    return {
      conversationId,
      integrity: inspectConversationIntegrity(facts),
      turns: facts.turns.map((run) => ({ ...run })).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      runTerminations: facts.runTerminations.map((termination) => ({ ...termination })).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      executionLeases: facts.executionLeases.map((lease) => ({ ...lease })).sort((left, right) => left.id.localeCompare(right.id)),
      progress,
      operations: facts.operations.map((operation) => ({
        id: operation.id,
        conversationId: operation.conversationId,
        ownerKind: operation.ownerKind === 'conversation' ? 'conversation' as const : 'run' as const,
        ...(operation.ownerRunId ? { ownerRunId: operation.ownerRunId } : {}),
        kind: operation.kind,
        state: operation.state,
        currentGeneration: operation.currentGeneration,
        rowVersion: operation.rowVersion,
        timeoutPolicy: operation.timeoutPolicy,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        ...(operation.completedAt !== undefined ? { completedAt: operation.completedAt } : {}),
        ...(operation.resolutionId ? { resolutionId: operation.resolutionId } : {})
      })).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
      attempts: facts.attempts.map((attempt) => ({ ...attempt })).sort((left, right) => left.generation - right.generation || left.id.localeCompare(right.id)),
      primaryEffects: facts.primaryEffects.map((effect) => ({
        effectIntentId: effect.effectIntentId,
        ownerKind: effect.ownerKind === 'conversation' ? 'conversation' as const : 'run' as const,
        ...(effect.ownerRunId ? { ownerRunId: effect.ownerRunId } : {}),
        operationId: effect.operationId,
        attemptId: effect.attemptId,
        generation: effect.generation,
        kind: effect.kind,
        recoveryPolicy: effect.recoveryPolicy,
        deadlineAt: effect.deadlineAt
      })).sort((left, right) => left.deadlineAt - right.deadlineAt || left.effectIntentId.localeCompare(right.effectIntentId)),
      outcomeUnknown: {
        operationIds: facts.operations.filter((operation) => operation.state === 'outcome_unknown').map((operation) => operation.id).sort(),
        pauses: facts.pauses.filter((pause) => pause.reason === 'outcome_unknown').map((pause) => ({
          id: pause.id,
          runId: pause.runId,
          operationId: pause.operationId,
          allowedResolutions: [...pause.allowedResolutions],
          createdAt: pause.createdAt
        })).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
        resolutions: facts.operationResolutions.map((resolution) => ({
          id: resolution.id,
          operationId: resolution.operationId,
          kind: resolution.kind,
          createdAt: resolution.createdAt
        })).sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      },
      answerBridges: facts.answerBridges.map((bridge) => ({ ...bridge })).sort((left, right) => left.id.localeCompare(right.id))
    };
  }
}

export function inspectConversationIntegrity(facts: DurableConversationFacts): ReliabilityConversationIntegrityInspection {
  const messages = [...facts.messages].sort((left, right) => left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  const latestUserMessageAt = maxDefined(messages
    .filter((message) => message.role === 'user' && message.content.parts.some((part) => !isFunctionResponsePart(part)))
    .map((message) => message.createdAt));
  const latestMessageAt = maxDefined(messages.map((message) => message.createdAt));
  const timelineValid = Number.isFinite(facts.conversation.createdAt)
    && facts.conversation.createdAt >= 0
    && Number.isFinite(facts.conversation.lastActivityAt)
    && facts.conversation.lastActivityAt >= facts.conversation.createdAt;
  const runIdsByMessage = new Map<string, string[]>();
  for (const link of facts.messageTurnLinks) {
    const values = runIdsByMessage.get(link.messageId) ?? [];
    if (!values.includes(link.turnId)) values.push(link.turnId);
    runIdsByMessage.set(link.messageId, values);
  }
  const artifacts = new Map(facts.toolResultArtifacts.map((artifact) => [artifact.id, artifact]));
  const modelResponsesByToolCallId = new Map(facts.toolCallResultLinks.flatMap((link) => {
    if (link.role !== 'final') return [];
    const artifact = artifacts.get(link.artifactId);
    return artifact ? [[link.toolCallId, artifact.modelResponse] as const] : [];
  }));
  const normalized = normalizeToolTurnSequence({
    entries: messages.map((message) => ({ messageId: message.id, content: message.content })),
    toolCalls: facts.toolCalls,
    modelResponsesByToolCallId,
    runIdsByMessage,
    terminationsByRun: new Map(facts.runTerminations.map((termination) => [termination.runId, termination])),
    purpose: 'fresh'
  });
  const referenced = new Set(normalized.referencedToolCallIds);
  return {
    timeline: {
      createdAt: facts.conversation.createdAt,
      lastActivityAt: facts.conversation.lastActivityAt,
      ...(latestUserMessageAt !== undefined ? { latestUserMessageAt } : {}),
      ...(latestMessageAt !== undefined ? { latestMessageAt } : {}),
      valid: timelineValid,
      coversLatestUserMessage: latestUserMessageAt === undefined || facts.conversation.lastActivityAt >= latestUserMessageAt,
      effectiveOrderingAt: Math.max(facts.conversation.createdAt, facts.conversation.lastActivityAt, latestMessageAt ?? 0)
    },
    toolPairing: {
      totalToolCalls: facts.toolCalls.length,
      terminalToolCalls: facts.toolCalls.filter((tool) => TERMINAL_TOOL_CALL_STATUSES.has(tool.status)).length,
      referencedToolCallIds: [...referenced].sort(),
      unreferencedToolCallIds: facts.toolCalls.map((tool) => tool.id).filter((id) => !referenced.has(id)).sort(),
      diagnostics: normalized.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    }
  };
}

export function inspectCommandTerminal(
  storage: FileTransactionStorageInspection,
  capturedAt: number
): ReliabilityCommandTerminalInspection {
  const receiptsBySource = new Map(storage.receipts.map((receipt) => [receipt.sourceKey, receipt]));
  const pendingSources = new Set(storage.pendingWals.map((wal) => wal.sourceKey));
  const pending = storage.pendingWals
    .filter((wal) => wal.sourceKind === 'command')
    .map((wal) => ({
      ...(commandIdFromSourceKey(wal.sourceKey) ? { commandId: commandIdFromSourceKey(wal.sourceKey) } : {}),
      transitionId: wal.transitionId,
      sourceKey: wal.sourceKey,
      ageMs: Math.max(0, capturedAt - wal.createdAt)
    }))
    .sort((left, right) => right.ageMs - left.ageMs || left.transitionId.localeCompare(right.transitionId));
  const terminalReceipts = storage.receipts
    .filter((receipt): receipt is typeof receipt & { commandId: NonNullable<typeof receipt.commandId> } => receipt.sourceKind === 'command' && !!receipt.commandId)
    .map((receipt) => ({
      commandId: receipt.commandId,
      transitionId: receipt.transitionId,
      finalStatus: receipt.finalStatus,
      createdAt: receipt.createdAt
    }))
    .sort((left, right) => left.createdAt - right.createdAt || left.commandId.localeCompare(right.commandId));
  const anomalies: ReliabilityCommandTerminalInspection['anomalies'] = [];
  for (const claim of storage.sourceClaims) {
    if (!claim.sourceKey.startsWith('command:') || receiptsBySource.has(claim.sourceKey) || pendingSources.has(claim.sourceKey)) continue;
    anomalies.push({
      sourceKey: claim.sourceKey,
      transitionId: claim.transitionId,
      reason: 'claim_without_wal_or_receipt'
    });
  }
  for (const wal of storage.committedWals) {
    if (wal.sourceKind !== 'command' || receiptsBySource.has(wal.sourceKey)) continue;
    anomalies.push({
      sourceKey: wal.sourceKey,
      transitionId: wal.transitionId,
      reason: 'committed_wal_without_receipt'
    });
  }
  anomalies.sort((left, right) => left.sourceKey.localeCompare(right.sourceKey) || left.transitionId.localeCompare(right.transitionId));
  return { pending, terminalReceipts, anomalies };
}

function maxDefined(values: readonly number[]): number | undefined {
  return values.length > 0 ? Math.max(...values) : undefined;
}

function commandIdFromSourceKey(sourceKey: string): string | undefined {
  return sourceKey.startsWith('command:') && sourceKey.length > 'command:'.length
    ? sourceKey.slice('command:'.length)
    : undefined;
}

function filterStorageInspection(
  storage: FileTransactionStorageInspection,
  conversationId: ConversationId
): FileTransactionStorageInspection {
  const pendingWals = storage.pendingWals.filter((wal) => wal.scopes.includes(conversationId));
  const committedWals = storage.committedWals.filter((wal) => wal.scopes.includes(conversationId));
  const transitionIds = new Set([...pendingWals, ...committedWals].map((wal) => wal.transitionId));
  const receipts = storage.receipts.filter((receipt) =>
    transitionIds.has(receipt.transitionId)
    || receipt.nextVersions.some((version) => version.conversationId === conversationId));
  for (const receipt of receipts) transitionIds.add(receipt.transitionId);
  const heads = storage.heads.filter((head) => head.conversationId === conversationId || head.conversationId === undefined);
  return {
    ...storage,
    heads,
    pendingWals,
    committedWals,
    sourceClaims: storage.sourceClaims.filter((claim) => transitionIds.has(claim.transitionId)),
    receipts,
    stagingTransitionIds: storage.stagingTransitionIds.filter((transitionId) => transitionIds.has(transitionId)),
    currentHeadTransitionIds: [...new Set(heads.map((head) => head.latestTransitionId).filter((id): id is NonNullable<typeof id> => !!id))].sort(),
    receiptOnlyTransitionIds: storage.receiptOnlyTransitionIds.filter((transitionId) => transitionIds.has(transitionId)),
    blockedScopes: storage.blockedScopes.filter((blocked) => blocked.conversationId === conversationId),
    blockedHeadKeys: storage.blockedHeadKeys.filter((blocked) => blocked.headKey === `conversation:${conversationId}` || blocked.headKey.startsWith('resource:'))
  };
}

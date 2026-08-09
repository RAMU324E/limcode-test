import { createHash } from 'node:crypto';
import { estimateTokenCount } from 'tokenx';
import { submitPlanOutputFromResult } from '../../shared/planReview';
import {
  SUBMIT_PLAN_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  type TaskListItemStatus,
  type TaskListToolOperationRecord
} from '../../shared/protocol';
import {
  applyTaskListOperationToSnapshot,
  emptyTaskListSnapshot,
  requireTaskListOperation,
  type TaskListItemView,
  type TaskListSnapshotView
} from '../../shared/taskListProjection';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export const TURN_TASK_CARD_MAX_TOKENS = 2_000;

export interface CurrentTurnTaskOperationFact {
  toolCallId: string;
  callSeq: string;
  toolName: typeof TASK_LIST_TOOL_NAME | typeof SUBMIT_PLAN_TOOL_NAME;
  operation: TaskListToolOperationRecord;
  /** submit_plan is authoritative only when its durable result explicitly says approved. */
  planApproved?: boolean;
  sourceMessageId?: string;
}

export interface CurrentTurnTaskCounts {
  total: number;
  unfinished: number;
  pending: number;
  inProgress: number;
  blocked: number;
  completed: number;
  cancelled: number;
}

/** Small, structured-clone-safe ModelRequest recipe material. */
export interface FrozenTurnTaskCard {
  kind: 'turn_task_card';
  turnId: string;
  revision: string;
  baselineToolCallId: string;
  sourceToolCallId: string;
  sourceMessageId?: string;
  operationCount: number;
  counts: CurrentTurnTaskCounts;
  card: string;
  estimatedTokens: number;
  cardSha256: string;
  frozenAtCommitSeq?: string;
}

/** Read-side state projection; freezeCurrentTurnTaskCard removes the unbounded UI snapshot. */
export interface CurrentTurnTaskProjection extends FrozenTurnTaskCard {
  snapshot: TaskListSnapshotView;
}

interface TaskArtifactEnvelope {
  toolCallId: string;
  status: string;
  detail: unknown;
}

/**
 * Reduces already-settled facts for exactly one Turn. Updates before the latest eligible rewrite
 * are deliberately ignored; without such a rewrite there is no task projection.
 */
export function buildCurrentTurnTaskProjection(input: {
  turnId: string;
  operations: readonly CurrentTurnTaskOperationFact[];
  maxTokens?: number;
  frozenAtCommitSeq?: string;
}): CurrentTurnTaskProjection | undefined {
  const turnId = requiredText(input.turnId, 'turnId');
  const eligible = input.operations
    .filter((fact) => fact.toolName === TASK_LIST_TOOL_NAME || fact.planApproved === true)
    .map(cloneOperationFact)
    .sort(compareOperationFacts);
  let baselineIndex = -1;
  for (let index = 0; index < eligible.length; index += 1) {
    if (eligible[index].operation.mode === 'rewrite') baselineIndex = index;
  }
  if (baselineIndex < 0) return undefined;

  const applied = eligible.slice(baselineIndex).filter((fact, index) =>
    index === 0 || fact.operation.mode === 'update');
  let snapshot = emptyTaskListSnapshot();
  applied.forEach((fact, operationIndex) => {
    snapshot = applyTaskListOperationToSnapshot(snapshot, fact.operation, {
      operationIndex,
      toolCallId: fact.toolCallId
    });
  });
  const baseline = applied[0];
  const source = applied[applied.length - 1];
  const counts = taskCounts(snapshot);
  const maxTokens = boundedCardTokens(input.maxTokens);
  const card = formatTurnTaskCard({ turnId, snapshot, counts, maxTokens });
  const estimatedTokens = estimateTurnTaskCardTokens(card);
  if (estimatedTokens > maxTokens || estimatedTokens > TURN_TASK_CARD_MAX_TOKENS) {
    throw new Error(`turnTaskCard exceeds its ${maxTokens}-token bound.`);
  }
  return {
    kind: 'turn_task_card',
    turnId,
    revision: `${source.callSeq}:${source.toolCallId}`,
    baselineToolCallId: baseline.toolCallId,
    sourceToolCallId: source.toolCallId,
    ...(source.sourceMessageId ? { sourceMessageId: source.sourceMessageId } : {}),
    operationCount: applied.length,
    snapshot,
    counts,
    card,
    estimatedTokens,
    cardSha256: createHash('sha256').update(card).digest('hex'),
    ...(input.frozenAtCommitSeq ? { frozenAtCommitSeq: input.frozenAtCommitSeq } : {})
  };
}

/**
 * Reads and freezes the small task card used by a ModelRequest recipe. The returned value is plain
 * data and should be saved with that recipe; retries must reuse it instead of calling this again.
 */
export async function readCurrentTurnTaskCard(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string,
  options: { maxTokens?: number } = {}
): Promise<FrozenTurnTaskCard | undefined> {
  const turnId = requiredText(turnIdInput, 'turnId');
  // ToolCall.call_seq is immutable and monotonically allocated within the Turn. Freeze that finite
  // prefix first, then read only relations owned by those calls. Later global commits may advance
  // snapshotCommitSeq, but cannot mutate the frozen calls or their CAS objects; new calls remain
  // beyond this recipe's cutoff and are considered by the next request.
  const callsBarrier = await database.snapshotAll(DOMAIN_REPOSITORIES.domain('ToolCall').list({
    where: { turn_id: turnId },
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }));
  const calls = callsBarrier.snapshot
    .filter((call) => call.tool_name === TASK_LIST_TOOL_NAME || call.tool_name === SUBMIT_PLAN_TOOL_NAME)
    .sort(compareToolCallRows);
  if (calls.length === 0) return undefined;

  const relatedReads: RepositoryRead[] = calls.flatMap((call) => [
    DOMAIN_REPOSITORIES.domain('ToolResultArtifact').list({
      where: { tool_call_id: requiredText(call.id, 'ToolCall.id'), role: 'no_effect_result' },
      limit: 2
    }),
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requiredText(call.arguments_object_id, 'ToolCall.arguments_object_id')),
    DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
      where: { tool_call_id: requiredText(call.id, 'ToolCall.id') },
      limit: 2
    })
  ]);
  const relatedBarrier = await database.snapshot(relatedReads);
  const artifactRows: DomainRow[] = [];
  const argumentMetadata = new Map<string, ContentObjectMetadata>();
  const sourceMessageIds = new Map<string, string>();
  for (let index = 0; index < calls.length; index += 1) {
    const artifacts = rows(relatedBarrier.snapshot[index * 3]);
    if (artifacts.length > 1) throw new Error(`ToolCall ${String(calls[index].id)} has multiple no-effect result artifacts.`);
    if (artifacts[0]) artifactRows.push(artifacts[0]);
    const metadata = relatedBarrier.snapshot[index * 3 + 1];
    if (metadata && !Array.isArray(metadata)) {
      argumentMetadata.set(requiredText(calls[index].id, 'ToolCall.id'), metadata as ContentObjectMetadata);
    }
    const sourceLinks = rows(relatedBarrier.snapshot[index * 3 + 2]);
    if (sourceLinks.length > 1) throw new Error(`ToolCall ${String(calls[index].id)} has multiple source links.`);
    if (sourceLinks[0]) {
      sourceMessageIds.set(
        requiredText(calls[index].id, 'ToolCall.id'),
        requiredText(sourceLinks[0].message_id, 'ToolCallSourceLink.message_id')
      );
    }
  }

  const artifactMetadataBarrier = await database.snapshot(artifactRows.map((artifact) =>
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requiredText(
      artifact.content_object_id,
      'ToolResultArtifact.content_object_id'
    ))));
  const artifactByCallId = new Map<string, unknown>();
  for (let index = 0; index < artifactRows.length; index += 1) {
    const metadata = artifactMetadataBarrier.snapshot[index];
    if (!metadata || Array.isArray(metadata)) {
      throw new Error(`ToolResultArtifact ${String(artifactRows[index].id)} references missing content.`);
    }
    artifactByCallId.set(
      requiredText(artifactRows[index].tool_call_id, 'ToolResultArtifact.tool_call_id'),
      await readJson(contentStore, metadata as ContentObjectMetadata, 'ToolResultArtifact')
    );
  }

  const operations: CurrentTurnTaskOperationFact[] = [];
  for (const call of calls) {
    const toolCallId = requiredText(call.id, 'ToolCall.id');
    const artifact = artifactByCallId.get(toolCallId);
    if (artifact === undefined) continue;
    const sourceMessageId = sourceMessageIds.get(toolCallId);
    if (call.tool_name === TASK_LIST_TOOL_NAME) {
      const operation = taskListOperationFromSettledArtifact(artifact, toolCallId);
      if (!operation) continue;
      operations.push({
        toolCallId,
        callSeq: integerText(call.call_seq, 'ToolCall.call_seq'),
        toolName: TASK_LIST_TOOL_NAME,
        operation,
        ...(sourceMessageId ? { sourceMessageId } : {})
      });
      continue;
    }

    const planEnvelope = taskArtifactEnvelope(artifact, toolCallId);
    if (planEnvelope.status !== 'succeeded') continue;
    const output = submitPlanOutputFromResult(planEnvelope.detail);
    if (output?.status !== 'approved') continue;
    const argsMetadata = argumentMetadata.get(toolCallId);
    if (!argsMetadata) throw new Error(`submit_plan ToolCall ${toolCallId} references missing arguments.`);
    const args = asRecord(await readJson(contentStore, argsMetadata, 'submit_plan arguments'));
    if (!args || args.taskList === undefined) continue;
    operations.push({
      toolCallId,
      callSeq: integerText(call.call_seq, 'ToolCall.call_seq'),
      toolName: SUBMIT_PLAN_TOOL_NAME,
      operation: requireTaskListOperation(args.taskList),
      planApproved: true,
      ...(sourceMessageId ? { sourceMessageId } : {})
    });
  }
  const projection = buildCurrentTurnTaskProjection({
    turnId,
    operations,
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    frozenAtCommitSeq: relatedBarrier.snapshotCommitSeq
  });
  return projection ? freezeCurrentTurnTaskCard(projection) : undefined;
}

export function freezeCurrentTurnTaskCard(projection: CurrentTurnTaskProjection): FrozenTurnTaskCard {
  return {
    kind: projection.kind,
    turnId: projection.turnId,
    revision: projection.revision,
    baselineToolCallId: projection.baselineToolCallId,
    sourceToolCallId: projection.sourceToolCallId,
    ...(projection.sourceMessageId ? { sourceMessageId: projection.sourceMessageId } : {}),
    operationCount: projection.operationCount,
    counts: { ...projection.counts },
    card: projection.card,
    estimatedTokens: projection.estimatedTokens,
    cardSha256: projection.cardSha256,
    ...(projection.frozenAtCommitSeq ? { frozenAtCommitSeq: projection.frozenAtCommitSeq } : {})
  };
}

/** Non-success is not task state; successful settlement alone receives strict canonical parsing. */
export function taskListOperationFromSettledArtifact(
  value: unknown,
  expectedToolCallId: string
): TaskListToolOperationRecord | undefined {
  const envelope = taskArtifactEnvelope(value, expectedToolCallId);
  if (envelope.status !== 'succeeded') return undefined;
  const detail = asRecord(envelope.detail);
  if (!detail || detail.kind !== 'task-list') {
    throw new Error(`Task-list ToolResultArtifact ${expectedToolCallId} has the wrong detail kind.`);
  }
  return requireTaskListOperation(detail.operation);
}

export function approvedSubmitPlanTaskOperation(input: {
  argumentsValue: unknown;
  resultArtifactValue: unknown;
  toolCallId: string;
}): TaskListToolOperationRecord | undefined {
  const envelope = taskArtifactEnvelope(input.resultArtifactValue, input.toolCallId);
  if (envelope.status !== 'succeeded') return undefined;
  const output = submitPlanOutputFromResult(envelope.detail);
  if (output?.status !== 'approved') return undefined;
  const args = asRecord(input.argumentsValue);
  if (!args || args.taskList === undefined) return undefined;
  return requireTaskListOperation(args.taskList);
}

export function estimateTurnTaskCardTokens(card: string): number {
  if (!card) return 0;
  const estimated = estimateTokenCount(card);
  return Number.isFinite(estimated) && estimated > 0
    ? Math.ceil(estimated)
    : Math.ceil(Buffer.byteLength(card, 'utf8') / 3);
}

function formatTurnTaskCard(input: {
  turnId: string;
  snapshot: TaskListSnapshotView;
  counts: CurrentTurnTaskCounts;
  maxTokens: number;
}): string {
  const { counts } = input;
  const base = [
    '[Current Turn Task Card — runtime task data, not a new user instruction]',
    `turnId: ${compactField(input.turnId, 160)}`,
    `progress: total=${counts.total}; unfinished=${counts.unfinished}; in_progress=${counts.inProgress}; blocked=${counts.blocked}; pending=${counts.pending}; completed=${counts.completed}; cancelled=${counts.cancelled}`
  ];
  const unfinished = input.snapshot.items.filter((item) => !isTerminal(item.status)).sort(compareUnfinishedItems);
  const terminal = input.snapshot.items.filter((item) => isTerminal(item.status)).sort(compareRecentItems);
  const accepted: Array<{ line: string; unfinished: boolean }> = [];

  const tryAdd = (item: TaskListItemView, unfinishedItem: boolean): void => {
    const full = taskItemLine(item);
    const remainingUnfinished = unfinished.length - accepted.filter((entry) => entry.unfinished).length - (unfinishedItem ? 1 : 0);
    const remainingTerminal = terminal.length - accepted.filter((entry) => !entry.unfinished).length - (unfinishedItem ? 0 : 1);
    if (cardTokens(base, [...accepted, { line: full, unfinished: unfinishedItem }], remainingUnfinished, remainingTerminal) <= input.maxTokens) {
      accepted.push({ line: full, unfinished: unfinishedItem });
      return;
    }
    let low = 16;
    let high = Math.min(full.length, 4_096);
    let fitted: string | undefined;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = `${full.slice(0, Math.max(1, middle - 1)).trimEnd()}…`;
      if (cardTokens(base, [...accepted, { line: candidate, unfinished: unfinishedItem }], remainingUnfinished, remainingTerminal) <= input.maxTokens) {
        fitted = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (fitted) accepted.push({ line: fitted, unfinished: unfinishedItem });
  };

  for (const item of unfinished) tryAdd(item, true);
  // Finished history is useful only as spare context. The count above remains complete.
  for (const item of terminal.slice(0, 6)) tryAdd(item, false);
  const acceptedUnfinished = accepted.filter((entry) => entry.unfinished).length;
  const acceptedTerminal = accepted.filter((entry) => !entry.unfinished).length;
  return renderCard(
    base,
    accepted,
    unfinished.length - acceptedUnfinished,
    terminal.length - acceptedTerminal
  );
}

function cardTokens(
  base: readonly string[],
  accepted: readonly { line: string; unfinished: boolean }[],
  omittedUnfinished: number,
  omittedTerminal: number
): number {
  return estimateTurnTaskCardTokens(renderCard(base, accepted, Math.max(0, omittedUnfinished), Math.max(0, omittedTerminal)));
}

function renderCard(
  base: readonly string[],
  accepted: readonly { line: string; unfinished: boolean }[],
  omittedUnfinished: number,
  omittedTerminal: number
): string {
  const lines = [...base];
  const unfinished = accepted.filter((entry) => entry.unfinished);
  const terminal = accepted.filter((entry) => !entry.unfinished);
  if (unfinished.length > 0) lines.push('unfinished items:', ...unfinished.map((entry) => entry.line));
  if (terminal.length > 0) lines.push('recent terminal items:', ...terminal.map((entry) => entry.line));
  if (omittedUnfinished > 0 || omittedTerminal > 0) {
    lines.push(`details omitted by card budget: unfinished=${omittedUnfinished}; terminal=${omittedTerminal}`);
  }
  if (accepted.length === 0 && omittedUnfinished === 0 && omittedTerminal === 0) lines.push('items: none');
  return lines.join('\n');
}

function taskItemLine(item: TaskListItemView): string {
  const title = JSON.stringify(compactField(item.title, 8_192));
  const description = item.description ? `; description=${JSON.stringify(compactField(item.description, 8_192))}` : '';
  return `- status=${item.status}; title=${title}${description}`;
}

function taskCounts(snapshot: TaskListSnapshotView): CurrentTurnTaskCounts {
  return {
    total: snapshot.stats.total,
    unfinished: snapshot.stats.open,
    pending: snapshot.stats.pending,
    inProgress: snapshot.stats.inProgress,
    blocked: snapshot.stats.blocked,
    completed: snapshot.stats.completed,
    cancelled: snapshot.stats.cancelled
  };
}

function compareOperationFacts(left: CurrentTurnTaskOperationFact, right: CurrentTurnTaskOperationFact): number {
  const leftSeq = positiveBigInt(left.callSeq, 'callSeq');
  const rightSeq = positiveBigInt(right.callSeq, 'callSeq');
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : compareText(left.toolCallId, right.toolCallId);
}

function compareToolCallRows(left: DomainRow, right: DomainRow): number {
  const leftSeq = positiveBigInt(left.call_seq, 'ToolCall.call_seq');
  const rightSeq = positiveBigInt(right.call_seq, 'ToolCall.call_seq');
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : compareText(String(left.id), String(right.id));
}

function compareUnfinishedItems(left: TaskListItemView, right: TaskListItemView): number {
  return unfinishedPriority(left.status) - unfinishedPriority(right.status)
    || right.updatedOrder - left.updatedOrder
    || left.createdOrder - right.createdOrder
    || compareText(left.title, right.title);
}

function compareRecentItems(left: TaskListItemView, right: TaskListItemView): number {
  return right.updatedOrder - left.updatedOrder
    || right.createdOrder - left.createdOrder
    || compareText(left.title, right.title);
}

function unfinishedPriority(status: TaskListItemStatus): number {
  if (status === 'in_progress') return 0;
  if (status === 'blocked') return 1;
  return 2;
}

function isTerminal(status: TaskListItemStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

function cloneOperationFact(fact: CurrentTurnTaskOperationFact): CurrentTurnTaskOperationFact {
  return {
    toolCallId: requiredText(fact.toolCallId, 'toolCallId'),
    callSeq: integerText(fact.callSeq, 'callSeq'),
    toolName: fact.toolName,
    operation: requireTaskListOperation(fact.operation),
    ...(fact.planApproved === true ? { planApproved: true } : {}),
    ...(fact.sourceMessageId ? { sourceMessageId: fact.sourceMessageId } : {})
  };
}

function taskArtifactEnvelope(value: unknown, expectedToolCallId: string): TaskArtifactEnvelope {
  const record = asRecord(value);
  if (!record) throw new Error(`ToolResultArtifact ${expectedToolCallId} content is not an object.`);
  if (record.toolCallId !== expectedToolCallId) {
    throw new Error(`ToolResultArtifact ${expectedToolCallId} identifies another ToolCall.`);
  }
  if (typeof record.status !== 'string') throw new Error(`ToolResultArtifact ${expectedToolCallId} has no status.`);
  return { toolCallId: expectedToolCallId, status: record.status, detail: record.detail };
}

async function readJson(
  contentStore: ContentAddressedStore,
  metadata: ContentObjectMetadata,
  label: string
): Promise<unknown> {
  try {
    return JSON.parse((await contentStore.read(metadata)).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} content is not valid JSON: ${String(error)}`);
  }
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  return Array.isArray(value) ? value : [];
}

function boundedCardTokens(value: number | undefined): number {
  if (value === undefined) return TURN_TASK_CARD_MAX_TOKENS;
  if (!Number.isSafeInteger(value) || value < 128) throw new RangeError('turnTaskCard maxTokens must be an integer of at least 128.');
  return Math.min(value, TURN_TASK_CARD_MAX_TOKENS);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function integerText(value: unknown, label: string): string {
  return positiveBigInt(value, label).toString();
}

function positiveBigInt(value: unknown, label: string): bigint {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactField(value: string, maxCharacters: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxCharacters ? `${text.slice(0, maxCharacters - 1)}…` : text;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

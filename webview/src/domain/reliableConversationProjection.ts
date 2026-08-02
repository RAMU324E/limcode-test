import type {
  FunctionCallPart,
  MessageContent,
  MessageRecord,
  ToolCallRecord,
  ToolCallStatus
} from '@shared/protocol';
import {
  reliableKernelDetailKey,
  type ReliableKernelDetailState,
  type ReliableKernelTransientState
} from '@webview/stores/useReliableKernelClientFeedStore';

export type ReliableClientRecord = Record<string, unknown>;
export type ReliableClientRecordBuckets = Record<string, Record<string, ReliableClientRecord>>;

export interface ReliableConversationProjectionInput {
  conversationId: string;
  records: ReliableClientRecordBuckets;
  details: Record<string, ReliableKernelDetailState>;
  transientModelRequests?: Record<string, ReliableKernelTransientState>;
}

export interface ReliableFileDiffProjection {
  files: Array<{
    memberId: string;
    path: string;
    action?: string;
    added?: number;
    removed?: number;
    truncated?: boolean;
    text: string;
  }>;
}

export interface ReliableInteractionProjection {
  id: string;
  kind: string;
  status: string;
  turnId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReliableConversationProjection {
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  turnIdByMessageId: Record<string, string>;
  toolResultByCallId: Record<string, unknown>;
  interactionByToolCallId: Record<string, ReliableInteractionProjection>;
  fileDiffByToolCallId: Record<string, ReliableFileDiffProjection>;
  fileChangeSetIdByToolCallId: Record<string, string>;
  loadingMessageRevisionIds: string[];
  missingToolArgumentIds: string[];
  missingToolResultIds: string[];
  missingFileDiffMemberIds: string[];
}

interface ParsedMessage {
  record: ReliableClientRecord;
  message: MessageRecord;
  turnId?: string;
}

interface FunctionCallTarget {
  messageId: string;
  part: FunctionCallPart;
  ordinal: number;
}

/**
 * Pure UI projection over independent Runtime objects and Link facts. It never mutates or persists a
 * coupled aggregate: Message↔Turn and Tool↔Turn relationships are interpreted only for rendering.
 */
export function projectReliableConversation(
  input: ReliableConversationProjectionInput
): ReliableConversationProjection {
  const conversationId = input.conversationId.trim();
  if (!conversationId) return emptyProjection();
  const messageFacts = values(input.records.Message)
    .filter((record) => text(record.conversation_id) === conversationId)
    .filter((record) => record.deleted_at === null || record.deleted_at === undefined)
    .sort(compareSequence('message_seq'));
  const messageTurnLinks = values(input.records.MessageTurnLink);
  const turnIdByMessageId: Record<string, string> = {};
  for (const link of messageTurnLinks) {
    const messageId = text(link.message_id);
    const turnId = text(link.turn_id);
    if (!messageId || !turnId) continue;
    if (link.role === 'model' || turnIdByMessageId[messageId] === undefined) {
      turnIdByMessageId[messageId] = turnId;
    }
  }

  const loadingMessageRevisionIds: string[] = [];
  const parsedMessages: ParsedMessage[] = [];
  for (const record of messageFacts) {
    const role = record.role;
    if (role !== 'user' && role !== 'model') continue;
    const id = text(record.id);
    const revisionId = text(record.revision_id);
    if (!id || !revisionId) continue;
    const detail = input.details[reliableKernelDetailKey('message-content', revisionId)];
    if (detail?.status !== 'ready') loadingMessageRevisionIds.push(revisionId);
    const content = detail?.status === 'ready'
      ? parseMessageContent(detail.text, role)
      : { role, parts: [] } satisfies MessageContent;
    parsedMessages.push({
      record,
      message: {
        id,
        conversationId,
        role,
        content,
        status: detail?.status === 'ready' ? 'final' : 'streaming',
        createdAt: timestamp(record.created_at),
        seq: integer(record.message_seq)
      },
      ...(turnIdByMessageId[id] ? { turnId: turnIdByMessageId[id] } : {})
    });
  }

  appendTransientMessages(parsedMessages, input.transientModelRequests ?? {}, conversationId);

  const callsByTurn = groupBy(values(input.records.ToolCall), (record) => text(record.turn_id));
  const executionsByCall = firstBy(values(input.records.ToolExecution), (record) => text(record.tool_call_id));
  const outcomesByCall = firstBy(values(input.records.ToolOutcome), (record) => text(record.tool_call_id));
  const toolCalls: ToolCallRecord[] = [];
  const toolResultByCallId: Record<string, unknown> = {};
  const missingToolArgumentIds: string[] = [];
  const missingToolResultIds: string[] = [];

  const messagesByTurn = groupBy(parsedMessages, (entry) => entry.turnId);
  for (const [turnId, rawCalls] of callsByTurn) {
    if (!turnId) continue;
    const functionTargets = functionCallTargets(messagesByTurn.get(turnId) ?? []);
    const orderedCalls = [...rawCalls].sort(compareSequence('call_seq'));
    for (let index = 0; index < orderedCalls.length; index += 1) {
      const raw = orderedCalls[index]!;
      const id = text(raw.id);
      const name = text(raw.tool_name);
      if (!id || !name) continue;
      const target = functionTargets[index];
      if (!target) continue;
      const argumentsDetail = input.details[reliableKernelDetailKey('tool-arguments-content', id)];
      const resultDetail = input.details[reliableKernelDetailKey('tool-result-content', id)];
      if (argumentsDetail?.status !== 'ready') missingToolArgumentIds.push(id);
      if (raw.status === 'terminal' && resultDetail?.status !== 'ready') missingToolResultIds.push(id);
      const args = argumentsDetail?.status === 'ready'
        ? normalizeJsonText(argumentsDetail.text)
        : JSON.stringify(target.part.functionCall.args ?? {});
      const execution = executionsByCall.get(id);
      const outcome = outcomesByCall.get(id);
      const parsedResult = resultDetail?.status === 'ready' ? parseJson(resultDetail.text) : undefined;
      if (parsedResult !== undefined) toolResultByCallId[id] = toolResultDetail(parsedResult);
      toolCalls.push({
        id,
        messageId: target.messageId,
        name,
        ...(text(target.part.id) ? { functionCallId: text(target.part.id) } : {}),
        args,
        status: toolStatus(raw, execution, outcome),
        schedulingOrdinal: target.ordinal,
        schedulingMode: 'serial',
        createdAt: timestamp(raw.created_at),
        updatedAt: timestamp(raw.updated_at),
        ...(durationMs(execution) !== undefined ? { durationMs: durationMs(execution) } : {})
      });
    }
  }

  const fileChanges = projectReliableFileChanges(input.records, input.details);
  const interactionByToolCallId = projectReliableInteractions(input.records);
  return {
    messages: parsedMessages.map((entry) => entry.message),
    toolCalls,
    turnIdByMessageId,
    toolResultByCallId,
    interactionByToolCallId,
    fileDiffByToolCallId: fileChanges.diffByToolCallId,
    fileChangeSetIdByToolCallId: fileChanges.changeSetIdByToolCallId,
    loadingMessageRevisionIds,
    missingToolArgumentIds,
    missingToolResultIds,
    missingFileDiffMemberIds: fileChanges.missingMemberIds
  };
}

export function reliableActiveConversationId(projections: Record<string, unknown>): string {
  const window = record(projections.activeConversationWindow);
  return text(window?.conversationId) ?? '';
}

function projectReliableInteractions(
  records: ReliableClientRecordBuckets
): Record<string, ReliableInteractionProjection> {
  const requests = new Map(values(records.InteractionRequest)
    .map((request) => [text(request.id), request] as const)
    .filter((entry): entry is readonly [string, ReliableClientRecord] => !!entry[0]));
  const owners = new Map(values(records.InteractionOwnerLink)
    .map((link) => [text(link.request_id), text(link.turn_id)] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[0] && !!entry[1]));
  const result: Record<string, ReliableInteractionProjection> = {};
  for (const link of values(records.InteractionToolCallLink)) {
    const requestId = text(link.request_id);
    const toolCallId = text(link.tool_call_id);
    if (!requestId || !toolCallId) continue;
    const request = requests.get(requestId);
    const kind = text(request?.request_kind);
    const status = text(request?.status);
    if (!request || !kind || !status) continue;
    const turnId = owners.get(requestId);
    result[toolCallId] = {
      id: requestId,
      kind,
      status,
      ...(turnId ? { turnId } : {}),
      createdAt: timestamp(request.created_at),
      updatedAt: timestamp(request.updated_at)
    };
  }
  return result;
}

function projectReliableFileChanges(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): {
  diffByToolCallId: Record<string, ReliableFileDiffProjection>;
  changeSetIdByToolCallId: Record<string, string>;
  missingMemberIds: string[];
} {
  const diffByToolCallId: Record<string, ReliableFileDiffProjection> = {};
  const changeSetIdByToolCallId: Record<string, string> = {};
  const missingMemberIds: string[] = [];
  const membersByChangeSet = groupBy(values(records.FileChangeSetMember), (member) => text(member.change_set_id));
  for (const changeSet of values(records.FileChangeSet)) {
    const changeSetId = text(changeSet.id);
    const toolCallId = text(changeSet.tool_call_id);
    if (!changeSetId || !toolCallId) continue;
    changeSetIdByToolCallId[toolCallId] = changeSetId;
    const files: ReliableFileDiffProjection['files'] = [];
    const members = [...(membersByChangeSet.get(changeSetId) ?? [])].sort(compareSequence('member_seq'));
    for (const member of members) {
      const memberId = text(member.id);
      if (!memberId) continue;
      const detail = details[reliableKernelDetailKey('file-change-diff', memberId)];
      if (detail?.status !== 'ready') {
        missingMemberIds.push(memberId);
        continue;
      }
      const payload = record(parseJson(detail.text));
      const diff = record(payload?.diff);
      const diffText = textPreserveWhitespace(diff?.text);
      const path = text(payload?.path);
      if (!diffText || !path) continue;
      const action = text(payload?.action);
      const added = finiteNumber(diff?.added);
      const removed = finiteNumber(diff?.removed);
      files.push({
        memberId,
        path,
        ...(action ? { action } : {}),
        ...(added !== undefined ? { added } : {}),
        ...(removed !== undefined ? { removed } : {}),
        ...(typeof diff?.truncated === 'boolean' ? { truncated: diff.truncated } : {}),
        text: diffText
      });
    }
    if (files.length > 0) diffByToolCallId[toolCallId] = { files };
  }
  return { diffByToolCallId, changeSetIdByToolCallId, missingMemberIds };
}

function appendTransientMessages(
  messages: ParsedMessage[],
  transientByRequest: Record<string, ReliableKernelTransientState>,
  conversationId: string
): void {
  let nextSequence = Math.max(0, ...messages.map((entry) => entry.message.seq));
  const active = Object.values(transientByRequest)
    .filter((entry) => entry.conversationId === conversationId)
    .sort((left, right) => left.startedAt - right.startedAt || left.modelRequestId.localeCompare(right.modelRequestId));
  for (const transient of active) {
    const durableExists = messages.some((entry) =>
      entry.turnId === transient.turnId
      && entry.message.role === 'model'
      && entry.message.createdAt >= transient.startedAt
    );
    if (durableExists) continue;
    nextSequence += 1;
    const parts: MessageContent['parts'] = [];
    if (transient.thought) {
      parts.push({
        text: transient.thought,
        thought: true,
        ...(transient.thoughtSignature ? { thoughtSignature: transient.thoughtSignature } : {})
      });
    }
    if (transient.text) parts.push({ text: transient.text });
    for (const call of transient.toolCalls) {
      const value = record(call);
      const name = text(value?.name);
      if (!name) continue;
      parts.push({
        ...(text(value?.id) ? { id: text(value?.id) } : {}),
        functionCall: {
          name,
          args: (value?.arguments ?? {}) as never
        }
      });
    }
    messages.push({
      record: {},
      turnId: transient.turnId,
      message: {
        id: `transient:${transient.modelRequestId}`,
        conversationId,
        role: 'model',
        content: { role: 'model', parts },
        status: 'streaming',
        createdAt: transient.startedAt,
        requestStartedAt: transient.startedAt,
        seq: nextSequence
      }
    });
  }
}

function functionCallTargets(messages: ParsedMessage[]): FunctionCallTarget[] {
  const targets: FunctionCallTarget[] = [];
  for (const entry of [...messages].sort((left, right) => left.message.seq - right.message.seq)) {
    let ordinal = 0;
    for (const part of entry.message.content.parts) {
      if (!('functionCall' in part)) continue;
      targets.push({ messageId: entry.message.id, part, ordinal });
      ordinal += 1;
    }
  }
  return targets;
}

function parseMessageContent(source: string, role: 'user' | 'model'): MessageContent {
  const parsed = parseJson(source);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const candidate = parsed as Record<string, unknown>;
    if ((candidate.role === 'user' || candidate.role === 'model') && Array.isArray(candidate.parts)) {
      return candidate as unknown as MessageContent;
    }
  }
  return { role, parts: source ? [{ text: source }] : [] };
}

function toolStatus(
  call: ReliableClientRecord,
  execution: ReliableClientRecord | undefined,
  outcome: ReliableClientRecord | undefined
): ToolCallStatus {
  if (call.status === 'terminal') {
    return outcome?.status === 'succeeded' ? 'success' : outcome?.status === 'rejected' ? 'warning' : 'error';
  }
  if (execution?.status === 'waiting_answer') return 'awaiting_user_input';
  if (call.status === 'executing' || execution?.status === 'executing') return 'executing';
  return 'queued';
}

function toolResultDetail(value: unknown): unknown {
  const envelope = record(value);
  return envelope && 'detail' in envelope ? envelope.detail : value;
}

function durationMs(execution: ReliableClientRecord | undefined): number | undefined {
  if (!execution) return undefined;
  const started = timestamp(execution.started_at);
  const completed = timestamp(execution.completed_at);
  return started > 0 && completed >= started ? completed - started : undefined;
}

function normalizeJsonText(value: string): string {
  const parsed = parseJson(value);
  return parsed === undefined ? value : JSON.stringify(parsed);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function emptyProjection(): ReliableConversationProjection {
  return {
    messages: [],
    toolCalls: [],
    turnIdByMessageId: {},
    toolResultByCallId: {},
    interactionByToolCallId: {},
    fileDiffByToolCallId: {},
    fileChangeSetIdByToolCallId: {},
    loadingMessageRevisionIds: [],
    missingToolArgumentIds: [],
    missingToolResultIds: [],
    missingFileDiffMemberIds: []
  };
}

function values(bucket: Record<string, ReliableClientRecord> | undefined): ReliableClientRecord[] {
  return Object.values(bucket ?? {});
}

function firstBy(
  input: ReliableClientRecord[],
  key: (record: ReliableClientRecord) => string | undefined
): Map<string, ReliableClientRecord> {
  const result = new Map<string, ReliableClientRecord>();
  for (const entry of input) {
    const id = key(entry);
    if (id && !result.has(id)) result.set(id, entry);
  }
  return result;
}

function groupBy<T>(input: T[], key: (record: T) => string | undefined): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const entry of input) {
    const id = key(entry);
    if (!id) continue;
    const group = result.get(id) ?? [];
    group.push(entry);
    result.set(id, group);
  }
  return result;
}

function compareSequence(field: string): (left: ReliableClientRecord, right: ReliableClientRecord) => number {
  return (left, right) => integer(left[field]) - integer(right[field])
    || text(left.id)?.localeCompare(text(right.id) ?? '')
    || 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function textPreserveWhitespace(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return 0;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

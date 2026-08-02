import type {
  FunctionCallPart,
  LlmUsageMetadataRecord,
  MessageContent,
  MessageRecord,
  RunTerminationRecord,
  ToolCallEventKind,
  ToolCallEventRecord,
  ToolCallRecord,
  ToolCallStatus,
  ToolDisplayPolicyRecord,
  ToolSchedulingMode
} from '@shared/protocol';
import { transientFunctionCallParts } from './reliableTransientModel.ts';
import { reliableKernelDetailKey } from './reliableDetailKey.ts';
import type {
  ReliableKernelDetailState,
  ReliableKernelTransientState
} from '@webview/stores/useReliableKernelClientFeedStore';

export type ReliableClientRecord = Record<string, unknown>;
export type ReliableClientRecordBuckets = Record<string, Record<string, ReliableClientRecord>>;

export interface ReliableConversationProjectionInput {
  conversationId: string;
  records: ReliableClientRecordBuckets;
  details: Record<string, ReliableKernelDetailState>;
  transientModelRequests?: Record<string, ReliableKernelTransientState>;
  lastCommitSeq?: string | null;
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
  prompt?: unknown;
}

export interface ReliableConversationProjection {
  messages: MessageRecord[];
  toolCalls: ToolCallRecord[];
  toolCallsByMessageId: Record<string, ToolCallRecord[]>;
  toolCallEvents: ToolCallEventRecord[];
  toolCallEventsByCallId: Record<string, ToolCallEventRecord[]>;
  toolEventIdsByCallId: Record<string, string[]>;
  turnIdByMessageId: Record<string, string>;
  messageRevisionIdByMessageId: Record<string, string>;
  terminationByMessageId: Record<string, RunTerminationRecord>;
  toolResultByCallId: Record<string, unknown>;
  interactionByToolCallId: Record<string, ReliableInteractionProjection>;
  interactionPromptIdByToolCallId: Record<string, string>;
  fileDiffByToolCallId: Record<string, ReliableFileDiffProjection>;
  fileDiffMemberIdsByToolCallId: Record<string, string[]>;
  fileChangeSetIdByToolCallId: Record<string, string>;
  loadingMessageRevisionIds: string[];
  missingToolArgumentIds: string[];
  missingToolResultIds: string[];
  missingToolEventIds: string[];
  missingInteractionPromptIds: string[];
  missingFileDiffMemberIds: string[];
}

interface ParsedMessage {
  record: ReliableClientRecord;
  message: MessageRecord;
  turnId?: string;
  revisionReady: boolean;
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
  const messageRevisionIdByMessageId: Record<string, string> = {};
  const parsedMessages: ParsedMessage[] = [];
  for (const record of messageFacts) {
    const role = record.role;
    if (role !== 'user' && role !== 'model') continue;
    const id = text(record.id);
    const revisionId = text(record.revision_id);
    if (!id || !revisionId) continue;
    messageRevisionIdByMessageId[id] = revisionId;
    const detail = input.details[reliableKernelDetailKey('message-content', revisionId)];
    if (!detail || detail.status === 'loading') loadingMessageRevisionIds.push(revisionId);
    const content = detail?.status === 'ready'
      ? parseMessageContent(detail.text, role)
      : detail?.status === 'error'
        ? {
            role,
            parts: [{ text: `[正文未在页面中物化：${detail.error?.trim() || '详情读取失败'}]` }]
          } satisfies MessageContent
      : { role, parts: [] } satisfies MessageContent;
    parsedMessages.push({
      record,
      message: {
        id,
        revisionId,
        conversationId,
        role,
        content,
        status: detail?.status === 'ready' ? 'final' : detail?.status === 'error' ? 'partial' : 'streaming',
        createdAt: timestamp(record.created_at),
        ...(role === 'model' ? { retryTarget: { kind: 'message' as const, messageId: id } } : {}),
        seq: integer(record.display_seq) || integer(record.message_seq)
      },
      revisionReady: detail?.status === 'ready',
      ...(turnIdByMessageId[id] ? { turnId: turnIdByMessageId[id] } : {})
    });
  }

  const modelRequestsByTurn = groupBy(values(input.records.ModelRequest), (record) => text(record.turn_id));
  const modelRequestMessageLinks = values(input.records.ModelRequestMessageLink);
  enrichModelMessages(
    parsedMessages,
    modelRequestsByTurn,
    modelRequestMessageLinks
  );
  appendTransientMessages({
    messages: parsedMessages,
    transientByRequest: input.transientModelRequests ?? {},
    conversationId,
    modelRequestById: firstBy(values(input.records.ModelRequest), (record) => text(record.id)),
    messageIdByModelRequestId: new Map(modelRequestMessageLinks.flatMap((link) => {
      const requestId = text(link.model_request_id);
      const messageId = text(link.message_id);
      return requestId && messageId ? [[requestId, messageId] as const] : [];
    })),
    toolCallFacts: values(input.records.ToolCall),
    lastCommitSeq: input.lastCommitSeq ?? undefined
  });
  parsedMessages.sort(compareParsedMessages);

  const callsByTurn = groupBy(values(input.records.ToolCall), (record) => text(record.turn_id));
  const interactionProjection = projectReliableInteractions(input.records, input.details);
  const interactionByToolCallId = interactionProjection.byToolCallId;
  const executionsByCall = firstBy(values(input.records.ToolExecution), (record) => text(record.tool_call_id));
  const outcomesByCall = firstBy(values(input.records.ToolOutcome), (record) => text(record.tool_call_id));
  const toolEventProjection = projectToolCallEvents(input.records, input.details);
  const toolCallEvents = toolEventProjection.events;
  const eventsByCall = groupBy(toolCallEvents, (event) => event.toolCallId);
  const toolCalls: ToolCallRecord[] = [];
  const toolResultByCallId: Record<string, unknown> = {};
  const missingToolArgumentIds: string[] = [];
  const missingToolResultIds: string[] = [];

  const messagesByTurn = groupBy(parsedMessages, (entry) => entry.turnId);
  const requestMessageIdByRequestId = new Map(modelRequestMessageLinks.flatMap((link) => {
    const requestId = text(link.model_request_id);
    const messageId = text(link.message_id);
    return requestId && messageId ? [[requestId, messageId] as const] : [];
  }));
  const sourceByToolCallId = firstBy(values(input.records.ToolCallSourceLink), (link) => text(link.tool_call_id));
  const policyByToolCallId = firstBy(values(input.records.ToolCallPolicySnapshot), (snapshot) => text(snapshot.tool_call_id));
  const assignedOrdinals = new Map<string, number>();
  for (const [turnId, rawCalls] of callsByTurn) {
    if (!turnId) continue;
    const functionTargets = functionCallTargets(messagesByTurn.get(turnId) ?? []);
    const orderedCalls = [...rawCalls].sort(compareSequence('call_seq'));
    for (let index = 0; index < orderedCalls.length; index += 1) {
      const raw = orderedCalls[index]!;
      const id = text(raw.id);
      const name = text(raw.tool_name);
      if (!id || !name) continue;
      const sourceLink = sourceByToolCallId.get(id);
      const policy = policyByToolCallId.get(id);
      const target = resolveFunctionCallTarget({
        raw,
        fallbackIndex: index,
        functionTargets,
        messages: messagesByTurn.get(turnId) ?? [],
        sourceLink,
        requestMessageIdByRequestId,
        assignedOrdinals
      });
      if (!target) continue;
      const argumentsDetail = input.details[reliableKernelDetailKey('tool-arguments-content', id)];
      const resultDetail = input.details[reliableKernelDetailKey('tool-result-content', id)];
      if (!argumentsDetail || argumentsDetail.status === 'loading') missingToolArgumentIds.push(id);
      if (raw.status === 'terminal' && (!resultDetail || resultDetail.status === 'loading')) missingToolResultIds.push(id);
      const args = argumentsDetail?.status === 'ready'
        ? normalizeJsonText(argumentsDetail.text)
        : JSON.stringify(interactionArguments(interactionByToolCallId[id]?.prompt) ?? target.part.functionCall.args ?? {});
      const execution = executionsByCall.get(id);
      const outcome = outcomesByCall.get(id);
      const parsedResult = resultDetail?.status === 'ready' ? parseJson(resultDetail.text) : undefined;
      if (parsedResult !== undefined) toolResultByCallId[id] = toolResultDetail(parsedResult);
      const events = eventsByCall.get(id) ?? [];
      const status = toolStatus(raw, execution, outcome);
      const progress = toolProgress(raw, events);
      const error = toolError(raw, outcome, parsedResult, events);
      toolCalls.push({
        id,
        messageId: target.messageId,
        name,
        ...(text(target.part.id) ? { functionCallId: text(target.part.id) } : {}),
        args,
        status,
        ...(toolSummary(policy) ? { summary: toolSummary(policy) } : {}),
        ...(progress !== undefined ? { progress } : {}),
        ...(error ? { error } : {}),
        schedulingOrdinal: sourceLink ? integer(sourceLink.provider_ordinal) : target.ordinal,
        schedulingMode: toolSchedulingMode(policy),
        ...(toolSchedulingReason(policy) ? { schedulingReason: toolSchedulingReason(policy) } : {}),
        ...(toolDisplayPolicy(policy) ? { display: toolDisplayPolicy(policy) } : {}),
        createdAt: timestamp(raw.created_at),
        updatedAt: timestamp(raw.updated_at),
        ...(durationMs(execution) !== undefined ? { durationMs: durationMs(execution) } : {})
      });
      ensureProjectedFunctionCall(
        parsedMessages,
        target,
        id,
        name,
        args
      );
    }
  }

  const fileChanges = projectReliableFileChanges(input.records, input.details);
  const terminationByMessageId = projectTurnTerminations(input.records, parsedMessages, conversationId);
  const toolCallsByMessageId = objectGroups(toolCalls, (call) => call.messageId);
  const toolCallEventsByCallId = objectGroups(toolCallEvents, (event) => event.toolCallId);
  const toolEventIdsByCallId = Object.fromEntries(Object.entries(toolCallEventsByCallId)
    .map(([toolCallId, events]) => [toolCallId, events.map((event) => event.id)]));
  return {
    messages: parsedMessages.map((entry) => entry.message),
    toolCalls,
    toolCallsByMessageId,
    toolCallEvents,
    toolCallEventsByCallId,
    toolEventIdsByCallId,
    turnIdByMessageId,
    messageRevisionIdByMessageId,
    terminationByMessageId,
    toolResultByCallId,
    interactionByToolCallId,
    interactionPromptIdByToolCallId: interactionProjection.promptIdByToolCallId,
    fileDiffByToolCallId: fileChanges.diffByToolCallId,
    fileDiffMemberIdsByToolCallId: fileChanges.memberIdsByToolCallId,
    fileChangeSetIdByToolCallId: fileChanges.changeSetIdByToolCallId,
    loadingMessageRevisionIds,
    missingToolArgumentIds,
    missingToolResultIds,
    missingToolEventIds: toolEventProjection.missingIds,
    missingInteractionPromptIds: interactionProjection.missingPromptIds,
    missingFileDiffMemberIds: fileChanges.missingMemberIds
  };
}

export function reliableActiveConversationId(projections: Record<string, unknown>): string {
  const window = record(projections.activeConversationWindow);
  return text(window?.conversationId) ?? '';
}

function projectReliableInteractions(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): {
  byToolCallId: Record<string, ReliableInteractionProjection>;
  promptIdByToolCallId: Record<string, string>;
  missingPromptIds: string[];
} {
  const requests = new Map(values(records.InteractionRequest)
    .map((request) => [text(request.id), request] as const)
    .filter((entry): entry is readonly [string, ReliableClientRecord] => !!entry[0]));
  const owners = new Map(values(records.InteractionOwnerLink)
    .map((link) => [text(link.request_id), text(link.turn_id)] as const)
    .filter((entry): entry is readonly [string, string] => !!entry[0] && !!entry[1]));
  const byToolCallId: Record<string, ReliableInteractionProjection> = {};
  const promptIdByToolCallId: Record<string, string> = {};
  const missingPromptIds: string[] = [];
  for (const link of values(records.InteractionToolCallLink)) {
    const requestId = text(link.request_id);
    const toolCallId = text(link.tool_call_id);
    if (!requestId || !toolCallId) continue;
    const request = requests.get(requestId);
    const kind = text(request?.request_kind);
    const status = text(request?.status);
    if (!request || !kind || !status) continue;
    const turnId = owners.get(requestId);
    const detail = details[reliableKernelDetailKey('interaction-prompt', requestId)];
    if (!detail || detail.status === 'loading') missingPromptIds.push(requestId);
    const prompt = detail?.status === 'ready' ? parseJson(detail.text) : undefined;
    promptIdByToolCallId[toolCallId] = requestId;
    byToolCallId[toolCallId] = {
      id: requestId,
      kind,
      status,
      ...(turnId ? { turnId } : {}),
      createdAt: timestamp(request.created_at),
      updatedAt: timestamp(request.updated_at),
      ...(prompt !== undefined ? { prompt } : {})
    };
  }
  return { byToolCallId, promptIdByToolCallId, missingPromptIds };
}

function projectReliableFileChanges(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): {
  diffByToolCallId: Record<string, ReliableFileDiffProjection>;
  changeSetIdByToolCallId: Record<string, string>;
  memberIdsByToolCallId: Record<string, string[]>;
  missingMemberIds: string[];
} {
  const diffByToolCallId: Record<string, ReliableFileDiffProjection> = {};
  const changeSetIdByToolCallId: Record<string, string> = {};
  const memberIdsByToolCallId: Record<string, string[]> = {};
  const missingMemberIds: string[] = [];
  const membersByChangeSet = groupBy(values(records.FileChangeSetMember), (member) => text(member.change_set_id));
  for (const changeSet of values(records.FileChangeSet)) {
    const changeSetId = text(changeSet.id);
    const toolCallId = text(changeSet.tool_call_id);
    if (!changeSetId || !toolCallId) continue;
    changeSetIdByToolCallId[toolCallId] = changeSetId;
    const files: ReliableFileDiffProjection['files'] = [];
    const members = [...(membersByChangeSet.get(changeSetId) ?? [])].sort(compareSequence('member_seq'));
    memberIdsByToolCallId[toolCallId] = members
      .map((member) => text(member.id))
      .filter((id): id is string => !!id);
    for (const member of members) {
      const memberId = text(member.id);
      if (!memberId) continue;
      const detail = details[reliableKernelDetailKey('file-change-diff', memberId)];
      if (!detail || detail.status === 'loading') {
        missingMemberIds.push(memberId);
        continue;
      }
      if (detail.status === 'error') continue;
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
  return { diffByToolCallId, changeSetIdByToolCallId, memberIdsByToolCallId, missingMemberIds };
}

function appendTransientMessages(input: {
  messages: ParsedMessage[];
  transientByRequest: Record<string, ReliableKernelTransientState>;
  conversationId: string;
  modelRequestById: Map<string, ReliableClientRecord>;
  messageIdByModelRequestId: Map<string, string>;
  toolCallFacts: ReliableClientRecord[];
  lastCommitSeq?: string;
}): void {
  const { messages, transientByRequest, conversationId } = input;
  const durableLatestRequestSeqByTurn = new Map<string, bigint>();
  for (const request of input.modelRequestById.values()) {
    const turnId = text(request.turn_id);
    const requestSeq = positiveBigInt(request.request_seq);
    if (!turnId || requestSeq === undefined) continue;
    const current = durableLatestRequestSeqByTurn.get(turnId);
    if (current === undefined || requestSeq > current) durableLatestRequestSeqByTurn.set(turnId, requestSeq);
  }
  const active = Object.values(transientByRequest)
    .filter((entry) => entry.conversationId === conversationId)
    .sort(compareTransientRequests);
  for (const transient of active) {
    const request = input.modelRequestById.get(transient.modelRequestId);
    const requestSeq = positiveBigInt(request?.request_seq) ?? positiveBigInt(transient.requestSeq);
    if (requestSeq === undefined) continue;
    // The durable source ModelRequest is the causal visibility fact. A global commit frontier is
    // only a fallback for the brief interval before that independent record arrives.
    if (!request && !transientCausalFrontierReached(transient, input.lastCommitSeq)) continue;
    if (!request && (durableLatestRequestSeqByTurn.get(transient.turnId) ?? 0n) >= requestSeq) continue;
    if (!priorToolCallsSettled(transient, request, input.toolCallFacts)) continue;

    const linkedMessageId = input.messageIdByModelRequestId.get(transient.modelRequestId);
    const durableTarget = linkedMessageId
      ? messages.find((entry) => entry.message.id === linkedMessageId)
      : undefined;
    if (durableTarget?.revisionReady) continue;

    const content = transientMessageContent(transient);
    const model = transient.modelId;
    const usageMetadata = transient.usageMetadata ?? usageMetadataFromRequest(request);
    const projectedStatus = transientProjectionStatus(transient, request);
    if (durableTarget) {
      durableTarget.message = {
        ...durableTarget.message,
        content,
        status: projectedStatus,
        ...(model ? { model } : {}),
        ...(usageMetadata ? { usageMetadata } : {}),
        requestStartedAt: (transient.providerStartedAt ?? timestamp(request?.created_at)) || transient.startedAt,
        firstChunkAt: transient.firstOutputAt ?? transient.startedAt,
        ...(transient.completedAt ? { completedAt: transient.completedAt } : {}),
        ...(transient.streamOutputDurationMs !== undefined
          ? { streamOutputDurationMs: transient.streamOutputDurationMs }
          : {})
      };
      continue;
    }

    const terminalState = text(request?.terminal_state);
    const durableCompleted = request?.status === 'terminal'
      && (terminalState === 'completed' || (!terminalState && transient.status === 'completed'));
    const historical = (durableLatestRequestSeqByTurn.get(transient.turnId) ?? requestSeq) > requestSeq;
    if (historical || (durableCompleted && linkedMessageId !== undefined)) continue;
    const anchoredSequence = transientSequenceAnchor({
      messages,
      transient,
      requestSeq,
      modelRequestById: input.modelRequestById,
      messageIdByModelRequestId: input.messageIdByModelRequestId
    });
    if (anchoredSequence === undefined) continue;
    messages.push({
      record: {
        model_request_id: transient.modelRequestId,
        request_seq: requestSeq.toString()
      },
      turnId: transient.turnId,
      revisionReady: false,
      message: {
        id: `transient:${transient.modelRequestId}`,
        conversationId,
        role: 'model',
        ...(model ? { model } : {}),
        content,
        status: projectedStatus,
        createdAt: transient.startedAt,
        requestStartedAt: (transient.providerStartedAt ?? timestamp(request?.created_at)) || transient.startedAt,
        firstChunkAt: transient.firstOutputAt ?? transient.startedAt,
        ...(transient.completedAt ? { completedAt: transient.completedAt } : {}),
        ...(transient.streamOutputDurationMs !== undefined
          ? { streamOutputDurationMs: transient.streamOutputDurationMs }
          : {}),
        ...(usageMetadata ? { usageMetadata } : {}),
        retryTarget: { kind: 'model_request', modelRequestId: transient.modelRequestId },
        seq: anchoredSequence
      }
    });
  }
}

function transientProjectionStatus(
  transient: ReliableKernelTransientState,
  request: ReliableClientRecord | undefined
): MessageRecord['status'] {
  if (request?.status === 'terminal') {
    const terminalState = text(request.terminal_state);
    return terminalState === 'completed' || (!terminalState && transient.status === 'completed')
      ? 'final'
      : 'partial';
  }
  if (transient.status === 'completed') return 'final';
  if (transient.status === 'failed' || transient.status === 'cancelled') return 'partial';
  return 'streaming';
}

function compareTransientRequests(
  left: ReliableKernelTransientState,
  right: ReliableKernelTransientState
): number {
  if (left.turnId === right.turnId) {
    const leftSeq = BigInt(left.requestSeq);
    const rightSeq = BigInt(right.requestSeq);
    if (leftSeq !== rightSeq) return leftSeq < rightSeq ? -1 : 1;
  }
  return left.startedAt - right.startedAt || left.modelRequestId.localeCompare(right.modelRequestId);
}

function transientSequenceAnchor(input: {
  messages: ParsedMessage[];
  transient: ReliableKernelTransientState;
  requestSeq: bigint;
  modelRequestById: Map<string, ReliableClientRecord>;
  messageIdByModelRequestId: Map<string, string>;
}): number | undefined {
  let lower: ParsedMessage | undefined;
  let lowerRequestSeq = -1n;
  let upper: ParsedMessage | undefined;
  let upperRequestSeq: bigint | undefined;
  for (const request of input.modelRequestById.values()) {
    if (text(request.turn_id) !== input.transient.turnId) continue;
    const candidateRequestSeq = positiveBigInt(request.request_seq);
    const requestId = text(request.id);
    const messageId = requestId ? input.messageIdByModelRequestId.get(requestId) : undefined;
    const candidate = messageId
      ? input.messages.find((entry) => entry.message.id === messageId)
      : undefined;
    if (!candidate || candidateRequestSeq === undefined) continue;
    if (candidateRequestSeq < input.requestSeq && candidateRequestSeq > lowerRequestSeq) {
      lower = candidate;
      lowerRequestSeq = candidateRequestSeq;
    } else if (
      candidateRequestSeq > input.requestSeq
      && (upperRequestSeq === undefined || candidateRequestSeq < upperRequestSeq)
    ) {
      upper = candidate;
      upperRequestSeq = candidateRequestSeq;
    }
  }
  for (const candidate of input.messages) {
    if (candidate.turnId !== input.transient.turnId) continue;
    const candidateRequestSeq = positiveBigInt(candidate.record.request_seq);
    if (candidateRequestSeq !== undefined && candidateRequestSeq < input.requestSeq) {
      if (candidateRequestSeq > lowerRequestSeq) {
        lower = candidate;
        lowerRequestSeq = candidateRequestSeq;
      }
    } else if (
      candidateRequestSeq === undefined
      && lowerRequestSeq === -1n
      && (!lower || candidate.message.seq > lower.message.seq)
    ) {
      lower = candidate;
    }
  }
  if (!lower) return undefined;
  if (!upper) {
    upper = input.messages
      .filter((candidate) => candidate.message.seq > lower!.message.seq)
      .sort(compareParsedMessages)[0];
  }
  return upper && upper.message.seq > lower.message.seq
    ? lower.message.seq + (upper.message.seq - lower.message.seq) / 2
    : lower.message.seq + 0.5;
}

function transientMessageContent(transient: ReliableKernelTransientState): MessageContent {
  const parts: MessageContent['parts'] = [];
  const meaningfulThoughtTiming = (transient.thoughtElapsedMs ?? 0) > 0
    || (transient.thoughtDurationMs ?? 0) > 0;
  if (transient.thought.trim() || meaningfulThoughtTiming) {
    parts.push({
      text: transient.thought,
      thought: true,
      ...(transient.thoughtSignature ? { thoughtSignature: transient.thoughtSignature } : {}),
      ...(transient.thoughtDurationMs !== undefined
        ? { thoughtDurationMs: transient.thoughtDurationMs }
        : transient.thoughtElapsedMs !== undefined
          ? { thoughtElapsedMs: transient.thoughtElapsedMs }
          : {})
    });
  }
  if (transient.text) parts.push({ text: transient.text });
  parts.push(...transientFunctionCallParts(transient.toolCalls));
  return { role: 'model', parts };
}

function transientCausalFrontierReached(
  transient: ReliableKernelTransientState,
  lastCommitSeq: string | undefined
): boolean {
  if (!transient.afterCommitSeq) return true;
  if (!lastCommitSeq || !/^\d+$/.test(lastCommitSeq)) return false;
  return BigInt(lastCommitSeq) >= BigInt(transient.afterCommitSeq);
}

function priorToolCallsSettled(
  transient: ReliableKernelTransientState,
  request: ReliableClientRecord | undefined,
  toolCalls: readonly ReliableClientRecord[]
): boolean {
  const requestStartedAt = timestamp(request?.created_at) || transient.startedAt;
  return !toolCalls.some((call) =>
    text(call.turn_id) === transient.turnId
    && call.status !== 'terminal'
    && timestamp(call.created_at) < requestStartedAt
  );
}

function enrichModelMessages(
  messages: ParsedMessage[],
  modelRequestsByTurn: Map<string, ReliableClientRecord[]>,
  requestMessageLinks: ReliableClientRecord[]
): void {
  const messagesById = firstBy(messages, (entry) => entry.message.id);
  const requestsById = firstBy(
    [...modelRequestsByTurn.values()].flat(),
    (request) => text(request.id)
  );
  for (const link of requestMessageLinks) {
    const messageId = text(link.message_id);
    const requestId = text(link.model_request_id);
    if (!messageId || !requestId) continue;
    const entry = messagesById.get(messageId);
    const request = requestsById.get(requestId);
    if (!entry || !request || entry.message.role !== 'model') continue;
    applyModelRequestMetadata(entry, request);
  }
}

function applyModelRequestMetadata(entry: ParsedMessage, request: ReliableClientRecord): void {
  const turnId = text(request.turn_id);
  const model = text(request.model_id);
  const usageMetadata = usageMetadataFromRequest(request);
  const streamStats = record(typeof request.stream_stats_json === 'string'
    ? parseJson(request.stream_stats_json)
    : request.stream_stats_json);
  const providerStartedAt = timestamp(streamStats?.providerStartedAt);
  const firstChunkAt = timestamp(streamStats?.firstOutputAt);
  const completedAt = timestamp(streamStats?.completedAt);
  const streamOutputDurationMs = finiteNumber(streamStats?.streamOutputDurationMs);
  // ModelRequestMessageLink is an additional authoritative live association. Keep using its Turn
  // identity even though MessageTurnLink now also arrives incrementally: commits may expose the
  // request/message fact first, and projection must remain correct at every atomic feed frontier.
  if (turnId) entry.turnId = turnId;
  entry.message = {
    ...entry.message,
    ...(model ? { model } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
    ...((providerStartedAt || timestamp(request.created_at)) > 0
      ? { requestStartedAt: providerStartedAt || timestamp(request.created_at) }
      : {}),
    ...(firstChunkAt > 0 ? { firstChunkAt } : {}),
    ...(completedAt > 0 ? { completedAt } : {}),
    ...(streamOutputDurationMs !== undefined && streamOutputDurationMs >= 0
      ? { streamOutputDurationMs }
      : {})
  };
}

function usageMetadataFromRequest(request: ReliableClientRecord | undefined): LlmUsageMetadataRecord | undefined {
  if (!request) return undefined;
  const value = typeof request.usage_json === 'string' ? parseJson(request.usage_json) : request.usage_json;
  return record(value) as LlmUsageMetadataRecord | undefined;
}

function compareParsedMessages(left: ParsedMessage, right: ParsedMessage): number {
  return left.message.seq - right.message.seq
    || left.message.createdAt - right.message.createdAt
    || left.message.id.localeCompare(right.message.id);
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

function resolveFunctionCallTarget(input: {
  raw: ReliableClientRecord;
  fallbackIndex: number;
  functionTargets: FunctionCallTarget[];
  messages: ParsedMessage[];
  sourceLink?: ReliableClientRecord;
  requestMessageIdByRequestId: Map<string, string>;
  assignedOrdinals: Map<string, number>;
}): FunctionCallTarget | undefined {
  const providerCallId = text(
    input.raw.provider_call_id
    ?? input.raw.providerCallId
    ?? input.raw.upstream_call_id
    ?? input.sourceLink?.provider_call_id
  );
  if (providerCallId) {
    const exact = input.functionTargets.find((target) => text(target.part.id) === providerCallId);
    if (exact) return exact;
  }

  const sourceRequestId = text(
    input.raw.model_request_id
    ?? input.raw.source_model_request_id
    ?? input.sourceLink?.model_request_id
  );
  const sourceMessageId = text(
    input.raw.source_message_id
    ?? input.raw.message_id
    ?? input.sourceLink?.message_id
  ) ?? (sourceRequestId ? input.requestMessageIdByRequestId.get(sourceRequestId) : undefined);
  const linkedOwnerMessageId = text(input.sourceLink?.message_id);
  if (linkedOwnerMessageId) {
    const owner = input.messages.find((entry) => entry.message.id === linkedOwnerMessageId);
    // ToolCallSourceLink is authoritative. If its owner was soft-deleted or lies outside the
    // visible Message window, the historical card must not be reattached to another live row.
    if (!owner) return undefined;
    const ownerTargets = input.functionTargets.filter((target) => target.messageId === linkedOwnerMessageId);
    const exact = providerCallId
      ? ownerTargets.find((candidate) => text(candidate.part.id) === providerCallId)
      : ownerTargets[input.fallbackIndex];
    if (exact) return exact;
    const ordinal = owner.message.content.parts.filter((part) => 'functionCall' in part).length;
    return {
      messageId: linkedOwnerMessageId,
      ordinal,
      part: {
        ...(providerCallId ? { id: providerCallId } : {}),
        functionCall: { name: text(input.raw.tool_name) ?? 'tool', args: {} }
      }
    };
  }
  if (sourceMessageId) {
    const sourceTargets = input.functionTargets.filter((target) => target.messageId === sourceMessageId);
    const target = providerCallId
      ? sourceTargets.find((candidate) => text(candidate.part.id) === providerCallId)
      : sourceTargets[input.fallbackIndex];
    if (target) return target;
  }

  const ordinalFallback = input.functionTargets[input.fallbackIndex];
  if (ordinalFallback) return ordinalFallback;

  const orderedMessages = [...input.messages]
    .filter((entry) => entry.message.role === 'model')
    .sort(compareParsedMessages);
  const callCreatedAt = timestamp(input.raw.created_at);
  const sourceMessage = sourceMessageId
    ? orderedMessages.find((entry) => entry.message.id === sourceMessageId)
    : [...orderedMessages].reverse().find((entry) => !callCreatedAt || entry.message.createdAt <= callCreatedAt)
      ?? orderedMessages[orderedMessages.length - 1];
  const messageId = sourceMessage?.message.id ?? `tool-host:${text(input.raw.turn_id) ?? text(input.raw.id) ?? 'unknown'}`;
  const existingCount = sourceMessage?.message.content.parts.filter((part) => 'functionCall' in part).length ?? 0;
  const ordinal = input.assignedOrdinals.get(messageId) ?? existingCount;
  input.assignedOrdinals.set(messageId, ordinal + 1);
  return {
    messageId,
    ordinal,
    part: {
      ...(providerCallId ? { id: providerCallId } : {}),
      functionCall: {
        name: text(input.raw.tool_name) ?? 'tool',
        args: {}
      }
    }
  };
}

function ensureProjectedFunctionCall(
  messages: ParsedMessage[],
  target: FunctionCallTarget,
  toolCallId: string,
  toolName: string,
  serializedArgs: string
): void {
  const message = messages.find((entry) => entry.message.id === target.messageId);
  if (!message) return;
  const functionParts = message.message.content.parts.filter((part): part is FunctionCallPart => 'functionCall' in part);
  if (functionParts.includes(target.part)) return;
  const providerCallId = text(target.part.id);
  if (functionParts.some((part) =>
    (providerCallId && text(part.id) === providerCallId)
    || text(part.id) === toolCallId
  )) return;
  const parsedArgs = parseJson(serializedArgs);
  message.message = {
    ...message.message,
    content: {
      ...message.message.content,
      parts: [...message.message.content.parts, {
        id: providerCallId ?? toolCallId,
        functionCall: {
          name: toolName,
          args: parsedArgs === undefined ? target.part.functionCall.args : parsedArgs
        }
      }]
    }
  };
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

function projectToolCallEvents(
  records: ReliableClientRecordBuckets,
  details: Record<string, ReliableKernelDetailState>
): { events: ToolCallEventRecord[]; missingIds: string[] } {
  const missingIds: string[] = [];
  const events = values(records.ToolCallEvent).flatMap((event) => {
    const id = text(event.id);
    const toolCallId = text(event.tool_call_id);
    const kind = toolCallEventKind(event.event_kind);
    if (!id || !toolCallId || !kind) return [];
    const detail = details[reliableKernelDetailKey('tool-event-content', id)];
    if (!detail || detail.status === 'loading') missingIds.push(id);
    const content = detail?.status === 'ready' ? record(parseJson(detail.text)) : undefined;
    const delta = textPreserveWhitespace(content?.delta);
    const payload = content?.payload ?? (kind === 'progress' ? content?.progress : undefined);
    const error = text(content?.error);
    const status = toolCallStatusValue(content?.status);
    const elapsedMs = finiteNumber(content?.elapsedMs);
    const duration = finiteNumber(content?.durationMs);
    return [{
      id,
      toolCallId,
      seq: integer(event.event_seq),
      kind,
      at: timestamp(event.created_at),
      ...(status ? { status } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(delta !== undefined ? { delta } : {}),
      ...(payload !== undefined ? { payload } : {}),
      ...(error ? { error } : {})
    }];
  }).sort((left, right) => left.at - right.at || left.seq - right.seq || left.id.localeCompare(right.id));
  return { events, missingIds };
}

function toolCallEventKind(value: unknown): ToolCallEventKind | undefined {
  return value === 'created' || value === 'queued' || value === 'started' || value === 'progress'
    || value === 'stdout' || value === 'stderr' || value === 'state' || value === 'completed'
    || value === 'failed'
    ? value
    : undefined;
}

function toolCallStatusValue(value: unknown): ToolCallStatus | undefined {
  return value === 'streaming' || value === 'queued' || value === 'awaiting_approval'
    || value === 'awaiting_user_input' || value === 'executing' || value === 'awaiting_change_apply'
    || value === 'applying_change' || value === 'change_applied' || value === 'change_rejected'
    || value === 'awaiting_result_submit' || value === 'success' || value === 'warning' || value === 'error'
    ? value
    : undefined;
}

function toolSummary(policy: ReliableClientRecord | undefined): string | undefined {
  return text(policy?.summary);
}

function toolProgress(call: ReliableClientRecord, events: readonly ToolCallEventRecord[]): unknown {
  const direct = typeof call.progress_json === 'string' ? parseJson(call.progress_json) : call.progress_json ?? call.progress;
  if (direct !== undefined && direct !== null) return direct;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === 'progress' && event.payload !== undefined) return event.payload;
  }
  return undefined;
}

function toolError(
  call: ReliableClientRecord,
  outcome: ReliableClientRecord | undefined,
  result: unknown,
  events: readonly ToolCallEventRecord[]
): string | undefined {
  const direct = text(call.error ?? call.error_message);
  if (direct) return direct;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.error) return event.error;
  }
  if (outcome?.status === 'succeeded' || outcome?.status === 'rejected') return undefined;
  const detail = record(toolResultDetail(result));
  return text(detail?.error ?? detail?.message ?? detail?.reason);
}

function toolSchedulingMode(policy: ReliableClientRecord | undefined): ToolSchedulingMode {
  const direct = policy?.scheduling_mode;
  if (direct === 'parallel' || direct === 'serial') return direct;
  return 'serial';
}

function toolSchedulingReason(policy: ReliableClientRecord | undefined): string | undefined {
  return text(policy?.scheduling_reason);
}

function toolDisplayPolicy(policy: ReliableClientRecord | undefined): ToolDisplayPolicyRecord | undefined {
  if (!policy) return undefined;
  const autoExpand = booleanInteger(policy.display_auto_expand);
  const autoOpenDiffPreview = booleanInteger(policy.display_auto_open_diff);
  return autoExpand === undefined && autoOpenDiffPreview === undefined
    ? undefined
    : {
        ...(autoExpand !== undefined ? { autoExpand } : {}),
        ...(autoOpenDiffPreview !== undefined ? { autoOpenDiffPreview } : {})
      };
}

function booleanInteger(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === 1n || value === '1') return true;
  if (value === false || value === 0 || value === 0n || value === '0') return false;
  return undefined;
}

function projectTurnTerminations(
  records: ReliableClientRecordBuckets,
  messages: ParsedMessage[],
  conversationId: string
): Record<string, RunTerminationRecord> {
  const byMessageId: Record<string, RunTerminationRecord> = {};
  const conversationTurnIds = new Set(values(records.Turn)
    .filter((turn) => text(turn.conversation_id) === conversationId)
    .map((turn) => text(turn.id))
    .filter((id): id is string => id !== undefined));
  const modelMessagesByTurn = groupBy(
    messages.filter((entry) => entry.message.role === 'model'),
    (entry) => entry.turnId
  );
  const userMessagesByTurn = groupBy(
    messages.filter((entry) => entry.message.role === 'user'),
    (entry) => entry.turnId
  );
  for (const raw of values(records.TurnTermination)) {
    const terminalStatus = text(raw.terminal_status);
    if (!terminalStatus || terminalStatus === 'completed') continue;
    const id = text(raw.id);
    const turnId = text(raw.turn_id);
    if (!id || !turnId || !conversationTurnIds.has(turnId)) continue;
    const reason = textPreserveWhitespace(raw.reason) ?? terminalStatus;
    const termination: RunTerminationRecord = {
      id,
      runId: turnId,
      kind: terminationKind(terminalStatus),
      actor: terminationActor(terminalStatus, reason),
      interruptedPhase: inferredInterruptedPhase(turnId, records),
      reasonCode: terminationReasonCode(terminalStatus, reason),
      detail: reason,
      createdAt: timestamp(raw.created_at)
    };
    const orderedModelTargets = [...(modelMessagesByTurn.get(turnId) ?? [])].sort(compareParsedMessages);
    const orderedUserTargets = [...(userMessagesByTurn.get(turnId) ?? [])].sort(compareParsedMessages);
    const target = orderedModelTargets[orderedModelTargets.length - 1]
      ?? orderedUserTargets[orderedUserTargets.length - 1];
    // The bounded Message window is the rendering authority for placement. A historical fact whose
    // exact Turn anchor is outside that window stays in history; it must never move to the latest row.
    if (!target) continue;
    if (target.message.role === 'model' && !target.revisionReady) {
      target.message = { ...target.message, status: 'partial' };
    }
    byMessageId[target.message.id] = termination;
  }
  return byMessageId;
}

function terminationKind(value: string): RunTerminationRecord['kind'] {
  if (value === 'cancelled') return 'cancelled';
  if (value === 'interrupted') return 'interrupted';
  return 'failed';
}

function terminationActor(value: string, reason: string): RunTerminationRecord['actor'] {
  const normalized = reason.toLowerCase();
  if ((value === 'cancelled' || value === 'interrupted') && normalized.includes('user')) return 'user';
  if (normalized.includes('provider') || normalized.includes('model')) return 'provider';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

function terminationReasonCode(value: string, reason: string): RunTerminationRecord['reasonCode'] {
  const normalized = reason.toLowerCase();
  if (normalized.includes('empty') && normalized.includes('model')) return 'empty_model_result';
  if (normalized.includes('extension') || normalized.includes('host restart')) return 'extension_host_restarted';
  if (value === 'cancelled') return 'user_cancelled';
  if (value === 'interrupted') return 'agent_interrupt_requested';
  if (value === 'outcome_unknown') return 'parent_outcome_unknown';
  if (normalized.includes('model') || normalized.includes('provider') || normalized.includes('round')) return 'llm_request_failed';
  return 'invocation_failed';
}

function inferredInterruptedPhase(
  turnId: string,
  records: ReliableClientRecordBuckets
): RunTerminationRecord['interruptedPhase'] {
  const interactionOwnerIds = new Set(values(records.InteractionOwnerLink)
    .filter((link) => text(link.turn_id) === turnId)
    .map((link) => text(link.request_id))
    .filter((id): id is string => id !== undefined));
  const pendingInteraction = values(records.InteractionRequest).find((request) =>
    interactionOwnerIds.has(text(request.id) ?? '') && request.status === 'pending'
  );
  if (pendingInteraction?.request_kind === 'plan_review') return 'waiting_plan_review';
  if (pendingInteraction) return 'waiting_user';
  if (values(records.ToolCall).some((call) => text(call.turn_id) === turnId && call.status !== 'terminal')) return 'waiting_tools';
  const orderedRequests = values(records.ModelRequest)
    .filter((request) => text(request.turn_id) === turnId)
    .sort(compareSequence('request_seq'));
  const latestRequest = orderedRequests[orderedRequests.length - 1];
  if (latestRequest?.status === 'streaming') return 'llm_streaming';
  if (latestRequest?.status === 'pending') return 'llm_request_pending';
  return 'delivering';
}

function toolResultDetail(value: unknown): unknown {
  const envelope = record(value);
  return envelope && 'detail' in envelope ? envelope.detail : value;
}

function interactionArguments(prompt: unknown): unknown {
  const envelope = record(prompt);
  if (!envelope) return undefined;
  if ('prompt' in envelope) return envelope.prompt;
  if ('request' in envelope) return envelope.request;
  return undefined;
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
    toolCallsByMessageId: {},
    toolCallEvents: [],
    toolCallEventsByCallId: {},
    toolEventIdsByCallId: {},
    turnIdByMessageId: {},
    messageRevisionIdByMessageId: {},
    terminationByMessageId: {},
    toolResultByCallId: {},
    interactionByToolCallId: {},
    interactionPromptIdByToolCallId: {},
    fileDiffByToolCallId: {},
    fileDiffMemberIdsByToolCallId: {},
    fileChangeSetIdByToolCallId: {},
    loadingMessageRevisionIds: [],
    missingToolArgumentIds: [],
    missingToolResultIds: [],
    missingToolEventIds: [],
    missingInteractionPromptIds: [],
    missingFileDiffMemberIds: []
  };
}

function values(bucket: Record<string, ReliableClientRecord> | undefined): ReliableClientRecord[] {
  return Object.values(bucket ?? {});
}

function firstBy<T>(
  input: T[],
  key: (record: T) => string | undefined
): Map<string, T> {
  const result = new Map<string, T>();
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

function objectGroups<T>(input: readonly T[], key: (entry: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const entry of input) (result[key(entry)] ??= []).push(entry);
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

function positiveBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return BigInt(value);
  return undefined;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

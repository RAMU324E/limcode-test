import { createEmptyClientState } from '../../../shared/clientStateSchema';
import type {
  ClientState,
  ConversationRunDetailRecord,
  ConversationRunHistoryPageRecord,
  ConversationRunHistoryPageRequest,
  ConversationRunSummaryRecord,
  MessageRecord
} from '../../../shared/protocol';

const DEFAULT_PAGE_SIZE = 20;

/** Pure on-demand Run History projection from one committed conversation aggregate. */
export function projectConversationRunHistoryPage(
  state: ClientState,
  request: ConversationRunHistoryPageRequest
): ConversationRunHistoryPageRecord {
  assertConversationState(state, request.conversationId);
  const summaries = state.agentRuns
    .map((run) => projectConversationRunDetail(state, request.conversationId, run.id)?.summary)
    .filter(isDefined)
    .sort(compareRunSummaries);
  const pageSize = requirePageSize(request.limit);
  const pageIndex = requirePageIndex(request.cursor);
  const pageCount = Math.max(1, Math.ceil(summaries.length / pageSize));
  if (pageIndex >= pageCount) {
    throw new Error(`Run History cursor is outside the committed projection: ${request.cursor}.`);
  }
  const runs = summaries.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  return {
    conversationId: request.conversationId,
    runs,
    pageInfo: {
      cursor: String(pageIndex),
      ...(pageIndex > 0 ? { previousCursor: String(pageIndex - 1) } : {}),
      ...(pageIndex + 1 < pageCount ? { nextCursor: String(pageIndex + 1) } : {}),
      pageIndex,
      pageSize,
      total: summaries.length,
      hasNext: pageIndex + 1 < pageCount,
      hasPrevious: pageIndex > 0
    }
  };
}

export function projectConversationRunDetail(
  state: ClientState,
  conversationId: string,
  runId: string
): ConversationRunDetailRecord | undefined {
  assertConversationState(state, conversationId);
  const detail = runDetailSlice(state, runId);
  const summary = conversationRunSummaryFromDetail(conversationId, detail);
  return summary ? { conversationId, runId, summary, state: detail } : undefined;
}

export function resolveConversationRunIdForMessage(
  state: ClientState,
  conversationId: string,
  messageId: string
): string | undefined {
  assertConversationState(state, conversationId);
  const summaries = state.agentRuns
    .map((run) => projectConversationRunDetail(state, conversationId, run.id)?.summary)
    .filter(isDefined)
    .sort(compareRunSummaries);
  return summaries.find((summary) => summary.sourceMessageId === messageId
    || summary.inputMessageIds?.includes(messageId) === true
    || summary.outputMessageIds?.includes(messageId) === true)?.id;
}

function runDetailSlice(state: ClientState, runId: string): ClientState {
  const detail = createEmptyClientState();
  detail.agentRuns = state.agentRuns.filter((run) => run.id === runId);
  if (detail.agentRuns.length === 0) return detail;

  detail.runTerminations = state.runTerminations.filter((termination) => termination.runId === runId);
  detail.agentRunSourceLinks = state.agentRunSourceLinks.filter((link) => link.runId === runId);
  detail.agentRunTargetLinks = state.agentRunTargetLinks.filter((link) => link.runId === runId);
  detail.messageTurnLinks = state.messageTurnLinks.filter((link) => link.turnId === runId);
  detail.toolCallRunLinks = state.toolCallRunLinks.filter((link) => link.runId === runId);
  detail.runWorkflowLinks = state.runWorkflowLinks.filter((link) => link.runId === runId);
  detail.runSystemPromptLinks = state.runSystemPromptLinks.filter((link) => link.runId === runId);
  detail.runModelProfileLinks = state.runModelProfileLinks.filter((link) => link.runId === runId);
  detail.runToolPolicyLinks = state.runToolPolicyLinks.filter((link) => link.runId === runId);
  detail.runConversationPolicyLinks = state.runConversationPolicyLinks.filter((link) => link.runId === runId);
  detail.runContextPolicyLinks = state.runContextPolicyLinks.filter((link) => link.runId === runId);
  detail.runDeliveryPolicyLinks = state.runDeliveryPolicyLinks.filter((link) => link.runId === runId);
  detail.runEditPolicyLinks = state.runEditPolicyLinks.filter((link) => link.runId === runId);
  detail.runLlmInvocationLinks = state.runLlmInvocationLinks.filter((link) => link.runId === runId);
  detail.runWorkEnvironmentLinks = state.runWorkEnvironmentLinks.filter((link) => link.runId === runId);
  detail.agentRunInputRevisions = state.agentRunInputRevisions.filter((input) => input.runId === runId);
  detail.runCompressionBlockLinks = state.runCompressionBlockLinks.filter((link) => link.runId === runId);
  detail.runPlanProposalLinks = state.runPlanProposalLinks.filter((link) => link.runId === runId);
  const planProposalIds = new Set(detail.runPlanProposalLinks.map((link) => link.planProposalId));
  detail.planProposals = state.planProposals.filter((proposal) => planProposalIds.has(proposal.id));

  const conversationPolicyIds = new Set(detail.runConversationPolicyLinks.map((link) => link.policyId));
  const contextPolicyIds = new Set(detail.runContextPolicyLinks.map((link) => link.policyId));
  const deliveryPolicyIds = new Set(detail.runDeliveryPolicyLinks.map((link) => link.policyId));
  const editPolicyIds = new Set(detail.runEditPolicyLinks.map((link) => link.policyId));
  detail.runConversationPolicies = state.runConversationPolicies.filter((policy) => conversationPolicyIds.has(policy.id));
  detail.runContextPolicies = state.runContextPolicies.filter((policy) => contextPolicyIds.has(policy.id));
  detail.runDeliveryPolicies = state.runDeliveryPolicies.filter((policy) => deliveryPolicyIds.has(policy.id));
  detail.runEditPolicies = state.runEditPolicies.filter((policy) => editPolicyIds.has(policy.id));

  detail.modelContextProjections = state.modelContextProjections.filter((projection) => projection.runId === runId);
  const projectionIds = new Set(detail.modelContextProjections.map((projection) => projection.id));
  detail.modelContextProjectionSourceLinks = state.modelContextProjectionSourceLinks.filter((link) => projectionIds.has(link.projectionId));
  detail.requestModelContextProjectionLinks = state.requestModelContextProjectionLinks.filter((link) => projectionIds.has(link.projectionId));
  detail.compressionModelContextProjectionLinks = state.compressionModelContextProjectionLinks.filter((link) => projectionIds.has(link.projectionId));

  const messageIds = new Set<string>();
  for (const link of detail.messageTurnLinks) messageIds.add(link.messageId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceMessageId) messageIds.add(link.sourceMessageId);
  const toolCallIds = new Set<string>();
  for (const link of detail.toolCallRunLinks) toolCallIds.add(link.toolCallId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceToolCallId) toolCallIds.add(link.sourceToolCallId);
  const revisionIds = new Set(detail.agentRunInputRevisions.map((input) => input.revisionId));
  for (const source of detail.modelContextProjectionSourceLinks) {
    if (source.messageId) messageIds.add(source.messageId);
    if (source.revisionId) revisionIds.add(source.revisionId);
    if (source.sourceKind === 'toolCall') toolCallIds.add(source.sourceId);
  }
  for (const revision of state.messageRevisions.filter((record) => revisionIds.has(record.id))) messageIds.add(revision.messageId);

  detail.messages = state.messages.filter((message) => messageIds.has(message.id));
  detail.messageRevisions = state.messageRevisions.filter((revision) => revisionIds.has(revision.id) || messageIds.has(revision.messageId));
  const allRevisionIds = new Set(detail.messageRevisions.map((revision) => revision.id));
  detail.messageCurrentRevisionLinks = state.messageCurrentRevisionLinks.filter((link) => messageIds.has(link.messageId) || allRevisionIds.has(link.revisionId));
  detail.toolCalls = state.toolCalls.filter((toolCall) => toolCallIds.has(toolCall.id) || messageIds.has(toolCall.messageId));
  for (const toolCall of detail.toolCalls) toolCallIds.add(toolCall.id);
  detail.toolCallEvents = state.toolCallEvents.filter((event) => toolCallIds.has(event.toolCallId));
  detail.toolCallResultLinks = state.toolCallResultLinks.filter((link) => toolCallIds.has(link.toolCallId));
  const artifactIds = new Set(detail.toolCallResultLinks.map((link) => link.artifactId));
  detail.toolResultArtifacts = state.toolResultArtifacts.filter((artifact) => artifactIds.has(artifact.id));

  const invocationIds = new Set(detail.runLlmInvocationLinks.map((link) => link.invocationId));
  detail.messageLlmInvocationLinks = state.messageLlmInvocationLinks.filter((link) => {
    const matches = messageIds.has(link.messageId) || invocationIds.has(link.invocationId);
    if (matches) invocationIds.add(link.invocationId);
    return matches;
  });
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));

  const compressionBlockIds = new Set([
    ...detail.runCompressionBlockLinks.map((link) => link.blockId),
    ...detail.compressionModelContextProjectionLinks.map((link) => link.blockId),
    ...detail.modelContextProjectionSourceLinks
      .filter((link) => link.sourceKind === 'compressionVariant')
      .map((link) => state.compressionContextVariants.find((variant) => variant.id === link.sourceId)?.blockId)
      .filter((id): id is string => !!id)
  ]);
  const compressionVariantIds = new Set([
    ...detail.runCompressionBlockLinks.map((link) => link.variantId).filter((id): id is string => !!id),
    ...detail.modelContextProjectionSourceLinks.filter((link) => link.sourceKind === 'compressionVariant').map((link) => link.sourceId)
  ]);
  detail.compressionBlocks = state.compressionBlocks.filter((block) => compressionBlockIds.has(block.id));
  detail.compressionBlockSourceLinks = state.compressionBlockSourceLinks.filter((link) => compressionBlockIds.has(link.blockId));
  detail.compressionContextVariants = state.compressionContextVariants.filter((variant) => compressionBlockIds.has(variant.blockId) || compressionVariantIds.has(variant.id));
  detail.compressionBlockLlmInvocationLinks = state.compressionBlockLlmInvocationLinks.filter((link) => compressionBlockIds.has(link.blockId) || invocationIds.has(link.invocationId));
  for (const link of detail.compressionBlockLlmInvocationLinks) invocationIds.add(link.invocationId);
  detail.llmInvocations = state.llmInvocations.filter((invocation) => invocationIds.has(invocation.id));

  const conversationIds = new Set(detail.modelContextProjections.map((projection) => projection.conversationId));
  for (const link of detail.agentRunTargetLinks) conversationIds.add(link.conversationId);
  for (const link of detail.agentRunSourceLinks) if (link.sourceConversationId) conversationIds.add(link.sourceConversationId);
  for (const input of detail.agentRunInputRevisions) conversationIds.add(input.conversationId);
  detail.conversations = state.conversations.filter((conversation) => conversationIds.has(conversation.id));
  return detail;
}

function conversationRunSummaryFromDetail(conversationId: string, detail: ClientState): ConversationRunSummaryRecord | undefined {
  const run = detail.agentRuns[0];
  if (!run) return undefined;
  const target = detail.agentRunTargetLinks.find((link) => link.conversationId === conversationId);
  const source = detail.agentRunSourceLinks.find((link) => link.sourceConversationId === conversationId) ?? detail.agentRunSourceLinks[0];
  const inputTouchesConversation = detail.agentRunInputRevisions.some((input) => input.conversationId === conversationId);
  if (!target && !source && !inputTouchesConversation) return undefined;

  const inputMessageIds = new Set<string>(detail.messageTurnLinks.filter((link) => link.role === 'input').map((link) => link.messageId));
  const outputMessageIds = new Set<string>(detail.messageTurnLinks.filter((link) => link.role !== 'input').map((link) => link.messageId));
  const toolCallIds = new Set([...detail.toolCallRunLinks.map((link) => link.toolCallId), ...detail.toolCalls.map((toolCall) => toolCall.id)]);
  const inputMessages = detail.messages.filter((message) => inputMessageIds.has(message.id)).sort(compareMessagesBySeq);
  const outputMessages = detail.messages.filter((message) => outputMessageIds.has(message.id)).sort(compareMessagesBySeq);
  return {
    id: run.id,
    conversationId,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    ...(run.retryOfRunId !== undefined ? { retryOfRunId: run.retryOfRunId } : {}),
    ...(run.attempt !== undefined ? { attempt: run.attempt } : {}),
    ...(source?.sourceKind !== undefined ? { sourceKind: source.sourceKind } : {}),
    ...(source?.sourceMessageId !== undefined ? { sourceMessageId: source.sourceMessageId } : {}),
    ...(source?.sourceToolCallId !== undefined ? { sourceToolCallId: source.sourceToolCallId } : {}),
    ...(source?.sourceRunId !== undefined ? { sourceRunId: source.sourceRunId } : {}),
    ...(target?.agentId !== undefined ? { targetAgentId: target.agentId } : {}),
    ...(target?.conversationId !== undefined ? { targetConversationId: target.conversationId } : {}),
    inputMessageCount: inputMessageIds.size,
    outputMessageCount: outputMessageIds.size,
    ...(inputMessageIds.size > 0 ? { inputMessageIds: [...inputMessageIds] } : {}),
    ...(outputMessageIds.size > 0 ? { outputMessageIds: [...outputMessageIds] } : {}),
    ...(toolCallIds.size > 0 ? { toolCallIds: [...toolCallIds] } : {}),
    toolCallCount: toolCallIds.size,
    ...(messagePreview(inputMessages[0]) ? { inputPreview: messagePreview(inputMessages[0]) } : {}),
    ...(messagePreview(outputMessages[outputMessages.length - 1]) ? { outputPreview: messagePreview(outputMessages[outputMessages.length - 1]) } : {})
  };
}

function assertConversationState(state: ClientState, conversationId: string): void {
  if (!state.conversations.some((conversation) => conversation.id === conversationId)) {
    throw new Error(`Run History projection has no Conversation ${conversationId}.`);
  }
}

function requirePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`Run History page size must be an integer from 1 through 100: ${String(value)}.`);
  }
  return value;
}

function requirePageIndex(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(cursor)) throw new Error(`Run History cursor is invalid: ${cursor}.`);
  const pageIndex = Number(cursor);
  if (!Number.isSafeInteger(pageIndex)) throw new Error(`Run History cursor exceeds the safe integer range: ${cursor}.`);
  return pageIndex;
}

function compareRunSummaries(left: ConversationRunSummaryRecord, right: ConversationRunSummaryRecord): number {
  return right.createdAt - left.createdAt || right.updatedAt - left.updatedAt || right.id.localeCompare(left.id);
}

function compareMessagesBySeq(left: MessageRecord, right: MessageRecord): number {
  return left.seq - right.seq || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function messagePreview(message: MessageRecord | undefined): string {
  if (!message) return '';
  const text = normalizeText(textPreview(message));
  if (text) return truncateText(text, 120);
  return message.role === 'user' ? '用户消息' : message.status === 'streaming' ? '响应中' : '空响应';
}

function textPreview(message: MessageRecord): string {
  for (const part of message.content.parts) {
    if ('text' in part && part.thought !== true && part.text.trim()) return part.text;
    if ('functionCall' in part) return `调用工具：${part.functionCall.name}`;
    if ('functionResponse' in part) return `工具返回：${part.functionResponse.name}`;
    if ('fileData' in part) return `文件：${part.fileData.uri}`;
    if ('inlineData' in part) return `附件：${part.inlineData.mimeType}`;
  }
  return '';
}

function normalizeText(text: string): string { return text.replace(/\s+/g, ' ').trim(); }
function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
function isDefined<T>(value: T | undefined): value is T { return value !== undefined; }

import {
  collectAttachmentCatalogFromStoredItems,
  renderAttachmentCatalog
} from './attachmentCatalog';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
  DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS,
  DEFAULT_LLM_CONTEXT_ESTIMATOR_SLACK_TOKENS,
  MAX_LLM_COMPRESSION_BODY_TARGET_TOKENS,
  type ContentPart,
  type InlineDataPart,
  type MessageContent
} from '../../shared/protocol';
import {
  estimateJsonTokens,
  estimateMessageContentsMediaTokens,
  estimateMessageContentsTokens,
  estimateTextTokens
} from './modelTokenEstimator';
import {
  decodeRuntimeDeliveryModelEnvelope,
  renderRuntimeDeliveryModelEnvelope
} from './runtimeDeliveryProjection';

/** Decimal token budgets. They intentionally are not configurable in the practical first release. */
export const ESTIMATOR_SLACK_TOKENS = DEFAULT_LLM_CONTEXT_ESTIMATOR_SLACK_TOKENS;
export const TURN_REMINDER_MAX_TOKENS = 2_000;
export const TOOL_RESULT_MAX_TOKENS = 4_000;
export const TOOL_RESULT_BATCH_MAX_TOKENS = 16_000;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS;
export const SUMMARY_TARGET_TOKENS = DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS;
export const MODEL_BODY_TARGET_TOKENS = MAX_LLM_COMPRESSION_BODY_TARGET_TOKENS;
export const TEXT_PREVIEW_HEAD_RATIO = 0.6;

export function calculateEffectiveSummaryMaxTokens(
  configuredTargetTokens: number | undefined,
  effectiveBodyTargetTokensInput: number
): number {
  const effectiveBodyTargetTokens = nonNegativeTokenCount(
    effectiveBodyTargetTokensInput,
    'effectiveBodyTargetTokens'
  );
  const configured = configuredTargetTokens === undefined
    ? SUMMARY_TARGET_TOKENS
    : positiveTokenCount(configuredTargetTokens, 'configuredTargetTokens');
  return Math.min(configured, SUMMARY_TARGET_TOKENS, effectiveBodyTargetTokens);
}

export type ContextPlanningFailureCode =
  | 'fixed_overhead_infeasible'
  | 'compression_request_too_large'
  | 'request_still_too_large'
  | 'finite_tail_too_large'
  | 'current_input_too_large'
  | 'atomic_group_too_large'
  | 'media_size_unknown';

export interface ContextPlanningFailure {
  status: 'error';
  code: ContextPlanningFailureCode;
  message: string;
  estimatedTokens: number;
  limitTokens: number;
  component?: keyof ProjectedRequestTokenBreakdown | 'compressionInput' | 'atomicGroup';
}

export interface ProjectedModelInput {
  /** Exact system instruction after provider-independent assembly. */
  systemInstruction?: string | MessageContent;
  /** Prefix applied by the selected model profile. */
  systemPromptPrefix?: string;
  /** Only schemas actually available under the frozen tool policy. */
  tools?: readonly unknown[];
  /** Durable model-visible history. Current input/addenda must not also be present below. */
  contextContents?: readonly MessageContent[];
  /** Exact current Turn request when it must be re-injected after compression. */
  currentInputContents?: readonly MessageContent[];
  /** Runtime deliveries that arrived after a native/text compression candidate was frozen. */
  runtimeDeliveryContents?: readonly MessageContent[];
  /** Rebuilt current task/process/child reminder. */
  turnReminderContents?: readonly MessageContent[];
  /** Provider envelope allowance measured by the adapter. */
  providerFramingTokens?: number;
}

export interface ProjectedRequestTokenBreakdown {
  systemTokens: number;
  toolSchemaTokens: number;
  providerFramingTokens: number;
  contextTokens: number;
  currentInputTokens: number;
  runtimeDeliveryTokens: number;
  turnReminderTokens: number;
  /** Informational subtotal already included in the relevant content components. */
  mediaTokens: number;
  fixedTokens: number;
  bodyTokens: number;
  fullTokens: number;
}

export interface FullRequestBudgetInput {
  contextWindowTokens: number;
  /** A provider's independent pure-input cap, when one exists. */
  providerInputLimitTokens?: number;
  maxOutputTokens?: number;
  compressionThresholdTokens: number;
  breakdown: ProjectedRequestTokenBreakdown;
}

export interface FullRequestBudget {
  contextWindowTokens: number;
  compressionThresholdTokens: number;
  providerInputLimitTokens?: number;
  outputReserveTokens: number;
  estimatorSlackTokens: number;
  estimatedInputLimitTokens: number;
  fixedTokens: number;
  bodyTokens: number;
  estimatedFullInputTokens: number;
  safeBodyRoomTokens: number;
  policyBodyRoomTokens: number;
  effectiveBodyTargetTokens: number;
  fixedOverPolicy: boolean;
  canSend: boolean;
  breakdown: ProjectedRequestTokenBreakdown;
}

export type FullRequestPreflightResult =
  | { status: 'ready'; budget: FullRequestBudget }
  | ContextPlanningFailure;

export function estimateProjectedModelInput(input: ProjectedModelInput): ProjectedRequestTokenBreakdown {
  const context = input.contextContents ?? [];
  const currentInput = input.currentInputContents ?? [];
  const runtimeDeliveries = input.runtimeDeliveryContents ?? [];
  const reminder = input.turnReminderContents ?? [];
  const systemTokens = typeof input.systemInstruction === 'string'
    ? estimateTextTokens(input.systemInstruction)
    : input.systemInstruction
      ? estimateMessageContentsTokens([input.systemInstruction])
      : 0;
  const prefixTokens = estimateTextTokens(input.systemPromptPrefix?.trim() ?? '');
  const toolSchemaTokens = safeSum((input.tools ?? []).map((tool) => 10 + estimateJsonTokens(tool)));
  const providerFramingTokens = nonNegativeTokenCount(input.providerFramingTokens ?? 0, 'providerFramingTokens');
  const contextTokens = estimateMessageContentsTokens(context);
  const currentInputTokens = estimateMessageContentsTokens(currentInput);
  const runtimeDeliveryTokens = estimateMessageContentsTokens(runtimeDeliveries);
  const turnReminderTokens = estimateMessageContentsTokens(reminder);
  const mediaTokens = safeSum([
    estimateMessageContentsMediaTokens(context),
    estimateMessageContentsMediaTokens(currentInput),
    estimateMessageContentsMediaTokens(runtimeDeliveries),
    estimateMessageContentsMediaTokens(reminder),
    input.systemInstruction && typeof input.systemInstruction !== 'string'
      ? estimateMessageContentsMediaTokens([input.systemInstruction])
      : 0
  ]);
  const fixedTokens = safeSum([systemTokens, prefixTokens, toolSchemaTokens, providerFramingTokens]);
  const bodyTokens = safeSum([contextTokens, currentInputTokens, runtimeDeliveryTokens, turnReminderTokens]);
  return {
    systemTokens: safeSum([systemTokens, prefixTokens]),
    toolSchemaTokens,
    providerFramingTokens,
    contextTokens,
    currentInputTokens,
    runtimeDeliveryTokens,
    turnReminderTokens,
    mediaTokens,
    fixedTokens,
    bodyTokens,
    fullTokens: safeSum([fixedTokens, bodyTokens])
  };
}

export function calculateFullRequestBudget(input: FullRequestBudgetInput): FullRequestBudget {
  const contextWindowTokens = positiveTokenCount(input.contextWindowTokens, 'contextWindowTokens');
  const compressionThresholdTokens = positiveTokenCount(
    input.compressionThresholdTokens,
    'compressionThresholdTokens'
  );
  const providerInputLimitTokens = input.providerInputLimitTokens === undefined
    ? undefined
    : positiveTokenCount(input.providerInputLimitTokens, 'providerInputLimitTokens');
  const maxOutputTokens = input.maxOutputTokens === undefined
    ? DEFAULT_OUTPUT_RESERVE_TOKENS
    : positiveTokenCount(input.maxOutputTokens, 'maxOutputTokens');
  const outputReserveTokens = Math.max(DEFAULT_OUTPUT_RESERVE_TOKENS, maxOutputTokens);
  const physicalLimit = providerInputLimitTokens ?? Math.max(0, contextWindowTokens - outputReserveTokens);
  const estimatedInputLimitTokens = Math.max(0, physicalLimit - ESTIMATOR_SLACK_TOKENS);
  const fixedTokens = nonNegativeTokenCount(input.breakdown.fixedTokens, 'breakdown.fixedTokens');
  const bodyTokens = nonNegativeTokenCount(input.breakdown.bodyTokens, 'breakdown.bodyTokens');
  const estimatedFullInputTokens = safeSum([fixedTokens, bodyTokens]);
  const safeBodyRoomTokens = Math.max(0, estimatedInputLimitTokens - fixedTokens);
  const policyBodyRoomTokens = Math.max(0, compressionThresholdTokens - fixedTokens - 1);
  const fixedOverPolicy = fixedTokens >= compressionThresholdTokens && fixedTokens <= estimatedInputLimitTokens;
  return {
    contextWindowTokens,
    compressionThresholdTokens,
    ...(providerInputLimitTokens === undefined ? {} : { providerInputLimitTokens }),
    outputReserveTokens,
    estimatorSlackTokens: ESTIMATOR_SLACK_TOKENS,
    estimatedInputLimitTokens,
    fixedTokens,
    bodyTokens,
    estimatedFullInputTokens,
    safeBodyRoomTokens,
    policyBodyRoomTokens,
    effectiveBodyTargetTokens: Math.min(
      MODEL_BODY_TARGET_TOKENS,
      safeBodyRoomTokens,
      fixedOverPolicy ? safeBodyRoomTokens : policyBodyRoomTokens
    ),
    fixedOverPolicy,
    canSend: estimatedFullInputTokens <= estimatedInputLimitTokens,
    breakdown: { ...input.breakdown, fullTokens: estimatedFullInputTokens }
  };
}

export function preflightFullRequest(
  input: FullRequestBudgetInput,
  oversizedCode: Extract<ContextPlanningFailureCode, 'request_still_too_large' | 'compression_request_too_large'>
    = 'request_still_too_large'
): FullRequestPreflightResult {
  const budget = calculateFullRequestBudget(input);
  if (budget.fixedTokens > budget.estimatedInputLimitTokens) {
    return planningFailure(
      'fixed_overhead_infeasible',
      budget.fixedTokens,
      budget.estimatedInputLimitTokens,
      'fixedTokens',
      'System instructions, tool schemas and provider framing exceed the safe input limit.'
    );
  }
  if (!budget.canSend) {
    return planningFailure(
      oversizedCode,
      budget.estimatedFullInputTokens,
      budget.estimatedInputLimitTokens,
      oversizedCode === 'compression_request_too_large' ? 'compressionInput' : undefined,
      oversizedCode === 'compression_request_too_large'
        ? 'The complete compression request exceeds the compression provider input limit.'
        : 'The rebuilt complete model request still exceeds the provider input limit.'
    );
  }
  return { status: 'ready', budget };
}

export interface AtomicContextGroup<T = MessageContent> {
  kind: 'message' | 'tool_exchange' | 'tool_results';
  items: T[];
  startIndex: number;
  endIndexExclusive: number;
  estimatedTokens: number;
  functionCallCount: number;
  functionResponseCount: number;
  complete: boolean;
}

/** Groups one assistant tool-call batch with every immediately following result message. */
export function groupAtomicMessageContents(contents: readonly MessageContent[]): AtomicContextGroup[] {
  const groups: AtomicContextGroup[] = [];
  for (let index = 0; index < contents.length;) {
    const current = contents[index];
    const callCount = countFunctionCalls(current);
    if (callCount > 0) {
      let end = index + 1;
      let responseCount = 0;
      while (end < contents.length && isToolResultOnly(contents[end])) {
        responseCount += countFunctionResponses(contents[end]);
        end += 1;
      }
      const items = contents.slice(index, end).map(cloneMessageContent);
      groups.push({
        kind: 'tool_exchange',
        items,
        startIndex: index,
        endIndexExclusive: end,
        estimatedTokens: estimateMessageContentsTokens(items),
        functionCallCount: callCount,
        functionResponseCount: responseCount,
        complete: responseCount >= callCount
      });
      index = end;
      continue;
    }
    if (isToolResultOnly(current)) {
      let end = index + 1;
      while (end < contents.length && isToolResultOnly(contents[end])) end += 1;
      const items = contents.slice(index, end).map(cloneMessageContent);
      const responseCount = items.reduce((total, item) => total + countFunctionResponses(item), 0);
      groups.push({
        kind: 'tool_results',
        items,
        startIndex: index,
        endIndexExclusive: end,
        estimatedTokens: estimateMessageContentsTokens(items),
        functionCallCount: 0,
        functionResponseCount: responseCount,
        complete: false
      });
      index = end;
      continue;
    }
    const item = cloneMessageContent(current);
    groups.push({
      kind: 'message',
      items: [item],
      startIndex: index,
      endIndexExclusive: index + 1,
      estimatedTokens: estimateMessageContentsTokens([item]),
      functionCallCount: 0,
      functionResponseCount: 0,
      complete: true
    });
    index += 1;
  }
  return groups;
}

export interface ContinuousTailPlan<T = MessageContent> {
  status: 'selected' | 'at_target';
  prefixGroups: AtomicContextGroup<T>[];
  tailGroups: AtomicContextGroup<T>[];
  prefixItems: T[];
  tailItems: T[];
  prefixTokens: number;
  tailTokens: number;
  protectedTailOverTarget: boolean;
}

/** Selects one continuous suffix. It never skips a large middle group to retain older small groups. */
export function selectContinuousAtomicTail<T>(
  groups: readonly AtomicContextGroup<T>[],
  tailBudgetTokensInput: number
): ContinuousTailPlan<T> {
  const tailBudgetTokens = nonNegativeTokenCount(tailBudgetTokensInput, 'tailBudgetTokens');
  if (groups.length === 0) {
    return {
      status: 'at_target', prefixGroups: [], tailGroups: [], prefixItems: [], tailItems: [],
      prefixTokens: 0, tailTokens: 0, protectedTailOverTarget: false
    };
  }
  let firstTailIndex = groups.length;
  let tailTokens = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const next = safeSum([tailTokens, groups[index].estimatedTokens]);
    if (next > tailBudgetTokens) break;
    firstTailIndex = index;
    tailTokens = next;
  }
  let protectedTailOverTarget = false;
  if (firstTailIndex === groups.length) {
    firstTailIndex = groups.length - 1;
    tailTokens = groups[firstTailIndex].estimatedTokens;
    protectedTailOverTarget = tailTokens > tailBudgetTokens;
  }
  const prefixGroups = groups.slice(0, firstTailIndex).map(cloneAtomicGroup);
  const tailGroups = groups.slice(firstTailIndex).map(cloneAtomicGroup);
  return {
    status: prefixGroups.length === 0 ? 'at_target' : 'selected',
    prefixGroups,
    tailGroups,
    prefixItems: prefixGroups.flatMap((group) => group.items),
    tailItems: tailGroups.flatMap((group) => group.items),
    prefixTokens: safeSum(prefixGroups.map((group) => group.estimatedTokens)),
    tailTokens,
    protectedTailOverTarget
  };
}

export function planTextCompressionTail(input: {
  contents: readonly MessageContent[];
  effectiveBodyTargetTokens: number;
  summaryMaxTokens?: number;
  turnReminderTokens?: number;
  currentInputAddendumTokens?: number;
  hardBodyRoomTokens?: number;
}): ContinuousTailPlan | ContextPlanningFailure {
  const effectiveTarget = nonNegativeTokenCount(input.effectiveBodyTargetTokens, 'effectiveBodyTargetTokens');
  const summaryMax = Math.min(
    nonNegativeTokenCount(input.summaryMaxTokens ?? SUMMARY_TARGET_TOKENS, 'summaryMaxTokens'),
    SUMMARY_TARGET_TOKENS,
    effectiveTarget
  );
  const reserved = safeSum([
    summaryMax,
    nonNegativeTokenCount(input.turnReminderTokens ?? 0, 'turnReminderTokens'),
    nonNegativeTokenCount(input.currentInputAddendumTokens ?? 0, 'currentInputAddendumTokens')
  ]);
  const tailBudget = Math.max(0, effectiveTarget - reserved);
  const groups = groupAtomicMessageContents(input.contents);
  const selected = selectContinuousAtomicTail(groups, tailBudget);
  const latest = selected.tailGroups[selected.tailGroups.length - 1];
  if (latest && input.hardBodyRoomTokens !== undefined) {
    const hardLimit = nonNegativeTokenCount(input.hardBodyRoomTokens, 'hardBodyRoomTokens');
    if (latest.estimatedTokens > hardLimit) {
      return planningFailure(
        latest.kind === 'tool_exchange' ? 'atomic_group_too_large' : 'finite_tail_too_large',
        latest.estimatedTokens,
        hardLimit,
        latest.kind === 'tool_exchange' ? 'atomicGroup' : 'contextTokens',
        'The newest indivisible context group cannot fit in the provider input room.'
      );
    }
  }
  return selected;
}

export type ToolResultPriority = 'ordinary' | 'evidence' | 'error_or_receipt';

export type ToolResultRereadTarget =
  | { kind: 'process_output'; processId?: string; outputHandle?: string }
  | { kind: 'file'; path: string; startLine?: number }
  | { kind: 'child_answer'; answerBridgeId: string };

export interface ToolResultProjectionInput {
  toolName: string;
  callId?: string;
  resultId?: string;
  status?: string;
  response: unknown;
  priority?: ToolResultPriority;
  reread?: ToolResultRereadTarget;
}

export interface ToolResultProjectionItem {
  toolName: string;
  callId?: string;
  resultId?: string;
  response: unknown;
  originalTokens: number;
  projectedTokens: number;
  allocatedTokens: number;
  truncated: boolean;
  digest: string;
}

export interface ToolResultBatchProjection {
  status: 'projected';
  items: ToolResultProjectionItem[];
  originalTokens: number;
  projectedTokens: number;
  mandatoryTokens: number;
  batchTargetTokens: number;
  mandatoryBatchOverTarget: boolean;
}

/**
 * Produces bounded model copies without mutating the source responses. Mandatory skeletons are
 * reserved first; the remaining batch budget is distributed by deterministic water filling.
 */
export function projectToolResultBatch(
  inputs: readonly ToolResultProjectionInput[],
  options: { perResultTokens?: number; batchTokens?: number } = {}
): ToolResultBatchProjection {
  const perResultTokens = positiveTokenCount(options.perResultTokens ?? TOOL_RESULT_MAX_TOKENS, 'perResultTokens');
  const batchTokens = positiveTokenCount(options.batchTokens ?? TOOL_RESULT_BATCH_MAX_TOKENS, 'batchTokens');
  const prepared = inputs.map((input, index) => prepareToolResult(input, index, perResultTokens));
  const mandatoryTokens = safeSum(prepared.map((item) => item.baseTokens));
  const remaining = Math.max(0, batchTokens - mandatoryTokens);
  const allocations = allocateToolResultPreviewTokens(prepared, remaining);
  const items = prepared.map((item, index): ToolResultProjectionItem => {
    const target = safeSum([item.baseTokens, allocations[index]]);
    const exact = item.originalTokens <= target;
    const response = exact ? cloneJsonValue(item.input.response) : boundedPreviewEnvelope(item, target);
    return {
      toolName: item.input.toolName,
      ...(item.input.callId ? { callId: item.input.callId } : {}),
      ...(item.input.resultId ? { resultId: item.input.resultId } : {}),
      response,
      originalTokens: item.originalTokens,
      projectedTokens: estimateJsonTokens(response),
      allocatedTokens: target,
      truncated: !exact,
      digest: item.digest
    };
  });
  return {
    status: 'projected',
    items,
    originalTokens: safeSum(prepared.map((item) => item.originalTokens)),
    projectedTokens: safeSum(items.map((item) => item.projectedTokens)),
    mandatoryTokens,
    batchTargetTokens: batchTokens,
    mandatoryBatchOverTarget: mandatoryTokens > batchTokens
  };
}

export interface ModelWindowProjection {
  contents: MessageContent[];
  tokenCount: number;
  mediaTokens: number;
  toolResultBatches: ToolResultBatchProjection[];
  mandatoryBatchOverTarget: boolean;
}

export interface StoredModelFacingContextItem {
  segmentKind: string;
  messageRole: string | null;
  contentType: string;
  content: string;
}

/**
 * Decodes the Reliable Context envelopes before applying the ordinary/native shared projection.
 * This is intentionally pure: callers keep the stored CAS bytes unchanged.
 */
export function projectStoredModelFacingWindow(
  items: readonly StoredModelFacingContextItem[]
): ModelWindowProjection {
  const contents = items.flatMap(storedContextItemContents);
  const catalogContent = renderAttachmentCatalog(collectAttachmentCatalogFromStoredItems(items));
  if (catalogContent) contents.push(catalogContent);
  return projectOrdinaryModelWindow(contents);
}

/** Common ordinary/native model-visible representation: same items, same result previews. */
export function projectOrdinaryModelWindow(contents: readonly MessageContent[]): ModelWindowProjection {
  const projected = contents.map(cloneMessageContent);
  const batches: ToolResultBatchProjection[] = [];
  for (const group of groupAtomicMessageContents(projected)) {
    if (group.kind !== 'tool_exchange' && group.kind !== 'tool_results') continue;
    const refs: Array<{ contentIndex: number; partIndex: number; part: Extract<ContentPart, { functionResponse: unknown }> }> = [];
    for (let contentIndex = group.startIndex; contentIndex < group.endIndexExclusive; contentIndex += 1) {
      projected[contentIndex].parts.forEach((part, partIndex) => {
        if ('functionResponse' in part) refs.push({ contentIndex, partIndex, part });
      });
    }
    if (refs.length === 0) continue;
    const batch = projectToolResultBatch(refs.map(({ part }) => ({
      toolName: part.functionResponse.name,
      ...(part.id ? { callId: part.id } : {}),
      response: part.functionResponse.response,
      priority: toolResultPriority(part.functionResponse.response)
    })));
    batches.push(batch);
    refs.forEach((ref, index) => {
      const original = ref.part;
      projected[ref.contentIndex].parts[ref.partIndex] = {
        ...original,
        functionResponse: {
          ...original.functionResponse,
          response: batch.items[index].response
        }
      };
    });
  }
  return {
    contents: projected,
    tokenCount: estimateMessageContentsTokens(projected),
    mediaTokens: estimateMessageContentsMediaTokens(projected),
    toolResultBatches: batches,
    mandatoryBatchOverTarget: batches.some((batch) => batch.mandatoryBatchOverTarget)
  };
}

function storedContextItemContents(item: StoredModelFacingContextItem): MessageContent[] {
  if (item.segmentKind === 'runtime_context') {
    const envelope = decodeRuntimeDeliveryModelEnvelope(item.content, item.contentType);
    return [{
      role: 'user',
      parts: [{ text: renderRuntimeDeliveryModelEnvelope(envelope) }]
    }];
  }
  if (item.segmentKind === 'tool_pair') {
    const pair = parseRecord(item.content);
    const call = asRecord(pair?.toolCall);
    const result = asRecord(pair?.toolModelResult);
    if (call && result && typeof call.toolName === 'string') {
      const decoded = parseNestedJson(result.result);
      const response = splitStoredToolResponseAttachments(decoded);
      return [{
        role: 'user',
        parts: [{
          ...(typeof call.providerCallId === 'string' && call.providerCallId.trim()
            ? { id: call.providerCallId }
            : {}),
          functionResponse: {
            name: call.toolName,
            response: response.value,
            ...(response.parts.length > 0 ? { parts: response.parts } : {})
          }
        }]
      }];
    }
  }
  if (item.contentType === 'application/vnd.limcode.compression-contents+json') {
    const envelope = parseRecord(item.content);
    if (envelope?.kind === 'compression_contents' && Array.isArray(envelope.contents)) {
      return envelope.contents.filter(isMessageContentValue).map(cloneMessageContent);
    }
  }
  if (item.contentType === 'application/vnd.limcode.message+json') {
    const parsed = parseJson(item.content);
    if (isMessageContentValue(parsed)) return [cloneMessageContent(parsed)];
  }
  return [{
    role: item.messageRole === 'model' ? 'model' : 'user',
    parts: [{ text: contextText(item.content, item.contentType) }]
  }];
}

function splitStoredToolResponseAttachments(value: unknown): { value: unknown; parts: InlineDataPart[] } {
  const envelope = asRecord(value);
  const detail = asRecord(envelope?.detail);
  if (!envelope || !detail || !Array.isArray(detail.parts)) return { value, parts: [] };
  const parts = detail.parts.filter(isInlineDataPartValue);
  if (parts.length === 0) return { value, parts: [] };
  const { parts: _parts, ...detailWithoutParts } = detail;
  return { value: { ...envelope, detail: detailWithoutParts }, parts };
}

function isInlineDataPartValue(value: unknown): value is InlineDataPart {
  const inlineData = asRecord(asRecord(value)?.inlineData);
  return !!inlineData && typeof inlineData.mimeType === 'string';
}

function isMessageContentValue(value: unknown): value is MessageContent {
  const record = asRecord(value);
  return !!record && (record.role === 'user' || record.role === 'model') && Array.isArray(record.parts);
}

function contextText(content: string, contentType: string): string {
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    const parsed = parseJson(content);
    if (typeof parsed === 'string') return parsed;
    const record = asRecord(parsed);
    if (typeof record?.text === 'string') return record.text;
    if (typeof record?.summary === 'string') return record.summary;
  }
  return content;
}

function parseNestedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  return asRecord(parseJson(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export interface NativeCompactWindowPlan extends ModelWindowProjection {
  status: 'ready';
  /** Always zero: native compact receives the complete canonical model-visible window. */
  retainedLocalTailCount: 0;
}

export function planNativeCompactWindow(input: {
  contents: readonly MessageContent[];
  estimatedInputLimitTokens: number;
  fixedTokens?: number;
}): NativeCompactWindowPlan | ContextPlanningFailure {
  const unresolvedMedia = firstUnresolvedMedia(input.contents);
  if (unresolvedMedia) {
    return planningFailure(
      'media_size_unknown', 0, 0, 'compressionInput',
      `Native compact media ${unresolvedMedia} has neither resolved bytes nor a frozen size.`
    );
  }
  const projected = projectOrdinaryModelWindow(input.contents);
  const fixedTokens = nonNegativeTokenCount(input.fixedTokens ?? 0, 'fixedTokens');
  const estimated = safeSum([fixedTokens, projected.tokenCount]);
  const limit = nonNegativeTokenCount(input.estimatedInputLimitTokens, 'estimatedInputLimitTokens');
  if (estimated > limit) {
    return planningFailure(
      'compression_request_too_large', estimated, limit, 'compressionInput',
      'The complete native compact model-visible window exceeds the compression provider input limit.'
    );
  }
  return { status: 'ready', ...projected, retainedLocalTailCount: 0 };
}

/** Returns a stable location for the first attachment that still cannot be estimated. */
export function firstUnresolvedMedia(contents: readonly MessageContent[]): string | undefined {
  for (let contentIndex = 0; contentIndex < contents.length; contentIndex += 1) {
    for (let partIndex = 0; partIndex < contents[contentIndex].parts.length; partIndex += 1) {
      const part = contents[contentIndex].parts[partIndex];
      if ('inlineData' in part && !inlineMediaResolved(part)) return `${contentIndex}:${partIndex}`;
      if ('functionResponse' in part) {
        const nested = part.functionResponse.parts ?? [];
        const missing = nested.findIndex((entry) => !inlineMediaResolved(entry));
        if (missing >= 0) return `${contentIndex}:${partIndex}:${missing}`;
      }
    }
  }
  return undefined;
}

/** Summary input uses readable descriptors, never historical base64 or signed function-call items. */
export function projectSummaryModelWindow(contents: readonly MessageContent[]): ModelWindowProjection {
  const ordinary = projectOrdinaryModelWindow(contents);
  const projected = ordinary.contents.map((content): MessageContent => ({
    role: content.role,
    parts: content.parts.map(summaryPart)
  }));
  return {
    contents: projected,
    tokenCount: estimateMessageContentsTokens(projected),
    mediaTokens: estimateMessageContentsMediaTokens(projected),
    toolResultBatches: ordinary.toolResultBatches,
    mandatoryBatchOverTarget: ordinary.mandatoryBatchOverTarget
  };
}

function summaryPart(part: ContentPart): ContentPart {
  if ('functionCall' in part) {
    return { text: stableJson({
      kind: 'historical_tool_call',
      ...(part.id ? { callId: part.id } : {}),
      toolName: part.functionCall.name,
      arguments: boundedValueDescriptor(part.functionCall.args, TOOL_RESULT_MAX_TOKENS)
    }) };
  }
  if ('functionResponse' in part) {
    return { text: stableJson({
      kind: 'historical_tool_result',
      ...(part.id ? { callId: part.id } : {}),
      toolName: part.functionResponse.name,
      result: boundedValueDescriptor(part.functionResponse.response, TOOL_RESULT_MAX_TOKENS),
      ...(part.functionResponse.parts?.length
        ? { media: part.functionResponse.parts.map(mediaDescriptor) }
        : {})
    }) };
  }
  if ('inlineData' in part) return { text: stableJson(mediaDescriptor(part)) };
  if ('fileData' in part) {
    return { text: stableJson({
      kind: 'historical_media',
      mimeType: part.fileData.mimeType ?? 'application/octet-stream',
      uri: part.fileData.uri
    }) };
  }
  if ('providerContext' in part) {
    const raw = asRecord(part.providerContext.rawItem);
    return { text: stableJson({
      kind: 'historical_provider_item',
      provider: part.providerContext.provider,
      format: part.providerContext.format,
      itemType: part.providerContext.itemType ?? raw?.type ?? 'unknown'
    }) };
  }
  return { ...part };
}

function mediaDescriptor(part: InlineDataPart): Record<string, unknown> {
  const value = part.inlineData;
  const rawBytes = typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0
    ? value.sizeBytes
    : typeof value.data === 'string'
      ? decodedBase64Size(value.data)
      : undefined;
  return {
    kind: 'historical_media',
    ...(value.attachmentId ? { attachmentId: value.attachmentId } : {}),
    ...(value.name ? { name: value.name } : {}),
    mimeType: value.mimeType,
    ...(rawBytes === undefined ? {} : { sizeBytes: rawBytes })
  };
}

function inlineMediaResolved(part: InlineDataPart): boolean {
  const value = part.inlineData;
  if (typeof value.data === 'string' && value.data.length > 0) return true;
  return typeof value.attachmentId === 'string'
    && value.attachmentId.trim().length > 0
    && Number.isSafeInteger(value.sizeBytes)
    && (value.sizeBytes ?? -1) >= 0
    && typeof value.sha256 === 'string'
    && /^[a-f\d]{64}$/i.test(value.sha256);
}

interface PreparedToolResult {
  input: ToolResultProjectionInput;
  serialized: string;
  digest: string;
  originalTokens: number;
  skeleton: Record<string, unknown>;
  skeletonTokens: number;
  baseTokens: number;
  demandTokens: number;
  shortExactEligible: boolean;
}

function prepareToolResult(
  rawInput: ToolResultProjectionInput,
  index: number,
  perResultTokens: number
): PreparedToolResult {
  const input: ToolResultProjectionInput = {
    ...rawInput,
    toolName: requireText(rawInput.toolName, `toolResults[${index}].toolName`)
  };
  const serialized = stableJson(input.response);
  const digest = createHash('sha256').update(serialized).digest('hex');
  const originalTokens = estimateJsonTokens(input.response);
  const skeleton = toolResultSkeleton(input, serialized.length, originalTokens, digest);
  const skeletonTokens = estimateJsonTokens(skeleton);
  const baseTokens = Math.min(originalTokens, skeletonTokens);
  const targetTokens = Math.min(originalTokens, Math.max(perResultTokens, baseTokens));
  return {
    input,
    serialized,
    digest,
    originalTokens,
    skeleton,
    skeletonTokens,
    baseTokens,
    demandTokens: Math.max(0, targetTokens - baseTokens),
    shortExactEligible: originalTokens <= perResultTokens
  };
}

function allocateToolResultPreviewTokens(
  prepared: readonly PreparedToolResult[],
  budgetInput: number
): number[] {
  let budget = nonNegativeTokenCount(budgetInput, 'tool result preview budget');
  const allocations = prepared.map(() => 0);
  const short = prepared
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.shortExactEligible && item.demandTokens > 0)
    .sort((left, right) =>
      left.item.demandTokens - right.item.demandTokens
      || toolResultPriorityWeight(right.item.input.priority ?? 'ordinary')
        - toolResultPriorityWeight(left.item.input.priority ?? 'ordinary')
      || left.index - right.index
    );
  // Results that naturally fit the per-result cap become exact before long previews consume space.
  for (const entry of short) {
    if (budget <= 0) break;
    const grant = Math.min(entry.item.demandTokens, budget);
    allocations[entry.index] = grant;
    budget -= grant;
    if (grant < entry.item.demandTokens) return allocations;
  }
  const longIndexes = prepared
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.shortExactEligible && item.demandTokens > 0);
  const longAllocations = waterFill(
    longIndexes.map(({ item }) => item.demandTokens),
    longIndexes.map(({ item }) => item.input.priority ?? 'ordinary'),
    budget
  );
  longIndexes.forEach((entry, index) => {
    allocations[entry.index] = longAllocations[index];
  });
  return allocations;
}

function toolResultSkeleton(
  input: ToolResultProjectionInput,
  originalChars: number,
  originalTokens: number,
  digest: string
): Record<string, unknown> {
  const facts = collectImportantFacts(input.response);
  return {
    kind: 'tool_result_preview',
    toolName: input.toolName,
    ...(input.callId ? { callId: input.callId } : {}),
    ...(input.resultId ? { resultId: input.resultId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...facts,
    originalChars,
    originalTokens,
    sha256: digest,
    truncated: true,
    ...(input.reread ? { rereadHint: rereadHint(input.reread) } : {}),
    preview: ''
  };
}

function collectImportantFacts(value: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const wanted = new Set([
    'status', 'error', 'exitCode', 'path', 'filePath', 'sourcePath', 'processId', 'outputHandle',
    'answerBridgeId', 'receiptId', 'submissionId', 'childExecutionId', 'count', 'total', 'changedFiles'
  ]);
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 3 || !candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      for (const entry of candidate.slice(0, 12)) visit(entry, depth + 1);
      return;
    }
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (wanted.has(key) && result[key] === undefined) result[key] = boundedScalar(nested);
      if (result[key] === undefined && depth < 3) visit(nested, depth + 1);
    }
  };
  visit(value, 0);
  return result;
}

function boundedScalar(value: unknown): unknown {
  if (typeof value === 'string') return value.length <= 1_000
    ? value
    : `${value.slice(0, 600)}\n…\n${value.slice(-400)}`;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(boundedScalar);
  return undefined;
}

function rereadHint(target: ToolResultRereadTarget): Record<string, unknown> {
  switch (target.kind) {
  case 'process_output':
    return {
      kind: target.kind,
      ...(target.processId ? { processId: target.processId } : {}),
      ...(target.outputHandle ? { outputHandle: target.outputHandle } : {})
    };
  case 'file':
    return { kind: target.kind, path: target.path, ...(target.startLine ? { startLine: target.startLine } : {}) };
  case 'child_answer':
    return { kind: target.kind, answerBridgeId: target.answerBridgeId };
  }
}

function boundedPreviewEnvelope(item: PreparedToolResult, targetTokens: number): unknown {
  if (item.skeletonTokens > targetTokens) return cloneJsonValue(item.skeleton);
  let low = 0;
  let high = item.serialized.length;
  let best: unknown = cloneJsonValue(item.skeleton);
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = { ...item.skeleton, preview: headTailPreview(item.serialized, length) };
    if (estimateJsonTokens(candidate) <= targetTokens) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

function boundedValueDescriptor(value: unknown, maxTokens: number): unknown {
  if (estimateJsonTokens(value) <= maxTokens) return cloneJsonValue(value);
  const serialized = stableJson(value);
  const digest = createHash('sha256').update(serialized).digest('hex');
  const base = {
    truncated: true,
    originalChars: serialized.length,
    originalTokens: estimateJsonTokens(value),
    sha256: digest,
    preview: ''
  };
  let low = 0;
  let high = serialized.length;
  let best: unknown = base;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = { ...base, preview: headTailPreview(serialized, length) };
    if (estimateJsonTokens(candidate) <= maxTokens) {
      best = candidate;
      low = length + 1;
    } else high = length - 1;
  }
  return best;
}

function headTailPreview(value: string, length: number): string {
  if (length <= 0) return '';
  if (value.length <= length) return value;
  const head = Math.ceil(length * TEXT_PREVIEW_HEAD_RATIO);
  const tail = Math.max(0, length - head);
  return `${value.slice(0, head)}\n…[truncated]…\n${tail > 0 ? value.slice(-tail) : ''}`;
}

function waterFill(
  demands: readonly number[],
  priorities: readonly ToolResultPriority[],
  budgetInput: number
): number[] {
  if (demands.length !== priorities.length) throw new Error('Water-fill demands and priorities must align.');
  let budget = nonNegativeTokenCount(budgetInput, 'waterFill budget');
  const allocations = demands.map(() => 0);
  let active = demands.map((demand, index) => ({
    demand,
    index,
    weight: toolResultPriorityWeight(priorities[index])
  })).filter((entry) => entry.demand > 0);
  while (active.length > 0 && budget > 0) {
    const totalWeight = active.reduce((total, entry) => total + entry.weight, 0);
    const share = Math.max(1, Math.floor(budget / totalWeight));
    let spent = 0;
    for (const entry of [...active].sort((left, right) =>
      right.weight - left.weight || left.index - right.index
    )) {
      const remaining = entry.demand - allocations[entry.index];
      const grant = Math.min(remaining, share * entry.weight, budget - spent);
      if (grant <= 0) continue;
      allocations[entry.index] += grant;
      spent += grant;
      if (spent >= budget) break;
    }
    if (spent <= 0) break;
    budget -= spent;
    active = active.filter((entry) => allocations[entry.index] < entry.demand);
  }
  return allocations;
}

function toolResultPriorityWeight(priority: ToolResultPriority): number {
  switch (priority) {
  case 'error_or_receipt': return 3;
  case 'evidence': return 2;
  case 'ordinary': return 1;
  }
}

function countFunctionCalls(content: MessageContent): number {
  return content.parts.reduce((count, part) => {
    if ('functionCall' in part) return count + 1;
    if ('providerContext' in part && asRecord(part.providerContext.rawItem)?.type === 'function_call') return count + 1;
    return count;
  }, 0);
}

function countFunctionResponses(content: MessageContent): number {
  return content.parts.reduce((count, part) => {
    if ('functionResponse' in part) return count + 1;
    const type = 'providerContext' in part ? asRecord(part.providerContext.rawItem)?.type : undefined;
    return type === 'function_call_output' ? count + 1 : count;
  }, 0);
}

function isToolResultOnly(content: MessageContent): boolean {
  return countFunctionResponses(content) > 0 && countFunctionCalls(content) === 0;
}

function toolResultPriority(value: unknown): ToolResultPriority {
  const facts = collectImportantFacts(value);
  if (
    facts.error !== undefined
    || facts.exitCode !== undefined
    || facts.changedFiles !== undefined
    || facts.status === 'failed'
    || facts.status === 'rejected'
  ) {
    return 'error_or_receipt';
  }
  return facts.processId !== undefined
    || facts.outputHandle !== undefined
    || facts.answerBridgeId !== undefined
    || facts.path !== undefined
    || facts.filePath !== undefined
    || facts.sourcePath !== undefined
      ? 'ordinary'
      : 'evidence';
}

function cloneAtomicGroup<T>(group: AtomicContextGroup<T>): AtomicContextGroup<T> {
  return { ...group, items: [...group.items] };
}

function cloneMessageContent(content: MessageContent): MessageContent {
  return cloneJsonValue(content) as MessageContent;
}

function cloneJsonValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value as object);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) result.push(cloneJsonValue(entry, seen));
    return result;
  }
  const result: Record<string, unknown> = {};
  seen.set(value as object, result);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cloneJsonValue(nested, seen);
  }
  return result;
}

function stableJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (candidate: unknown): unknown => {
    if (candidate === undefined) return null;
    if (candidate === null || typeof candidate !== 'object') {
      if (typeof candidate === 'bigint') return candidate.toString();
      return candidate;
    }
    if (seen.has(candidate as object)) return '[Circular]';
    seen.add(candidate as object);
    if (Array.isArray(candidate)) return candidate.map(normalize);
    return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]));
  };
  return JSON.stringify(normalize(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function planningFailure(
  code: ContextPlanningFailureCode,
  estimatedTokens: number,
  limitTokens: number,
  component: ContextPlanningFailure['component'],
  message: string
): ContextPlanningFailure {
  return {
    status: 'error', code, message, estimatedTokens, limitTokens,
    ...(component ? { component } : {})
  };
}

function safeSum(values: readonly number[]): number {
  return values.reduce((total, value) => {
    const next = total + nonNegativeTokenCount(value, 'token subtotal');
    if (!Number.isSafeInteger(next)) throw new RangeError('Token total exceeds the safe integer range.');
    return next;
  }, 0);
}

function positiveTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer.`);
  return value;
}

function nonNegativeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function decodedBase64Size(value: string): number {
  const normalized = value.replace(/\s/g, '');
  if (!normalized) return 0;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

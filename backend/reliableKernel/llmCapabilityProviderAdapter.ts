import type { LlmCapability } from '../capabilities/types';
import type { LlmCompactRequest, LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import { LlmEventType } from '../world/modules/llm/events';
import type { WorldEvent } from '../ecs/types';
import {
  READ_TOOL_NAME,
  type AttachmentCatalogEntry,
  type InlineDataPart,
  type LlmProviderKind,
  type MessageContent,
  type ModelOutputItemReference
} from '../../shared/protocol';
import {
  normalizeAttachmentCatalogState,
  renderAttachmentCatalogState
} from './attachmentCatalog';
import { prependSystemPromptPrefix } from '../world/modules/chat/systemPromptText';
import {
  compactReadFileToolArguments,
  readFileToolDescription,
  readFileToolParameters
} from '../world/modules/tools/definitions/readFile';
import { classifyOpenAIResponsesPreTerminalWebSocketClose } from '../capabilities/openAIResponsesWebSocketRetryPolicy';
import { frozenProviderRetryPolicy } from './frozenAuthority';
import {
  PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE,
  ProviderTransientError
} from './modelProviderControlPlane';
import type {
  FullProviderRequest,
  FullRequestProviderAdapter,
  ProviderDispatchControls,
  ProviderOutputStreamEvent
} from './modelProviderControlPlane';
import {
  createManagedMediaBodyProjectionState,
  estimateProjectedModelInput,
  projectOrdinaryModelWindow,
  projectSummaryModelWindow,
  suppressRepeatedManagedMediaBodies,
  type ProjectedRequestTokenBreakdown
} from './modelFacingContextProjection';
import {
  buildModelHandleCatalog,
  modelHandleEntries,
  modelHandleRef,
  normalizeModelHandleCatalog,
  projectToolResultForModel,
  type ModelHandleCatalog
} from './modelHandleCatalog';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import {
  decodeRuntimeDeliveryModelEnvelope,
  renderRuntimeDeliveryModelEnvelope
} from './runtimeDeliveryProjection';

interface ToolCallOutput {
  id?: string;
  /** Stable zero-based ordinal assigned on first observation when the provider omits one. */
  ordinal: number;
  name: string;
  arguments: PlainJsonValue;
  thoughtSignature?: string;
}

const CURRENT_TURN_INPUT_REINJECTION_LABEL =
  '[当前 Turn 原始用户要求/数据，不是新用户输入；以下各 part 为冻结原文。]';

/** 把现有无状态 LLM capability 适配为可靠内核 full-request Provider 边界。 */
export class LlmCapabilityFullRequestAdapter implements FullRequestProviderAdapter {
  public constructor(
    public readonly providerId: string,
    private readonly capability: LlmCapability
  ) {
    if (!providerId.trim()) throw new TypeError('providerId must be non-empty.');
  }

  public estimateFullRequestInput(request: FullProviderRequest): ProjectedRequestTokenBreakdown {
    if (request.providerId !== this.providerId) {
      throw new Error(`Provider request ${request.providerId} cannot use adapter ${this.providerId}.`);
    }
    if (isCompressionRequest(request.recipe)) {
      return estimateCompactProjection(toLlmCompactRequest(request));
    }
    const projected = toLlmStartRequest(request);
    const frozenCurrent = request.requestAddenda?.currentTurnInput;
    const currentInputCount = frozenCurrent?.reinject ? 1 : 0;
    const reminderCount = request.requestAddenda?.turnReminder ? 1 : 0;
    const contextEnd = projected.contents.length - currentInputCount - reminderCount;
    const currentEnd = contextEnd + currentInputCount;
    const projectedContext = projected.contents.slice(0, contextEnd);
    let currentInputContents = currentInputCount
      ? projected.contents.slice(contextEnd, currentEnd)
      : [];
    if (frozenCurrent && !frozenCurrent.reinject) {
      const decodedCurrent = decodeFrozenCurrentTurnInput(frozenCurrent.content, frozenCurrent.contentType);
      if (!decodedCurrent || decodedCurrent.role !== 'user') {
        throw new TypeError('Frozen current Turn input must be a user MessageContent.');
      }
      const identity = canonicalPlainJson(decodedCurrent, 'Frozen current Turn input');
      let index = -1;
      for (let candidate = projectedContext.length - 1; candidate >= 0; candidate -= 1) {
        if (canonicalPlainJson(projectedContext[candidate], 'Projected model content') !== identity) continue;
        index = candidate;
        break;
      }
      if (index < 0) throw new Error('Frozen current Turn input is absent from its projected Context window.');
      currentInputContents = [projectedContext[index]];
      projectedContext.splice(index, 1);
    }
    return estimateProjectedModelInput({
      ...(projected.systemInstruction ? { systemInstruction: projected.systemInstruction } : {}),
      tools: projected.tools,
      contextContents: projectedContext,
      ...(currentInputContents.length ? { currentInputContents } : {}),
      ...(reminderCount ? { turnReminderContents: projected.contents.slice(currentEnd) } : {}),
      providerFramingTokens: 64
    });
  }

  public sendFullRequest(request: FullProviderRequest, controls: ProviderDispatchControls): Promise<void> {
    if (request.providerId !== this.providerId) {
      return Promise.reject(new Error(`Provider request ${request.providerId} cannot use adapter ${this.providerId}.`));
    }
    if (isCompressionRequest(request.recipe)) return this.sendCompressionRequest(request, controls);
    const llmRequest = toLlmStartRequest(request);
    return new Promise<void>((resolve, reject) => {
      let sequence = 0n;
      let text = '';
      let thought = '';
      let thoughtSignature: string | undefined;
      const outputParts: MessageContent['parts'] = [];
      const completedThoughtBlockDurations: number[] = [];
      let thoughtElapsedMs: number | undefined;
      let thoughtStartedAt: number | undefined;
      let completedThoughtDurationMs = 0;
      let thoughtTimingObserved = false;
      let providerStartedAt: number | undefined;
      const toolCalls = new CapabilityToolCallAccumulator();
      let terminal = false;
      let sawReplayUnsafeProviderOutput = false;
      let tail = Promise.resolve();

      const enqueue = (event: Omit<ProviderOutputStreamEvent, 'streamSeq'>): void => {
        sequence += 1n;
        if (event.semanticProgress !== false) sawReplayUnsafeProviderOutput = true;
        const completeEvent: ProviderOutputStreamEvent = { ...event, streamSeq: sequence.toString() };
        tail = tail.then(() => controls.onEvent(completeEvent)).then(() => undefined);
      };
      const finish = (error?: unknown): void => {
        if (terminal) return;
        const terminalError = error instanceof ProviderTransientError
          && sawReplayUnsafeProviderOutput
          && !error.retryAfterOutput
            ? new Error(`${error.message}（已收到 Provider 输出，不自动重放请求。）`)
            : error;
        if (terminalError !== undefined) {
          const partialOutput = partialOutputSnapshot(outputParts);
          if (partialOutput && shouldFreezeFailedPartialOutput(request, terminalError)) {
            enqueue({
              kind: 'output_item_done',
              semanticProgress: false,
              content: normalizePlainJson({
                type: PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE,
                message: partialOutput
              }, 'LLM partial output snapshot')
            });
          }
        }
        terminal = true;
        detachAbort();
        void tail.then(
          () => terminalError === undefined ? resolve() : reject(terminalError),
          reject
        );
      };
      const emit = (event: WorldEvent): void => {
        if (terminal) return;
        try {
          const payload = asRecord(event.payload);
          switch (event.type) {
          case LlmEventType.Started:
            providerStartedAt = optionalPositiveNumber(payload?.startedAt) ?? providerStartedAt;
            return;
          case LlmEventType.Delta: {
            const delta = optionalText(payload?.text);
            const outputItem = modelOutputItemFromPayload(payload);
            text += delta;
            if (delta) {
              appendTextPart(outputParts, delta, false, undefined, outputItem);
              enqueue({
                kind: 'output_delta',
                content: {
                  type: 'text_delta',
                  text: delta,
                  ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {})
                }
              });
            }
            return;
          }
          case LlmEventType.ThoughtDelta: {
            const delta = optionalText(payload?.text);
            const outputItem = modelOutputItemFromPayload(payload);
            thought += delta;
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            const blockStartedAt = optionalPositiveNumber(payload?.thoughtStartedAt);
            const blockElapsedMs = optionalNonNegativeNumber(payload?.thoughtElapsedMs);
            if (blockStartedAt !== undefined && blockStartedAt !== thoughtStartedAt) {
              thoughtStartedAt = blockStartedAt;
              thoughtElapsedMs = blockElapsedMs;
            } else {
              thoughtStartedAt = blockStartedAt ?? thoughtStartedAt;
              thoughtElapsedMs = blockElapsedMs ?? thoughtElapsedMs;
            }
            thoughtTimingObserved = true;
            if (delta) {
              appendTextPart(outputParts, delta, true, thoughtSignature, outputItem);
              enqueue({
                kind: 'output_delta',
                content: {
                  type: 'thought_delta',
                  text: delta,
                  ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {}),
                  ...(thoughtSignature ? { thoughtSignature } : {}),
                  ...(thoughtStartedAt !== undefined ? { thoughtStartedAt } : {}),
                  thoughtCompletedDurationMs: completedThoughtDurationMs,
                  ...(thoughtElapsedMs !== undefined ? { thoughtElapsedMs } : {})
                }
              });
            }
            return;
          }
          case LlmEventType.ThoughtProgress: {
            const outputItem = modelOutputItemFromPayload(payload);
            const blockStartedAt = optionalPositiveNumber(payload?.thoughtStartedAt);
            const blockElapsedMs = optionalNonNegativeNumber(payload?.thoughtElapsedMs);
            if (blockStartedAt !== undefined && blockStartedAt !== thoughtStartedAt) {
              thoughtStartedAt = blockStartedAt;
              thoughtElapsedMs = blockElapsedMs;
            } else {
              thoughtStartedAt = blockStartedAt ?? thoughtStartedAt;
              thoughtElapsedMs = blockElapsedMs ?? thoughtElapsedMs;
            }
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            thoughtTimingObserved = true;
            if (thoughtElapsedMs !== undefined) {
              enqueue({
                kind: 'output_delta',
                semanticProgress: false,
                content: {
                  type: 'thought_progress',
                  ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {}),
                  thoughtElapsedMs,
                  ...(thoughtStartedAt !== undefined ? { thoughtStartedAt } : {}),
                  thoughtCompletedDurationMs: completedThoughtDurationMs,
                  ...(thoughtSignature ? { thoughtSignature } : {})
                }
              });
            }
            return;
          }
          case LlmEventType.ThoughtDone: {
            const outputItem = modelOutputItemFromPayload(payload);
            const blockStartedAt = optionalPositiveNumber(payload?.thoughtStartedAt) ?? thoughtStartedAt;
            const blockDurationMs = optionalNonNegativeNumber(payload?.thoughtDurationMs)
              ?? currentThoughtBlockDurationMs(blockStartedAt, thoughtElapsedMs, Date.now());
            completedThoughtDurationMs += blockDurationMs;
            completedThoughtBlockDurations.push(blockDurationMs);
            thoughtTimingObserved = true;
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            completeLastThoughtPart(outputParts, blockDurationMs, thoughtSignature);
            enqueue({
              kind: 'output_item_done',
              content: {
                type: 'thought_done',
                ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {}),
                ...(blockStartedAt !== undefined ? { thoughtStartedAt: blockStartedAt } : {}),
                thoughtBlockDurationMs: blockDurationMs,
                thoughtCompletedDurationMs: completedThoughtDurationMs,
                thoughtDurationMs: completedThoughtDurationMs,
                ...(thoughtSignature ? { thoughtSignature } : {})
              }
            });
            thoughtStartedAt = undefined;
            thoughtElapsedMs = undefined;
            return;
          }
          case LlmEventType.OutputItemDone: {
            const outputItem = modelOutputItemFromPayload(payload);
            if (outputItem) {
              applyOutputItemMetadata(outputParts, outputItem);
              enqueue({
                kind: 'output_item_done',
                content: {
                  type: 'output_item_done',
                  outputItem: plainModelOutputItem(outputItem)
                }
              });
            }
            return;
          }
          case LlmEventType.ToolCallDelta: {
            const outputItem = modelOutputItemFromPayload(payload);
            enqueue({
              kind: 'output_delta',
              content: {
                type: 'tool_call_delta',
                ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {}),
                calls: normalizePlainJson(payload?.calls ?? [], 'LLM tool call delta')
              }
            });
            return;
          }
          case LlmEventType.ToolCall: {
            const outputItem = modelOutputItemFromPayload(payload);
            const merged = toolCalls.merge(payload?.calls);
            if (merged.length > 0) {
              upsertFunctionCallParts(outputParts, merged, outputItem);
              enqueue({
                kind: 'output_item_done',
                content: {
                  type: 'tool_calls',
                  semantics: 'upsert',
                  ...(outputItem ? { outputItem: plainModelOutputItem(outputItem) } : {}),
                  calls: normalizePlainJson(merged, 'LLM completed tool call upserts')
                }
              });
            }
            return;
          }
          case LlmEventType.Done: {
            if (thoughtStartedAt !== undefined) {
              completedThoughtDurationMs += currentThoughtBlockDurationMs(
                thoughtStartedAt,
                thoughtElapsedMs,
                Date.now()
              );
              thoughtStartedAt = undefined;
              thoughtElapsedMs = undefined;
              thoughtTimingObserved = true;
            }
            const usage = payload?.usageMetadata === undefined
              ? undefined
              : normalizePlainJson(payload.usageMetadata, 'LLM usage metadata');
            const authoritativeContent = messageContentFromDonePayload(payload?.content);
            const completedContent = compactReadToolCallsInContent(applyThoughtDurations(
              authoritativeContent ?? { role: 'model', parts: outputParts },
              completedThoughtBlockDurations,
              thoughtTimingObserved ? completedThoughtDurationMs : undefined
            ));
            enqueue({
              kind: 'completed',
              content: normalizePlainJson(completedContent, 'LLM completed MessageContent'),
              ...(usage !== undefined ? { usage } : {}),
              timing: {
                ...(providerStartedAt !== undefined ? { providerStartedAt } : {}),
                ...(optionalPositiveNumber(payload?.createdAt) !== undefined
                  ? { firstOutputAt: optionalPositiveNumber(payload?.createdAt) }
                  : {}),
                ...(optionalPositiveNumber(payload?.completedAt) !== undefined
                  ? { completedAt: optionalPositiveNumber(payload?.completedAt) }
                  : {}),
                ...(optionalNonNegativeNumber(payload?.streamOutputDurationMs) !== undefined
                  ? { streamOutputDurationMs: optionalNonNegativeNumber(payload?.streamOutputDurationMs) }
                  : {})
              }
            });
            finish();
            return;
          }
          case LlmEventType.RetryScheduled:
          case LlmEventType.RetryStarted:
            // Reliable ModelRequest/Attempt owns the only retry loop. If a misconfigured capability
            // still announces an internal retry, stop it and surface the transient failure now.
            this.capability.cancelRetry(request.modelRequestId);
            if (event.type === LlmEventType.RetryStarted) this.capability.abort(request.modelRequestId);
            finish(capabilityRetryError(payload));
            return;
          case LlmEventType.Error:
            finish(capabilityProviderError(payload));
            return;
            default:
              return;
          }
        } catch (error) {
          finish(error);
        }
      };

      const onAbort = (): void => {
        this.capability.abort(request.modelRequestId);
        finish(abortError(controls.signal));
      };
      const detachAbort = (): void => controls.signal?.removeEventListener('abort', onAbort);
      if (controls.signal?.aborted) {
        finish(abortError(controls.signal));
        return;
      }
      controls.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.capability.start(llmRequest, emit);
      } catch (error) {
        finish(capabilityThrownProviderError(error));
      }
    });
  }

  private sendCompressionRequest(request: FullProviderRequest, controls: ProviderDispatchControls): Promise<void> {
    const compactRequest = toLlmCompactRequest(request);
    return new Promise<void>((resolve, reject) => {
      let terminal = false;
      let sequence = 0n;
      let tail = Promise.resolve();
      const finish = (error?: unknown): void => {
        if (terminal) return;
        terminal = true;
        detachAbort();
        void tail.then(() => error === undefined ? resolve() : reject(error), reject);
      };
      const emit = (event: WorldEvent): void => {
        if (terminal) return;
        try {
          const payload = asRecord(event.payload);
          if (event.type === LlmEventType.CompactDone) {
            const result = asRecord(payload?.result);
            if (!result) throw new TypeError('LLM compact result must be an object.');
            const contents = normalizeProviderPlainJson(result.contents, 'LLM compact result.contents');
            if (!Array.isArray(contents) || contents.length === 0) {
              throw new TypeError('LLM compact result must contain structured MessageContent[].');
            }
            // Only these fields cross into the reliable kernel. Provider SDK response objects are
            // diagnostic implementation details and may contain handles or explicit `undefined`.
            const settingsSnapshot = result.settingsSnapshot === undefined
              ? undefined
              : normalizePlainJson(result.settingsSnapshot, 'LLM compact result.settingsSnapshot');
            const methodConfig = result.methodConfig === undefined
              ? undefined
              : normalizePlainJson(result.methodConfig, 'LLM compact result.methodConfig');
            const usage = result.usageMetadata === undefined
              ? undefined
              : normalizeProviderPlainJson(result.usageMetadata, 'LLM compact result.usageMetadata');
            sequence += 1n;
            const completeEvent: ProviderOutputStreamEvent = {
              kind: 'completed',
              streamSeq: sequence.toString(),
              content: normalizePlainJson({
                type: 'compression_result',
                contents,
                ...(settingsSnapshot !== undefined ? { settingsSnapshot } : {}),
                ...(methodConfig !== undefined ? { methodConfig } : {})
              }, 'LLM compression terminal content'),
              ...(usage !== undefined ? { usage } : {})
            };
            tail = tail.then(() => controls.onEvent(completeEvent)).then(() => undefined);
            finish();
            return;
          }
          if (event.type === LlmEventType.RetryScheduled || event.type === LlmEventType.RetryStarted) {
            this.capability.cancelRetry(request.modelRequestId);
            if (event.type === LlmEventType.RetryStarted) this.capability.abort(request.modelRequestId);
            finish(capabilityRetryError(payload));
            return;
          }
          if (event.type === LlmEventType.CompactError) {
            finish(compactProviderError(payload));
          }
        } catch (error) {
          finish(error);
        }
      };
      const onAbort = (): void => {
        this.capability.abort(request.modelRequestId);
        finish(abortError(controls.signal));
      };
      const detachAbort = (): void => controls.signal?.removeEventListener('abort', onAbort);
      if (controls.signal?.aborted) {
        finish(abortError(controls.signal));
        return;
      }
      controls.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.capability.compact(compactRequest, emit);
      } catch (error) {
        finish(capabilityThrownProviderError(error));
      }
    });
  }
}

function toLlmStartRequest(request: FullProviderRequest): LlmStartRequest {
  const recipe = requireRecord(request.recipe, 'Provider recipe');
  const modelHandleCatalog = normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  const authority = requireRecord(request.authoritySnapshot, 'Provider authority snapshot');
  const toolPolicy = authorityToolPolicy(authority);
  const availableTools = normalizeToolDefinitions(recipe.tools)
    .filter((tool) => providerToolAllowed(toolPolicy, tool))
    .map((tool) => tool.schema);
  const authorityModel = requireRecord(authority.model, 'Provider authority model');
  const provider = requireProviderKind(authorityModel.provider);
  const systemPromptPrefix = typeof authorityModel.systemPromptPrefix === 'string'
    ? authorityModel.systemPromptPrefix
    : '';
  const systemParts: string[] = [];
  const systemPrompt = asRecord(authority.systemPrompt);
  if (typeof systemPrompt?.text === 'string' && systemPrompt.text.trim()) systemParts.push(systemPrompt.text.trim());
  const runtimeContext = asRecord(authority.runtimeContext);
  // 优先使用冻结时已渲染占位符并注入规则区域的 text；旧快照只有原始 template 时回退兼容。
  const runtimeContextText = typeof runtimeContext?.text === 'string' && runtimeContext.text.trim()
    ? runtimeContext.text.trim()
    : typeof runtimeContext?.template === 'string' && runtimeContext.template.trim()
      ? runtimeContext.template.trim()
      : '';
  if (runtimeContextText) systemParts.push(runtimeContextText);
  const contents: MessageContent[] = [];
  const canonicalCompressionRanges: Array<{ start: number; end: number }> = [];
  const currentTurnInput = request.requestAddenda?.currentTurnInput;
  const attachmentCatalogState = normalizeAttachmentCatalogState(
    request.attachmentCatalogState,
    'Provider request attachmentCatalogState'
  );
  const renderedAttachmentState = renderAttachmentCatalogState(
    attachmentCatalogState,
    request.context.map((item) => item.segmentId),
    (entry) => requireAttachmentHandle(modelHandleCatalog, entry.attachmentId),
    { allowCurrentTurnDelta: currentTurnInput?.reinject === true }
  );
  const appendAttachmentState = (segmentId: string): void => {
    const placement = renderedAttachmentState.afterSegment.get(segmentId);
    if (placement) contents.push(placement);
  };
  for (const item of request.context) {
    if (item.segmentKind === 'system') {
      systemParts.push(contextText(item.content, item.contentType));
      appendAttachmentState(item.segmentId);
      continue;
    }
    if (item.segmentKind === 'tool_pair') {
      contents.push(...toolPairContents(item.content, modelHandleCatalog));
      appendAttachmentState(item.segmentId);
      continue;
    }
    const compressed = decodeCompressionContents(item.content, item.contentType);
    if (compressed) {
      assertCompressionBinding(compressed, {
        providerConfigId: request.providerId,
        provider,
        modelId: request.modelId
      });
      const start = contents.length;
      contents.push(...compressed.contents);
      canonicalCompressionRanges.push({ start, end: contents.length });
      appendAttachmentState(item.segmentId);
      continue;
    }
    if (item.segmentKind === 'runtime_context') {
      contents.push(runtimeContextContent(item.content, item.contentType, modelHandleCatalog));
      appendAttachmentState(item.segmentId);
      continue;
    }
    const decoded = decodeMessageContent(item.content, item.contentType);
    if (decoded) {
      contents.push(decoded);
      appendAttachmentState(item.segmentId);
      continue;
    }
    const role = item.messageRole === 'model' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: item.content }] });
    appendAttachmentState(item.segmentId);
  }
  const tools = modelFacingToolsForHandleCatalog(
    readToolsForAttachmentCatalog(availableTools, attachmentCatalogState.catalog),
    modelHandleCatalog
  );
  if (currentTurnInput?.reinject) {
    const current = decodeFrozenCurrentTurnInput(currentTurnInput.content, currentTurnInput.contentType);
    if (!current || current.role !== 'user') {
      throw new TypeError('Frozen current Turn input must be a user MessageContent.');
    }
    const reinjected = reinjectedCurrentTurnInput(current);
    if (renderedAttachmentState.currentTurn) {
      reinjected.parts.push(...renderedAttachmentState.currentTurn.parts);
    }
    contents.push(reinjected);
  }
  const turnReminder = request.requestAddenda?.turnReminder;
  if (turnReminder) {
    contents.push({ role: 'user', parts: [{ text: turnReminder.content }] });
  }
  const volatileTailContentKinds: NonNullable<
    LlmStartRequest['openAIResponsesContinuation']
  >['volatileTailContentKinds'] = [
    ...(currentTurnInput?.reinject ? ['current_turn_input' as const] : []),
    ...(turnReminder ? ['turn_reminder' as const] : [])
  ];
  const systemText = prependSystemPromptPrefix(systemParts.filter(Boolean).join('\n\n'), systemPromptPrefix);
  const projectedContents = projectOrdinaryContentsPreservingRanges(
    contents,
    canonicalCompressionRanges,
    modelHandleCatalog
  );
  return {
    id: request.modelRequestId,
    conversationId: requireText(request.conversationId, 'Provider request conversationId'),
    contents: projectedContents,
    tools,
    model: {
      providerConfigId: request.providerId,
      provider,
      model: request.modelId
    },
    settingsSnapshot: {
      providerConfigId: request.providerId,
      provider,
      modelId: request.modelId,
      systemPromptPrefix
    },
    reliableProviderAttempt: reliableProviderAttempt(request, authorityModel),
    openAIResponsesContinuation: { volatileTailContentKinds },
    ...(systemText ? { systemInstruction: { role: 'user', parts: [{ text: systemText }] } } : {})
  };
}

function requireAttachmentHandle(catalog: ModelHandleCatalog, attachmentId: string): string {
  const ref = modelHandleRef(catalog, 'attachment', attachmentId);
  if (!ref) throw new Error(`Attachment ${attachmentId} has no frozen model handle.`);
  return ref;
}

function reinjectedCurrentTurnInput(current: MessageContent): MessageContent {
  return {
    role: 'user',
    // Keep the label as its own part. Original text and multimodal parts remain individually
    // addressable and byte-stable across retries instead of being flattened into one synthetic text.
    parts: [{ text: CURRENT_TURN_INPUT_REINJECTION_LABEL }, ...current.parts]
  };
}

function reliableProviderAttempt(
  request: FullProviderRequest,
  authorityModel: Record<string, unknown>
): NonNullable<LlmStartRequest['reliableProviderAttempt']> {
  const attemptBigInt = BigInt(request.attemptSeq);
  const attemptSeq = attemptBigInt > BigInt(Number.MAX_SAFE_INTEGER)
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Number(attemptBigInt));
  const retryPolicy = asRecord(authorityModel.retryPolicy);
  const retryEnabled = retryPolicy?.enabled !== false;
  const configuredRetries = typeof retryPolicy?.maxRetries === 'number'
    && Number.isSafeInteger(retryPolicy.maxRetries)
    && retryPolicy.maxRetries >= 0
      ? retryPolicy.maxRetries
      : 1;
  const maxAttempts = retryEnabled
    ? Math.min(10, configuredRetries + 1)
    : 1;
  return {
    attemptSeq,
    maxAttempts,
    ...(request.requestCreatedAt === undefined ? {} : { requestCreatedAt: request.requestCreatedAt })
  };
}

function isCompressionRequest(recipe: PlainJsonValue): boolean {
  return asRecord(recipe)?.kind === 'reliable-context-compression';
}

function toLlmCompactRequest(request: FullProviderRequest): LlmCompactRequest {
  const recipe = requireRecord(request.recipe, 'Compression recipe');
  if (recipe.kind !== 'reliable-context-compression') throw new TypeError('ModelRequest is not a compression request.');
  const authority = requireRecord(request.authoritySnapshot, 'Compression authority');
  const compression = requireRecord(authority.compression, 'Compression authority policy');
  const authorityMethodConfig = requireRecord(compression.config, 'Compression authority config');
  const methodKind = requireText(authorityMethodConfig.kind, 'Compression method kind') as LlmCompactRequest['methodKind'];
  const methodConfig = frozenEffectiveCompressionConfig(authorityMethodConfig, recipe, methodKind);
  const conversationId = requireText(request.conversationId, 'Provider request conversationId');
  const authorityConversationId = optionalText(authority.conversationId);
  if (authorityConversationId && authorityConversationId !== conversationId) {
    throw new Error('Compression AuthoritySnapshot belongs to another Conversation.');
  }
  const provider = requireRecord(compression.provider, 'Compression authority provider');
  const compressionProvider = {
    providerConfigId: requireText(provider.providerConfigId, 'Compression providerConfigId'),
    provider: requireProviderKind(provider.provider),
    modelId: requireText(provider.modelId, 'Compression modelId')
  };
  const context = compressionContext(request, compressionProvider, methodKind);
  const settingsSnapshot = normalizePlainJson({
    providerConfigId: compressionProvider.providerConfigId,
    provider: compressionProvider.provider,
    modelId: compressionProvider.modelId,
    compressionConfigId: requireText(methodConfig.id, 'Compression config id'),
    compressionMethodKind: methodKind,
    compressionTrigger: methodConfig.trigger,
    compressionConfigSnapshot: methodConfig
  }, 'Compression settings snapshot') as LlmCompactRequest['settingsSnapshot'];
  return {
    id: request.modelRequestId,
    blockId: optionalText(recipe.blockId) || `${request.modelRequestId}:compression`,
    conversationId,
    methodConfigId: requireText(methodConfig.id, 'Compression config id'),
    methodKind,
    methodConfigSnapshot: methodConfig as unknown as NonNullable<LlmCompactRequest['methodConfigSnapshot']>,
    settingsSnapshot,
    contents: context.contents,
    ...(methodKind === 'segmented_summary' && context.segments.length > 0
      ? { segments: context.segments }
      : {}),
    ...(methodKind !== 'openai_responses_compact' && context.priorSummaryContents.length > 0
      ? { priorSummaryContents: context.priorSummaryContents }
      : {}),
    ...(optionalText(recipe.sourceHash) ? { sourceHash: optionalText(recipe.sourceHash) } : {})
  };
}

function frozenEffectiveCompressionConfig(
  authorityConfig: { [key: string]: PlainJsonValue },
  recipe: { [key: string]: PlainJsonValue },
  methodKind: LlmCompactRequest['methodKind']
): { [key: string]: PlainJsonValue } {
  if (methodKind === 'openai_responses_compact') {
    if (recipe.effectiveSummaryMaxTokens !== undefined) {
      throw new TypeError('Provider-native Compact recipe cannot carry a text summary target.');
    }
    return authorityConfig;
  }
  const effective = recipe.effectiveSummaryMaxTokens;
  if (!Number.isSafeInteger(effective) || (effective as number) <= 0 || (effective as number) > 8_000) {
    throw new RangeError('Text compression recipe requires effectiveSummaryMaxTokens in [1, 8000].');
  }
  const summary = asRecord(authorityConfig.llmSummary) ?? {};
  return normalizePlainJson({
    ...authorityConfig,
    llmSummary: { ...summary, targetTokens: effective as number }
  }, 'Effective frozen compression config') as { [key: string]: PlainJsonValue };
}

function estimateCompactProjection(request: LlmCompactRequest): ProjectedRequestTokenBreakdown {
  const prior = request.priorSummaryContents ?? [];
  if (request.methodKind === 'segmented_summary' && request.segments?.length) {
    const candidates = request.segments.map((segment, index) => estimateProjectedModelInput({
      contextContents: index === 0 ? [...prior, ...segment] : segment,
      providerFramingTokens: 512
    }));
    return candidates.reduce((largest, candidate) =>
      candidate.fullTokens > largest.fullTokens ? candidate : largest
    );
  }
  return estimateProjectedModelInput({
    contextContents: [...prior, ...request.contents],
    providerFramingTokens: request.methodKind === 'openai_responses_compact' ? 64 : 512
  });
}

function compressionContext(
  request: FullProviderRequest,
  provider: CompressionProviderBinding,
  methodKind: LlmCompactRequest['methodKind']
): {
  contents: MessageContent[];
  segments: MessageContent[][];
  priorSummaryContents: MessageContent[];
} {
  const contents: MessageContent[] = [];
  const priorSummaryContents: MessageContent[] = [];
  const segments: MessageContent[][] = [];
  const canonicalCompressionRanges: Array<{ start: number; end: number }> = [];
  let current: MessageContent[] = [];
  const flush = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  const recipe = requireRecord(request.recipe, 'Compression recipe');
  const sourceContext = request.context.slice(
    0,
    typeof recipe.sourceSegmentCount === 'number' ? recipe.sourceSegmentCount : request.context.length
  );
  const attachmentCatalogState = normalizeAttachmentCatalogState(
    request.attachmentCatalogState,
    'Compression request attachmentCatalogState'
  );
  const seededHandleCatalog = normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  for (const entry of attachmentCatalogState.catalog) {
    requireAttachmentHandle(seededHandleCatalog, entry.attachmentId);
  }
  const modelHandleCatalog = buildModelHandleCatalog(
    sourceContext.map((item) => item.content),
    seededHandleCatalog.entries
  );
  const requestedCount = recipe.sourceSegmentCount;
  if (!Number.isSafeInteger(requestedCount) || (requestedCount as number) <= 0
    || (requestedCount as number) > request.context.length) {
    throw new RangeError('Compression recipe sourceSegmentCount is outside its frozen Context projection.');
  }
  if (methodKind === 'openai_responses_compact' && requestedCount !== request.context.length) {
    throw new Error('Provider-native compression requires the complete frozen model-visible window.');
  }
  if (request.context[requestedCount as number]?.segmentKind === 'tool_pair') {
    throw new Error('Compression recipe splits an assistant function call from its tool_pair response.');
  }
  const renderedAttachmentState = renderAttachmentCatalogState(
    attachmentCatalogState,
    sourceContext.map((item) => item.segmentId),
    (entry) => requireAttachmentHandle(modelHandleCatalog, entry.attachmentId)
  );
  for (const item of sourceContext) {
    let decoded: MessageContent[];
    if (item.segmentKind === 'tool_pair') decoded = toolPairContents(item.content, modelHandleCatalog);
    else if (item.segmentKind === 'runtime_context') {
      decoded = [runtimeContextContent(item.content, item.contentType, modelHandleCatalog)];
    }
    else {
      const structured = decodeCompressionContents(item.content, item.contentType);
      if (structured) {
        assertCompressionBinding(structured, provider);
        decoded = structured.contents;
      }
      else {
        const message = decodeMessageContent(item.content, item.contentType);
        decoded = message ? [message] : [{
          role: item.messageRole === 'model' ? 'model' : 'user',
          parts: [{ text: contextText(item.content, item.contentType) }]
        }];
      }
    }
    const attachmentStateContent = renderedAttachmentState.afterSegment.get(item.segmentId);
    if (item.segmentKind === 'compression' && contents.length === 0
      && methodKind !== 'openai_responses_compact') {
      priorSummaryContents.push(...decoded);
      if (attachmentStateContent) priorSummaryContents.push(attachmentStateContent);
      continue;
    }
    const protectedStart = contents.length;
    for (const content of decoded) {
      if (item.segmentKind !== 'runtime_context'
        && content.role === 'user'
        && hasOrdinaryUserPart(content)
        && current.length > 0) flush();
      current.push(content);
      contents.push(content);
    }
    if (item.segmentKind === 'compression' && methodKind === 'openai_responses_compact') {
      canonicalCompressionRanges.push({ start: protectedStart, end: contents.length });
    }
    if (attachmentStateContent) {
      current.push(attachmentStateContent);
      contents.push(attachmentStateContent);
    }
  }
  flush();
  if (methodKind === 'openai_responses_compact') {
    return {
      contents: projectOrdinaryContentsPreservingRanges(
        contents,
        canonicalCompressionRanges,
        modelHandleCatalog
      ),
      segments: [],
      priorSummaryContents: []
    };
  }
  return {
    contents: projectSummaryModelWindow(contents).contents,
    segments: segments.map((segment) => projectSummaryModelWindow(segment).contents),
    priorSummaryContents
  };
}

function hasOrdinaryUserPart(content: MessageContent): boolean {
  return content.parts.some((part) => 'text' in part && typeof part.text === 'string' && !('functionResponse' in part));
}

function runtimeContextContent(
  content: string,
  contentType: string,
  modelHandleCatalog: ModelHandleCatalog = { entries: [] }
): MessageContent {
  const envelope = decodeRuntimeDeliveryModelEnvelope(content, contentType);
  return {
    // The shared Provider contract currently has only user/model roles. The explicit envelope is
    // therefore the authority boundary: runtime data never masquerades as naked user prose, and
    // its body cannot elevate a fake "System" heading into an instruction.
    role: 'user',
    parts: [{ text: renderRuntimeDeliveryModelEnvelope(envelope, undefined, modelHandleCatalog) }]
  };
}

function projectOrdinaryContentsPreservingRanges(
  contents: readonly MessageContent[],
  canonicalRanges: readonly { start: number; end: number }[],
  modelHandleCatalog: ModelHandleCatalog
): MessageContent[] {
  if (canonicalRanges.length === 0) {
    return projectOrdinaryModelWindow(contents, modelHandleCatalog).contents;
  }
  const mediaState = createManagedMediaBodyProjectionState();
  const projected: MessageContent[] = [];
  let cursor = 0;
  for (const range of canonicalRanges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < cursor || range.end < range.start || range.end > contents.length) {
      throw new RangeError('Canonical compression ranges are invalid or overlapping.');
    }
    projected.push(...projectOrdinaryModelWindow(
      contents.slice(cursor, range.start),
      modelHandleCatalog,
      mediaState
    ).contents);
    // Provider-native Compact output is the canonical next window. Only repeat-media suppression is
    // applied here; tool results and provider-native items are not projected a second time.
    projected.push(...suppressRepeatedManagedMediaBodies(
      contents.slice(range.start, range.end),
      modelHandleCatalog,
      mediaState
    ));
    cursor = range.end;
  }
  projected.push(...projectOrdinaryModelWindow(
    contents.slice(cursor),
    modelHandleCatalog,
    mediaState
  ).contents);
  return projected;
}

interface CompressionProviderBinding {
  providerConfigId: string;
  provider: LlmProviderKind;
  modelId: string;
}

interface DecodedCompressionContents {
  contents: MessageContent[];
  nativeBinding?: CompressionProviderBinding;
}

function decodeCompressionContents(content: string, contentType: string): DecodedCompressionContents | undefined {
  if (contentType !== 'application/vnd.limcode.compression-contents+json') return undefined;
  const envelope = requireRecord(
    normalizePlainJson(JSON.parse(content), 'Structured compression contents'),
    'Structured compression contents'
  );
  if (envelope.kind !== 'compression_contents' || envelope.version !== 1 || !Array.isArray(envelope.contents)) {
    throw new TypeError('Structured compression contents codec is invalid.');
  }
  const contents = envelope.contents.map((value, index) => {
    const item = requireRecord(value, `Structured compression content ${index}`);
    if ((item.role !== 'user' && item.role !== 'model') || !Array.isArray(item.parts)) {
      throw new TypeError(`Structured compression content ${index} is invalid.`);
    }
    return item as unknown as MessageContent;
  });
  const rawBinding = asRecord(envelope.nativeBinding);
  const nativeBinding = rawBinding ? {
    providerConfigId: requireText(rawBinding.providerConfigId, 'Compression native providerConfigId'),
    provider: requireProviderKind(normalizePlainJson(rawBinding.provider, 'Compression native provider')),
    modelId: requireText(rawBinding.modelId, 'Compression native modelId')
  } : undefined;
  return { contents, ...(nativeBinding ? { nativeBinding } : {}) };
}

function assertCompressionBinding(
  compressed: DecodedCompressionContents,
  active: CompressionProviderBinding
): void {
  const frozen = compressed.nativeBinding;
  if (!frozen) return;
  if (frozen.providerConfigId !== active.providerConfigId
    || frozen.provider !== active.provider
    || frozen.modelId !== active.modelId) {
    throw new Error(
      'Provider-native compression state is incompatible with the active provider/model '
      + `(frozen=${frozen.providerConfigId}/${frozen.provider}/${frozen.modelId}, `
      + `active=${active.providerConfigId}/${active.provider}/${active.modelId}).`
    );
  }
}

function decodeMessageContent(content: string, contentType: string): MessageContent | undefined {
  if (contentType !== 'application/vnd.limcode.message+json') return undefined;
  const parsed = JSON.parse(content) as unknown;
  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.parts)) throw new TypeError('Frozen MessageContent is invalid.');
  const role = record.role === 'model' ? 'model' : 'user';
  return { role, parts: record.parts as MessageContent['parts'] };
}

/** Plain-text Turn input is a current storage format, not a legacy envelope. Project it through
 * the same user MessageContent shape used by ordinary Context messages before identity/reinjection. */
function decodeFrozenCurrentTurnInput(content: string, contentType: string): MessageContent | undefined {
  const decoded = decodeMessageContent(content, contentType);
  if (decoded) return decoded;
  if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'text/plain') return undefined;
  return { role: 'user', parts: [{ text: content }] };
}

function toolPairContents(
  content: string,
  modelHandleCatalog: ModelHandleCatalog = { entries: [] }
): MessageContent[] {
  const pair = requireRecord(normalizePlainJson(JSON.parse(content), 'Context tool pair'), 'Context tool pair');
  const call = requireRecord(pair.toolCall, 'Context tool pair.toolCall');
  const result = requireRecord(pair.toolModelResult, 'Context tool pair.toolModelResult');
  requireText(call.id, 'Context tool pair.toolCall.id');
  const providerCallId = optionalText(call.providerCallId);
  const name = requireText(call.toolName, 'Context tool pair.toolCall.toolName');
  const decoded = parseNestedJson(result.result, 'Context tool result');
  const response = splitToolResponseAttachments(decoded);
  return [{
    role: 'user',
    parts: [{
      ...(providerCallId ? { id: providerCallId } : {}),
      functionResponse: {
        name,
        response: projectToolResultForModel(name, response.value, modelHandleCatalog),
        ...(response.parts.length > 0 ? { parts: response.parts } : {})
      }
    }]
  }];
}

function splitToolResponseAttachments(value: unknown): { value: unknown; parts: InlineDataPart[] } {
  const envelope = asRecord(value);
  const detail = asRecord(envelope?.detail);
  if (!envelope || !detail || !Array.isArray(detail.parts)) return { value, parts: [] };
  const parts = detail.parts.filter(isInlineDataPartValue);
  if (parts.length === 0) return { value, parts: [] };
  const { parts: _parts, ...detailWithoutParts } = detail;
  return {
    value: { ...envelope, detail: detailWithoutParts },
    parts
  };
}

function isInlineDataPartValue(value: unknown): value is InlineDataPart {
  const record = asRecord(value);
  const inlineData = asRecord(record?.inlineData);
  return !!inlineData
    && typeof inlineData.mimeType === 'string'
    && (
      typeof inlineData.attachmentId === 'string'
      || typeof inlineData.data === 'string'
      || typeof inlineData.sourcePath === 'string'
    );
}

function contextText(content: string, contentType: string): string {
  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    try {
      const parsed = JSON.parse(content) as unknown;
      if (typeof parsed === 'string') return parsed;
      const record = asRecord(parsed);
      if (typeof record?.text === 'string') return record.text;
      if (typeof record?.summary === 'string') return record.summary;
    } catch {
      return content;
    }
  }
  return content;
}

function authorityToolPolicy(authority: { [key: string]: PlainJsonValue }): {
  allowedTools: Set<string>;
  preset: string;
  sourceConfigs: { [key: string]: PlainJsonValue };
} {
  const policy = requireRecord(authority.toolPolicy, 'Provider authority toolPolicy');
  if (!Array.isArray(policy.allowedTools)) throw new TypeError('Provider authority toolPolicy.allowedTools must be an array.');
  return {
    allowedTools: new Set(policy.allowedTools.map((name, index) => requireText(name, `allowedTools[${index}]`))),
    preset: typeof policy.preset === 'string' ? policy.preset : 'custom',
    sourceConfigs: policy.sourceConfigs === undefined
      ? {}
      : requireRecord(policy.sourceConfigs, 'Provider authority toolPolicy.sourceConfigs')
  };
}

interface NormalizedProviderToolDefinition {
  schema: ToolSchema;
  source?: { [key: string]: PlainJsonValue };
}

function normalizeToolDefinitions(value: PlainJsonValue | undefined): NormalizedProviderToolDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Provider recipe.tools must be an array.');
  return value.map((entry, index) => {
    const record = requireRecord(entry, `Provider recipe.tools[${index}]`);
    return {
      schema: {
        name: requireText(record.name, `Provider recipe.tools[${index}].name`),
        description: optionalText(record.description),
        parameters: record.parameters ?? {}
      },
      ...(record.source === undefined
        ? {}
        : { source: requireRecord(record.source, `Provider recipe.tools[${index}].source`) })
    };
  });
}

function readToolsForAttachmentCatalog(
  tools: ToolSchema[],
  attachmentCatalog: readonly AttachmentCatalogEntry[]
): ToolSchema[] {
  const includeManagedAttachments = attachmentCatalog.length > 0;
  const includeManagedPageRanges = attachmentCatalog.some((entry) =>
    entry.mimeType === 'text/plain' || entry.mimeType === 'application/pdf');
  return tools.map((tool) => tool.name === READ_TOOL_NAME
    ? {
        ...tool,
        description: readFileToolDescription(includeManagedAttachments, includeManagedPageRanges),
        parameters: readFileToolParameters(includeManagedAttachments, includeManagedPageRanges)
      }
    : tool);
}

function modelFacingToolsForHandleCatalog(
  tools: ToolSchema[],
  catalog: ModelHandleCatalog
): ToolSchema[] {
  return tools.map((tool) => {
    const parameters = cloneSchemaRecord(tool.parameters);
    if (tool.name === READ_TOOL_NAME) {
      renameSchemaProperty(parameters, 'attachmentId', 'attachmentRef');
    } else if (tool.name === 'bash' || tool.name === 'shell') {
      renameSchemaProperty(parameters, 'processId', 'processRef');
      renameSchemaProperty(parameters, 'outputHandle', 'cursor');
    } else if (tool.name === 'run_agent' || tool.name === 'read_agent_answer' || tool.name === 'submit_agent_answer') {
      renameSchemaProperty(parameters, 'answerBridgeId', 'childRef');
      if (tool.name === 'run_agent') {
        const properties = asRecord(parameters.properties);
        const agent = asRecord(properties?.agent);
        const agentProperties = asRecord(agent?.properties);
        if (agentProperties) delete agentProperties.id;
      }
    } else if (tool.name === 'switch_work_environment') {
      renameSchemaProperty(parameters, 'workEnvironmentId', 'workEnvironmentRef');
    }
    return {
      ...tool,
      description: modelFacingHandleText(tool.description ?? '', catalog),
      parameters: replaceSchemaHandleText(parameters, catalog)
    };
  });
}

function renameSchemaProperty(parameters: Record<string, unknown>, from: string, to: string): void {
  const properties = asRecord(parameters.properties);
  if (properties && Object.prototype.hasOwnProperty.call(properties, from)) {
    properties[to] = properties[from];
    delete properties[from];
  }
  if (Array.isArray(parameters.required)) {
    parameters.required = parameters.required.map((key) => key === from ? to : key);
  }
}

function replaceSchemaHandleText(value: unknown, catalog: ModelHandleCatalog): unknown {
  if (typeof value === 'string') return modelFacingHandleText(value, catalog);
  if (Array.isArray(value)) return value.map((entry) => replaceSchemaHandleText(entry, catalog));
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    replaceSchemaHandleText(entry, catalog)
  ]));
}

function modelFacingHandleText(value: string, catalog: ModelHandleCatalog): string {
  let text = value;
  for (const [from, to] of [
    ['attachmentId', 'attachmentRef'],
    ['processId', 'processRef'],
    ['outputHandle', 'cursor'],
    ['answerBridgeId', 'childRef'],
    ['workEnvironmentId', 'workEnvironmentRef']
  ] as const) text = text.split(from).join(to);
  for (const entry of modelHandleEntries(catalog)) text = text.split(entry.target).join(entry.ref);
  return text;
}

function cloneSchemaRecord(value: unknown): Record<string, unknown> {
  const cloned = value === undefined ? {} : JSON.parse(JSON.stringify(value)) as unknown;
  return asRecord(cloned) ?? {};
}

function providerToolAllowed(
  policy: ReturnType<typeof authorityToolPolicy>,
  tool: NormalizedProviderToolDefinition
): boolean {
  const explicitlyAllowed = policy.allowedTools.has(tool.schema.name);
  if (tool.source?.kind !== 'mcp' || typeof tool.source.sourceId !== 'string' || !tool.source.sourceId.trim()) {
    return explicitlyAllowed;
  }
  const config = policy.sourceConfigs[tool.source.sourceId];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return explicitlyAllowed;
  if (config.enabled !== true) return false;
  const disabled = Array.isArray(config.disabledTools)
    ? config.disabledTools.filter((name): name is string => typeof name === 'string')
    : [];
  return !disabled.includes(tool.schema.name);
}

function shouldFreezeFailedPartialOutput(request: FullProviderRequest, error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return false;
  if (!(error instanceof ProviderTransientError) || !error.retryAfterOutput) return true;
  if (!/^[1-9]\d*$/.test(request.attemptSeq)) {
    throw new TypeError('Provider request attemptSeq must be a positive decimal integer.');
  }
  const retryPolicy = frozenProviderRetryPolicy(request.authoritySnapshot);
  return BigInt(request.attemptSeq) >= BigInt(retryPolicy.maxRetries + 1);
}

function partialOutputSnapshot(parts: MessageContent['parts']): MessageContent | undefined {
  const textParts = parts
    .filter((part) => 'text' in part && part.text.trim().length > 0)
    .map((part) => {
      if (!('text' in part)) throw new TypeError('Partial output snapshot accepted a non-text part.');
      return {
        ...part,
        ...(part.outputItem ? { outputItem: { ...part.outputItem } } : {})
      };
    });
  return textParts.length > 0 ? { role: 'model', parts: textParts } : undefined;
}

function appendTextPart(
  parts: MessageContent['parts'],
  delta: string,
  thought: boolean,
  thoughtSignature?: string,
  outputItem?: ModelOutputItemReference
): void {
  const last = parts[parts.length - 1];
  const sameOutputItem = outputItem
    ? last?.outputItem?.id === outputItem.id
    : last?.outputItem === undefined;
  if (last && 'text' in last && (last.thought === true) === thought
    && sameOutputItem
    && (!thought || last.thoughtDurationMs === undefined)) {
    last.text += delta;
    if (thought && thoughtSignature) last.thoughtSignature = thoughtSignature;
    if (outputItem) last.outputItem = outputItem;
    return;
  }
  parts.push({
    text: delta,
    ...(thought ? { thought: true, ...(thoughtSignature ? { thoughtSignature } : {}) } : {}),
    ...(outputItem ? { outputItem } : {})
  });
}

function completeLastThoughtPart(
  parts: MessageContent['parts'],
  durationMs: number,
  thoughtSignature?: string
): void {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part || !('text' in part) || part.thought !== true || part.thoughtDurationMs !== undefined) continue;
    part.thoughtDurationMs = durationMs;
    if (thoughtSignature) part.thoughtSignature = thoughtSignature;
    return;
  }
  if (thoughtSignature || durationMs > 0) {
    parts.push({
      text: '',
      thought: true,
      ...(thoughtSignature ? { thoughtSignature } : {}),
      thoughtDurationMs: durationMs
    });
  }
}

function upsertFunctionCallParts(
  parts: MessageContent['parts'],
  calls: readonly ToolCallOutput[],
  outputItem?: ModelOutputItemReference
): void {
  for (const call of calls) {
    const functionIndexes = parts
      .map((part, index) => 'functionCall' in part ? index : -1)
      .filter((index) => index >= 0);
    const byId = call.id
      ? parts.findIndex((part) => 'functionCall' in part && part.id === call.id)
      : -1;
    const existingIndex = byId >= 0 ? byId : functionIndexes[call.ordinal] ?? -1;
    const prior = existingIndex >= 0 ? parts[existingIndex] : undefined;
    const priorOutputItem = prior?.outputItem;
    const next = {
      ...(call.id ? { id: call.id } : {}),
      functionCall: { name: call.name, args: call.arguments },
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      ...(outputItem ?? priorOutputItem ? { outputItem: outputItem ?? priorOutputItem } : {})
    };
    if (existingIndex >= 0) parts[existingIndex] = next;
    else parts.push(next);
  }
}

function applyOutputItemMetadata(
  parts: MessageContent['parts'],
  outputItem: ModelOutputItemReference
): void {
  for (const part of parts) {
    if (part.outputItem?.id === outputItem.id) part.outputItem = outputItem;
  }
}

function modelOutputItemFromPayload(
  payload: Record<string, unknown> | undefined
): ModelOutputItemReference | undefined {
  const source = asRecord(payload?.outputItem);
  const id = optionalText(source?.id);
  const ordinal = optionalOrdinal(source?.ordinal);
  if (!id || ordinal === undefined) return undefined;
  const phase = source?.phase === 'commentary' || source?.phase === 'final_answer'
    ? source.phase
    : undefined;
  return { id, ordinal, ...(phase ? { phase } : {}) };
}

function plainModelOutputItem(outputItem: ModelOutputItemReference): PlainJsonValue {
  return normalizePlainJson(outputItem, 'Model output item reference');
}

function messageContentFromDonePayload(value: unknown): MessageContent | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizePlainJson(value, 'LLM completed MessageContent');
  const record = requireRecord(normalized, 'LLM completed MessageContent');
  if (record.role !== 'model' || !Array.isArray(record.parts)) {
    throw new TypeError('LLM completed MessageContent must contain model parts.');
  }
  return normalized as unknown as MessageContent;
}

function compactReadToolCallsInContent(content: MessageContent): MessageContent {
  return {
    ...content,
    parts: content.parts.map((part) => {
      if (!('functionCall' in part) || part.functionCall.name !== READ_TOOL_NAME) return part;
      return {
        ...part,
        functionCall: {
          ...part.functionCall,
          args: compactReadFileToolArguments(part.functionCall.args)
        }
      };
    })
  };
}

function applyThoughtDurations(
  content: MessageContent,
  blockDurations: readonly number[],
  totalDurationMs: number | undefined
): MessageContent {
  const parts = content.parts.map((part) => ({ ...part }));
  const thoughtIndexes = parts
    .map((part, index) => 'text' in part && part.thought === true ? index : -1)
    .filter((index) => index >= 0);
  let assigned = 0;
  thoughtIndexes.forEach((partIndex, thoughtIndex) => {
    const part = parts[partIndex];
    if (!part || !('text' in part)) return;
    const direct = blockDurations[thoughtIndex];
    const duration = direct ?? (thoughtIndex === thoughtIndexes.length - 1 && totalDurationMs !== undefined
      ? Math.max(0, totalDurationMs - assigned)
      : undefined);
    if (duration !== undefined) {
      part.thoughtDurationMs = duration;
      assigned += duration;
    }
  });
  return { role: 'model', parts };
}

class CapabilityToolCallAccumulator {
  private readonly calls: ToolCallOutput[] = [];
  private readonly byProviderCallId = new Map<string, number>();
  private readonly byProviderOrdinal = new Map<number, number>();
  private readonly explicitOrdinalByCallIndex: Array<number | undefined> = [];
  private readonly anonymousBySignature = new Map<string, number>();

  public merge(value: unknown): ToolCallOutput[] {
    const incoming = normalizeCapabilityToolCalls(value);
    const changed: ToolCallOutput[] = [];
    for (const candidate of incoming) {
      const explicitOrdinal = candidate.ordinal;
      const idIndex = candidate.id ? this.byProviderCallId.get(candidate.id) : undefined;
      const ordinalIndex = candidate.hasExplicitOrdinal
        ? this.byProviderOrdinal.get(explicitOrdinal)
        : undefined;
      if (idIndex !== undefined && ordinalIndex !== undefined && idIndex !== ordinalIndex) {
        throw new Error(
          `LLM provider tool call id ${candidate.id} and ordinal ${explicitOrdinal} identify different calls.`
        );
      }
      const existingIndex = idIndex
        ?? ordinalIndex
        ?? (!candidate.id && !candidate.hasExplicitOrdinal
          ? this.anonymousBySignature.get(toolCallCoreSignature(candidate))
          : undefined);
      if (existingIndex !== undefined) {
        const existing = this.calls[existingIndex];
        if (existing.id && candidate.id && existing.id !== candidate.id) {
          throw new Error(`LLM provider reused tool call ordinal ${explicitOrdinal} for ids ${existing.id} and ${candidate.id}.`);
        }
        const priorExplicitOrdinal = this.explicitOrdinalByCallIndex[existingIndex];
        if (
          candidate.hasExplicitOrdinal
          && priorExplicitOrdinal !== undefined
          && priorExplicitOrdinal !== explicitOrdinal
        ) {
          throw new Error(
            `LLM provider reused tool call ${candidate.id ? `id ${candidate.id}` : `ordinal ${priorExplicitOrdinal}`} with ordinal ${explicitOrdinal}.`
          );
        }
        assertSameToolCall(existing, candidate);
        const signature = mergeThoughtSignature(existing.thoughtSignature, candidate.thoughtSignature, candidate.id, existing.ordinal);
        let enriched = false;
        if (!existing.id && candidate.id) {
          existing.id = candidate.id;
          this.byProviderCallId.set(candidate.id, existingIndex);
          enriched = true;
        }
        if (candidate.hasExplicitOrdinal && priorExplicitOrdinal === undefined) {
          this.explicitOrdinalByCallIndex[existingIndex] = explicitOrdinal;
          this.byProviderOrdinal.set(explicitOrdinal, existingIndex);
        }
        if (signature && signature !== existing.thoughtSignature) {
          existing.thoughtSignature = signature;
          enriched = true;
        }
        if (enriched) changed.push({ ...existing });
        continue;
      }

      const ordinal = this.calls.length;
      const call: ToolCallOutput = {
        ...(candidate.id ? { id: candidate.id } : {}),
        ordinal,
        name: candidate.name,
        arguments: candidate.arguments,
        ...(candidate.thoughtSignature ? { thoughtSignature: candidate.thoughtSignature } : {})
      };
      this.calls.push(call);
      this.explicitOrdinalByCallIndex.push(candidate.hasExplicitOrdinal ? explicitOrdinal : undefined);
      if (call.id) this.byProviderCallId.set(call.id, ordinal);
      if (candidate.hasExplicitOrdinal) this.byProviderOrdinal.set(explicitOrdinal, ordinal);
      if (!call.id && !candidate.hasExplicitOrdinal) {
        this.anonymousBySignature.set(toolCallCoreSignature(call), ordinal);
      }
      changed.push({ ...call });
    }
    return changed;
  }

  public snapshot(): ToolCallOutput[] {
    return this.calls.map((call) => ({ ...call }));
  }
}

interface NormalizedCapabilityToolCall extends ToolCallOutput {
  hasExplicitOrdinal: boolean;
}

function normalizeCapabilityToolCalls(value: unknown): NormalizedCapabilityToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) throw new TypeError(`LLM tool call ${index} is invalid.`);
    const argsJson = optionalText(record.argsJson);
    const id = optionalText(record.id);
    const explicitOrdinal = optionalOrdinal(record.ordinal ?? record.streamIndex);
    const name = requireText(record.name, `LLM tool call ${index}.name`);
    const normalizedArguments = argsJson
      ? normalizePlainJson(JSON.parse(argsJson), `LLM tool call ${index}.argsJson`)
      : normalizePlainJson(record.arguments ?? {}, `LLM tool call ${index}.arguments`);
    return {
      ...(id ? { id } : {}),
      ordinal: explicitOrdinal ?? index,
      hasExplicitOrdinal: explicitOrdinal !== undefined,
      name,
      arguments: name === READ_TOOL_NAME
        ? normalizePlainJson(compactReadFileToolArguments(normalizedArguments), `LLM tool call ${index}.compactedReadArguments`)
        : normalizedArguments,
      ...(optionalText(record.thoughtSignature) ? { thoughtSignature: optionalText(record.thoughtSignature) } : {})
    };
  });
}

function assertSameToolCall(existing: ToolCallOutput, incoming: ToolCallOutput): void {
  if (toolCallCoreSignature(existing) !== toolCallCoreSignature(incoming)) {
    const identity = incoming.id
      ? `id ${incoming.id}`
      : `ordinal ${incoming.ordinal}`;
    throw new Error(`LLM provider reused tool call ${identity} with conflicting content.`);
  }
}

function toolCallCoreSignature(call: Pick<ToolCallOutput, 'name' | 'arguments'>): string {
  return canonicalPlainJson({ name: call.name, arguments: call.arguments }, 'LLM tool call signature');
}

function mergeThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
  providerCallId: string | undefined,
  ordinal: number
): string | undefined {
  if (existing && incoming && existing !== incoming) {
    throw new Error(
      `LLM provider reused tool call ${providerCallId ? `id ${providerCallId}` : `ordinal ${ordinal}`} with conflicting thoughtSignature.`
    );
  }
  return incoming || existing;
}

/**
 * Provider SDKs commonly materialize absent optional JSON fields as `undefined`.
 * Omit only those object properties while retaining the reliable kernel's strict
 * JSON boundary for arrays, prototypes, cycles, and non-finite numbers.
 */
function normalizeProviderPlainJson(value: unknown, label: string): PlainJsonValue {
  return normalizeProviderPlainJsonValue(value, label, new Set<object>());
}

function normalizeProviderPlainJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>
): PlainJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} cannot contain non-finite numbers.`);
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return withProviderJsonAncestor(value, label, ancestors, () => Array.from(
      { length: value.length },
      (_, index) => {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError(`${label}[${index}] must contain JSON-compatible plain data.`);
        }
        return normalizeProviderPlainJsonValue(value[index], `${label}[${index}]`, ancestors);
      }
    ));
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects and arrays.`);
    }
    return withProviderJsonAncestor(value, label, ancestors, () => {
      const normalized: Record<string, PlainJsonValue> = {};
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (nested === undefined) continue;
        normalized[key] = normalizeProviderPlainJsonValue(nested, `${label}.${key}`, ancestors);
      }
      return normalized;
    });
  }
  throw new TypeError(`${label} must contain JSON-compatible plain data.`);
}

function withProviderJsonAncestor<T>(
  value: object,
  label: string,
  ancestors: Set<object>,
  action: () => T
): T {
  if (ancestors.has(value)) throw new TypeError(`${label} cannot contain cycles.`);
  ancestors.add(value);
  try {
    return action();
  } finally {
    ancestors.delete(value);
  }
}

function optionalOrdinal(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseNestedJson(value: PlainJsonValue | undefined, label: string): PlainJsonValue {
  if (typeof value !== 'string') return normalizePlainJson(value ?? null, label);
  try {
    return normalizePlainJson(JSON.parse(value), label);
  } catch {
    return value;
  }
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function currentThoughtBlockDurationMs(
  startedAt: number | undefined,
  authoritativeElapsedMs: number | undefined,
  observedAt: number
): number {
  const elapsedMs = authoritativeElapsedMs ?? 0;
  if (startedAt === undefined || !Number.isFinite(observedAt)) return elapsedMs;
  return Math.max(elapsedMs, Math.max(0, Math.round(observedAt - startedAt)));
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function capabilityProviderError(payload: Record<string, unknown> | undefined): Error {
  const message = optionalText(payload?.message) || 'Provider 调用失败。';
  return classifyProviderFailure(message, asRecord(payload?.rawError));
}

function capabilityThrownProviderError(error: unknown): Error {
  if (error instanceof ProviderTransientError || (error instanceof Error && error.name === 'AbortError')) return error;
  const record = asRecord(error);
  const raw: Record<string, unknown> = record ? { ...record } : {};
  if (error instanceof Error) {
    raw.name ??= error.name;
    raw.message ??= error.message;
    const structured = error as Error & {
      code?: unknown;
      status?: unknown;
      retryable?: unknown;
      transportAttemptsExhausted?: unknown;
      receivedServerEvent?: unknown;
      receivedSemanticOutput?: unknown;
      phase?: unknown;
      closeCode?: unknown;
      cause?: unknown;
    };
    if (structured.code !== undefined) raw.code ??= structured.code;
    if (structured.status !== undefined) raw.status ??= structured.status;
    if (structured.retryable !== undefined) raw.retryable ??= structured.retryable;
    if (structured.transportAttemptsExhausted !== undefined) {
      raw.transportAttemptsExhausted ??= structured.transportAttemptsExhausted;
    }
    if (structured.receivedServerEvent !== undefined) raw.receivedServerEvent ??= structured.receivedServerEvent;
    if (structured.receivedSemanticOutput !== undefined) {
      raw.receivedSemanticOutput ??= structured.receivedSemanticOutput;
    }
    if (structured.phase !== undefined) raw.phase ??= structured.phase;
    if (structured.closeCode !== undefined) raw.closeCode ??= structured.closeCode;
    if (structured.cause !== undefined) raw.cause ??= structured.cause;
  }
  const message = error instanceof Error && error.message.trim()
    ? error.message
    : optionalText(raw.message) || 'Provider 调用失败。';
  return classifyProviderFailure(message, raw);
}

function classifyProviderFailure(message: string, raw: Record<string, unknown> | undefined): Error {
  const status = findNumericStatus(raw);
  const signature = collectErrorSignature(raw, message).toLowerCase();
  const explicitlyRetryable = findBooleanMetadata(raw, 'retryable');
  const transportAttemptsExhausted = findBooleanMetadata(raw, 'transportAttemptsExhausted');
  const receivedSemanticOutput = findBooleanMetadata(raw, 'receivedSemanticOutput');
  const preTerminalWebSocketClose = classifyOpenAIResponsesPreTerminalWebSocketClose(
    signature,
    findNumericMetadata(raw, 'closeCode', 1_000, 4_999)
  );
  // A new reliable Attempt gets a fresh socket and transient accumulator, so these explicitly
  // recoverable pre-terminal closes may replace partial text/thought/tool output instead of
  // appending to it. They outrank receivedSemanticOutput, stale retryable=false metadata, an
  // exhausted capability-local transport budget, and a close reason that would otherwise look
  // permanent; the reliable ControlPlane's frozen Attempt budget remains authoritative.
  if (preTerminalWebSocketClose?.retryable === true) {
    return new ProviderTransientError('connection_interrupted', message, true);
  }
  if (preTerminalWebSocketClose?.retryable === false) return new Error(message);
  if (/\b(invalid_api_key|authentication_error|permission_denied|invalid_request_error|context_length_exceeded|insufficient_quota|billing_hard_limit_reached)\b|\b(?:unauthorized|forbidden)\b|context (?:length|window).*(?:exceed|too (?:large|long))|(?:credit|balance|billing).*(?:exhaust|limit|insufficient)/.test(signature)) {
    return new Error(message);
  }
  if (receivedSemanticOutput === true) {
    return new Error(`${message}（已收到 Provider 语义输出，不自动重放请求。）`);
  }
  if (explicitlyRetryable === false || transportAttemptsExhausted === true) return new Error(message);
  if (status === 429 || /unexpected server response:\s*429\b/.test(signature)) {
    return new ProviderTransientError('rate_limited', message);
  }
  if (
    status === 408
    || status === 425
    || (status !== undefined && status >= 500 && status <= 599)
    || /unexpected server response:\s*(?:408|425|5\d\d)\b/.test(signature)
  ) {
    return new ProviderTransientError('temporary_service_error', message);
  }
  if (/\b(econnreset|econnrefused|enotfound|enetunreach|ehostunreach|etimedout|eai_again|network_changed)\b|socket hang up|network error|fetch failed|connection (?:closed|reset|interrupted)|websocket closed before (?:terminal event|response\.completed|open)|timed? out/.test(signature)) {
    return new ProviderTransientError('connection_interrupted', message);
  }
  if (/\bupstream request failed\b|\bservice (?:temporarily )?unavailable\b|\bbad gateway\b|\bgateway timeout\b|\bserver overloaded\b|\brate_limit_exceeded\b|\bserver_error\b|\binternal_error\b/.test(signature)) {
    return new ProviderTransientError('temporary_service_error', message);
  }
  if (explicitlyRetryable === true) {
    return new ProviderTransientError('connection_interrupted', message);
  }
  return new Error(message);
}

function compactProviderError(payload: Record<string, unknown> | undefined): Error {
  return capabilityProviderError(payload);
}

function capabilityRetryError(payload: Record<string, unknown> | undefined): ProviderTransientError {
  const mapped = capabilityProviderError(payload);
  return mapped instanceof ProviderTransientError
    ? mapped
    : new ProviderTransientError('temporary_service_error', mapped.message);
}

function findBooleanMetadata(value: unknown, key: string, depth = 0, seen = new Set<object>()): boolean | undefined {
  if (depth > 6 || value === null || value === undefined || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      const nested = findBooleanMetadata(entry, key, depth + 1, seen);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'boolean') return record[key] as boolean;
  for (const nested of Object.values(record).slice(0, 32)) {
    const result = findBooleanMetadata(nested, key, depth + 1, seen);
    if (result !== undefined) return result;
  }
  return undefined;
}

function findNumericMetadata(
  value: unknown,
  key: string,
  minimum: number,
  maximum: number,
  depth = 0,
  seen = new Set<object>()
): number | undefined {
  if (depth > 6 || value === null || value === undefined || typeof value !== 'object' || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      const nested = findNumericMetadata(entry, key, minimum, maximum, depth + 1, seen);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record[key];
  const numeric = typeof direct === 'number'
    ? direct
    : typeof direct === 'string' && /^\d+$/.test(direct.trim())
      ? Number(direct.trim())
      : NaN;
  if (Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum) return numeric;
  for (const nested of Object.values(record).slice(0, 32)) {
    const result = findNumericMetadata(nested, key, minimum, maximum, depth + 1, seen);
    if (result !== undefined) return result;
  }
  return undefined;
}

function findNumericStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      const nested = findNumericStatus(entry, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['status', 'statusCode', 'httpStatus', 'response']) {
    const nested = findNumericStatus(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function collectErrorSignature(value: unknown, fallback: string, depth = 0, seen = new Set<object>()): string {
  if (depth > 5 || value === null || value === undefined) return depth === 0 ? fallback : '';
  if (typeof value === 'string' || typeof value === 'number') return String(value).slice(0, 1_000);
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) => collectErrorSignature(entry, '', depth + 1, seen)).join(' ');
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  const record = value as Record<string, unknown>;
  const fields = ['name', 'kind', 'code', 'message', 'reason', 'cause', 'error', 'data', 'response'];
  const text = fields.map((key) => collectErrorSignature(record[key], '', depth + 1, seen)).join(' ');
  return depth === 0 ? `${fallback} ${text}` : text;
}

function requireProviderKind(value: PlainJsonValue | undefined): LlmProviderKind {
  if (!['openai-compatible', 'openai-responses', 'claude', 'gemini', 'deepseek'].includes(String(value))) {
    throw new TypeError(`Provider authority model.provider is invalid: ${String(value)}.`);
  }
  return value as LlmProviderKind;
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof ProviderTransientError) return signal.reason;
  const error = new Error('Provider dispatch aborted.');
  error.name = 'AbortError';
  return error;
}

import type { LlmCapability } from '../capabilities/types';
import type { LlmCompactRequest, LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import { LlmEventType } from '../world/modules/llm/events';
import type { WorldEvent } from '../ecs/types';
import type { LlmProviderKind, MessageContent } from '../../shared/protocol';
import { ProviderTransientError } from './modelProviderControlPlane';
import type {
  FullProviderRequest,
  FullRequestProviderAdapter,
  ProviderDispatchControls,
  ProviderOutputStreamEvent
} from './modelProviderControlPlane';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';

interface ToolCallOutput {
  id?: string;
  /** Stable zero-based ordinal assigned on first observation when the provider omits one. */
  ordinal: number;
  name: string;
  arguments: PlainJsonValue;
  thoughtSignature?: string;
}

/** 把现有无状态 LLM capability 适配为可靠内核 full-request Provider 边界。 */
export class LlmCapabilityFullRequestAdapter implements FullRequestProviderAdapter {
  public constructor(
    public readonly providerId: string,
    private readonly capability: LlmCapability
  ) {
    if (!providerId.trim()) throw new TypeError('providerId must be non-empty.');
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
      let thoughtElapsedMs: number | undefined;
      let thoughtDurationMs: number | undefined;
      let providerStartedAt: number | undefined;
      const toolCalls = new CapabilityToolCallAccumulator();
      let terminal = false;
      let tail = Promise.resolve();

      const enqueue = (event: Omit<ProviderOutputStreamEvent, 'streamSeq'>): void => {
        sequence += 1n;
        const completeEvent: ProviderOutputStreamEvent = { ...event, streamSeq: sequence.toString() };
        tail = tail.then(() => controls.onEvent(completeEvent)).then(() => undefined);
      };
      const finish = (error?: unknown): void => {
        if (terminal) return;
        terminal = true;
        detachAbort();
        void tail.then(
          () => error === undefined ? resolve() : reject(error),
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
            text += delta;
            if (delta) enqueue({ kind: 'output_delta', content: { type: 'text_delta', text: delta } });
            return;
          }
          case LlmEventType.ThoughtDelta: {
            const delta = optionalText(payload?.text);
            thought += delta;
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            thoughtElapsedMs = optionalNonNegativeNumber(payload?.thoughtElapsedMs) ?? thoughtElapsedMs;
            if (delta) {
              enqueue({
                kind: 'output_delta',
                content: {
                  type: 'thought_delta',
                  text: delta,
                  ...(thoughtSignature ? { thoughtSignature } : {}),
                  ...(thoughtElapsedMs !== undefined ? { thoughtElapsedMs } : {})
                }
              });
            }
            return;
          }
          case LlmEventType.ThoughtProgress: {
            thoughtElapsedMs = optionalNonNegativeNumber(payload?.thoughtElapsedMs) ?? thoughtElapsedMs;
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            if (thoughtElapsedMs !== undefined) {
              enqueue({
                kind: 'output_delta',
                semanticProgress: false,
                content: {
                  type: 'thought_progress',
                  thoughtElapsedMs,
                  ...(thoughtSignature ? { thoughtSignature } : {})
                }
              });
            }
            return;
          }
          case LlmEventType.ThoughtDone: {
            thoughtDurationMs = optionalNonNegativeNumber(payload?.thoughtDurationMs)
              ?? thoughtElapsedMs;
            thoughtSignature = optionalText(payload?.thoughtSignature) || thoughtSignature;
            enqueue({
              kind: 'output_item_done',
              content: {
                type: 'thought_done',
                ...(thoughtDurationMs !== undefined ? { thoughtDurationMs } : {}),
                ...(thoughtSignature ? { thoughtSignature } : {})
              }
            });
            return;
          }
          case LlmEventType.ToolCallDelta: {
            enqueue({
              kind: 'output_delta',
              content: {
                type: 'tool_call_delta',
                calls: normalizePlainJson(payload?.calls ?? [], 'LLM tool call delta')
              }
            });
            return;
          }
          case LlmEventType.ToolCall: {
            const merged = toolCalls.merge(payload?.calls);
            if (merged.length > 0) {
              enqueue({
                kind: 'output_item_done',
                content: {
                  type: 'tool_calls',
                  semantics: 'upsert',
                  calls: normalizePlainJson(merged, 'LLM completed tool call upserts')
                }
              });
            }
            return;
          }
          case LlmEventType.Done: {
            thoughtDurationMs ??= thoughtElapsedMs;
            const usage = payload?.usageMetadata === undefined
              ? undefined
              : normalizePlainJson(payload.usageMetadata, 'LLM usage metadata');
            enqueue({
              kind: 'completed',
              content: {
                text,
                thought,
                ...(thoughtSignature ? { thoughtSignature } : {}),
                ...(thoughtDurationMs !== undefined ? { thoughtDurationMs } : {}),
                toolCallsSemantics: 'snapshot',
                toolCalls: normalizePlainJson(toolCalls.snapshot(), 'LLM terminal tool calls')
              },
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
        finish(abortError());
      };
      const detachAbort = (): void => controls.signal?.removeEventListener('abort', onAbort);
      if (controls.signal?.aborted) {
        finish(abortError());
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
            const result = requireRecord(
              normalizePlainJson(payload?.result, 'LLM compact result'),
              'LLM compact result'
            );
            if (!Array.isArray(result.contents) || result.contents.length === 0) {
              throw new TypeError('LLM compact result must contain structured MessageContent[].');
            }
            sequence += 1n;
            const completeEvent: ProviderOutputStreamEvent = {
              kind: 'completed',
              streamSeq: sequence.toString(),
              content: normalizePlainJson({
                type: 'compression_result',
                contents: result.contents,
                ...(result.settingsSnapshot !== undefined ? { settingsSnapshot: result.settingsSnapshot } : {}),
                ...(result.methodConfig !== undefined ? { methodConfig: result.methodConfig } : {})
              }, 'LLM compression terminal content'),
              ...(result.usageMetadata !== undefined
                ? { usage: normalizePlainJson(result.usageMetadata, 'LLM compression usage') }
                : {})
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
        finish(abortError());
      };
      const detachAbort = (): void => controls.signal?.removeEventListener('abort', onAbort);
      if (controls.signal?.aborted) {
        finish(abortError());
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
  const authority = requireRecord(request.authoritySnapshot, 'Provider authority snapshot');
  const toolPolicy = authorityToolPolicy(authority);
  const tools = normalizeToolDefinitions(recipe.tools)
    .filter((tool) => providerToolAllowed(toolPolicy, tool))
    .map((tool) => tool.schema);
  const authorityModel = requireRecord(authority.model, 'Provider authority model');
  const provider = requireProviderKind(authorityModel.provider);
  const systemParts: string[] = [];
  const systemPrompt = asRecord(authority.systemPrompt);
  if (typeof systemPrompt?.text === 'string' && systemPrompt.text.trim()) systemParts.push(systemPrompt.text.trim());
  const runtimeContext = asRecord(authority.runtimeContext);
  if (typeof runtimeContext?.template === 'string' && runtimeContext.template.trim()) {
    systemParts.push(runtimeContext.template.trim());
  }
  const contents: MessageContent[] = [];
  for (const item of request.context) {
    if (item.segmentKind === 'system') {
      systemParts.push(contextText(item.content, item.contentType));
      continue;
    }
    if (item.segmentKind === 'tool_pair') {
      contents.push(...toolPairContents(item.content));
      continue;
    }
    const compressed = decodeCompressionContents(item.content, item.contentType);
    if (compressed) {
      assertCompressionBinding(compressed, {
        providerConfigId: request.providerId,
        provider,
        modelId: request.modelId
      });
      contents.push(...compressed.contents);
      continue;
    }
    const decoded = decodeMessageContent(item.content, item.contentType);
    if (decoded) {
      contents.push(decoded);
      continue;
    }
    const role = item.messageRole === 'model' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: item.content }] });
  }
  const systemText = systemParts.filter(Boolean).join('\n\n');
  return {
    id: request.modelRequestId,
    contents,
    tools,
    model: {
      providerConfigId: request.providerId,
      provider,
      model: request.modelId
    },
    ...(systemText ? { systemInstruction: { role: 'user', parts: [{ text: systemText }] } } : {})
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
  const methodConfig = requireRecord(compression.config, 'Compression authority config');
  const methodKind = requireText(methodConfig.kind, 'Compression method kind') as LlmCompactRequest['methodKind'];
  const conversationId = requireText(authority.conversationId, 'Compression authority conversationId');
  const provider = requireRecord(compression.provider, 'Compression authority provider');
  const compressionProvider = {
    providerConfigId: requireText(provider.providerConfigId, 'Compression providerConfigId'),
    provider: requireProviderKind(provider.provider),
    modelId: requireText(provider.modelId, 'Compression modelId')
  };
  const context = compressionContext(request, compressionProvider);
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
      ? { segments: context.segments, ...(context.priorSummaryContents.length > 0
        ? { priorSummaryContents: context.priorSummaryContents }
        : {}) }
      : {}),
    ...(optionalText(recipe.sourceHash) ? { sourceHash: optionalText(recipe.sourceHash) } : {})
  };
}

function compressionContext(
  request: FullProviderRequest,
  provider: CompressionProviderBinding
): {
  contents: MessageContent[];
  segments: MessageContent[][];
  priorSummaryContents: MessageContent[];
} {
  const contents: MessageContent[] = [];
  const priorSummaryContents: MessageContent[] = [];
  const segments: MessageContent[][] = [];
  let current: MessageContent[] = [];
  const flush = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };
  const recipe = requireRecord(request.recipe, 'Compression recipe');
  const requestedCount = recipe.sourceSegmentCount;
  if (!Number.isSafeInteger(requestedCount) || (requestedCount as number) <= 0
    || (requestedCount as number) > request.context.length) {
    throw new RangeError('Compression recipe sourceSegmentCount is outside its frozen Context projection.');
  }
  if (request.context[requestedCount as number]?.segmentKind === 'tool_pair') {
    throw new Error('Compression recipe splits an assistant function call from its tool_pair response.');
  }
  for (const item of request.context.slice(0, requestedCount as number)) {
    let decoded: MessageContent[];
    if (item.segmentKind === 'tool_pair') decoded = toolPairContents(item.content);
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
    if (item.segmentKind === 'compression' && contents.length === 0) {
      priorSummaryContents.push(...decoded);
    }
    for (const content of decoded) {
      if (content.role === 'user' && hasOrdinaryUserPart(content) && current.length > 0) flush();
      current.push(content);
      contents.push(content);
    }
  }
  flush();
  return { contents, segments, priorSummaryContents };
}

function hasOrdinaryUserPart(content: MessageContent): boolean {
  return content.parts.some((part) => 'text' in part && typeof part.text === 'string' && !('functionResponse' in part));
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

function toolPairContents(content: string): MessageContent[] {
  const pair = requireRecord(normalizePlainJson(JSON.parse(content), 'Context tool pair'), 'Context tool pair');
  const call = requireRecord(pair.toolCall, 'Context tool pair.toolCall');
  const result = requireRecord(pair.toolModelResult, 'Context tool pair.toolModelResult');
  requireText(call.id, 'Context tool pair.toolCall.id');
  const providerCallId = optionalText(call.providerCallId);
  const name = requireText(call.toolName, 'Context tool pair.toolCall.toolName');
  const response = parseNestedJson(result.result, 'Context tool result');
  return [{
    role: 'user',
    parts: [{
      ...(providerCallId ? { id: providerCallId } : {}),
      functionResponse: { name, response }
    }]
  }];
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
    return {
      ...(id ? { id } : {}),
      ordinal: explicitOrdinal ?? index,
      hasExplicitOrdinal: explicitOrdinal !== undefined,
      name: requireText(record.name, `LLM tool call ${index}.name`),
      arguments: argsJson
        ? normalizePlainJson(JSON.parse(argsJson), `LLM tool call ${index}.argsJson`)
        : normalizePlainJson(record.arguments ?? {}, `LLM tool call ${index}.arguments`),
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
      cause?: unknown;
    };
    if (structured.code !== undefined) raw.code ??= structured.code;
    if (structured.status !== undefined) raw.status ??= structured.status;
    if (structured.retryable !== undefined) raw.retryable ??= structured.retryable;
    if (structured.transportAttemptsExhausted !== undefined) {
      raw.transportAttemptsExhausted ??= structured.transportAttemptsExhausted;
    }
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
  const incompleteNormalWebSocketClose = /websocket closed before (?:terminal event|response\.completed|open)(?::|\s)+(?:1000|1001)\b/.test(signature);
  if (/\b(invalid_api_key|authentication_error|permission_denied|invalid_request_error|context_length_exceeded|insufficient_quota|billing_hard_limit_reached)\b|\b(?:unauthorized|forbidden)\b|context (?:length|window).*(?:exceed|too (?:large|long))|(?:credit|balance|billing).*(?:exhaust|limit|insufficient)/.test(signature)) {
    return new Error(message);
  }
  // 1000/1001 only describe a graceful WebSocket closing handshake. If no Responses terminal
  // event arrived, the provider response is incomplete and must outrank stale retryable=false
  // metadata from older transport adapters.
  if (incompleteNormalWebSocketClose && transportAttemptsExhausted !== true) {
    return new ProviderTransientError('connection_interrupted', message);
  }
  if (explicitlyRetryable === false || transportAttemptsExhausted === true) return new Error(message);
  if (status === 429) return new ProviderTransientError('rate_limited', message);
  if (status === 408 || status === 425 || (status !== undefined && status >= 500 && status <= 599)) {
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

function abortError(): Error {
  const error = new Error('Provider dispatch aborted.');
  error.name = 'AbortError';
  return error;
}

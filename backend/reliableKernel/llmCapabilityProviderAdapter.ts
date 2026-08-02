import type { LlmCapability } from '../capabilities/types';
import type { LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import { LlmEventType } from '../world/modules/llm/events';
import type { WorldEvent } from '../ecs/types';
import type { LlmProviderKind, MessageContent } from '../../shared/protocol';
import { ProviderTransientError } from './modelProviderControlPlane';
import type {
  FullProviderRequest,
  FullRequestProviderAdapter,
  ProviderDispatchControls,
  ProviderStreamEvent
} from './modelProviderControlPlane';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';

interface ToolCallOutput {
  id?: string;
  name: string;
  arguments: PlainJsonValue;
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
    const llmRequest = toLlmStartRequest(request);
    return new Promise<void>((resolve, reject) => {
      let sequence = 0n;
      let text = '';
      let thought = '';
      let thoughtSignature: string | undefined;
      let toolCalls: ToolCallOutput[] = [];
      let terminal = false;
      let tail = Promise.resolve();

      const enqueue = (event: Omit<ProviderStreamEvent, 'streamSeq'>): void => {
        sequence += 1n;
        const completeEvent: ProviderStreamEvent = { ...event, streamSeq: sequence.toString() };
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
        const payload = asRecord(event.payload);
        switch (event.type) {
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
            if (delta) {
              enqueue({
                kind: 'output_delta',
                content: {
                  type: 'thought_delta',
                  text: delta,
                  ...(thoughtSignature ? { thoughtSignature } : {})
                }
              });
            }
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
            toolCalls = normalizeCapabilityToolCalls(payload?.calls);
            enqueue({
              kind: 'output_item_done',
              content: {
                type: 'tool_calls',
                calls: normalizePlainJson(toolCalls, 'LLM completed tool calls')
              }
            });
            return;
          }
          case LlmEventType.Done: {
            const usage = payload?.usageMetadata === undefined
              ? undefined
              : normalizePlainJson(payload.usageMetadata, 'LLM usage metadata');
            enqueue({
              kind: 'completed',
              content: {
                text,
                thought,
                ...(thoughtSignature ? { thoughtSignature } : {}),
                toolCalls: normalizePlainJson(toolCalls, 'LLM terminal tool calls')
              },
              ...(usage !== undefined ? { usage } : {})
            });
            finish();
            return;
          }
          case LlmEventType.Error:
            finish(capabilityProviderError(payload));
            return;
          default:
            return;
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
        finish(error);
      }
    });
  }
}

function toLlmStartRequest(request: FullProviderRequest): LlmStartRequest {
  const recipe = requireRecord(request.recipe, 'Provider recipe');
  const authority = requireRecord(request.authoritySnapshot, 'Provider authority snapshot');
  const allowedTools = authorityAllowedTools(authority);
  const tools = normalizeToolSchemas(recipe.tools).filter((tool) => allowedTools.has(tool.name));
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

function authorityAllowedTools(authority: { [key: string]: PlainJsonValue }): Set<string> {
  const policy = requireRecord(authority.toolPolicy, 'Provider authority toolPolicy');
  if (!Array.isArray(policy.allowedTools)) throw new TypeError('Provider authority toolPolicy.allowedTools must be an array.');
  return new Set(policy.allowedTools.map((name, index) => requireText(name, `allowedTools[${index}]`)));
}

function normalizeToolSchemas(value: PlainJsonValue | undefined): ToolSchema[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Provider recipe.tools must be an array.');
  return value.map((entry, index) => {
    const record = requireRecord(entry, `Provider recipe.tools[${index}]`);
    return {
      name: requireText(record.name, `Provider recipe.tools[${index}].name`),
      description: optionalText(record.description),
      parameters: record.parameters ?? {}
    };
  });
}

function normalizeCapabilityToolCalls(value: unknown): ToolCallOutput[] {
  if (!Array.isArray(value)) return [];
  const normalized: ToolCallOutput[] = [];
  const byProviderCallId = new Map<string, string>();
  value.forEach((entry, index) => {
    const record = asRecord(entry);
    if (!record) throw new TypeError(`LLM tool call ${index} is invalid.`);
    const argsJson = optionalText(record.argsJson);
    const id = optionalText(record.id);
    const call: ToolCallOutput = {
      ...(id ? { id } : {}),
      name: requireText(record.name, `LLM tool call ${index}.name`),
      arguments: argsJson
        ? normalizePlainJson(JSON.parse(argsJson), `LLM tool call ${index}.argsJson`)
        : normalizePlainJson(record.arguments ?? {}, `LLM tool call ${index}.arguments`)
    };
    if (id) {
      const signature = canonicalPlainJson({ name: call.name, arguments: call.arguments }, 'LLM tool call signature');
      const existing = byProviderCallId.get(id);
      if (existing !== undefined) {
        if (existing !== signature) throw new Error(`LLM provider reused tool call id ${id} with conflicting content.`);
        return;
      }
      byProviderCallId.set(id, signature);
    }
    normalized.push(call);
  });
  return normalized;
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

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function capabilityProviderError(payload: Record<string, unknown> | undefined): Error {
  const message = optionalText(payload?.message) || 'Provider 调用失败。';
  const raw = asRecord(payload?.rawError);
  const status = findNumericStatus(raw);
  if (status === 429) return new ProviderTransientError('rate_limited', message);
  if (status === 408 || status === 425 || (status !== undefined && status >= 500 && status <= 599)) {
    return new ProviderTransientError('temporary_service_error', message);
  }
  const signature = collectErrorSignature(raw, message).toLowerCase();
  if (/\b(econnreset|econnrefused|enotfound|enetunreach|ehostunreach|etimedout|eai_again)\b|socket hang up|network error|fetch failed|connection (?:closed|reset|interrupted)|timed? out/.test(signature)) {
    return new ProviderTransientError('connection_interrupted', message);
  }
  return new Error(message);
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

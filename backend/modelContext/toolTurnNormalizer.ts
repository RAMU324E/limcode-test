import {
  TERMINAL_TOOL_CALL_STATUSES,
  isFunctionCallPart,
  isFunctionResponsePart,
  type ContentPart,
  type FunctionCallPart,
  type FunctionResponsePart,
  type MessageContent,
  type RunTerminationRecord,
  type ToolCallRecord
} from '../../shared/protocol';
import type { JsonValue } from '../../shared/conversationReliability';
import type { ModelContextDiagnostic } from './types';

export type ToolSequenceEntry =
  | {
      kind: 'content';
      content: MessageContent;
      messageId?: string;
    }
  | {
      /** Internal control-plane fact used only to close calls owned by this terminated Run. */
      kind: 'termination';
      termination: RunTerminationRecord;
    };

export interface ToolTurnNormalizerInput {
  entries: readonly ToolSequenceEntry[];
  toolCalls: readonly ToolCallRecord[];
  modelResponsesByToolCallId?: ReadonlyMap<string, JsonValue>;
  runIdsByMessage: ReadonlyMap<string, readonly string[]>;
  terminationsByRun: ReadonlyMap<string, RunTerminationRecord>;
  purpose: 'fresh' | 'compression' | 'same_run_resume' | 'dry_run';
}

export interface ToolTurnNormalizerResult {
  contents: MessageContent[];
  diagnostics: ModelContextDiagnostic[];
  referencedToolCallIds: string[];
}

interface PendingCall {
  key: string;
  id?: string;
  name: string;
  tool?: ToolCallRecord;
  ownerRunId?: string;
}

/**
 * Canonicalizes one model-visible tool sequence before hashing/token estimation/provider rendering.
 * Calls and outputs are paired deterministically; provider adapters may only assert idempotence.
 */
export function normalizeToolTurnSequence(input: ToolTurnNormalizerInput): ToolTurnNormalizerResult {
  const diagnostics: ModelContextDiagnostic[] = [];
  const referencedToolCallIds = new Set<string>();
  const pending: PendingCall[] = [];
  const toolsByAlias = toolAliases(input.toolCalls);
  const toolsByMessage = groupToolsByMessage(input.toolCalls);
  const contents: MessageContent[] = [];

  for (const entry of input.entries) {
    if (entry.kind === 'termination') {
      contents.push(...closeRunCalls(
        pending,
        entry.termination,
        diagnostics,
        referencedToolCallIds,
        input.modelResponsesByToolCallId
      ));
      continue;
    }

    const normalizedParts: ContentPart[] = [];
    const representedTools = new Set<string>();
    for (const part of entry.content.parts) {
      if (isFunctionCallPart(part)) {
        const tool = matchToolForCall(part, entry.messageId, toolsByAlias, toolsByMessage, representedTools, diagnostics);
        if (tool) {
          representedTools.add(tool.id);
          referencedToolCallIds.add(tool.id);
        }
        const canonical = canonicalCallPart(part, tool);
        normalizedParts.push(canonical);
        pending.push({
          key: callKey(canonical),
          id: canonical.id?.trim() || undefined,
          name: canonical.functionCall.name,
          tool,
          ownerRunId: entry.messageId ? ownerRunForMessage(entry.messageId, input.runIdsByMessage, input.terminationsByRun) : undefined
        });
        continue;
      }
      if (isFunctionResponsePart(part)) {
        const match = consumePendingCall(pending, part);
        if (!match) {
          diagnostics.push({
            code: 'orphan_tool_response',
            severity: 'warning',
            message: `Function response ${part.functionResponse.name} has no selected call and was converted to text.`,
            sourceId: part.id
          });
          normalizedParts.push(orphanResponseText(part));
          continue;
        }
        if (match.tool) referencedToolCallIds.add(match.tool.id);
        normalizedParts.push(canonicalResponsePart(part, match.tool, match.tool ? input.modelResponsesByToolCallId?.get(match.tool.id) : undefined));
        continue;
      }
      normalizedParts.push(clone(part));
    }

    if (entry.messageId && entry.content.role === 'model') {
      for (const tool of toolsByMessage.get(entry.messageId) ?? []) {
        if (representedTools.has(tool.id)) continue;
        const canonical = canonicalToolCallPart(tool);
        normalizedParts.push(canonical);
        representedTools.add(tool.id);
        referencedToolCallIds.add(tool.id);
        pending.push({
          key: callKey(canonical),
          id: canonical.id?.trim() || undefined,
          name: canonical.functionCall.name,
          tool,
          ownerRunId: ownerRunForMessage(entry.messageId, input.runIdsByMessage, input.terminationsByRun)
        });
      }
    }

    if (normalizedParts.length > 0) contents.push({ role: entry.content.role, parts: normalizedParts });
  }

  if (pending.length > 0 && input.purpose !== 'same_run_resume') {
    const terminalResponses: FunctionResponsePart[] = [];
    const unresolvedResponses: FunctionResponsePart[] = [];
    for (const call of pending.splice(0)) {
      if (call.tool && TERMINAL_TOOL_CALL_STATUSES.has(call.tool.status)) {
        terminalResponses.push(canonicalToolResponsePart(call.tool, requireModelResponse(input.modelResponsesByToolCallId, call.tool.id)));
        referencedToolCallIds.add(call.tool.id);
      } else {
        diagnostics.push({
          code: 'unresolved_tool_call',
          severity: input.purpose === 'compression' ? 'error' : 'warning',
          message: `Function call ${call.name} has no terminal response in the selected sequence.`,
          sourceId: call.tool?.id ?? call.id
        });
        if (input.purpose !== 'compression') unresolvedResponses.push(unknownOutcomeResponse(call));
      }
    }
    if (terminalResponses.length > 0) contents.push({ role: 'user', parts: terminalResponses });
    if (unresolvedResponses.length > 0) contents.push({ role: 'user', parts: unresolvedResponses });
  }

  return { contents, diagnostics, referencedToolCallIds: [...referencedToolCallIds] };
}

function closeRunCalls(
  pending: PendingCall[],
  termination: RunTerminationRecord,
  diagnostics: ModelContextDiagnostic[],
  referencedToolCallIds: Set<string>,
  modelResponsesByToolCallId?: ReadonlyMap<string, JsonValue>
): MessageContent[] {
  const responses: FunctionResponsePart[] = [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const call = pending[index];
    if (call.ownerRunId !== termination.runId) continue;
    pending.splice(index, 1);
    if (call.tool) referencedToolCallIds.add(call.tool.id);
    if (call.tool && TERMINAL_TOOL_CALL_STATUSES.has(call.tool.status)) {
      responses.unshift(canonicalToolResponsePart(call.tool, requireModelResponse(modelResponsesByToolCallId, call.tool.id)));
    } else {
      responses.unshift(interruptedResponse(call, termination));
      diagnostics.push({
        code: 'unresolved_tool_call',
        severity: 'info',
        message: `Function call ${call.name} was closed by RunTermination ${termination.id}.`,
        sourceId: call.tool?.id ?? call.id
      });
    }
  }
  return responses.length > 0 ? [{ role: 'user', parts: responses }] : [];
}

function matchToolForCall(
  part: FunctionCallPart,
  messageId: string | undefined,
  byAlias: ReadonlyMap<string, ToolCallRecord[]>,
  byMessage: ReadonlyMap<string, ToolCallRecord[]>,
  represented: ReadonlySet<string>,
  diagnostics: ModelContextDiagnostic[]
): ToolCallRecord | undefined {
  const id = part.id?.trim();
  if (id) {
    const exact = (byAlias.get(id) ?? []).filter((tool) => !represented.has(tool.id));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      diagnostics.push({ code: 'ambiguous_tool_pair', severity: 'error', message: `Function call ID ${id} matches multiple ToolCall facts.`, sourceId: id });
      return undefined;
    }
  }
  const candidates = messageId
    ? (byMessage.get(messageId) ?? []).filter((tool) => !represented.has(tool.id)
      && tool.name === part.functionCall.name
      && canonicalJson(parseJson(tool.args)) === canonicalJson(part.functionCall.args))
    : [];
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) diagnostics.push({ code: 'ambiguous_tool_pair', severity: 'error', message: `Function call ${part.functionCall.name} has ambiguous name/args ToolCall facts.`, sourceId: messageId });
  return undefined;
}

function consumePendingCall(pending: PendingCall[], response: FunctionResponsePart): PendingCall | undefined {
  const id = response.id?.trim();
  if (id) {
    const exact = pending.findIndex((call) => call.id === id || call.tool?.id === id || call.tool?.functionCallId === id);
    if (exact >= 0) return pending.splice(exact, 1)[0];
    return undefined;
  }
  const byName = pending.findIndex((call) => !call.id && call.name === response.functionResponse.name);
  return byName >= 0 ? pending.splice(byName, 1)[0] : undefined;
}

function canonicalCallPart(original: FunctionCallPart, tool: ToolCallRecord | undefined): FunctionCallPart {
  if (!tool) return clone(original);
  return canonicalToolCallPart(tool);
}

function requireModelResponse(
  modelResponsesByToolCallId: ReadonlyMap<string, JsonValue> | undefined,
  toolCallId: string
): JsonValue {
  const response = modelResponsesByToolCallId?.get(toolCallId);
  if (response === undefined) throw new Error(`Terminal ToolCall ${toolCallId} has no Artifact model response.`);
  return response;
}

function canonicalToolCallPart(tool: ToolCallRecord): FunctionCallPart {
  return {
    id: tool.functionCallId ?? tool.id,
    functionCall: { name: tool.name, args: parseJson(tool.args) }
  };
}

function canonicalResponsePart(original: FunctionResponsePart, tool: ToolCallRecord | undefined, modelResponse?: JsonValue): FunctionResponsePart {
  if (!tool || !TERMINAL_TOOL_CALL_STATUSES.has(tool.status)) return clone(original);
  if (modelResponse === undefined) throw new Error(`Terminal ToolCall ${tool.id} has no Artifact model response.`);
  return canonicalToolResponsePart(tool, modelResponse);
}

export function canonicalToolResponsePart(tool: ToolCallRecord, modelResponse: JsonValue): FunctionResponsePart {
  const response = modelResponse;
  return {
    id: tool.functionCallId ?? tool.id,
    functionResponse: {
      name: tool.name,
      response: clone(response),
      ...(tool.responseParts?.length ? { parts: clone(tool.responseParts) } : {})
    }
  };
}

function interruptedResponse(call: PendingCall, termination: RunTerminationRecord): FunctionResponsePart {
  return {
    ...(call.id ? { id: call.id } : {}),
    functionResponse: {
      name: call.name,
      response: {
        ok: false,
        interrupted: true,
        outcomeUnknown: true,
        reasonCode: termination.reasonCode,
        message: 'Tool execution ended without a committed terminal result. Verify current state before retrying any side effect.'
      }
    }
  };
}

function unknownOutcomeResponse(call: PendingCall): FunctionResponsePart {
  return {
    ...(call.id ? { id: call.id } : {}),
    functionResponse: {
      name: call.name,
      response: {
        ok: false,
        outcomeUnknown: true,
        reasonCode: 'tool_outcome_unknown',
        message: 'No terminal tool result is available; do not assume the side effect did or did not occur.'
      }
    }
  };
}

function orphanResponseText(part: FunctionResponsePart): ContentPart {
  return {
    text: `[orphan_tool_response name=${part.functionResponse.name}] ${canonicalJson(part.functionResponse.response)}`
  };
}

function toolAliases(tools: readonly ToolCallRecord[]): Map<string, ToolCallRecord[]> {
  const result = new Map<string, ToolCallRecord[]>();
  for (const tool of tools) {
    for (const alias of [tool.id, tool.functionCallId].filter((value): value is string => !!value)) {
      const values = result.get(alias) ?? [];
      values.push(tool);
      result.set(alias, values);
    }
  }
  return result;
}

function groupToolsByMessage(tools: readonly ToolCallRecord[]): Map<string, ToolCallRecord[]> {
  const result = new Map<string, ToolCallRecord[]>();
  for (const tool of tools) {
    const values = result.get(tool.messageId) ?? [];
    values.push(tool);
    result.set(tool.messageId, values);
  }
  for (const values of result.values()) {
    values.sort((left, right) => (left.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.schedulingOrdinal ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id));
  }
  return result;
}

function ownerRunForMessage(
  messageId: string,
  runIdsByMessage: ReadonlyMap<string, readonly string[]>,
  terminationsByRun: ReadonlyMap<string, RunTerminationRecord>
): string | undefined {
  const terminated = (runIdsByMessage.get(messageId) ?? []).filter((runId) => terminationsByRun.has(runId));
  return terminated.length === 1 ? terminated[0] : undefined;
}

function callKey(part: FunctionCallPart): string {
  return part.id?.trim() || `${part.functionCall.name}:${canonicalJson(part.functionCall.args)}`;
}

function parseJson(value: string): unknown {
  try { return value ? JSON.parse(value) : {}; }
  catch { return value; }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

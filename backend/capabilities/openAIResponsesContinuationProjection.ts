import type { LLMRequest, LLMStreamChunk, Part } from 'unified-llm-provider';

export interface OpenAIResponsesContinuationEncoder {
  encodeRequest(request: LLMRequest, stream?: boolean): unknown;
}

export interface OpenAIResponsesContinuationProjectionResult {
  chunk: LLMStreamChunk;
  semanticOutput: boolean;
}

interface DoneOutputItem {
  item: Record<string, unknown>;
  outputIndex?: number;
  key: string;
}

interface ProjectedFunctionCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

interface ReasoningIdentity {
  itemId?: string;
  outputIndex?: number;
}

/**
 * Builds the continuation baseline from the exact semantic chunks yielded to LimCode.
 *
 * Raw terminal items are deliberately not replayed as the baseline. They are used only to prove
 * that the stream projection is a lossless representation of the completed response and to
 * recover the output_item.done reasoning signature that the provider documents as replayable.
 */
export class OpenAIResponsesContinuationProjection {
  private visibleText = '';
  private thoughtText = '';
  private thoughtSignature?: string;
  private readonly functionCalls: ProjectedFunctionCall[] = [];
  private readonly functionCallIndexes = new Map<string, number>();
  private readonly doneItems: DoneOutputItem[] = [];
  private readonly doneItemIndexes = new Map<string, number>();
  private completedOutput?: Record<string, unknown>[];
  private reasoningIdentity?: ReasoningIdentity;
  private readonly summaryTextByIndex = new Map<number, string>();
  private readonly completedSummaryIndexes = new Set<number>();
  private lastStreamedSummaryIndex?: number;
  private unsafeReason?: string;

  public observe(
    raw: Record<string, unknown>,
    decoded: LLMStreamChunk
  ): OpenAIResponsesContinuationProjectionResult {
    this.captureTerminalEvidence(raw);
    const chunk = this.canonicalChunk(raw, decoded);
    this.accumulateChunk(raw, chunk);
    if (eventType(raw) === 'response.output_item.done') this.validateReasoningTerminal(raw);
    return { chunk, semanticOutput: hasSemanticChunkOutput(chunk) };
  }

  public completedOutputItems(encoder: OpenAIResponsesContinuationEncoder): unknown[] | undefined {
    if (this.unsafeReason) return undefined;
    const terminalItems = this.terminalItems();
    if (!terminalItems) return undefined;
    if (!this.validateTerminalProjection(terminalItems)) return undefined;
    if (terminalItems.length === 0) return [];

    const parts: Part[] = [];
    if (this.thoughtText || this.thoughtSignature) {
      parts.push({
        text: this.thoughtText,
        thought: true,
        ...(this.thoughtSignature
          ? { thoughtSignatures: { 'openai-responses': this.thoughtSignature } }
          : {})
      });
    }
    if (this.visibleText) parts.push({ text: this.visibleText });
    for (const call of this.functionCalls) {
      parts.push({
        functionCall: {
          name: call.name,
          args: cloneJson(call.args),
          callId: call.callId
        }
      });
    }
    if (parts.length === 0) return undefined;

    let encoded: unknown;
    try {
      encoded = encoder.encodeRequest({ contents: [{ role: 'model', parts }] }, false);
    } catch {
      return undefined;
    }
    return isRecord(encoded) && Array.isArray(encoded.input)
      ? encoded.input.map(cloneJson)
      : undefined;
  }

  private canonicalChunk(raw: Record<string, unknown>, decoded: LLMStreamChunk): LLMStreamChunk {
    const type = eventType(raw);
    const isDelta = isReasoningDeltaEvent(type);
    const isFullText = isReasoningFullTextEvent(type);
    if (!isDelta && !isFullText) return decoded;

    const rawText = isDelta
      ? optionalString(raw.delta)
      : reasoningFullText(raw, type);
    if (!rawText) return decoded;
    const identity = reasoningIdentity(raw);
    if (!identity || !this.registerReasoningIdentity(identity)) return decoded;
    const summaryIndex = nonNegativeInteger(raw.summary_index) ?? 0;
    const isNewBlock = !this.summaryTextByIndex.has(summaryIndex);
    if (!this.registerSummaryBlock(summaryIndex)) return decoded;

    const thoughtParts = (decoded.partsDelta ?? []).filter(isThoughtTextPart);
    const decodedText = thoughtParts.map((part) => part.text ?? '').join('');
    const existingText = this.summaryTextByIndex.get(summaryIndex) ?? '';
    let projectedText: string;
    if (isDelta) {
      if (this.completedSummaryIndexes.has(summaryIndex)) {
        this.markUnsafe('reasoning_delta_after_summary_done');
      }
      if (decodedText !== rawText) this.markUnsafe('reasoning_delta_projection_changed');
      projectedText = rawText;
      this.summaryTextByIndex.set(summaryIndex, `${existingText}${rawText}`);
    } else {
      if (!rawText.startsWith(existingText)) {
        this.markUnsafe('reasoning_summary_terminal_revision_conflict');
        return withCanonicalThoughtText(decoded, '');
      }
      projectedText = rawText.slice(existingText.length);
      this.summaryTextByIndex.set(summaryIndex, rawText);
      if (isReasoningFullTextDoneEvent(type)) this.completedSummaryIndexes.add(summaryIndex);
      if (decodedText && decodedText !== projectedText && decodedText !== rawText) {
        this.markUnsafe('reasoning_full_text_projection_changed');
      }
    }

    if (isNewBlock && this.thoughtText && projectedText) projectedText = `\n${projectedText}`;
    return withCanonicalThoughtText(decoded, projectedText);
  }

  private registerSummaryBlock(summaryIndex: number): boolean {
    if (this.summaryTextByIndex.has(summaryIndex)) {
      if (summaryIndex !== this.lastStreamedSummaryIndex) {
        this.markUnsafe('reasoning_summary_blocks_out_of_order');
        return false;
      }
      return true;
    }
    const expectedIndex = this.lastStreamedSummaryIndex === undefined
      ? 0
      : this.lastStreamedSummaryIndex + 1;
    if (summaryIndex !== expectedIndex) {
      this.markUnsafe('reasoning_summary_index_gap');
      return false;
    }
    this.summaryTextByIndex.set(summaryIndex, '');
    this.lastStreamedSummaryIndex = summaryIndex;
    return true;
  }

  private accumulateChunk(raw: Record<string, unknown>, chunk: LLMStreamChunk): void {
    const parts = chunk.partsDelta ?? [];
    this.visibleText += chunk.textDelta ?? parts.filter(isVisibleTextPart).map((part) => part.text ?? '').join('');
    this.thoughtText += parts.filter(isThoughtTextPart).map((part) => part.text ?? '').join('');

    const signature = openAIResponsesSignature(chunk)
      ?? parts.map(openAIResponsesSignature).find((value): value is string => !!value);
    if (signature) {
      const trustedDoneSignature = eventType(raw) === 'response.output_item.done'
        && isRecord(raw.item)
        && raw.item.type === 'reasoning'
        && optionalString(raw.item.encrypted_content) === signature;
      if (!trustedDoneSignature) {
        this.markUnsafe('reasoning_signature_from_untrusted_event');
      } else if (this.thoughtSignature && this.thoughtSignature !== signature) {
        this.markUnsafe('reasoning_signature_conflict');
      } else this.thoughtSignature = signature;
    }

    const calls = [
      ...(chunk.functionCalls ?? []),
      ...parts.filter(isFunctionCallPart)
    ];
    for (const part of calls) this.accumulateFunctionCall(part);
  }

  private accumulateFunctionCall(part: Part): void {
    if (!isFunctionCallPart(part)) return;
    const callId = optionalString(part.functionCall.callId);
    if (!callId) {
      this.markUnsafe('function_call_without_provider_id');
      return;
    }
    const candidate: ProjectedFunctionCall = {
      callId,
      name: part.functionCall.name,
      args: cloneJson(part.functionCall.args)
    };
    const existingIndex = this.functionCallIndexes.get(callId);
    if (existingIndex === undefined) {
      this.functionCallIndexes.set(callId, this.functionCalls.length);
      this.functionCalls.push(candidate);
      return;
    }
    if (canonicalString(this.functionCalls[existingIndex]) !== canonicalString(candidate)) {
      this.markUnsafe('function_call_projection_conflict');
    }
  }

  private captureTerminalEvidence(raw: Record<string, unknown>): void {
    const type = eventType(raw);
    if (type === 'response.output_item.done') {
      if (!isRecord(raw.item)) {
        this.markUnsafe('output_item_done_without_item');
        return;
      }
      const outputIndex = nonNegativeInteger(raw.output_index);
      const key = optionalString(raw.item.id)
        ? `id:${optionalString(raw.item.id)}`
        : outputIndex !== undefined
          ? `output:${outputIndex}`
          : `ordinal:${this.doneItems.length}`;
      const candidate: DoneOutputItem = {
        item: cloneJson(raw.item),
        ...(outputIndex !== undefined ? { outputIndex } : {}),
        key
      };
      const existingIndex = this.doneItemIndexes.get(key);
      if (existingIndex === undefined) {
        this.doneItemIndexes.set(key, this.doneItems.length);
        this.doneItems.push(candidate);
      } else if (canonicalString(this.doneItems[existingIndex]) !== canonicalString(candidate)) {
        this.markUnsafe('output_item_done_conflict');
      }
      if (raw.item.type === 'reasoning') {
        const identity = reasoningIdentity(raw);
        if (identity) this.registerReasoningIdentity(identity);
        else this.markUnsafe('reasoning_item_without_identity');
      }
      return;
    }
    if (type !== 'response.completed') return;
    const response = isRecord(raw.response) ? raw.response : raw;
    if (this.completedOutput !== undefined) {
      this.markUnsafe('duplicate_response_completed');
      return;
    }
    if (response.output === undefined) {
      this.completedOutput = [];
      return;
    }
    if (!Array.isArray(response.output)) {
      this.markUnsafe('response_completed_without_output_membership');
      return;
    }
    if (!response.output.every(isRecord)) {
      this.markUnsafe('response_completed_invalid_output_member');
      return;
    }
    this.completedOutput = response.output.map((item) => cloneJson(item));
  }

  private validateReasoningTerminal(raw: Record<string, unknown>): void {
    if (!isRecord(raw.item) || raw.item.type !== 'reasoning') return;
    const summary = reasoningSummaryText(raw.item.summary);
    if (summary === undefined) {
      this.markUnsafe('reasoning_terminal_summary_invalid');
      return;
    }
    // A terminal item may arrive after complete deltas. Validation is deferred until all decoded
    // chunks (including a done-only full summary or a partial-delta suffix) have been accumulated.
  }

  private terminalItems(): Array<{ item: Record<string, unknown>; trustedSignature?: string }> | undefined {
    if (this.completedOutput === undefined) return undefined;
    if (this.completedOutput.length === 0) {
      const sorted = [...this.doneItems].sort((left, right) => {
        if (left.outputIndex === undefined || right.outputIndex === undefined) return 0;
        return left.outputIndex - right.outputIndex;
      });
      if (sorted.some((entry) => entry.outputIndex === undefined)) return this.fail('done_output_index_missing');
      for (let index = 0; index < sorted.length; index += 1) {
        if (sorted[index].outputIndex !== index) return this.fail('done_output_index_gap');
      }
      return sorted.map((entry) => ({
        item: cloneJson(entry.item),
        ...(entry.item.type === 'reasoning' && optionalString(entry.item.encrypted_content)
          ? { trustedSignature: optionalString(entry.item.encrypted_content) }
          : {})
      }));
    }

    const consumed = new Set<number>();
    const result: Array<{ item: Record<string, unknown>; trustedSignature?: string }> = [];
    for (const [outputIndex, item] of this.completedOutput.entries()) {
      const matches = this.doneItems
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry, index }) => !consumed.has(index) && terminalItemsMatch(item, outputIndex, entry));
      if (matches.length > 1) return this.fail('completed_done_match_ambiguous');
      const matched = matches[0];
      if (matched) {
        consumed.add(matched.index);
        if (!sameTerminalItem(item, matched.entry.item)) return this.fail('completed_done_item_conflict');
      }
      result.push({
        item: cloneJson(item),
        ...(item.type === 'reasoning' && matched && optionalString(matched.entry.item.encrypted_content)
          ? { trustedSignature: optionalString(matched.entry.item.encrypted_content) }
          : {})
      });
    }
    if (consumed.size !== this.doneItems.length) return this.fail('completed_done_membership_conflict');
    return result;
  }

  private validateTerminalProjection(
    terminal: Array<{ item: Record<string, unknown>; trustedSignature?: string }>
  ): boolean {
    const expectedTypes = [
      ...(this.thoughtText || this.thoughtSignature ? ['reasoning'] : []),
      ...(this.visibleText ? ['message'] : []),
      ...this.functionCalls.map(() => 'function_call')
    ];
    if (terminal.length !== expectedTypes.length) return this.invalidate('terminal_member_count_mismatch');
    if (terminal.filter((entry) => entry.item.type === 'reasoning').length > 1) {
      return this.invalidate('multiple_reasoning_items_unrepresentable');
    }

    let functionIndex = 0;
    for (let index = 0; index < terminal.length; index += 1) {
      const entry = terminal[index];
      if (entry.item.type !== expectedTypes[index]) return this.invalidate('terminal_member_order_mismatch');
      if (entry.item.type === 'reasoning') {
        const summary = reasoningSummaryText(entry.item.summary);
        if (summary === undefined || summary !== this.thoughtText) {
          return this.invalidate('reasoning_terminal_revision_conflict');
        }
        if ((entry.trustedSignature ?? undefined) !== (this.thoughtSignature ?? undefined)) {
          return this.invalidate('reasoning_terminal_signature_conflict');
        }
        continue;
      }
      if (entry.item.type === 'message') {
        const text = assistantMessageText(entry.item);
        if (text === undefined || text !== this.visibleText) {
          return this.invalidate('message_terminal_revision_conflict');
        }
        continue;
      }
      if (entry.item.type === 'function_call') {
        const call = this.functionCalls[functionIndex++];
        if (!sameFunctionCall(entry.item, call)) {
          return this.invalidate('function_call_terminal_conflict');
        }
        continue;
      }
      return this.invalidate('terminal_member_unrepresentable');
    }
    return !this.unsafeReason;
  }

  private registerReasoningIdentity(candidate: ReasoningIdentity): boolean {
    if (!this.reasoningIdentity) {
      this.reasoningIdentity = { ...candidate };
      return true;
    }
    const current = this.reasoningIdentity;
    const idConflict = current.itemId !== undefined && candidate.itemId !== undefined
      && current.itemId !== candidate.itemId;
    const indexConflict = current.outputIndex !== undefined && candidate.outputIndex !== undefined
      && current.outputIndex !== candidate.outputIndex;
    if (idConflict || indexConflict) {
      this.markUnsafe('multiple_reasoning_items_unrepresentable');
      return false;
    }
    current.itemId ??= candidate.itemId;
    current.outputIndex ??= candidate.outputIndex;
    return true;
  }

  private markUnsafe(reason: string): void {
    this.unsafeReason ??= reason;
  }

  private invalidate(reason: string): false {
    this.markUnsafe(reason);
    return false;
  }

  private fail(reason: string): undefined {
    this.markUnsafe(reason);
    return undefined;
  }
}

export function hasSemanticChunkOutput(chunk: LLMStreamChunk): boolean {
  if (typeof chunk.textDelta === 'string' && chunk.textDelta.length > 0) return true;
  if ((chunk.functionCalls?.length ?? 0) > 0) return true;
  if (openAIResponsesSignature(chunk)) return true;
  return (chunk.partsDelta ?? []).some((part) => {
    if (isFunctionCallPart(part)) return true;
    if (isThoughtTextPart(part)) return !!part.text || !!openAIResponsesSignature(part);
    if (isVisibleTextPart(part)) return !!part.text;
    return isRecord(part) && 'providerContext' in part;
  });
}

function terminalItemsMatch(
  completed: Record<string, unknown>,
  completedIndex: number,
  done: DoneOutputItem
): boolean {
  const completedId = optionalString(completed.id);
  const doneId = optionalString(done.item.id);
  if (completedId && doneId) return completedId === doneId;
  return done.outputIndex === completedIndex && completed.type === done.item.type;
}

function sameTerminalItem(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return canonicalString(terminalComparable(left)) === canonicalString(terminalComparable(right));
}

function terminalComparable(value: Record<string, unknown>): Record<string, unknown> {
  const result = cloneJson(value);
  delete result.id;
  delete result.status;
  delete result.encrypted_content;
  return result;
}

function sameFunctionCall(item: Record<string, unknown>, call: ProjectedFunctionCall): boolean {
  if (optionalString(item.call_id) !== call.callId || optionalString(item.name) !== call.name) return false;
  let args: unknown = item.arguments;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return false;
    }
  }
  return isRecord(args) && canonicalString(args) === canonicalString(call.args);
}

function assistantMessageText(item: Record<string, unknown>): string | undefined {
  if (item.role !== 'assistant' || !Array.isArray(item.content)) return undefined;
  let text = '';
  for (const block of item.content) {
    if (!isRecord(block) || block.type !== 'output_text' || typeof block.text !== 'string') return undefined;
    text += block.text;
  }
  return text;
}

function reasoningSummaryText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const blocks: string[] = [];
  for (const part of value) {
    const text = reasoningSummaryPartText(part);
    if (text) blocks.push(text);
  }
  return blocks.join('\n');
}

function reasoningSummaryPartText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.summary_text === 'string') return value.summary_text;
  if (typeof value.content === 'string') return value.content;
  return '';
}

function reasoningIdentity(value: Record<string, unknown>): ReasoningIdentity | undefined {
  const item = isRecord(value.item) ? value.item : undefined;
  const itemId = optionalString(value.item_id) ?? (item ? optionalString(item.id) : undefined);
  const outputIndex = nonNegativeInteger(value.output_index);
  return itemId || outputIndex !== undefined ? {
    ...(itemId ? { itemId } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {})
  } : undefined;
}

function isReasoningDeltaEvent(type: string): boolean {
  return type === 'response.reasoning_summary_text.delta'
    || type === 'response.reasoning_text.delta'
    || type === 'response.reasoning.delta';
}

function isReasoningFullTextEvent(type: string): boolean {
  return isReasoningFullTextDoneEvent(type)
    || type === 'response.reasoning_summary_part.added';
}

function isReasoningFullTextDoneEvent(type: string): boolean {
  return type === 'response.reasoning_summary_text.done'
    || type === 'response.reasoning_text.done'
    || type === 'response.reasoning.done'
    || type === 'response.reasoning_summary_part.done';
}

function reasoningFullText(raw: Record<string, unknown>, type: string): string | undefined {
  if (type === 'response.reasoning_summary_part.added'
    || type === 'response.reasoning_summary_part.done') {
    return optionalString(reasoningSummaryPartText(
      raw.part ?? raw.summary_part ?? raw.content_part ?? raw
    ));
  }
  return optionalString(raw.text)
    ?? optionalString(raw.content)
    ?? optionalString(raw.summary_text);
}

function withCanonicalThoughtText(chunk: LLMStreamChunk, text: string): LLMStreamChunk {
  const parts = chunk.partsDelta ?? [];
  const currentText = parts.filter(isThoughtTextPart).map((part) => part.text ?? '').join('');
  if (currentText === text) return chunk;

  let placedText = false;
  const projectedParts: Part[] = [];
  for (const part of parts) {
    if (!isThoughtTextPart(part) || typeof part.text !== 'string') {
      projectedParts.push(part);
      continue;
    }
    if (!placedText && text) {
      projectedParts.push({ ...part, text });
      placedText = true;
      continue;
    }
    const withoutText = { ...part } as Part & Record<string, unknown>;
    delete withoutText.text;
    if (Object.keys(withoutText).some((key) => key !== 'thought')) projectedParts.push(withoutText);
  }
  if (!placedText && text) projectedParts.push({ text, thought: true });
  return { ...chunk, partsDelta: projectedParts };
}

function isThoughtTextPart(value: unknown): value is Part & { text?: string; thought: true } {
  return isRecord(value) && value.thought === true;
}

function isVisibleTextPart(value: unknown): value is Part & { text?: string } {
  return isRecord(value) && 'text' in value && value.thought !== true;
}

function isFunctionCallPart(value: unknown): value is Part & {
  functionCall: { name: string; args: Record<string, unknown>; callId?: string };
} {
  return isRecord(value) && isRecord(value.functionCall)
    && typeof value.functionCall.name === 'string'
    && isRecord(value.functionCall.args);
}

function openAIResponsesSignature(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = optionalString(value.thoughtSignature);
  if (direct) {
    const prefix = 'openai-responses:';
    return direct.startsWith(prefix) ? direct.slice(prefix.length) : direct;
  }
  return isRecord(value.thoughtSignatures)
    ? optionalString(value.thoughtSignatures['openai-responses'])
    : undefined;
}

function eventType(value: Record<string, unknown>): string {
  return optionalString(value.event) ?? optionalString(value.type) ?? '';
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function canonicalString(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

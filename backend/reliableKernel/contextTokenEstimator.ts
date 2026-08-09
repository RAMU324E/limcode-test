import { estimateTokenCount } from 'tokenx';
import type { ContentPart, InlineDataPart, MessageContent } from '../../shared/protocol';
import { ContentAddressedStore } from './contentAddressedStore';
import {
  ContextSequenceControlPlane,
  type MaterializedContextSegment
} from './contextSequence';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

const CONTENT_TYPE_MESSAGE = 'application/vnd.limcode.message+json';
const CONTENT_TYPE_TOOL_PAIR = 'application/vnd.limcode.context-tool-pair+json';
const CONTENT_TYPE_COMPRESSION = 'application/vnd.limcode.compression-contents+json';
const MESSAGE_OVERHEAD_TOKENS = 4;
const FUNCTION_OVERHEAD_TOKENS = 4;
const FILE_REFERENCE_TOKENS = 258;

export type ReliableContextTokenEstimateSource =
  | 'provider-observed-delta'
  | 'compression-output'
  | 'semantic';

export interface ReliableContextTokenEstimate {
  estimatedTokens: number;
  source: ReliableContextTokenEstimateSource;
  conversationId: string;
  observedPromptTokens?: number;
  observedModelRequestId?: string;
  coveredSegmentCount: number;
}

/**
 * Provider-aligned Context accounting.
 *
 * ContextSequence stores durable replay envelopes. Those bytes are deliberately not the provider
 * token stream: they can contain base64 attachments, duplicate convenience fields and source facts
 * that materialization later drops. This estimator therefore works on the materialized semantic
 * parts and, when possible, anchors the prefix to a provider-observed prompt/total token count.
 */
export class ReliableContextTokenEstimator {
  private readonly context: ContextSequenceControlPlane;

  public constructor(
    private readonly database: RuntimeDatabase,
    contentStore: ContentAddressedStore
  ) {
    this.context = new ContextSequenceControlPlane(database, contentStore);
  }

  public async estimateRoot(rootIdInput: string): Promise<ReliableContextTokenEstimate> {
    const rootId = requireId(rootIdInput, 'rootId');
    const materialized = await this.context.materialize(rootId);
    const conversationId = requireId(materialized.root.conversation_id, 'ContextSequenceRoot.conversation_id');
    const semanticTokens = estimateMaterializedContextTokens(materialized.segments);
    const compressed = compressionEstimate(materialized.segments);
    const observed = await this.findObservedPrefix(conversationId, materialized.segments);
    if (observed) return observed;
    return {
      estimatedTokens: semanticTokens,
      source: compressed ? 'compression-output' : 'semantic',
      conversationId,
      coveredSegmentCount: materialized.segments.length
    };
  }

  /** Estimates the exact prefix sent by a compression request while preserving a full-root usage anchor. */
  public async estimateRootPrefix(rootIdInput: string, segmentCountInput: number): Promise<number> {
    const rootId = requireId(rootIdInput, 'rootId');
    const materialized = await this.context.materialize(rootId);
    const segmentCount = requireSegmentCount(segmentCountInput, materialized.segments.length);
    if (segmentCount === materialized.segments.length) {
      return (await this.estimateRoot(rootId)).estimatedTokens;
    }
    const full = await this.estimateRoot(rootId);
    const omittedTail = estimateMaterializedContextTokens(materialized.segments.slice(segmentCount));
    return Math.max(0, full.estimatedTokens - omittedTail);
  }

  private async findObservedPrefix(
    conversationId: string,
    current: readonly MaterializedContextSegment[]
  ): Promise<ReliableContextTokenEstimate | null> {
    const turns = (await listAllDomainRows(this.database, 'Turn', {
      conversation_id: conversationId
    })).sort(compareRequestsNewestFirst);
    // Query newest Turns lazily. A long Conversation can contain thousands of Turns; fanning out one
    // SQLite request per historical Turn on every compression check would make token accounting the
    // new bottleneck. The current/latest Turn normally resolves the baseline immediately.
    for (const turn of turns) {
      const requests = (await listAllDomainRows(this.database, 'ModelRequest', {
        turn_id: requireId(turn.id, 'Turn.id')
      })).filter((request) =>
        request.status === 'terminal'
        && request.terminal_state === 'completed'
        && providerPromptTokens(request.usage_json) !== undefined
      ).sort(compareRequestsNewestFirst);

      for (const request of requests) {
        const requestId = requireId(request.id, 'ModelRequest.id');
        const related = await this.database.snapshot([
          DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').list({
            where: { model_request_id: requestId }, limit: 2
          }),
          DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({
            where: { owner_kind: 'model_request', owner_id: requestId }, limit: 2
          })
        ]);
        const links = rows(related.snapshot[0]);
        const projections = rows(related.snapshot[1]);
        // Compression requests never own an assistant Message link. Excluding them is essential:
        // their usage describes the compaction call, not the ordinary model prompt shown to users.
        if (links.length === 0) continue;
        if (links.length !== 1 || projections.length !== 1) return null;
        const projected = await this.context.materialize(requireId(projections[0].root_id, 'ModelContextProjection.root_id'));
        // Conversation Context is linear between explicit compression/edit operations. Once the latest
        // ordinary request is not a prefix, no older ordinary request can be a safer calibration.
        if (!isSegmentPrefix(projected.segments, current)) return null;

        const input = providerPromptTokens(request.usage_json);
        if (input === undefined) continue;
        let estimatedTokens = input;
        let coveredSegmentCount = projected.segments.length;
        const outputSegmentId = await this.messageSegmentId(requireId(links[0].message_id, 'ModelRequestMessageLink.message_id'));
        if (outputSegmentId && current[coveredSegmentCount]?.segmentId === outputSegmentId) {
          const total = providerTotalTokens(request.usage_json);
          estimatedTokens = total ?? (input + estimateMaterializedContextTokens([
            current[coveredSegmentCount]
          ]));
          coveredSegmentCount += 1;
        }
        estimatedTokens += estimateMaterializedContextTokens(current.slice(coveredSegmentCount));
        return {
          estimatedTokens: safeTokenCount(estimatedTokens, 'provider-observed Context estimate'),
          source: 'provider-observed-delta',
          conversationId,
          observedPromptTokens: input,
          observedModelRequestId: requestId,
          coveredSegmentCount
        };
      }
    }
    return null;
  }

  private async messageSegmentId(messageId: string): Promise<string | null> {
    const revisions = (await listAllDomainRows(this.database, 'MessageRevision', {
      message_id: messageId
    })).sort((left, right) => {
      const leftSeq = nonNegativeBigInt(left.revision_seq);
      const rightSeq = nonNegativeBigInt(right.revision_seq);
      return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
    });
    // ModelRequestMessageLink owns the original provider output Message, not a later user edit.
    const providerRevision = revisions[0];
    if (!providerRevision) return null;
    const sources = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: {
          source_kind: 'message_revision',
          source_id: requireId(providerRevision.id, 'MessageRevision.id')
        },
        limit: 2
      })
    ]);
    const occurrences = rows(sources.snapshot[0]);
    return occurrences.length === 1
      ? requireId(occurrences[0].segment_id, 'ContextSegmentSource.segment_id')
      : null;
  }
}

export function estimateMaterializedContextTokens(
  segments: readonly MaterializedContextSegment[]
): number {
  return safeTokenCount(segments.reduce((total, segment) =>
    total + estimateContextSegmentTokens(segment), 0), 'semantic Context estimate');
}

export function estimateContextSegmentTokens(segment: Pick<
  MaterializedContextSegment,
  'segmentKind' | 'messageRole' | 'contentObject' | 'content'
>): number {
  const content = segment.content.toString('utf8');
  const contentType = segment.contentObject.content_type;
  if (segment.segmentKind === 'tool_pair' || contentType === CONTENT_TYPE_TOOL_PAIR) {
    return estimateToolPairContentTokens(content);
  }
  if (segment.segmentKind === 'compression' || contentType === CONTENT_TYPE_COMPRESSION) {
    return estimateCompressionEnvelopeTokens(content);
  }
  if (contentType === CONTENT_TYPE_MESSAGE) {
    const message = parseMessageContent(content);
    if (message) return estimateMessageContentTokens(message);
  }
  return estimateTextTokens(contextText(content, contentType));
}

export function estimateStoredMessageContentTokens(
  content: string | Uint8Array,
  contentType: string
): number {
  const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  if (contentType === CONTENT_TYPE_MESSAGE) {
    const message = parseMessageContent(text);
    if (message) return estimateMessageContentTokens(message);
  }
  return estimateTextTokens(contextText(text, contentType));
}

export function estimateMessageContentsTokens(contents: readonly MessageContent[]): number {
  return safeTokenCount(contents.reduce((total, content) =>
    total + estimateMessageContentTokens(content), 0), 'MessageContent token estimate');
}

/** Informational media subtotal. It is already included in estimateMessageContentsTokens(). */
export function estimateMessageContentsMediaTokens(contents: readonly MessageContent[]): number {
  return safeTokenCount(contents.reduce((total, content) => total + content.parts.reduce(
    (partTotal, part) => partTotal + estimateContentPartMediaTokens(part), 0
  ), 0), 'MessageContent media token estimate');
}

export function estimateMessageContentTokens(content: MessageContent): number {
  const wholeContext = asRecord(content as unknown)?.providerContext;
  if (wholeContext) return estimateProviderContextTokens(wholeContext);
  return MESSAGE_OVERHEAD_TOKENS + content.parts.reduce((total, part) =>
    total + estimateContentPartTokens(part), 0);
}

export function estimateRequestAuthorityTokens(
  authorityValue: PlainJsonValue,
  recipeValue: PlainJsonValue
): number {
  const authority = asRecord(authorityValue);
  const recipe = asRecord(recipeValue);
  if (!authority || !recipe || recipe.kind === 'reliable-context-compression') return 0;
  let total = 0;
  const systemPrompt = asRecord(authority.systemPrompt);
  const runtimeContext = asRecord(authority.runtimeContext);
  if (typeof systemPrompt?.text === 'string') total += estimateTextTokens(systemPrompt.text.trim());
  if (typeof runtimeContext?.template === 'string') total += estimateTextTokens(runtimeContext.template.trim());

  const policy = asRecord(authority.toolPolicy);
  const allowed = new Set(Array.isArray(policy?.allowedTools)
    ? policy.allowedTools.filter((value): value is string => typeof value === 'string')
    : []);
  const sourceConfigs = asRecord(policy?.sourceConfigs) ?? {};
  const tools = Array.isArray(recipe.tools) ? recipe.tools : [];
  for (const value of tools) {
    const tool = asRecord(value);
    if (!tool || !providerToolAllowed(tool, allowed, sourceConfigs)) continue;
    total += 10;
    if (typeof tool.name === 'string') total += estimateTextTokens(tool.name);
    if (typeof tool.description === 'string') total += estimateTextTokens(tool.description);
    total += estimateJsonTokens(tool.parameters ?? {});
  }
  return safeTokenCount(total, 'request authority token estimate');
}

/** Removes the convenience ciphertext copy when rawItem already owns the exact replay value. */
export function canonicalizeCompressionContents(contents: readonly MessageContent[]): MessageContent[] {
  return contents.map((content) => ({
    ...content,
    parts: content.parts.map((part) => canonicalizeCompressionPart(part))
  }));
}

function canonicalizeCompressionPart(part: ContentPart): ContentPart {
  if (!('providerContext' in part)) return part;
  const context = part.providerContext;
  const raw = asRecord(context.rawItem);
  if (
    typeof context.encryptedContent === 'string'
    && typeof raw?.encrypted_content === 'string'
    && context.encryptedContent === raw.encrypted_content
  ) {
    const { encryptedContent: _duplicate, ...canonical } = context;
    return { providerContext: canonical };
  }
  return part;
}

function estimateContentPartTokens(part: ContentPart): number {
  if ('providerContext' in part) return estimateProviderContextTokens(part.providerContext);
  if ('text' in part) return estimateTextTokens(part.text);
  if ('functionCall' in part) {
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(part.functionCall.name)
      + estimateJsonTokens(part.functionCall.args ?? {});
  }
  if ('functionResponse' in part) {
    const attachmentTokens = part.functionResponse.parts?.reduce((total, nested) =>
      total + estimateInlineDataTokens(nested), 0) ?? 0;
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(part.functionResponse.name)
      + estimateJsonTokens(part.functionResponse.response ?? {})
      + attachmentTokens;
  }
  if ('inlineData' in part) return estimateInlineDataTokens(part);
  if ('fileData' in part) return FILE_REFERENCE_TOKENS;
  return 0;
}

function estimateContentPartMediaTokens(part: ContentPart): number {
  if ('inlineData' in part) return estimateInlineDataTokens(part);
  if ('fileData' in part) return FILE_REFERENCE_TOKENS;
  if ('functionResponse' in part) {
    return part.functionResponse.parts?.reduce((total, nested) =>
      total + estimateInlineDataTokens(nested), 0) ?? 0;
  }
  if ('providerContext' in part) {
    const context = asRecord(part.providerContext);
    const raw = asRecord(context?.rawItem);
    if (raw?.type !== 'message' || !Array.isArray(raw.content)) return 0;
    return raw.content.reduce((total, value) => {
      const block = asRecord(value);
      if (block?.type === 'input_image' && typeof block.image_url === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'image/unknown', data: dataUrlBase64(block.image_url)
        } });
      }
      if (block?.type === 'input_file' && typeof block.file_data === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'application/octet-stream', data: dataUrlBase64(block.file_data)
        } });
      }
      return total;
    }, 0);
  }
  return 0;
}

function estimateProviderContextTokens(value: unknown): number {
  const context = asRecord(value);
  const raw = asRecord(context?.rawItem);
  if (!raw) return 0;
  switch (raw.type) {
  case 'message': {
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    return MESSAGE_OVERHEAD_TOKENS + blocks.reduce((total, value) => {
      const block = asRecord(value);
      if (!block) return total;
      if (typeof block.text === 'string') return total + estimateTextTokens(block.text);
      if (block.type === 'input_image' && typeof block.image_url === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'image/unknown', data: dataUrlBase64(block.image_url)
        } });
      }
      if (block.type === 'input_file' && typeof block.file_data === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'application/octet-stream', data: dataUrlBase64(block.file_data)
        } });
      }
      return total;
    }, 0);
  }
  case 'function_call':
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(typeof raw.name === 'string' ? raw.name : '')
      + estimateTextTokens(typeof raw.arguments === 'string'
        ? raw.arguments
        : safeJsonString(raw.arguments ?? {}));
  case 'function_call_output':
    return FUNCTION_OVERHEAD_TOKENS + estimateTextTokens(typeof raw.output === 'string'
      ? raw.output
      : safeJsonString(raw.output ?? {}));
  case 'reasoning':
    return Array.isArray(raw.summary) ? raw.summary.reduce((total, value) => {
      const summary = asRecord(value);
      return total + estimateTextTokens(typeof summary?.text === 'string' ? summary.text : '');
    }, 0) : 0;
  case 'compaction':
    // Ciphertext is an opaque provider handle, not a text prompt. The compression envelope carries
    // the provider-observed output token estimate for this state when one is available.
    return 0;
  default:
    return 0;
  }
}

function estimateInlineDataTokens(part: InlineDataPart): number {
  const rawBytes = inlineDataRawBytes(part.inlineData);
  if (rawBytes <= 0) return 0;
  const mimeType = part.inlineData.mimeType;
  if (mimeType.startsWith('image/')) {
    return Math.max(258, Math.ceil(rawBytes / (300 * 1024)) * 258);
  }
  if (mimeType.startsWith('audio/')) {
    return Math.max(32, Math.ceil(rawBytes / (16 * 1024)) * 32);
  }
  if (mimeType.startsWith('video/')) {
    return Math.max(263, Math.ceil(rawBytes / (256 * 1024)) * 263);
  }
  return Math.max(258, Math.ceil(rawBytes / (100 * 1024)) * 258);
}

function inlineDataRawBytes(value: InlineDataPart['inlineData']): number {
  if (Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) > 0) {
    return value.sizeBytes as number;
  }
  if (typeof value.data === 'string' && value.data.length > 0) {
    return Math.ceil(value.data.length * 3 / 4);
  }
  return 0;
}

export function estimateToolPairContentTokens(content: string): number {
  const pair = parseRecord(content);
  const call = asRecord(pair?.toolCall);
  const result = asRecord(pair?.toolModelResult);
  if (!call || !result) return estimateTextTokens(content);
  const response = parseNestedJson(result.result);
  return MESSAGE_OVERHEAD_TOKENS
    + FUNCTION_OVERHEAD_TOKENS
    + estimateTextTokens(typeof call.toolName === 'string' ? call.toolName : '')
    + estimateJsonTokens(response);
}

function estimateCompressionEnvelopeTokens(content: string): number {
  const envelope = parseRecord(content);
  if (!envelope || envelope.kind !== 'compression_contents' || !Array.isArray(envelope.contents)) {
    return estimateTextTokens(content);
  }
  const stored = optionalTokenCount(envelope.estimatedTokens);
  if (stored !== undefined) return stored;
  const contents = envelope.contents.filter(isMessageContent);
  return estimateMessageContentsTokens(contents);
}

function compressionEstimate(segments: readonly MaterializedContextSegment[]): number | undefined {
  const first = segments[0];
  if (!first || first.segmentKind !== 'compression') return undefined;
  const envelope = parseRecord(first.content.toString('utf8'));
  return optionalTokenCount(envelope?.estimatedTokens);
}

function parseMessageContent(content: string): MessageContent | undefined {
  const parsed = parseRecord(content);
  return parsed && isMessageContent(parsed) ? parsed : undefined;
}

function isMessageContent(value: unknown): value is MessageContent {
  const record = asRecord(value);
  return Boolean(record)
    && (record?.role === 'user' || record?.role === 'model')
    && Array.isArray(record.parts);
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

function providerToolAllowed(
  tool: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  sourceConfigs: Record<string, unknown>
): boolean {
  const name = typeof tool.name === 'string' ? tool.name : '';
  const source = asRecord(tool.source);
  if (source?.kind !== 'mcp' || typeof source.sourceId !== 'string' || !source.sourceId.trim()) {
    return allowed.has(name);
  }
  const config = asRecord(sourceConfigs[source.sourceId]);
  if (!config || config.enabled !== true) return allowed.has(name);
  const disabled = Array.isArray(config.disabledTools)
    ? config.disabledTools.filter((value): value is string => typeof value === 'string')
    : [];
  return !disabled.includes(name);
}

function isSegmentPrefix(
  prefix: readonly MaterializedContextSegment[],
  complete: readonly MaterializedContextSegment[]
): boolean {
  return prefix.length <= complete.length && prefix.every((segment, index) =>
    segment.segmentId === complete[index]?.segmentId
  );
}

function compareRequestsNewestFirst(left: DomainRow, right: DomainRow): number {
  const leftTime = timestamp(left.updated_at) || timestamp(left.created_at);
  const rightTime = timestamp(right.updated_at) || timestamp(right.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftSeq = nonNegativeBigInt(left.request_seq);
  const rightSeq = nonNegativeBigInt(right.request_seq);
  return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
}

export function providerPromptTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  return firstTokenCount(usage, ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens']);
}

export function providerTotalTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  const explicit = firstTokenCount(usage, ['totalTokenCount', 'total_tokens', 'totalTokens']);
  if (explicit !== undefined) return explicit;
  const input = firstTokenCount(usage, ['promptTokenCount', 'prompt_tokens', 'input_tokens', 'inputTokens']);
  const output = firstTokenCount(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
  return input !== undefined && output !== undefined ? input + output : undefined;
}

export function compressionOutputTokens(value: unknown): number | undefined {
  const usage = usageRecord(value);
  return firstTokenCount(usage, ['candidatesTokenCount', 'completion_tokens', 'output_tokens', 'outputTokens']);
}

function usageRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

function firstTokenCount(value: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const parsed = optionalTokenCount(value[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) && estimated > 0 ? Math.ceil(estimated) : 0;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(safeJsonString(value));
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function parseNestedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function dataUrlBase64(value: string): string {
  const comma = value.indexOf(',');
  return comma >= 0 ? value.slice(comma + 1) : value;
}

function optionalTokenCount(value: unknown): number | undefined {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is outside the safe integer range.`);
  return value;
}

function requireSegmentCount(value: number, total: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > total) {
    throw new RangeError(`segmentCount must be from 1 to ${Math.max(1, total)}.`);
  }
  return value;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeBigInt(value: unknown): bigint {
  return typeof value === 'bigint' && value >= 0n ? value : 0n;
}

import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart,
  type MessageContent
} from '../../../shared/protocol';
import type { ContentAddressedStore, ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import {
  LogicalMessageContentReader,
  NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE,
  type NativeMessageBlock
} from '../../reliableKernel/logicalMessageContent';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import type { RuntimeDatabase } from '../../reliableKernel/runtimeDatabase';

const HISTORY_PREVIEW_SUMMARY_LIMIT = 256;
const HISTORY_PREVIEW_SUMMARY_CHARACTERS = 4096;

interface HistoryPreviewSummary {
  visibleText: string;
  thoughtText: string;
  toolNames: string[];
  responseNames: string[];
  toolText: string;
  responseText: string;
  hasAttachments: boolean;
  hasParts: boolean;
}

interface HistoryPartPreview {
  visibleText: string;
  thoughtText: string;
  toolName?: string;
  responseName?: string;
  hasAttachments: boolean;
}

/** Sidebar-only summaries of immutable items and their existing block prefixes. */
export class ConversationHistoryContentReader {
  private readonly messageContents: LogicalMessageContentReader;
  private readonly blockPreviews = new Map<string, HistoryPreviewSummary>();
  private readonly itemPreviews = new Map<string, HistoryPartPreview[]>();

  public constructor(private readonly database: Pick<RuntimeDatabase, 'snapshot'>,
    contentStore: Pick<ContentAddressedStore, 'read' | 'readMany' | 'readChunk'>) {
    this.messageContents = new LogicalMessageContentReader(database, contentStore);
  }

  public async read(metadata: ContentObjectMetadata): Promise<{ preview?: string; titleContent?: MessageContent }> {
    if (metadata.content_type !== NATIVE_MESSAGE_COMPOSITION_CONTENT_TYPE) {
      return conversationHistoryPresentationFromBytes(await this.messageContents.read(metadata), metadata.content_type);
    }
    const root = await this.messageContents.readComposition(metadata);
    let next: string | null = root.tailBlockContentObjectId;
    let summary = emptyHistoryPreview();
    const pending: Array<{ id: string; block: NativeMessageBlock }> = [];
    while (next) {
      const cached = this.cached(this.blockPreviews, next);
      if (cached) { summary = cached; break; }
      const block = await this.messageContents.readBlock(next);
      pending.push({ id: next, block });
      next = block.previousBlockContentObjectId;
    }
    for (const { id, block } of pending.reverse()) {
      if (summary.visibleText.length <= 180) {
        summary = { ...summary, toolNames: [...summary.toolNames], responseNames: [...summary.responseNames] };
        const missing = [...new Set(block.items.flatMap(item => this.itemPreviews.has(item.contentObjectId)
          ? [] : [item.contentObjectId]))];
        const contentRows = missing.length ? (await this.database.snapshot(missing.map(contentId =>
          DOMAIN_REPOSITORIES.domain('ContentObject').get(contentId)))).snapshot : [];
        const contents = new Map(missing.flatMap((contentId, index) => {
          const row = contentRows[index];
          return row && !Array.isArray(row) ? [[contentId, row as ContentObjectMetadata] as const] : [];
        }));
        for (const item of block.items) {
          // An append cannot change the first 177 visible characters once truncation is known.
          if (summary.visibleText.length > 180) break;
          let parts = this.cached(this.itemPreviews, item.contentObjectId);
          if (!parts) {
            const content = contents.get(item.contentObjectId);
            if (!content) throw new Error(`History preview ContentObject ${item.contentObjectId} is unavailable.`);
            const message = decodeConversationHistoryContent((await this.messageContents.read(content)).toString('utf8'));
            if (!message) throw new Error(`History preview ContentObject ${item.contentObjectId} is not MessageContent.`);
            parts = message.parts.map(historyPartPreview);
            this.remember(this.itemPreviews, item.contentObjectId, parts, parts.reduce((size, part) => size
              + part.visibleText.length + part.thoughtText.length + (part.toolName?.length ?? 0)
              + (part.responseName?.length ?? 0) + 1, 0));
          }
          for (const part of parts) appendHistoryPart(summary, part);
        }
      }
      this.remember(this.blockPreviews, id, summary, summary.visibleText.length + summary.thoughtText.length
        + summary.toolText.length + summary.responseText.length
        + [...summary.toolNames, ...summary.responseNames].reduce((size, name) => size + name.length, 0));
    }
    return { preview: renderHistoryPreview(summary) };
  }

  private cached<T>(cache: Map<string, T>, id: string): T | undefined {
    const value = cache.get(id);
    if (value !== undefined) { cache.delete(id); cache.set(id, value); }
    return value;
  }

  private remember<T>(cache: Map<string, T>, id: string, value: T, characters: number): void {
    // Text is capped at the preview boundary. Unusually whitespace-heavy tool names may be
    // longer before normalization; do not retain them merely to reproduce exact name deduplication.
    if (characters > HISTORY_PREVIEW_SUMMARY_CHARACTERS) return;
    cache.delete(id); cache.set(id, value);
    if (cache.size > HISTORY_PREVIEW_SUMMARY_LIMIT) cache.delete(cache.keys().next().value!);
  }
}

export const CHILD_HISTORY_STATUS = {
  running: '运行中',
  awaitingParent: '等待主 Agent 接收',
  deliveryFailed: '答案交付失败',
  interrupted: '已中断'
} as const;

export type ChildConversationHistoryState =
  | 'running'
  | 'awaiting_parent'
  | 'completed'
  | 'delivery_failed'
  | 'interrupted';

export interface ChildConversationHistoryFacts {
  turns: readonly DomainRow[];
  leases: readonly DomainRow[];
  childExecutions: readonly DomainRow[];
  activeTurnLinks: readonly DomainRow[];
  answerBridges: readonly DomainRow[];
  inboxItems: readonly DomainRow[];
  deliveries: readonly DomainRow[];
  deliveryWakes: readonly DomainRow[];
  deliveryInputLinks: readonly DomainRow[];
}

export interface ChildConversationHistoryProjection {
  state: ChildConversationHistoryState;
  isRunning: boolean;
  runStatusLabel?: string;
}

/**
 * Derive the sidebar state from the independent ChildExecution/answer/delivery facts.
 *
 * In particular, a generic active Turn is not enough to keep a child marked as running: the
 * ChildExecutionActiveTurnLink, active Turn and matching ExecutionLease must all agree. Likewise,
 * parent handling is only complete when the exact RuntimeDeliveryInputLink has handled_at.
 */
export function projectChildConversationHistory(
  conversationId: string,
  facts: ChildConversationHistoryFacts
): ChildConversationHistoryProjection | undefined {
  const child = facts.childExecutions.find((row) => row.child_conversation_id === conversationId);
  if (!child) return undefined;

  const childExecutionId = String(child.id);
  const bridge = facts.answerBridges.find((row) => row.child_execution_id === childExecutionId);
  const childStatus = text(child.status);
  if (
    childStatus === 'interrupting'
    || childStatus === 'interrupted'
    || bridge?.status === 'interrupted'
  ) {
    return {
      state: 'interrupted',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.interrupted
    };
  }
  const activeLink = facts.activeTurnLinks.find((row) => row.child_execution_id === childExecutionId);
  const activeTurnId = text(activeLink?.turn_id);
  const activeTurn = activeTurnId
    ? facts.turns.find((row) => row.id === activeTurnId && row.status === 'active')
    : undefined;
  const activeLease = activeTurnId
    ? facts.leases.find((row) => row.turn_id === activeTurnId && row.conversation_id === conversationId)
    : undefined;
  if (activeLink && activeTurn && activeLease) {
    return { state: 'running', isRunning: true, runStatusLabel: CHILD_HISTORY_STATUS.running };
  }

  const submissionId = text(bridge?.current_submission_id);
  if (!submissionId) {
    // An idle/resumable child has not submitted anything to deliver. Absence of a submission is
    // therefore not a failed RuntimeDelivery fact.
    return { state: 'completed', isRunning: false };
  }

  const inbox = facts.inboxItems.find((row) =>
    row.source_kind === 'answer_submission' && row.source_id === submissionId
  );
  if (!inbox) {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }

  const delivery = latestDelivery(facts.deliveries.filter((row) => row.inbox_item_id === inbox.id));
  // No RuntimeDelivery means the answer directly settled a foreground run_agent wait. The
  // AnswerSubmission transaction itself is then the durable completion fact.
  if (!delivery) return { state: 'completed', isRunning: false };

  if (delivery.state === 'failed') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  // notify_only is deliberately not a parent-model input. Once the answer has a durable delivery
  // fact the child result is retained for history/read_agent_answer, even if the best-effort UI
  // notification acknowledgement has not run yet. It must never masquerade as parent handling.
  if (delivery.phase === 'notify_only') return { state: 'completed', isRunning: false };
  if (delivery.state === 'pending') {
    return {
      state: 'awaiting_parent',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.awaitingParent
    };
  }
  if (delivery.state !== 'consumed') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }

  const inputLink = facts.deliveryInputLinks.find((row) => row.delivery_id === delivery.id);
  if (inputLink && text(inputLink.handled_at)) return { state: 'completed', isRunning: false };
  const wake = facts.deliveryWakes.find((row) => row.delivery_id === delivery.id);
  if (wake?.state === 'dead_letter') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  const targetTurnId = text(delivery.target_turn_id);
  if (targetTurnId && facts.turns.some((row) => row.id === targetTurnId && row.status === 'terminated')) {
    // consumed only proves that the input row was injected. A terminal target plus a missing exact
    // handled_at proves the model never acknowledged that input; continuing to show awaiting_parent
    // would create the permanent stuck state observed in the field.
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  return {
    state: 'awaiting_parent',
    isRunning: false,
    runStatusLabel: CHILD_HISTORY_STATUS.awaitingParent
  };
}

/** Produce a bounded, user-facing preview from an immutable MessageContent object. */
export function conversationHistoryPreview(content: MessageContent): string {
  const summary = emptyHistoryPreview();
  for (const part of content.parts) {
    appendHistoryPart(summary, historyPartPreview(part));
    if (summary.visibleText.length > 180) break;
  }
  return renderHistoryPreview(summary);
}

function emptyHistoryPreview(): HistoryPreviewSummary {
  return { visibleText: '', thoughtText: '', toolNames: [], responseNames: [], toolText: '', responseText: '',
    hasAttachments: false, hasParts: false };
}

function historyPartPreview(part: MessageContent['parts'][number]): HistoryPartPreview {
  return {
    visibleText: isTextPart(part) && part.thought !== true ? previewTextPrefix(part.text) : '',
    thoughtText: isTextPart(part) && part.thought === true ? previewTextPrefix(part.text) : '',
    ...(isFunctionCallPart(part) ? { toolName: part.functionCall.name.trim() } : {}),
    ...(isFunctionResponsePart(part) ? { responseName: part.functionResponse.name.trim() } : {}),
    hasAttachments: isInlineDataPart(part) || isFileDataPart(part)
  };
}

function appendHistoryPart(summary: HistoryPreviewSummary, part: HistoryPartPreview): void {
  const appendText = (left: string, right: string): string => left.length > 180 || !right ? left
    : (left ? `${left} ${right}` : right).slice(0, 181);
  summary.visibleText = appendText(summary.visibleText, part.visibleText);
  summary.thoughtText = appendText(summary.thoughtText, part.thoughtText);
  const appendName = (names: string[], text: string, name: string | undefined, label: string): string => {
    if (!name || text.length > 180 || names.includes(name)) return text;
    names.push(name);
    const value = previewTextPrefix(`${label}${names.join('、')}`);
    if (value.length > 180) names.length = 0;
    return value;
  };
  summary.toolText = appendName(summary.toolNames, summary.toolText, part.toolName, '调用工具：');
  summary.responseText = appendName(summary.responseNames, summary.responseText, part.responseName, '工具结果：');
  summary.hasAttachments ||= part.hasAttachments;
  summary.hasParts = true;
}

function renderHistoryPreview(summary: HistoryPreviewSummary): string {
  if (summary.visibleText) return renderPreviewPrefix(summary.visibleText);
  if (summary.toolText) return renderPreviewPrefix(summary.toolText);
  if (summary.responseText) return renderPreviewPrefix(summary.responseText);
  if (summary.thoughtText) return normalizePreview(`思考：${renderPreviewPrefix(summary.thoughtText)}`);
  if (summary.hasAttachments) return '附件消息';
  return summary.hasParts ? '结构化消息' : '消息未包含可显示内容';
}

function previewTextPrefix(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 181);
}

function renderPreviewPrefix(value: string): string {
  return value.length > 180 ? `${value.slice(0, 177)}…` : value;
}

export function decodeConversationHistoryContent(value: string): MessageContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return conversationHistoryContentFromParsed(parsed);
}

function conversationHistoryContentFromParsed(parsed: unknown): MessageContent | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.parts)) return undefined;
  return {
    role: record.role === 'model' ? 'model' : 'user',
    parts: record.parts as MessageContent['parts']
  };
}

/** One decoded immutable object supplies both sidebar title and preview. */
export function conversationHistoryPresentationFromBytes(
  bytes: Buffer,
  contentType: string
): { preview?: string; titleContent?: MessageContent } {
  const source = bytes.toString('utf8');
  if (contentType.toLowerCase().startsWith('text/plain')) {
    const titleContent: MessageContent = { role: 'user', parts: source ? [{ text: source }] : [] };
    return { preview: conversationHistoryPreview(titleContent), titleContent };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {};
  }
  const titleContent = conversationHistoryContentFromParsed(parsed);
  if (titleContent) return { preview: conversationHistoryPreview(titleContent), titleContent };
  if (contentType === 'application/vnd.limcode.message+json') return {};
  if (!parsed || typeof parsed !== 'object') return source.trim() ? { preview: '结构化消息' } : {};
  const record = Array.isArray(parsed) ? undefined : parsed as Record<string, unknown>;
  if (record && ('inlineData' in record || 'fileData' in record || 'attachment' in record)) return { preview: '附件消息' };
  if (record && ('toolCallId' in record || 'toolName' in record || 'detail' in record)) return { preview: '工具结果' };
  return { preview: '结构化消息' };
}

/** Decode the canonical first-user content used by the shared conversation title formatter. */
export function conversationHistoryTitleContentFromBytes(
  bytes: Buffer,
  contentType: string
): MessageContent | undefined {
  const source = bytes.toString('utf8');
  if (contentType.toLowerCase().startsWith('text/plain')) {
    return { role: 'user', parts: source ? [{ text: source }] : [] };
  }
  return decodeConversationHistoryContent(source);
}

function latestDelivery(rows: readonly DomainRow[]): DomainRow | undefined {
  return [...rows].sort((left, right) =>
    compareInteger(right.attempt_seq, left.attempt_seq)
      || timestamp(right.updated_at) - timestamp(left.updated_at)
      || String(right.id).localeCompare(String(left.id))
  )[0];
}

function compareInteger(left: unknown, right: unknown): number {
  const leftValue = integer(left);
  const rightValue = integer(right);
  return leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
}

function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePreview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

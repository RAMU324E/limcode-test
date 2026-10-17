import type { ModelOutputItemReference } from '@shared/protocol';
import type { ReliableKernelDetailState } from '@webview/stores/useReliableKernelClientFeedStore';

export const MESSAGE_CONTENT_ITEM_PAGE_SIZE = 32;

export interface ReliableCommittedContentItem {
  id: string;
  sequence: number;
  revisionId: string;
  contentObjectId: string;
  partByteLength: number;
  outputItem?: ModelOutputItemReference;
}
export interface ReliableMessageContentItemPage {
  key: string;
  indexRevisionId: string;
  totalItems: number;
  totalBytes: number;
  items: readonly ReliableCommittedContentItem[];
  nextSequence?: number;
}
export interface ReliableMessageContentWindow {
  indexRevisionId: string;
  pages: readonly ReliableMessageContentItemPage[];
  currentAfterSequence?: number;
  currentPageKey?: string;
  followTail: boolean;
}
export interface ReliableMessageContentWindowPresentation {
  firstSequence: number;
  lastSequence: number;
  totalItems: number;
  loading: boolean;
  error?: string;
  canRetry?: boolean;
}

export function reliableMessageContentItemsKey(revisionId: string, afterSequence?: number): string {
  return `message-content-items:${revisionId}:${afterSequence === undefined ? 'tail' : afterSequence}`;
}

/** Item metadata is immutable identity/order only. Its body remains in the common detail cache. */
export function parseReliableMessageContentItemPage(
  text: string, key: string, indexRevisionId: string
): ReliableMessageContentItemPage {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.totalItems) || Number(raw.totalItems) < 0
    || !Number.isSafeInteger(raw.totalBytes) || Number(raw.totalBytes) < 0 || !Array.isArray(raw.items)
    || raw.items.length > 96) throw new Error('消息内容块页面格式无效。');
  const items: ReliableCommittedContentItem[] = [];
  let previousSequence = 0;
  for (const candidate of raw.items) {
    const item = candidate as ReliableCommittedContentItem;
    if (!item || typeof item.id !== 'string' || !item.id || item.revisionId !== item.id
      || typeof item.contentObjectId !== 'string' || !item.contentObjectId
      || !Number.isSafeInteger(item.sequence) || item.sequence <= previousSequence || item.sequence > Number(raw.totalItems)
      || !Number.isSafeInteger(item.partByteLength) || item.partByteLength < 0) throw new Error('消息内容块顺序无效。');
    previousSequence = item.sequence;
    items.push(item);
  }
  if (raw.nextSequence !== undefined && (!Number.isSafeInteger(raw.nextSequence)
    || raw.nextSequence !== previousSequence || Number(raw.nextSequence) >= Number(raw.totalItems))) throw new Error('消息内容块分页游标无效。');
  return { key, indexRevisionId, totalItems: Number(raw.totalItems), totalBytes: Number(raw.totalBytes), items,
    ...(raw.nextSequence === undefined ? {} : { nextSequence: Number(raw.nextSequence) }) };
}

export function residentReliableMessageContentItems(window: ReliableMessageContentWindow): ReliableCommittedContentItem[] {
  const items = new Map<number, ReliableCommittedContentItem>();
  for (const page of window.pages) for (const item of page.items) items.set(item.sequence, item);
  return [...items.values()].sort((left, right) => left.sequence - right.sequence);
}

/** A page selection survives retry; the common detail cache owns its read lifecycle. */
export function reliableMessageContentWindowState(
  window: ReliableMessageContentWindow | undefined,
  indexRevisionId: string,
  details: Readonly<Record<string, ReliableKernelDetailState>>
): { items: ReliableCommittedContentItem[]; ready: boolean; presentation: ReliableMessageContentWindowPresentation } {
  if (!window) return { items: [], ready: false,
    presentation: { firstSequence: 0, lastSequence: 0, totalItems: 0, loading: true } };
  const items = residentReliableMessageContentItems(window);
  const selectedKey = reliableMessageContentItemsKey(window.indexRevisionId, window.currentAfterSequence);
  const selectedPage = window.pages.find(page => page.key === selectedKey && page.indexRevisionId === indexRevisionId);
  const metadata = details[selectedKey];
  const itemDetails = items.map(item => details[`message-content-item:${item.contentObjectId}`]);
  const indexReady = Boolean(selectedPage && (!window.followTail
    || selectedPage.items[selectedPage.items.length - 1]?.sequence === selectedPage.totalItems));
  const ready = indexReady && itemDetails.every(detail => detail?.status === 'ready');
  const failed = [metadata, ...itemDetails].filter(detail => detail?.status === 'error');
  const error = failed.length > 0 ? failed[0]?.error?.trim() || '读取消息内容失败，请重试。' : undefined;
  return { items, ready, presentation: {
    firstSequence: items[0]?.sequence ?? 0, lastSequence: items[items.length - 1]?.sequence ?? 0,
    totalItems: window.pages.reduce((maximum, page) => Math.max(maximum, page.totalItems), 0),
    loading: metadata?.status === 'loading' || (!ready && !error),
    ...(error ? { error, canRetry: failed.some(detail => !detail?.terminalError) } : {})
  } };
}

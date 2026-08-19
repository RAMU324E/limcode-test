import type { RuntimeCommitResult } from '../../reliableKernel/contracts';
import { EXTENSION_BRAND } from '../../../shared/extensionIdentity';

export const INTERACTION_ATTENTION_ACTION = '打开标签页';

export type InteractionAttentionKind = 'ask_user' | 'plan_review';

export interface PendingInteractionAttention {
  requestId: string;
  kind: InteractionAttentionKind;
  conversationId: string;
  conversationTitle?: string;
  createdAt: number;
}

export interface InteractionAttentionHost {
  showInformationMessage(message: string, action: string): PromiseLike<string | undefined>;
  openConversation(request: { conversationId: string; conversationTitle?: string }): PromiseLike<unknown>;
  onError?(error: unknown): void;
}

interface InteractionAttentionGroup {
  key: string;
  kind: InteractionAttentionKind;
  conversationId: string;
  conversationTitle?: string;
  count: number;
  createdAt: number;
}

const INTERACTION_ATTENTION_DOMAINS = new Set([
  'InteractionRequest',
  'InteractionOwnerLink',
  'InteractionToolCallLink'
]);

/** Returns true when a committed batch may have changed a pending user decision. */
export function runtimeCommitNeedsInteractionAttention(
  commit: Pick<RuntimeCommitResult, 'changes'>
): boolean {
  return commit.changes.some((change) => INTERACTION_ATTENTION_DOMAINS.has(change.domain));
}

/** Extension Host-local notification dedupe; reliable Interaction rows remain the decision authority. */
export class InteractionAttentionNotifier {
  private readonly activeRequestIds = new Set<string>();

  public constructor(private readonly host: InteractionAttentionHost) {}

  public synchronize(requests: readonly PendingInteractionAttention[]): void {
    const ordered = [...requests].sort((left, right) =>
      left.createdAt - right.createdAt || left.requestId.localeCompare(right.requestId)
    );
    const pendingRequestIds = new Set(ordered.map((request) => request.requestId));
    for (const requestId of this.activeRequestIds) {
      if (!pendingRequestIds.has(requestId)) this.activeRequestIds.delete(requestId);
    }

    const newGroupKeys = new Set<string>();
    for (const request of ordered) {
      if (!this.activeRequestIds.has(request.requestId)) {
        newGroupKeys.add(groupKey(request));
      }
      this.activeRequestIds.add(request.requestId);
    }

    for (const group of groupPendingAttention(ordered)) {
      if (!newGroupKeys.has(group.key)) continue;
      void Promise.resolve(this.host.showInformationMessage(
        interactionAttentionMessage(group),
        INTERACTION_ATTENTION_ACTION
      )).then((selection) => {
        if (selection !== INTERACTION_ATTENTION_ACTION) return undefined;
        return this.host.openConversation({
          conversationId: group.conversationId,
          ...(group.conversationTitle ? { conversationTitle: group.conversationTitle } : {})
        });
      }).catch((error) => this.host.onError?.(error));
    }
  }

  public clear(): void {
    this.activeRequestIds.clear();
  }
}

export function interactionAttentionMessage(
  request: Pick<InteractionAttentionGroup, 'kind' | 'conversationTitle' | 'count'>
): string {
  const title = compactText(request.conversationTitle?.trim() || '当前对话', 36);
  if (request.kind === 'ask_user') {
    return request.count > 1
      ? `${EXTENSION_BRAND}：标签页“${title}”有 ${request.count} 个问题等待回答。`
      : `${EXTENSION_BRAND}：标签页“${title}”有问题等待回答。`;
  }
  return request.count > 1
    ? `${EXTENSION_BRAND}：标签页“${title}”有 ${request.count} 个 Plan 等待审批。`
    : `${EXTENSION_BRAND}：标签页“${title}”有 Plan 等待审批。`;
}

function groupPendingAttention(requests: readonly PendingInteractionAttention[]): InteractionAttentionGroup[] {
  const groups = new Map<string, InteractionAttentionGroup>();
  for (const request of requests) {
    const key = groupKey(request);
    const current = groups.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    groups.set(key, {
      key,
      kind: request.kind,
      conversationId: request.conversationId,
      ...(request.conversationTitle ? { conversationTitle: request.conversationTitle } : {}),
      count: 1,
      createdAt: request.createdAt
    });
  }
  return [...groups.values()].sort((left, right) =>
    left.createdAt - right.createdAt || left.key.localeCompare(right.key)
  );
}

function groupKey(request: Pick<PendingInteractionAttention, 'kind' | 'conversationId'>): string {
  return `${request.kind}:${request.conversationId}`;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 1))}…` : text;
}

import { submitPlanRequestFromArgs } from '../../shared/planReview';
import { SUBMIT_PLAN_TOOL_NAME } from '../../shared/protocol';
import { EXTENSION_BRAND } from '../../shared/extensionIdentity';
import type { WorldReader } from '../ecs/types';
import { runForToolCall, runTarget } from '../world/modules/agentRun/queries';
import { Conversation } from '../world/modules/chat/components';
import { OpenConversationPanelIdsKey } from '../world/modules/chat/resources';
import { ToolCall, ToolState } from '../world/modules/tools/components';
import { ConversationAttentionTracker, compactAttentionText } from './conversationAttention';

export interface PendingPlanReviewAttention {
  conversationId: string;
  conversationTitle?: string;
  planCount: number;
  firstPlan?: string;
  firstCreatedAt: number;
}

/**
 * 按执行 Turn 的目标 Conversation 聚合待审批 Plan。
 * Interaction 是唯一审批权威；本函数只从已投影的等待态生成提醒，不决定或自动提交审批结果。
 */
export function collectPendingPlanReviewAttention(world: WorldReader): PendingPlanReviewAttention[] {
  const openConversationIds = new Set(world.tryGetResource(OpenConversationPanelIdsKey) ?? []);
  if (openConversationIds.size === 0) return [];

  const grouped = new Map<string, PendingPlanReviewAttention>();
  for (const entity of world.query(ToolCall, ToolState)) {
    const call = world.get(entity, ToolCall);
    const state = world.get(entity, ToolState);
    if (!call || state?.status !== 'awaiting_user_input' || call.name !== SUBMIT_PLAN_TOOL_NAME) continue;
    if (!isWaitingForPlanReview(state.progress)) continue;

    const run = runForToolCall(world, entity);
    const target = run === undefined ? undefined : runTarget(world, run);
    const conversation = target ? world.get(target.conversation, Conversation) : undefined;
    const conversationId = conversation?.id;
    if (!conversationId || !openConversationIds.has(conversationId)) continue;

    const request = submitPlanRequestFromArgs(call.argsJson);
    const existing = grouped.get(conversationId);
    if (existing) {
      existing.planCount += 1;
      if (call.createdAt < existing.firstCreatedAt) {
        existing.firstCreatedAt = call.createdAt;
        existing.firstPlan = request?.plan;
      }
      continue;
    }

    grouped.set(conversationId, {
      conversationId,
      ...(conversation.title?.trim() ? { conversationTitle: conversation.title.trim() } : {}),
      planCount: 1,
      ...(request?.plan ? { firstPlan: request.plan } : {}),
      firstCreatedAt: call.createdAt
    });
  }

  return [...grouped.values()].sort((left, right) =>
    left.firstCreatedAt - right.firstCreatedAt || left.conversationId.localeCompare(right.conversationId)
  );
}

/** 与 ask_user 共用连续等待仅提醒一次的 tracker 实现。 */
export class PlanReviewAttentionTracker extends ConversationAttentionTracker<PendingPlanReviewAttention> {}

export function planReviewAttentionMessage(request: PendingPlanReviewAttention): string {
  const tabLabel = request.conversationTitle?.trim() || '当前对话';
  if (request.planCount > 1) {
    return `${EXTENSION_BRAND}：标签页“${compactAttentionText(tabLabel, 36)}”有 ${request.planCount} 个 Plan 等待审批。`;
  }
  const plan = request.firstPlan?.trim();
  return plan
    ? `${EXTENSION_BRAND} 需要你审批 Plan：${compactAttentionText(plan, 96)}`
    : `${EXTENSION_BRAND}：标签页“${compactAttentionText(tabLabel, 36)}”有 Plan 等待审批。`;
}

function isWaitingForPlanReview(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  return progress.waitingFor === 'plan_review'
    && typeof progress.planProposalId === 'string'
    && !!progress.planProposalId.trim();
}

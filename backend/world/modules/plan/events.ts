import type { PlanReviewPolicyScopeClearPayload, PlanReviewPolicyScopeSetPayload } from '../../../../shared/protocol';

/** PlanProposal 只保留策略配置事件；审批响应统一走可靠 Interaction 命令。 */
export const PlanReviewEventType = {
  PolicyScopeSetRequested: 'planReview:policyScopeSetRequested',
  PolicyScopeClearRequested: 'planReview:policyScopeClearRequested'
} as const;

declare module '@backend/world/events' {
  interface WorldEventPayloadMap {
    'planReview:policyScopeSetRequested': PlanReviewPolicyScopeSetPayload;
    'planReview:policyScopeClearRequested': PlanReviewPolicyScopeClearPayload;
  }
}

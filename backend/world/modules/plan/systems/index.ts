import type { Scheduler } from '../../../../ecs/Scheduler';
import { PlanReviewPolicyScopeSystem } from './PlanReviewPolicyScopeSystem';

/** Plan 审批生命周期由统一 Interaction 状态机拥有；ECS 仅投影作用域策略。 */
export function registerPlanReviewSystems(scheduler: Scheduler): void {
  scheduler.addMany([PlanReviewPolicyScopeSystem]);
}

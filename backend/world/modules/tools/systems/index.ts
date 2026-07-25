import type { Scheduler } from '../../../../ecs/Scheduler';
import { ToolCallPreviewSystem } from './ToolCallPreviewSystem';
import { ToolPollSystem } from './ToolPollSystem';
import { ToolPolicyScopeSystem } from './ToolPolicyScopeSystem';

/**
 * Tool 生命周期由可靠事务控制面拥有；ECS 仅保留策略投影、瞬态预览与 runtime event 投影。
 */
export function registerToolSystems(scheduler: Scheduler): void {
  scheduler.addMany([ToolPolicyScopeSystem, ToolCallPreviewSystem, ToolPollSystem]);
}

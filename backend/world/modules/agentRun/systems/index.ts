import type { Scheduler } from '../../../../ecs/Scheduler';

/** AgentRun 是可靠 Turn 的只读兼容投影，不再拥有任何生命周期或队列 System。 */
export function registerAgentRunSystems(_scheduler: Scheduler): void {}

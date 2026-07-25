import type { Scheduler } from '../../../../ecs/Scheduler';
import { LlmPollSystem } from './LlmPollSystem';

/** LLM 派发由可靠 effect dispatcher 拥有；ECS 只消费并投影 provider 流事件。 */
export function registerChatSystems(scheduler: Scheduler): void {
  scheduler.addMany([LlmPollSystem]);
}

import type { CommandSink, Entity } from '../../../ecs/types';
import { nextAuxiliaryId } from '../../../reliability/stableIdFactory';
import { ToolCallRunLink } from './components';

/**
 * ToolCallRunLink 是可靠 ToolCall/Turn 投影之间的独立关系；其生命周期不创建或推进 AgentRun。
 */
export function spawnToolCallRunLink(cmd: CommandSink, input: { toolCall: Entity; run: Entity }): Entity {
  const entity = cmd.spawn();
  const now = Date.now();
  cmd.add(entity, ToolCallRunLink, {
    id: nextAuxiliaryId('tcrl'),
    toolCall: input.toolCall,
    run: input.run,
    role: 'produced_by',
    createdAt: now,
    updatedAt: now
  });
  return entity;
}

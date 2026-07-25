import type { AgentSource } from '../../../../shared/protocol';
import { isUuidV7 } from '../../../../shared/stableIds';
import type { Entity, WorldReader } from '../../../ecs/types';
import { Agent, AgentKind } from './components';

export function projectedAgentSource(source: AgentSource): AgentSource {
  return source;
}

export function isTemporaryAgentEntity(world: WorldReader, agent: Entity): boolean {
  const data = world.get(agent, Agent);
  const kind = world.get(agent, AgentKind)?.kind;
  return !!data?.id && !!kind && isRunAgentTemporaryId(data.id, kind);
}

export function agentTypeEntityForRuntimeAgent(world: WorldReader, agent: Entity): Entity {
  const typeId = world.get(agent, AgentKind)?.kind;
  if (!typeId || !isTemporaryAgentEntity(world, agent)) return agent;
  return findAgentTypeEntity(world, typeId) ?? agent;
}

export function findAgentTypeEntity(world: WorldReader, selector: string): Entity | undefined {
  const exact = world.entityByRecordId(Agent, selector);
  if (exact !== undefined && !isTemporaryAgentEntity(world, exact)) return exact;
  const matches = world.query(Agent).filter((entity) => !isTemporaryAgentEntity(world, entity)
    && world.get(entity, AgentKind)?.kind === selector);
  if (matches.length > 1) throw new Error(`Agent type selector is ambiguous: ${selector}`);
  return matches[0];
}

export function isRunAgentTemporaryId(id: string, kind: string): boolean {
  const slug = agentSelectorSlug(kind);
  const stablePrefix = `agent${slug.replace(/[^a-z0-9]/g, '')}_`;
  if (id.startsWith(stablePrefix) && isUuidV7(id.slice(stablePrefix.length))) return true;
  const legacyPrefix = `agent-${slug}-`;
  return id.startsWith(legacyPrefix) && /^[a-z0-9]+-[a-z0-9]{8}$/.test(id.slice(legacyPrefix.length));
}

export function agentSelectorSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'default';
}

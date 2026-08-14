import type { WorldReader } from '../../../ecs/types';
import type { ToolSchema } from '../llm/contracts';
import { AgentBlueprintsKey, type BuiltinAgentDefinition, type BuiltinAgentRegistry } from '../agent/blueprints';
import { Agent, AgentKind } from '../agent/components';
import { isTemporaryAgentEntity } from '../agent/identity';
import type { ToolSchemaContributor } from './schemaContributors';
import { RUN_AGENT_TOOL_NAME } from './definitions/runAgent';
import { augmentRunAgentToolSchema, formatAgentTypeList, type AgentTypeListEntry } from './runAgentTypeDescription';

export const runAgentToolSchemaContributor: ToolSchemaContributor = {
  key: 'run-agent-blueprint-types',
  reads: { components: [Agent, AgentKind], resources: [AgentBlueprintsKey] },
  augment(tools, context) {
    const blueprints = context.world.tryGetResource(AgentBlueprintsKey);
    if (!blueprints) return tools;
    const typeList = formatAgentTypeList(agentTypeEntries(context.world, blueprints));
    if (!typeList) return tools;
    return tools.map((tool) => tool.name === RUN_AGENT_TOOL_NAME ? augmentRunAgentToolSchema(tool, typeList) : tool);
  }
};

function agentTypeEntries(world: WorldReader, blueprints: BuiltinAgentRegistry): AgentTypeListEntry[] {
  const entries: AgentTypeListEntry[] = [];
  const seen = new Set<string>();

  for (const entity of world.query(Agent).sort((left, right) => left - right)) {
    if (isTemporaryAgentEntity(world, entity)) continue;
    const agent = world.get(entity, Agent);
    if (!agent?.id || seen.has(agent.id)) continue;
    const kind = world.get(entity, AgentKind)?.kind;
    if (agent.source === 'builtin' && !hasBuiltinAgentDefinition(blueprints.agents, agent.id, kind)) continue;
    seen.add(agent.id);
    entries.push({ id: agent.id, label: agent.description?.trim() || agent.name.trim() });
  }

  for (const agent of Object.values(blueprints.agents)) {
    if (seen.has(agent.id) || seen.has(agent.kind)) continue;
    seen.add(agent.id);
    entries.push({ id: agent.id, label: agent.description?.trim() });
  }

  return entries;
}

function hasBuiltinAgentDefinition(agents: Record<string, BuiltinAgentDefinition>, id: string, kind: string | undefined): boolean {
  return Object.values(agents).some((definition) => definition.id === id
    || definition.kind === id
    || (!!kind && (definition.id === kind || definition.kind === kind)));
}

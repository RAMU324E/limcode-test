import { defineQuery, defineSystem, type CommandSink, type Entity, type WorldReader } from '../../../../ecs/types';
import { AgentBlueprintsKey, DEFAULT_INTEGRATED_SYSTEM_PROMPT } from '../blueprints';
import {
  AgentFromBlueprintBundle,
  hasAgentId,
  hasWorkflowId,
  linkAgentToConversation,
  linkSystemPromptToScope,
  selectAgentForConversation,
  spawnAgentProfileFromBlueprint,
  spawnWorkflowFromDefinition,
  spawnSystemPrompt
} from '../bundles';
import { Agent, AgentConversationLink, ConversationAgentSelection } from '../components';
import { Conversation } from '../../chat/components';
import { ConversationWorkflowSelection, SystemPrompt, SystemPromptScopeLink, type SystemPromptScopeLinkData } from '../../workflow/components';
import { selectDefaultWorkflowForConversation } from '../../workflow/bundles';
import { AgentSpawnRequest } from '../requests';
import type { ConfigScopeKind } from '../../../../../shared/protocol';

const DEFAULT_GLOBAL_SYSTEM_PROMPT_ID = 'system-prompt:global:integrated';
const DEFAULT_GLOBAL_SYSTEM_PROMPT_NAME = 'Integrated Global System Prompt';

const SpawnRequestsQuery = defineQuery({
  name: 'SpawnRequests',
  all: [AgentSpawnRequest],
  read: [AgentSpawnRequest],
  remove: [AgentSpawnRequest],
  mutationMode: 'consume',
  role: 'work'
});

export const AgentSpawnSystem = defineSystem({
  name: 'AgentSpawnSystem',
  shouldRun({ world }) {
    const registry = world.tryGetResource(AgentBlueprintsKey);
    if (!registry) return false;
    return world.query(AgentSpawnRequest).length > 0
      || !hasActiveSystemPromptForScope(world, 'global')
      || Object.values(registry.workflows).some((workflow) => !hasWorkflowId(world, workflow.id))
      || Object.values(registry.agents).some((agent) => !hasAgentId(world, agent.id));
  },
  access: {
    queries: [SpawnRequestsQuery],
    reads: {
      components: [
        Agent,
        AgentConversationLink,
        ConversationAgentSelection,
        Conversation,
        ConversationWorkflowSelection,
        SystemPrompt,
        SystemPromptScopeLink
      ]
    },
    resources: { read: [AgentBlueprintsKey] },
    bundles: [AgentFromBlueprintBundle]
  },
  run({ world, cmd }) {
    const registry = world.getResource(AgentBlueprintsKey);
    ensureIntegratedGlobalSystemPrompt(world, cmd);

    for (const workflow of Object.values(registry.workflows)) {
      if (!hasWorkflowId(world, workflow.id)) spawnWorkflowFromDefinition(cmd, workflow);
    }

    const agentEntities = new Map(world.query(Agent).map((entity) => [world.get(entity, Agent)!.id, entity]));
    const linkedPairs = new Set(world.query(AgentConversationLink).flatMap((entity) => {
      const link = world.get(entity, AgentConversationLink);
      const agent = link ? world.get(link.agent, Agent) : undefined;
      const conversation = link ? world.get(link.conversation, Conversation) : undefined;
      return agent && conversation ? [`${agent.id}\0${conversation.id}`] : [];
    }));
    const selectedPairs = new Set(world.query(ConversationAgentSelection).flatMap((entity) => {
      const selection = world.get(entity, ConversationAgentSelection);
      const agent = selection ? world.get(selection.agent, Agent) : undefined;
      const conversation = selection ? world.get(selection.conversation, Conversation) : undefined;
      return selection?.role === 'active' && agent && conversation ? [`${agent.id}\0${conversation.id}`] : [];
    }));
    const workflowSelectedConversationIds = new Set(world.query(ConversationWorkflowSelection).flatMap((entity) => {
      const selection = world.get(entity, ConversationWorkflowSelection);
      const conversation = selection ? world.get(selection.conversation, Conversation) : undefined;
      return selection?.role === 'active' && conversation ? [conversation.id] : [];
    }));

    const requests = world.query(AgentSpawnRequest);
    for (const entity of requests) {
      const request = world.get(entity, AgentSpawnRequest);
      if (!request) throw new Error(`AgentSpawnRequest ${entity} disappeared during its consume pass.`);

      const definition = registry.agents[request.kind]
        ?? Object.values(registry.agents).find((candidate) => candidate.kind === request.kind || candidate.id === request.kind);
      if (!definition) throw new Error(`Unknown agent blueprint: ${request.kind}`);

      const conversationId = request.conversationId.trim();
      if (!conversationId) throw new Error('AgentSpawnRequest must reference an already committed Conversation.');
      const conversation = uniqueConversation(world, conversationId);
      const agentId = request.agentId ?? definition.id;
      let agent = agentEntities.get(agentId);
      if (agent === undefined) {
        agent = spawnAgentProfileFromBlueprint(cmd, {
          definition,
          agentId,
          agentName: request.agentName
        });
        agentEntities.set(agentId, agent);
      }

      const pairKey = `${agentId}\0${conversationId}`;
      if (!linkedPairs.has(pairKey)) {
        linkAgentToConversation(cmd, { agent, conversation, role: 'default' });
        linkedPairs.add(pairKey);
      }
      if (!selectedPairs.has(pairKey)) {
        selectAgentForConversation(cmd, { agent, conversation, conversationId, agentId });
        selectedPairs.add(pairKey);
      }
      if (!workflowSelectedConversationIds.has(conversationId)) {
        selectDefaultWorkflowForConversation(cmd, conversation, conversationId);
        workflowSelectedConversationIds.add(conversationId);
      }
      cmd.despawn(entity);
    }

    if (requests.length > 0) return;
    for (const definition of Object.values(registry.agents)) {
      if (!agentEntities.has(definition.id)) {
        const agent = spawnAgentProfileFromBlueprint(cmd, { definition, agentId: definition.id });
        agentEntities.set(definition.id, agent);
      }
    }
  }
});

function uniqueConversation(world: WorldReader, conversationId: string): Entity {
  const matches = world.query(Conversation).filter((entity) => world.get(entity, Conversation)?.id === conversationId);
  if (matches.length !== 1) {
    throw new Error(`AgentSpawnRequest requires exactly one committed Conversation ${conversationId}; found ${matches.length}.`);
  }
  return matches[0];
}

function ensureIntegratedGlobalSystemPrompt(world: WorldReader, cmd: CommandSink): void {
  if (hasActiveSystemPromptForScope(world, 'global')) return;
  const prompt = spawnSystemPrompt(cmd, {
    id: DEFAULT_GLOBAL_SYSTEM_PROMPT_ID,
    name: DEFAULT_GLOBAL_SYSTEM_PROMPT_NAME,
    text: DEFAULT_INTEGRATED_SYSTEM_PROMPT
  });
  linkSystemPromptToScope(cmd, { scopeKind: 'global', systemPrompt: prompt });
}

function hasActiveSystemPromptForScope(world: WorldReader, scopeKind: ConfigScopeKind, scopeId?: string): boolean {
  return scopedPromptLinks(world, scopeKind, scopeId).some(({ link }) => !!world.get(link.systemPrompt, SystemPrompt)?.text.trim());
}

function scopedPromptLinks(world: WorldReader, scopeKind: ConfigScopeKind, scopeId: string | undefined): Array<{ entity: Entity; link: SystemPromptScopeLinkData }> {
  const links: Array<{ entity: Entity; link: SystemPromptScopeLinkData }> = [];
  for (const entity of world.query(SystemPromptScopeLink)) {
    const link = world.get(entity, SystemPromptScopeLink);
    if (!link || link.role !== 'active' || link.scopeKind !== scopeKind) continue;
    if (scopeKind === 'global') {
      links.push({ entity, link });
      continue;
    }
    if (link.scopeId === scopeId) links.push({ entity, link });
  }
  return links;
}

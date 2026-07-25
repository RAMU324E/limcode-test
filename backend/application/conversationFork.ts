import type { Entity, World } from '../ecs/types';
import {
  Agent,
  AgentConversationLink,
  ConversationAgentSelection,
  type AgentConversationLinkData
} from '../world/modules/agent/components';
import {
  Conversation,
  ConversationBranchLink,
  ConversationOriginLink,
  Message,
  MessageCurrentRevisionLink,
  PartOf
} from '../world/modules/chat/components';
import {
  ConversationWorkflowSelection,
  Workflow,
  type ConversationWorkflowSelectionData
} from '../world/modules/workflow/components';
import { ConversationProjectLink } from '../world/modules/project/components';
import { ConversationWorkEnvironmentLink } from '../world/modules/workEnvironment/components';
import { nextAuxiliaryId } from '../reliability/stableIdFactory';

export interface MaterializeForkRelationsInput {
  sourceConversationId: string;
  targetConversationId: string;
  throughMessageId: string;
  now?: number;
}

/** Materializes only independent Link objects after the target Conversation aggregate has committed. */
export function materializeForkRelationsInWorld(world: World, input: MaterializeForkRelationsInput): void {
  const sourceConversation = findConversation(world, input.sourceConversationId.trim());
  const targetConversation = findConversation(world, input.targetConversationId.trim());
  if (sourceConversation === undefined) throw new Error(`Fork source Conversation is missing: ${input.sourceConversationId}`);
  if (targetConversation === undefined) throw new Error(`Committed fork target Conversation is missing: ${input.targetConversationId}`);
  const sourceMessage = messagesForConversation(world, sourceConversation)
    .find((entity) => world.get(entity, Message)?.id === input.throughMessageId.trim());
  if (sourceMessage === undefined) throw new Error(`Fork source Message is missing: ${input.throughMessageId}`);
  const agentContext = resolveAgentContext(world, sourceConversation);
  if (!agentContext) throw new Error('Fork source has no Agent relationship to inherit.');

  const now = input.now ?? Date.now();
  cloneAgentRelations(world, targetConversation, input.targetConversationId, agentContext, now);
  cloneWorkflowSelection(world, sourceConversation, targetConversation, input.targetConversationId, now);
  cloneProjectLinks(world, sourceConversation, targetConversation, now);
  cloneWorkEnvironmentLinks(world, sourceConversation, targetConversation, now);

  const branch = world.spawn();
  const sourceRevision = currentRevisionForMessage(world, sourceMessage);
  world.add(branch, ConversationBranchLink, {
    id: nextAuxiliaryId('cbl'),
    sourceConversation,
    targetConversation,
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
    kind: 'fork',
    createdAt: now,
    updatedAt: now
  });
  const origin = world.spawn();
  world.add(origin, ConversationOriginLink, {
    id: nextAuxiliaryId('col'),
    conversation: targetConversation,
    originKind: 'user',
    sourceKind: 'user',
    createdAt: now,
    updatedAt: now
  });
}

function resolveAgentContext(world: World, sourceConversation: Entity): { selectedAgent: Entity; links: AgentConversationLinkData[] } | undefined {
  const links = world.query(AgentConversationLink)
    .map((entity) => world.get(entity, AgentConversationLink))
    .filter((link): link is AgentConversationLinkData => !!link && link.conversation === sourceConversation)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id));

  let selectedAgent: Entity | undefined;
  let selectedAt = Number.NEGATIVE_INFINITY;
  let selectedEntity = Number.NEGATIVE_INFINITY;
  for (const entity of world.query(ConversationAgentSelection)) {
    const data = world.get(entity, ConversationAgentSelection);
    if (!data || data.conversation !== sourceConversation || data.role !== 'active') continue;
    if (data.updatedAt > selectedAt || (data.updatedAt === selectedAt && entity > selectedEntity)) {
      selectedAgent = data.agent;
      selectedAt = data.updatedAt;
      selectedEntity = entity;
    }
  }

  selectedAgent ??= links.find((link) => link.role === 'default')?.agent ?? links[0]?.agent;
  if (selectedAgent === undefined || !world.has(selectedAgent, Agent)) return undefined;
  return { selectedAgent, links };
}

function cloneAgentRelations(
  world: World,
  targetConversation: Entity,
  targetConversationId: string,
  context: { selectedAgent: Entity; links: AgentConversationLinkData[] },
  now: number
): void {
  const linkedAgents = new Set<Entity>();
  for (const source of context.links) {
    if (!world.has(source.agent, Agent)) continue;
    const targetLink = world.spawn();
    world.add(targetLink, AgentConversationLink, {
      id: nextAuxiliaryId('acl'),
      agent: source.agent,
      conversation: targetConversation,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
    linkedAgents.add(source.agent);
  }
  if (!linkedAgents.has(context.selectedAgent)) {
    const targetLink = world.spawn();
    world.add(targetLink, AgentConversationLink, {
      id: nextAuxiliaryId('acl'),
      agent: context.selectedAgent,
      conversation: targetConversation,
      role: 'default',
      createdAt: now,
      updatedAt: now
    });
  }

  const agent = world.get(context.selectedAgent, Agent)!;
  const selection = world.spawn();
  world.add(selection, ConversationAgentSelection, {
    id: `conversation-agent:${targetConversationId}:${agent.id}`,
    conversation: targetConversation,
    agent: context.selectedAgent,
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function cloneWorkflowSelection(world: World, sourceConversation: Entity, targetConversation: Entity, targetConversationId: string, now: number): void {
  const selected = world.query(ConversationWorkflowSelection)
    .map((entity) => ({ entity, data: world.get(entity, ConversationWorkflowSelection) }))
    .filter((item): item is { entity: Entity; data: ConversationWorkflowSelectionData } =>
      item.data !== undefined && item.data.conversation === sourceConversation && item.data.role === 'active')
    .sort((left, right) => right.data.updatedAt - left.data.updatedAt || right.entity - left.entity)[0];
  if (!selected) return;
  const selectedWorkflow = selected.data.scopeKind === 'workflow'
    && selected.data.workflow !== undefined
    && world.has(selected.data.workflow, Workflow)
    ? selected.data.workflow
    : undefined;
  const workflowId = selectedWorkflow !== undefined ? world.get(selectedWorkflow, Workflow)?.id : undefined;
  const entity = world.spawn();
  world.add(entity, ConversationWorkflowSelection, {
    id: selectedWorkflow !== undefined && workflowId
      ? `conversation-workflow:workflow:${targetConversationId}:${workflowId}`
      : `conversation-workflow:global:${targetConversationId}`,
    conversation: targetConversation,
    scopeKind: selectedWorkflow !== undefined ? 'workflow' : 'global',
    ...(selectedWorkflow !== undefined ? { workflow: selectedWorkflow } : {}),
    role: 'active',
    createdAt: now,
    updatedAt: now
  });
}

function cloneProjectLinks(world: World, sourceConversation: Entity, targetConversation: Entity, now: number): void {
  for (const entity of world.query(ConversationProjectLink)) {
    const source = world.get(entity, ConversationProjectLink);
    if (!source || source.conversation !== sourceConversation) continue;
    const target = world.spawn();
    world.add(target, ConversationProjectLink, {
      id: nextAuxiliaryId('cpl'),
      conversation: targetConversation,
      projectContext: source.projectContext,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
  }
}

function cloneWorkEnvironmentLinks(world: World, sourceConversation: Entity, targetConversation: Entity, now: number): void {
  for (const entity of world.query(ConversationWorkEnvironmentLink)) {
    const source = world.get(entity, ConversationWorkEnvironmentLink);
    if (!source || source.conversation !== sourceConversation) continue;
    const target = world.spawn();
    world.add(target, ConversationWorkEnvironmentLink, {
      id: nextAuxiliaryId('cwel'),
      conversation: targetConversation,
      workEnvironment: source.workEnvironment,
      role: source.role,
      createdAt: now,
      updatedAt: now
    });
  }
}

function currentRevisionForMessage(world: World, message: Entity): Entity | undefined {
  return world.query(MessageCurrentRevisionLink)
    .map((entity) => ({ entity, link: world.get(entity, MessageCurrentRevisionLink) }))
    .filter((item) => item.link?.message === message)
    .sort((left, right) => right.entity - left.entity)[0]?.link?.revision;
}

function findConversation(world: World, conversationId: string): Entity | undefined {
  const matches = world.query(Conversation).filter((entity) => world.get(entity, Conversation)?.id === conversationId);
  if (matches.length > 1) throw new Error(`Conversation Stable ID conflict: ${conversationId}`);
  return matches[0];
}

function messagesForConversation(world: World, conversation: Entity): Entity[] {
  return world.query(Message, PartOf)
    .filter((entity) => world.get(entity, PartOf)?.parent === conversation)
    .sort((left, right) => {
      const a = world.get(left, Message)!;
      const b = world.get(right, Message)!;
      return a.seq - b.seq || a.createdAt - b.createdAt || left - right;
    });
}

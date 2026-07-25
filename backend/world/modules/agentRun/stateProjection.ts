import type {
  AgentRunInputRevisionRecord,
  AgentRunRecord,
  AgentRunSourceLinkRecord,
  AgentRunTargetLinkRecord,
  ClientState,
  RunContextPolicyLinkRecord,
  RunContextPolicyRecord,
  RunConversationPolicyLinkRecord,
  RunConversationPolicyRecord,
  RunDeliveryPolicyLinkRecord,
  RunDeliveryPolicyRecord,
  RunEditPolicyLinkRecord,
  RunEditPolicyRecord,
  RunWorkflowLinkRecord,
  RunModelProfileLinkRecord,
  RunSystemPromptLinkRecord,
  RunTerminationRecord,
  RunToolPolicyLinkRecord,
  ToolCallRunLinkRecord
} from '../../../../shared/protocol';
import type { MessageTurnLinkRecord } from '../../../../shared/conversationReliability';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import { Conversation, Message, MessageRevision } from '../chat/components';
import { Workflow, ModelProfile, SystemPrompt, ToolPolicy } from '../workflow/components';
import { ToolCall } from '../tools/components';
import {
  AgentRun,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageTurnLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunConversationPolicy,
  RunConversationPolicyLink,
  RunDeliveryPolicy,
  RunDeliveryPolicyLink,
  RunEditPolicy,
  RunEditPolicyLink,
  RunWorkflowLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunTermination,
  RunToolPolicyLink,
  ToolCallRunLink
} from './components';

export const agentRunStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    Conversation,
    Message,
    MessageRevision,
    ToolCall,
    Workflow,
    ToolPolicy,
    SystemPrompt,
    ModelProfile,
    AgentRun,
    RunTermination,
    AgentRunSourceLink,
    AgentRunTargetLink,
    MessageTurnLink,
    ToolCallRunLink,
    RunConversationPolicy,
    RunContextPolicy,
    RunDeliveryPolicy,
    RunEditPolicy,
    RunWorkflowLink,
    RunSystemPromptLink,
    RunModelProfileLink,
    RunToolPolicyLink,
    RunConversationPolicyLink,
    RunContextPolicyLink,
    RunDeliveryPolicyLink,
    RunEditPolicyLink,
    AgentRunInputRevision
  ]
};

export function projectAgentRunState(world: WorldReader): Partial<ClientState> {
  const agentRuns = world.query(AgentRun).map((entity): AgentRunRecord => ({ ...world.get(entity, AgentRun)! }));
  return {
    agentRuns,
    runTerminations: world.query(RunTermination).map((entity) => buildRunTerminationRecord(world, entity)).filter(isDefined),
    agentRunSourceLinks: world.query(AgentRunSourceLink).map((entity) => buildSourceLinkRecord(world, entity)).filter(isDefined),
    agentRunTargetLinks: world.query(AgentRunTargetLink).map((entity) => buildTargetLinkRecord(world, entity)).filter(isDefined),
    messageTurnLinks: world.query(MessageTurnLink).map((entity) => buildMessageTurnLinkRecord(world, entity)).filter(isDefined),
    toolCallRunLinks: world.query(ToolCallRunLink).map((entity) => buildToolCallRunLinkRecord(world, entity)).filter(isDefined),
    runConversationPolicies: world.query(RunConversationPolicy).map((entity): RunConversationPolicyRecord => ({ ...world.get(entity, RunConversationPolicy)! })),
    runContextPolicies: world.query(RunContextPolicy).map((entity): RunContextPolicyRecord => ({ ...world.get(entity, RunContextPolicy)! })),
    runDeliveryPolicies: world.query(RunDeliveryPolicy).map((entity) => buildDeliveryPolicyRecord(world, entity)).filter(isDefined),
    runEditPolicies: world.query(RunEditPolicy).map((entity): RunEditPolicyRecord => ({ ...world.get(entity, RunEditPolicy)! })),
    runWorkflowLinks: world.query(RunWorkflowLink).map((entity) => buildRunWorkflowLinkRecord(world, entity)).filter(isDefined),
    runSystemPromptLinks: world.query(RunSystemPromptLink).map((entity) => buildRunSystemPromptLinkRecord(world, entity)).filter(isDefined),
    runModelProfileLinks: world.query(RunModelProfileLink).map((entity) => buildRunModelProfileLinkRecord(world, entity)).filter(isDefined),
    runToolPolicyLinks: world.query(RunToolPolicyLink).map((entity) => buildRunToolPolicyLinkRecord(world, entity)).filter(isDefined),
    runConversationPolicyLinks: world.query(RunConversationPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunConversationPolicyLink, RunConversationPolicy)).filter(isDefined),
    runContextPolicyLinks: world.query(RunContextPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunContextPolicyLink, RunContextPolicy)).filter(isDefined),
    runDeliveryPolicyLinks: world.query(RunDeliveryPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunDeliveryPolicyLink, RunDeliveryPolicy)).filter(isDefined),
    runEditPolicyLinks: world.query(RunEditPolicyLink).map((entity) => buildRunPolicyLinkRecord(world, entity, RunEditPolicyLink, RunEditPolicy)).filter(isDefined),
    agentRunInputRevisions: world.query(AgentRunInputRevision).map((entity) => buildInputRevisionRecord(world, entity)).filter(isDefined)
  };
}

function buildRunTerminationRecord(world: WorldReader, entity: number): RunTerminationRecord | undefined {
  const termination = world.get(entity, RunTermination);
  if (!termination) return undefined;
  const run = world.get(termination.run, AgentRun);
  if (!run) return undefined;
  const triggerRun = termination.triggerRun === undefined ? undefined : world.get(termination.triggerRun, AgentRun);
  return {
    id: termination.id,
    runId: run.id,
    kind: termination.kind,
    actor: termination.actor,
    interruptedPhase: termination.interruptedPhase,
    reasonCode: termination.reasonCode,
    ...((triggerRun?.id ?? termination.triggerRunId) ? { triggerRunId: triggerRun?.id ?? termination.triggerRunId } : {}),
    createdAt: termination.createdAt
  };
}

function buildSourceLinkRecord(world: WorldReader, entity: number): AgentRunSourceLinkRecord | undefined {
  const link = world.get(entity, AgentRunSourceLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  if (!run) return undefined;
  return {
    id: link.id,
    runId: run.id,
    sourceKind: link.sourceKind,
    ...(link.sourceAgent !== undefined ? { sourceAgentId: world.get(link.sourceAgent, Agent)?.id } : {}),
    ...(link.sourceConversation !== undefined ? { sourceConversationId: world.get(link.sourceConversation, Conversation)?.id } : {}),
    ...(link.sourceMessage !== undefined ? { sourceMessageId: world.get(link.sourceMessage, Message)?.id } : {}),
    ...(link.sourceToolCall !== undefined ? { sourceToolCallId: world.get(link.sourceToolCall, ToolCall)?.id } : {}),
    ...(link.sourceRun !== undefined ? { sourceRunId: world.get(link.sourceRun, AgentRun)?.id } : {}),
    ...(link.answerBridgeId ? { answerBridgeId: link.answerBridgeId } : {})
  };
}

function buildTargetLinkRecord(world: WorldReader, entity: number): AgentRunTargetLinkRecord | undefined {
  const link = world.get(entity, AgentRunTargetLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const agent = world.get(link.agent, Agent);
  const conversation = world.get(link.conversation, Conversation);
  if (!run || !agent || !conversation) return undefined;
  return { id: link.id, runId: run.id, agentId: agent.id, conversationId: conversation.id, role: link.role };
}

function buildMessageTurnLinkRecord(world: WorldReader, entity: number): MessageTurnLinkRecord | undefined {
  const link = world.get(entity, MessageTurnLink);
  if (!link) return undefined;
  const message = world.get(link.message, Message);
  const turn = world.get(link.turn, AgentRun);
  if (!message || !turn) return undefined;
  return {
    id: link.id,
    messageId: message.id as MessageTurnLinkRecord['messageId'],
    turnId: turn.id as MessageTurnLinkRecord['turnId'],
    role: link.role
  };
}

function buildToolCallRunLinkRecord(world: WorldReader, entity: number): ToolCallRunLinkRecord | undefined {
  const link = world.get(entity, ToolCallRunLink);
  if (!link) return undefined;
  const toolCall = world.get(link.toolCall, ToolCall);
  const run = world.get(link.run, AgentRun);
  if (!toolCall || !run) return undefined;
  return { id: link.id, toolCallId: toolCall.id, runId: run.id, role: link.role };
}

function buildDeliveryPolicyRecord(world: WorldReader, entity: number): RunDeliveryPolicyRecord | undefined {
  const policy = world.get(entity, RunDeliveryPolicy);
  if (!policy) return undefined;
  return {
    id: policy.id,
    mode: policy.mode,
    includeTranscript: policy.includeTranscript,
    ...(policy.targetConversation !== undefined ? { targetConversationId: world.get(policy.targetConversation, Conversation)?.id } : {}),
    ...(policy.targetToolCall !== undefined ? { targetToolCallId: world.get(policy.targetToolCall, ToolCall)?.id } : {})
  };
}

function buildRunWorkflowLinkRecord(world: WorldReader, entity: number): RunWorkflowLinkRecord | undefined {
  const link = world.get(entity, RunWorkflowLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const mode = world.get(link.workflow, Workflow);
  if (!run || !mode) return undefined;
  return { id: link.id, runId: run.id, workflowId: mode.id, role: link.role };
}

function buildRunSystemPromptLinkRecord(world: WorldReader, entity: number): RunSystemPromptLinkRecord | undefined {
  const link = world.get(entity, RunSystemPromptLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const systemPrompt = world.get(link.systemPrompt, SystemPrompt);
  if (!run || !systemPrompt) return undefined;
  return { id: link.id, runId: run.id, systemPromptId: systemPrompt.id, role: link.role };
}

function buildRunModelProfileLinkRecord(world: WorldReader, entity: number): RunModelProfileLinkRecord | undefined {
  const link = world.get(entity, RunModelProfileLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const modelProfile = world.get(link.modelProfile, ModelProfile);
  if (!run || !modelProfile) return undefined;
  return { id: link.id, runId: run.id, modelProfileId: modelProfile.id, role: link.role };
}

function buildRunToolPolicyLinkRecord(world: WorldReader, entity: number): RunToolPolicyLinkRecord | undefined {
  const link = world.get(entity, RunToolPolicyLink);
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const toolPolicy = world.get(link.toolPolicy, ToolPolicy);
  if (!run || !toolPolicy) return undefined;
  return { id: link.id, runId: run.id, toolPolicyId: toolPolicy.id, role: link.role };
}

function buildRunPolicyLinkRecord<TLink extends { id: string; run: number; policy: number; role: 'active' }>(
  world: WorldReader,
  entity: number,
  linkType: { id: symbol },
  policyType: { id: symbol }
): RunConversationPolicyLinkRecord | RunContextPolicyLinkRecord | RunDeliveryPolicyLinkRecord | RunEditPolicyLinkRecord | undefined {
  const link = world.get(entity, linkType as never) as TLink | undefined;
  if (!link) return undefined;
  const run = world.get(link.run, AgentRun);
  const policy = world.get(link.policy, policyType as never) as { id: string } | undefined;
  if (!run || !policy) return undefined;
  return { id: link.id, runId: run.id, policyId: policy.id, role: link.role };
}

function buildInputRevisionRecord(world: WorldReader, entity: number): AgentRunInputRevisionRecord | undefined {
  const input = world.get(entity, AgentRunInputRevision);
  if (!input) return undefined;
  const run = world.get(input.run, AgentRun);
  const conversation = world.get(input.conversation, Conversation);
  const revision = world.get(input.revision, MessageRevision);
  if (!run || !conversation || !revision) return undefined;
  return { id: input.id, runId: run.id, conversationId: conversation.id, revisionId: revision.id };
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

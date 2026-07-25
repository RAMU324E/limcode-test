import type { ClientState, McpToolSourceRecord, ToolCallEventRecord, ToolCallPreviewRecord, ToolCallPreviewTargetLinkRecord, ToolCallRecord, ToolCallResultLinkRecord, ToolDefinitionRecord, ToolPolicyScopeLinkRecord, ToolResultArtifactRecord, ToolChangeApplyPolicyRecord, ToolDisplayPolicyRecord } from '../../../../shared/protocol';
import type { AccessDeclaration, WorldReader } from '../../../ecs/types';
import { Agent } from '../agent/components';
import {
  AgentRun,
  AgentRunTargetLink,
  RunWorkflowLink,
  RunToolPolicyLink,
  ToolCallRunLink
} from '../agentRun/components';
import { activeToolPolicyForRun, runForToolCall } from '../agentRun/queries';
import { Conversation, Message, PartOf } from '../chat/components';
import { ConversationWorkflowSelection, Workflow, ToolPolicy } from '../workflow/components';
import { McpToolSourcesKey, ToolDefinitionsKey, ToolRuntimeDefinitionsKey } from './resources';
import { toolSchedulingDecision } from './scheduling';
import { ToolCall, ToolCallEvent, ToolCallPreview, ToolCallPreviewTargetLink, ToolCallResultLink, ToolPolicyScopeLink, ToolResultArtifact, ToolResultConsumed, ToolState, type ToolCallData, type ToolPolicyScopeLinkData, type ToolStateData } from './components';
import { isYoloToolPolicy } from './policy';

export const toolsRuntimeStateProjectionReads: AccessDeclaration = {
  components: [
    Agent,
    Workflow,
    AgentRun,
    Conversation,
    Message,
    PartOf,
    ToolPolicy,
    AgentRunTargetLink,
    ToolCallRunLink,
    RunWorkflowLink,
    RunToolPolicyLink,
    ConversationWorkflowSelection,
    ToolCall,
    ToolState,
    ToolCallEvent,
    ToolResultArtifact,
    ToolCallResultLink,
    ToolResultConsumed,
    ToolPolicyScopeLink
  ],
  resources: [ToolDefinitionsKey, ToolRuntimeDefinitionsKey, McpToolSourcesKey]
};

export const toolsClientStateProjectionReads: AccessDeclaration = {
  ...toolsRuntimeStateProjectionReads,
  components: [
    ...(toolsRuntimeStateProjectionReads.components ?? []),
    ToolCallPreview,
    ToolCallPreviewTargetLink
  ],
  resources: [ToolDefinitionsKey, ToolRuntimeDefinitionsKey, McpToolSourcesKey]
};

export const toolsStateProjectionReads = toolsClientStateProjectionReads;

export function projectToolsRuntimeState(world: WorldReader) {
  const toolCalls = world
    .query(ToolCall, ToolState, PartOf)
    .map((entity) => buildToolCallRecord(world, entity))
    .filter((item): item is ToolCallRecord => item !== undefined);

  const toolCallEvents = world
    .query(ToolCallEvent, PartOf)
    .map((entity) => buildToolCallEventRecord(world, entity))
    .filter((item): item is ToolCallEventRecord => item !== undefined)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));

  const toolResultArtifacts = world
    .query(ToolResultArtifact)
    .map((entity) => world.get(entity, ToolResultArtifact))
    .filter((item): item is NonNullable<typeof item> => item !== undefined);

  const toolCallResultLinks = world
    .query(ToolCallResultLink)
    .map((entity): ToolCallResultLinkRecord | undefined => world.get(entity, ToolCallResultLink))
    .filter((item): item is ToolCallResultLinkRecord => item !== undefined);

  const toolPolicyScopeLinks = world
    .query(ToolPolicyScopeLink)
    .map((entity) => buildToolPolicyScopeLinkRecord(world, entity))
    .filter((item): item is ToolPolicyScopeLinkRecord => item !== undefined);

  return { toolCalls, toolCallEvents, toolResultArtifacts, toolCallResultLinks, toolPolicyScopeLinks };
}

export function projectToolsClientState(world: WorldReader): Partial<ClientState> {
  const toolDefinitions = world.tryGetResource(ToolDefinitionsKey) ?? [];
  const mcpToolSources = world.tryGetResource(McpToolSourcesKey) ?? [];
  const runtime = projectToolsRuntimeState(world);
  const toolCallPreviews = world.query(ToolCallPreview)
    .map((entity): ToolCallPreviewRecord | undefined => world.get(entity, ToolCallPreview))
    .filter((preview): preview is ToolCallPreviewRecord => preview !== undefined);
  const toolCallPreviewTargetLinks = world.query(ToolCallPreviewTargetLink)
    .map((entity): ToolCallPreviewTargetLinkRecord | undefined => {
      const link = world.get(entity, ToolCallPreviewTargetLink);
      if (!link) return undefined;
      const preview = world.get(link.preview, ToolCallPreview);
      if (!preview) return undefined;
      return {
        id: link.id,
        previewId: preview.id,
        requestId: link.requestId,
        messageId: link.messageId,
        conversationId: link.conversationId,
        createdAt: link.createdAt,
        updatedAt: link.updatedAt
      };
    })
    .filter((link): link is ToolCallPreviewTargetLinkRecord => link !== undefined);
  return {
    toolDefinitions: toolDefinitions.map((tool): ToolDefinitionRecord => ({ ...tool })),
    mcpToolSources: mcpToolSources.map((source): McpToolSourceRecord => ({ ...source })),
    toolCallPreviews,
    toolCallPreviewTargetLinks,
    ...runtime,
    toolResultArtifacts: runtime.toolResultArtifacts.map((artifact): ToolResultArtifactRecord => {
      const { modelResponse: _modelResponse, ...clientArtifact } = artifact;
      return clientArtifact;
    })
  };
}

export const projectToolsState = projectToolsClientState;


function buildToolCallRecord(world: WorldReader, entity: number): ToolCallRecord | undefined {
  const call = world.get(entity, ToolCall);
  const state = world.get(entity, ToolState);
  const messageEntity = world.get(entity, PartOf)?.parent;
  if (!call || !state || messageEntity === undefined) return undefined;

  const message = world.get(messageEntity, Message);
  if (!message) return undefined;
  const scheduling = toolSchedulingDecision(world, entity);
  const summary = resolveToolCallSummary(world, call, state);
  const display = resolveToolCallDisplay(world, entity, call);
  const changeApply = resolveToolCallChangeApply(world, entity, call);

  return {
    id: call.id,
    messageId: message.id,
    name: call.name,
    functionCallId: call.functionCallId,
    args: call.argsJson,
    ...(summary ? { summary } : {}),
    status: state.status,
    ...(state.responseParts?.length ? { responseParts: state.responseParts.map((part) => ({ inlineData: { ...part.inlineData } })) } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    ...(state.progress !== undefined ? { progress: state.progress } : {}),
    ...(call.schedulingOrdinal !== undefined ? { schedulingOrdinal: call.schedulingOrdinal } : {}),
    schedulingMode: scheduling.mode,
    ...(scheduling.reason ? { schedulingReason: scheduling.reason } : {}),
    ...(display ? { display } : {}),
    ...(changeApply ? { changeApply } : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    createdAt: call.createdAt,
    updatedAt: state.updatedAt
  };
}

function resolveToolCallDisplay(world: WorldReader, entity: number, call: ToolCallData): ToolDisplayPolicyRecord | undefined {
  const run = runForToolCall(world, entity);
  if (run === undefined) return undefined;
  const policy = activeToolPolicyForRun(world, run);
  const display = policy?.toolConfigs?.[call.name]?.display;
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const definition = definitions.find((tool) => tool.declaration.name === call.name);
  const metadata = definition?.declaration.metadata;
  const resolved: ToolDisplayPolicyRecord = {};
  if (display?.autoExpand !== undefined) resolved.autoExpand = display.autoExpand;
  else if (metadata?.defaultAutoExpand === true) resolved.autoExpand = true;
  if (isYoloToolPolicy(policy) && metadata?.supportsDiffPreview === true) resolved.autoOpenDiffPreview = false;
  if (metadata?.supportsDiffPreview === true) {
    if (resolved.autoOpenDiffPreview !== undefined) return resolved;
    if (display?.autoOpenDiffPreview !== undefined) resolved.autoOpenDiffPreview = display.autoOpenDiffPreview;
    else if (metadata.defaultAutoOpenDiffPreview === true) resolved.autoOpenDiffPreview = true;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function resolveToolCallChangeApply(world: WorldReader, entity: number, call: ToolCallData): ToolChangeApplyPolicyRecord | undefined {
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const definition = definitions.find((tool) => tool.declaration.name === call.name);
  const metadata = definition?.declaration.metadata;
  if (metadata?.supportsChangeApply !== true) return undefined;

  const run = runForToolCall(world, entity);
  const policy = run === undefined ? undefined : activeToolPolicyForRun(world, run);
  const config = policy?.toolConfigs?.[call.name];
  const delay = normalizeAutoApplyDelay(config?.autoApplyChangeDelaySeconds ?? metadata.defaultAutoApplyChangeDelaySeconds ?? 3);
  return {
    autoApply: isYoloToolPolicy(policy) ? true : config?.autoApplyChange ?? metadata.defaultAutoApplyChange ?? true,
    autoApplyDelaySeconds: isYoloToolPolicy(policy) ? 0 : delay
  };
}

function normalizeAutoApplyDelay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3;
  return Math.min(600, Math.max(0, Math.floor(value)));
}

function resolveToolCallSummary(world: WorldReader, call: ToolCallData, state: ToolStateData): string | undefined {
  const definitions = world.tryGetResource(ToolRuntimeDefinitionsKey) ?? [];
  const definition = definitions.find((tool) => tool.declaration.name === call.name);
  if (!definition?.summary) return undefined;

  try {
    return normalizeToolCallSummary(definition.summary(parseToolCallArgs(call.argsJson), {
      toolName: call.name,
      argsJson: call.argsJson,
      ...(state.progress !== undefined ? { progress: state.progress } : {}),
      ...(state.result !== undefined ? { result: state.result } : {})
    }));
  } catch {
    return undefined;
  }
}

function parseToolCallArgs(argsJson: string): unknown {
  try {
    return argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return argsJson;
  }
}

function normalizeToolCallSummary(summary: string | undefined): string | undefined {
  const text = summary?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function buildToolCallEventRecord(world: WorldReader, entity: number): ToolCallEventRecord | undefined {
  const event = world.get(entity, ToolCallEvent);
  if (!event) return undefined;
  return { ...event };
}

function buildToolPolicyScopeLinkRecord(world: WorldReader, entity: number): ToolPolicyScopeLinkRecord | undefined {
  const link = world.get(entity, ToolPolicyScopeLink);
  if (!link) return undefined;
  const policy = world.get(link.toolPolicy, ToolPolicy);
  if (!policy) return undefined;
  const scopeId = link.scopeId ?? resolveScopeId(world, link);
  if (link.scopeKind !== 'global' && !scopeId) return undefined;
  return {
    id: link.id,
    scopeKind: link.scopeKind,
    ...(scopeId ? { scopeId } : {}),
    toolPolicyId: policy.id,
    role: link.role,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt
  };
}

function resolveScopeId(world: WorldReader, link: ToolPolicyScopeLinkData): string | undefined {
  switch (link.scopeKind) {
    case 'global':
      return undefined;
    case 'conversation':
      return link.conversation !== undefined ? world.get(link.conversation, Conversation)?.id : undefined;
    case 'agent':
      return link.agent !== undefined ? world.get(link.agent, Agent)?.id : undefined;
    case 'workflow':
      return link.workflow !== undefined ? world.get(link.workflow, Workflow)?.id : undefined;
    case 'run':
      return link.run !== undefined ? world.get(link.run, AgentRun)?.id : undefined;
    case 'agentSystem':
      return link.agentSystemId;
  }
}

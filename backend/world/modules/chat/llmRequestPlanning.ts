import type { Entity, WorldReader } from '../../../ecs/types';
import {
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  MessageTurnLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunModelProfileLink,
  RunSystemPromptLink,
  RunToolPolicyLink,
  RunWorkflowLink
} from '../agentRun/components';
import {
  activeContextPolicyForRun,
  activeModelProfileForRun,
  activeToolPolicyForRun,
  systemPromptsForRun
} from '../agentRun/queries';
import { projectRunModelContext } from '../agentRun/contextPolicy';
import { Agent } from '../agent/components';
import { CompressionBlock, CompressionContextVariant, RunCompressionBlockLink } from '../compression/components';
import { LlmInvocation } from '../llm/components';
import type { LlmModelSettings, LlmStartRequest, ToolSchema } from '../llm/contracts';
import {
  ModelContextProjection as ModelContextProjectionComponent,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink,
  CompressionModelContextProjectionLink
} from '../modelContext/components';
import {
  ConversationRuntimeContextSnapshotLink,
  RuntimeContextSnapshot,
  RunRuntimeContextSnapshotLink
} from '../runtimeContext/components';
import { PROMPT_CONTEXT_PLACEHOLDER_READS, renderSystemPromptTemplate } from '../runtimeContext/placeholders';
import { ToolCall, ToolPolicyScopeLink, ToolState } from '../tools/components';
import { isToolNameAllowedByPolicy } from '../tools/policy';
import { buildRuntimeToolSchemas, TOOL_SCHEMA_CONTRIBUTOR_READS } from '../tools/schemaContributors';
import { ToolDefinitionsKey, ToolSchemasKey } from '../tools/resources';
import {
  ConversationWorkflowSelection,
  ModelProfile,
  ModelProfileScopeLink,
  SystemPrompt,
  SystemPromptScopeLink,
  ToolPolicy,
  Workflow
} from '../workflow/components';
import { Conversation, Message, MessageCurrentRevisionLink, MessageRevision, PartOf } from './components';
import { textContent, type MessageContent } from '../../../../shared/protocol';
import type { ModelContextProjection } from '../../../modelContext/types';

/**
 * 已提交 Run/Turn 投影到不可变 LLM effect payload 的唯一只读组装边界。
 * 该模块不注册 System，也不写 ECS；历史 dry-run 与可靠 dispatcher 复用同一投影规则。
 */
export const LLM_REQUEST_PLANNING_READS = [...new Set([
  Message,
  PartOf,
  MessageTurnLink,
  MessageRevision,
  MessageCurrentRevisionLink,
  AgentRunInputRevision,
  AgentRunSourceLink,
  AgentRunTargetLink,
  RunContextPolicy,
  RunContextPolicyLink,
  RunWorkflowLink,
  RunSystemPromptLink,
  RunModelProfileLink,
  RunToolPolicyLink,
  ConversationWorkflowSelection,
  Workflow,
  Agent,
  SystemPromptScopeLink,
  ModelProfileScopeLink,
  SystemPrompt,
  ModelProfile,
  ToolPolicy,
  ToolPolicyScopeLink,
  ToolCall,
  ToolState,
  LlmInvocation,
  CompressionBlock,
  CompressionContextVariant,
  RunCompressionBlockLink,
  RuntimeContextSnapshot,
  ConversationRuntimeContextSnapshotLink,
  RunRuntimeContextSnapshotLink,
  ModelContextProjectionComponent,
  ModelContextProjectionConversationLink,
  ModelContextProjectionSourceLink,
  RequestModelContextProjectionLink,
  CompressionModelContextProjectionLink,
  ...(TOOL_SCHEMA_CONTRIBUTOR_READS.components ?? []),
  ...(PROMPT_CONTEXT_PLACEHOLDER_READS.components ?? [])
])] as const;

export interface BuildLlmStartRequestForRunInput {
  run: Entity;
  conversation?: Entity;
  modelMessage?: Entity;
  invocation?: Entity;
  requestId?: string;
  tools?: ToolSchema[];
  contextProjection?: ModelContextProjection;
  contextContents?: MessageContent[];
}

export function buildLlmStartRequestForRun(
  world: WorldReader,
  input: BuildLlmStartRequestForRunInput
): LlmStartRequest | undefined {
  const context = resolveLlmContext(world, input);
  if (!context) return undefined;

  const systemPrompt = composeSystemInstruction(systemPromptsForRun(world, input.run).map((prompt) => ({
    ...prompt,
    text: renderSystemPromptTemplate(prompt.text, { world, run: input.run, conversation: context.conversation })
  })));
  const invocation = input.invocation !== undefined ? world.get(input.invocation, LlmInvocation) : undefined;
  const settingsSnapshot = invocation?.settings;
  const modelProfile = activeModelProfileForRun(world, input.run);
  const conversation = world.get(context.conversation, Conversation);
  const model = settingsSnapshot?.modelId
    ? {
        providerConfigId: settingsSnapshot.providerConfigId,
        provider: settingsSnapshot.provider,
        model: settingsSnapshot.modelId
      } satisfies LlmModelSettings
    : modelProfile === undefined
      ? undefined
      : {
          providerConfigId: modelProfile.providerConfigId,
          provider: modelProfile.provider,
          model: modelProfile.model
        } satisfies LlmModelSettings;
  const toolPolicy = activeToolPolicyForRun(world, input.run);
  const allTools = input.tools ?? world.tryGetResource(ToolSchemasKey) ?? [];
  const definitionsByName = new Map((world.tryGetResource(ToolDefinitionsKey) ?? []).map((tool) => [tool.name, tool]));
  const filteredTools = toolPolicy
    ? allTools.filter((tool) => isToolNameAllowedByPolicy(toolPolicy, tool.name, definitionsByName.get(tool.name)))
    : [];
  const tools = buildRuntimeToolSchemas(filteredTools, {
    world,
    run: input.run,
    conversation: context.conversation
  });
  const contextPolicy = activeContextPolicyForRun(world, input.run);
  const contents = input.contextProjection?.contents
    ?? input.contextContents
    ?? projectRunModelContext(world, { ...context, policy: contextPolicy, settingsSnapshot }).contents;
  const systemText = systemPrompt.trim();

  return {
    id: input.requestId ?? `dryrun-${input.run}-${Date.now()}`,
    ...(invocation ? { invocationId: invocation.id } : {}),
    systemInstruction: systemText ? textContent('user', systemText) : undefined,
    contents,
    tools,
    conversationId: conversation?.id,
    model,
    ...(settingsSnapshot ? { settingsSnapshot } : {})
  };
}

function resolveLlmContext(
  world: WorldReader,
  input: BuildLlmStartRequestForRunInput
): { run: Entity; conversation: Entity; modelMessage: Entity } | undefined {
  const modelMessage = input.modelMessage ?? latestModelMessageForRun(world, input.run);
  if (modelMessage === undefined) return undefined;
  const conversation = input.conversation ?? world.get(modelMessage, PartOf)?.parent;
  if (conversation === undefined) return undefined;
  return { run: input.run, conversation, modelMessage };
}

function latestModelMessageForRun(world: WorldReader, run: Entity): Entity | undefined {
  return world
    .query(MessageTurnLink)
    .map((entity) => world.get(entity, MessageTurnLink))
    .filter((link): link is NonNullable<typeof link> => !!link && link.turn === run && link.role === 'model')
    .sort((left, right) => (world.get(right.message, Message)?.seq ?? 0)
      - (world.get(left.message, Message)?.seq ?? 0))[0]?.message;
}

function composeSystemInstruction(prompts: Array<{ name: string; text: string }>): string {
  return prompts
    .map((prompt) => {
      const text = prompt.text.trim();
      if (!text) return '';
      const name = prompt.name.trim();
      return name ? `[${name}]\n${text}` : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

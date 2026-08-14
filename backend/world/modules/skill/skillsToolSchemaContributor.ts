import { SKILLS_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunWorkflowLink } from '../agentRun/components';
import { Conversation } from '../chat/components';
import { ConversationWorkflowSelection, Workflow } from '../workflow/components';
import type { ToolSchemaContributor } from '../tools/schemaContributors';
import { SkillPolicy, SkillPolicyScopeLink } from './components';
import { isSkillEnabledByPolicy } from './policy';
import { activeSkillPolicyForRun } from './queries';
import { SkillCatalogKey } from './resources';
import { composeSkillsToolDescription } from './skillDescription';

/**
 * 动态把「当前 run 已启用的技能」注入 skills 工具描述，让 AI 感知可用技能。
 * 技能正文只在 AI 调用 skills({ name }) 时按需返回，避免污染 system prompt。
 */
export const skillsToolSchemaContributor: ToolSchemaContributor = {
  key: 'skillsCatalog',
  reads: {
    components: [Agent, AgentRun, AgentRunTargetLink, RunWorkflowLink, Conversation, ConversationWorkflowSelection, Workflow, SkillPolicy, SkillPolicyScopeLink],
    resources: [SkillCatalogKey]
  },
  augment(tools, context) {
    if (!tools.some((tool) => tool.name === SKILLS_TOOL_NAME)) return tools;
    const catalog = context.world.tryGetResource(SkillCatalogKey) ?? [];
    const policy = activeSkillPolicyForRun(context.world, context.run);
    const enabled = catalog.filter((skill) => isSkillEnabledByPolicy(policy, skill));
    return tools.map((tool): ToolSchema => (tool.name === SKILLS_TOOL_NAME
      ? { ...tool, description: composeSkillsToolDescription(tool.description, enabled) }
      : tool));
  }
};

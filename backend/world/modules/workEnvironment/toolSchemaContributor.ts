import { SWITCH_WORK_ENVIRONMENT_TOOL_NAME, TRANSFER_TOOL_NAME } from '../../../../shared/protocol';
import type { ToolSchema } from '../llm/contracts';
import type { ToolSchemaContributor } from '../tools/schemaContributors';
import { Agent } from '../agent/components';
import { AgentRun, AgentRunTargetLink, RunWorkflowLink } from '../agentRun/components';
import { ConversationWorkflowSelection, Workflow } from '../workflow/components';
import { Conversation } from '../chat/components';
import { ConversationProjectLink, ProjectContext } from '../project/components';
import {
  ConversationWorkEnvironmentLink,
  RunWorkEnvironmentLink,
  WorkEnvironment,
  WorkEnvironmentPolicy,
  WorkEnvironmentPolicyScopeLink
} from './components';
import { effectiveWorkEnvironmentPolicyForRun, toolContextWorkEnvironmentsForRun } from './queries';
import {
  SWITCH_WORK_ENVIRONMENTS_TITLE,
  TRANSFER_WORK_ENVIRONMENTS_TITLE,
  workEnvironmentListText,
  withTransferEnvironmentParameterHints,
  withWorkEnvironmentIdParameterHints
} from './toolDescription';

export const workEnvironmentToolSchemaContributor: ToolSchemaContributor = {
  key: 'workEnvironment',
  reads: {
    components: [
      Agent,
      AgentRun,
      AgentRunTargetLink,
      RunWorkflowLink,
      Conversation,
      ConversationWorkflowSelection,
      Workflow,
      WorkEnvironment,
      WorkEnvironmentPolicy,
      WorkEnvironmentPolicyScopeLink,
      ConversationWorkEnvironmentLink,
      RunWorkEnvironmentLink,
      ConversationProjectLink,
      ProjectContext
    ]
  },
  augment(tools, context) {
    if (effectiveWorkEnvironmentPolicyForRun(context.world, context.run).policy?.enabled !== true) {
      return tools.filter((tool) => tool.name !== SWITCH_WORK_ENVIRONMENT_TOOL_NAME && tool.name !== TRANSFER_TOOL_NAME);
    }

    const environments = toolContextWorkEnvironmentsForRun(context.world, context.run).map((item) => item.data);
    return tools.map((tool) => {
      if (tool.name === SWITCH_WORK_ENVIRONMENT_TOOL_NAME) {
        const environmentText = workEnvironmentListText(environments, SWITCH_WORK_ENVIRONMENTS_TITLE);
        return {
          ...tool,
          description: [tool.description, environmentText].filter(Boolean).join('\n\n'),
          parameters: withWorkEnvironmentIdParameterHints(tool.parameters, environmentText)
        };
      }
      if (tool.name === TRANSFER_TOOL_NAME) {
        const environmentText = workEnvironmentListText(environments, TRANSFER_WORK_ENVIRONMENTS_TITLE);
        return {
          ...tool,
          description: [tool.description, environmentText].filter(Boolean).join('\n\n'),
          parameters: withTransferEnvironmentParameterHints(tool.parameters, environmentText)
        };
      }
      return tool;
    });
  }
};

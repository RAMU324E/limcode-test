import { defineClientStateContributor } from '../../clientSync/contributors';
import { agentRunStateProjectionReads, projectAgentRunState } from './stateProjection';

export const projectAgentRunClientState = projectAgentRunState;

export const agentRunClientSyncContributor = defineClientStateContributor({
  key: 'agentRuns',
  tables: [
    'agentRuns',
    'runTerminations',
    'agentRunSourceLinks',
    'agentRunTargetLinks',
    'messageTurnLinks',
    'toolCallRunLinks',
    'runConversationPolicies',
    'runContextPolicies',
    'runDeliveryPolicies',
    'runEditPolicies',
    'runWorkflowLinks',
    'runSystemPromptLinks',
    'runModelProfileLinks',
    'runToolPolicyLinks',
    'runConversationPolicyLinks',
    'runContextPolicyLinks',
    'runDeliveryPolicyLinks',
    'runEditPolicyLinks',
    'agentRunInputRevisions'
  ],
  reads: agentRunStateProjectionReads,
  project: projectAgentRunClientState,
  worker: {
    modulePath: '../world/modules/agentRun/clientSync',
    projectExport: 'projectAgentRunClientState'
  }
});

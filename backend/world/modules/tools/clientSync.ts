import { defineClientStateContributor } from '../../clientSync/contributors';
import { projectToolsClientState, toolsClientStateProjectionReads } from './stateProjection';

export { projectToolsClientState };

export const toolsClientSyncContributor = defineClientStateContributor({
  key: 'tools',
  tables: ['toolDefinitions', 'mcpToolSources', 'toolCalls', 'toolCallPreviews', 'toolCallPreviewTargetLinks', 'toolCallEvents', 'toolPolicyScopeLinks'],
  reads: toolsClientStateProjectionReads,
  project: projectToolsClientState,
  worker: {
    modulePath: '../world/modules/tools/clientSync',
    projectExport: 'projectToolsClientState'
  }
});

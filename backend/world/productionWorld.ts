import { clientSyncPlugin, registerClientSyncSystems } from './clientSync';
import {
  agentAnswerPlugin,
  agentPlugin,
  agentRunPlugin,
  backgroundProcessPlugin,
  chatPlugin,
  checkpointPlugin,
  commonPlugin,
  compressionPlugin,
  llmPlugin,
  modelContextPlugin,
  planReviewPlugin,
  projectPlugin,
  rulesPlugin,
  runtimeContextPlugin,
  skillPlugin,
  toolsPlugin,
  workflowPlugin,
  workEnvironmentPlugin
} from './modules';
import type { ToolsPluginOptions } from './modules/tools/plugin';
import { installWorldPlugins, type WorldInstallContext } from './plugin';
import { storageProjectionPlugin } from './storageProjection';

/**
 * The single production ECS composition root.
 * Tests install this exact graph so a partial-system fixture cannot hide topology regressions.
 */
export function installProductionWorld(
  context: WorldInstallContext,
  tools: ToolsPluginOptions
): void {
  installWorldPlugins(context, [
    commonPlugin(),
    clientSyncPlugin(),
    storageProjectionPlugin(),
    agentPlugin(),
    workflowPlugin(),
    planReviewPlugin(),
    projectPlugin(),
    workEnvironmentPlugin(),
    runtimeContextPlugin(),
    checkpointPlugin(),
    compressionPlugin(),
    modelContextPlugin(),
    llmPlugin(),
    agentAnswerPlugin(),
    toolsPlugin(tools),
    backgroundProcessPlugin(),
    skillPlugin(),
    rulesPlugin(),
    chatPlugin(),
    agentRunPlugin()
  ]);
  registerClientSyncSystems(context.scheduler);
}

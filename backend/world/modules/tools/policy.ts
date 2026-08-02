import type { ToolDefinitionRecord, ToolPolicyRecord } from '../../../../shared/protocol';

type ToolPolicyLike = Pick<ToolPolicyRecord, 'allowedTools' | 'sourceConfigs' | 'preset'>;
type ToolDefinitionLike = Pick<ToolDefinitionRecord, 'name' | 'source'>;

export function isYoloToolPolicy(policy: Pick<ToolPolicyRecord, 'preset'> | undefined): boolean {
  return policy?.preset === 'yolo';
}

export function isToolAllowedByPolicy(policy: ToolPolicyLike, tool: ToolDefinitionLike): boolean {
  const explicitlyAllowed = policy.allowedTools.includes(tool.name);
  if (tool.source?.kind !== 'mcp') return explicitlyAllowed;
  const sourceId = tool.source.sourceId?.trim();
  if (!sourceId) return explicitlyAllowed;
  const sourceConfig = policy.sourceConfigs?.[sourceId];
  if (!sourceConfig) return explicitlyAllowed;
  if (!sourceConfig.enabled) return false;
  return !(sourceConfig.disabledTools ?? []).includes(tool.name);
}

export function isToolNameAllowedByPolicy(policy: ToolPolicyLike, toolName: string, tool?: ToolDefinitionLike): boolean {
  if (tool) return isToolAllowedByPolicy(policy, tool);
  const name = toolName.trim();
  return !!name && policy.allowedTools.includes(name);
}

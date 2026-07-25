import type { AgentRecord } from '../../shared/protocol';
import type { AgentSpawnRequestData } from '../world/modules/agent/requests';
import { EXTENSION_AGENT_NAME } from '../../shared/extensionIdentity';

export const DEFAULT_AGENT_ID = 'main';
export const DEFAULT_AGENT_NAME = EXTENSION_AGENT_NAME;

export function createDefaultAgentRecord(): AgentRecord {
  return {
    id: DEFAULT_AGENT_ID,
    name: DEFAULT_AGENT_NAME,
    kind: 'main',
    source: 'builtin',
    status: 'idle'
  };
}

export function createDefaultAgentSpawnRequest(conversationId: string): AgentSpawnRequestData {
  return {
    kind: 'main',
    agentId: DEFAULT_AGENT_ID,
    agentName: DEFAULT_AGENT_NAME,
    conversationId
  };
}

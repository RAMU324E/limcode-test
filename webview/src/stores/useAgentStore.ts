import { defineStore } from 'pinia';
import type { AgentRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';
import { useReliableKernelClientFeedStore } from './useReliableKernelClientFeedStore';

function agentLabel(agent: AgentRecord): string {
  return agent.name.trim() || agent.id;
}

function isConfigurableAgent(agent: AgentRecord): boolean {
  return agent.runtimeRole !== 'mirror';
}

export const useAgentStore = defineStore('agent', {
  state: () => ({ status: '' }),
  getters: {
    agents(): AgentRecord[] {
      const clientState = useClientStateStore();
      return [...clientState.agents].sort((left, right) => {
        const sourceOrder = Number(left.source === 'user') - Number(right.source === 'user');
        return sourceOrder || agentLabel(left).localeCompare(agentLabel(right), 'zh-CN') || left.id.localeCompare(right.id);
      });
    },
    configurableAgents(): AgentRecord[] {
      return this.agents.filter(isConfigurableAgent);
    },
    userAgents(): AgentRecord[] {
      return this.configurableAgents.filter((agent) => agent.source === 'user');
    }
  },
  actions: {
    activeAgentForConversation(conversationId: string): AgentRecord | undefined {
      const clientState = useClientStateStore();
      const feed = useReliableKernelClientFeedStore();
      const links = Object.values(feed.records.AgentConversationLink ?? {});
      const link = links.find((candidate) =>
        text(candidate.conversation_id) === conversationId && text(candidate.role) === 'default'
      ) ?? links.find((candidate) => text(candidate.conversation_id) === conversationId);
      return clientState.agents.find((agent) => agent.id === text(link?.agent_id));
    },
    selectAgent(conversationId: string, agentId: string): void {
      if (!conversationId || !agentId) return;
      const clientState = useClientStateStore();
      if (!clientState.agents.some((agent) => agent.id === agentId && isConfigurableAgent(agent))) return;
      bridge.request(BridgeMessageType.ConversationAgentSelect, { conversationId, agentId });
    },
    createAgent(name: string): void {
      const normalized = name.trim().replace(/\s+/g, ' ') || '新 Agent';
      this.status = '正在创建 Agent...';
      bridge.request(BridgeMessageType.AgentCreate, { name: normalized, kind: 'custom' });
    },
    renameAgent(agentId: string, name: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent) return;
      const nextName = name.trim().replace(/\s+/g, ' ') || agent.name;
      agent.name = nextName;
      this.status = '正在重命名 Agent...';
      bridge.request(BridgeMessageType.AgentUpdate, { agentId, name: nextName });
    },
    updateDescription(agentId: string, description: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent) return;
      const text = description.trim();
      if (text) agent.description = text;
      else delete agent.description;
      this.status = '正在更新 Agent 描述...';
      bridge.request(BridgeMessageType.AgentUpdate, { agentId, description: text });
    },
    deleteAgent(agentId: string): void {
      const clientState = useClientStateStore();
      const agent = clientState.agents.find((item) => item.id === agentId);
      if (!agent || agent.source === 'builtin') return;
      clientState.agents = clientState.agents.filter((item) => item.id !== agentId);
      this.status = '正在删除 Agent...';
      bridge.request(BridgeMessageType.AgentDelete, { agentId });
    }
  }
});

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

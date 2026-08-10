import { defineStore } from 'pinia';
import { type ConfigScopeKind, type LlmProviderKind, type ModelProfileRecord, type ModelProfileScopeLinkRecord } from '@shared/protocol';
import { bridge, BridgeMessageType } from '@webview/transport';
import { useClientStateStore } from './useClientStateStore';

interface PendingModelProfileSelection {
  requestId: string;
  profile: ModelProfileRecord;
  link: ModelProfileScopeLinkRecord;
}

function scopeIdFor(scopeKind: ConfigScopeKind, scopeId?: string): string | undefined { return scopeKind === 'global' ? undefined : scopeId?.trim(); }
function matches(link: ModelProfileScopeLinkRecord, scopeKind: ConfigScopeKind, scopeId?: string): boolean { return link.role === 'active' && link.scopeKind === scopeKind && scopeIdFor(scopeKind, link.scopeId) === scopeIdFor(scopeKind, scopeId); }
function latest<T extends { createdAt: number; updatedAt: number; id: string }>(items: T[]): T | undefined { return [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0]; }

export const useModelProfileStore = defineStore('modelProfile', {
  state: () => ({
    status: '',
    pendingSelections: {} as Record<string, PendingModelProfileSelection>
  }),
  actions: {
    localProfileFor(scopeKind: ConfigScopeKind, scopeId?: string): { profile?: ModelProfileRecord; link?: ModelProfileScopeLinkRecord } {
      const pending = this.pendingSelections[pendingKey(scopeKind, scopeId)];
      if (pending) return { profile: pending.profile, link: pending.link };
      const clientState = useClientStateStore();
      const link = latest(clientState.modelProfileScopeLinks.filter((item) => matches(item, scopeKind, scopeId)));
      const profile = clientState.modelProfiles.find((item) => item.id === link?.modelProfileId);
      return { ...(profile ? { profile } : {}), ...(link ? { link } : {}) };
    },
    setProfileForScope(scopeKind: ConfigScopeKind, scopeId: string | undefined, input: { name?: string; providerConfigId?: string; provider?: LlmProviderKind; model: string }): void {
      const normalizedScopeId = scopeIdFor(scopeKind, scopeId);
      const requestId = bridge.request(BridgeMessageType.ModelProfileScopeSet, {
        scopeKind,
        ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        model: input.model
      });
      const now = Date.now();
      const scopeSuffix = `${scopeKind}:${normalizedScopeId ?? 'global'}`;
      const profile: ModelProfileRecord = {
        id: `model-profile:${scopeSuffix}`,
        name: input.name?.trim() || 'LLM 配置',
        ...(input.providerConfigId?.trim() ? { providerConfigId: input.providerConfigId.trim() } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        model: input.model.trim()
      };
      this.pendingSelections[pendingKey(scopeKind, normalizedScopeId)] = {
        requestId,
        profile,
        link: {
          id: `model-profile-scope:${scopeSuffix}`,
          scopeKind,
          ...(normalizedScopeId ? { scopeId: normalizedScopeId } : {}),
          modelProfileId: profile.id,
          role: 'active',
          createdAt: now,
          updatedAt: now
        }
      };
      this.status = '正在保存 LLM 配置…';
    },
    reconcileSnapshot(correlationId?: string): void {
      if (!correlationId) return;
      let reconciled = false;
      for (const [key, pending] of Object.entries(this.pendingSelections)) {
        if (pending.requestId !== correlationId) continue;
        delete this.pendingSelections[key];
        reconciled = true;
      }
      if (reconciled) this.status = 'LLM 配置已同步';
    },
    rejectPending(correlationId: string | undefined, message: string): void {
      if (!correlationId) return;
      for (const [key, pending] of Object.entries(this.pendingSelections)) {
        if (pending.requestId !== correlationId) continue;
        delete this.pendingSelections[key];
        this.status = message;
      }
    },
    clearProfileScope(scopeKind: ConfigScopeKind, scopeId?: string): void {
      if (scopeKind === 'global') return;
      const clientState = useClientStateStore();
      clientState.modelProfileScopeLinks = clientState.modelProfileScopeLinks.filter((link) => !matches(link, scopeKind, scopeId));
      bridge.request(BridgeMessageType.ModelProfileScopeClear, { scopeKind, ...(scopeIdFor(scopeKind, scopeId) ? { scopeId: scopeIdFor(scopeKind, scopeId) } : {}) });
    }
  }
});

function pendingKey(scopeKind: ConfigScopeKind, scopeId?: string): string {
  return `${scopeKind}:${scopeIdFor(scopeKind, scopeId) ?? 'global'}`;
}

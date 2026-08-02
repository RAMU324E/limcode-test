import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  AgentCreatePayload,
  AgentDeletePayload,
  AgentRecord,
  AgentUpdatePayload,
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  CheckpointPolicyScopeSetPayload,
  ConfigScopeKind,
  ConversationWorkflowSelectPayload,
  ConversationWorkflowSelectionRecord,
  ConversationWorkEnvironmentLinkRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  ModelProfileScopeSetPayload,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  PlanReviewPolicyScopeSetPayload,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  RuntimeContextScopeSetPayload,
  SkillPolicyRecord,
  SkillPolicyScopeLinkRecord,
  SkillPolicyScopeSetPayload,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  SystemPromptScopeSetPayload,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  ToolPolicyScopeSetPayload,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord,
  WorkEnvironmentPolicyScopeSetPayload,
  WorkEnvironmentRecord,
  WorkflowCreatePayload,
  WorkflowRecord,
  WorkflowUpdatePayload
} from '../../shared/protocol';
import {
  canRemoveWorkEnvironment,
  createLocalFolderWorkEnvironmentRecord,
  createRemoteServerWorkEnvironmentRecord,
  isLocalFolderWorkEnvironment,
  isRemoteServerWorkEnvironment,
  workEnvironmentCapabilities,
  workEnvironmentIdFromUri
} from '../../shared/workEnvironmentCatalog';
import type { StoragePaths } from '../capabilities/vscodeStorage/paths';
import {
  loadRecordStore,
  saveRecordStore,
  withRecordStoreTransaction
} from '../capabilities/vscodeStorage/recordStore';
import { createDefaultAgentBlueprints } from '../world/modules/agent/blueprints';

const BLUEPRINTS = createDefaultAgentBlueprints();
const CONFIGURATION_MUTATION_LOCK = '.configuration-authority';
const DEFAULT_CHECKPOINT_TRIGGERS: CheckpointPolicyRecord['triggers'] = {
  conversationInitial: false,
  userMessageBefore: true,
  userMessageAfter: false,
  llmResponseBefore: false,
  llmResponseAfter: false,
  agentRunCompletedBefore: false,
  agentRunCompletedAfter: false,
  manual: true
};

type ScopeKind = ConfigScopeKind;

interface ScopeRef {
  scopeKind: ScopeKind;
  scopeId?: string;
}

interface ScopeLinkBase {
  id: string;
  scopeKind: string;
  scopeId?: string;
  role: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreSpec<TRecord extends { id: string }, TKey extends string> {
  root: vscode.Uri;
  index: vscode.Uri;
  key: TKey;
  idPrefix: string;
  label(record: TRecord): string;
}

/**
 * Settings-root mutation boundary. It never reads or writes Runtime SQLite.
 * A dedicated cross-process lock serializes multi-store record/link updates; record-first set and
 * link-first clear ordering make an interrupted operation leave at most an unreachable record.
 */
export class VscodeConfigurationMutations {
  public constructor(private readonly getPaths: () => StoragePaths) {}

  public createAgent(payload: AgentCreatePayload): Promise<AgentRecord> {
    return this.mutate(async (paths) => {
      const spec = agentStore(paths);
      const records = await loadStore(spec);
      const record: AgentRecord = {
        id: `agent:${randomUUID()}`,
        name: normalizedName(payload.name, '新 Agent'),
        ...(normalizedOptionalText(payload.description) ? { description: normalizedOptionalText(payload.description) } : {}),
        kind: normalizedOptionalText(payload.kind) ?? 'custom',
        source: 'user',
        status: 'idle'
      };
      await saveStore(spec, upsert(records, record));
      return record;
    });
  }

  public updateAgent(payload: AgentUpdatePayload): Promise<AgentRecord> {
    return this.mutate(async (paths) => {
      const spec = agentStore(paths);
      const configured = await loadStore(spec);
      const id = requireId(payload.agentId, 'agentId');
      const current = configured.find((record) => record.id === id) ?? builtinAgent(id);
      if (!current) throw new Error(`Agent 不存在：${id}`);
      const description = payload.description === undefined
        ? current.description
        : normalizedOptionalText(payload.description);
      const record: AgentRecord = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : normalizedName(payload.name, current.name),
        kind: payload.kind === undefined ? current.kind : normalizedName(payload.kind, current.kind),
        source: current.source,
        status: 'idle',
        ...(description ? { description } : {})
      };
      if (!description) delete record.description;
      await saveStore(spec, upsert(configured, record));
      return record;
    });
  }

  public deleteAgent(payload: AgentDeletePayload): Promise<void> {
    return this.mutate(async (paths) => {
      const id = requireId(payload.agentId, 'agentId');
      if (builtinAgent(id)) throw new Error('内置 Agent 不能删除。');
      const spec = agentStore(paths);
      const configured = await loadStore(spec);
      if (!configured.some((record) => record.id === id)) return;
      await saveStore(spec, configured.filter((record) => record.id !== id));
      await this.clearOwnerScopes(paths, 'agent', id);
    });
  }

  public createWorkflow(payload: WorkflowCreatePayload): Promise<WorkflowRecord> {
    return this.mutate(async (paths) => {
      const spec = workflowStore(paths);
      const records = await loadStore(spec);
      const now = Date.now();
      const record: WorkflowRecord = {
        id: `workflow:${randomUUID()}`,
        name: normalizedName(payload.name, '新工作流'),
        ...(normalizedOptionalText(payload.description) ? { description: normalizedOptionalText(payload.description) } : {}),
        source: 'user',
        icon: 'list-details',
        createdAt: now,
        updatedAt: now
      };
      await saveStore(spec, upsert(records, record));
      return record;
    });
  }

  public updateWorkflow(payload: WorkflowUpdatePayload): Promise<WorkflowRecord> {
    return this.mutate(async (paths) => {
      const spec = workflowStore(paths);
      const configured = await loadStore(spec);
      const id = requireId(payload.workflowId, 'workflowId');
      const current = configured.find((record) => record.id === id) ?? builtinWorkflow(id);
      if (!current) throw new Error(`Workflow 不存在：${id}`);
      const description = payload.description === undefined
        ? current.description
        : normalizedOptionalText(payload.description);
      const record: WorkflowRecord = {
        ...current,
        id,
        name: payload.name === undefined ? current.name : normalizedName(payload.name, current.name),
        source: current.source,
        createdAt: current.createdAt,
        updatedAt: Date.now(),
        ...(description ? { description } : {}),
        ...(payload.icon !== undefined ? { icon: payload.icon } : current.icon ? { icon: current.icon } : {})
      };
      if (!description) delete record.description;
      await saveStore(spec, upsert(configured, record));
      return record;
    });
  }

  public deleteWorkflow(workflowIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const workflowId = requireId(workflowIdInput, 'workflowId');
      if (builtinWorkflow(workflowId)) throw new Error('内置 Workflow 不能删除。');
      const spec = workflowStore(paths);
      const configured = await loadStore(spec);
      if (!configured.some((record) => record.id === workflowId)) return;
      await saveStore(spec, configured.filter((record) => record.id !== workflowId));
      await this.clearOwnerScopes(paths, 'workflow', workflowId);
      const selections = conversationWorkflowSelectionStore(paths);
      await saveStore(
        selections,
        (await loadStore(selections)).filter((selection) => selection.workflowId !== workflowId)
      );
    });
  }

  public synchronizeWorkspaceFolders(folders: readonly { uri: string; name: string; rootPath: string; index: number }[]): Promise<void> {
    return this.mutate(async (paths) => {
      const spec = workEnvironmentStore(paths);
      const records = await loadStore(spec);
      const byId = new Map(records.map((record) => [record.id, record]));
      const now = Date.now();
      const activeIds = new Set<string>();
      for (const folder of folders) {
        const uri = requireText(folder.uri, 'workspace folder uri');
        const id = workEnvironmentIdFromUri(uri);
        const record = createLocalFolderWorkEnvironmentRecord({
          id,
          name: normalizedName(folder.name, folder.rootPath),
          uri,
          rootPath: requireText(folder.rootPath, 'workspace folder path'),
          displayPath: folder.rootPath,
          index: folder.index,
          available: true,
          createdAt: byId.get(id)?.createdAt ?? now,
          updatedAt: now
        }, now);
        activeIds.add(record.id);
        byId.set(record.id, record);
      }
      for (const [id, record] of byId) {
        if (record.source === 'workspaceFolder' && !activeIds.has(id)) {
          byId.set(id, { ...record, available: false, updatedAt: now });
        }
      }
      await saveStore(spec, [...byId.values()]);

      const availableIds = new Set([...byId.values()].filter((record) => record.available).map((record) => record.id));
      const activeWorkspaceIds = [...activeIds];
      const policies = workEnvironmentPolicyStore(paths);
      await saveStore(policies, (await loadStore(policies)).map((policy) => {
        const availableAllowed = policy.allowedWorkEnvironmentIds.filter((id) => availableIds.has(id));
        const allowedWorkEnvironmentIds = availableAllowed.length > 0 || activeWorkspaceIds.length === 0
          ? [...policy.allowedWorkEnvironmentIds]
          : [...new Set([...policy.allowedWorkEnvironmentIds, ...activeWorkspaceIds])];
        const eligibleDefaults = allowedWorkEnvironmentIds.filter((id) => availableIds.has(id));
        const defaultWorkEnvironmentId = policy.defaultWorkEnvironmentId
          && eligibleDefaults.includes(policy.defaultWorkEnvironmentId)
          ? policy.defaultWorkEnvironmentId
          : eligibleDefaults[0];
        const unchanged = allowedWorkEnvironmentIds.length === policy.allowedWorkEnvironmentIds.length
          && allowedWorkEnvironmentIds.every((id, index) => id === policy.allowedWorkEnvironmentIds[index])
          && defaultWorkEnvironmentId === policy.defaultWorkEnvironmentId;
        if (unchanged) return policy;
        const { defaultWorkEnvironmentId: _staleDefault, ...rest } = policy;
        return {
          ...rest,
          allowedWorkEnvironmentIds,
          ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {}),
          updatedAt: now
        };
      }));
    });
  }

  public selectConversationWorkflow(payload: ConversationWorkflowSelectPayload): Promise<void> {
    return this.mutate(async (paths) => {
      const conversationId = requireId(payload.conversationId, 'conversationId');
      const workflowId = payload.scopeKind === 'workflow' ? requireId(payload.workflowId, 'workflowId') : undefined;
      if (workflowId && !await this.workflowExists(paths, workflowId)) throw new Error(`Workflow 不存在：${workflowId}`);
      const spec = conversationWorkflowSelectionStore(paths);
      const records = await loadStore(spec);
      const existing = latest(records.filter((record) => record.conversationId === conversationId && record.role === 'active'));
      const now = Date.now();
      const record: ConversationWorkflowSelectionRecord = {
        id: payload.scopeKind === 'global'
          ? `conversation-workflow:global:${conversationId}`
          : `conversation-workflow:workflow:${conversationId}:${workflowId}`,
        conversationId,
        scopeKind: payload.scopeKind,
        ...(workflowId ? { workflowId } : {}),
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await saveStore(
        spec,
        upsert(records.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active')), record)
      );
    });
  }

  public setModelProfile(payload: ModelProfileScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const model = requireId(payload.model, 'model');
    return this.mutate((paths) => this.setScoped(
      modelProfileStore(paths),
      modelProfileLinkStore(paths),
      scope,
      (link) => link.modelProfileId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('Model Profile', scope),
        ...(normalizedOptionalText(payload.providerConfigId)
          ? { providerConfigId: normalizedOptionalText(payload.providerConfigId) }
          : existing?.providerConfigId ? { providerConfigId: existing.providerConfigId } : {}),
        ...(payload.provider ? { provider: payload.provider } : existing?.provider ? { provider: existing.provider } : {}),
        model
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('model-profile', scope),
        ...scope,
        modelProfileId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearModelProfile(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      modelProfileStore(paths), modelProfileLinkStore(paths), scope, (link) => link.modelProfileId
    ));
  }

  public setToolPolicy(payload: ToolPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const allowedTools = uniqueStrings(payload.allowedTools);
    return this.mutate((paths) => this.setScoped(
      toolPolicyStore(paths),
      toolPolicyLinkStore(paths),
      scope,
      (link) => link.toolPolicyId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('工具', scope.scopeKind),
        allowedTools,
        ...(payload.preset !== undefined ? { preset: payload.preset } : existing?.preset !== undefined ? { preset: existing.preset } : {}),
        ...(payload.toolConfigs !== undefined ? { toolConfigs: plainClone(payload.toolConfigs) } : existing?.toolConfigs ? { toolConfigs: plainClone(existing.toolConfigs) } : {}),
        ...(payload.sourceConfigs !== undefined ? { sourceConfigs: plainClone(payload.sourceConfigs) } : existing?.sourceConfigs ? { sourceConfigs: plainClone(existing.sourceConfigs) } : {})
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('tool-policy', scope),
        ...scope,
        toolPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearToolPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      toolPolicyStore(paths), toolPolicyLinkStore(paths), scope, (link) => link.toolPolicyId
    ));
  }

  public setSkillPolicy(payload: SkillPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    return this.mutate((paths) => this.setScoped(
      skillPolicyStore(paths),
      skillPolicyLinkStore(paths),
      scope,
      (link) => link.skillPolicyId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('技能', scope.scopeKind),
        ...(payload.sourceConfigs !== undefined ? { sourceConfigs: plainClone(payload.sourceConfigs) } : existing?.sourceConfigs ? { sourceConfigs: plainClone(existing.sourceConfigs) } : {})
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('skill-policy', scope),
        ...scope,
        skillPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearSkillPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      skillPolicyStore(paths), skillPolicyLinkStore(paths), scope, (link) => link.skillPolicyId
    ));
  }

  public setSystemPrompt(payload: SystemPromptScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const text = requireText(payload.text, 'System Prompt');
    return this.mutate((paths) => this.setScoped(
      systemPromptStore(paths),
      systemPromptLinkStore(paths),
      scope,
      (link) => link.systemPromptId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('System Prompt', scope),
        text
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('system-prompt', scope),
        ...scope,
        systemPromptId: recordId,
        role: 'active' as const,
        ...(payload.order !== undefined ? { order: finiteInteger(payload.order, 0) } : existing?.order !== undefined ? { order: existing.order } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearSystemPrompt(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      systemPromptStore(paths), systemPromptLinkStore(paths), scope, (link) => link.systemPromptId
    ));
  }

  public setRuntimeContext(payload: RuntimeContextScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const template = requireText(payload.template, 'Runtime Context template');
    return this.mutate((paths) => this.setScoped(
      runtimeContextStore(paths),
      runtimeContextLinkStore(paths),
      scope,
      (link) => link.runtimeContextId,
      (existing, id) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultScopeName('Runtime Context', scope),
        template
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('runtime-context', scope),
        ...scope,
        runtimeContextId: recordId,
        role: 'active' as const,
        ...(payload.order !== undefined ? { order: finiteInteger(payload.order, 0) } : existing?.order !== undefined ? { order: existing.order } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearRuntimeContext(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      runtimeContextStore(paths), runtimeContextLinkStore(paths), scope, (link) => link.runtimeContextId
    ));
  }

  public setPlanReviewPolicy(payload: PlanReviewPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    const required = uniqueRiskLevels(payload.requireForToolRiskLevels);
    return this.mutate((paths) => this.setScoped(
      planReviewPolicyStore(paths),
      planReviewPolicyLinkStore(paths),
      scope,
      (link) => link.planReviewPolicyId,
      (existing, id, now) => ({
        id,
        mode: payload.mode,
        allowReadonlyBeforeApproval: payload.allowReadonlyBeforeApproval ?? existing?.allowReadonlyBeforeApproval ?? true,
        requireForToolRiskLevels: required.length > 0 ? required : existing?.requireForToolRiskLevels ?? ['write', 'command', 'agent'],
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? planReviewScopeLinkId(scope),
        ...scope,
        planReviewPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearPlanReviewPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      planReviewPolicyStore(paths), planReviewPolicyLinkStore(paths), scope, (link) => link.planReviewPolicyId
    ));
  }

  public setCheckpointPolicy(payload: CheckpointPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    return this.mutate((paths) => this.setScoped(
      checkpointPolicyStore(paths),
      checkpointPolicyLinkStore(paths),
      scope,
      (link) => link.checkpointPolicyId,
      (existing, id, now) => ({
        id,
        name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('存档点', scope.scopeKind),
        enabled: payload.enabled ?? existing?.enabled ?? true,
        initialSnapshotMaxBytes: positiveInteger(payload.initialSnapshotMaxBytes, existing?.initialSnapshotMaxBytes ?? 50 * 1024 * 1024),
        preserveEmptyDirectories: payload.preserveEmptyDirectories ?? existing?.preserveEmptyDirectories ?? true,
        useGitignore: payload.useGitignore ?? existing?.useGitignore ?? true,
        skipPatterns: uniqueStrings(payload.skipPatterns ?? existing?.skipPatterns ?? ['node_modules/', 'dist/', 'out/', 'build/']),
        triggers: {
          ...(existing?.triggers ?? DEFAULT_CHECKPOINT_TRIGGERS),
          ...(payload.triggers ?? {})
        },
        toolTriggers: normalizeCheckpointToolTriggers(existing?.toolTriggers, payload.toolTriggers),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }),
      (existing, recordId, now) => ({
        id: existing?.id ?? scopeLinkId('checkpoint-policy', scope),
        ...scope,
        checkpointPolicyId: recordId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      })
    ));
  }

  public clearCheckpointPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      checkpointPolicyStore(paths), checkpointPolicyLinkStore(paths), scope, (link) => link.checkpointPolicyId
    ));
  }

  public setWorkEnvironmentPolicy(payload: WorkEnvironmentPolicyScopeSetPayload): Promise<void> {
    const scope = normalizeScope(payload.scopeKind, payload.scopeId);
    return this.mutate(async (paths) => {
      const configured = await loadStore(workEnvironmentStore(paths));
      const available = new Set(configured.filter((record) => record.available).map((record) => record.id));
      const allowed = uniqueStrings(payload.allowedWorkEnvironmentIds).filter((id) => available.has(id));
      const defaultId = payload.defaultWorkEnvironmentId && allowed.includes(payload.defaultWorkEnvironmentId)
        ? payload.defaultWorkEnvironmentId
        : allowed[0];
      await this.setScoped(
        workEnvironmentPolicyStore(paths),
        workEnvironmentPolicyLinkStore(paths),
        scope,
        (link) => link.workEnvironmentPolicyId,
        (existing, id, now) => ({
          id,
          name: normalizedOptionalText(payload.name) ?? existing?.name ?? defaultPolicyName('工作环境', scope.scopeKind),
          enabled: payload.enabled ?? existing?.enabled ?? false,
          allowedWorkEnvironmentIds: allowed,
          ...(defaultId ? { defaultWorkEnvironmentId: defaultId } : {}),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        }),
        (existing, recordId, now) => ({
          id: existing?.id ?? scopeLinkId('work-environment-policy', scope),
          ...scope,
          workEnvironmentPolicyId: recordId,
          role: 'active' as const,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        })
      );
    });
  }

  public clearWorkEnvironmentPolicy(scopeKind: ScopeKind, scopeId?: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    return this.mutate((paths) => this.clearScoped(
      workEnvironmentPolicyStore(paths), workEnvironmentPolicyLinkStore(paths), scope, (link) => link.workEnvironmentPolicyId
    ));
  }

  public async upsertWorkEnvironment(input: WorkEnvironmentRecord): Promise<WorkEnvironmentRecord> {
    return (await this.upsertWorkEnvironments([input]))[0];
  }

  public upsertWorkEnvironments(inputs: readonly WorkEnvironmentRecord[]): Promise<WorkEnvironmentRecord[]> {
    return this.mutate(async (paths) => {
      const spec = workEnvironmentStore(paths);
      let records = await loadStore(spec);
      const saved: WorkEnvironmentRecord[] = [];
      for (const input of inputs) {
        const record = normalizeWorkEnvironmentRecord(input, records.find((candidate) => candidate.id === input.id));
        records = upsert(records, record);
        saved.push(record);
      }
      await saveStore(spec, records);
      return saved;
    });
  }

  public removeWorkEnvironment(workEnvironmentIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const workEnvironmentId = requireId(workEnvironmentIdInput, 'workEnvironmentId');
      const spec = workEnvironmentStore(paths);
      const records = await loadStore(spec);
      const record = records.find((candidate) => candidate.id === workEnvironmentId);
      if (!record) return;
      if (!canRemoveWorkEnvironment(record)) throw new Error('系统管理的工作环境不能删除。');
      await saveStore(spec, records.filter((candidate) => candidate.id !== workEnvironmentId));

      const selections = conversationWorkEnvironmentLinkStore(paths);
      await saveStore(selections, (await loadStore(selections)).filter((link) => link.workEnvironmentId !== workEnvironmentId));

      const policies = workEnvironmentPolicyStore(paths);
      await saveStore(policies, (await loadStore(policies)).map((policy) => {
        const allowedWorkEnvironmentIds = policy.allowedWorkEnvironmentIds.filter((id) => id !== workEnvironmentId);
        const defaultWorkEnvironmentId = policy.defaultWorkEnvironmentId === workEnvironmentId
          ? allowedWorkEnvironmentIds[0]
          : policy.defaultWorkEnvironmentId;
        const { defaultWorkEnvironmentId: _removedDefault, ...rest } = policy;
        return {
          ...rest,
          allowedWorkEnvironmentIds,
          ...(defaultWorkEnvironmentId ? { defaultWorkEnvironmentId } : {})
        };
      }));
    });
  }

  public selectConversationWorkEnvironment(conversationIdInput: string, workEnvironmentIdInput: string): Promise<void> {
    return this.mutate(async (paths) => {
      const conversationId = requireId(conversationIdInput, 'conversationId');
      const workEnvironmentId = requireId(workEnvironmentIdInput, 'workEnvironmentId');
      const environment = (await loadStore(workEnvironmentStore(paths))).find((record) => record.id === workEnvironmentId);
      if (!environment?.available) throw new Error(`工作环境不可用：${workEnvironmentId}`);
      const spec = conversationWorkEnvironmentLinkStore(paths);
      const records = await loadStore(spec);
      const existing = latest(records.filter((record) => record.conversationId === conversationId && record.role === 'active'));
      const now = Date.now();
      const record: ConversationWorkEnvironmentLinkRecord = {
        id: existing?.id ?? `conversation-work-environment:${conversationId}`,
        conversationId,
        workEnvironmentId,
        role: 'active' as const,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      await saveStore(
        spec,
        upsert(records.filter((candidate) => !(candidate.conversationId === conversationId && candidate.role === 'active')), record)
      );
    });
  }

  private mutate<T>(action: (paths: StoragePaths) => Promise<T>): Promise<T> {
    const paths = this.getPaths();
    const lockUri = vscode.Uri.joinPath(paths.settingsRootUri, CONFIGURATION_MUTATION_LOCK);
    return withRecordStoreTransaction(lockUri, () => action(paths));
  }

  private async workflowExists(paths: StoragePaths, workflowId: string): Promise<boolean> {
    return !!builtinWorkflow(workflowId)
      || (await loadStore(workflowStore(paths))).some((record) => record.id === workflowId);
  }

  private async clearOwnerScopes(paths: StoragePaths, scopeKind: ScopeKind, scopeId: string): Promise<void> {
    const scope = normalizeScope(scopeKind, scopeId);
    await this.clearScoped(modelProfileStore(paths), modelProfileLinkStore(paths), scope, (link) => link.modelProfileId);
    await this.clearScoped(planReviewPolicyStore(paths), planReviewPolicyLinkStore(paths), scope, (link) => link.planReviewPolicyId);
    await this.clearScoped(toolPolicyStore(paths), toolPolicyLinkStore(paths), scope, (link) => link.toolPolicyId);
    await this.clearScoped(skillPolicyStore(paths), skillPolicyLinkStore(paths), scope, (link) => link.skillPolicyId);
    await this.clearScoped(systemPromptStore(paths), systemPromptLinkStore(paths), scope, (link) => link.systemPromptId);
    await this.clearScoped(runtimeContextStore(paths), runtimeContextLinkStore(paths), scope, (link) => link.runtimeContextId);
    await this.clearScoped(workEnvironmentPolicyStore(paths), workEnvironmentPolicyLinkStore(paths), scope, (link) => link.workEnvironmentPolicyId);
    await this.clearScoped(checkpointPolicyStore(paths), checkpointPolicyLinkStore(paths), scope, (link) => link.checkpointPolicyId);
  }

  private async setScoped<
    TRecord extends { id: string },
    TLink extends ScopeLinkBase,
    TRecordKey extends string,
    TLinkKey extends string
  >(
    recordStore: StoreSpec<TRecord, TRecordKey>,
    linkStore: StoreSpec<TLink, TLinkKey>,
    scope: ScopeRef,
    linkedRecordId: (link: TLink) => string,
    buildRecord: (existing: TRecord | undefined, id: string, now: number) => TRecord,
    buildLink: (existing: TLink | undefined, recordId: string, now: number) => TLink
  ): Promise<void> {
    const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
    const matching = links.filter((link) => scopeMatches(link, scope));
    const existingLink = latest(matching);
    const recordId = existingLink ? linkedRecordId(existingLink) : scopeRecordId(recordStore.idPrefix, scope);
    const existingRecord = records.find((record) => record.id === recordId);
    const now = Date.now();
    const record = buildRecord(existingRecord, recordId, now);
    await saveStore(recordStore, upsert(records, record));
    const link = buildLink(existingLink, record.id, now);
    await saveStore(linkStore, upsert(links.filter((candidate) => !scopeMatches(candidate, scope)), link));
  }

  private async clearScoped<
    TRecord extends { id: string },
    TLink extends ScopeLinkBase,
    TRecordKey extends string,
    TLinkKey extends string
  >(
    recordStore: StoreSpec<TRecord, TRecordKey>,
    linkStore: StoreSpec<TLink, TLinkKey>,
    scope: ScopeRef,
    linkedRecordId: (link: TLink) => string
  ): Promise<void> {
    const [records, links] = await Promise.all([loadStore(recordStore), loadStore(linkStore)]);
    const removed = links.filter((link) => scopeMatches(link, scope));
    if (removed.length === 0) return;
    const nextLinks = links.filter((link) => !scopeMatches(link, scope));
    await saveStore(linkStore, nextLinks);
    const stillReferenced = new Set(nextLinks.map(linkedRecordId));
    const removedRecordIds = new Set(removed.map(linkedRecordId));
    await saveStore(recordStore, records.filter((record) => !removedRecordIds.has(record.id) || stillReferenced.has(record.id)));
  }
}

function agentStore(paths: StoragePaths): StoreSpec<AgentRecord, 'agent'> {
  return { root: paths.agentsRootUri, index: paths.agentsIndexUri, key: 'agent', idPrefix: 'agent', label: (record) => record.name };
}

function workflowStore(paths: StoragePaths): StoreSpec<WorkflowRecord, 'workflow'> {
  return { root: paths.workflowsRootUri, index: paths.workflowsIndexUri, key: 'workflow', idPrefix: 'workflow', label: (record) => record.name };
}

function modelProfileStore(paths: StoragePaths): StoreSpec<ModelProfileRecord, 'modelProfile'> {
  return { root: paths.modelProfilesRootUri, index: paths.modelProfilesIndexUri, key: 'modelProfile', idPrefix: 'model-profile', label: (record) => record.name };
}

function modelProfileLinkStore(paths: StoragePaths): StoreSpec<ModelProfileScopeLinkRecord, 'link'> {
  return { root: paths.modelProfileScopeLinksRootUri, index: paths.modelProfileScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function planReviewPolicyStore(paths: StoragePaths): StoreSpec<PlanReviewPolicyRecord, 'policy'> {
  return { root: paths.planReviewPoliciesRootUri, index: paths.planReviewPoliciesIndexUri, key: 'policy', idPrefix: 'plan-review-policy', label: (record) => record.id };
}

function planReviewPolicyLinkStore(paths: StoragePaths): StoreSpec<PlanReviewPolicyScopeLinkRecord, 'link'> {
  return { root: paths.planReviewPolicyScopeLinksRootUri, index: paths.planReviewPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function toolPolicyStore(paths: StoragePaths): StoreSpec<ToolPolicyRecord, 'toolPolicy'> {
  return { root: paths.toolPoliciesRootUri, index: paths.toolPoliciesIndexUri, key: 'toolPolicy', idPrefix: 'tool-policy', label: (record) => record.name };
}

function toolPolicyLinkStore(paths: StoragePaths): StoreSpec<ToolPolicyScopeLinkRecord, 'link'> {
  return { root: paths.toolPolicyScopeLinksRootUri, index: paths.toolPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function skillPolicyStore(paths: StoragePaths): StoreSpec<SkillPolicyRecord, 'skillPolicy'> {
  return { root: paths.skillPoliciesRootUri, index: paths.skillPoliciesIndexUri, key: 'skillPolicy', idPrefix: 'skill-policy', label: (record) => record.name };
}

function skillPolicyLinkStore(paths: StoragePaths): StoreSpec<SkillPolicyScopeLinkRecord, 'link'> {
  return { root: paths.skillPolicyScopeLinksRootUri, index: paths.skillPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function systemPromptStore(paths: StoragePaths): StoreSpec<SystemPromptRecord, 'systemPrompt'> {
  return { root: paths.systemPromptsRootUri, index: paths.systemPromptsIndexUri, key: 'systemPrompt', idPrefix: 'system-prompt', label: (record) => record.name };
}

function systemPromptLinkStore(paths: StoragePaths): StoreSpec<SystemPromptScopeLinkRecord, 'link'> {
  return { root: paths.systemPromptScopeLinksRootUri, index: paths.systemPromptScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function runtimeContextStore(paths: StoragePaths): StoreSpec<RuntimeContextRecord, 'runtimeContext'> {
  return { root: paths.runtimeContextsRootUri, index: paths.runtimeContextsIndexUri, key: 'runtimeContext', idPrefix: 'runtime-context', label: (record) => record.name };
}

function runtimeContextLinkStore(paths: StoragePaths): StoreSpec<RuntimeContextScopeLinkRecord, 'link'> {
  return { root: paths.runtimeContextScopeLinksRootUri, index: paths.runtimeContextScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function workEnvironmentStore(paths: StoragePaths): StoreSpec<WorkEnvironmentRecord, 'workEnvironment'> {
  return { root: paths.workEnvironmentsRootUri, index: paths.workEnvironmentsIndexUri, key: 'workEnvironment', idPrefix: 'work-environment', label: (record) => record.name };
}

function workEnvironmentPolicyStore(paths: StoragePaths): StoreSpec<WorkEnvironmentPolicyRecord, 'policy'> {
  return { root: paths.workEnvironmentPoliciesRootUri, index: paths.workEnvironmentPoliciesIndexUri, key: 'policy', idPrefix: 'work-environment-policy', label: (record) => record.name };
}

function workEnvironmentPolicyLinkStore(paths: StoragePaths): StoreSpec<WorkEnvironmentPolicyScopeLinkRecord, 'link'> {
  return { root: paths.workEnvironmentPolicyScopeLinksRootUri, index: paths.workEnvironmentPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function checkpointPolicyStore(paths: StoragePaths): StoreSpec<CheckpointPolicyRecord, 'policy'> {
  return { root: paths.checkpointPoliciesRootUri, index: paths.checkpointPoliciesIndexUri, key: 'policy', idPrefix: 'checkpoint-policy', label: (record) => record.name };
}

function checkpointPolicyLinkStore(paths: StoragePaths): StoreSpec<CheckpointPolicyScopeLinkRecord, 'link'> {
  return { root: paths.checkpointPolicyScopeLinksRootUri, index: paths.checkpointPolicyScopeLinksIndexUri, key: 'link', idPrefix: 'link', label: (record) => record.id };
}

function conversationWorkflowSelectionStore(paths: StoragePaths): StoreSpec<ConversationWorkflowSelectionRecord, 'selection'> {
  return {
    root: paths.conversationWorkflowSelectionsRootUri,
    index: paths.conversationWorkflowSelectionsIndexUri,
    key: 'selection',
    idPrefix: 'conversation-workflow',
    label: (record) => record.id
  };
}

function conversationWorkEnvironmentLinkStore(paths: StoragePaths): StoreSpec<ConversationWorkEnvironmentLinkRecord, 'link'> {
  return {
    root: paths.conversationWorkEnvironmentLinksRootUri,
    index: paths.conversationWorkEnvironmentLinksIndexUri,
    key: 'link',
    idPrefix: 'conversation-work-environment',
    label: (record) => record.id
  };
}

async function loadStore<TRecord extends { id: string }, TKey extends string>(
  spec: StoreSpec<TRecord, TKey>
): Promise<TRecord[]> {
  return (await loadRecordStore<TRecord, TKey>(spec.root, spec.index, spec.key)) ?? [];
}

async function saveStore<TRecord extends { id: string }, TKey extends string>(
  spec: StoreSpec<TRecord, TKey>,
  records: TRecord[]
): Promise<void> {
  await saveRecordStore(spec.root, spec.index, records, spec.key, spec.label, { pruneMissing: true });
}

function normalizeScope(scopeKind: ScopeKind, scopeIdInput?: string): ScopeRef {
  if (!['global', 'conversation', 'agent', 'workflow', 'run'].includes(scopeKind)) {
    throw new TypeError(`不支持的配置作用域：${String(scopeKind)}`);
  }
  if (scopeKind === 'global') return { scopeKind };
  return { scopeKind, scopeId: requireId(scopeIdInput, `${scopeKind} scopeId`) };
}

function scopeMatches(link: ScopeLinkBase, scope: ScopeRef): boolean {
  return link.role === 'active'
    && link.scopeKind === scope.scopeKind
    && (scope.scopeKind === 'global' ? link.scopeId === undefined : link.scopeId === scope.scopeId);
}

function scopeRecordId(prefix: string, scope: ScopeRef): string {
  return `${prefix}:${scope.scopeKind}:${scope.scopeId ?? 'global'}`;
}

function scopeLinkId(prefix: string, scope: ScopeRef): string {
  return `${prefix}-scope:${scope.scopeKind}:${scope.scopeId ?? 'global'}`;
}

function planReviewScopeLinkId(scope: ScopeRef): string {
  return scope.scopeKind === 'global'
    ? 'plan-review-policy-link:global'
    : `plan-review-policy-link:${scope.scopeKind}:${scope.scopeId}`;
}

function defaultScopeName(kind: string, scope: ScopeRef): string {
  return `${scope.scopeKind === 'global' ? 'Global' : scope.scopeKind} ${kind}`;
}

function defaultPolicyName(domain: string, scopeKind: ScopeKind): string {
  const prefix = scopeKind === 'global'
    ? '全局默认'
    : scopeKind === 'conversation'
      ? '对话'
      : scopeKind === 'agent'
        ? 'Agent '
        : scopeKind === 'workflow'
          ? '工作流'
          : '运行';
  return `${prefix}${domain}策略`;
}

function upsert<T extends { id: string }>(records: T[], record: T): T[] {
  return [...records.filter((candidate) => candidate.id !== record.id), record];
}

function latest<T extends { id: string; createdAt: number; updatedAt: number }>(records: T[]): T | undefined {
  return [...records].sort((left, right) =>
    right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id)
  )[0];
}

function builtinAgent(id: string): AgentRecord | undefined {
  const definition = BLUEPRINTS.agents[id] ?? Object.values(BLUEPRINTS.agents).find((candidate) => candidate.id === id);
  return definition ? {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    kind: definition.kind,
    source: 'builtin',
    status: 'idle'
  } : undefined;
}

function builtinWorkflow(id: string): WorkflowRecord | undefined {
  const definition = BLUEPRINTS.workflows[id] ?? Object.values(BLUEPRINTS.workflows).find((candidate) => candidate.id === id);
  return definition ? {
    id: definition.id,
    name: definition.name,
    ...(definition.description ? { description: definition.description } : {}),
    source: 'builtin',
    ...(definition.icon ? { icon: definition.icon } : {}),
    createdAt: 0,
    updatedAt: 0
  } : undefined;
}

function normalizeWorkEnvironmentRecord(input: WorkEnvironmentRecord, existing: WorkEnvironmentRecord | undefined): WorkEnvironmentRecord {
  const id = requireId(input.id, 'workEnvironment.id');
  const now = Date.now();
  if (isRemoteServerWorkEnvironment(input)) {
    return createRemoteServerWorkEnvironmentRecord({
      ...plainClone(input),
      id,
      host: requireText(input.host ?? input.name, 'workEnvironment.host'),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }, now);
  }
  if (isLocalFolderWorkEnvironment(input)) {
    return createLocalFolderWorkEnvironmentRecord({
      ...plainClone(input),
      id,
      name: normalizedName(input.name, existing?.name ?? id),
      uri: requireText(input.uri, 'workEnvironment.uri'),
      rootPath: requireText(input.rootPath, 'workEnvironment.rootPath'),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: now
    }, now);
  }
  return {
    ...plainClone(input),
    id,
    name: normalizedName(input.name, existing?.name ?? id),
    available: input.available !== false,
    capabilities: workEnvironmentCapabilities(input),
    createdAt: existing?.createdAt ?? input.createdAt ?? now,
    updatedAt: now
  };
}

function normalizeCheckpointToolTriggers(
  current: CheckpointPolicyRecord['toolTriggers'] | undefined,
  input: CheckpointPolicyScopeSetPayload['toolTriggers']
): CheckpointPolicyRecord['toolTriggers'] {
  const result: CheckpointPolicyRecord['toolTriggers'] = plainClone(current ?? {});
  for (const [name, config] of Object.entries(input ?? {})) {
    const key = name.trim();
    if (!key) continue;
    result[key] = {
      before: config.before ?? result[key]?.before ?? false,
      after: config.after ?? result[key]?.after ?? false
    };
  }
  return result;
}

function uniqueRiskLevels(
  input: PlanReviewPolicyScopeSetPayload['requireForToolRiskLevels']
): PlanReviewPolicyRecord['requireForToolRiskLevels'] {
  return [...new Set((input ?? []).filter((level) => level === 'write' || level === 'command' || level === 'agent'))];
}

function uniqueStrings(input: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of input) {
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalizedName(input: unknown, fallback: string): string {
  return normalizedOptionalText(input)?.replace(/\s+/g, ' ') ?? fallback;
}

function normalizedOptionalText(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined;
}

function requireId(input: unknown, label: string): string {
  const value = normalizedOptionalText(input);
  if (!value) throw new TypeError(`${label} 必须是非空字符串。`);
  return value;
}

function requireText(input: unknown, label: string): string {
  return requireId(input, label);
}

function positiveInteger(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.floor(input) : fallback;
}

function finiteInteger(input: unknown, fallback: number): number {
  return typeof input === 'number' && Number.isFinite(input) ? Math.floor(input) : fallback;
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

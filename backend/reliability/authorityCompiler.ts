import type {
  AgentRecord,
  ClientState,
  ConfigScopeKind,
  ModelProfileRecord,
  PlanReviewPolicyRecord,
  RuntimeContextRecord,
  SkillPolicyRecord,
  SystemPromptRecord,
  ToolPolicyRecord,
  ToolPolicyToolConfigRecord,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentRecord,
  WorkflowRecord
} from '../../shared/protocol';
import type { EffectiveTurnAuthority, JsonValue } from '../../shared/conversationReliability';
import { canonicalSha256 } from './canonicalJson';
import { DEFAULT_TURN_EXECUTION_POLICY } from './domain/turnExecutionPolicy';

interface ScopeSelector {
  kind: Exclude<ConfigScopeKind, 'run'>;
  ids: readonly string[];
}

interface ScopedRecord<T> {
  scopeKind: ScopeSelector['kind'];
  scopeId?: string;
  record: T;
}

export interface ChildTurnAuthorityProfile {
  /** Child role identity. This is not a permission scope. */
  agent: JsonValue;
  /** Agent-scoped model override; null means inherit the parent Turn's frozen model. */
  modelOverride: JsonValue;
  /** Agent-scoped instructions appended to the parent's frozen effective system prompt. */
  systemPromptAddition: JsonValue;
}

export interface DerivedChildAuthority {
  authority: EffectiveTurnAuthority;
  relation: 'equal' | 'restricted';
  overrideDigest: string;
}

/** Compiles one complete prospective root authority from the committed ECS ClientState projection. */
export function compileEffectiveTurnAuthority(
  state: ClientState,
  input: { conversationId?: string; agentId: string; executionPolicy?: JsonValue }
): EffectiveTurnAuthority {
  const agent = uniqueRecord(state.agents, input.agentId, 'Agent');
  if (!agent) throw new Error(`Cannot compile Turn authority for missing Agent ${input.agentId}.`);
  const agentScopeIds = [...new Set([
    agent.typeAgentId,
    agent.id,
    agent.kind
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const workflow = selectedWorkflow(state, input.conversationId);
  const scopes: ScopeSelector[] = [
    { kind: 'global', ids: [] },
    { kind: 'agent', ids: agentScopeIds },
    ...(workflow ? [{ kind: 'workflow' as const, ids: [workflow.id] }] : []),
    ...(input.conversationId ? [{ kind: 'conversation' as const, ids: [input.conversationId] }] : [])
  ];

  const systemPromptSources = scopedMany(
    state.systemPromptScopeLinks,
    state.systemPrompts,
    'systemPromptId',
    scopes
  );
  const runtimeContextSources = scopedMany(
    state.runtimeContextScopeLinks,
    state.runtimeContexts,
    'runtimeContextId',
    scopes
  );
  const model = firstScoped(
    state.modelProfileScopeLinks,
    state.modelProfiles,
    'modelProfileId',
    [...scopes].reverse()
  );
  const toolPolicies = scopes.flatMap((scope) => {
    const selected = latestScoped(state.toolPolicyScopeLinks, state.toolPolicies, 'toolPolicyId', scope);
    return selected ? [selected.record] : [];
  });
  const toolPolicy = toolPolicies.length > 0
    ? intersectToolPolicies(toolPolicies, `effective-tool-policy:${input.agentId}:${input.conversationId ?? 'detached'}`)
    : denyAllToolPolicy(`effective-tool-policy:${input.agentId}:${input.conversationId ?? 'detached'}`);
  const skill = firstScoped(
    state.skillPolicyScopeLinks,
    state.skillPolicies,
    'skillPolicyId',
    [...scopes].reverse()
  );
  const planReview = firstScoped(
    state.planReviewPolicyScopeLinks,
    state.planReviewPolicies,
    'planReviewPolicyId',
    planReviewScopePriority(scopes)
  );
  const workEnvironmentPolicy = firstScoped(
    state.workEnvironmentPolicyScopeLinks,
    state.workEnvironmentPolicies,
    'workEnvironmentPolicyId',
    planReviewScopePriority(scopes)
  );
  const workEnvironment = resolveWorkEnvironment(
    state,
    input.conversationId,
    workEnvironmentPolicy?.record
  );
  const runtimeSnapshot = input.conversationId
    ? latestConversationRuntimeSnapshot(state, input.conversationId)
    : undefined;
  const approvalMode = toolPolicy.preset === 'yolo' ? 'yolo' : 'interactive';
  const approvalPolicy = {
    mode: approvalMode,
    planReview: planReview?.record ?? disabledPlanReviewPolicy()
  };
  const sandboxPolicy = jsonObjectField(input.executionPolicy, 'sandboxPolicy') ?? {
    mode: approvalMode === 'yolo' ? 'workspace_and_explicit_environment' : 'workspace_only'
  };
  const networkPolicy = jsonObjectField(input.executionPolicy, 'networkPolicy') ?? {
    mode: approvalMode === 'yolo' ? 'allowed_by_tool_policy' : 'approval_required'
  };
  const permissionProfile = jsonObjectField(input.executionPolicy, 'permissionProfile') ?? {
    mode: approvalMode === 'yolo' ? 'yolo' : 'interactive',
    toolPolicyHash: canonicalSha256(toolPolicy)
  };
  const runtimeContext = {
    text: runtimeSnapshot?.text
      ?? runtimeContextSources.map((source) => source.record.template.trim()).filter(Boolean).join('\n\n'),
    sources: runtimeContextSources,
    ...(runtimeSnapshot ? { snapshot: runtimeSnapshot } : {})
  };
  const systemPrompt = {
    text: systemPromptSources.map((source) => source.record.text.trim()).filter(Boolean).join('\n\n'),
    sources: systemPromptSources
  };
  const skillPolicy = skill?.record ?? disabledSkillPolicy();
  const baseExecutionPolicy = object(input.executionPolicy) ?? object(DEFAULT_TURN_EXECUTION_POLICY)!;
  const executionPolicy = {
    ...clone(baseExecutionPolicy),
    toolPolicy: clone(toolPolicy),
    skillPolicy: clone(skillPolicy),
    approvalPolicy: clone(approvalPolicy),
    sandboxPolicy: clone(sandboxPolicy),
    networkPolicy: clone(networkPolicy),
    permissionProfile: clone(permissionProfile),
    runtimeContext: clone(runtimeContext),
    workEnvironment: clone(workEnvironment)
  };

  const authority: EffectiveTurnAuthority = {
    agent: clone(agent) as unknown as JsonValue,
    workflow: clone(workflow ?? { id: 'none', kind: 'none' }) as unknown as JsonValue,
    model: clone(model ? { profile: model.record, selectedFrom: scopeIdentity(model) } : { profile: null, selectedFrom: 'provider_default' }) as unknown as JsonValue,
    systemPrompt: clone(systemPrompt) as unknown as JsonValue,
    toolPolicy: clone(toolPolicy) as unknown as JsonValue,
    skillPolicy: clone(skillPolicy) as unknown as JsonValue,
    approvalPolicy: clone(approvalPolicy) as unknown as JsonValue,
    sandboxPolicy: clone(sandboxPolicy),
    networkPolicy: clone(networkPolicy),
    permissionProfile: clone(permissionProfile),
    runtimeContext: clone(runtimeContext) as unknown as JsonValue,
    workEnvironment: clone(workEnvironment) as unknown as JsonValue,
    executionPolicy: clone(executionPolicy) as unknown as JsonValue
  };
  assertCompleteEffectiveAuthority(authority);
  return authority;
}

/**
 * Compiles only role-owned child fields. It intentionally ignores global, workflow and child
 * conversation permission scopes: those were already resolved by the parent Turn admission.
 */
export function compileChildTurnAuthorityProfile(
  state: ClientState,
  targetAgentId: string
): ChildTurnAuthorityProfile {
  const agent = uniqueRecord(state.agents, targetAgentId, 'Child Agent');
  if (!agent) throw new Error(`Cannot compile child authority profile for missing Agent ${targetAgentId}.`);
  const agentScopeIds = [...new Set([
    agent.typeAgentId,
    agent.id,
    agent.kind
  ].filter((value): value is string => typeof value === 'string' && value.length > 0))];
  const agentScopes: ScopeSelector[] = [{ kind: 'agent', ids: agentScopeIds }];
  const model = firstScoped(
    state.modelProfileScopeLinks,
    state.modelProfiles,
    'modelProfileId',
    agentScopes
  );
  const systemPromptSources = scopedMany(
    state.systemPromptScopeLinks,
    state.systemPrompts,
    'systemPromptId',
    agentScopes
  );
  return {
    agent: clone(agent) as unknown as JsonValue,
    modelOverride: model
      ? clone({ profile: model.record, selectedFrom: scopeIdentity(model) }) as unknown as JsonValue
      : null,
    systemPromptAddition: clone({
      text: systemPromptSources.map((source) => source.record.text.trim()).filter(Boolean).join('\n\n'),
      sources: systemPromptSources
    }) as unknown as JsonValue
  };
}

/**
 * Derives a child from the parent's effective snapshot, mirroring Codex's spawn rule: start from
 * the live parent Turn, layer role identity/model/instructions, then reapply every runtime-owned
 * permission field from the parent. Role selection can never silently change YOLO, approval,
 * sandbox, network, tools, skills, cwd or work-environment authority.
 */
export function deriveChildAuthority(
  parent: EffectiveTurnAuthority,
  childProfile: ChildTurnAuthorityProfile,
  targetAgentId: string
): DerivedChildAuthority {
  assertCompleteEffectiveAuthority(parent);
  const childAgent = object(childProfile.agent);
  if (childAgent?.id !== targetAgentId) {
    throw new Error(`Child authority Agent ${String(childAgent?.id)} does not match target ${targetAgentId}.`);
  }
  const model = childProfile.modelOverride === null
    ? clone(parent.model)
    : requireObjectJson(childProfile.modelOverride, 'Child model override');
  const systemPrompt = appendAuthorityText(parent.systemPrompt, childProfile.systemPromptAddition);
  const authority: EffectiveTurnAuthority = {
    agent: clone(childProfile.agent),
    workflow: clone(parent.workflow),
    model: clone(model),
    systemPrompt: clone(systemPrompt),
    toolPolicy: clone(parent.toolPolicy),
    skillPolicy: clone(parent.skillPolicy),
    approvalPolicy: clone(parent.approvalPolicy),
    sandboxPolicy: clone(parent.sandboxPolicy),
    networkPolicy: clone(parent.networkPolicy),
    permissionProfile: clone(parent.permissionProfile),
    runtimeContext: clone(parent.runtimeContext),
    workEnvironment: clone(parent.workEnvironment),
    executionPolicy: clone(parent.executionPolicy)
  };
  assertCompleteEffectiveAuthority(authority);
  if (authoritySecurityEnvelopeHash(parent) !== authoritySecurityEnvelopeHash(authority)) {
    throw new Error('Child role profile changed the frozen parent security envelope.');
  }
  return {
    authority,
    relation: 'equal',
    overrideDigest: canonicalSha256(childProfile)
  };
}

export function authoritySecurityEnvelopeHash(authority: EffectiveTurnAuthority): string {
  assertCompleteEffectiveAuthority(authority);
  return canonicalSha256(securityEnvelope(authority));
}

export function assertCompleteEffectiveAuthority(authority: EffectiveTurnAuthority): void {
  for (const key of [
    'agent',
    'workflow',
    'model',
    'systemPrompt',
    'toolPolicy',
    'skillPolicy',
    'approvalPolicy',
    'sandboxPolicy',
    'networkPolicy',
    'permissionProfile',
    'runtimeContext',
    'workEnvironment',
    'executionPolicy'
  ] as const) {
    if (!object(authority[key])) throw new Error(`Effective Turn authority is incomplete at ${key}.`);
  }
  const executionPolicy = object(authority.executionPolicy)!;
  for (const deadline of [
    'contextDeadlineMs',
    'resolveInvocationDeadlineMs',
    'requestDeadlineMs',
    'toolDeadlineMs',
    'checkpointDeadlineMs',
    'compressionDeadlineMs'
  ]) {
    const value = executionPolicy[deadline];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Effective Turn authority has invalid execution policy ${deadline}.`);
    }
  }
}

function selectedWorkflow(state: ClientState, conversationId: string | undefined): WorkflowRecord | undefined {
  if (!conversationId) return undefined;
  const selection = state.conversationWorkflowSelections
    .filter((candidate) => candidate.conversationId === conversationId && candidate.role === 'active')
    .sort(newest)[0];
  return selection?.scopeKind === 'workflow' && selection.workflowId
    ? uniqueRecord(state.workflows, selection.workflowId, 'Workflow')
    : undefined;
}

function scopedMany<
  TLink extends { id: string; scopeKind: string; scopeId?: string; role: string; order?: number; createdAt: number; updatedAt: number },
  TRecord extends { id: string }
>(
  links: readonly TLink[],
  records: readonly TRecord[],
  foreignKey: keyof TLink,
  scopes: readonly ScopeSelector[]
): ScopedRecord<TRecord>[] {
  const result: ScopedRecord<TRecord>[] = [];
  for (const scope of scopes) {
    const matches = links
      .filter((link) => link.role === 'active' && matchesScope(link, scope))
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0)
        || left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    for (const link of matches) {
      const id = link[foreignKey];
      if (typeof id !== 'string') continue;
      const record = uniqueRecord(records, id, 'Scoped authority record');
      if (!record) throw new Error(`Authority scope link ${link.id} references missing record ${id}.`);
      result.push({ scopeKind: scope.kind, ...(link.scopeId ? { scopeId: link.scopeId } : {}), record: clone(record) });
    }
  }
  return dedupeScopedRecords(result);
}

function firstScoped<
  TLink extends { id: string; scopeKind: string; scopeId?: string; role: string; createdAt: number; updatedAt: number },
  TRecord extends { id: string }
>(
  links: readonly TLink[],
  records: readonly TRecord[],
  foreignKey: keyof TLink,
  scopes: readonly ScopeSelector[]
): ScopedRecord<TRecord> | undefined {
  for (const scope of scopes) {
    const selected = latestScoped(links, records, foreignKey, scope);
    if (selected) return selected;
  }
  return undefined;
}

function latestScoped<
  TLink extends { id: string; scopeKind: string; scopeId?: string; role: string; createdAt: number; updatedAt: number },
  TRecord extends { id: string }
>(
  links: readonly TLink[],
  records: readonly TRecord[],
  foreignKey: keyof TLink,
  scope: ScopeSelector
): ScopedRecord<TRecord> | undefined {
  const link = links
    .filter((candidate) => candidate.role === 'active' && matchesScope(candidate, scope))
    .sort(newest)[0];
  if (!link) return undefined;
  const id = link[foreignKey];
  if (typeof id !== 'string') return undefined;
  const record = uniqueRecord(records, id, 'Scoped authority record');
  if (!record) throw new Error(`Authority scope link ${link.id} references missing record ${id}.`);
  return { scopeKind: scope.kind, ...(link.scopeId ? { scopeId: link.scopeId } : {}), record: clone(record) };
}

function matchesScope(link: { scopeKind: string; scopeId?: string }, scope: ScopeSelector): boolean {
  if (link.scopeKind !== scope.kind) return false;
  if (scope.kind === 'global') return link.scopeId === undefined;
  return typeof link.scopeId === 'string' && scope.ids.includes(link.scopeId);
}

function planReviewScopePriority(scopes: readonly ScopeSelector[]): ScopeSelector[] {
  const byKind = new Map(scopes.map((scope) => [scope.kind, scope]));
  return ['workflow', 'conversation', 'agent', 'global']
    .flatMap((kind) => byKind.get(kind as ScopeSelector['kind']) ?? []);
}

function latestConversationRuntimeSnapshot(state: ClientState, conversationId: string) {
  const link = state.conversationRuntimeContextSnapshotLinks
    .filter((candidate) => candidate.conversationId === conversationId && candidate.role === 'active')
    .sort(newest)[0];
  return link
    ? uniqueRecord(state.runtimeContextSnapshots, link.runtimeContextSnapshotId, 'RuntimeContextSnapshot')
    : undefined;
}

function resolveWorkEnvironment(
  state: ClientState,
  conversationId: string | undefined,
  policy: WorkEnvironmentPolicyRecord | undefined
) {
  const allowedIds = new Set(policy?.enabled === false
    ? []
    : policy?.allowedWorkEnvironmentIds ?? state.workEnvironments.filter((item) => item.available).map((item) => item.id));
  const allowed = state.workEnvironments
    .filter((item) => item.available && allowedIds.has(item.id))
    .map(sanitizeWorkEnvironment);
  const activeLink = conversationId
    ? state.conversationWorkEnvironmentLinks
      .filter((candidate) => candidate.conversationId === conversationId && candidate.role === 'active')
      .sort(newest)[0]
    : undefined;
  const activeId = activeLink && allowedIds.has(activeLink.workEnvironmentId)
    ? activeLink.workEnvironmentId
    : policy?.defaultWorkEnvironmentId && allowedIds.has(policy.defaultWorkEnvironmentId)
      ? policy.defaultWorkEnvironmentId
      : allowed[0]?.id;
  const active = activeId ? allowed.find((item) => item.id === activeId) : undefined;
  return {
    activeId: active?.id ?? null,
    allowedIds: allowed.map((item) => item.id),
    allowed,
    policy: policy ? clone(policy) : { id: 'none', name: 'No work environment policy', enabled: false, allowedWorkEnvironmentIds: [] }
  };
}

function appendAuthorityText(parentValue: JsonValue, additionValue: JsonValue): JsonValue {
  const parent = object(parentValue) ?? {};
  const addition = object(additionValue) ?? {};
  const parentSources = Array.isArray(parent.sources) ? parent.sources : [];
  const additionSources = Array.isArray(addition.sources) ? addition.sources : [];
  const sources = dedupeJsonRecords([...parentSources, ...additionSources]);
  const parentText = typeof parent.text === 'string' ? parent.text.trim() : '';
  const additionText = typeof addition.text === 'string' ? addition.text.trim() : '';
  return clone({
    ...parent,
    text: [parentText, additionText].filter(Boolean).join('\n\n'),
    sources
  }) as unknown as JsonValue;
}

function requireObjectJson(value: JsonValue, label: string): JsonValue {
  if (!object(value)) throw new Error(`${label} must be a JSON object.`);
  return clone(value);
}

function securityEnvelope(authority: EffectiveTurnAuthority): JsonValue {
  return clone({
    toolPolicy: authority.toolPolicy,
    skillPolicy: authority.skillPolicy,
    approvalPolicy: authority.approvalPolicy,
    sandboxPolicy: authority.sandboxPolicy,
    networkPolicy: authority.networkPolicy,
    permissionProfile: authority.permissionProfile,
    workEnvironment: authority.workEnvironment,
    executionPolicy: authority.executionPolicy
  }) as unknown as JsonValue;
}

function intersectToolPolicies(policies: readonly ToolPolicyRecord[], id: string): ToolPolicyRecord {
  const preset = policies.reduce<ToolPolicyRecord['preset']>((selected, policy) =>
    policy.preset && policy.preset !== 'inherit' ? policy.preset : selected, undefined);
  let allowed = new Set(policies[0]?.allowedTools ?? []);
  for (const policy of policies.slice(1)) {
    const next = new Set(policy.allowedTools);
    allowed = new Set([...allowed].filter((tool) => next.has(tool)));
  }
  const toolConfigs: Record<string, ToolPolicyToolConfigRecord> = {};
  const sourceConfigs: NonNullable<ToolPolicyRecord['sourceConfigs']> = {};
  for (const policy of policies) {
    for (const [sourceId, config] of Object.entries(policy.sourceConfigs ?? {})) {
      const previous = sourceConfigs[sourceId];
      sourceConfigs[sourceId] = {
        enabled: previous?.enabled === false || config.enabled === false ? false : config.enabled || previous?.enabled === true,
        disabledTools: [...new Set([...(previous?.disabledTools ?? []), ...(config.disabledTools ?? [])])]
      };
    }
    for (const [toolName, config] of Object.entries(policy.toolConfigs ?? {})) {
      const previous = toolConfigs[toolName];
      toolConfigs[toolName] = {
        config: { ...(previous?.config ?? {}), ...(config.config ?? {}) },
        autoApproveExecution: previous?.autoApproveExecution === false || config.autoApproveExecution === false ? false : config.autoApproveExecution ?? previous?.autoApproveExecution,
        autoApplyChange: previous?.autoApplyChange === false || config.autoApplyChange === false ? false : config.autoApplyChange ?? previous?.autoApplyChange,
        autoApplyChangeDelaySeconds: config.autoApplyChangeDelaySeconds ?? previous?.autoApplyChangeDelaySeconds,
        autoSubmitResult: previous?.autoSubmitResult === false || config.autoSubmitResult === false ? false : config.autoSubmitResult ?? previous?.autoSubmitResult,
        ...(config.display || previous?.display ? { display: { ...(previous?.display ?? {}), ...(config.display ?? {}) } } : {})
      };
    }
  }
  for (const toolName of preset === 'yolo' ? [] : Object.keys(toolConfigs)) {
    if (!allowed.has(toolName)) delete toolConfigs[toolName];
  }
  return {
    id,
    name: 'Effective Tool Policy',
    allowedTools: [...allowed].sort(),
    ...(preset ? { preset } : {}),
    ...(Object.keys(toolConfigs).length > 0 ? { toolConfigs } : {}),
    ...(Object.keys(sourceConfigs).length > 0 ? { sourceConfigs } : {})
  };
}

function requireToolPolicy(value: JsonValue, label: string): ToolPolicyRecord {
  const policy = object(value) as unknown as ToolPolicyRecord | undefined;
  if (!policy || !Array.isArray(policy.allowedTools) || typeof policy.id !== 'string') {
    throw new Error(`${label} authority has no complete ToolPolicy.`);
  }
  return clone(policy);
}

function denyAllToolPolicy(id: string): ToolPolicyRecord {
  return { id, name: 'Frozen deny-all Tool Policy', allowedTools: [], preset: 'custom' };
}

function disabledSkillPolicy(): SkillPolicyRecord {
  return {
    id: 'effective-skill-policy:none',
    name: 'No skills',
    sourceConfigs: {
      agents: { enabled: false },
      claude: { enabled: false },
      global: { enabled: false }
    }
  };
}

function disabledPlanReviewPolicy(): PlanReviewPolicyRecord {
  return {
    id: 'effective-plan-review:none',
    mode: 'off',
    allowReadonlyBeforeApproval: true,
    requireForToolRiskLevels: [],
    createdAt: 0,
    updatedAt: 0
  };
}

function sanitizeWorkEnvironment(record: WorkEnvironmentRecord): WorkEnvironmentRecord {
  const { password: _password, ...safe } = record;
  return clone(safe);
}

function scopeIdentity(value: ScopedRecord<unknown>): string {
  return value.scopeKind === 'global' ? 'global' : `${value.scopeKind}:${value.scopeId ?? ''}`;
}

function dedupeScopedRecords<T extends { id: string }>(records: readonly ScopedRecord<T>[]): ScopedRecord<T>[] {
  const seen = new Set<string>();
  return records.filter((item) => {
    const key = `${item.scopeKind}:${item.scopeId ?? ''}:${item.record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeJsonRecords(values: JsonValue[]): JsonValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = canonicalSha256(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(clone);
}

function uniqueRecord<T extends { id: string }>(records: readonly T[], id: string, label: string): T | undefined {
  const matches = records.filter((record) => record.id === id);
  if (matches.length > 1) throw new Error(`${label} identity is ambiguous: ${id}.`);
  return matches[0];
}

function newest<T extends { id: string; createdAt: number; updatedAt: number }>(left: T, right: T): number {
  return right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || right.id.localeCompare(left.id);
}

function object(value: unknown): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function jsonObjectField(value: JsonValue | undefined, field: string): JsonValue | undefined {
  const record = object(value);
  return object(record?.[field]) ? clone(record![field]!) : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

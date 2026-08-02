import * as path from 'node:path';
import type * as vscode from 'vscode';
import type {
  CommandCapability,
  CommandOutputLimits,
  CommandRunArgs,
  CommandRunObserver,
  CommandRunResult,
  WorkEnvironmentCapabilityOptions
} from '../../capabilities/types';
import { createSkillCatalogCapability } from '../../capabilities/skillCatalog';
import { createRulesCatalogCapability } from '../../capabilities/rulesCatalog';
import { createVsCodeFsCapability } from '../../capabilities/vscodeFs';
import { createWorkEnvironmentRuntimeCapability } from '../../capabilities/workEnvironmentTransfer';
import { McpRuntimeManager, dedupeMcpToolNames } from '../mcpRuntimeManager';
import { createBuiltinToolDefinitions } from '../../world/modules/tools/definitions';
import {
  toolDefinitionRecord,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResultOut
} from '../../world/modules/tools/registry';
import type { RuleFileRecord, RuleScope, SkillDefinitionRecord, ToolDefinitionRecord, WorkEnvironmentRecord } from '../../../shared/protocol';
import type {
  ReliableAgentToolDispatchInput,
  ReliableAgentToolPause
} from '../../reliableKernel/agentLoop';
import {
  LocalFileToolPlanner,
  resolvePathInsideBoundary,
  type ResolvedLocalToolPath
} from '../../reliableKernel/localFileToolPlanner';
import type { ToolTerminalResult } from '../../reliableKernel/effectControlPlane';
import type {
  ReliableToolDispatchAuthority,
  ReliableToolDispatcherHost
} from '../../reliableKernel/toolDispatcher';
import { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import type { PlainJsonValue } from '../../reliableKernel/plainJson';
import { resolveFrozenWorkEnvironmentBoundary } from '../../reliableKernel/workEnvironmentBoundary';

export interface VscodeReliableToolHostOptions {
  dispatchSpecial?: (
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ) => Promise<ToolTerminalResult | ReliableAgentToolPause | undefined>;
}

/** VS Code capability adapter only; Runtime lifecycle remains owned by ReliableToolDispatcher. */
export class VscodeReliableToolHost implements ReliableToolDispatcherHost {
  public readonly mcp: McpRuntimeManager;
  private readonly fs = createVsCodeFsCapability();
  private readonly skills;
  private readonly rules;
  private readonly workEnvironment = createWorkEnvironmentRuntimeCapability();
  private readonly commandDeclaration = commandDeclarationCapability();
  private readonly builtins: ToolDefinition[];
  private readonly filePlanner: LocalFileToolPlanner;

  public constructor(
    context: vscode.ExtensionContext,
    private readonly configuration: VscodeConfigurationAuthority,
    private readonly options: VscodeReliableToolHostOptions = {}
  ) {
    this.skills = createSkillCatalogCapability(context);
    this.rules = createRulesCatalogCapability(context);
    this.mcp = new McpRuntimeManager(configuration);
    this.builtins = createBuiltinToolDefinitions({ command: this.commandDeclaration });
    this.filePlanner = new LocalFileToolPlanner((inputPath, authority) => this.resolveFilePath(inputPath, authority));
  }

  public async initialize(): Promise<void> {
    await Promise.all([
      this.skills.refresh(),
      this.rules.refresh(),
      this.mcp.refreshFromSettings({ discover: true })
    ]);
  }

  public async dispose(): Promise<void> {
    await this.mcp.dispose();
  }

  public definitions(): ToolDefinition[] {
    return [
      ...this.builtins,
      ...dedupeMcpToolNames(this.mcp.runtimeTools(), this.builtins.map((definition) => definition.declaration.name))
    ];
  }

  public definitionRecords(): ToolDefinitionRecord[] {
    return this.definitions().map(toolDefinitionRecord);
  }

  public skillDefinitions(): SkillDefinitionRecord[] {
    return this.skills.list().map((skill) => ({ ...skill }));
  }

  public ruleFiles(): RuleFileRecord[] {
    return this.rules.list().map((rule) => ({ ...rule }));
  }

  public async refreshSkillCatalog(): Promise<void> {
    await this.skills.refresh();
  }

  public async refreshRulesCatalog(): Promise<void> {
    await this.rules.refresh();
  }

  public async saveRulesFile(scope: RuleScope, content: string): Promise<void> {
    await this.rules.writeAgents(scope, content);
    await this.rules.refresh();
  }

  public async executeNoEffect(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolResultOut> {
    if (definition.execution !== 'runtime') throw new Error(`Tool ${definition.declaration.name} is not a runtime definition.`);
    if (!['read', 'skills'].includes(definition.declaration.name)) {
      throw new Error(`Tool ${definition.declaration.name} is not classified as a repeatable no-effect capability.`);
    }
    const environments = await this.resolveEnvironments(authority);
    const context: ToolExecutionContext = {
      toolCallId: input.toolCallId,
      conversationId: authorityConversationId(authority.document),
      ...(authority.toolConfig?.config ? { config: plainClone(authority.toolConfig.config) } : {}),
      settingsSnapshot: {
        enableMultimodalTools: authorityMultimodalEnabled(authority.document)
      },
      ...(environments.active ? { workEnvironment: environments.active } : {}),
      workEnvironments: environments.allowed,
      accessibleWorkEnvironments: environments.allowed,
      emit() {}
    };
    return definition.execute(input.arguments, {
      fs: this.fs,
      command: this.commandDeclaration,
      workEnvironment: this.workEnvironment,
      skills: this.skills
    }, context);
  }

  public planFileMutation(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ) {
    return this.filePlanner.plan(definition, input, authority);
  }

  public async resolveProcessCwd(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<string> {
    const environments = await this.resolveEnvironments(authority);
    const active = environments.active;
    if (!active?.rootPath || active.kind !== 'localFolder') {
      throw new Error('可靠进程工具首发只允许具有本地 rootPath 的 active work environment。');
    }
    const args = asRecord(input.arguments);
    const requested = typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '.';
    const root = path.resolve(active.rootPath);
    const cwd = path.resolve(root, requested);
    assertInsideRoot(root, cwd, 'command cwd');
    return cwd;
  }

  public dispatchSpecial(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | undefined> {
    return this.options.dispatchSpecial
      ? this.options.dispatchSpecial(definition, input, authority)
      : Promise.resolve(undefined);
  }

  private async resolveFilePath(
    inputPath: string,
    authority: ReliableToolDispatchAuthority
  ): Promise<ResolvedLocalToolPath> {
    const environments = await this.resolveEnvironments(authority);
    const local = environments.allowed.filter((environment) =>
      environment.available && environment.kind === 'localFolder' && !!environment.rootPath
    );
    if (local.length === 0) throw new Error('冻结 WorkEnvironmentPolicy 没有可用本地文件根。');
    if (path.isAbsolute(inputPath)) {
      const matches = local
        .map((environment) => ({ environment, root: path.resolve(environment.rootPath!) }))
        .filter(({ root }) => isInsideRoot(root, path.resolve(inputPath)))
        .sort((left, right) => right.root.length - left.root.length);
      const selected = matches[0];
      if (!selected) throw new Error(`绝对路径不属于冻结策略允许的本地工作环境：${inputPath}`);
      return resolvePathInsideBoundary(selected.environment.id, selected.root, inputPath);
    }
    const active = environments.active;
    if (!active?.rootPath || active.kind !== 'localFolder') {
      throw new Error('相对文件路径需要一个可用的默认本地工作环境。');
    }
    return resolvePathInsideBoundary(active.id, active.rootPath, inputPath);
  }

  private async resolveEnvironments(authority: ReliableToolDispatchAuthority): Promise<{
    active?: WorkEnvironmentRecord;
    allowed: WorkEnvironmentRecord[];
  }> {
    const policy = authorityWorkEnvironmentPolicy(authority.document);
    const records = await this.configuration.workEnvironments();
    const boundary = resolveFrozenWorkEnvironmentBoundary(policy, records);
    return { ...(boundary.active ? { active: boundary.active } : {}), allowed: boundary.allowed };
  }
}

function authorityWorkEnvironmentPolicy(document: PlainJsonValue): {
  enabled: boolean;
  allowedWorkEnvironmentIds: string[];
  defaultWorkEnvironmentId: string | null;
} {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const policy = requireRecord(authority.workEnvironmentPolicy, 'AuthoritySnapshot.workEnvironmentPolicy');
  if (!Array.isArray(policy.allowedWorkEnvironmentIds)) {
    throw new TypeError('AuthoritySnapshot.workEnvironmentPolicy.allowedWorkEnvironmentIds must be an array.');
  }
  return {
    enabled: policy.enabled !== false,
    allowedWorkEnvironmentIds: policy.allowedWorkEnvironmentIds.map((id, index) =>
      requireText(id, `allowedWorkEnvironmentIds[${index}]`)),
    defaultWorkEnvironmentId: policy.defaultWorkEnvironmentId === null
      ? null
      : requireText(policy.defaultWorkEnvironmentId, 'defaultWorkEnvironmentId')
  };
}

function authorityConversationId(document: PlainJsonValue): string | undefined {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  return typeof authority.conversationId === 'string' ? authority.conversationId : undefined;
}

function authorityMultimodalEnabled(document: PlainJsonValue): boolean {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const model = requireRecord(authority.model, 'AuthoritySnapshot.model');
  return model.enableMultimodalTools !== false;
}

function commandDeclarationCapability(): CommandCapability {
  const toolName: 'shell' | 'bash' = process.platform === 'win32' ? 'shell' : 'bash';
  const unavailable = (): never => {
    throw new Error(`${toolName} execution must use reliable ProcessControlPlane.`);
  };
  return {
    toolName,
    executable: undefined,
    description: `${toolName === 'shell' ? 'Run a non-interactive PowerShell command' : 'Run a non-interactive Bash/Shell command'} in the project workspace. Returns stdout, stderr, and exitCode. Foreground wait moves a still-running process to the reliable detached wrapper; running results carry exitCode=null.`,
    run(_args: CommandRunArgs, _observer?: CommandRunObserver, _options?: WorkEnvironmentCapabilityOptions, _limits?: CommandOutputLimits): Promise<CommandRunResult> {
      return Promise.reject(unavailable());
    },
    backgroundForeground: unavailable,
    readOutput: unavailable,
    kill: unavailable,
    quiesce() {},
    dispose() {}
  } as CommandCapability;
}

function assertInsideRoot(root: string, target: string, label: string): void {
  if (!isInsideRoot(root, target)) throw new Error(`${label} escapes active work environment.`);
}

function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function plainClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

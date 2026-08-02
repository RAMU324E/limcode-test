import type { ToolPolicyToolConfigRecord } from '../../shared/protocol';
import type { ToolDefinition, ToolResultOut } from '../world/modules/tools/registry';
import type {
  ReliableAgentToolDefinition,
  ReliableAgentToolDispatchInput,
  ReliableAgentToolDispatcher,
  ReliableAgentToolPause
} from './agentLoop';
import type { ContentAddressedStore } from './contentAddressedStore';
import type { EffectControlPlane, ToolTerminalResult } from './effectControlPlane';
import type {
  FileChangeControlPlane,
  FileChangeProposalMemberInput,
  FileMutationDispatcher
} from './fileEffects';
import { readFrozenTurnAuthority } from './frozenAuthority';
import type { McpEffectDispatcher } from './mcpEffects';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import type { ProcessControlPlane, ProcessWaitObservation } from './processEffects';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { ToolInteractionControlPlane } from './toolInteractions';

export interface ReliableToolDispatchAuthority {
  snapshotId: string;
  document: PlainJsonValue;
  toolConfig?: ToolPolicyToolConfigRecord;
}

export interface ReliableToolDispatcherHost {
  dispose?(): Promise<void> | void;
  /** Current immutable declarations, including memory-only MCP discovery results. */
  definitions(): Promise<ToolDefinition[]> | ToolDefinition[];
  /** Pure/repeatable capability call. The dispatcher persists its returned result before finalization. */
  executeNoEffect?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolResultOut>;
  /** Builds a proposal only. It must not mutate the target filesystem. */
  planFileMutation?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<FileChangeProposalMemberInput[]>;
  /** Resolves and validates the process working directory without running the command. */
  resolveProcessCwd?(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<string> | string;
  /** Child/answer/plan/work-environment operations stay in their dedicated control planes. */
  dispatchSpecial?(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | undefined>;
}

export interface ReliableToolDispatcherDependencies {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  effects: EffectControlPlane;
  files: FileChangeControlPlane;
  fileMutations: FileMutationDispatcher;
  processes: ProcessControlPlane;
  mcp: McpEffectDispatcher;
  interactions: ToolInteractionControlPlane;
  host: ReliableToolDispatcherHost;
}

const FILE_TOOLS = new Set(['write', 'edit', 'delete']);
const PROCESS_TOOLS = new Set(['bash', 'shell']);
const SPECIAL_TOOLS = new Set([
  'run_agent',
  'submit_agent_answer',
  'read_agent_answer',
  'submit_plan',
  'switch_work_environment'
]);

/** Product Tool dispatcher. Every non-readonly external effect is committed before dispatch. */
export class ReliableToolDispatcher implements ReliableAgentToolDispatcher {
  public constructor(private readonly dependencies: ReliableToolDispatcherDependencies) {}

  public dispose(): Promise<void> | void {
    return this.dependencies.host.dispose?.();
  }

  public async definitions(): Promise<ReliableAgentToolDefinition[]> {
    const definitions = await this.dependencies.host.definitions();
    return definitions.map((definition) => ({
      name: requireText(definition.declaration.name, 'Tool declaration.name'),
      description: typeof definition.declaration.description === 'string'
        ? definition.declaration.description
        : '',
      parameters: normalizePlainJson(definition.declaration.parameters ?? {}, `Tool ${definition.declaration.name} parameters`)
    }));
  }

  public async dispatch(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause> {
    const replay = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (replay) return replay;
    const definitions = await this.dependencies.host.definitions();
    const definition = definitions.find((candidate) => candidate.declaration.name === input.toolName);
    if (!definition) return this.reject(input, `未知工具：${input.toolName}`);
    const authority = await this.readAuthority(input.turnId, input.toolName);
    const policy = authorityPolicy(authority.document);
    if (!policy.allowedTools.has(input.toolName)) {
      return this.reject(input, `冻结 ToolPolicy 不允许工具 ${input.toolName}。`);
    }

    if (definition.declaration.source?.kind === 'mcp') {
      return this.dispatchMcp(definition, input);
    }
    if (FILE_TOOLS.has(input.toolName)) {
      return this.dispatchFile(definition, input, authority);
    }
    if (PROCESS_TOOLS.has(input.toolName)) {
      return this.dispatchProcess(input, authority);
    }
    if (input.toolName === 'ask_user') {
      const pause = await this.dependencies.interactions.pauseForAskUser({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:ask-user` },
        toolCallId: input.toolCallId,
        prompt: input.arguments
      });
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_user',
        resumeKey: pause.requestId
      };
    }
    if (input.toolName === 'update_task_list') {
      const args = requireRecord(input.arguments, 'update_task_list arguments');
      const items = Array.isArray(args.items) ? args.items : [];
      const settled = await this.dependencies.interactions.settleTaskList({
        source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:task-list` },
        toolCallId: input.toolCallId,
        items
      });
      return settled.terminal ?? this.requireTerminal(input.toolCallId);
    }
    if (SPECIAL_TOOLS.has(input.toolName)) {
      const special = await this.dependencies.host.dispatchSpecial?.(definition, input, authority);
      if (special) return special;
      return this.reject(input, `工具 ${input.toolName} 尚未连接到可靠专用控制面。`);
    }
    return this.dispatchNoEffect(definition, input, authority);
  }

  private async dispatchNoEffect(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult> {
    if (!this.dependencies.host.executeNoEffect) {
      return this.reject(input, `工具 ${input.toolName} 没有只读 capability adapter。`);
    }
    const result = await this.dependencies.host.executeNoEffect(definition, input, authority);
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:no-effect` },
      toolCallId: input.toolCallId,
      status: result.ok ? 'succeeded' : 'failed',
      detail: normalizePlainJson({
        ok: result.ok,
        output: result.output ?? null,
        ...(result.parts ? { parts: result.parts } : {}),
        ...(result.status ? { status: result.status } : {})
      }, `Tool ${input.toolName} result`)
    });
    return settled.terminal ?? this.requireTerminal(input.toolCallId);
  }

  private async dispatchFile(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult | ReliableAgentToolPause> {
    if (!this.dependencies.host.planFileMutation) {
      return this.reject(input, `文件工具 ${input.toolName} 没有可靠 proposal planner。`);
    }
    const existing = await this.list('FileChangeSet', { tool_call_id: input.toolCallId }, 2);
    const proposal = existing.length === 0
      ? await this.dependencies.files.propose({
          source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:file-proposal` },
          toolCallId: input.toolCallId,
          members: await this.dependencies.host.planFileMutation(definition, input, authority)
        })
      : { changeSetId: requireId(existing[0].id, 'FileChangeSet.id') };
    const policy = authorityPolicy(authority.document);
    if (!fileAutoApply(policy.preset, authority.toolConfig, definition)) {
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_approval',
        resumeKey: proposal.changeSetId
      };
    }
    const decision = await this.dependencies.files.decide({
      source: { kind: 'command', key: `tool-policy:auto-apply:${proposal.changeSetId}` },
      changeSetId: proposal.changeSetId,
      decision: 'approved',
      response: { actor: 'frozen-tool-policy', automatic: true }
    });
    if (decision.terminal) return decision.terminal;
    if (!decision.preparedEffect) {
      const terminal = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (terminal) return terminal;
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_approval',
        resumeKey: proposal.changeSetId
      };
    }
    const applied = await this.dependencies.fileMutations.dispatchRecordAndReconcile(
      decision.preparedEffect.effectIntentId
    );
    return applied.terminal ?? this.requireTerminal(input.toolCallId);
  }

  private async dispatchProcess(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<ToolTerminalResult | ReliableAgentToolPause> {
    const args = requireRecord(input.arguments, `${input.toolName} arguments`);
    const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';
    if (mode === 'output') return this.readProcessOutput(input, args);
    if (mode === 'kill') return this.stopProcess(input, args);
    const command = requireText(args.command, `${input.toolName}.command`);
    const foregroundWaitMs = requireWaitMs(args.foregroundWaitMs);
    if (!this.dependencies.host.resolveProcessCwd) {
      return this.reject(input, `${input.toolName} 没有工作目录 resolver。`);
    }
    const cwd = await this.dependencies.host.resolveProcessCwd(input, authority);
    const prepared = await this.dependencies.processes.prepareStart({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-start` },
      toolCallId: input.toolCallId,
      command,
      cwd
    });
    const started = await this.dependencies.processes.dispatchStart(
      prepared.effect.effectIntentId,
      foregroundWaitMs
    );
    const terminal = started.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: prepared.request.processId
    };
  }

  private async readProcessOutput(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }
  ): Promise<ToolTerminalResult> {
    const processId = requireId(args.processId, 'processId');
    const observed = await this.dependencies.processes.wait(processId, 0);
    if (observed.state !== 'running') await this.dependencies.processes.reconcileProcessExit(processId);
    await this.dependencies.processes.reconcileOutput(processId);
    const output = await this.dependencies.processes.readOutput(processId);
    const limits = processOutputLimits(args);
    const detail = {
      processId,
      status: processStatus(observed),
      exitCode: processExitCode(observed),
      killed: observed.state === 'exited' ? observed.receipt.stopRequested : false,
      stdout: limitOutput(output.stdout.toString('utf8'), limits),
      stderr: limitOutput(output.stderr.toString('utf8'), limits),
      truncated: output.truncated,
      droppedBytes: output.droppedBytes
    };
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-output` },
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail
    });
    return settled.terminal ?? this.requireTerminal(input.toolCallId);
  }

  private async stopProcess(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }
  ): Promise<ToolTerminalResult | ReliableAgentToolPause> {
    const processId = requireId(args.processId, 'processId');
    const prepared = await this.dependencies.processes.prepareStop({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:process-stop` },
      toolCallId: input.toolCallId,
      processId
    });
    const stopped = await this.dependencies.processes.dispatchStop(prepared.effectIntentId);
    const terminal = stopped?.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: processId
    };
  }

  private async dispatchMcp(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause> {
    const source = definition.declaration.source;
    if (source?.kind !== 'mcp') return this.reject(input, 'MCP 工具缺少冻结 source metadata。');
    const prepared = await this.dependencies.mcp.prepare({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:mcp-prepare` },
      toolCallId: input.toolCallId,
      serverId: requireId(source.sourceId, 'MCP source.sourceId'),
      toolName: requireText(source.originalToolName, 'MCP source.originalToolName'),
      arguments: plainRecord(input.arguments, 'MCP arguments')
    });
    if (prepared.disposition === 'rejected') {
      return prepared.settlement.terminal ?? this.requireTerminal(input.toolCallId);
    }
    const dispatched = await this.dependencies.mcp.dispatch(prepared.effectIntentId);
    const terminal = dispatched.terminal ?? await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
    if (terminal) return terminal;
    return {
      disposition: 'paused',
      toolCallId: input.toolCallId,
      reason: 'background_process',
      resumeKey: prepared.effectIntentId
    };
  }

  private async readAuthority(turnId: string, toolName: string): Promise<ReliableToolDispatchAuthority> {
    const rows = await this.list('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (rows.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    const snapshotId = requireId(rows[0].id, 'AuthoritySnapshot.id');
    const frozen = await readFrozenTurnAuthority(
      this.dependencies.database,
      this.dependencies.contentStore,
      snapshotId,
      turnId
    );
    const policy = authorityPolicy(frozen.document);
    return {
      snapshotId,
      document: frozen.document,
      ...(policy.toolConfigs[toolName] ? { toolConfig: policy.toolConfigs[toolName] } : {})
    };
  }

  private async reject(input: ReliableAgentToolDispatchInput, reason: string): Promise<ToolTerminalResult> {
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `tool-dispatch:${input.toolCallId}:rejected` },
      toolCallId: input.toolCallId,
      status: 'rejected',
      detail: { reason }
    });
    return settled.terminal ?? this.requireTerminal(input.toolCallId);
  }

  private async requireTerminal(toolCallId: string): Promise<ToolTerminalResult> {
    const terminal = await this.dependencies.effects.readTerminalResult(toolCallId, true);
    if (!terminal) throw new Error(`ToolCall ${toolCallId} has no terminal ToolModelResult.`);
    return terminal;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0];
  }
}

function authorityPolicy(document: PlainJsonValue): {
  allowedTools: Set<string>;
  preset: string;
  toolConfigs: Record<string, ToolPolicyToolConfigRecord>;
} {
  const authority = requireRecord(document, 'AuthoritySnapshot');
  const policy = requireRecord(authority.toolPolicy, 'AuthoritySnapshot.toolPolicy');
  if (!Array.isArray(policy.allowedTools)) throw new TypeError('AuthoritySnapshot.toolPolicy.allowedTools must be an array.');
  const allowedTools = new Set(policy.allowedTools.map((value, index) => requireText(
    value,
    `AuthoritySnapshot.toolPolicy.allowedTools[${index}]`
  )));
  const toolConfigsRaw = policy.toolConfigs === undefined
    ? {}
    : plainRecord(policy.toolConfigs, 'AuthoritySnapshot.toolPolicy.toolConfigs');
  return {
    allowedTools,
    preset: typeof policy.preset === 'string' ? policy.preset : 'custom',
    toolConfigs: toolConfigsRaw as unknown as Record<string, ToolPolicyToolConfigRecord>
  };
}

function fileAutoApply(
  preset: string,
  toolConfig: ToolPolicyToolConfigRecord | undefined,
  definition: ToolDefinition
): boolean {
  if (preset === 'yolo') return true;
  return toolConfig?.autoApplyChange
    ?? definition.declaration.metadata?.defaultAutoApplyChange
    ?? false;
}

function processOutputLimits(args: { [key: string]: PlainJsonValue }): { maxLines: number; maxChars: number } {
  return {
    maxLines: positiveBound(args.maxOutputLines, 100, 10_000),
    maxChars: positiveBound(args.maxOutputChars, 10_000, 1_000_000)
  };
}

function limitOutput(value: string, limits: { maxLines: number; maxChars: number }): string {
  const lines = value.split(/\r?\n/);
  const lineBounded = lines.length > limits.maxLines ? lines.slice(lines.length - limits.maxLines).join('\n') : value;
  return lineBounded.length > limits.maxChars
    ? lineBounded.slice(lineBounded.length - limits.maxChars)
    : lineBounded;
}

function processStatus(observed: ProcessWaitObservation): string {
  if (observed.state === 'running') return 'running';
  if (observed.state === 'outcome_unknown') return 'outcome_unknown';
  return observed.receipt.stopRequested ? 'killed' : 'exited';
}

function processExitCode(observed: ProcessWaitObservation): number | null {
  if (observed.state !== 'exited') return null;
  const value = observed.receipt.exitCode;
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function positiveBound(value: PlainJsonValue | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

function requireWaitMs(value: PlainJsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw new TypeError('foregroundWaitMs must be an integer from 0 to 60000.');
  }
  return value;
}

function plainRecord(value: PlainJsonValue | undefined, label: string): Record<string, unknown> {
  return requireRecord(value, label) as Record<string, unknown>;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

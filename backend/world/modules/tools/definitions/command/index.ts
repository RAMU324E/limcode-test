import type { CommandCapability } from '../../../../../capabilities/types';
import type { ToolConfigRecord } from '../../../../../../shared/protocol';
import type { ToolDefinition } from '../../registry';
import { normalizeSchedulingHint } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';

export const commandToolModule = defineToolDefinitionModule({
  id: 'command',
  create({ command }) {
    return createCommandTool(command);
  }
});

export function createCommandTool(command: CommandCapability): ToolDefinition {
  return {
    declaration: {
      name: command.toolName,
      description: command.description,
      parameters: {
        type: 'object',
        properties: {
          explanation: {
            type: 'string',
            description: 'Required. Briefly explain to the user what this command will do and why. This text is shown as the tool-call title.'
          },
          mode: {
            type: 'string',
            description: 'Operation mode. Defaults to execute. execute starts a new command; output reads one resumable page from a background process; kill terminates a background process. output/kill require a processId returned by an earlier execute result.'
          },
          command: {
            type: 'string',
            description: command.toolName === 'shell'
              ? 'PowerShell command to execute. Separate multiple commands with semicolons. Quote paths that contain spaces. Required when mode=execute.'
              : 'Bash/Shell command to execute. Prefer joining multiple commands with &&. Quote paths that contain spaces. Required when mode=execute.'
          },
          cwd: {
            type: 'string',
            description: 'Working directory relative to the workspace root. Defaults to the workspace root. Only used when mode=execute.'
          },
          foregroundWaitMs: {
            type: 'number',
            description: 'Required for mode=execute. Foreground wait budget in milliseconds; this is not a command timeout. If the command is still running after this budget, it is moved to the background and the tool returns a generated processId. Use 0 to background immediately.'
          },
          processId: {
            type: 'string',
            description: 'Do not provide this when mode=execute. The runtime generates and returns processId when an execute command is moved to the background. Required only for mode=output or mode=kill; copy it from a previous shell/bash result or background notification.'
          },
          outputHandle: {
            type: 'string',
            description: 'Only for mode=output. Omit on the first read. When a result returns nextOutputHandle, pass that exact opaque value to continue from the next output chunk. Each stdout/stderr page is bounded for transport, while repeated reads traverse the complete retained history without a total output cap. Running-only liveStdout/liveStderr fields are provisional previews and do not advance this handle.'
          },
          readonly: {
            type: 'string',
            description: 'Whether this command is read-only and does not modify files, system state, or network state. Use "true" for read-only commands; read-only commands may be auto-approved when the policy allows it.'
          },
          wait: {
            type: 'string',
            description: 'Legacy scheduling hint. Prefer the scheduling field. "true" means serial and "false" means parallel when scheduling is omitted.'
          },
          scheduling: {
            type: 'string',
            enum: ['parallel', 'serial'],
            description: 'Tool-call scheduling mode. Defaults to serial. Use parallel only when this command is independent from sibling tool calls.'
          }
        },
        required: ['explanation', 'foregroundWaitMs']
      },
      metadata: {
        category: 'command',
        scope: 'command',
        riskLevel: 'command',
        readonly: false,
        defaultEnabled: true,
        requiresApproval: true,
        checkpoint: { before: true, after: true }
      },
      configSchema: {
        fields: [
          {
            key: 'denyCommands',
            label: '命令黑名单',
            type: 'stringList',
            description: '命令文本包含任一黑名单片段时，后端会自动拒绝执行。',
            placeholder: '例如：format\nshutdown\nrm -rf /'
          },
          {
            key: 'allowCommands',
            label: '命令白名单',
            type: 'stringList',
            description: '配置非空时，仅命令文本包含白名单片段的命令可以执行；未匹配命令会由后端拒绝。',
            placeholder: '例如：git status\nnpm run compile'
          },
          {
            key: 'autoApproveReadonly',
            label: '只读命令自动跳过审批',
            type: 'boolean',
            description: '开启后，即使未开启"自动批准执行"，被模型标记为只读(readonly=true)的命令也会自动批准、无需人工确认。',
            defaultValue: true
          }
        ]
      },
      defaultConfig: {
        denyCommands: [],
        allowCommands: [],
        autoApproveReadonly: true
      }
    },
    execution: 'runtime',
    scheduling: (rawArgs) => resolveCommandScheduling(rawArgs),
    summary: summarizeCommandToolCall,
    async execute(rawArgs, deps, ctx) {
      const args = (rawArgs ?? {}) as CommandToolArgs;
      const config = normalizeCommandToolConfig(ctx?.config);
      const mode = args.mode === 'output' || args.mode === 'kill' ? args.mode : 'execute';

      if (mode === 'output') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=output 需要指定后台进程 id。' };
        return {
          ok: true,
          output: deps.command.readOutput(processId)
        };
      }

      if (mode === 'kill') {
        const processId = (args.processId ?? '').trim();
        if (!processId) return { ok: false, output: '缺少 processId：mode=kill 需要指定后台进程 id。' };
        return { ok: true, output: deps.command.kill(processId) };
      }

      const commandText = (args.command ?? '').trim();
      if (!commandText) return { ok: false, output: 'mode=execute 需要提供 command。' };
      if (typeof args.foregroundWaitMs !== 'number' || !Number.isFinite(args.foregroundWaitMs) || args.foregroundWaitMs < 0) {
        return { ok: false, output: 'foregroundWaitMs 为必填参数，需为非负的毫秒数（0 表示启动后立即转后台）。' };
      }
      const deniedBy = firstMatchedCommandRule(commandText, config.denyCommands);
      if (deniedBy) return { ok: false, output: `命令已被工具策略黑名单拒绝：${deniedBy}` };

      const origin = ctx?.runId && ctx.conversationId && ctx.attemptId && ctx.generation !== undefined
        ? {
            sourceToolCallId: ctx.toolCallId,
            sourceRunId: ctx.runId,
            conversationId: ctx.conversationId,
            sourceAttemptId: ctx.attemptId,
            sourceGeneration: ctx.generation
          }
        : undefined;
      const result = await deps.command.run({
        command: args.command,
        cwd: args.cwd,
        foregroundWaitMs: args.foregroundWaitMs,
        executionId: ctx?.toolCallId,
        ...(origin ? { backgroundProcessOrigin: origin } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {})
      }, {
        onEvent(event) {
          ctx?.emit({
            kind: event.kind,
            ...(event.delta !== undefined ? { delta: event.delta } : {}),
            ...(event.payload !== undefined ? { payload: event.payload } : {})
          });
        }
      }, { workEnvironment: ctx?.workEnvironment, accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments });
      const ok = result.status === 'running' || result.exitCode === 0;
      return {
        ok,
        output: result,
        ...(result.status === 'running' && result.processId
          ? { backgroundProcesses: [{ id: result.processId, processId: result.processId, status: 'running' as const }] }
          : {})
      };
    }
  };
}

type CommandToolArgs = {
  command?: string;
  cwd?: string;
  foregroundWaitMs?: number;
  mode?: string;
  processId?: string;
  outputHandle?: string;
  readonly?: string;
  wait?: string;
  scheduling?: string;
  explanation?: string;
};

function summarizeCommandToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const explanation = typeof args.explanation === 'string' ? args.explanation.trim() : '';
  if (!explanation) return undefined;
  return explanation.replace(/\s+/g, ' ');
}

/** Canonical LLM scheduling wins; legacy wait remains a compatibility hint; commands default to serial. */
function resolveCommandScheduling(rawArgs: unknown): { mode: 'parallel' | 'serial'; reason: string } {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  const scheduling = normalizeSchedulingHint(args.scheduling);
  if (scheduling !== 'auto') return { mode: scheduling, reason: `llm_selected_${scheduling}` };

  const wait = typeof args.wait === 'string' ? args.wait.trim().toLowerCase() : '';
  if (wait === 'false') return { mode: 'parallel', reason: 'legacy_wait_false' };
  if (wait === 'true') return { mode: 'serial', reason: 'legacy_wait_true' };
  return { mode: 'serial', reason: 'default_serial_command' };
}

/** 判断某次命令工具调用是否被模型标记为只读（供审批放行使用）。 */
export function isReadonlyCommandCall(rawArgs: unknown): boolean {
  const args = (rawArgs ?? {}) as CommandToolArgs;
  return typeof args.readonly === 'string' && args.readonly.trim().toLowerCase() === 'true';
}

interface NormalizedCommandToolConfig {
  denyCommands: string[];
  allowCommands: string[];
  autoApproveReadonly: boolean;
}

function normalizeCommandToolConfig(config: ToolConfigRecord | undefined): NormalizedCommandToolConfig {
  return {
    denyCommands: normalizeStringList(config?.denyCommands),
    allowCommands: normalizeStringList(config?.allowCommands),
    autoApproveReadonly: config?.autoApproveReadonly !== false
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}

function firstMatchedCommandRule(command: string, rules: readonly string[]): string | undefined {
  const normalizedCommand = command.toLowerCase();
  return rules.find((rule) => normalizedCommand.includes(rule.toLowerCase()));
}

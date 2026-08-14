import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { RuleFileRecord, RuleKind, RuleScope, WorkEnvironmentRecord } from '../../shared/protocol';
import { stripInitialWorkEnvironmentSection } from '../../shared/runtimeContextText';
import { formatWorkEnvironmentForDisplay } from '../../shared/workEnvironmentCatalog';

// 与 world/modules/runtimeContext/placeholders.ts 的 formatWorkspaceUriForPrompt 逻辑一致；
// 不复用原文件是因为它会拖入未被 tsconfig 编译的 ECS 死代码图（agentRun 模块已在上游删除）。
function formatWorkspaceUriForPrompt(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('file:')) return decodeUriFallback(trimmed);
  return fileUriToDisplayPath(trimmed) ?? decodeUriFallback(trimmed);
}

function fileUriToDisplayPath(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'file:') return undefined;
    const decodedPath = decodeURIComponent(parsed.pathname);
    const windowsDrivePath = decodedPath.match(/^\/([a-zA-Z]:)(?:\/(.*))?$/);
    if (windowsDrivePath) {
      const [, drive, rest = ''] = windowsDrivePath;
      return rest ? `${drive}\\${rest.replace(/\//g, '\\')}` : `${drive}\\`;
    }
    if (process.platform === 'win32') return fileURLToPath(parsed);
    return path.normalize(fileURLToPath(parsed));
  } catch {
    return undefined;
  }
}

function decodeUriFallback(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * reliableKernel 侧的提示词占位符渲染上下文。
 * 与 ECS world/modules/runtimeContext/placeholders.ts 的 token 语义保持一致，
 * 但数据源换成冻结 authority 时已有的纯记录（不依赖 ECS World）。
 */
export interface ReliablePromptRenderContext {
  now: Date;
  platform: string;
  /** 工作区名称与 URI；缺失（未绑定工作区）时两个 token 都渲染为「未绑定工作区。」。 */
  workspace?: { name: string; uri: string };
  /** 冻结策略允许且可用的工作环境，用于 $workEnvironment.current*。 */
  workEnvironments: readonly WorkEnvironmentRecord[];
  agentName?: string;
  agentDescription?: string;
  workflowName?: string;
  workflowDescription?: string;
}

const UNBOUND_WORKSPACE_TEXT = '未绑定工作区。';

/** 渲染系统提示词中的 {{$agent.*}} / {{$workflow.*}} 占位符。 */
export function renderReliableSystemPromptTemplate(template: string, context: ReliablePromptRenderContext): string {
  return replacePlaceholders(template, (token) => {
    switch (token) {
      case '{{$agent.name}}': return context.agentName ?? '';
      case '{{$agent.description}}': return context.agentDescription ?? '';
      case '{{$workflow.name}}': return context.workflowName ?? '';
      case '{{$workflow.description}}': return context.workflowDescription ?? '';
      default: return undefined;
    }
  });
}

/** 渲染运行时上下文模板中的 {{$runtime.*}} / {{$platform.*}} / {{$workspace.*}} / {{$workEnvironment.*}} 占位符。 */
export function renderReliableRuntimeContextTemplate(template: string, context: ReliablePromptRenderContext): string {
  const rendered = replacePlaceholders(template, (token) => {
    switch (token) {
      case '{{$runtime.timestamp}}': return context.now.toISOString();
      case '{{$runtime.date}}': return formatLocalDate(context.now);
      case '{{$platform.os}}': return context.platform;
      case '{{$workEnvironment.current}}': return currentWorkEnvironmentText(context);
      case '{{$workEnvironment.currentSection}}': return currentWorkEnvironmentSectionText(context);
      case '{{$workspace.name}}': return context.workspace?.name ?? UNBOUND_WORKSPACE_TEXT;
      case '{{$workspace.uri}}': return context.workspace ? formatWorkspaceUriForPrompt(context.workspace.uri) : UNBOUND_WORKSPACE_TEXT;
      default: return undefined;
    }
  });
  return context.workEnvironments.length > 0 ? rendered : stripInitialWorkEnvironmentSection(rendered);
}

const RULE_REGION_LABEL: Record<RuleScope, Record<RuleKind, string>> = {
  global: { AGENTS: '全局规则 (AGENTS.md)', CLAUDE: '全局规则 (CLAUDE.md)' },
  project: { AGENTS: '项目规则 (AGENTS.md)', CLAUDE: '项目规则 (CLAUDE.md)' }
};

/** 规则区域顺序：全局在前、项目在后；同一作用域 AGENTS 在前、CLAUDE 在后。 */
const RULE_REGION_ORDER: ReadonlyArray<{ scope: RuleScope; kind: RuleKind }> = [
  { scope: 'global', kind: 'AGENTS' },
  { scope: 'global', kind: 'CLAUDE' },
  { scope: 'project', kind: 'AGENTS' },
  { scope: 'project', kind: 'CLAUDE' }
];

/** 规则文件原样注入（不走占位符渲染，避免用户文件里的 {{}} 被破坏）。 */
export function composeRuntimeContextRuleParts(rules: readonly RuleFileRecord[]): string[] {
  const parts: string[] = [];
  for (const { scope, kind } of RULE_REGION_ORDER) {
    const rule = rules.find((candidate) => candidate.scope === scope && candidate.kind === kind);
    const content = rule?.content.trim();
    if (!rule?.exists || !content) continue;
    parts.push(`[${RULE_REGION_LABEL[scope][kind]}]\n${content}`);
  }
  return parts;
}

function replacePlaceholders(template: string, resolve: (token: string) => string | undefined): string {
  return template.replace(/\{\{\$[a-zA-Z0-9_.-]+\}\}/g, (token) => resolve(token) ?? token);
}

function currentWorkEnvironmentText(context: ReliablePromptRenderContext): string {
  return context.workEnvironments.map((environment) => formatWorkEnvironmentForDisplay(environment)).join('\n');
}

function currentWorkEnvironmentSectionText(context: ReliablePromptRenderContext): string {
  const text = currentWorkEnvironmentText(context);
  return text ? `\nInitial work environment:\n${text}` : '';
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

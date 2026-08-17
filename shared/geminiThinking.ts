import type { LlmThinkingLevel } from './protocol';

export type GeminiThinkingLevel = Extract<LlmThinkingLevel, 'minimal' | 'low' | 'medium' | 'high'>;

export interface GeminiThinkingLevelCapability {
  kind: 'thinkingLevel';
  levels: readonly GeminiThinkingLevel[];
  defaultLevel: GeminiThinkingLevel;
}

export interface GeminiThinkingBudgetCapability {
  kind: 'thinkingBudget';
  levels: readonly [];
}

export interface GeminiThinkingUnsupportedCapability {
  kind: 'unsupported';
  levels: readonly [];
}

export interface GeminiThinkingUnknownCapability {
  kind: 'unknown';
  levels: readonly GeminiThinkingLevel[];
}

export type GeminiThinkingCapability =
  | GeminiThinkingLevelCapability
  | GeminiThinkingBudgetCapability
  | GeminiThinkingUnsupportedCapability
  | GeminiThinkingUnknownCapability;

const ALL_GEMINI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const satisfies readonly GeminiThinkingLevel[];
const LOW_MEDIUM_HIGH = ['low', 'medium', 'high'] as const satisfies readonly GeminiThinkingLevel[];
const MINIMAL_HIGH = ['minimal', 'high'] as const satisfies readonly GeminiThinkingLevel[];
const LOW_HIGH = ['low', 'high'] as const satisfies readonly GeminiThinkingLevel[];
const NO_LEVELS = [] as const;

/**
 * 返回 Gemini 模型原生支持的思考控制方式。
 *
 * Gemini 2.5 使用 thinkingBudget；Gemini 3.x 使用 thinkingLevel，而且各模型系列
 * 支持的等级并不相同。未知模型不猜测请求能力，由调用方保留通用编辑体验但不应用
 * Gemini 3.x 的请求默认值。
 */
export function geminiThinkingCapabilityForModel(modelId: string | undefined): GeminiThinkingCapability {
  const model = normalizeGeminiModelId(modelId);
  if (!model) return { kind: 'unknown', levels: ALL_GEMINI_THINKING_LEVELS };
  if (!isGeminiModelId(model)) return { kind: 'unsupported', levels: NO_LEVELS };

  if (/^gemini-2\.5(?:-|$)/.test(model)) {
    return { kind: 'thinkingBudget', levels: NO_LEVELS };
  }
  if (!/^gemini-3(?:\.\d+)?(?:-|$)/.test(model)) {
    return { kind: 'unsupported', levels: NO_LEVELS };
  }

  // 图像模型的集合比同名文本系列更窄，必须先于 flash/pro 通用规则匹配。
  if (model.includes('-flash-lite-image') || model.includes('-flash-image')) {
    return levelCapability(MINIMAL_HIGH);
  }
  if (model.includes('-pro-image')) {
    return levelCapability(LOW_HIGH);
  }

  // Flash-Lite 文本模型支持完整四档。
  if (model.includes('-flash-lite')) {
    return levelCapability(ALL_GEMINI_THINKING_LEVELS);
  }

  // Gemini 3.7 Flash 不支持 minimal；合法集合固定为 low / medium / high。
  if (/^gemini-3\.7-flash(?:-|$)/.test(model)) {
    return levelCapability(LOW_MEDIUM_HIGH);
  }

  // 其他普通 Flash 文本模型支持完整四档。
  if (model.includes('-flash')) {
    return levelCapability(ALL_GEMINI_THINKING_LEVELS);
  }

  // Gemini 3.1 Pro 增加了 medium；较早 Pro 模型仅支持 low / high。
  if (/^gemini-3\.1-pro(?:-|$)/.test(model)) {
    return levelCapability(LOW_MEDIUM_HIGH);
  }
  if (model.includes('-pro')) {
    return levelCapability(LOW_HIGH);
  }

  // 对已识别但未细分的 Gemini 3.x 使用保守的官方公共集合。
  return levelCapability(LOW_HIGH);
}

export function isGeminiThinkingLevelSupported(
  capability: GeminiThinkingCapability,
  value: unknown
): value is GeminiThinkingLevel {
  return capability.kind === 'thinkingLevel'
    && typeof value === 'string'
    && capability.levels.some((level) => level === value);
}

function levelCapability(levels: readonly GeminiThinkingLevel[]): GeminiThinkingLevelCapability {
  return { kind: 'thinkingLevel', levels, defaultLevel: 'high' };
}

function normalizeGeminiModelId(modelId: string | undefined): string {
  const normalized = modelId?.trim().toLowerCase() ?? '';
  if (!normalized) return '';
  return normalized.match(/gemini-[a-z0-9][a-z0-9._-]*/)?.[0] ?? normalized;
}

function isGeminiModelId(modelId: string): boolean {
  return /^gemini-(?:\d|pro|flash)/.test(modelId);
}

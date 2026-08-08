import { DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID } from '../agent/blueprints';

export interface SystemPromptTextPart {
  id?: string;
  name?: string;
  text: string;
}

/** 只隐藏内置全局提示词的内部名称；用户命名的其他提示词仍保留标题。 */
export function composeSystemInstruction(prompts: readonly SystemPromptTextPart[]): string {
  return prompts
    .map((prompt) => {
      const text = prompt.text.trim();
      if (!text) return '';
      const name = prompt.name?.trim() ?? '';
      return name && prompt.id !== DEFAULT_INTEGRATED_SYSTEM_PROMPT_ID
        ? `[${name}]\n${text}`
        : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** 前置提示词不加标题，并与已经组装好的系统提示词空一行。 */
export function prependSystemPromptPrefix(systemInstruction: string, prefix: string | undefined): string {
  const normalizedInstruction = systemInstruction.trim();
  const normalizedPrefix = prefix?.trim() ?? '';
  if (!normalizedPrefix) return normalizedInstruction;
  if (!normalizedInstruction) return normalizedPrefix;
  return `${normalizedPrefix}\n\n${normalizedInstruction}`;
}

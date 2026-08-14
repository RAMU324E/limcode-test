const SOURCE_DISPLAY: Record<string, string> = { agents: '.agents', claude: '.claude', global: 'global' };

export interface SkillDescriptionEntry {
  name: string;
  slug: string;
  description: string;
  source: string;
}

/**
 * 把「当前已启用的技能」列表拼进 skills 工具描述，让 AI 感知可用技能。
 * 技能正文只在 AI 调用 skills({ name }) 时按需返回，避免污染 system prompt。
 * ECS schema contributor 与 reliableKernel toolDispatcher 共用此纯函数。
 */
export function composeSkillsToolDescription(baseDescription: string, skills: SkillDescriptionEntry[]): string {
  if (skills.length === 0) {
    return `${baseDescription}\n\nAvailable skills: none.`;
  }
  const lines = skills.map((skill) => {
    const source = SOURCE_DISPLAY[skill.source] ?? skill.source;
    const description = skill.description.trim();
    return [
      `- name: ${skill.slug}`,
      `  source: ${source}`,
      `  description: ${yamlScalar(description)}`
    ].join('\n');
  });
  return `${baseDescription}\n\nAvailable skills (YAML):\n${lines.join('\n')}`;
}

/** 把自由文本描述编码为安全的 YAML 标量：双引号包裹并转义换行/引号/反斜杠。 */
function yamlScalar(value: string): string {
  if (!value) return '""';
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
  return `"${escaped}"`;
}

import { EDIT_TOOL_NAME, WRITE_TOOL_NAME, type ToolCallPreviewRecord } from './protocol';

const DISPLAY_PREVIEW_CHARS = 6_000;

export type ToolCallPreviewKind = 'write' | 'edit' | 'command' | 'generic';

export interface ToolCallPreviewPresentation {
  kind: ToolCallPreviewKind;
  title: string;
  subject?: string;
  detail: string;
  previewText?: string;
}

export function toolCallPreviewPresentation(preview: ToolCallPreviewRecord): ToolCallPreviewPresentation {
  const name = preview.name?.trim() || '工具';
  const path = extractPartialJsonStringField(preview.argumentsHead, 'path');
  const count = formatCharacterCount(preview.receivedChars);
  const truncation = preview.truncated ? ' · 预览已截断' : '';

  if (name === WRITE_TOOL_NAME) {
    return {
      kind: 'write',
      title: '正在生成文件内容',
      ...(path ? { subject: path } : {}),
      detail: `已接收 ${count} 个参数字符${truncation}`,
      ...(writeContentPreview(preview) ? { previewText: writeContentPreview(preview) } : {})
    };
  }

  if (name === EDIT_TOOL_NAME) {
    return {
      kind: 'edit',
      title: '正在准备文件修改',
      ...(path ? { subject: path } : {}),
      detail: `已接收 ${count} 个参数字符${truncation}`,
      ...(genericArgumentsPreview(preview) ? { previewText: genericArgumentsPreview(preview) } : {})
    };
  }

  if (name === 'bash' || name === 'shell') {
    const command = extractPartialJsonStringField(preview.argumentsHead, 'command');
    const explanation = extractPartialJsonStringField(preview.argumentsHead, 'explanation');
    return {
      kind: 'command',
      title: '正在组装命令',
      ...(explanation ? { subject: explanation } : {}),
      detail: `已接收 ${count} 个参数字符${truncation}`,
      ...(command ? { previewText: tail(command, DISPLAY_PREVIEW_CHARS) } : {})
    };
  }

  return {
    kind: 'generic',
    title: `正在组装 ${name} 参数`,
    detail: `已接收 ${count} 个参数字符${truncation}`,
    ...(genericArgumentsPreview(preview) ? { previewText: genericArgumentsPreview(preview) } : {})
  };
}

/** Best-effort parser for one JSON string field while the enclosing JSON is still incomplete. */
export function extractPartialJsonStringField(source: string, field: string): string | undefined {
  const marker = `"${field}"\\s*:\\s*"`;
  const match = new RegExp(marker).exec(source);
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length;
  return decodeJsonStringFragment(source.slice(start)).value || undefined;
}

export function genericArgumentsPreview(preview: ToolCallPreviewRecord): string | undefined {
  if (!preview.truncated) return tail(preview.argumentsHead.trim(), DISPLAY_PREVIEW_CHARS) || undefined;
  const joined = `${preview.argumentsHead}\n… 中间参数已省略 …\n${preview.argumentsTail}`;
  return tail(joined.trim(), DISPLAY_PREVIEW_CHARS) || undefined;
}

function writeContentPreview(preview: ToolCallPreviewRecord): string | undefined {
  if (!preview.truncated) {
    const content = extractPartialJsonStringField(preview.argumentsHead, 'content');
    return content ? tail(content, DISPLAY_PREVIEW_CHARS) : undefined;
  }
  const rawTail = trimTrailingJsonStringEnvelope(preview.argumentsTail);
  const decoded = decodeJsonStringFragment(rawTail, false).value;
  return tail(decoded || rawTail, DISPLAY_PREVIEW_CHARS) || undefined;
}

function decodeJsonStringFragment(source: string, stopAtQuote = true): { value: string; closed: boolean } {
  let value = '';
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (escaped) {
      if (char === 'n') value += '\n';
      else if (char === 'r') value += '\r';
      else if (char === 't') value += '\t';
      else if (char === 'b') value += '\b';
      else if (char === 'f') value += '\f';
      else if (char === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16));
        index += 4;
      } else value += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"' && stopAtQuote) return { value, closed: true };
    value += char;
  }
  if (escaped) value += '\\';
  return { value, closed: false };
}

function trimTrailingJsonStringEnvelope(value: string): string {
  return value
    .replace(/\s*}\s*$/, '')
    .replace(/"\s*$/, '');
}

function formatCharacterCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

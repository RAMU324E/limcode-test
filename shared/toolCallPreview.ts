import {
  EDIT_TOOL_NAME,
  SUBMIT_PLAN_TOOL_NAME,
  TOOL_CALL_PREVIEW_HEAD_CHARS,
  WRITE_TOOL_NAME,
  type ToolCallPreviewRecord
} from './protocol';

const DISPLAY_PREVIEW_CHARS = 6_000;

export type ToolCallPreviewKind = 'write' | 'edit' | 'command' | 'plan' | 'generic';
export type ToolCallPreviewRenderMode = 'markdown' | 'text' | 'json';

export interface ToolCallPreviewPresentation {
  kind: ToolCallPreviewKind;
  title: string;
  subject?: string;
  detail: string;
  previewText?: string;
  renderMode?: ToolCallPreviewRenderMode;
}

interface PartialJsonStringField {
  value: string;
  closed: boolean;
}

interface BoundedFieldPreview {
  text?: string;
  truncated: boolean;
}

export function toolCallPreviewPresentation(preview: ToolCallPreviewRecord): ToolCallPreviewPresentation {
  const name = preview.name?.trim() || '工具';
  const stableArguments = stableArgumentsPrefix(preview);
  const path = extractPartialJsonStringField(stableArguments, 'path');

  if (name === SUBMIT_PLAN_TOOL_NAME) {
    const plan = boundedStringFieldPreview(preview, 'plan');
    return {
      kind: 'plan',
      title: '正在编写计划',
      detail: previewDetail(preview, plan.truncated),
      ...(plan.text ? { previewText: plan.text, renderMode: 'markdown' as const } : {})
    };
  }

  if (name === WRITE_TOOL_NAME) {
    const content = boundedStringFieldPreview(preview, 'content');
    return {
      kind: 'write',
      title: '正在生成文件内容',
      ...(path ? { subject: path } : {}),
      detail: previewDetail(preview, content.truncated),
      ...(content.text
        ? { previewText: content.text, renderMode: isMarkdownPath(path) ? 'markdown' as const : 'text' as const }
        : {})
    };
  }

  if (name === EDIT_TOOL_NAME) {
    const argumentsPreview = genericArgumentsPreview(preview);
    return {
      kind: 'edit',
      title: '正在准备文件修改',
      ...(path ? { subject: path } : {}),
      detail: previewDetail(preview),
      ...(argumentsPreview ? { previewText: argumentsPreview, renderMode: 'json' as const } : {})
    };
  }

  if (name === 'bash' || name === 'shell') {
    const command = boundedStringFieldPreview(preview, 'command');
    const explanation = extractPartialJsonStringField(stableArguments, 'explanation');
    return {
      kind: 'command',
      title: '正在组装命令',
      ...(explanation ? { subject: explanation } : {}),
      detail: previewDetail(preview, command.truncated),
      ...(command.text ? { previewText: command.text, renderMode: 'text' as const } : {})
    };
  }

  const argumentsPreview = genericArgumentsPreview(preview);
  return {
    kind: 'generic',
    title: `正在组装 ${name} 参数`,
    detail: previewDetail(preview),
    ...(argumentsPreview ? { previewText: argumentsPreview, renderMode: 'json' as const } : {})
  };
}

/** Parses one JSON string field while the enclosing JSON may still be incomplete. */
export function extractPartialJsonStringField(source: string, field: string): string | undefined {
  return extractPartialJsonStringFieldState(source, field)?.value || undefined;
}

export function genericArgumentsPreview(preview: ToolCallPreviewRecord): string | undefined {
  if (!preview.truncated) return tail(preview.argumentsHead.trim(), DISPLAY_PREVIEW_CHARS) || undefined;
  const joined = `${preview.argumentsHead}\n… 中间参数已省略 …\n${preview.argumentsTail}`;
  return tail(joined.trim(), DISPLAY_PREVIEW_CHARS) || undefined;
}

function boundedStringFieldPreview(preview: ToolCallPreviewRecord, field: string): BoundedFieldPreview {
  const source = stableArgumentsPrefix(preview);
  const decoded = extractPartialJsonStringFieldState(source, field);
  if (!decoded?.value) return { truncated: false };
  return {
    text: head(decoded.value, DISPLAY_PREVIEW_CHARS),
    truncated: decoded.value.length > DISPLAY_PREVIEW_CHARS
      || (!decoded.closed && preview.receivedChars > source.length)
  };
}

/**
 * The backend preserves this leading raw-argument window after its total preview limit is crossed.
 * Markdown/text field previews must only consume that immutable prefix; a rolling tail would force
 * the incremental Markdown renderer to reset and reparse the whole visible document every frame.
 */
function stableArgumentsPrefix(preview: ToolCallPreviewRecord): string {
  return preview.argumentsHead.slice(0, TOOL_CALL_PREVIEW_HEAD_CHARS);
}

function extractPartialJsonStringFieldState(source: string, field: string): PartialJsonStringField | undefined {
  const marker = `"${escapeRegExp(field)}"\\s*:\\s*"`;
  const match = new RegExp(marker).exec(source);
  if (!match || match.index === undefined) return undefined;
  const start = match.index + match[0].length;
  return decodeJsonStringFragment(source.slice(start));
}

/**
 * Decodes only complete JSON escape sequences. An escape split across stream chunks is withheld
 * until complete so the decoded value remains append-only for the streaming Markdown renderer.
 */
function decodeJsonStringFragment(source: string): PartialJsonStringField {
  let value = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"') return { value, closed: true };
    if (char !== '\\') {
      value += char;
      index += 1;
      continue;
    }

    if (index + 1 >= source.length) return { value, closed: false };
    const escaped = source[index + 1]!;
    if (escaped === 'u') {
      if (index + 6 > source.length) return { value, closed: false };
      const hex = source.slice(index + 2, index + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += 'u';
      index += 2;
      continue;
    }

    if (escaped === 'n') value += '\n';
    else if (escaped === 'r') value += '\r';
    else if (escaped === 't') value += '\t';
    else if (escaped === 'b') value += '\b';
    else if (escaped === 'f') value += '\f';
    else if (escaped === '"') value += '"';
    else if (escaped === '\\') value += '\\';
    else if (escaped === '/') value += '/';
    else value += escaped;
    index += 2;
  }
  return { value, closed: false };
}

function previewDetail(preview: ToolCallPreviewRecord, displayTruncated = false): string {
  const truncation = preview.truncated || displayTruncated ? ' · 预览已截断' : '';
  return `已接收 ${formatCharacterCount(preview.receivedChars)} 个参数字符${truncation}`;
}

function isMarkdownPath(path: string | undefined): boolean {
  return !!path && /\.(?:md|markdown|mdx)$/i.test(path.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatCharacterCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function head(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}

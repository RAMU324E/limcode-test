import { READ_TOOL_NAME, type InlineDataPart } from '../../../../../../shared/protocol';
import type { ToolDefinition, ToolDeps, ToolExecutionContext } from '../../registry';
import { staticToolScheduling } from '../../schedulingContract';
import { defineToolDefinitionModule } from '../types';
import { allowOutsideProjectPathsDefaultConfig, allowOutsideProjectPathsField, allowOutsideProjectPathsFromConfig, filePathPolicyDescription } from '../filePathPolicy';

type ReadFileMode = 'text' | 'attachment';

interface ReadFileItem {
  path?: string;
  startLine?: number;
  endLine?: number;
}

interface ReadFileArgs {
  path?: string;
  mode?: ReadFileMode;
  startLine?: number;
  endLine?: number;
  items?: ReadFileItem[];
}

const READ_BATCH_MAX_ITEMS = 8;
const READ_BATCH_MAX_CONTENT_CHARS = 256 * 1024;

const READ_MULTIMODAL_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const EXTENSION_MIME_MAP: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };

export const readFileToolModule = defineToolDefinitionModule({
  id: READ_TOOL_NAME,
  create() {
    return readFileTool;
  }
});

export const readFileTool: ToolDefinition = {
  declaration: {
    name: READ_TOOL_NAME,
    description: [
      'Read one file or a batch of up to 8 text files from the current work environment. For one file, path is required and mode defaults to "text"; use mode="attachment" for supported images/PDF. For independent text files, prefer one items batch over multiple read calls: batch items are read concurrently while results preserve input order. Exactly one of path or items must be provided.',
      filePathPolicyDescription(true)
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path. Relative paths are resolved from the current work environment root; absolute paths are supported when allowed by tool policy or when they are inside an explicitly allowed local work environment root.' },
        mode: { type: 'string', enum: ['text', 'attachment'], description: 'Optional read mode. Defaults to "text" when omitted; use "attachment" for a multimodal file inferred from its extension.' },
        startLine: { type: 'number', description: 'Text mode only. Optional 1-based start line (inclusive); non-positive values are treated as omitted.' },
        endLine: { type: 'number', description: 'Text mode only. Optional 1-based end line (inclusive); non-positive values are treated as omitted.' },
        items: {
          type: 'array',
          maxItems: READ_BATCH_MAX_ITEMS,
          description: 'Optional batch of 2-8 independent text reads. Items execute concurrently, results preserve input order, and one batch is preferred over multiple read calls. Attachments are not supported in a batch.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Text file path.' },
              startLine: { type: 'number', description: 'Optional 1-based inclusive start line.' },
              endLine: { type: 'number', description: 'Optional 1-based inclusive end line.' }
            },
            required: ['path']
          }
        }
      }
    },
    metadata: {
      category: 'filesystem',
      scope: 'file',
      riskLevel: 'read',
      readonly: true,
      defaultEnabled: true,
      checkpoint: { before: false, after: false }
    },
    configSchema: { fields: [allowOutsideProjectPathsField(true)] },
    defaultConfig: allowOutsideProjectPathsDefaultConfig(true)
  },
  execution: 'runtime',
  scheduling: staticToolScheduling('parallel', 'readonly_file_read'),
  summary: summarizeReadFileToolCall,
  async execute(rawArgs, deps, ctx) {
    const args = (rawArgs ?? {}) as ReadFileArgs;
    const path = normalizeDisplayPath(args.path);
    // Some tool transports materialize optional schema fields as empty placeholders. Do not let an
    // empty items array (or minItems-shaped blank objects) turn a valid single-file call into a
    // false path/items conflict.
    const items = path && isSyntheticEmptyReadItems(args.items) ? undefined : args.items;
    if (items !== undefined) {
      if (path) return { ok: false, output: 'Provide either path or items, not both.' };
      const explicitMode = normalizeReadMode(args.mode);
      if (args.mode !== undefined && !explicitMode) {
        return { ok: false, output: 'Invalid argument: mode. Expected "text" or "attachment".' };
      }
      if (explicitMode === 'attachment') {
        return { ok: false, output: 'Batch items support text mode only.' };
      }
      const normalizedItems = normalizeReadItems(items);
      if (typeof normalizedItems === 'string') return { ok: false, output: normalizedItems };
      const files = await Promise.all(normalizedItems.map((item) => readTextFile(item, deps, ctx)));
      return { ok: true, output: { files: boundBatchReadOutput(files) } };
    }
    if (!path) {
      return { ok: false, output: 'Missing required argument: path or items' };
    }
    const explicitMode = normalizeReadMode(args.mode);
    if (args.mode !== undefined && !explicitMode) {
      return { ok: false, output: 'Invalid argument: mode. Expected "text" or "attachment".' };
    }
    const mode: ReadFileMode = explicitMode ?? 'text';

    const mimeType = inferMimeType(path);
    const isSupportedAttachment = !!mimeType && READ_MULTIMODAL_MIME_TYPES.has(mimeType);
    if (mode === 'attachment') {
      if (!isSupportedAttachment || !mimeType) {
        return { ok: false, output: unsupportedAttachmentMessage(path) };
      }
      if (ctx?.settingsSnapshot?.enableMultimodalTools === false) {
        return { ok: true, status: 'warning', output: multimodalDisabledMessage(mimeType) };
      }
      const file = await deps.fs.readBinaryFile(path, mimeType, {
        signal: ctx?.signal,
        workEnvironment: ctx?.workEnvironment,
        accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
        allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
      });
      const part: InlineDataPart = {
        inlineData: {
          mimeType,
          data: file.data,
          name: file.name,
          sourcePath: file.path,
          storage: 'embedded',
          status: 'available',
          sizeBytes: file.sizeBytes
        }
      };
      return { ok: true, output: { mimeType, sizeBytes: file.sizeBytes }, parts: [part] };
    }

    if (isSupportedAttachment) {
      return { ok: false, output: `Cannot read ${mimeType} as UTF-8 text. Use mode="attachment" for ${path}.` };
    }
    const output = await readTextFile({ ...args, path }, deps, ctx);
    return { ok: true, output };
  }
};

function summarizeReadFileToolCall(rawArgs: unknown): string | undefined {
  const args = (rawArgs ?? {}) as ReadFileArgs;
  const path = normalizeDisplayPath(args.path);
  const items = Array.isArray(args.items) && !(path && isSyntheticEmptyReadItems(args.items))
    ? args.items
    : undefined;
  if (items) return `${items.length} text files`;
  if (!path) return undefined;

  const mode = normalizeReadMode(args.mode) ?? 'text';
  const modeSuffix = `[${mode}]`;
  if (mode === 'attachment') return `${path}${modeSuffix}`;
  const range = lineRangeSuffix(args.startLine, args.endLine);
  return `${path}${modeSuffix}${range}`;
}

async function readTextFile(
  item: ReadFileItem,
  deps: ToolDeps,
  ctx: ToolExecutionContext | undefined
): Promise<{
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}> {
  const path = normalizeDisplayPath(item.path);
  if (!path) throw new TypeError('Read item path must be non-empty.');
  const text = await deps.fs.readFile(path, normalizeLineNumber(item.startLine), normalizeLineNumber(item.endLine), {
    signal: ctx?.signal,
    workEnvironment: ctx?.workEnvironment,
    accessibleWorkEnvironments: ctx?.accessibleWorkEnvironments,
    allowOutsideProjectPaths: allowOutsideProjectPathsFromConfig(ctx?.config, true)
  });
  return {
    path: text.path,
    startLine: text.startLine,
    endLine: text.endLine,
    totalLines: text.totalLines,
    content: text.content
  };
}

function isSyntheticEmptyReadItems(value: unknown): boolean {
  return Array.isArray(value) && value.every((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const item = candidate as ReadFileItem;
    return !normalizeDisplayPath(item.path)
      && normalizeLineNumber(item.startLine) === undefined
      && normalizeLineNumber(item.endLine) === undefined;
  });
}

function normalizeReadItems(value: unknown): ReadFileItem[] | string {
  if (!Array.isArray(value) || value.length < 2 || value.length > READ_BATCH_MAX_ITEMS) {
    return `items must contain 2-${READ_BATCH_MAX_ITEMS} text read requests.`;
  }
  const items: ReadFileItem[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return `items[${index}] must be an object.`;
    }
    const item = candidate as ReadFileItem;
    const path = normalizeDisplayPath(item.path);
    if (!path) return `items[${index}].path must be non-empty.`;
    items.push({ path, startLine: item.startLine, endLine: item.endLine });
  }
  return items;
}

function boundBatchReadOutput<T extends { content: string }>(files: T[]): Array<T & {
  contentTruncated?: boolean;
  omittedChars?: number;
}> {
  let remaining = READ_BATCH_MAX_CONTENT_CHARS;
  return files.map((file) => {
    if (file.content.length <= remaining) {
      remaining -= file.content.length;
      return file;
    }
    const content = remaining > 0 ? file.content.slice(0, remaining) : '';
    const omittedChars = file.content.length - content.length;
    remaining = 0;
    return { ...file, content, contentTruncated: true, omittedChars };
  });
}

function normalizeDisplayPath(path: string | undefined): string {
  return typeof path === 'string' ? path.trim().replace(/\\+/g, '/') : '';
}

function lineRangeSuffix(startLine: number | undefined, endLine: number | undefined): string {
  const start = normalizeLineNumber(startLine);
  const end = normalizeLineNumber(endLine);
  if (start !== undefined && end !== undefined) return `[L${start}-${end}]`;
  if (start !== undefined) return `[L${start}-]`;
  if (end !== undefined) return `[L1-${end}]`;
  return '';
}

function normalizeLineNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const line = Math.floor(value);
  return line > 0 ? line : undefined;
}

function normalizeReadMode(value: unknown): ReadFileMode | undefined {
  return value === 'text' || value === 'attachment' ? value : undefined;
}

function multimodalDisabledMessage(mimeType: string): string {
  return `当前渠道未启用多模态工具，模型不具备读取 ${mimeType} 附件内容的能力。read 现在只能读取文本文件；如需查看图片、PDF 等附件，请在渠道配置中启用多模态工具。`;
}

function unsupportedAttachmentMessage(filePath: string): string {
  return `mode="attachment" only supports .png, .jpg, .jpeg, .webp, and .pdf files. Unsupported path: ${filePath}`;
}

function inferMimeType(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXTENSION_MIME_MAP[filePath.slice(dot).toLowerCase()];
}

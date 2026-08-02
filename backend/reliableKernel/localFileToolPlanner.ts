import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolDefinition } from '../world/modules/tools/registry';
import type {
  ReliableAgentToolDispatchInput
} from './agentLoop';
import type { FileChangeProposalMemberInput } from './fileEffects';
import type { ReliableToolDispatchAuthority } from './toolDispatcher';

export interface ResolvedLocalToolPath {
  workEnvironmentId: string;
  rootPath: string;
  targetPath: string;
  absolutePath: string;
}

export type LocalToolPathResolver = (
  inputPath: string,
  authority: ReliableToolDispatchAuthority
) => Promise<ResolvedLocalToolPath> | ResolvedLocalToolPath;

/** Pure planner for built-in write/edit/delete tools. It reads current bytes but never mutates them. */
export class LocalFileToolPlanner {
  public constructor(private readonly resolvePath: LocalToolPathResolver) {}

  public async plan(
    definition: ToolDefinition,
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<FileChangeProposalMemberInput[]> {
    switch (definition.declaration.name) {
      case 'write':
        return [await this.planWrite(input, authority)];
      case 'edit':
        return [await this.planEdit(input, authority)];
      case 'delete':
        return this.planDelete(input, authority);
      default:
        throw new Error(`Unsupported local file proposal tool: ${definition.declaration.name}.`);
    }
  }

  private async planWrite(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<FileChangeProposalMemberInput> {
    const args = requireRecord(input.arguments, 'write arguments');
    const inputPath = requireText(args.path, 'write.path');
    const content = requireString(args.content, 'write.content');
    const resolved = await this.resolvePath(inputPath, authority);
    const current = await inspectLocalTarget(resolved.absolutePath);
    if (current.kind === 'directory') throw new Error(`write target is a directory: ${inputPath}`);
    return {
      operation: current.kind === 'missing' ? 'create_file' : 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      targetPath: normalizedRelativeTarget(resolved),
      ...(current.kind === 'file' ? {
        baseDigest: current.digest,
        baseContent: current.bytes,
        baseContentType: 'application/octet-stream'
      } : {}),
      targetContent: content,
      contentType: 'text/plain; charset=utf-8'
    };
  }

  private async planEdit(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<FileChangeProposalMemberInput> {
    const args = requireRecord(input.arguments, 'edit arguments');
    const inputPath = requireText(args.path, 'edit.path');
    const resolved = await this.resolvePath(inputPath, authority);
    const current = await inspectLocalTarget(resolved.absolutePath);
    if (current.kind !== 'file') throw new Error(`edit target must be an existing regular file: ${inputPath}`);
    const source = decodeUtf8Exact(current.bytes, inputPath);
    const target = applyEditArguments(source, args);
    return {
      operation: 'replace_file',
      workEnvironmentId: resolved.workEnvironmentId,
      targetPath: normalizedRelativeTarget(resolved),
      baseDigest: current.digest,
      baseContent: current.bytes,
      baseContentType: 'text/plain; charset=utf-8',
      targetContent: target,
      contentType: 'text/plain; charset=utf-8'
    };
  }

  private async planDelete(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority
  ): Promise<FileChangeProposalMemberInput[]> {
    const args = requireRecord(input.arguments, 'delete arguments');
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      throw new TypeError('delete.paths must be a non-empty array.');
    }
    const members: FileChangeProposalMemberInput[] = [];
    for (let index = 0; index < args.paths.length; index += 1) {
      const inputPath = requireText(args.paths[index], `delete.paths[${index}]`);
      const resolved = await this.resolvePath(inputPath, authority);
      const current = await inspectLocalTarget(resolved.absolutePath);
      members.push({
        operation: current.kind === 'directory' ? 'delete_directory_tree' : 'delete_file',
        workEnvironmentId: resolved.workEnvironmentId,
        targetPath: normalizedRelativeTarget(resolved),
        baseDigest: current.kind === 'file'
          ? current.digest
          : current.kind === 'directory'
            ? 'directory'
            : null,
        ...(current.kind === 'file' ? {
          baseContent: current.bytes,
          baseContentType: 'application/octet-stream'
        } : {})
      });
    }
    return members;
  }
}

export function resolvePathInsideBoundary(
  workEnvironmentId: string,
  rootPathInput: string,
  inputPath: string
): ResolvedLocalToolPath {
  const rootPath = path.resolve(requireText(rootPathInput, 'work environment rootPath'));
  const absolutePath = path.resolve(rootPath, requireText(inputPath, 'file path'));
  const relative = path.relative(rootPath, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes work environment ${workEnvironmentId}: ${inputPath}`);
  }
  if (!relative) throw new Error('A file tool cannot target the work environment root itself.');
  return {
    workEnvironmentId: requireText(workEnvironmentId, 'workEnvironmentId'),
    rootPath,
    targetPath: relative.split(path.sep).join('/'),
    absolutePath
  };
}

type LocalTarget =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: Buffer; digest: string }
  | { kind: 'directory' };

async function inspectLocalTarget(absolutePath: string): Promise<LocalTarget> {
  let stat;
  try {
    stat = await fs.lstat(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`Symbolic-link targets are not allowed: ${absolutePath}`);
  if (stat.isDirectory()) return { kind: 'directory' };
  if (!stat.isFile()) throw new Error(`Unsupported filesystem target type: ${absolutePath}`);
  const bytes = await fs.readFile(absolutePath);
  return { kind: 'file', bytes, digest: createHash('sha256').update(bytes).digest('hex') };
}

function applyEditArguments(source: string, args: { [key: string]: unknown }): string {
  if (Array.isArray(args.hunks)) return applyHunks(source, args.hunks);
  if (args.insert !== undefined) {
    const insert = requireUnknownRecord(args.insert, 'edit.insert');
    const line = requirePositiveLine(insert.line, 'edit.insert.line');
    const content = requireString(insert.content, 'edit.insert.content');
    const offset = lineStartOffset(source, line, true);
    return `${source.slice(0, offset)}${content}${source.slice(offset)}`;
  }
  if (args.delete !== undefined) {
    const deletion = requireUnknownRecord(args.delete, 'edit.delete');
    const startLine = requirePositiveLine(deletion.startLine, 'edit.delete.startLine');
    const endLine = requirePositiveLine(deletion.endLine, 'edit.delete.endLine');
    if (endLine < startLine) throw new Error('edit.delete.endLine must be >= startLine.');
    const start = lineStartOffset(source, startLine, false);
    const end = lineStartOffset(source, endLine + 1, true);
    return `${source.slice(0, start)}${source.slice(end)}`;
  }
  throw new Error('edit requires hunks, insert, or delete.');
}

function applyHunks(source: string, hunks: unknown[]): string {
  if (hunks.length === 0) throw new Error('edit.hunks must not be empty.');
  let output = source;
  for (let index = 0; index < hunks.length; index += 1) {
    const hunk = requireUnknownRecord(hunks[index], `edit.hunks[${index}]`);
    const oldContent = requireString(hunk.oldContent, `edit.hunks[${index}].oldContent`);
    const newContent = requireString(hunk.newContent, `edit.hunks[${index}].newContent`);
    if (!oldContent) throw new Error(`edit.hunks[${index}].oldContent must not be empty.`);
    const first = output.indexOf(oldContent);
    if (first < 0) throw new Error(`Hunk ${index}: no exact match found for oldContent.`);
    if (hunk.replaceAll === true) output = output.split(oldContent).join(newContent);
    else output = `${output.slice(0, first)}${newContent}${output.slice(first + oldContent.length)}`;
  }
  return output;
}

function lineStartOffset(source: string, line: number, allowAppend: boolean): number {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const maximum = starts.length + (allowAppend && starts.at(-1) !== source.length ? 1 : 0);
  if (line < 1 || line > maximum) throw new Error(`Line ${line} is outside 1-${maximum}.`);
  if (line === starts.length + 1) return source.length;
  return starts[line - 1];
}

function normalizedRelativeTarget(resolved: ResolvedLocalToolPath): string {
  const relative = path.relative(path.resolve(resolved.rootPath), path.resolve(resolved.absolutePath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Resolved file target is outside its declared work environment boundary.');
  }
  const declared = resolved.targetPath.split('/').join(path.sep);
  if (path.normalize(declared) !== path.normalize(relative)) {
    throw new Error('Resolved file targetPath does not match absolutePath/rootPath evidence.');
  }
  return relative.split(path.sep).join('/');
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(`${label} is not canonical UTF-8 text.`);
  return decoded;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function requireUnknownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  const text = requireString(value, label).trim();
  if (!text) throw new TypeError(`${label} must be non-empty.`);
  return text;
}

function requirePositiveLine(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

type PlainJsonValue = import('./plainJson').PlainJsonValue;

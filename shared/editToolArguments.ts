import type { EditToolMode } from './protocol';

export interface ValidatedEditHunk {
  oldContent: string;
  newContent: string;
  replaceAll: boolean;
}

export type ValidatedEditToolArguments =
  | { path: string; mode: 'hunk'; hunks: ValidatedEditHunk[] }
  | { path: string; mode: 'insert'; insert: { line: number; content: string } }
  | { path: string; mode: 'delete'; delete: { startLine: number; endLine: number } };

type EditBranchName = 'hunks' | 'insert' | 'delete';

/**
 * Validates the edit discriminated union at the shared tool/effect boundary.
 * Empty optional placeholders emitted by some structured transports are ignored only when a
 * different branch is complete; a path-only call and a lone empty branch still fail closed.
 */
export function validateEditToolArguments(value: unknown): ValidatedEditToolArguments {
  const args = requireRecord(value, 'edit arguments');
  assertOnlyKeys(args, ['path', 'hunks', 'insert', 'delete'], 'edit arguments');
  const path = requireNonEmptyString(args.path, 'edit.path');
  const active = (['hunks', 'insert', 'delete'] as const)
    .filter((branch) => !isEmptyBranchPlaceholder(branch, args[branch]));
  if (active.length !== 1) {
    throw new TypeError('edit arguments must provide exactly one edit branch: non-empty hunks, insert, or delete.');
  }

  switch (active[0]) {
    case 'hunks':
      return { path, mode: 'hunk', hunks: validateHunks(args.hunks) };
    case 'insert':
      return { path, mode: 'insert', insert: validateInsert(args.insert) };
    case 'delete':
      return { path, mode: 'delete', delete: validateDelete(args.delete) };
  }
}

/** Best-effort mode selection for summaries of malformed calls; execution must use the validator. */
export function selectEditToolMode(value: unknown): EditToolMode {
  try {
    return validateEditToolArguments(value).mode;
  } catch {
    const args = asRecord(value);
    if (!isEmptyBranchPlaceholder('insert', args?.insert)) return 'insert';
    if (!isEmptyBranchPlaceholder('delete', args?.delete)) return 'delete';
    return 'hunk';
  }
}

export function hasRequestedEditHunks(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function hasRequestedEditInsert(value: unknown): boolean {
  try {
    validateInsert(value);
    return true;
  } catch {
    return false;
  }
}

export function hasRequestedEditDelete(value: unknown): boolean {
  try {
    validateDelete(value);
    return true;
  } catch {
    return false;
  }
}

function validateHunks(value: unknown): ValidatedEditHunk[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('edit.hunks must be a non-empty array.');
  }
  return value.map((entry, index) => {
    const hunk = requireRecord(entry, `edit.hunks[${index}]`);
    const oldContent = requireString(hunk.oldContent, `edit.hunks[${index}].oldContent`);
    const newContent = requireString(hunk.newContent, `edit.hunks[${index}].newContent`);
    if (!oldContent) throw new TypeError(`edit.hunks[${index}].oldContent must be non-empty.`);
    const unsupported = Object.keys(hunk).filter((key) => !['oldContent', 'newContent', 'replaceAll'].includes(key));
    if (unsupported.length > 0) throw new TypeError(`edit.hunks[${index}] contains unsupported fields: ${unsupported.join(', ')}.`);
    if (hunk.replaceAll !== undefined && typeof hunk.replaceAll !== 'boolean') {
      throw new TypeError(`edit.hunks[${index}].replaceAll must be a boolean when provided.`);
    }
    return { oldContent, newContent, replaceAll: hunk.replaceAll === true };
  });
}

function validateInsert(value: unknown): { line: number; content: string } {
  const insert = requireRecord(value, 'edit.insert');
  assertOnlyKeys(insert, ['line', 'content'], 'edit.insert');
  const line = requirePositiveInteger(insert.line, 'edit.insert.line');
  const content = requireString(insert.content, 'edit.insert.content');
  if (!content) throw new TypeError('edit.insert.content must be non-empty.');
  return { line, content };
}

function validateDelete(value: unknown): { startLine: number; endLine: number } {
  const deletion = requireRecord(value, 'edit.delete');
  assertOnlyKeys(deletion, ['startLine', 'endLine'], 'edit.delete');
  const startLine = requirePositiveInteger(deletion.startLine, 'edit.delete.startLine');
  const endLine = requirePositiveInteger(deletion.endLine, 'edit.delete.endLine');
  if (endLine < startLine) throw new TypeError('edit.delete.endLine must be greater than or equal to startLine.');
  return { startLine, endLine };
}

function isEmptyBranchPlaceholder(branch: EditBranchName, value: unknown): boolean {
  if (value === undefined) return true;
  if (branch === 'hunks') return Array.isArray(value) && value.length === 0;
  const record = asRecord(value);
  return !!record && Object.keys(record).length === 0;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new TypeError(`${label} must be an object.`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = requireString(value, label).trim();
  if (!text) throw new TypeError(`${label} must be non-empty.`);
  return text;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unsupported = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) throw new TypeError(`${label} contains unsupported fields: ${unsupported.join(', ')}.`);
}

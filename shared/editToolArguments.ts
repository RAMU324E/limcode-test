import type { EditToolMode } from './protocol';

interface EditArgumentRecord {
  hunks?: unknown;
  insert?: unknown;
  delete?: unknown;
}

/**
 * Chooses the one edit branch that was actually requested. Some structured-tool transports
 * materialize every optional object as an empty zero-value placeholder, so object presence alone
 * cannot decide the mode. A non-empty hunk array wins, followed by a valid line insert/delete.
 * The presence fallbacks deliberately preserve useful validation errors for genuinely malformed
 * calls that do not contain any valid branch.
 */
export function selectEditToolMode(value: unknown): EditToolMode {
  const args = asRecord(value) as EditArgumentRecord | undefined;
  if (hasRequestedEditHunks(args?.hunks)) return 'hunk';
  if (hasRequestedEditInsert(args?.insert)) return 'insert';
  if (hasRequestedEditDelete(args?.delete)) return 'delete';
  if (args?.insert !== undefined) return 'insert';
  if (args?.delete !== undefined) return 'delete';
  return 'hunk';
}

export function hasRequestedEditHunks(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function hasRequestedEditInsert(value: unknown): boolean {
  const insert = asRecord(value);
  return Boolean(
    insert
    && isPositiveLine(insert.line)
    && typeof insert.content === 'string'
    && insert.content.length > 0
  );
}

export function hasRequestedEditDelete(value: unknown): boolean {
  const deletion = asRecord(value);
  return Boolean(
    deletion
    && isPositiveLine(deletion.startLine)
    && isPositiveLine(deletion.endLine)
  );
}

function isPositiveLine(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

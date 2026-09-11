/**
 * Shared SQL text/identifier quoting and runtime row scalar guards used by the database worker
 * and its client projection. Pure functions over decoded values only: no connection, binding, or
 * worker state, so either side of the worker/projection split can depend on them without cycles.
 */
import type { EncodedRow } from './repositories';

export function requireEncodedId(value: EncodedRow[string], codecName: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${codecName}.id must be a non-empty string.`);
  return value;
}

export function requireRuntimeId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Runtime row id must be a non-empty string.');
  return value;
}

export function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quote(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  return `"${identifier}"`;
}

export function requireNonNegativeIntegerString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

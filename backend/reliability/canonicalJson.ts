import { createHash } from 'node:crypto';
import type { CommandEnvelope, JsonValue } from '../../shared/conversationReliability';

/** RFC 8785-compatible canonical JSON for the JSON domain accepted by command envelopes. */
export function canonicalJson(value: unknown): string {
  return serialize(assertJsonValue(value, '$'));
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function commandPayloadHash(command: CommandEnvelope): string {
  return canonicalSha256({
    type: command.type,
    requestedScope: canonicalCommandScope(command.scope),
    expectedVersions: [...command.expectedVersions]
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId))
      .map((item) => ({ conversationId: item.conversationId, version: item.version })),
    payload: command.payload
  });
}

export function canonicalCommandScope(scope: CommandEnvelope['scope']): JsonValue {
  if (scope.kind === 'conversation') return { kind: scope.kind, id: scope.id };
  return { kind: scope.kind, ids: [...new Set(scope.ids)].sort() };
}

function serialize(value: JsonValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number': return JSON.stringify(value);
    case 'string': return JSON.stringify(value);
    case 'object':
      if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${serialize(value[key])}`).join(',')}}`;
  }
}

function assertJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${path}.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => assertJsonValue(item, `${path}[${index}]`));
  if (!isPlainObject(value)) throw new TypeError(`Non-JSON value at ${path}.`);

  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined) throw new TypeError(`Undefined value at ${path}.${key}.`);
    result[key] = assertJsonValue(item, `${path}.${key}`);
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

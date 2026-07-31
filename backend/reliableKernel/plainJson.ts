export type PlainJsonValue = null | boolean | number | string | PlainJsonValue[] | { [key: string]: PlainJsonValue };

/** Strict deterministic JSON data: no class/Date/Map/Set/Buffer/undefined fallback. */
export function normalizePlainJson(value: unknown, label = 'JSON'): PlainJsonValue {
  return normalize(value, label, new Set<object>());
}

export function canonicalPlainJson(value: unknown, label = 'JSON'): string {
  return JSON.stringify(normalizePlainJson(value, label));
}

function normalize(value: unknown, label: string, ancestors: Set<object>): PlainJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} cannot contain non-finite numbers.`);
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) {
    return withAncestor(value, label, ancestors, () => value.map((entry, index) =>
      normalize(entry, `${label}[${index}]`, ancestors)
    ));
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} must contain only plain objects and arrays.`);
    }
    return withAncestor(value, label, ancestors, () => Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested, `${label}.${key}`, ancestors)])
    ));
  }
  throw new TypeError(`${label} must contain JSON-compatible plain data.`);
}

function withAncestor<T>(value: object, label: string, ancestors: Set<object>, action: () => T): T {
  if (ancestors.has(value)) throw new TypeError(`${label} cannot contain cycles.`);
  ancestors.add(value);
  try {
    return action();
  } finally {
    ancestors.delete(value);
  }
}

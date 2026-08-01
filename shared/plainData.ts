export type PlainData = null | string | number | boolean | PlainData[] | { [key: string]: PlainData };

/** Recursively copies Vue/Pinia proxy-backed object graphs into structured-clone plain data. */
export function toStructuredClonePlainData(value: unknown, label = 'payload'): PlainData {
  return copyPlain(value, label, new WeakSet<object>(), false) as PlainData;
}

export function isStructuredClonePlainData(value: unknown): value is PlainData {
  try {
    toStructuredClonePlainData(value);
    return true;
  } catch {
    return false;
  }
}

function copyPlain(
  value: unknown,
  label: string,
  ancestors: WeakSet<object>,
  allowUndefined: boolean
): PlainData | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number.`);
    return value;
  }
  if (value === undefined && allowUndefined) return undefined;
  if (value === undefined) throw new TypeError(`${label} contains undefined outside an optional object field.`);
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`${label} contains unsupported ${typeof value}.`);
  }
  if (typeof value !== 'object') throw new TypeError(`${label} is not structured-clone plain data.`);
  if (value instanceof Map || value instanceof Set || value instanceof Date || value instanceof RegExp) {
    throw new TypeError(`${label} contains a forbidden class instance.`);
  }
  const object = value as object;
  if (ancestors.has(object)) throw new TypeError(`${label} contains a cycle.`);
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => {
        const copied = copyPlain(entry, `${label}[${index}]`, ancestors, true);
        return copied === undefined ? null : copied;
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${label} contains a non-plain class instance.`);
    }
    const result: Record<string, PlainData> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const copied = copyPlain(entry, `${label}.${key}`, ancestors, true);
      if (copied !== undefined) result[key] = copied;
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}

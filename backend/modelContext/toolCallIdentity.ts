export function canonicalFunctionCallId(input: {
  providerId?: string;
  requestId: string;
  name: string;
  argsJson: string;
  ordinal: number;
}): string {
  const providerId = input.providerId?.trim();
  if (providerId) return providerId;
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'tool';
  return `tool-${input.requestId}-${name}-${shortHash(canonicalArgs(input.argsJson))}-${Math.max(0, Math.floor(input.ordinal))}`;
}

function canonicalArgs(argsJson: string): string {
  try { return canonicalJson(argsJson ? JSON.parse(argsJson) : {}); }
  catch { return argsJson; }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(',')}}`;
}

function shortHash(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  return (hash >>> 0).toString(36);
}

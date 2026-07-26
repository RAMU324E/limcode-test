import type {
  CompressionModelContextProjectionLinkRecord,
  MessageContent,
  ModelContextProjectionRecord
} from './protocol';

export interface CompressionProviderContentsInput {
  blockId: string;
  canonicalContents: readonly MessageContent[];
  projections: readonly Pick<ModelContextProjectionRecord, 'id' | 'resultAddenda'>[];
  compressionLinks: readonly Pick<CompressionModelContextProjectionLinkRecord, 'blockId' | 'projectionId' | 'role'>[];
}

/**
 * Resolves the immutable source projection for one CompressionBlock and removes only its exact
 * structured resultAddenda suffix. The canonical variant remains untouched for raw inspection and
 * model reuse. Undefined means the relation/suffix cannot be proven and presentation must fail
 * closed instead of guessing from text.
 */
export function compressionProviderContents(input: CompressionProviderContentsInput): MessageContent[] | undefined {
  const links = input.compressionLinks.filter((link) => link.blockId === input.blockId && link.role === 'source');
  if (links.length !== 1) return undefined;
  const projections = input.projections.filter((projection) => projection.id === links[0].projectionId);
  if (projections.length !== 1) return undefined;

  const addenda = projections[0].resultAddenda ?? [];
  if (addenda.length === 0) return input.canonicalContents.map(clone);
  if (input.canonicalContents.length < addenda.length) return undefined;

  const providerLength = input.canonicalContents.length - addenda.length;
  const canonicalSuffix = input.canonicalContents.slice(providerLength);
  if (!structuredDataEqual(canonicalSuffix, addenda)) return undefined;
  return input.canonicalContents.slice(0, providerLength).map(clone);
}

function structuredDataEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structuredDataEqual(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && structuredDataEqual(left[key], right[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

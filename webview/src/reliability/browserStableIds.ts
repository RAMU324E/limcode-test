import { prefixedStableId, STABLE_ID_PREFIXES, uuidV7, type CommandId } from '@shared/stableIds';

const source = {
  now: () => Date.now(),
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  }
};

/** Browser-side durable command identity. Retries must retain the returned ID. */
export function nextCommandId(): CommandId {
  return prefixedStableId<'CommandId'>(STABLE_ID_PREFIXES.command, uuidV7(source));
}

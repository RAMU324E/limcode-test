import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { modelHandleRef, prepareModelHandleCatalog, type ReadonlyModelHandleCatalog } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

const CARD_PROCESS_LIMIT = 32;
const COMMAND_METADATA_MAX_BYTES = 64 * 1024;
const commandCaches = new WeakMap<RuntimeDatabase, WeakMap<ContentAddressedStore, Map<string, string | undefined>>>();

function commandCache(database: RuntimeDatabase, store: ContentAddressedStore): Map<string, string | undefined> {
  let stores = commandCaches.get(database);
  if (!stores) commandCaches.set(database, stores = new WeakMap());
  let cache = stores.get(store);
  if (!cache) stores.set(store, cache = new Map());
  return cache;
}

/** A repaired P# is a new address, never a guess about what an ambiguous old P# meant.
 * Only this Conversation's proven process sources are described; a fork does not gain its
 * source's processes. This reads facts without starting, observing or stopping a process.
 */
export async function historicalProcessHandleCard(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string,
  catalog: ReadonlyModelHandleCatalog
): Promise<string | undefined> {
  if (!catalog.retiredRefs?.some(ref => ref.startsWith('P'))) return undefined;
  const preparedModelHandles = prepareModelHandleCatalog(catalog);
  const sources = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ProcessCompletionSourceLink').list({
    where: { conversation_id: conversationId }, orderBy: { column: 'created_at', direction: 'desc' }, limit: CARD_PROCESS_LIMIT
  })])).snapshot[0] as DomainRow[];
  const candidates = sources.filter(source => modelHandleRef(preparedModelHandles, 'process', source.process_id));
  const facts = candidates.length ? (await database.snapshot(candidates.flatMap(source => [
    DOMAIN_REPOSITORIES.domain('Process').get(String(source.process_id)),
    DOMAIN_REPOSITORIES.domain('Turn').get(String(source.source_turn_id)),
    DOMAIN_REPOSITORIES.domain('ToolCall').get(String(source.source_tool_call_id))
  ]))).snapshot : [];
  const cache = commandCache(database, contentStore);
  const valid: Array<{ process: DomainRow; call: DomainRow }> = [];
  for (let index = 0; index < candidates.length; index++) {
    const [process, turn, call] = facts.slice(index * 3, index * 3 + 3);
    if (!process || Array.isArray(process) || !turn || Array.isArray(turn)
      || turn.conversation_id !== conversationId || !call || Array.isArray(call)
      || call.turn_id !== turn.id || (call.tool_name !== 'bash' && call.tool_name !== 'shell')) continue;
    valid.push({ process, call });
  }
  // Command bodies are immutable CAS objects. Keep only their short display text; status is read above every round.
  const uncached = [...new Set(valid.map(({ call }) => call.arguments_object_id)
    .filter((id): id is string => typeof id === 'string' && !cache.has(id)))];
  if (uncached.length) {
    const metadata = (await database.snapshot(uncached.map(id => DOMAIN_REPOSITORIES.domain('ContentObject').get(id)))).snapshot;
    await Promise.all(metadata.map(async (row, index) => {
      let command: string | undefined;
      if (row && !Array.isArray(row) && Number(row.byte_length) <= COMMAND_METADATA_MAX_BYTES) {
        const args: unknown = JSON.parse((await contentStore.read(row as unknown as ContentObjectMetadata)).toString('utf8'));
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          const text = (args as Record<string, unknown>).command;
          if (typeof text === 'string') command = text.slice(0, 240);
        }
      }
      cache.set(uncached[index], command);
      if (cache.size > CARD_PROCESS_LIMIT * 4) cache.delete(cache.keys().next().value!);
    }));
  }
  const descriptions: Array<Record<string, unknown>> = [];
  for (const { process, call } of valid) {
    const command = typeof call.arguments_object_id === 'string' ? cache.get(call.arguments_object_id) : undefined;
    descriptions.push({
      processRef: modelHandleRef(preparedModelHandles, 'process', process.id),
      status: process.status, startedAt: process.started_at,
      ...(command !== undefined ? { command } : {})
    });
  }
  return [
    '[Known processes after historical reference repair — runtime data]',
    'Only known processes among the most recent 32 process sources are listed. These current references identify the described processes. None is an alias for an ambiguous retired reference; choose by the command and facts, never by the old number. Read output without a cursor to start from the beginning.',
    JSON.stringify({ processes: descriptions })
  ].join('\n');
}

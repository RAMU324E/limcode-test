import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryKeysetCursor } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

const REPOSITORY_PAGE_SIZE = 1000;

/** Walk an existing owner/order index lazily; finding a recent match reads only its first pages. */
export async function* recentDomainRows(database: RuntimeDatabase, domain: string, where: DomainRow,
  column: string): AsyncGenerator<DomainRow> {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  let keyset: RepositoryKeysetCursor | undefined;
  for (;;) {
    const value = (await database.snapshot([repository.list({ where,
      orderBy: { column, direction: 'desc' }, limit: 16, ...(keyset ? { keyset } : {}) })])).snapshot[0];
    if (!Array.isArray(value)) throw new TypeError(`${domain} recent rows must be a list.`);
    for (const row of value) yield row;
    if (value.length < 16) return;
    const last = value[value.length - 1]!;
    keyset = { column, value: last[column] as string | bigint, id: String(last.id), direction: 'before' };
  }
}

/** Reads a complete equality-filtered domain set in one SQLite read transaction. */
export async function listAllDomainRows(
  database: RuntimeDatabase,
  domain: string,
  where: DomainRow = {}
): Promise<DomainRow[]> {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const snapshot = await database.snapshotAll(repository.list({
    where,
    orderBy: { column: domain === 'ModelRequest' ? 'request_seq' : 'id', direction: 'asc' },
    limit: REPOSITORY_PAGE_SIZE
  }));
  return snapshot.snapshot;
}

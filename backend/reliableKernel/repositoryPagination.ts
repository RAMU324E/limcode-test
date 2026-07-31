import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

const REPOSITORY_PAGE_SIZE = 1000;

/** Reads a complete equality-filtered domain set in one SQLite read transaction. */
export async function listAllDomainRows(
  database: RuntimeDatabase,
  domain: string,
  where: DomainRow = {}
): Promise<DomainRow[]> {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const snapshot = await database.snapshotAll(repository.list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: REPOSITORY_PAGE_SIZE
  }));
  return snapshot.snapshot;
}

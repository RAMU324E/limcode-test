import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

/** Returns 0 for a root Turn, 1 for its child Turn, and so on. Parent links are immutable. */
export async function childAgentDepthForTurn(
  database: RuntimeDatabase,
  turnIdInput: string
): Promise<number> {
  const turnId = requireDepthId(turnIdInput, 'turnId');
  const memberships = await listRows(database, 'ChildExecutionTurnLink', { turn_id: turnId });
  if (memberships.length > 1) {
    throw new Error(`Turn ${turnId} has multiple ChildExecution memberships.`);
  }
  if (memberships.length === 0) return 0;

  let depth = 0;
  let childExecutionId: string | null = requireDepthId(
    memberships[0].child_execution_id,
    'ChildExecutionTurnLink.child_execution_id'
  );
  const visited = new Set<string>();
  while (childExecutionId !== null) {
    if (visited.has(childExecutionId)) {
      throw new Error('ChildExecution parent lineage contains a cycle.');
    }
    visited.add(childExecutionId);
    depth += 1;
    const parentLinks = await listRows(database, 'ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    });
    if (parentLinks.length !== 1) {
      throw new Error(`ChildExecution ${childExecutionId} must retain exactly one parent link.`);
    }
    childExecutionId = parentLinks[0].parent_child_execution_id === null
      ? null
      : requireDepthId(
          parentLinks[0].parent_child_execution_id,
          'ChildExecutionParentLink.parent_child_execution_id'
        );
  }
  return depth;
}

async function listRows(
  database: RuntimeDatabase,
  domain: 'ChildExecutionTurnLink' | 'ChildExecutionParentLink',
  where: DomainRow
): Promise<DomainRow[]> {
  const snapshot = await database.snapshot([
    DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 2 })
  ]);
  const rows = snapshot.snapshot[0];
  if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
  return rows;
}

function requireDepthId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

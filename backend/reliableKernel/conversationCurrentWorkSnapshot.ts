import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';

export interface CurrentConversationTurns {
  activeTurns: DomainRow[];
  latestTurn: DomainRow | null;
}

export type NativeSteeringReceiptScope = { conversationId: string } | { turnId: string };
export interface NativeSteeringReceiptFacts {
  inputs: DomainRow[];
  contentObjects: DomainRow[];
}

/** Caller owns the read transaction. Two rows retain the existing uniqueness assertion. */
export function readCurrentConversationTurns(
  database: Database.Database,
  conversationIdInput: string,
  includeLatest = false
): CurrentConversationTurns {
  const conversationId = requireRuntimeId(conversationIdInput);
  const codec = DOMAIN_REPOSITORIES.domain('Turn').codec;
  const activeTurns = prepareCached(database, `
    SELECT * FROM turn INDEXED BY ix_turn_02
    WHERE status = 'active' AND conversation_id = ? LIMIT 2
  `).all(conversationId).map(row => codec.decode(row as DomainRow));
  const latest = includeLatest && activeTurns.length === 0 ? prepareCached(database, `
    SELECT * FROM turn WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(conversationId) as DomainRow | undefined : undefined;
  return { activeTurns, latestTurn: latest ? codec.decode(latest) : null };
}

/** One conversation range read replaces one PendingTurnInput request per historical Turn. */
export function readNativeSteeringReceiptFacts(
  database: Database.Database,
  scope: NativeSteeringReceiptScope
): NativeSteeringReceiptFacts {
  const where = 'conversationId' in scope ? 'turn.conversation_id = ?' : 'turn.id = ?';
  const id = requireRuntimeId('conversationId' in scope ? scope.conversationId : scope.turnId);
  const inputCodec = DOMAIN_REPOSITORIES.domain('PendingTurnInput').codec;
  const inputs = prepareCached(database, `
    SELECT input.* FROM turn
    JOIN pending_turn_input AS input ON input.turn_id = turn.id
    WHERE ${where} AND input.input_kind = 'native_steer'
    ORDER BY turn.created_at, turn.id, input.created_at, input.id
  `).all(id).map(row => inputCodec.decode(row as DomainRow));
  const metadataCodec = DOMAIN_REPOSITORIES.domain('ContentObject').codec;
  const metadata = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?');
  const contentObjects = [...new Set(inputs.map(row => requireRuntimeId(row.content_object_id)))].map(contentObjectId => {
    const row = metadata.get(contentObjectId) as DomainRow | undefined;
    if (!row) throw new Error(`Native steering envelope ContentObject ${contentObjectId} does not exist.`);
    return metadataCodec.decode(row);
  });
  return { inputs, contentObjects };
}

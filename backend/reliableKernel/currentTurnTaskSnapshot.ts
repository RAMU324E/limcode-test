import type Database from 'better-sqlite3';
import {
  approvedSubmitPlanTaskOperation,
  buildCurrentTurnTaskProjection,
  freezeCurrentTurnTaskCard,
  isApprovedCurrentConversationPlanArtifact,
  taskListOperationFromSettledArtifact,
  type CurrentTurnTaskOperationFact,
  type FrozenTurnTaskCard
} from './currentTurnTaskProjection';
import type { RuntimeChange } from './contracts';
import { toolArtifactIdentifiesCallInWorker } from './copiedToolIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { prepareCached } from './runtimeStatementCache';
import { requireRuntimeId } from './runtimeSqlRows';

/** The complete task card is reduced once on the worker and frozen with the request frontier. */
export interface CurrentTurnTaskSnapshot {
  turnId: string;
  card?: FrozenTurnTaskCard;
}

type ReadVerifiedBytes = (metadata: DomainRow) => Buffer;

/** Local commits invalidate only affected task owners; peer commits use SQLite's data version. */
export class CurrentTurnTaskCardCache {
  private readonly cards = new Map<string, FrozenTurnTaskCard | undefined>();
  private externalVersion?: string;

  public clear(): void { this.cards.clear(); }

  public synchronizeExternalVersion(version: string): void {
    if (version !== this.externalVersion) this.clear();
    this.externalVersion = version;
  }

  public invalidate(changes: readonly RuntimeChange[]): void {
    for (const change of changes) {
      if (change.domain === 'ConversationTaskList' || (change.domain === 'Conversation' && change.kind === 'remove')) {
        this.cards.delete(change.id);
      }
    }
  }

  public read(database: Database.Database, turnIdInput: string, readVerifiedBytes: ReadVerifiedBytes,
    reuse = true): CurrentTurnTaskSnapshot {
    const turnId = requireRuntimeId(turnIdInput);
    const turn = prepareCached(database, 'SELECT conversation_id FROM turn WHERE id = ?').get(turnId) as DomainRow | undefined;
    if (!turn) throw new Error(`Turn ${turnId} is missing.`);
    const conversationId = requireRuntimeId(turn.conversation_id);
    let card = reuse ? this.cards.get(conversationId) : undefined;
    if (!reuse || !this.cards.has(conversationId)) {
      const projection = buildCurrentTurnTaskProjection({ turnId,
        operations: readCurrentTurnTaskOperations(database, conversationId, readVerifiedBytes) });
      card = projection && freezeCurrentTurnTaskCard(projection);
      if (reuse) {
        this.cards.set(conversationId, card);
        if (this.cards.size > 8) this.cards.delete(this.cards.keys().next().value!);
      }
    }
    return { turnId, ...(card ? { card: { ...card, turnId } } : {}) };
  }
}

// Drive the scan from the existing conversation/message_seq index. CROSS JOIN keeps SQLite from
// starting with every ToolCall and sorting the entire history before yielding its first candidate.
// The remaining ordering terms sort only calls within one Message, using the existing source link.
// No Turn inventory, ordinal reassignment, or global commit counter is part of this read.
const TASK_CANDIDATES_SQL = `
  SELECT call.*,
         artifact.content_object_id AS artifact_content_object_id,
         source.message_id AS source_message_id,
         source.provider_ordinal AS source_provider_ordinal,
         membership.message_seq AS source_message_seq
    FROM message_part_of_conversation AS membership
    CROSS JOIN message ON message.id = membership.message_id
    CROSS JOIN tool_call_source_link AS source ON source.message_id = membership.message_id
    CROSS JOIN tool_call AS call ON call.id = source.tool_call_id
    CROSS JOIN turn AS owner ON owner.id = call.turn_id
    CROSS JOIN tool_result_artifact AS artifact
      ON artifact.tool_call_id = call.id AND artifact.role = 'no_effect_result'
   WHERE membership.conversation_id = @conversationId
     AND owner.conversation_id = @conversationId
     AND message.deleted_at IS NULL
     AND call.tool_name IN ('update_task_list', 'submit_plan')
   ORDER BY membership.message_seq DESC,
            source.provider_ordinal DESC,
            call.call_seq DESC,
            call.id DESC
`;

/**
 * The caller holds a fenced SQLite read transaction. Candidate order, visibility, settlement,
 * copied identities and CAS metadata therefore share one frontier, including external writes.
 * CAS is read only for visited candidates. Once a valid rewrite is found, superseded artifacts
 * (even malformed/missing old bodies) have no authority over this card and are not opened.
 */
function readCurrentTurnTaskOperations(
  database: Database.Database,
  conversationId: string,
  readVerifiedBytes: ReadVerifiedBytes
): CurrentTurnTaskOperationFact[] {
  const operations: CurrentTurnTaskOperationFact[] = [];
  const candidates = prepareCached(database, TASK_CANDIDATES_SQL).iterate({ conversationId });
  for (const value of candidates) {
    const row = value as DomainRow;
    const call = DOMAIN_REPOSITORIES.codec('ToolCall').decode(row);
    const toolCallId = requireRuntimeId(call.id);
    const rawArtifact = readJson(database, row.artifact_content_object_id, 'ToolResultArtifact', readVerifiedBytes);
    const artifact = identifyArtifact(database, call, rawArtifact);
    let operation: CurrentTurnTaskOperationFact['operation'] | undefined;
    if (call.tool_name === 'update_task_list') {
      operation = taskListOperationFromSettledArtifact(artifact, toolCallId);
    } else {
      // Rejected/cancelled Plans and Plans executed elsewhere cannot reset this Conversation.
      // Their arguments have no task authority, so do not read or validate those old bodies.
      if (!isApprovedCurrentConversationPlanArtifact(artifact, toolCallId)) continue;
      operation = approvedSubmitPlanTaskOperation({
        argumentsValue: readJson(database, call.arguments_object_id, 'submit_plan arguments', readVerifiedBytes),
        resultArtifactValue: artifact,
        toolCallId
      });
    }
    if (!operation) continue;
    operations.push({
      toolCallId,
      callSeq: nonNegativeInteger(call.call_seq, 'ToolCall.call_seq'),
      toolName: call.tool_name as CurrentTurnTaskOperationFact['toolName'],
      operation,
      ...(call.tool_name === 'submit_plan' ? { planApproved: true } : {}),
      sourceTurnId: requireRuntimeId(call.turn_id),
      sourceMessageId: requireRuntimeId(row.source_message_id),
      sourceMessageSeq: nonNegativeInteger(row.source_message_seq, 'MessagePartOfConversation.message_seq'),
      providerOrdinal: nonNegativeInteger(row.source_provider_ordinal, 'ToolCallSourceLink.provider_ordinal')
    });
    if (operation.mode === 'rewrite') return operations.reverse();
  }
  // Update-only history has no baseline. Do not return a historical update inventory to the Host.
  return [];
}

function identifyArtifact(database: Database.Database, call: DomainRow, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const artifact = value as Record<string, unknown>;
  return toolArtifactIdentifiesCallInWorker(database, artifact.toolCallId, call)
    ? { ...artifact, toolCallId: call.id }
    : artifact;
}

function readJson(
  database: Database.Database,
  contentObjectIdInput: unknown,
  label: string,
  readVerifiedBytes: ReadVerifiedBytes
): unknown {
  const contentObjectId = requireRuntimeId(contentObjectIdInput);
  const row = prepareCached(database, 'SELECT * FROM content_object WHERE id = ?').get(contentObjectId);
  if (!row) throw new Error(`${label} references missing ContentObject ${contentObjectId}.`);
  const metadata = DOMAIN_REPOSITORIES.codec('ContentObject').decode(row as DomainRow);
  try {
    return JSON.parse(readVerifiedBytes(metadata).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} content is not valid JSON: ${String(error)}`);
  }
}

function nonNegativeInteger(value: unknown, label: string): string {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative bigint.`);
  return value.toString();
}

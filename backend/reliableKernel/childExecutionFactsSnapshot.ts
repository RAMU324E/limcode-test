import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';
import { childContinuationTurnId, queuedIntentPendingInputId, CHILD_INTENT_ANSWER_WAIT_OWNER_KIND,
  CHILD_TURN_ANSWER_WAIT_OWNER_KIND } from './childSendLineage';

export interface ChildExecutionSnapshot {
  childExecution: DomainRow;
  parentLink: DomainRow;
  /** The first, latest, active and current-answer memberships, with duplicate identities removed. */
  turnLinks: DomainRow[];
  firstTurnLink: DomainRow | null;
  latestTurnLink: DomainRow | null;
  turnCount: bigint;
  activeTurnLink: DomainRow | null;
  activeTurn: DomainRow | null;
  answerBridge: DomainRow;
  currentSubmission: DomainRow | null;
}

export interface ChildExecutionSubtreeFacts {
  root: DomainRow;
  lineages: DomainRow[];
  parentLinks: DomainRow[];
  activeLinks: DomainRow[];
  activeTurns: DomainRow[];
  intentLinks: DomainRow[];
  pendingIntentLinks: DomainRow[];
  answerBridges: DomainRow[];
  pendingInputs: DomainRow[];
}

export interface ChildContinuationWaitFactsInput {
  childExecutionId: string;
  turnIntentId?: string;
  sourceTurnId?: string;
  toolCallId?: string;
  status?: string;
}

export interface ChildContinuationWaitFacts {
  operations: DomainRow[];
  legacyOperations: DomainRow[];
  intentLinks: DomainRow[];
}

function rows(database: Database.Database, domain: string, sql: string, ...args: (string | number | bigint)[]): DomainRow[] {
  const codec = DOMAIN_REPOSITORIES.domain(domain).codec;
  return prepareCached(database, sql).all(...args).map(row => codec.decode(row as DomainRow));
}

function get(database: Database.Database, domain: string, id: unknown): DomainRow {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const row = prepareCached(database, `SELECT * FROM ${repository.schema.table} WHERE id = ?`).get(requireRuntimeId(id));
  if (!row) throw new Error(`Child execution snapshot requires ${domain} ${String(id)}.`);
  return repository.codec.decode(row as DomainRow);
}

function one(matches: DomainRow[], domain: string, required = false): DomainRow | null {
  if (matches.length > 1 || (required && matches.length !== 1)) {
    throw new Error(`Child execution snapshot requires ${required ? 'one' : 'at most one'} ${domain}.`);
  }
  return matches[0] ?? null;
}

/** Existing membership order defines first/latest and count; a current subset never allocates a sequence. */
export function readChildExecutionTurnSelection(database: Database.Database, childExecutionId: string,
  referencedTurnIds: readonly string[] = []): Pick<ChildExecutionSnapshot, 'turnLinks' | 'firstTurnLink' | 'latestTurnLink' | 'turnCount'> {
  const firstTurnLink = rows(database, 'ChildExecutionTurnLink', `SELECT * FROM child_execution_turn_link
    WHERE child_execution_id = ? ORDER BY turn_seq ASC LIMIT 1`, childExecutionId)[0] ?? null;
  const latestTurnLink = rows(database, 'ChildExecutionTurnLink', `SELECT * FROM child_execution_turn_link
    WHERE child_execution_id = ? ORDER BY turn_seq DESC LIMIT 1`, childExecutionId)[0] ?? null;
  const count = prepareCached(database, 'SELECT COUNT(*) AS count FROM child_execution_turn_link WHERE child_execution_id = ?')
    .get(childExecutionId) as { count: bigint };
  const selected = new Map<string, DomainRow>();
  for (const row of [firstTurnLink, latestTurnLink]) if (row) selected.set(requireRuntimeId(row.id), row);
  for (const turnId of new Set(referencedTurnIds)) {
    if ([...selected.values()].some(link => link.turn_id === turnId)) continue;
    const link = one(rows(database, 'ChildExecutionTurnLink', 'SELECT * FROM child_execution_turn_link WHERE turn_id = ?', turnId), 'Turn membership', true)!;
    if (link.child_execution_id !== childExecutionId) throw new Error('Child execution Turn reference crosses lineage.');
    selected.set(requireRuntimeId(link.id), link);
  }
  return { firstTurnLink, latestTurnLink, turnCount: BigInt(count.count), turnLinks: [...selected.values()]
    .sort((a, b) => BigInt(String(a.turn_seq)) < BigInt(String(b.turn_seq)) ? -1 : 1) };
}

/** Caller owns one read transaction for all dependent targets. */
export function readChildExecutionSnapshot(database: Database.Database, childExecutionIdInput: string): ChildExecutionSnapshot {
  const childExecutionId = requireRuntimeId(childExecutionIdInput);
  const childExecution = get(database, 'ChildExecution', childExecutionId);
  const parentLink = one(rows(database, 'ChildExecutionParentLink', 'SELECT * FROM child_execution_parent_link WHERE child_execution_id = ?', childExecutionId), 'ParentLink', true)!;
  const activeTurnLink = one(rows(database, 'ChildExecutionActiveTurnLink', 'SELECT * FROM child_execution_active_turn_link WHERE child_execution_id = ?', childExecutionId), 'ActiveTurnLink');
  const answerBridge = one(rows(database, 'AnswerBridge', 'SELECT * FROM answer_bridge WHERE child_execution_id = ?', childExecutionId), 'AnswerBridge', true)!;
  const activeTurn = activeTurnLink ? get(database, 'Turn', activeTurnLink.turn_id) : null;
  const currentSubmission = answerBridge.current_submission_id === null ? null : get(database, 'AnswerSubmission', answerBridge.current_submission_id);
  const turnSelection = readChildExecutionTurnSelection(database, childExecutionId,
    [activeTurn?.id, currentSubmission?.turn_id].filter((id): id is string => typeof id === 'string'));
  if (activeTurn && activeTurn.conversation_id !== childExecution.child_conversation_id) throw new Error('Child execution active Turn crosses Conversation.');
  if (currentSubmission && currentSubmission.answer_bridge_id !== answerBridge.id) throw new Error('Child execution current answer crosses bridge.');
  return { childExecution, parentLink, ...turnSelection, activeTurnLink, activeTurn, answerBridge, currentSubmission };
}

export function readChildExecutionList(database: Database.Database, limit: number): ChildExecutionSnapshot[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('ChildExecution list limit must be from 1 to 200.');
  const children = rows(database, 'ChildExecution', 'SELECT * FROM child_execution ORDER BY created_at DESC, id DESC LIMIT ?', limit);
  return children.map(child => readChildExecutionSnapshot(database, requireRuntimeId(child.id)));
}

/** Traverse only the selected subtree; cancellation guards its live work and immutable parent edges. */
export function readChildExecutionSubtreeFacts(database: Database.Database, childExecutionIdInput: string,
  includeDescendants = true): ChildExecutionSubtreeFacts {
  const rootId = requireRuntimeId(childExecutionIdInput);
  const root = get(database, 'ChildExecution', rootId);
  const facts: ChildExecutionSubtreeFacts = { root, lineages: [], parentLinks: [], activeLinks: [], activeTurns: [],
    intentLinks: [], pendingIntentLinks: [], answerBridges: [], pendingInputs: [] };
  const queue = [root];
  const visited = new Set<string>();
  const inputs = new Map<string, DomainRow>();
  for (const child of queue) {
    const id = requireRuntimeId(child.id);
    if (visited.has(id)) throw new Error('ChildExecution parent lineage contains a cycle.');
    visited.add(id);
    facts.lineages.push(child);
    const parent = one(rows(database, 'ChildExecutionParentLink', 'SELECT * FROM child_execution_parent_link WHERE child_execution_id = ?', id), 'ParentLink', true)!;
    facts.parentLinks.push(parent);
    const active = one(rows(database, 'ChildExecutionActiveTurnLink', 'SELECT * FROM child_execution_active_turn_link WHERE child_execution_id = ?', id), 'ActiveTurnLink');
    if (active) {
      facts.activeLinks.push(active);
      const turn = get(database, 'Turn', active.turn_id);
      if (turn.conversation_id !== child.child_conversation_id) throw new Error('ChildExecution subtree active Turn crosses Conversation.');
      facts.activeTurns.push(turn);
      for (const input of rows(database, 'PendingTurnInput', 'SELECT * FROM pending_turn_input WHERE turn_id = ?', requireRuntimeId(turn.id))) {
        inputs.set(requireRuntimeId(input.id), input);
      }
    }
    const pending = rows(database, 'ChildExecutionIntentLink', `SELECT * FROM child_execution_intent_link
      WHERE child_execution_id = ? AND state = 'pending' ORDER BY intent_seq`, id);
    facts.intentLinks.push(...pending);
    facts.pendingIntentLinks.push(...pending);
    for (const intent of pending) {
      const inputId = queuedIntentPendingInputId(id, requireRuntimeId(intent.turn_intent_id));
      if (inputs.has(inputId)) continue;
      const input = prepareCached(database, 'SELECT * FROM pending_turn_input WHERE id = ?').get(inputId);
      if (input) inputs.set(inputId, DOMAIN_REPOSITORIES.domain('PendingTurnInput').codec.decode(input as DomainRow));
    }
    facts.answerBridges.push(one(rows(database, 'AnswerBridge', 'SELECT * FROM answer_bridge WHERE child_execution_id = ?', id), 'AnswerBridge', true)!);
    if (includeDescendants) for (const link of rows(database, 'ChildExecutionParentLink',
      'SELECT * FROM child_execution_parent_link WHERE parent_child_execution_id = ? ORDER BY id', id)) {
      queue.push(get(database, 'ChildExecution', link.child_execution_id));
    }
  }
  facts.pendingInputs = [...inputs.values()];
  return facts;
}

/** Intent-owned waits survive cancellation without reconstructing completed send history. */
export function readChildContinuationWaitFacts(database: Database.Database, input: ChildContinuationWaitFactsInput): ChildContinuationWaitFacts {
  const childId = requireRuntimeId(input.childExecutionId);
  const turnIntentId = input.turnIntentId === undefined ? undefined : requireRuntimeId(input.turnIntentId);
  const predicates: string[] = [];
  const parameters: string[] = [];
  const sourceTurnId = input.sourceTurnId === undefined ? undefined : requireRuntimeId(input.sourceTurnId);
  const sourceMembership = sourceTurnId === undefined ? null : one(rows(database, 'ChildExecutionTurnLink',
    'SELECT * FROM child_execution_turn_link WHERE turn_id = ?', sourceTurnId), 'answer source Turn');
  if (sourceMembership && sourceMembership.child_execution_id !== childId) {
    throw new Error('Continuation answer source Turn is not a member of its AnswerBridge ChildExecution.');
  }
  if (input.toolCallId !== undefined) { predicates.push('operation.tool_call_id = ?'); parameters.push(requireRuntimeId(input.toolCallId)); }
  if (input.status !== undefined) { predicates.push('operation.status = ?'); parameters.push(requireRuntimeId(input.status)); }
  const suffix = predicates.length ? ` AND ${predicates.join(' AND ')}` : '';
  const operations: DomainRow[] = [];
  if (turnIntentId !== undefined) {
    const relation = one(rows(database, 'ChildExecutionIntentLink',
      'SELECT * FROM child_execution_intent_link WHERE turn_intent_id = ?', turnIntentId), 'wait Intent', true)!;
    if (relation.child_execution_id !== childId) throw new Error('Continuation wait Intent crosses ChildExecution.');
    operations.push(...rows(database, 'Operation', `SELECT operation.* FROM operation
      WHERE operation.owner_kind = ? AND operation.owner_id = ?${suffix}`,
    CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, turnIntentId, ...parameters));
    operations.push(...rows(database, 'Operation', `SELECT operation.* FROM operation
      WHERE operation.owner_kind = ? AND operation.owner_id = ?${suffix}`,
    CHILD_TURN_ANSWER_WAIT_OWNER_KIND, childContinuationTurnId(childId, turnIntentId), ...parameters));
  } else if (sourceMembership) {
    // Answer delivery also needs materialized results of this exact admitted generation to avoid
    // delivering the same answer again in the background.
    operations.push(...rows(database, 'Operation', `SELECT operation.* FROM turn_intent AS intent
      JOIN child_execution_intent_link AS link ON link.turn_intent_id = intent.id
      JOIN operation ON operation.owner_kind = ? AND operation.owner_id = intent.id
      WHERE intent.turn_id = ? AND link.child_execution_id = ?${suffix}`,
    CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, sourceTurnId!, childId, ...parameters));
    operations.push(...rows(database, 'Operation', `SELECT operation.* FROM operation
      WHERE operation.owner_kind = ? AND operation.owner_id = ?${suffix}`,
    CHILD_TURN_ANSWER_WAIT_OWNER_KIND, sourceTurnId!, ...parameters));
  } else {
    // ToolCall terminalization and ToolModelResult publication share one transaction. This live
    // index therefore retains terminal Operations awaiting ordered result materialization too.
    if (sourceTurnId === undefined) {
      operations.push(...rows(database, 'Operation', `SELECT operation.*
        FROM tool_call AS call INDEXED BY ix_tool_call_02
        CROSS JOIN operation INDEXED BY ix_operation_02
        CROSS JOIN child_execution_intent_link AS link
        WHERE call.status IN ('pending', 'executing', 'waiting_approval', 'waiting_answer')
          AND operation.tool_call_id = call.id AND operation.owner_kind = ?
          AND link.turn_intent_id = operation.owner_id AND link.child_execution_id = ?
          AND NOT EXISTS (SELECT 1 FROM tool_model_result AS result WHERE result.tool_call_id = call.id)${suffix}`,
      CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, childId, ...parameters));
    }

    // Only unfinished published future-Turn owners need their original reverse identity lookup.
    // Completed old sends never drive Intent reads or deterministic-id reconstruction.
    const published = prepareCached(database, `SELECT operation.*, membership.child_execution_id AS admitted_child_id
      FROM tool_call AS call INDEXED BY ix_tool_call_02
      CROSS JOIN operation INDEXED BY ix_operation_02
      LEFT JOIN child_execution_turn_link AS membership ON membership.turn_id = operation.owner_id
      WHERE call.status IN ('pending', 'executing', 'waiting_approval', 'waiting_answer')
        AND operation.tool_call_id = call.id AND operation.owner_kind = ?
        AND NOT EXISTS (SELECT 1 FROM tool_model_result AS result WHERE result.tool_call_id = call.id)
        AND (membership.child_execution_id = ? OR membership.id IS NULL)${suffix}`)
      .all(CHILD_TURN_ANSWER_WAIT_OWNER_KIND, childId, ...parameters) as DomainRow[];
    const unadmitted = new Map<string, DomainRow>();
    for (const row of published) {
      if (sourceTurnId !== undefined && row.owner_id !== sourceTurnId) continue;
      const operation = DOMAIN_REPOSITORIES.domain('Operation').codec.decode(row);
      if (row.admitted_child_id === childId) operations.push(operation);
      else unadmitted.set(requireRuntimeId(operation.owner_id), operation);
    }
    if (unadmitted.size > 0) {
      const links = prepareCached(database, `SELECT link.turn_intent_id FROM child_execution_intent_link AS link
        JOIN turn_intent AS intent ON intent.id = link.turn_intent_id
        WHERE link.child_execution_id = ? AND link.state IN ('pending', 'cancelled') AND intent.turn_id IS NULL
        ORDER BY link.intent_seq`).iterate(childId);
      for (const row of links) {
        const turnId = childContinuationTurnId(childId, requireRuntimeId((row as DomainRow).turn_intent_id));
        const operation = unadmitted.get(turnId);
        if (!operation) continue;
        operations.push(operation);
        unadmitted.delete(turnId);
        if (unadmitted.size === 0) break;
      }
    }
  }
  const legacyOperations = sourceMembership || turnIntentId !== undefined
    ? rows(database, 'Operation', `SELECT operation.* FROM answer_bridge AS bridge
      JOIN operation ON operation.owner_kind = 'answer_bridge_wait' AND operation.owner_id = bridge.id
      WHERE bridge.child_execution_id = ?${suffix}`, childId, ...parameters)
    : rows(database, 'Operation', `SELECT operation.* FROM tool_call AS call INDEXED BY ix_tool_call_02
      CROSS JOIN operation INDEXED BY ix_operation_02 CROSS JOIN answer_bridge AS bridge
      WHERE call.status IN ('pending', 'executing', 'waiting_approval', 'waiting_answer')
        AND operation.tool_call_id = call.id AND operation.owner_kind = 'answer_bridge_wait'
        AND operation.owner_id = bridge.id AND bridge.child_execution_id = ?
        AND NOT EXISTS (SELECT 1 FROM tool_model_result AS result WHERE result.tool_call_id = call.id)${suffix}`,
    childId, ...parameters);
  // Only the precisely shipped legacy owner requires reconstruction from its retained send identities.
  const intentLinks = legacyOperations.length ? rows(database, 'ChildExecutionIntentLink',
    'SELECT * FROM child_execution_intent_link WHERE child_execution_id = ? ORDER BY intent_seq', childId) : [];
  return { operations, legacyOperations, intentLinks };
}

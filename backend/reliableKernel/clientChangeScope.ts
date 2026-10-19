import type { RuntimeChange, RuntimeChangeScope } from './contracts';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDomainSchema } from './schema/types';
import { quote } from './runtimeSqlRows';

/** Owner and relationship removals which change a bounded conversation projection. */
export const CLIENT_STRUCTURAL_REMOVAL_DOMAINS = new Set([
  'Message', 'MessageTurnLink', 'Turn', 'ModelRequest', 'ModelContextProjection',
  'ModelRequestMessageLink', 'ToolCall', 'ToolCallSourceLink', 'FileChangeSet',
  'FileChangeSetMember', 'Process', 'ProcessOriginLink', 'ChildExecution',
  'ChildExecutionParentLink', 'ChildExecutionTurnLink', 'ChildExecutionActiveTurnLink',
  'AnswerBridge', 'RuntimeDelivery', 'CollaborationMessage', 'ConversationProjectLink'
]);

const domainsByTable = new Map(DOMAIN_REPOSITORIES.all().map(repository => [repository.schema.table, repository.schema.key]));

/** SQL used only by the existing TEMP change-capture triggers, while OLD ownership still exists. */
export function clientRemovalScopeSql(schema: RuntimeDomainSchema, row: 'OLD' | 'NEW'): string {
  const columns = new Set(schema.columns.map(column => column.name));
  const field = (name: string) => `${row}.${quote(name)}`;
  const owners: string[] = [];
  const references: string[] = [];
  const addOwner = (sql: string) => owners.push(sql);
  const addReference = (domain: string, id: string) => references.push(`json_object('domain', '${domain}', 'id', ${id})`);
  for (const column of schema.columns) {
    const domain = column.references && domainsByTable.get(column.references.table);
    if (domain) addReference(domain, field(column.name));
  }
  for (const name of ['conversation_id', 'source_conversation_id', 'target_conversation_id', 'child_conversation_id']) {
    if (columns.has(name)) addOwner(`SELECT ${field(name)} AS id`);
  }
  for (const name of ['turn_id', 'source_turn_id', 'target_turn_id', 'parent_turn_id']) {
    if (columns.has(name)) addOwner(`SELECT conversation_id AS id FROM turn WHERE id = ${field(name)}`);
  }
  for (const name of ['tool_call_id', 'source_tool_call_id']) {
    if (columns.has(name)) addOwner(`SELECT turn.conversation_id AS id FROM tool_call AS call
      JOIN turn ON turn.id = call.turn_id WHERE call.id = ${field(name)}`);
  }
  if (columns.has('model_request_id')) addOwner(`SELECT turn.conversation_id AS id FROM model_request AS request
    JOIN turn ON turn.id = request.turn_id WHERE request.id = ${field('model_request_id')}`);
  if (columns.has('message_id')) addOwner(`SELECT conversation_id AS id FROM message_part_of_conversation WHERE message_id = ${field('message_id')}`);
  for (const name of ['child_execution_id', 'parent_child_execution_id']) {
    if (columns.has(name)) {
      addOwner(`SELECT child_conversation_id AS id FROM child_execution WHERE id = ${field(name)}`);
      addOwner(`SELECT turn.conversation_id AS id FROM child_execution_parent_link AS parent
        JOIN turn ON turn.id = parent.parent_turn_id WHERE parent.child_execution_id = ${field(name)}`);
    }
  }
  if (schema.key === 'Message') addOwner(`SELECT conversation_id AS id FROM message_part_of_conversation WHERE message_id = ${row}.id`);
  if (schema.key === 'ChildExecution') addOwner(`SELECT turn.conversation_id AS id FROM child_execution_parent_link AS parent
    JOIN turn ON turn.id = parent.parent_turn_id WHERE parent.child_execution_id = ${row}.id`);
  if (schema.key === 'ModelContextProjection') addOwner(`SELECT turn.conversation_id AS id FROM model_request AS request
    JOIN turn ON turn.id = request.turn_id WHERE ${row}.owner_kind = 'model_request' AND request.id = ${row}.owner_id`);
  if (schema.key === 'Process') {
    addOwner(`SELECT turn.conversation_id AS id FROM process_origin_link AS origin JOIN tool_call AS call ON call.id = origin.tool_call_id
      JOIN turn ON turn.id = call.turn_id WHERE origin.process_id = ${row}.id`);
    addOwner(`SELECT conversation_id AS id FROM process_completion_source_link WHERE process_id = ${row}.id`);
  }
  if (schema.key === 'CollaborationMessage') {
    addOwner(`SELECT conversation_id AS id FROM collaboration_message_source_link WHERE message_id = ${row}.id`);
    addOwner(`SELECT conversation_id AS id FROM collaboration_message_target_link WHERE message_id = ${row}.id`);
  }
  const conversationIds = owners.length === 0 ? "'[]'" : `(WITH RECURSIVE affected(id) AS (
    ${owners.join(' UNION ')}
    UNION SELECT turn.conversation_id FROM affected
      JOIN child_execution AS child ON child.child_conversation_id = affected.id
      JOIN child_execution_parent_link AS parent ON parent.child_execution_id = child.id
      JOIN turn ON turn.id = parent.parent_turn_id
  ) SELECT json_group_array(id) FROM affected WHERE id IS NOT NULL)`;
  return `json_object('conversationIds', json(${conversationIds}), 'references', json_array(${references.join(', ')}))`;
}

/** Merge only the small scopes already captured by this transaction, including cascaded deletes. */
export function mergeClientChangeScopes(values: readonly string[]): RuntimeChangeScope {
  const conversationIds = new Set<string>();
  const references = new Map<string, { domain: string; id: string }>();
  for (const value of values) {
    const scope = JSON.parse(value) as RuntimeChangeScope;
    for (const id of scope.conversationIds) if (id) conversationIds.add(id);
    for (const reference of scope.references) {
      if (reference.id) references.set(`${reference.domain}\0${reference.id}`, reference);
    }
  }
  return { conversationIds: [...conversationIds], references: [...references.values()] };
}

/** Shared by local commit application and cross-Host refresh selection. */
export function clientRemovalAffectsSession(change: RuntimeChange, activeConversationId: string | null | undefined,
  materialized: (domain: string, id: string) => boolean): boolean {
  return materialized(change.domain, change.id)
    || Boolean(change.scope && (activeConversationId && change.scope.conversationIds.includes(activeConversationId)
      || change.scope.references.some(reference => materialized(reference.domain, reference.id))));
}

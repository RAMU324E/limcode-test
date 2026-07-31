import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const ref = (name: string, table: string, nullable = false, onDelete: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION' = 'CASCADE') =>
  text(name, { nullable, references: { table, onDelete } });

export const CORE_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'ContentObject', table: 'content_object', repository: 'ContentObjectRepository', codec: 'ContentObjectRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['content_type,sha256,byte_length UNIQUE'],
    columns: [id(), text('content_type'), text('sha256'), integer('byte_length'), text('storage_key'), text('created_at')]
  }),
  domain({
    key: 'Conversation', table: 'conversation', repository: 'ConversationRepository', codec: 'ConversationRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'summary', deletePolicy: 'cascade-runtime-children',
    indexes: ['updated_at,id'],
    columns: [id(), text('title'), text('status'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ConversationReuseLink', table: 'conversation_reuse_link', repository: 'ConversationReuseLinkRepository', codec: 'ConversationReuseLinkRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['reuse_key UNIQUE', 'conversation_id', 'agent_id'],
    columns: [id(), text('reuse_key'), ref('conversation_id', 'conversation'), text('agent_id'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ConversationBranchLink', table: 'conversation_branch_link', repository: 'ConversationBranchLinkRepository', codec: 'ConversationBranchLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-target-conversation',
    indexes: ['target_conversation_id UNIQUE', 'source_conversation_id,created_at'],
    columns: [id(), ref('target_conversation_id', 'conversation'), text('source_conversation_id'), text('source_message_revision_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'ConversationOriginLink', table: 'conversation_origin_link', repository: 'ConversationOriginLinkRepository', codec: 'ConversationOriginLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id UNIQUE', 'source_conversation_id', 'source_turn_id', 'source_tool_call_id'],
    columns: [id(), ref('conversation_id', 'conversation'), text('source_conversation_id', { nullable: true }), text('source_turn_id', { nullable: true }), text('source_tool_call_id', { nullable: true }), text('source_message_revision_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'AgentConversationLink', table: 'agent_conversation_link', repository: 'AgentConversationLinkRepository', codec: 'AgentConversationLinkRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id,role UNIQUE', 'agent_id'],
    columns: [id(), ref('conversation_id', 'conversation'), text('agent_id'), text('role'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'Turn', table: 'turn', repository: 'TurnRepository', codec: 'TurnRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-conversation',
    indexes: ['conversation_id,created_at,id', 'status'],
    columns: [id(), ref('conversation_id', 'conversation'), text('status'), text('created_at'), text('updated_at'), text('terminal_at', { nullable: true })]
  }),
  domain({
    key: 'TurnIntent', table: 'turn_intent', repository: 'TurnIntentRepository', codec: 'TurnIntentRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('turn_id', 'turn', true, 'SET NULL'), text('state'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'TurnIntentRevision', table: 'turn_intent_revision', repository: 'TurnIntentRevisionRepository', codec: 'TurnIntentRevisionRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-intent',
    indexes: ['intent_id,revision_seq UNIQUE'],
    columns: [id(), ref('intent_id', 'turn_intent'), integer('revision_seq'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'TurnExecutionPresetRevision', table: 'turn_execution_preset_revision', repository: 'TurnExecutionPresetRevisionRepository', codec: 'TurnExecutionPresetRevisionRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-intent',
    indexes: ['intent_id,revision_seq UNIQUE'],
    columns: [id(), ref('intent_id', 'turn_intent'), integer('revision_seq'), ref('preset_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'PendingTurnInput', table: 'pending_turn_input', repository: 'PendingTurnInputRepository', codec: 'PendingTurnInputRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'none', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id,position UNIQUE'],
    columns: [id(), ref('turn_id', 'turn'), integer('position'), text('input_kind'), ref('content_object_id', 'content_object'), text('state'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ExecutionLease', table: 'execution_lease', repository: 'ExecutionLeaseRepository', codec: 'ExecutionLeaseRowCodec',
    mutations: ['insert', 'update', 'delete'], client: 'summary', deletePolicy: 'release-on-terminal',
    indexes: ['conversation_id UNIQUE', 'turn_id UNIQUE'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('turn_id', 'turn'), text('owner_id'), text('host_boot_id'), text('acquired_at'), text('expires_at')]
  }),
  domain({
    key: 'AuthoritySnapshot', table: 'authority_snapshot', repository: 'AuthoritySnapshotRepository', codec: 'AuthoritySnapshotRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id,created_at'],
    columns: [id(), ref('turn_id', 'turn'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'TurnTermination', table: 'turn_termination', repository: 'TurnTerminationRepository', codec: 'TurnTerminationRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id UNIQUE'],
    columns: [id(), ref('turn_id', 'turn'), text('terminal_status'), text('reason'), text('created_at')]
  }),
  domain({
    key: 'TurnExecutorLink', table: 'turn_executor_link', repository: 'TurnExecutorLinkRepository', codec: 'TurnExecutorLinkRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id UNIQUE', 'agent_id'],
    columns: [id(), ref('turn_id', 'turn'), text('agent_id'), text('created_at')]
  }),
  domain({
    key: 'CommandReceipt', table: 'command_receipt', repository: 'CommandReceiptRepository', codec: 'CommandReceiptRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'dataset-reset-only',
    indexes: ['source_kind,source_key UNIQUE', 'conversation_id,created_at'],
    columns: [id(), text('source_kind'), text('source_key'), text('conversation_id', { nullable: true }), text('turn_id', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'Message', table: 'message', repository: 'MessageRepository', codec: 'MessageRowCodec',
    mutations: ['insert', 'update'], client: 'window', deletePolicy: 'soft-delete',
    indexes: ['created_at,id'],
    columns: [id(), text('created_at'), text('updated_at'), text('deleted_at', { nullable: true })]
  }),
  domain({
    key: 'MessageRevision', table: 'message_revision', repository: 'MessageRevisionRepository', codec: 'MessageRevisionRowCodec',
    mutations: ['insert'], client: 'window', deletePolicy: 'cascade-with-message',
    indexes: ['message_id,revision_seq UNIQUE'],
    columns: [id(), ref('message_id', 'message'), integer('revision_seq'), text('role'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'MessageCurrentRevisionLink', table: 'message_current_revision_link', repository: 'MessageCurrentRevisionLinkRepository', codec: 'MessageCurrentRevisionLinkRowCodec',
    mutations: ['insert', 'update'], client: 'none', deletePolicy: 'cascade-with-message',
    indexes: ['message_id UNIQUE', 'revision_id UNIQUE'],
    columns: [id(), ref('message_id', 'message'), ref('revision_id', 'message_revision'), text('updated_at')]
  }),
  domain({
    key: 'MessagePartOfConversation', table: 'message_part_of_conversation', repository: 'MessagePartOfConversationRepository', codec: 'MessagePartOfConversationRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-message',
    indexes: ['conversation_id,message_seq UNIQUE', 'message_id UNIQUE'],
    columns: [id(), ref('conversation_id', 'conversation'), ref('message_id', 'message'), integer('message_seq'), text('created_at')]
  }),
  domain({
    key: 'MessageTurnLink', table: 'message_turn_link', repository: 'MessageTurnLinkRepository', codec: 'MessageTurnLinkRowCodec',
    mutations: ['insert', 'delete'], client: 'none', deletePolicy: 'cascade-with-message',
    indexes: ['turn_id,message_id,role UNIQUE', 'message_id'],
    columns: [id(), ref('turn_id', 'turn'), ref('message_id', 'message'), text('role'), text('created_at')]
  }),
  domain({
    key: 'Attachment', table: 'attachment', repository: 'AttachmentRepository', codec: 'AttachmentRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['id UNIQUE', 'sha256'],
    columns: [id(), text('sha256'), integer('byte_length'), text('mime_type'), text('name'), text('storage_mode'), ref('content_object_id', 'content_object', true, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'AttachmentLink', table: 'attachment_link', repository: 'AttachmentLinkRepository', codec: 'AttachmentLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-message',
    indexes: ['message_revision_id,attachment_id,position UNIQUE'],
    columns: [id(), ref('message_revision_id', 'message_revision'), ref('attachment_id', 'attachment', false, 'RESTRICT'), integer('position'), text('created_at')]
  })
];

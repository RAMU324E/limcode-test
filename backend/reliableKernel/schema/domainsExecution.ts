import { domain, integer, text, type RuntimeDomainSchema } from './types';

const id = () => text('id');
const ref = (name: string, table: string, nullable = false, onDelete: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION' = 'CASCADE') =>
  text(name, { nullable, references: { table, onDelete } });

export const EXECUTION_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = [
  domain({
    key: 'InteractionRequest', table: 'interaction_request', repository: 'InteractionRequestRepository', codec: 'InteractionRequestRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-turn',
    indexes: ['status,created_at'],
    columns: [id(), text('request_kind'), text('status'), ref('prompt_object_id', 'content_object'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'InteractionOwnerLink', table: 'interaction_owner_link', repository: 'InteractionOwnerLinkRepository', codec: 'InteractionOwnerLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-request',
    indexes: ['request_id UNIQUE', 'turn_id'],
    columns: [id(), ref('request_id', 'interaction_request'), ref('turn_id', 'turn'), text('created_at')]
  }),
  domain({
    key: 'InteractionResponse', table: 'interaction_response', repository: 'InteractionResponseRepository', codec: 'InteractionResponseRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-request',
    indexes: ['request_id UNIQUE'],
    columns: [id(), ref('request_id', 'interaction_request'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'ToolCall', table: 'tool_call', repository: 'ToolCallRepository', codec: 'ToolCallRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-turn',
    indexes: ['turn_id,call_seq UNIQUE', 'status'],
    columns: [id(), ref('turn_id', 'turn'), integer('call_seq'), text('tool_name'), text('status'), ref('arguments_object_id', 'content_object'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'ToolCallEvent', table: 'tool_call_event', repository: 'ToolCallEventRepository', codec: 'ToolCallEventRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id,event_seq UNIQUE'],
    columns: [id(), ref('tool_call_id', 'tool_call'), integer('event_seq'), text('event_kind'), ref('content_object_id', 'content_object', true, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'ToolExecution', table: 'tool_execution', repository: 'ToolExecutionRepository', codec: 'ToolExecutionRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id UNIQUE', 'status'],
    columns: [id(), ref('tool_call_id', 'tool_call'), text('status'), text('wait_deadline_at', { nullable: true }), text('started_at'), text('updated_at'), text('completed_at', { nullable: true })]
  }),
  domain({
    key: 'Operation', table: 'operation', repository: 'OperationRepository', codec: 'OperationRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-owner',
    indexes: ['owner_kind,owner_id,operation_seq UNIQUE', 'tool_call_id', 'status'],
    columns: [id(), text('owner_kind'), text('owner_id'), integer('operation_seq'), ref('tool_call_id', 'tool_call', true, 'SET NULL'), text('status'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'Attempt', table: 'attempt', repository: 'AttemptRepository', codec: 'AttemptRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-operation',
    indexes: ['operation_id,attempt_seq UNIQUE', 'status'],
    columns: [id(), ref('operation_id', 'operation'), integer('attempt_seq'), text('status'), text('created_at'), text('updated_at'), text('completed_at', { nullable: true })]
  }),
  domain({
    key: 'OutcomePause', table: 'outcome_pause', repository: 'OutcomePauseRepository', codec: 'OutcomePauseRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-operation',
    indexes: ['operation_id'],
    columns: [id(), ref('operation_id', 'operation'), text('status'), text('reason'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'OperationResolution', table: 'operation_resolution', repository: 'OperationResolutionRepository', codec: 'OperationResolutionRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-pause',
    indexes: ['pause_id UNIQUE'],
    columns: [id(), ref('pause_id', 'outcome_pause'), text('resolution_kind'), ref('content_object_id', 'content_object', true, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'EffectIntent', table: 'effect_intent', repository: 'EffectIntentRepository', codec: 'EffectIntentRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['attempt_id UNIQUE', 'dispatch_state'],
    columns: [id(), text('attempt_id'), text('effect_kind'), text('dispatch_state'), ref('request_object_id', 'content_object'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'EffectReceipt', table: 'effect_receipt', repository: 'EffectReceiptRepository', codec: 'EffectReceiptRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['attempt_id UNIQUE', 'effect_kind,received_at'],
    columns: [id(), text('attempt_id'), text('effect_kind'), text('outcome'), ref('response_object_id', 'content_object', true, 'RESTRICT'), text('conversation_id', { nullable: true }), text('tool_call_id', { nullable: true }), text('operation_id', { nullable: true }), text('received_at')]
  }),
  domain({
    key: 'ToolOutcome', table: 'tool_outcome', repository: 'ToolOutcomeRepository', codec: 'ToolOutcomeRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id UNIQUE'],
    columns: [id(), ref('tool_call_id', 'tool_call'), text('status'), ref('content_object_id', 'content_object', true, 'RESTRICT'), text('created_at')]
  }),
  domain({
    key: 'ToolModelResult', table: 'tool_model_result', repository: 'ToolModelResultRepository', codec: 'ToolModelResultRowCodec',
    mutations: ['insert'], client: 'window', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id UNIQUE', 'message_revision_id UNIQUE'],
    columns: [id(), ref('tool_call_id', 'tool_call'), ref('message_revision_id', 'message_revision'), text('created_at')]
  }),
  domain({
    key: 'ToolResultArtifact', table: 'tool_result_artifact', repository: 'ToolResultArtifactRepository', codec: 'ToolResultArtifactRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id,role UNIQUE'],
    columns: [id(), ref('tool_call_id', 'tool_call'), text('role'), ref('content_object_id', 'content_object'), text('created_at')]
  }),
  domain({
    key: 'FileChangeSet', table: 'file_change_set', repository: 'FileChangeSetRepository', codec: 'FileChangeSetRowCodec',
    mutations: ['insert', 'update'], client: 'detail', deletePolicy: 'cascade-with-tool-call',
    indexes: ['tool_call_id UNIQUE', 'status'],
    columns: [id(), ref('tool_call_id', 'tool_call'), text('status'), text('created_at'), text('updated_at')]
  }),
  domain({
    key: 'FileChangeSetMember', table: 'file_change_set_member', repository: 'FileChangeSetMemberRepository', codec: 'FileChangeSetMemberRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-change-set',
    indexes: ['change_set_id,member_seq UNIQUE', 'change_set_id,target_path'],
    columns: [
      id(),
      ref('change_set_id', 'file_change_set'),
      integer('member_seq'),
      text('operation'),
      text('work_environment_id'),
      text('target_path'),
      text('base_digest', { nullable: true }),
      ref('target_content_object_id', 'content_object', true, 'RESTRICT'),
      text('target_digest', { nullable: true }),
      text('created_at')
    ]
  }),
  domain({
    key: 'FileChangeDecision', table: 'file_change_decision', repository: 'FileChangeDecisionRepository', codec: 'FileChangeDecisionRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'cascade-with-change-set',
    indexes: ['change_set_id UNIQUE'],
    columns: [id(), ref('change_set_id', 'file_change_set'), text('decision'), text('decided_at')]
  }),
  domain({
    key: 'FileMutationReceipt', table: 'file_mutation_receipt', repository: 'FileMutationReceiptRepository', codec: 'FileMutationReceiptRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'dataset-reset-only',
    indexes: ['effect_receipt_id UNIQUE', 'change_set_id UNIQUE'],
    columns: [id(), text('effect_receipt_id'), text('change_set_id'), text('outcome'), text('created_at')]
  }),
  domain({
    key: 'FileMutationReceiptMember', table: 'file_mutation_receipt_member', repository: 'FileMutationReceiptMemberRepository', codec: 'FileMutationReceiptMemberRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-receipt',
    indexes: ['receipt_id,member_id UNIQUE'],
    columns: [id(), ref('receipt_id', 'file_mutation_receipt'), text('member_id'), text('outcome'), text('actual_digest', { nullable: true }), text('created_at')]
  }),
  domain({
    key: 'Process', table: 'process', repository: 'ProcessRepository', codec: 'ProcessRowCodec',
    mutations: ['insert', 'update'], client: 'summary', deletePolicy: 'dataset-reset-only',
    indexes: ['status,started_at'],
    columns: [id(), text('status'), text('wrapper_nonce'), integer('wrapper_pid'), integer('child_pid', { nullable: true }), integer('process_group_id', { nullable: true }), text('start_fingerprint'), text('command_digest'), text('spool_locator'), integer('retained_bytes', { defaultSql: '0' }), integer('retained_chunks', { defaultSql: '0' }), integer('dropped_bytes', { defaultSql: '0' }), integer('truncated', { defaultSql: '0' }), text('started_at'), text('updated_at'), text('completed_at', { nullable: true })]
  }),
  domain({
    key: 'ProcessOriginLink', table: 'process_origin_link', repository: 'ProcessOriginLinkRepository', codec: 'ProcessOriginLinkRowCodec',
    mutations: ['insert'], client: 'none', deletePolicy: 'cascade-with-process',
    indexes: ['process_id UNIQUE', 'tool_call_id'],
    columns: [id(), ref('process_id', 'process'), text('tool_call_id'), text('created_at')]
  }),
  domain({
    key: 'ProcessOutputChunk', table: 'process_output_chunk', repository: 'ProcessOutputChunkRepository', codec: 'ProcessOutputChunkRowCodec',
    mutations: ['insert'], client: 'detail', deletePolicy: 'cascade-with-process',
    indexes: ['process_id,chunk_seq UNIQUE'],
    columns: [id(), ref('process_id', 'process'), integer('chunk_seq'), text('stream_kind'), ref('content_object_id', 'content_object'), integer('byte_length'), text('created_at')]
  }),
  domain({
    key: 'ProcessReceipt', table: 'process_receipt', repository: 'ProcessReceiptRepository', codec: 'ProcessReceiptRowCodec',
    mutations: ['insert'], client: 'summary', deletePolicy: 'dataset-reset-only',
    indexes: ['process_id UNIQUE'],
    columns: [id(), text('process_id'), text('outcome'), integer('exit_code', { nullable: true }), text('exit_signal', { nullable: true }), text('wrapper_nonce'), text('start_fingerprint'), text('received_at')]
  })
];

import type { RuntimeDomainSchema } from './types';
import {
  EPOCH_5_RUNTIME_DOMAIN_SCHEMAS, EPOCH_5_RUNTIME_METADATA_SQL, EPOCH_5_RUNTIME_SCHEMA_TRIGGERS
} from './publishedEpoch5';

/** Exact v0.0.42 / epoch-6 storage description, published 2026-10-17. Independent of current domains. */
const epoch6AddedDomains: readonly RuntimeDomainSchema[] = [
  {
    "key": "ConversationContextHandleState",
    "table": "conversation_context_handle_state",
    "repository": "ConversationContextHandleStateRepository",
    "codec": "ConversationContextHandleStateRowCodec",
    "mutations": [
      "insert",
      "update"
    ],
    "client": "none",
    "deletePolicy": "cascade-with-conversation",
    "indexes": [
      "conversation_id UNIQUE",
      "state"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "conversation_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "conversation",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "context_root_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "context_sequence_root",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "state",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "revision",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "provenance_revision",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "content_object_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "content_object",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "requires_native_reset",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "created_at",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "updated_at",
        "type": "TEXT",
        "nullable": false
      }
    ],
    "schemaOwner": "ConversationContextHandleState",
    "resetPolicy": "runtime-dataset"
  },
  {
    "key": "ContextRootHandleCatalog",
    "table": "context_root_handle_catalog",
    "repository": "ContextRootHandleCatalogRepository",
    "codec": "ContextRootHandleCatalogRowCodec",
    "mutations": [
      "insert"
    ],
    "client": "none",
    "deletePolicy": "cascade-with-conversation",
    "indexes": [
      "conversation_id,context_root_id,provenance_revision UNIQUE",
      "conversation_id,provenance_revision,root_node_id,tail_node_id,tail_segment_count,segment_count",
      "context_root_id"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "conversation_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "conversation",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "context_root_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "context_sequence_root",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "provenance_revision",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "root_node_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "context_sequence_node",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "tail_node_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "context_sequence_node",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "tail_segment_count",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "segment_count",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "content_object_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "content_object",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "created_at",
        "type": "TEXT",
        "nullable": false
      }
    ],
    "schemaOwner": "ContextRootHandleCatalog",
    "resetPolicy": "runtime-dataset"
  },
  {
    "key": "RuntimeDeliveryTimelineLink",
    "table": "runtime_delivery_timeline_link",
    "repository": "RuntimeDeliveryTimelineLinkRepository",
    "codec": "RuntimeDeliveryTimelineLinkRowCodec",
    "mutations": [
      "insert"
    ],
    "client": "summary",
    "deletePolicy": "cascade-with-conversation",
    "indexes": [
      "delivery_id UNIQUE",
      "pending_turn_input_id UNIQUE",
      "conversation_id,inbox_item_id,exchange_seq",
      "conversation_id,exchange_seq UNIQUE",
      "conversation_id,predecessor_message_seq,exchange_seq"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "conversation_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "conversation",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "delivery_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "runtime_delivery",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "inbox_item_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "runtime_inbox_item",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "acceptance_kind",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "pending_turn_input_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "context_root_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "context_sequence_root",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "context_node_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "context_sequence_node",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "predecessor_message_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "predecessor_message_seq",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "exchange_seq",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "position_basis",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "created_at",
        "type": "TEXT",
        "nullable": false
      }
    ],
    "schemaOwner": "RuntimeDeliveryTimelineLink",
    "resetPolicy": "runtime-dataset"
  },
  {
    "key": "CollaborationSendTimelineLink",
    "table": "collaboration_send_timeline_link",
    "repository": "CollaborationSendTimelineLinkRepository",
    "codec": "CollaborationSendTimelineLinkRowCodec",
    "mutations": [
      "insert"
    ],
    "client": "summary",
    "deletePolicy": "cascade-with-conversation",
    "indexes": [
      "message_id UNIQUE",
      "conversation_id,exchange_seq UNIQUE",
      "conversation_id,predecessor_message_seq,exchange_seq"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "conversation_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "conversation",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "message_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "collaboration_message",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "predecessor_message_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "predecessor_message_seq",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "exchange_seq",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "position_basis",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "created_at",
        "type": "TEXT",
        "nullable": false
      }
    ],
    "schemaOwner": "CollaborationSendTimelineLink",
    "resetPolicy": "runtime-dataset"
  },
  {
    "key": "TimelineImportProvenance",
    "table": "timeline_import_provenance",
    "repository": "TimelineImportProvenanceRepository",
    "codec": "TimelineImportProvenanceRowCodec",
    "mutations": [
      "insert"
    ],
    "client": "none",
    "deletePolicy": "cascade-with-timeline-link",
    "indexes": [
      "receive_timeline_link_id",
      "send_timeline_link_id"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "receive_timeline_link_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "runtime_delivery_timeline_link",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "send_timeline_link_id",
        "type": "TEXT",
        "nullable": true,
        "references": {
          "table": "collaboration_send_timeline_link",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "source_data_set_id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "source_root_instance_id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "source_exchange_seq",
        "type": "INTEGER",
        "nullable": false
      }
    ],
    "schemaOwner": "TimelineImportProvenance",
    "resetPolicy": "runtime-dataset"
  },
  {
    "key": "RuntimeDeliveryAnswerPresentation",
    "table": "runtime_delivery_answer_presentation",
    "repository": "RuntimeDeliveryAnswerPresentationRepository",
    "codec": "RuntimeDeliveryAnswerPresentationRowCodec",
    "mutations": [
      "insert"
    ],
    "client": "summary",
    "deletePolicy": "cascade-with-conversation",
    "indexes": [
      "delivery_id UNIQUE",
      "conversation_id,inbox_item_id,attempt_seq"
    ],
    "columns": [
      {
        "name": "id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "conversation_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "conversation",
          "onDelete": "CASCADE"
        }
      },
      {
        "name": "delivery_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "runtime_delivery",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "inbox_item_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "runtime_inbox_item",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "attempt_seq",
        "type": "INTEGER",
        "nullable": false
      },
      {
        "name": "submission_id",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "child_execution_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "child_conversation_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "answer_bridge_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "source_turn_id",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "outcome",
        "type": "TEXT",
        "nullable": false
      },
      {
        "name": "peer_title_preview",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "answer_title_preview",
        "type": "TEXT",
        "nullable": true
      },
      {
        "name": "body_content_object_id",
        "type": "TEXT",
        "nullable": false,
        "references": {
          "table": "content_object",
          "onDelete": "RESTRICT"
        }
      },
      {
        "name": "body_representation",
        "type": "TEXT",
        "nullable": false
      }
    ],
    "schemaOwner": "RuntimeDeliveryAnswerPresentation",
    "resetPolicy": "runtime-dataset"
  }
];

export const EPOCH_6_RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze([
  ...EPOCH_5_RUNTIME_DOMAIN_SCHEMAS.map(schema => schema.key === 'RuntimeDelivery'
    ? Object.freeze({ ...schema, indexes: Object.freeze([...schema.indexes,
      'target_conversation_id,state,created_at,id', 'target_conversation_id,created_at,id']) })
    : schema),
  ...epoch6AddedDomains.map(schema => Object.freeze({ ...schema,
    mutations: Object.freeze([...schema.mutations]), indexes: Object.freeze([...schema.indexes]),
    columns: Object.freeze(schema.columns.map(column => Object.freeze({ ...column,
      ...(column.references ? { references: Object.freeze({ ...column.references }) } : {}) }))) }))
]);
export const EPOCH_6_RUNTIME_METADATA_SQL = EPOCH_5_RUNTIME_METADATA_SQL;
export const EPOCH_6_RUNTIME_SCHEMA_TRIGGERS = EPOCH_5_RUNTIME_SCHEMA_TRIGGERS;

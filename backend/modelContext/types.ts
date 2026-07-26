import type {
  AgentRunSourceLinkRecord,
  CompressionBlockRecord,
  CompressionContextVariantRecord,
  LlmInvocationSettingsSnapshotRecord,
  MessageContent,
  MessageCurrentRevisionLinkRecord,
  MessageRecord,
  MessageRevisionRecord,
  RunCompressionBlockLinkRecord,
  RunContextPolicyRecord,
  RunRuntimeContextSnapshotLinkRecord,
  RunTerminationRecord,
  RuntimeContextSnapshotRecord,
  ToolCallRecord,
  ToolCallResultLinkRecord
} from '../../shared/protocol';
import type { MessageTurnLinkRecord } from '../../shared/conversationReliability';
import type { DurableToolResultArtifactRecord } from '../reliability/toolResultTypes';
import type { RunExecutionPhase, RunLifecycleStatus } from '../../shared/runLifecycle';

export interface ModelContextRunFact {
  id: string;
  conversationId: string;
  lifecycle?: RunLifecycleStatus;
  phase?: RunExecutionPhase;
  createdAt: number;
  updatedAt: number;
}

export interface ModelContextInputRevisionFact {
  id: string;
  runId: string;
  conversationId: string;
  messageId: string;
  revisionId: string;
}

export interface ModelContextFactView {
  messages: readonly MessageRecord[];
  messageRevisions: readonly MessageRevisionRecord[];
  messageCurrentRevisionLinks: readonly MessageCurrentRevisionLinkRecord[];
  runs: readonly ModelContextRunFact[];
  runSources: readonly AgentRunSourceLinkRecord[];
  messageTurnLinks: readonly MessageTurnLinkRecord[];
  inputRevisions: readonly ModelContextInputRevisionFact[];
  runTerminations: readonly RunTerminationRecord[];
  toolCalls: readonly ToolCallRecord[];
  toolResultArtifacts: readonly DurableToolResultArtifactRecord[];
  toolCallResultLinks: readonly ToolCallResultLinkRecord[];
  compressionBlocks: readonly CompressionBlockRecord[];
  compressionContextVariants: readonly CompressionContextVariantRecord[];
  runCompressionBlockLinks: readonly RunCompressionBlockLinkRecord[];
  runtimeContextSnapshots: readonly RuntimeContextSnapshotRecord[];
  runRuntimeContextSnapshotLinks: readonly RunRuntimeContextSnapshotLinkRecord[];
}

export interface ModelTurnRef {
  conversationId: string;
  runId: string;
  modelMessageId: string;
  requestId?: string;
  invocationId?: string;
}

export type ModelContextPurpose =
  | {
      kind: 'turn';
      mode: 'fresh' | 'same_run_resume' | 'dry_run';
      turn: ModelTurnRef;
      policy: RunContextPolicyRecord;
      settingsSnapshot?: LlmInvocationSettingsSnapshotRecord;
    }
  | {
      kind: 'compression';
      mode: 'auto' | 'manual' | 'dry_run';
      conversationId: string;
      sourceTurn?: ModelTurnRef;
      /** Auto post-response compression includes the completed source turn itself; preflight keeps excluding its pending model message. */
      includeSourceTurnMessage?: boolean;
      startMessageId?: string;
      endMessageId?: string;
      preserveLatestMessages?: number;
      methodKind: CompressionBlockRecord['methodKind'];
    };

export type ModelContextSourceRef =
  | { kind: 'messageRevision'; id: string; sourceConversationId: string; messageId: string; revisionId: string; seq: number; fingerprint: string }
  | { kind: 'compressionVariant'; id: string; sourceConversationId: string; blockId: string; variantId: string; fingerprint: string }
  | { kind: 'runTermination'; id: string; sourceConversationId: string; runId: string; terminationId: string; fingerprint: string }
  | { kind: 'toolCall'; id: string; sourceConversationId: string; toolCallId: string; messageId: string; fingerprint: string }
  | { kind: 'runtimeContextSnapshot'; id: string; sourceConversationId: string; snapshotId: string; runId: string; fingerprint: string };

export interface ModelContextMessageSelection {
  messageId: string;
  revisionId: string;
  conversationId: string;
  runIds: readonly string[];
  seq: number;
  role: MessageRecord['role'];
  origin: 'target_history' | 'run_scoped' | 'source_history' | 'compression_source';
  materialization: 'verbatim' | 'tool_facts_only';
  content: MessageContent;
}

export type ModelContextIrItem =
  | {
      kind: 'message';
      selection: ModelContextMessageSelection;
    }
  | {
      kind: 'compression_variant';
      blockId: string;
      variantId: string;
      mode: 'provider_native' | 'summary_fallback';
      contents: readonly MessageContent[];
    }
  | {
      /** Structured control-plane boundary consumed by the normalizer; never serialized as prompt text. */
      kind: 'interruption_boundary';
      runId: string;
      termination: RunTerminationRecord;
    }
  | {
      kind: 'runtime_snapshot';
      runId: string;
      snapshotId: string;
      content: MessageContent;
    }
  | {
      kind: 'synthetic_transcript';
      label: 'context_summary' | 'source_conversation' | 'source_tool';
      sourceIds: readonly string[];
      content: MessageContent;
    };

export interface ModelContextDiagnostic {
  code:
    | 'missing_turn'
    | 'missing_revision_link'
    | 'missing_revision'
    | 'ambiguous_revision_link'
    | 'streaming_message_excluded'
    | 'unattributed_partial_excluded'
    | 'foreign_active_run_input_excluded'
    | 'internal_message_target_mismatch'
    | 'internal_message_excluded'
    | 'terminated_run_without_tool_facts_excluded'
    | 'source_boundary_missing'
    | 'compression_variant_incompatible'
    | 'orphan_run_termination'
    | 'unresolved_tool_call'
    | 'orphan_tool_response'
    | 'ambiguous_tool_pair';
  severity: 'info' | 'warning' | 'error';
  message: string;
  sourceId?: string;
}

export interface ModelContextProjection {
  purpose: ModelContextPurpose;
  items: readonly ModelContextIrItem[];
  contents: MessageContent[];
  messageSelections: readonly ModelContextMessageSelection[];
  orderedSources: readonly ModelContextSourceRef[];
  diagnostics: readonly ModelContextDiagnostic[];
  fingerprint: string;
  tokenCount: number;
  boundary: {
    modelMessageId?: string;
    modelSeq?: number;
    compressionBoundarySeq?: number;
  };
  compression?: {
    segments: MessageContent[][];
    selectedMessageIds: string[];
    anchorMessageId?: string;
    anchorSeq?: number;
    priorBlockId?: string;
    priorVariantId?: string;
    priorSummaryContents?: MessageContent[];
    /** Frozen deterministic content appended to the compression result after provider execution. */
    resultAddenda: MessageContent[];
  };
}

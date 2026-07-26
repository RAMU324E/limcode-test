export const STORAGE_VERSION = 1;
/**
 * 整个 data root 的开发期兼容边界。它与单个 index 文件的 schemaVersion 分离：
 * data epoch 不匹配时整根目录拒绝加载，不做旧数据兜底或隐式迁移。
 */
/**
 * The current data format keeps RunTermination as structured projection provenance, never as
 * model-visible marker text, and separates provider compression output from frozen result addenda.
 * Earlier data roots may contain incompatible CompressionVariant contents and are archived/reset as
 * one development-format cutover; no schema migration, dual writer, or legacy import exists.
 */
export const DATA_FORMAT_EPOCH = 8;
export const DATA_ROOT_MARKER_FILE = '.limcode-data-root.json';
export const DATA_ROOT_RESET_PENDING_FILE = '.limcode-data-reset-pending.json';
export const DATA_ROOT_BACKUPS_DIR = '.limcode-data-backups';
export const INDEX_FILE = 'index.json';
export const RECORDS_DIR = 'records';

export const AGENTS_ROOT_DIR = 'agents';
export const WORKFLOWS_ROOT_DIR = 'workflows';
export const PLAN_REVIEW_POLICIES_ROOT_DIR = 'plan-review-policies';
export const PLAN_REVIEW_POLICY_SCOPE_LINKS_ROOT_DIR = 'plan-review-policy-scope-links';
export const TOOL_POLICIES_ROOT_DIR = 'tool-policies';
export const TOOL_POLICY_SCOPE_LINKS_ROOT_DIR = 'tool-policy-scope-links';
export const SKILL_POLICIES_ROOT_DIR = 'skill-policies';
export const SKILL_POLICY_SCOPE_LINKS_ROOT_DIR = 'skill-policy-scope-links';
export const SYSTEM_PROMPTS_ROOT_DIR = 'system-prompts';
export const MODEL_PROFILES_ROOT_DIR = 'model-profiles';
export const AGENT_CONVERSATION_LINKS_ROOT_DIR = 'agent-conversation-links';
export const SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR = 'system-prompt-scope-links';
export const RUNTIME_CONTEXTS_ROOT_DIR = 'runtime-contexts';
export const RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR = 'runtime-context-scope-links';
export const RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR = 'runtime-context-snapshots';
export const CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR = 'conversation-runtime-context-snapshot-links';
export const RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR = 'run-runtime-context-snapshot-links';
export const MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR = 'model-profile-scope-links';
export const CONVERSATION_WORKFLOW_SELECTIONS_ROOT_DIR = 'conversation-workflow-selections';
export const CONVERSATION_AGENT_SELECTIONS_ROOT_DIR = 'conversation-agent-selections';
export const CONVERSATIONS_ROOT_DIR = 'conversations';
export const CONVERSATION_HISTORY_ROOT_DIR = 'conversation-history';
export const ATTACHMENTS_ROOT_DIR = 'attachments';
export const PROJECT_CONTEXTS_ROOT_DIR = 'project-contexts';
export const CONVERSATION_PROJECT_LINKS_ROOT_DIR = 'conversation-project-links';
export const AGENT_ANSWERS_ROOT_DIR = 'agent-answers';
export const AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR = 'agent-answer-submission-links';
export const AGENT_ANSWER_TARGET_LINKS_ROOT_DIR = 'agent-answer-target-links';
export const SETTINGS_ROOT_DIR = 'settings';
export const BACKGROUND_PROCESSES_ROOT_DIR = 'background-processes';
export const BACKGROUND_PROCESS_ORIGIN_LINKS_ROOT_DIR = 'background-process-origin-links';
export const BACKGROUND_PROCESS_EXIT_RECEIPTS_ROOT_DIR = 'background-process-exit-receipts';
export const BACKGROUND_PROCESS_NOTIFICATION_DELIVERIES_ROOT_DIR = 'background-process-notification-deliveries';
/** 可靠事务 WAL、HEAD、receipt、writer owner 等控制面数据。 */
export const OPERATIONS_ROOT_DIR = 'operations';
export const WORK_ENVIRONMENTS_ROOT_DIR = 'work-environments';
export const CONVERSATION_WORK_ENVIRONMENT_LINKS_ROOT_DIR = 'conversation-work-environment-links';
export const RUN_WORK_ENVIRONMENT_LINKS_ROOT_DIR = 'run-work-environment-links';
export const WORK_ENVIRONMENT_POLICIES_ROOT_DIR = 'work-environment-policies';
export const WORK_ENVIRONMENT_POLICY_SCOPE_LINKS_ROOT_DIR = 'work-environment-policy-scope-links';
export const CHECKPOINT_POLICIES_ROOT_DIR = 'checkpoint-policies';
export const CHECKPOINT_POLICY_SCOPE_LINKS_ROOT_DIR = 'checkpoint-policy-scope-links';
export const SHADOW_REPOSITORIES_ROOT_DIR = 'shadow-repositories';
export const CONVERSATION_CHECKPOINT_REPOSITORY_LINKS_ROOT_DIR = 'conversation-checkpoint-repository-links';
export const CHECKPOINTS_ROOT_DIR = 'checkpoints';
export const CHECKPOINT_TIMELINE_ANCHORS_ROOT_DIR = 'checkpoint-timeline-anchors';
export const CHECKPOINT_SHADOW_WORKTREES_ROOT_DIR = 'checkpoint-shadow-worktrees';
export const COMPRESSION_BLOCKS_ROOT_DIR = 'compression-blocks';
export const COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR = 'compression-block-source-links';
export const COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR = 'compression-context-variants';
export const COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR = 'compression-block-llm-invocation-links';
export const TOOL_CALLS_ROOT_DIR = 'tool-calls';
export const TOOL_CALL_EVENTS_ROOT_DIR = 'tool-call-events';
export const TOOL_RESULT_ARTIFACTS_ROOT_DIR = 'tool-result-artifacts';
export const TOOL_CALL_RESULT_LINKS_ROOT_DIR = 'tool-call-result-links';
export const TOOL_RESULT_BLOBS_ROOT_DIR = 'tool-result-blobs';
export const ANSWER_BRIDGE_LINKS_ROOT_DIR = 'answer-bridge-links';
export const TURNS_ROOT_DIR = 'turns';
export const CHILD_TURN_LINKS_ROOT_DIR = 'child-turn-links';
export const MESSAGE_TURN_LINKS_ROOT_DIR = 'message-turn-links';
export const TURN_INTENTS_ROOT_DIR = 'turn-intents';
export const TURN_INTENT_REVISIONS_ROOT_DIR = 'turn-intent-revisions';
export const TURN_EXECUTION_PRESET_REVISIONS_ROOT_DIR = 'turn-execution-preset-revisions';
export const PENDING_TURN_INPUTS_ROOT_DIR = 'pending-turn-inputs';
export const EXECUTION_LEASES_ROOT_DIR = 'execution-leases';
export const AUTHORITY_SNAPSHOTS_ROOT_DIR = 'authority-snapshots';
export const AUTHORITY_DERIVATION_LINKS_ROOT_DIR = 'authority-derivation-links';
export const RUNTIME_INBOX_ITEMS_ROOT_DIR = 'runtime-inbox-items';
export const RUNTIME_DELIVERY_LINKS_ROOT_DIR = 'runtime-delivery-links';
export const INTERACTIONS_ROOT_DIR = 'interactions';
export const INTERACTION_OWNER_LINKS_ROOT_DIR = 'interaction-owner-links';
export const INTERACTION_RESPONSES_ROOT_DIR = 'interaction-responses';

/**
 * 当前插件明确注册的数据根目录名。
 * 自定义 data root 可能包含用户其它文件；迁移和删除只能触碰这些已注册目录。
 */
export const REGISTERED_STORAGE_ROOT_DIRS = [
  AGENTS_ROOT_DIR,
  WORKFLOWS_ROOT_DIR,
  PLAN_REVIEW_POLICIES_ROOT_DIR,
  PLAN_REVIEW_POLICY_SCOPE_LINKS_ROOT_DIR,
  TOOL_POLICIES_ROOT_DIR,
  TOOL_POLICY_SCOPE_LINKS_ROOT_DIR,
  SKILL_POLICIES_ROOT_DIR,
  SKILL_POLICY_SCOPE_LINKS_ROOT_DIR,
  SYSTEM_PROMPTS_ROOT_DIR,
  MODEL_PROFILES_ROOT_DIR,
  AGENT_CONVERSATION_LINKS_ROOT_DIR,
  SYSTEM_PROMPT_SCOPE_LINKS_ROOT_DIR,
  RUNTIME_CONTEXTS_ROOT_DIR,
  RUNTIME_CONTEXT_SCOPE_LINKS_ROOT_DIR,
  RUNTIME_CONTEXT_SNAPSHOTS_ROOT_DIR,
  CONVERSATION_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  RUN_RUNTIME_CONTEXT_SNAPSHOT_LINKS_ROOT_DIR,
  MODEL_PROFILE_SCOPE_LINKS_ROOT_DIR,
  CONVERSATION_WORKFLOW_SELECTIONS_ROOT_DIR,
  CONVERSATION_AGENT_SELECTIONS_ROOT_DIR,
  CONVERSATIONS_ROOT_DIR,
  CONVERSATION_HISTORY_ROOT_DIR,
  ATTACHMENTS_ROOT_DIR,
  PROJECT_CONTEXTS_ROOT_DIR,
  CONVERSATION_PROJECT_LINKS_ROOT_DIR,
  AGENT_ANSWERS_ROOT_DIR,
  AGENT_ANSWER_SUBMISSION_LINKS_ROOT_DIR,
  AGENT_ANSWER_TARGET_LINKS_ROOT_DIR,
  WORK_ENVIRONMENTS_ROOT_DIR,
  CONVERSATION_WORK_ENVIRONMENT_LINKS_ROOT_DIR,
  RUN_WORK_ENVIRONMENT_LINKS_ROOT_DIR,
  WORK_ENVIRONMENT_POLICIES_ROOT_DIR,
  WORK_ENVIRONMENT_POLICY_SCOPE_LINKS_ROOT_DIR,
  CHECKPOINT_POLICIES_ROOT_DIR,
  CHECKPOINT_POLICY_SCOPE_LINKS_ROOT_DIR,
  SHADOW_REPOSITORIES_ROOT_DIR,
  CONVERSATION_CHECKPOINT_REPOSITORY_LINKS_ROOT_DIR,
  CHECKPOINTS_ROOT_DIR,
  CHECKPOINT_TIMELINE_ANCHORS_ROOT_DIR,
  CHECKPOINT_SHADOW_WORKTREES_ROOT_DIR,
  COMPRESSION_BLOCKS_ROOT_DIR,
  COMPRESSION_BLOCK_SOURCE_LINKS_ROOT_DIR,
  COMPRESSION_CONTEXT_VARIANTS_ROOT_DIR,
  COMPRESSION_BLOCK_LLM_INVOCATION_LINKS_ROOT_DIR,
  TOOL_CALLS_ROOT_DIR,
  TOOL_CALL_EVENTS_ROOT_DIR,
  TOOL_RESULT_ARTIFACTS_ROOT_DIR,
  TOOL_CALL_RESULT_LINKS_ROOT_DIR,
  TOOL_RESULT_BLOBS_ROOT_DIR,
  ANSWER_BRIDGE_LINKS_ROOT_DIR,
  TURNS_ROOT_DIR,
  CHILD_TURN_LINKS_ROOT_DIR,
  MESSAGE_TURN_LINKS_ROOT_DIR,
  TURN_INTENTS_ROOT_DIR,
  TURN_INTENT_REVISIONS_ROOT_DIR,
  TURN_EXECUTION_PRESET_REVISIONS_ROOT_DIR,
  PENDING_TURN_INPUTS_ROOT_DIR,
  EXECUTION_LEASES_ROOT_DIR,
  AUTHORITY_SNAPSHOTS_ROOT_DIR,
  AUTHORITY_DERIVATION_LINKS_ROOT_DIR,
  RUNTIME_INBOX_ITEMS_ROOT_DIR,
  RUNTIME_DELIVERY_LINKS_ROOT_DIR,
  INTERACTIONS_ROOT_DIR,
  INTERACTION_OWNER_LINKS_ROOT_DIR,
  INTERACTION_RESPONSES_ROOT_DIR,
  BACKGROUND_PROCESSES_ROOT_DIR,
  BACKGROUND_PROCESS_ORIGIN_LINKS_ROOT_DIR,
  BACKGROUND_PROCESS_EXIT_RECEIPTS_ROOT_DIR,
  BACKGROUND_PROCESS_NOTIFICATION_DELIVERIES_ROOT_DIR,
  SETTINGS_ROOT_DIR,
  OPERATIONS_ROOT_DIR
] as const;

/** 迁移/归档时与受管目录一起处理的 data-root 顶层文件。 */
export const REGISTERED_STORAGE_ROOT_FILES = [DATA_ROOT_MARKER_FILE] as const;

export const LLM_SETTINGS_FILE = 'llm.json';
export const LLM_COMPRESSION_SETTINGS_FILE = 'llm-compression.json';
export const CHECKPOINT_MAINTENANCE_SETTINGS_FILE = 'checkpoint-maintenance.json';
export const APPEARANCE_SETTINGS_FILE = 'appearance.json';
export const ATTACHMENT_SETTINGS_FILE = 'attachments.json';

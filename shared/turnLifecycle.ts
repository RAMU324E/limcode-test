export type TurnLifecycleStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'interrupted';

export type TurnExecutionPhase =
  | 'loading_context'
  | 'waiting_compression'
  | 'resolving_invocation'
  | 'waiting_checkpoint_before_llm'
  | 'llm_request_pending'
  | 'llm_streaming'
  | 'waiting_tools'
  | 'waiting_child_run'
  | 'waiting_user'
  | 'waiting_plan_review'
  | 'waiting_checkpoint_after_llm'
  | 'delivering'
  | 'paused'
  | 'terminal';

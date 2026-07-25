export type TurnLifecycleStatus =
  | 'active'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale'
  | 'interrupted';

/** Legacy Run still includes queued while the one-shot TurnIntent cutover is assembled. */
export type RunLifecycleStatus = 'queued' | TurnLifecycleStatus;

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

/** Legacy Run still includes queued while the one-shot TurnIntent cutover is assembled. */
export type RunExecutionPhase =
  | 'queued'
  | TurnExecutionPhase;

export type RunExecutionPhaseWithoutQueue =
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

export type RunProgressSourceKind =
  | 'queue_fact'
  | 'context_operation'
  | 'compression_operation'
  | 'invocation_operation'
  | 'checkpoint_operation'
  | 'request_operation'
  | 'stream_state'
  | 'tool_operation'
  | 'child_delivery_wait'
  | 'user_wait'
  | 'plan_review_wait'
  | 'tool_wait'
  | 'delivery_operation'
  | 'pause_record';

export interface RunPhaseMetadata {
  readonly lifecycle: RunLifecycleStatus | readonly RunLifecycleStatus[];
  readonly requiresSlot: boolean;
  readonly progress: Readonly<Partial<Record<RunProgressSourceKind, { readonly min: number; readonly max: number }>>>;
}

const exactlyOne = { min: 1, max: 1 } as const;
const oneOrMore = { min: 1, max: Number.POSITIVE_INFINITY } as const;
const zeroOrMore = { min: 0, max: Number.POSITIVE_INFINITY } as const;

/** The single exhaustive source of Run phase/liveness rules. */
export const RUN_PHASE_METADATA: Readonly<Record<RunExecutionPhase, RunPhaseMetadata>> = {
  queued: { lifecycle: 'queued', requiresSlot: false, progress: { queue_fact: exactlyOne } },
  loading_context: { lifecycle: 'active', requiresSlot: true, progress: { context_operation: exactlyOne } },
  waiting_compression: { lifecycle: 'active', requiresSlot: true, progress: { compression_operation: exactlyOne } },
  resolving_invocation: { lifecycle: 'active', requiresSlot: true, progress: { invocation_operation: exactlyOne } },
  waiting_checkpoint_before_llm: { lifecycle: 'active', requiresSlot: true, progress: { checkpoint_operation: exactlyOne } },
  llm_request_pending: { lifecycle: 'active', requiresSlot: true, progress: { request_operation: exactlyOne } },
  llm_streaming: { lifecycle: 'active', requiresSlot: true, progress: { request_operation: exactlyOne, stream_state: exactlyOne } },
  waiting_tools: {
    lifecycle: 'active',
    requiresSlot: true,
    progress: {
      tool_operation: zeroOrMore,
      tool_wait: zeroOrMore,
      child_delivery_wait: zeroOrMore,
      delivery_operation: zeroOrMore,
      user_wait: zeroOrMore,
      plan_review_wait: zeroOrMore
    }
  },
  waiting_child_run: { lifecycle: 'active', requiresSlot: true, progress: { child_delivery_wait: exactlyOne } },
  waiting_user: { lifecycle: 'active', requiresSlot: true, progress: { user_wait: exactlyOne } },
  waiting_plan_review: { lifecycle: 'active', requiresSlot: true, progress: { plan_review_wait: exactlyOne } },
  waiting_checkpoint_after_llm: { lifecycle: 'active', requiresSlot: true, progress: { checkpoint_operation: exactlyOne } },
  delivering: { lifecycle: 'active', requiresSlot: true, progress: { delivery_operation: exactlyOne } },
  paused: {
    lifecycle: 'active',
    requiresSlot: true,
    progress: {
      context_operation: zeroOrMore,
      compression_operation: zeroOrMore,
      invocation_operation: zeroOrMore,
      checkpoint_operation: zeroOrMore,
      request_operation: zeroOrMore,
      tool_operation: zeroOrMore,
      child_delivery_wait: zeroOrMore,
      user_wait: zeroOrMore,
      plan_review_wait: zeroOrMore,
      tool_wait: zeroOrMore,
      delivery_operation: zeroOrMore,
      pause_record: oneOrMore
    }
  },
  terminal: {
    lifecycle: ['completed', 'failed', 'cancelled', 'stale', 'interrupted'],
    requiresSlot: false,
    progress: {}
  }
};

export const RUN_EXECUTION_PHASES = Object.freeze(Object.keys(RUN_PHASE_METADATA) as RunExecutionPhase[]);

export function isTerminalRunLifecycle(status: RunLifecycleStatus): boolean {
  return status !== 'queued' && status !== 'active';
}

export function phaseAcceptsLifecycle(phase: RunExecutionPhase, lifecycle: RunLifecycleStatus): boolean {
  const accepted = RUN_PHASE_METADATA[phase].lifecycle;
  return Array.isArray(accepted)
    ? (accepted as readonly RunLifecycleStatus[]).includes(lifecycle)
    : accepted === lifecycle;
}

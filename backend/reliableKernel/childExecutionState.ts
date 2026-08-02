export const CHILD_EXECUTION_STATUSES = [
  'starting',
  'active',
  'idle',
  'interrupting',
  'interrupted',
  'closed',
  'needs_human'
] as const;

export type ChildExecutionStatus = typeof CHILD_EXECUTION_STATUSES[number];

const CHILD_EXECUTION_STATUS_SET = new Set<string>(CHILD_EXECUTION_STATUSES);
const CONTINUATION_ACCEPTING_STATUSES = new Set<ChildExecutionStatus>([
  'starting',
  'active',
  'idle',
  'interrupted'
]);
const PERMANENT_TERMINAL_STATUSES = new Set<ChildExecutionStatus>([
  'closed',
  'needs_human'
]);

export function requireChildExecutionStatus(
  value: unknown,
  label = 'ChildExecution.status'
): ChildExecutionStatus {
  if (typeof value !== 'string' || !CHILD_EXECUTION_STATUS_SET.has(value)) {
    throw new Error(`${label} has unsupported value ${String(value)}.`);
  }
  return value as ChildExecutionStatus;
}

export function childExecutionAcceptsContinuation(status: ChildExecutionStatus): boolean {
  return CONTINUATION_ACCEPTING_STATUSES.has(status);
}

export function isChildExecutionPermanentlyTerminal(status: ChildExecutionStatus): boolean {
  return PERMANENT_TERMINAL_STATUSES.has(status);
}

export function isChildExecutionInterrupting(status: ChildExecutionStatus): boolean {
  return status === 'interrupting';
}

export function interruptedStatusAfterTurnTerminal(status: ChildExecutionStatus): ChildExecutionStatus {
  if (status === 'interrupting') return 'interrupted';
  if (status === 'active' || status === 'starting') return 'idle';
  return status;
}

export function assertChildExecutionTransition(
  from: ChildExecutionStatus,
  to: ChildExecutionStatus
): void {
  const allowed: Readonly<Record<ChildExecutionStatus, readonly ChildExecutionStatus[]>> = {
    starting: ['active', 'interrupting', 'interrupted', 'closed', 'needs_human'],
    active: ['idle', 'interrupting', 'interrupted', 'closed', 'needs_human'],
    idle: ['active', 'interrupting', 'interrupted', 'closed', 'needs_human'],
    interrupting: ['interrupted', 'closed', 'needs_human'],
    interrupted: ['active', 'interrupting', 'closed', 'needs_human'],
    closed: [],
    needs_human: []
  };
  if (from !== to && !allowed[from].includes(to)) {
    throw new Error(`Illegal ChildExecution transition ${from} -> ${to}.`);
  }
}

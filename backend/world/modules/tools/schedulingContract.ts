export type ToolSchedulingMode = 'parallel' | 'serial';

export interface ToolSchedulingDecision {
  mode: ToolSchedulingMode;
  reason?: string;
}

export interface ToolSchedulingContext {
  toolName: string;
}

export type ToolSchedulingResolver = (
  args: unknown,
  ctx: ToolSchedulingContext
) => ToolSchedulingDecision | undefined;

export function staticToolScheduling(
  mode: ToolSchedulingMode,
  reason?: string
): ToolSchedulingResolver {
  return () => ({ mode, ...(reason ? { reason } : {}) });
}

export function normalizeSchedulingHint(value: unknown): 'auto' | 'parallel' | 'serial' {
  if (value === 'parallel' || value === 'serial') return value;
  return 'auto';
}

export interface HistoryImageSettings {
  /** Historical image longest edge; 0 sends original images. */
  maxDimension: number;
  /** Total inline image base64 bytes per request in decimal MB; 0 is unlimited. */
  maxMB: number;
}

export function normalizeHistoryImageSettings(value?: unknown): HistoryImageSettings {
  const input = value && typeof value === 'object' ? value as Partial<HistoryImageSettings> : {};
  return {
    maxDimension: finiteInteger(input.maxDimension, 1024, 8192),
    maxMB: finiteInteger(input.maxMB, 16, 200)
  };
}

function finiteInteger(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.round(value))) : fallback;
}

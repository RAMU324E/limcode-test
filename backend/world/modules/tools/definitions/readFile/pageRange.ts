export const READ_MAX_PAGES_PER_CALL = 4;

export interface ReadPageRange {
  start: number;
  end: number;
  canonical: string;
}

export interface ResolvedReadPageRange {
  requestedPages: string;
  returnedPages: string;
  start: number;
  end: number;
  totalPages: number;
  hasMore: boolean;
  nextPages?: string;
}

export type ReadPageRangeResult =
  | { ok: true; range: ReadPageRange }
  | { ok: false; error: string };

export type ResolvedReadPageRangeResult =
  | { ok: true; range: ResolvedReadPageRange }
  | { ok: false; error: string };

export function parseReadPageRange(value: unknown): ReadPageRangeResult {
  if (value === undefined || value === null || value === '') {
    return { ok: true, range: { start: 1, end: 1, canonical: '1' } };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'pages must be a string such as "3" or "1-4".' };
  }
  const normalized = value.trim();
  if (!normalized) return { ok: true, range: { start: 1, end: 1, canonical: '1' } };
  const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(normalized);
  if (!match) {
    return { ok: false, error: 'pages must use "N" or "N-M" with positive page numbers.' };
  }
  const start = Number(match[1]);
  const end = match[2] === undefined ? start : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
    return { ok: false, error: 'pages must contain positive safe integers.' };
  }
  if (end < start) return { ok: false, error: 'pages range end must not be smaller than its start.' };
  if (end - start + 1 > READ_MAX_PAGES_PER_CALL) {
    return { ok: false, error: `pages may include at most ${READ_MAX_PAGES_PER_CALL} consecutive pages per call.` };
  }
  return { ok: true, range: { start, end, canonical: pageRangeText(start, end) } };
}

export function resolveReadPageRange(value: unknown, totalPagesInput: number): ResolvedReadPageRangeResult {
  const parsed = parseReadPageRange(value);
  if (!parsed.ok) return parsed;
  const totalPages = Number.isSafeInteger(totalPagesInput) && totalPagesInput > 0 ? totalPagesInput : 1;
  if (parsed.range.start > totalPages) {
    return {
      ok: false,
      error: `Requested pages start at ${parsed.range.start}, but this attachment has ${totalPages} page(s).`
    };
  }
  const start = parsed.range.start;
  const end = Math.min(parsed.range.end, totalPages);
  const width = parsed.range.end - parsed.range.start + 1;
  const nextStart = end + 1;
  const nextEnd = Math.min(totalPages, nextStart + width - 1);
  return {
    ok: true,
    range: {
      requestedPages: parsed.range.canonical,
      returnedPages: pageRangeText(start, end),
      start,
      end,
      totalPages,
      hasMore: end < totalPages,
      ...(end < totalPages ? { nextPages: pageRangeText(nextStart, nextEnd) } : {})
    }
  };
}

export function compactReadPagesArgument(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = parseReadPageRange(value);
  return parsed.ok ? parsed.range.canonical : value;
}

function pageRangeText(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

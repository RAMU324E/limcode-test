import { resolveReadPageRange, type ResolvedReadPageRange } from './pageRange';

export const READ_TEXT_PAGE_TARGET_CHARS = 8 * 1024;
const READ_TEXT_NEWLINE_SEARCH_MIN_RATIO = 0.5;

export type ReadTextPagesResult =
  | { ok: true; range: ResolvedReadPageRange; content: string }
  | { ok: false; error: string };

export function readTextPages(content: string, pagesArgument: unknown): ReadTextPagesResult {
  const pages = splitReadTextPages(content);
  const resolved = resolveReadPageRange(pagesArgument, pages.length);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    range: resolved.range,
    content: pages.slice(resolved.range.start - 1, resolved.range.end).join('')
  };
}

/** Stable, lossless pages: concatenate every returned page to reconstruct the exact UTF-16 text. */
export function splitReadTextPages(content: string): string[] {
  if (!content) return [''];
  const pages: string[] = [];
  let start = 0;
  while (start < content.length) {
    const hardEnd = Math.min(content.length, start + READ_TEXT_PAGE_TARGET_CHARS);
    let end = hardEnd;
    if (hardEnd < content.length) {
      const newlineSearchStart = start + Math.floor(READ_TEXT_PAGE_TARGET_CHARS * READ_TEXT_NEWLINE_SEARCH_MIN_RATIO);
      const newline = content.lastIndexOf('\n', hardEnd - 1);
      if (newline >= newlineSearchStart) end = newline + 1;
      else if (splitsSurrogatePair(content, end)) end -= 1;
    }
    if (end <= start) end = Math.min(content.length, start + READ_TEXT_PAGE_TARGET_CHARS);
    pages.push(content.slice(start, end));
    start = end;
  }
  return pages;
}

function splitsSurrogatePair(content: string, index: number): boolean {
  if (index <= 0 || index >= content.length) return false;
  const left = content.charCodeAt(index - 1);
  const right = content.charCodeAt(index);
  return left >= 0xD800 && left <= 0xDBFF && right >= 0xDC00 && right <= 0xDFFF;
}

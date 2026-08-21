export interface ExactEditHunk {
  oldContent: string;
  newContent: string;
  replaceAll?: boolean;
}

export interface ExactEditMatch {
  normalizedIndex: number;
  sourceStart: number;
  sourceEnd: number;
}

export interface ExactEditHunkResult {
  content: string;
  matches: ExactEditMatch[];
  matchCount: number;
  replacements: number;
}

interface CanonicalText {
  text: string;
  /** sourceOffsets[n] is the source UTF-16 offset at canonical boundary n. */
  sourceOffsets: number[];
}

/**
 * Applies one exact hunk after canonicalizing only newline spellings for comparison. No whitespace,
 * indentation, case, or context fuzz is permitted. Unmatched source bytes remain untouched.
 */
export function applyExactEditHunk(source: string, hunk: ExactEditHunk): ExactEditHunkResult {
  if (!hunk.oldContent) throw new TypeError('oldContent must be non-empty.');
  const canonicalSource = canonicalizeWithOffsets(source);
  const canonicalSearch = normalizeLineEndings(hunk.oldContent);
  if (!canonicalSearch) throw new TypeError('oldContent must be non-empty.');
  const normalizedIndexes = findNonOverlappingMatches(canonicalSource.text, canonicalSearch);
  if (normalizedIndexes.length === 0) return { content: source, matches: [], matchCount: 0, replacements: 0 };

  const matches = normalizedIndexes.map((normalizedIndex): ExactEditMatch => {
    const sourceStart = canonicalSource.sourceOffsets[normalizedIndex];
    const sourceEnd = canonicalSource.sourceOffsets[normalizedIndex + canonicalSearch.length];
    if (sourceStart === undefined || sourceEnd === undefined) {
      throw new Error('Exact edit match boundary could not be mapped to the source text.');
    }
    return { normalizedIndex, sourceStart, sourceEnd };
  });
  const fileEol = firstLineEnding(source)
    ?? firstLineEnding(hunk.oldContent)
    ?? firstLineEnding(hunk.newContent)
    ?? '\n';
  let content = source;
  const replacements = hunk.replaceAll === true ? matches : [matches[0]!];
  for (const match of [...replacements].sort((left, right) => right.sourceStart - left.sourceStart)) {
    const matchedSource = source.slice(match.sourceStart, match.sourceEnd);
    const replacementEol = firstLineEnding(matchedSource) ?? fileEol;
    const replacement = convertLineEndings(hunk.newContent, replacementEol);
    content = `${content.slice(0, match.sourceStart)}${replacement}${content.slice(match.sourceEnd)}`;
  }
  return { content, matches, matchCount: matches.length, replacements: replacements.length };
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n|\r/g, '\n');
}

export function firstLineEnding(value: string): '\r\n' | '\n' | '\r' | undefined {
  const match = /\r\n|\r|\n/.exec(value);
  return match?.[0] as '\r\n' | '\n' | '\r' | undefined;
}

export function convertLineEndings(value: string, eol: '\r\n' | '\n' | '\r'): string {
  return normalizeLineEndings(value).replace(/\n/g, eol);
}

function canonicalizeWithOffsets(source: string): CanonicalText {
  let text = '';
  const sourceOffsets = [0];
  for (let sourceOffset = 0; sourceOffset < source.length;) {
    const code = source.charCodeAt(sourceOffset);
    if (code === 13) {
      sourceOffset += source.charCodeAt(sourceOffset + 1) === 10 ? 2 : 1;
      text += '\n';
      sourceOffsets.push(sourceOffset);
      continue;
    }
    sourceOffset += 1;
    text += source[sourceOffset - 1];
    sourceOffsets.push(sourceOffset);
  }
  return { text, sourceOffsets };
}

function findNonOverlappingMatches(content: string, search: string): number[] {
  const matches: number[] = [];
  for (let fromIndex = 0; fromIndex <= content.length;) {
    const found = content.indexOf(search, fromIndex);
    if (found < 0) break;
    matches.push(found);
    fromIndex = found + search.length;
  }
  return matches;
}

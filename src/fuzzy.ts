// Simple fuzzy matching: substring + initial-letter abbreviation
// Examples:
//   "mini" → "minimax"   (substring)
//   "ds"   → "deepseek"  (initials)
//   "mimo" → "mimo"      (exact)

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // exact match
  if (q === t) return 1000;

  // prefix match
  if (t.startsWith(q)) return 500 - (t.length - q.length);

  // substring match
  const idx = t.indexOf(q);
  if (idx >= 0) return 300 - idx;

  // initial-letter abbreviation: each char of q appears as an initial in t (not necessarily contiguous)
  // e.g. q="ds", t="deepseek" → hits 'd' and 's'
  let ti = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    ti = found + 1;
  }
  return 100 - t.length;
}

export function fuzzyMatch(query: string, candidates: string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  const scored = candidates
    .map((c) => ({ name: c, score: fuzzyScore(query, c) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.name;
}

/**
 * Same-bucket ambiguity threshold: when top-1 and top-2 score gap is below this,
 * treat the match as ambiguous (used by destructive commands like rm / launch).
 *
 * Threshold rationale (see fuzzyScore buckets):
 *   exact=1000, prefix 500±, substring 300±, initials 100±
 * 50-gap filters out same-bucket ambiguity (e.g. two equal-score prefix matches),
 * without breaking cross-bucket matches (e.g. `open` → `opencode-go` unique).
 */
export const FUZZY_AMBIGUITY_GAP = 50;

/** Top-N candidates (descending score). Returns [] when n<=0 or candidates empty. */
export function fuzzyTopN(
  query: string,
  candidates: string[],
  n: number,
): Array<{ name: string; score: number }> {
  if (n <= 0 || candidates.length === 0) return [];
  return candidates
    .map((c) => ({ name: c, score: fuzzyScore(query, c) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** Returns true when top-1 vs top-2 score gap < FUZZY_AMBIGUITY_GAP. */
export function isAmbiguous(top: Array<{ name: string; score: number }>): boolean {
  if (top.length < 2) return false;
  const first = top[0];
  const second = top[1];
  // length >= 2 guard above, but noUncheckedIndexedAccess doesn't narrow array access
  if (first === undefined || second === undefined) return false;
  return first.score - second.score < FUZZY_AMBIGUITY_GAP;
}
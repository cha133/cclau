// 简易 fuzzy 匹配：支持子串 + 首字母缩写
// 例：
//   "mini" → "minimax" (子串)
//   "ds"   → "deepseek" (首字母)
//   "mimo" → "mimo" (完全)

export function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // 完全匹配
  if (q === t) return 1000;

  // 前缀匹配
  if (t.startsWith(q)) return 500 - (t.length - q.length);

  // 子串匹配
  const idx = t.indexOf(q);
  if (idx >= 0) return 300 - idx;

  // 首字母缩写：query 字符按顺序在 target 中作为首字母出现
  // 例：q="ds", t="deepseek" → 命中 'd' 和 's'（不连续也算）
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
 * 同档歧义阈值：top-1 与 top-2 分数差距小于此值视为歧义
 * （用于危险命令如 rm 拒绝执行）。
 *
 * 阈值依据（见 fuzzyScore 分档）：
 *   完全=1000、前缀 500±、子串 300±、缩写 100±
 * 50 gap 滤掉"同档内歧义"（如两个同分前缀匹配），
 * 不会误伤跨档（`open` → `opencode-go` 唯一命中不会被拒）。
 */
export const FUZZY_AMBIGUITY_GAP = 50;

/** top-N 候选（按 score 降序）。n<=0 或 candidates 为空时返回空数组。 */
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

/** top-1 与 top-2 分数差距 < FUZZY_AMBIGUITY_GAP 时视为歧义 */
export function isAmbiguous(top: Array<{ name: string; score: number }>): boolean {
  if (top.length < 2) return false;
  const first = top[0];
  const second = top[1];
  // length >= 2 守卫后索引必存在，但 noUncheckedIndexedAccess 不 narrow 数组访问
  if (first === undefined || second === undefined) return false;
  return first.score - second.score < FUZZY_AMBIGUITY_GAP;
}
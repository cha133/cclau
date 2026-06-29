// ============================================================================
// 轻量纯文本渲染 helper（照搬 cctra src/ui/table.ts）
// - padEndStr: ANSI-aware padEnd（颜色码不计入宽度）
// - printSection: 打印一个带 header 的段
//
// 注意：padEndStr 内部用 String.prototype.length，它是 UTF-16 code unit，
// 不是显示列宽。CJK 字符在终端里占 2 列但 .length === 1，会出现轻微 pad
// 不足 —— 不修，因为加 string-width 依赖只为这一个命令不值。
// ============================================================================

import pc from "picocolors";

/** 去掉 ANSI 颜色码（picocolors 用的就是 SGR sequences） */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * 把字符串 padEnd 到 width 个可见字符（不计 ANSI 颜色码宽度）。
 * 已经超过 width 的字符串原样返回。
 */
export function padEndStr(s: string, width: number): string {
  const visible = visibleLength(s);
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

/**
 * 打印一个段：粗体 header，下方按 2 空格缩进打印每行。
 * 空 rows 时不打 header（调用方自行决定是否调用）。
 */
export function printSection(header: string, rows: string[]): void {
  if (rows.length === 0) return;
  console.log(pc.bold(header));
  for (const row of rows) {
    console.log(`  ${row}`);
  }
}
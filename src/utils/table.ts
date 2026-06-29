// Lightweight plain-text rendering helpers (ported from cctra src/ui/table.ts)
// - padEndStr: ANSI-aware padEnd (color codes don't count toward width)
// - printSection: print a section with header
//
// Note: padEndStr uses String.prototype.length internally, which is UTF-16 code units,
// not display column width. CJK chars take 2 columns in terminal but .length === 1,
// causing slight padding underrun — left unfixed because adding string-width just for
// one command isn't worth the dependency.

import pc from "picocolors";

/** Strip ANSI color codes (picocolors uses SGR sequences). */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * Pad-end a string to `width` visible chars (excluding ANSI color code width).
 * Strings already longer than width return as-is.
 */
export function padEndStr(s: string, width: number): string {
  const visible = visibleLength(s);
  if (visible >= width) return s;
  return s + " ".repeat(width - visible);
}

/**
 * Print a section: bold header followed by rows indented by 2 spaces.
 * Empty rows: skip the header entirely (caller decides whether to print).
 */
export function printSection(header: string, rows: string[]): void {
  if (rows.length === 0) return;
  console.log(pc.bold(header));
  for (const row of rows) {
    console.log(`  ${row}`);
  }
}
// cclau show [name] - show profile details
//
// With no arg, resolves to the current default profile. With a name,
// fuzzy-resolves against the profile list (same as launch).
//
// refactored: name can only be a profile (provider concept deleted).

import {
  getDefaultName,
  getDefaultProfile,
  getProfile,
  listProfileNames,
} from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import { RULE_DEFS, RULE_DEFS_OPENAI } from "../preset-rules.js";
import type { Profile } from "../types.js";
import { error, info, pc } from "../ui/format.js";
import { formatModelWith1m } from "../core/model-1m.js";

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

/**
 * Format a unix-ms timestamp in the user's local timezone as
 * `YYYY-MM-DD HH:MM:SS ±HH:MM` (e.g. `2026-06-30 16:56:22 +08:00`).
 *
 * Why not `.toISOString()`: that always emits UTC (`Z` suffix), which
 * forces the reader to do mental offset math. Why not `.toLocaleString()`:
 * the output shape varies across Node ICU versions and system locale —
 * a user in zh-CN sees different separator / AM-PM choices than one in
 * en-US. The manual format is deterministic, sortable, and unambiguous
 * about the offset so the reader never has to guess what TZ they're
 * looking at.
 */
function formatLocalTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  // Date#getTimezoneOffset returns minutes WEST of UTC, so negate to get
  // the conventional east-of-UTC offset used in `±HH:MM` formatting.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} ${sign}${oh}:${om}`;
}

export function showCmd(name?: string): void {
  let resolvedName: string;

  if (name === undefined) {
    // No arg → show the current default. getDefaultProfile lazy-resolves a
    // dangling `default` key (auto-promotes first remaining profile per
    // config.ts invariant), so we don't need a separate fuzzy pass here.
    const def = getDefaultProfile();
    if (!def) {
      error(`(no default profile)`);
      info(`run ${pc.cyan("`cclau default <name>`")} to set one.`);
      process.exit(1);
    }
    resolvedName = def.name;
  } else {
    // Fuzzy-resolve user input (same matcher as launch).
    const all = listProfileNames();
    const top = fuzzyTopN(name, all, 1);
    const hit = top[0];
    if (!hit) {
      const hint = all.length > 0 ? ` did you mean: ${all.slice(0, 3).join(", ")}?` : "";
      error(`"${name}" does not exist.${hint} run ${pc.cyan("`cclau ls`")} to see the profile list.`);
      process.exit(1);
    }
    if (hit.name !== name) info(`matched profile "${pc.dim(hit.name)}"`);
    resolvedName = hit.name;
  }

  const profile = getProfile(resolvedName);
  if (!profile) {
    error(`profile "${resolvedName}" does not exist`);
    process.exit(1);
  }

  printProfile(profile, getDefaultName() === profile.name);
}

function printProfile(p: Profile, isDefault: boolean): void {
  const modeColor =
    p.mode === "direct" ? pc.green : p.mode === "rectify" ? pc.yellow : pc.cyan;
  console.log(pc.bold(`Profile: ${p.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${p.endpoint}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(p.apiKey)}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(p.mode)}`);
  // Rectifier (between mode and model — it's a behavior knob, not data).
  // Look up the human-readable label+hint curated for the wizard picker
  // (RULE_DEFS / RULE_DEFS_OPENAI). Fall back to the raw name when the
  // rectifier is unknown to this cclau build (forward compat).
  for (const line of rectifierLines(p)) console.log(line);
  console.log(
    `  ${pc.dim("model   :")} ${formatModelWith1m(p.model, p.supports1m, pc.dim)}`,
  );
  console.log(`  ${pc.dim("default :")} ${isDefault ? pc.green("true") : "false"}`);
  console.log(`  ${pc.dim("createdAt:")} ${formatLocalTs(p.createdAt)}`);
  console.log(`  ${pc.dim("updatedAt:")} ${formatLocalTs(p.updatedAt)}`);
}

// Value column starts at column 13 (2-space indent + 9-char "createdAt:" + 1 space).
// Continuation lines align with the value column.
const VALUE_COL = " ".repeat(13);

/**
 * Word-wrap `text` into lines of at most `maxWidth` characters (counted on
 * the raw text — no ANSI), each prefixed with `prefix`. Words longer than
 * `maxWidth` go on their own line (no mid-word break — readability over
 * strict width).
 *
 * Used to render multi-line field values like rectifier hints so they don't
 * leak past the terminal edge and get ugly terminal-wrap to column 0.
 * Color is applied AFTER wrapping (each line uniformly), so callers should
 * dim/stylize the returned lines themselves.
 */
function wrapText(text: string, maxWidth: number, prefix: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `${prefix}${line}`);
}

function rectifierLines(p: Profile): string[] {
  const name = p.rectifier;
  if (!name) return [];
  // mode-aware lookup: rectify uses anthropic rules, openai uses openai rules.
  // (direct mode never carries a rectifier — see registry.ts.)
  const defs = p.mode === "openai" ? RULE_DEFS_OPENAI : RULE_DEFS;
  const def = defs[name];
  if (!def) {
    // Unknown / future rectifier — show raw name, no description (registry
    // emits the "unknown rectifier" warning at boot, so don't repeat it here).
    return [`  ${pc.dim("rectifier:")} ${name}`];
  }

  // Auto-size to terminal width. VALUE_COL = 13 chars; leave at least 40
  // chars for content so short hints stay single-line. Falls back to 100
  // when stdout isn't a TTY (piped to file/grep, CI logs, etc.).
  const colWidth = process.stdout.columns ?? 100;
  const valueWidth = Math.max(40, colWidth - VALUE_COL.length);

  const out: string[] = [];
  // Label: first line rides next to "rectifier:", continuation (if any)
  // aligns to VALUE_COL. Not dimmed (matches single-line style).
  const labelLines = wrapText(def.label, valueWidth, "");
  out.push(`  ${pc.dim("rectifier:")} ${labelLines[0]}`);
  for (let i = 1; i < labelLines.length; i++) {
    out.push(`${VALUE_COL}${labelLines[i]}`);
  }
  // Hint: every line dimmed, all aligned to VALUE_COL.
  const hintLines = wrapText(`(${def.hint})`, valueWidth, "");
  for (const line of hintLines) {
    out.push(`${VALUE_COL}${pc.dim(line)}`);
  }
  return out;
}
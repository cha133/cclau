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
  console.log(`  ${pc.dim("createdAt:")} ${new Date(p.createdAt).toISOString()}`);
  console.log(`  ${pc.dim("updatedAt:")} ${new Date(p.updatedAt).toISOString()}`);
}

// Value column starts at column 13 (2-space indent + 9-char "createdAt:" + 1 space).
// Continuation lines align with the value column.
const VALUE_COL = " ".repeat(13);

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
  return [
    `  ${pc.dim("rectifier:")} ${def.label}`,
    `${VALUE_COL}${pc.dim(`(${def.hint})`)}`,
  ];
}
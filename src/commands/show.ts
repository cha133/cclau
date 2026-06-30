// cclau show <name> - show profile details
//
// refactored: name can only be a profile (provider concept deleted).

import { getDefaultName, getProfile, listProfileNames } from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { Profile } from "../types.js";
import { error, info, pc } from "../ui/format.js";
import { formatModelWith1m } from "../core/model-1m.js";

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

export function showCmd(name: string): void {
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 1);
  const hit = top[0];
  if (!hit) {
    const hint = all.length > 0 ? ` did you mean: ${all.slice(0, 3).join(", ")}?` : "";
    error(`"${name}" does not exist.${hint} run ${pc.cyan("`cclau ls`")} to see the profile list.`);
    process.exit(1);
  }
  if (hit.name !== name) info(`matched profile "${pc.dim(hit.name)}"`);

  const profile = getProfile(hit.name);
  if (!profile) {
    error(`profile "${hit.name}" does not exist`);
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
  console.log(
    `  ${pc.dim("model   :")} ${formatModelWith1m(p.model, p.supports1m, pc.dim)}`,
  );
  console.log(`  ${pc.dim("default :")} ${isDefault ? pc.green("true") : "false"}`);
  console.log(`  ${pc.dim("createdAt:")} ${new Date(p.createdAt).toISOString()}`);
  console.log(`  ${pc.dim("updatedAt:")} ${new Date(p.updatedAt).toISOString()}`);
}
// cclau rm <name> - remove a profile
//
// fuzzy + ambiguity protection: rm is irreversible, reject on top-1/top-2 score gap < threshold.
// If the removed profile was the default, auto-promote the first remaining one
// (sorted by name) to keep `cclau` (no args) usable. If no profiles remain,
// leave the global `default` key stale — the next `cclau add` overwrites it
// via the lazy-resolve auto-default trigger.

import {
  getDefaultName,
  listProfileNames,
  listProfiles,
  removeProfile,
  setDefault,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { success, error, info, pc } from "../ui/format.js";

export async function rmCmd(name: string): Promise<void> {
  try {
    const all = listProfileNames();
    const top = fuzzyTopN(name, all, 2);
    if (top.length === 0) {
      error(`profile "${name}" does not exist. existing: ${all.join(", ") || "(empty)"}`);
      process.exit(1);
    }
    if (isAmbiguous(top)) {
      error(
        `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. rm is irreversible, please use a more specific name.`,
      );
      process.exit(1);
    }
    const resolved = top[0]!.name;
    if (resolved !== name) info(`matched profile "${pc.dim(resolved)}"`);

    // Capture default state BEFORE removal (we need it for fallback logic)
    const wasDefault = getDefaultName() === resolved;

    const ok = await removeProfile(resolved);
    if (!ok) {
      error(`profile "${resolved}" does not exist`);
      process.exit(1);
    }

    success(`removed profile "${resolved}"`);

    if (wasDefault) {
      const remaining = listProfiles();
      if (remaining.length > 0) {
        const fallback = remaining[0]!;
        await setDefault(fallback.name);
        info(`auto-promoted "${fallback.name}" as new default`);
      } else {
        // Stale default reference is intentional — next `cclau add` will
        // see getDefaultProfile() === undefined (lazy) and overwrite.
        info(`no profiles left — next \`cclau add\` will become default`);
      }
    }
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}
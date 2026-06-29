// cclau rm <name> - remove a profile
//
// fuzzy + ambiguity protection: rm is irreversible, reject on top-1/top-2 score gap < threshold.
// If the removed profile was the default, auto-promote the first remaining one
// (sorted by name) to keep `cclau` (no args) usable.

import * as p from "@clack/prompts";
import {
  getProfile,
  listProfileNames,
  listProfiles,
  removeProfile,
  upsertProfile,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { pc } from "../utils/logger.js";
import type { Profile } from "../types.js";

export async function rmCmd(name: string): Promise<void> {
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 2);
  if (top.length === 0) {
    p.log.error(`profile "${name}" does not exist. existing: ${all.join(", ") || "(empty)"}`);
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. rm is irreversible, please use a more specific name.`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`matched profile "${resolved}"`));

  // Capture default state BEFORE removal (we need it for fallback logic)
  const wasDefault = getProfile(resolved)?.default === true;

  const ok = await removeProfile(resolved);
  if (!ok) {
    p.log.error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  p.log.success(`✓ removed profile "${resolved}"`);

  // If the removed profile was the default, auto-promote first remaining (by name).
  // listProfiles() returns sorted by name, so [0] is the deterministic fallback.
  if (wasDefault) {
    const remaining = listProfiles();
    if (remaining.length > 0) {
      const fallback = remaining[0]!;
      const updated: Profile = {
        ...fallback,
        default: true,
        updatedAt: Date.now(),
      };
      await upsertProfile(updated);
      console.log(
        pc.dim(`(auto-promoted "${fallback.name}" as new default)`),
      );
    } else {
      console.log(
        pc.dim(`(no profiles left — add a new one and run \`cclau default <name>\` after)`),
      );
    }
  }
}
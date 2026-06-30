// cclau edit <name> - entry point for the edit wizard
//
// Real interactive flow lives in src/ui/prompts.ts::promptEdit().
// This file is a thin wrapper: fuzzy-resolve name → run wizard → if anything
// changed, clear other profiles' default flag (when promoting this one) and
// persist.

import {
  getProfile,
  listProfiles,
  listProfileNames,
  upsertProfile,
} from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import { success, error, info, pc } from "../ui/format.js";
import { promptEdit } from "../ui/prompts.js";
import type { Profile } from "../types.js";

export async function editCmd(name: string): Promise<void> {
  try {
    const top = fuzzyTopN(name, listProfileNames(), 1);
    if (top.length === 0) {
      const all = listProfileNames();
      error(
        `profile "${name}" does not exist. existing: ${all.join(", ") || "(empty)"}`,
      );
      process.exit(1);
    }
    const resolved = top[0]!.name;
    if (resolved !== name) info(`matched profile "${pc.dim(resolved)}"`);

    const original = getProfile(resolved);
    if (!original) {
      error(`profile "${resolved}" does not exist`);
      process.exit(1);
    }

    const updated = await promptEdit(original);

    if (!isChanged(original, updated)) {
      info("no changes");
      return;
    }

    // Default cascade: clear other profiles' default flag
    if (updated.default === true) {
      for (const prof of listProfiles()) {
        if (prof.name !== updated.name && prof.default === true) {
          const cleared: Profile = { ...prof };
          delete cleared.default;
          cleared.updatedAt = Date.now();
          await upsertProfile(cleared);
        }
      }
    }

    updated.updatedAt = Date.now();
    await upsertProfile(updated);
    success(`saved profile "${updated.name}"`);
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}

function isChanged(a: Profile, b: Profile): boolean {
  return (
    a.endpoint !== b.endpoint ||
    a.apiKey !== b.apiKey ||
    a.mode !== b.mode ||
    a.model !== b.model ||
    a.supports1m !== b.supports1m ||
    (a.default === true) !== (b.default === true)
  );
}

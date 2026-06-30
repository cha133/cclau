// cclau add - entry point for the add wizard
//
// Real interactive flow lives in src/ui/prompts.ts::promptAdd().
// This file is a thin wrapper: run wizard → persist profile → auto-default
// when no other default exists (invariant #7) → print success.

import { listProfiles, upsertProfile } from "../config.js";
import { success, error, info } from "../ui/format.js";
import { promptAdd } from "../ui/prompts.js";
import type { Profile } from "../types.js";

export async function addCmd(): Promise<void> {
  try {
    const profile = await promptAdd();
    await upsertProfile(profile);

    // Auto-default: if no other profile is the default, promote the new one.
    // Rationale: first profile added → make it default so `cclau` (no args) works
    // immediately, no need to run `cclau default <name>` separately. Subsequent
    // adds don't auto-default — user picks explicitly via `cclau default <name>`.
    let autoDefaulted = false;
    const allAfter = listProfiles();
    const hasAnotherDefault = allAfter.some(
      (p) => p.name !== profile.name && p.default === true,
    );
    if (!hasAnotherDefault && profile.default !== true) {
      const updated: Profile = {
        ...profile,
        default: true,
        updatedAt: Date.now(),
      };
      await upsertProfile(updated);
      autoDefaulted = true;
    }

    const rectHint = profile.rectifier ? " (rectifier enabled)" : "";
    const defaultHint = autoDefaulted ? " (auto-set as default)" : "";
    success(
      `added profile "${profile.name}" (${profile.mode}, model: ${profile.model}${rectHint}${defaultHint})`,
    );
    info(
      `next: run \`cclau default ${profile.name}\` to set as default, \`cclau ${profile.name}\` to launch claude code`,
    );
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}

// cclau add - entry point for the add wizard
//
// Real interactive flow lives in src/ui/prompts.ts::promptAdd().
// This file is a thin wrapper: run wizard → persist profile → auto-default
// when no global default is set (or current default is dangling) → print success.

import { getDefaultProfile, setDefault, upsertProfile } from "../config.js";
import { success, error, info } from "../ui/format.js";
import { promptAdd } from "../ui/prompts.js";

export async function addCmd(): Promise<void> {
  try {
    const profile = await promptAdd();
    await upsertProfile(profile);

    // Auto-default: lazy resolve — dangling counts as unset. First add wins;
    // subsequent adds leave existing default alone.
    let autoDefaulted = false;
    if (getDefaultProfile() === undefined) {
      await setDefault(profile.name);
      autoDefaulted = true;
    }

    const rectHint = profile.rectifier ? " (rectifier enabled)" : "";
    const defaultHint = autoDefaulted ? " (auto-set as default)" : "";
    success(
      `added profile "${profile.name}" (${profile.mode}, model: ${profile.model}${rectHint}${defaultHint})`,
    );
    info(
      `next: run \`cclau ${profile.name}\` to launch claude code`,
    );
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}

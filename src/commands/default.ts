// ============================================================================
// cclau default [name]
//
// nvm-style:
//   cclau default              -- show current default profile
//   cclau default <name>       -- set as default (fuzzy match)
//
// Config layer allows exactly one default. Setting a new default automatically
// clears the default flag on all other profiles. To switch defaults, just run
// `cclau default <other>` — no need to unset first.
// ============================================================================

import { Command } from "commander";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import {
  getDefaultProfile,
  getProfile,
  listProfiles,
  upsertProfile,
} from "../config.js";
import { success, error, info, pc } from "../ui/format.js";

export function registerDefault(program: Command): void {
  program
    .command("default [name]")
    .description("Show or set the default profile (nvm-style)")
    .action(async (name?: string) => {
      if (!name) {
        showDefault();
        return;
      }
      await setDefault(name);
    });
}

// ---------------------------------------------------------------------------

function showDefault(): void {
  const all = listProfiles();
  const defaults = all.filter((p) => p.default === true);

  if (defaults.length > 1) {
    // Config is dirty: multiple defaults. Ask the user to clean up.
    error(`multiple profiles marked as default:`);
    for (const prof of defaults) {
      console.log(pc.dim(`  - ${prof.name}`));
    }
    console.log(
      pc.dim(`run ${pc.cyan("`cclau default <name>`")} to set one, or ${pc.cyan("`cclau edit <name>`")} to clear extras.`),
    );
    return;
  }

  const def = getDefaultProfile();
  if (!def) {
    info("(no default profile)");
    info(`run ${pc.cyan("`cclau default <name>`")} to set one.`);
    return;
  }

  console.log(
    `${pc.cyan(def.name)}  ${pc.dim(`(mode: ${def.mode}, model: ${def.model})`)}`,
  );
}

async function setDefault(name: string): Promise<void> {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    error(`no profiles yet. run ${pc.cyan("`cclau add`")} to create one.`);
    process.exit(1);
  }

  const top = fuzzyTopN(name, profiles.map((p) => p.name), 2);
  if (top.length === 0) {
    error(
      `no profile matched "${name}". existing: ${profiles.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    error(
      `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. please use a more specific name.`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;

  const target = getProfile(resolved);
  if (!target) {
    error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  // Clear other defaults (enforce single default at config layer)
  for (const prof of profiles) {
    if (prof.name !== resolved && prof.default === true) {
      const updated: typeof prof = { ...prof };
      delete updated.default;
      updated.updatedAt = Date.now();
      await upsertProfile(updated);
    }
  }

  if (target.default === true) {
    info(`"${resolved}" is already default`);
    return;
  }

  const updated: typeof target = {
    ...target,
    default: true,
    updatedAt: Date.now(),
  };
  await upsertProfile(updated);
  success(`default → "${resolved}"`);
}
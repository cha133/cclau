// ============================================================================
// cclau default [name] [--unset]
//
// nvm-style:
//   cclau default              -- show current default profile
//   cclau default <name>       -- set as default (fuzzy match)
//   cclau default --unset      -- unset all defaults
//
// Config layer allows exactly one default. Setting a new default automatically
// clears the default flag on all other profiles.
// ============================================================================

import { Command } from "commander";
import * as p from "@clack/prompts";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import {
  getDefaultProfile,
  getProfile,
  listProfiles,
  upsertProfile,
} from "../config.js";
import { pc } from "../utils/logger.js";

export function registerDefault(program: Command): void {
  program
    .command("default [name]")
    .description("Show or set the default profile (nvm-style)")
    .option("--unset", "Unset the current default profile")
    .action(async (name?: string, opts?: { unset?: boolean }) => {
      if (opts?.unset) {
        await unsetDefault();
        return;
      }
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
    console.log(pc.red(`error: multiple profiles marked as default:`));
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
    console.log(pc.dim("(no default profile)"));
    console.log(pc.dim(`run ${pc.cyan("`cclau default <name>`")} to set one.`));
    return;
  }

  console.log(
    `${pc.cyan(def.name)}  ${pc.dim(`(mode: ${def.mode}, model: ${def.model})`)}`,
  );
}

async function setDefault(name: string): Promise<void> {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    p.log.error(`no profiles yet. run ${pc.cyan("`cclau add`")} to create one.`);
    process.exit(1);
  }

  const top = fuzzyTopN(name, profiles.map((p) => p.name), 2);
  if (top.length === 0) {
    p.log.error(
      `no profile matched "${name}". existing: ${profiles.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. please use a more specific name.`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;

  const target = getProfile(resolved);
  if (!target) {
    p.log.error(`profile "${resolved}" does not exist`);
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
    p.log.info(`"${resolved}" is already default`);
    return;
  }

  const updated: typeof target = {
    ...target,
    default: true,
    updatedAt: Date.now(),
  };
  await upsertProfile(updated);
  p.log.success(`✓ default → "${resolved}"`);
}

async function unsetDefault(): Promise<void> {
  const profiles = listProfiles();
  const defaults = profiles.filter((p) => p.default === true);
  if (defaults.length === 0) {
    p.log.info("(no default profile to unset)");
    return;
  }

  for (const prof of defaults) {
    const updated: typeof prof = { ...prof };
    delete updated.default;
    updated.updatedAt = Date.now();
    await upsertProfile(updated);
  }

  if (defaults.length === 1) {
    p.log.success(`✓ cleared default "${defaults[0]!.name}"`);
  } else {
    p.log.success(
      `✓ cleared ${defaults.length} default profiles: ${defaults.map((d) => d.name).join(", ")}`,
    );
  }
}
// ============================================================================
// cclau use [name]
//
// nvm-style:
//   cclau use                  -- show current default (active) profile
//   cclau use <name>           -- set as default / switch to (fuzzy match)
//
// Aligned with ../ccswi's `use` command naming. The underlying config field
// is still `Config.default` (top-level TOML key, single source of truth);
// only the CLI verb changed. Multi-default is impossible by construction.
// ============================================================================

import type { Command } from "commander";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import {
  getDefaultName,
  getDefaultProfile,
  getProfile,
  listProfiles,
  setDefault,
} from "../config.js";
import { success, error, info, pc } from "../ui/format.js";

export function registerUse(program: Command): void {
  program
    .command("use [name]")
    .description("Show or set the active profile (nvm-style)")
    .action(async (name?: string) => {
      if (!name) {
        showActive();
        return;
      }
      await switchTo(name);
    });
}

// ---------------------------------------------------------------------------

function showActive(): void {
  const def = getDefaultProfile();
  if (def) {
    console.log(
      `${pc.cyan(def.name)}  ${pc.dim(`(mode: ${def.mode}, model: ${def.model})`)}`,
    );
    return;
  }

  // No resolvable active — either truly absent or dangling (cfg.default points
  // to a profile that no longer exists). Distinguish for diagnostics.
  const raw = getDefaultName();
  if (raw !== undefined) {
    info(`(default reference "${pc.cyan(raw)}" is stale — profile no longer exists)`);
    info(`run ${pc.cyan("`cclau use <name>`")} to set a new one.`);
    return;
  }

  info("(no active profile)");
  info(`run ${pc.cyan("`cclau use <name>`")} to set one.`);
}

async function switchTo(name: string): Promise<void> {
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

  // setDefault validates the profile exists — prevents dangling writes.
  if (!getProfile(resolved)) {
    error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  if (getDefaultName() === resolved) {
    info(`"${resolved}" is already active`);
    return;
  }

  await setDefault(resolved);
  success(`switched to "${resolved}"`);
}
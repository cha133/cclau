// ============================================================================
// cclau default [name]
//
// nvm-style:
//   cclau default              -- show current default profile
//   cclau default <name>       -- set as default (fuzzy match)
//
// Default is a global key (config top-level `default = "<profile-name>"`),
// single source of truth. Multi-default is impossible by construction.
// ============================================================================

import { Command } from "commander";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import {
  getDefaultName,
  getDefaultProfile,
  getProfile,
  listProfiles,
  setDefault,
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
      await setDefaultCmd(name);
    });
}

// ---------------------------------------------------------------------------

function showDefault(): void {
  const def = getDefaultProfile();
  if (def) {
    console.log(
      `${pc.cyan(def.name)}  ${pc.dim(`(mode: ${def.mode}, model: ${def.model})`)}`,
    );
    return;
  }

  // No resolvable default — either truly absent or dangling (cfg.default points
  // to a profile that no longer exists). Distinguish for diagnostics.
  const raw = getDefaultName();
  if (raw !== undefined) {
    info(`(default reference "${pc.cyan(raw)}" is stale — profile no longer exists)`);
    info(`run ${pc.cyan("`cclau default <name>`")} to set a new one.`);
    return;
  }

  info("(no default profile)");
  info(`run ${pc.cyan("`cclau default <name>`")} to set one.`);
}

async function setDefaultCmd(name: string): Promise<void> {
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
    info(`"${resolved}" is already default`);
    return;
  }

  await setDefault(resolved);
  success(`default → "${resolved}"`);
}

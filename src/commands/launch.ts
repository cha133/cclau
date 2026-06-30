// cclau <name> [claude args...] - main launch command
// cclau (no args)               - launch default profile
//
// Flow:
//   1. Fuzzy-resolve profile name (launch is destructive, reject on ambiguity)
//   2. resolveLaunch → { settingsModel, upstreamModel, sidecar }
//   3. apiKey sanity check (resolveLaunch already errors)
//   4. Decide sidecar based on sidecar.needed
//      - false (direct) → no server, writeSettingsFile(port=undefined) → baseUrl = endpoint
//      - true  (rectify / openai) → findFreePort → buildRegistry(profile) → startServer → writeSettingsFile(port)
//   5. spawn claude → cleanup server + temp settings file
//
// All 4 ANTHROPIC_DEFAULT_*_MODEL envs = settingsModel (single profile, no tier split).

import {
  getDefaultProfile,
  getProfile,
  listProfileNames,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { findFreePort } from "../port.js";
import { resolveLaunch, writeSettingsFile } from "../settings.js";
import { spawnClaude } from "../process.js";
import { startServer } from "../server/index.js";
import { buildRegistry } from "../server/registry.js";
import { success, error, info, pc } from "../ui/format.js";

export async function launchCmd(
  query: string,
  claudeArgs: string[],
): Promise<void> {
  // 1. Fuzzy-resolve profile
  const all = listProfileNames();
  if (all.length === 0) {
    error(`no profiles yet. run ${pc.cyan("`cclau add`")} to create one.`);
    process.exit(1);
  }

  const top = fuzzyTopN(query, all, 2);
  if (top.length === 0) {
    error(
      `no profile matched "${query}". existing: ${all.join(", ")}`,
    );
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    error(
      `"${query}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. please use a more specific name.`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== query) info(`matched profile "${pc.dim(resolved)}"`);

  const profile = getProfile(resolved);
  if (!profile) {
    error(`profile "${resolved}" does not exist`);
    process.exit(1);
  }

  // 2. Resolve launch decision (required-field validation)
  let launch;
  try {
    launch = resolveLaunch(profile);
  } catch (err) {
    if (err instanceof Error) error(err.message);
    process.exit(1);
  }

  // 3. Decide sidecar
  let server: ReturnType<typeof startServer> | undefined;
  let port: number | undefined;

  if (launch.sidecar.needed) {
    port = await findFreePort(3133);
    const registry = buildRegistry(profile);
    server = startServer(registry, port);
  }

  // 4. Write settings
  const settings = await writeSettingsFile(profile, port);

  // 5. Log
  const modeDesc = launch.sidecar.needed
    ? `sidecar (${launch.sidecar.reason}, port: ${port})`
    : `direct (zero-hop)`;
  info(`launching claude code (profile: ${profile.name}, ${modeDesc})`);
  console.log(
    pc.dim(
      `endpoint: ${profile.endpoint}, model: ${profile.model}${profile.supports1m ? " [1m]" : ""}`,
    ),
  );

  const { exited } = spawnClaude(settings, claudeArgs);
  const code = await exited;

  // 6. Cleanup
  if (server) {
    server.stop();
    console.log(`sidecar server stopped (port ${port})`);
  }

  process.exit(code ?? 0);
}

/**
 * Called by `cclau` (no args): resolve default profile → launchCmd.
 * Reports 0-default and multi-default errors here.
 */
export async function launchDefault(args: string[]): Promise<void> {
  const def = getDefaultProfile();
  if (!def) {
    error("(no default profile)");
    info(`run ${pc.cyan("`cclau default <name>`")} to set one.`);
    process.exit(1);
  }
  await launchCmd(def.name, args);
}
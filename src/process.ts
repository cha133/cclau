// Spawn claude + signal forwarding

import { spawn, type Subprocess } from "bun";
import { warn } from "./ui/format.js";
import type { SettingsFile } from "./settings.js";

export interface ClaudeProcess {
  proc: Subprocess;
  exited: Promise<number>;
}

/**
 * Launch `claude --settings <file> [args...]`
 * Pipes stdin/stdout/stderr through. Ctrl-C forwards synchronously to the claude child.
 *
 * `debug` flips the sidecar's CCLAU_DEBUG env (read by server/index.ts to enable
 * debug logging to $XDG_STATE_HOME/cclau/debug.log). Off by default — zero overhead
 * when not set.
 */
export function spawnClaude(
  settings: SettingsFile,
  args: string[],
  debug = false,
): ClaudeProcess {
  // Spread process.env then overlay CCLAU_DEBUG when enabled. process.env
  // values are technically `string | undefined`; sub-process spawn tolerates
  // undefined entries (env vars unset at the kernel level), so keeping the
  // original type avoids forcing a needless filter pass.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (debug) env.CCLAU_DEBUG = "1";

  const proc = spawn({
    cmd: ["claude", "--settings", settings.path, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env,
  });

  // Signal forwarding: parent SIGINT/SIGTERM/SIGBREAK → child claude
  const forward = (sig: NodeJS.Signals | "SIGBREAK") => {
    if (!proc.killed) {
      try {
        proc.kill(sig);
      } catch (err) {
        warn(`failed to forward ${sig} to claude: ${(err as Error).message}`);
      }
    }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  // Windows-specific: Ctrl-Break
  process.on("SIGBREAK", forward);

  const exited = proc.exited.then(async (code) => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    process.off("SIGBREAK", forward);
    await settings.cleanup();
    return code;
  });

  return { proc, exited };
}
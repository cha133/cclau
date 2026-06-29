// Spawn claude + signal forwarding

import { spawn, type Subprocess } from "bun";
import * as p from "@clack/prompts";
import type { SettingsFile } from "./settings.js";

export interface ClaudeProcess {
  proc: Subprocess;
  exited: Promise<number>;
}

/**
 * Launch `claude --settings <file> [args...]`
 * Pipes stdin/stdout/stderr through. Ctrl-C forwards synchronously to the claude child.
 */
export function spawnClaude(settings: SettingsFile, args: string[]): ClaudeProcess {
  const proc = spawn({
    cmd: ["claude", "--settings", settings.path, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  // Signal forwarding: parent SIGINT/SIGTERM/SIGBREAK → child claude
  const forward = (sig: NodeJS.Signals | "SIGBREAK") => {
    if (!proc.killed) {
      try {
        proc.kill(sig);
      } catch (err) {
        p.log.warn(`failed to forward ${sig} to claude: ${(err as Error).message}`);
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
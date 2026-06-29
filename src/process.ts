// spawn claude + 信号转发

import { spawn, type Subprocess } from "bun";
import * as p from "@clack/prompts";
import type { SettingsFile } from "./settings.js";

export interface ClaudeProcess {
  proc: Subprocess;
  exited: Promise<number>;
}

/**
 * 启动 `claude --settings <file> [args...]`
 * 透传 stdin/stdout/stderr，Ctrl-C 时同步转发给 claude 子进程
 */
export function spawnClaude(settings: SettingsFile, args: string[]): ClaudeProcess {
  const proc = spawn({
    cmd: ["claude", "--settings", settings.path, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });

  // 信号转发：父进程收到 SIGINT/SIGTERM/SIGBREAK 时同步发给 claude
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
  // Windows 特有：Ctrl-Break
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
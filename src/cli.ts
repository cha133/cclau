#!/usr/bin/env bun
// cclau - Claude Code launcher
//
// 5 层路由（详见 .claude/02-cli-routing.md）：
//   1. 无参 → launch default profile
//   2. -h/--help 单独首参 → cclau help（拦截 cc help）
//   3. 首参以 - 开头 → launch default + 透传所有 argv 给 claude
//   4. 已知子命令 → commander
//   5. 其余 → fuzzy match profile + 透传剩余 args 给 claude

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { addCmd } from "./commands/add.js";
import { editCmd } from "./commands/edit.js";
import { listCmd } from "./commands/ls.js";
import { registerDefault } from "./commands/default.js";
import { launchCmd, launchDefault } from "./commands/launch.js";
import { rmCmd } from "./commands/rm.js";
import { showCmd } from "./commands/show.js";

// commander 已知子命令。增减只改这一处。
// 最终名单（详见 .claude/02-cli-routing.md § 规则 4）：
//   add edit rm remove ls list show default help version
// 已删：doctor models alias switch profile（及其子命令组）
const KNOWN_SUBCOMMANDS = new Set([
  "add",
  "edit",
  "rm",
  "remove",
  "ls",
  "list",
  "show",
  "default",
  "help",
  "version",
]);

const program = new Command();

program
  .name("cclau")
  .description("Claude Code launcher with profile manager")
  .version(pkg.version, "-v, --version")
  .showHelpAfterError(true);

program
  .command("add")
  .description("Interactively add a profile")
  .action(async () => {
    await addCmd();
  });

program
  .command("edit <name>")
  .description("Edit a profile (endpoint/key/mode/model/1m/default)")
  .action(async (name: string) => {
    await editCmd(name);
  });

program
  .command("rm <name>")
  .alias("remove")
  .description("Remove a profile")
  .action(async (name: string) => {
    await rmCmd(name);
  });

program
  .command("ls")
  .alias("list")
  .description("List all profiles")
  .action(() => {
    listCmd();
  });

program
  .command("show <name>")
  .description("Show profile details")
  .action((name: string) => {
    showCmd(name);
  });

// nvm 风格的 default 子命令组（详见 src/commands/default.ts）
registerDefault(program);

// ============================================================================
// main 路由
// ============================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  // 规则 1：无参 → launch default
  if (firstArg === undefined) {
    await launchDefault([]);
    return;
  }

  // 规则 2：-h / --help 单独首参 → cclau help（拦截 cc help）
  if ((firstArg === "-h" || firstArg === "--help") && argv.length === 1) {
    program.parse(process.argv);
    return;
  }

  // 规则 3：首参以 - 开头 → launch default + 透传给 claude
  if (firstArg.startsWith("-")) {
    await launchDefault(argv);
    return;
  }

  // 规则 4：已知子命令 → commander
  if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    program.parse(process.argv);
    return;
  }

  // 规则 5：fuzzy match profile + 透传剩余 args
  await launchCmd(firstArg, argv.slice(1));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
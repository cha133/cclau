#!/usr/bin/env bun
// cclau - Claude Code launcher
//
// 5-layer routing (see .claude/02-cli-routing.md):
//   1. no args             → launch default profile
//   2. -h / --help alone   → cclau help (intercepts cc help)
//   3. -X                  → launch default + passthrough all argv to claude
//   4. known subcommand    → commander
//   5. otherwise           → fuzzy match profile + passthrough remaining args

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { addCmd } from "./commands/add.js";
import { editCmd } from "./commands/edit.js";
import { listCmd } from "./commands/ls.js";
import { registerDefault } from "./commands/default.js";
import { launchCmd, launchDefault } from "./commands/launch.js";
import { rmCmd } from "./commands/rm.js";
import { showCmd } from "./commands/show.js";

// commander-known subcommands. Add or remove here only.
// Final list (see .claude/02-cli-routing.md § rule 4):
//   add edit rm remove ls list show default help version
// Removed: doctor models alias switch profile (and its subcommand group)
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

// nvm-style default subcommand group (see src/commands/default.ts)
registerDefault(program);

// ============================================================================
// main routing
// ============================================================================

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  // rule 1: no args → launch default
  if (firstArg === undefined) {
    await launchDefault([]);
    return;
  }

  // rule 2: -h / --help as the only arg → cclau help (intercepts cc help)
  if ((firstArg === "-h" || firstArg === "--help") && argv.length === 1) {
    program.parse(process.argv);
    return;
  }

  // rule 3: -X → launch default + passthrough
  if (firstArg.startsWith("-")) {
    await launchDefault(argv);
    return;
  }

  // rule 4: known subcommand → commander
  if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    program.parse(process.argv);
    return;
  }

  // rule 5: fuzzy match profile + passthrough remaining args
  await launchCmd(firstArg, argv.slice(1));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
#!/usr/bin/env bun
// cclau - Claude Code launcher
//
// Two-lane routing:
//   management command → Commander
//   everything else    → launch default or named profile, preserving Claude argv

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { addCmd } from "./commands/add.js";
import { cpCmd } from "./commands/cp.js";
import { editCmd } from "./commands/edit.js";
import { listCmd } from "./commands/ls.js";
import { registerUse } from "./commands/use.js";
import { launchCmd, launchDefault } from "./commands/launch.js";
import { rmCmd } from "./commands/rm.js";
import { renameCmd } from "./commands/rename.js";
import { showCmd } from "./commands/show.js";
import { classifyRoute } from "./routing.js";

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
  .command("cp <src> <new_name>")
  .description("Clone a profile with a different model")
  .action(async (src: string, newName: string) => {
    await cpCmd(src, newName);
  });

program
  .command("edit <name>")
  .description("Edit a profile (endpoint/key/mode/model/1m/default)")
  .action(async (name: string) => {
    await editCmd(name);
  });

program
  .command("rename <name> <new_name>")
  .description("Rename a profile")
  .action(async (name: string, newName: string) => {
    await renameCmd(name, newName);
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
  .command("show [name]")
  .description("Show a profile's details (defaults to the current default profile)")
  .action((name?: string) => {
    showCmd(name);
  });

// nvm-style `use` subcommand (see src/commands/use.ts) — aligned with ../ccswi
registerUse(program);

// ============================================================================
// main routing — Commander owns management command registration; classifyRoute
// only decides whether argv belongs to Commander or the wrapped Claude process.
// ============================================================================

async function main(): Promise<void> {
  const route = classifyRoute(program, process.argv.slice(2));

  switch (route.kind) {
    case "commander":
      await program.parseAsync(route.argv, { from: "user" });
      return;
    case "default":
      await launchDefault(route.claudeArgs, route.debug);
      return;
    case "profile":
      await launchCmd(route.profile, route.claudeArgs, route.debug);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

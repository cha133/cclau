import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { classifyRoute, isRegisteredSubcommand } from "../src/routing.js";

function makeProgram(): Command {
  const program = new Command();
  program.command("rename <name> <new_name>");
  program.command("rm <name>").alias("remove");
  program.command("ls").alias("list");
  return program;
}

describe("registered subcommand discovery", () => {
  const program = makeProgram();

  test("uses Commander command names and aliases as the source of truth", () => {
    expect(isRegisteredSubcommand(program, "rename")).toBe(true);
    expect(isRegisteredSubcommand(program, "remove")).toBe(true);
    expect(isRegisteredSubcommand(program, "list")).toBe(true);
    expect(isRegisteredSubcommand(program, "missing")).toBe(false);
  });

  test("recognizes Commander's implicit help command", () => {
    expect(isRegisteredSubcommand(program, "help")).toBe(true);
  });
});

describe("CLI routing matrix", () => {
  const program = makeProgram();

  test("no args launches the default profile", () => {
    expect(classifyRoute(program, [])).toEqual({
      kind: "default",
      claudeArgs: [],
      debug: false,
    });
  });

  test("registered command and alias go to Commander", () => {
    expect(classifyRoute(program, ["rename", "old", "new"])).toMatchObject({
      kind: "commander",
      argv: ["rename", "old", "new"],
    });
    expect(classifyRoute(program, ["remove", "old"])).toMatchObject({
      kind: "commander",
      argv: ["remove", "old"],
    });
  });

  test("sole help/version flags go to Commander", () => {
    for (const flag of ["-h", "--help", "-v", "--version"]) {
      expect(classifyRoute(program, [flag])).toMatchObject({
        kind: "commander",
        argv: [flag],
      });
    }
  });

  test("leading Claude flags launch the default and preserve argv", () => {
    expect(classifyRoute(program, ["--help", "prompt"])).toEqual({
      kind: "default",
      claudeArgs: ["--help", "prompt"],
      debug: false,
    });
  });

  test("unknown positional is a profile and preserves following Claude args", () => {
    expect(classifyRoute(program, ["work", "--help", "-c"])).toEqual({
      kind: "profile",
      profile: "work",
      claudeArgs: ["--help", "-c"],
      debug: false,
    });
  });

  test("version is not a phantom subcommand", () => {
    expect(classifyRoute(program, ["version"])).toEqual({
      kind: "profile",
      profile: "version",
      claudeArgs: [],
      debug: false,
    });
  });

  test("strips every cclau debug flag before either route", () => {
    expect(
      classifyRoute(program, ["--cclau-debug", "rename", "old", "new", "--cclau-debug"]),
    ).toEqual({
      kind: "commander",
      argv: ["rename", "old", "new"],
      debug: true,
    });
    expect(classifyRoute(program, ["work", "--cclau-debug", "-c"])).toEqual({
      kind: "profile",
      profile: "work",
      claudeArgs: ["-c"],
      debug: true,
    });
  });
});

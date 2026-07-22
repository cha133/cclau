import type { Command } from "commander";

const INTERCEPT_FLAGS = new Set(["-h", "--help", "-v", "--version"]);
const CCLAU_DEBUG_FLAG = "--cclau-debug";

export type CliRoute =
  | { kind: "commander"; argv: string[]; debug: boolean }
  | { kind: "default"; claudeArgs: string[]; debug: boolean }
  | { kind: "profile"; profile: string; claudeArgs: string[]; debug: boolean };

/** Commander is the source of truth for management command names and aliases. */
export function isRegisteredSubcommand(program: Command, name: string): boolean {
  if (name === "help") return true; // Commander's implicit help command.
  return program.commands.some(
    (command) => command.name() === name || command.aliases().includes(name),
  );
}

/**
 * Split cclau management commands from Claude Code launch invocations while
 * preserving Claude's argv byte-for-byte, apart from cclau-owned flags.
 */
export function classifyRoute(program: Command, rawArgv: string[]): CliRoute {
  const debug = rawArgv.includes(CCLAU_DEBUG_FLAG);
  const argv = rawArgv.filter((arg) => arg !== CCLAU_DEBUG_FLAG);
  const firstArg = argv[0];

  if (firstArg === undefined) {
    return { kind: "default", claudeArgs: [], debug };
  }

  // Only intercept root help/version when used alone. In every other shape,
  // leading flags belong to Claude Code.
  if (argv.length === 1 && INTERCEPT_FLAGS.has(firstArg)) {
    return { kind: "commander", argv, debug };
  }

  if (firstArg.startsWith("-")) {
    return { kind: "default", claudeArgs: argv, debug };
  }

  if (isRegisteredSubcommand(program, firstArg)) {
    return { kind: "commander", argv, debug };
  }

  return {
    kind: "profile",
    profile: firstArg,
    claudeArgs: argv.slice(1),
    debug,
  };
}

# CLAUDE.md

Project guidance for Claude Code when working on this repository.

## What this is

`cclau` is a launcher for [Claude Code](https://docs.claude.com/en/docs/claude-code) that lets you switch between API endpoints (DeepSeek, MiniMax, Moonshot Kimi, OpenCode Go, custom) via named profiles. A local sidecar server kicks in automatically when the active profile's mode requires protocol translation or request/response patching.

See [README.md](./README.md) for end-user docs (install, usage, configuration).

## Project layout

```
src/
  cli.ts                 # 5-layer routing + commander subcommand registration
  commands/              # add, edit, rm, ls, show, default, launch
  server/                # sidecar HTTP server + protocol conversion
  core/                  # pure helpers (fuzzy, 1m, model-fetch)
  utils/                 # paths, logger (picocolors), names, upstream-url, table
  types.ts               # Profile + Mode + Anthropic/OpenAI protocol types
  config.ts              # TOML CRUD on $XDG_CONFIG_HOME/cclau/config.toml
  settings.ts            # claude --settings JSON generation
  builtins.ts            # vendor preset table
  preset-rules.ts        # built-in rectifier presets (opencode-go, kimi)
  cli.ts                 # entry point + subcommand routing
bin/cclau.js             # bun shim: import("../src/cli.ts")
tests/                   # bun test, isolated via CCLAU_CONFIG env var
```

## Conventions

- **Runtime**: Bun only (>= 1.0). Never use node / npm.
- **Language**: TypeScript with `strict` + `noUncheckedIndexedAccess`.
- **Tests**: `bun test` runs `tests/*.test.ts`. No third-party test framework. Use `CCLAU_CONFIG` env var to redirect config path for isolation.
- **Config**: TOML via `smol-toml`. Schema is a single `[profiles.<name>]` table.
- **CLI deps**: `commander`, `smol-toml`, `picocolors`, `@clack/prompts` (add / edit wizards only).
- **User-facing language**: English (errors, help text, comments). Commit messages: mixed English + Chinese OK.

## Common commands

```bash
bun install                  # install deps
bun run dev --help           # run src/cli.ts directly (dev mode)
bun run typecheck            # tsc --noEmit (strict + noUncheckedIndexedAccess)
bun test                     # run tests/*.test.ts (isolated via CCLAU_CONFIG)
bun run verify               # typecheck && bun test
```

## Architecture invariants

These are load-bearing — do not change without updating tests in lockstep.

1. **Single profile concept** — no provider / multi-tier model split. Each `Profile` has exactly one `model`. Three modes:
   - `direct` (anthropic, zero-hop, no sidecar)
   - `rectify` (anthropic + rectifier hooks via sidecar)
   - `openai` (openai chat → anthropic conversion via sidecar)

2. **Settings file (4 env vars all equal)** — `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_OPUS_MODEL` + `ANTHROPIC_DEFAULT_SONNET_MODEL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`. The last four all hold the same `apply1m(profile.model, profile.supports1m)` value.

3. **Sidecar registry key** — `strip1m(profile.model)`. claude-code's `normalizeModelStringForAPI` strips `[1m]` before sending, so the key matches the bare model name. No provider prefix (single profile owns its own endpoint).

4. **Rectifier mounts only in rectify mode** — `entry.rectifier` is `undefined` for `direct` and `openai`.

5. **Default profile mechanism** — at most one profile can have `default: true`. `cclau default <name>` sets it and clears others atomically.

## Adding a new vendor preset

1. Add entry to `BUILTIN_PRESETS` in `src/builtins.ts`.
2. (Optional) If the upstream needs protocol patching, add a `Rectifier` to `BUILTIN_PRESETS` in `src/preset-rules.ts` and document it in README.
3. Run `bun test` to confirm nothing broke; the presets are validated by `tests/config.test.ts` and `tests/registry.test.ts`.
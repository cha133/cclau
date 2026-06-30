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
    index.ts             # Bun.serve, /v1/messages dispatcher
    registry.ts          # model → RouteEntry (always 1 entry per profile)
    anthropic-passthrough.ts  # direct / rectify stream + unary forward
    openai-to-anthropic.ts    # OpenAI Chat-Completions → Anthropic Messages
    rectify.ts           # AnthropicRectifier hooks (request/response/stream)
  core/                  # pure helpers (1m marker, model fetching)
  utils/                 # paths, logger (picocolors), names, upstream-url, table
  fuzzy.ts               # profile name fuzzy matching
  port.ts                # findFreePort (default 3133)
  process.ts             # spawn `claude --settings <temp.json>` child process
  types.ts               # Profile + Mode + Anthropic/OpenAI protocol types
  config.ts              # TOML CRUD on $XDG_CONFIG_HOME/cclau/config.toml
  settings.ts            # resolveLaunch + writeSettingsFile (writes temp file)
  builtins.ts            # vendor preset table (endpoint / mode / apiKey hint)
  preset-rules.ts        # built-in rectifier presets (opencode-go, kimi)
bin/cclau.js             # bun shim: import("../src/cli.ts")
tests/                   # bun test, isolated via CCLAU_CONFIG env var
tests/e2e/               # sidecar-routing integration tests (real Bun.serve)
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
bun test tests/foo.test.ts   # run a single test file
bun run verify               # typecheck && bun test
```

`CCLAU_CONFIG=/tmp/cclau-test.toml bun test …` is how tests redirect the
config path to keep parallel runs / global config from interfering.

## Architecture invariants

These are load-bearing — do not change without updating tests in lockstep.

1. **Single profile concept** — no provider / multi-tier model split. Each `Profile` has exactly one `model`. Three modes:
   - `direct` (anthropic, zero-hop, no sidecar; `ANTHROPIC_BASE_URL = profile.endpoint`)
   - `rectify` (anthropic + rectifier hooks via sidecar; `ANTHROPIC_BASE_URL = http://127.0.0.1:<port>`)
   - `openai` (openai chat → anthropic conversion via sidecar; `ANTHROPIC_BASE_URL = http://127.0.0.1:<port>`)

2. **Settings file (4 model env vars all equal)** — `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL` + `ANTHROPIC_DEFAULT_OPUS_MODEL` + `ANTHROPIC_DEFAULT_SONNET_MODEL` + `ANTHROPIC_DEFAULT_HAIKU_MODEL`. The last four all hold the same `apply1m(profile.model, profile.supports1m)` value. The temp file is written via `writeSettingsFile` to `$INVOCATION_DIR/invocation-<uuid>.json`; it is `claude --settings <path>`'d, never `~/.claude/settings.json`. Cleanup runs on signal/exit.

3. **Settings deep-merge** — Claude Code deep-merges `--settings` over global settings (lodash `mergeWith` → source order user → project → local → flag → policy). Our temp file only writes `env`: all other fields merge through unchanged. Don't write fields here expecting to "reset" global state; deep merge just keeps it. To override, set the field explicitly in `env` (or the nested object).

4. **Sidecar registry key** — `strip1m(profile.model)`. claude-code's `normalizeModelStringForAPI` strips `[1m]` before sending, so the sidecar receives the already-stripped name. The registry (always 1 entry per launch) must match on that form. No provider prefix (single profile owns its own endpoint).

5. **Rectifier mounts only in rectify mode** — `entry.rectifier` is `undefined` for `direct` and `openai`. `__CCLAU_BEARER_APIKEY__` is a sentinel in TOML that the runtime substitutes with `profile.apiKey` at request time — keeps secrets out of disk.

6. **Default profile mechanism** — at most one profile can have `default: true`. `cclau default <name>` sets it and clears others atomically. `cclau default` (no arg) prints the active name (nvm-style). If the current default is removed, the alphabetically-first remaining profile is auto-promoted; if none remain, the default is cleared.

7. **First add becomes default** — `cclau add` marks the new profile `default: true` IFF it's the first profile ever added. Subsequent adds leave the existing default alone. Removing a non-default profile does not change which is default.

## Adding a new vendor preset

1. Add entry to `BUILTIN_PRESETS` in `src/builtins.ts`.
2. (Optional) If the upstream needs protocol patching, add a `Rectifier` to `BUILTIN_PRESETS` in `src/preset-rules.ts` and document it in README.
3. Run `bun test` to confirm nothing broke; the presets are validated by `tests/config.test.ts` and `tests/registry.test.ts`.
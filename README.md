# cclau

Claude Code launcher with profile manager.

`cclau` wraps [Claude Code](https://docs.claude.com/en/docs/claude-code) so you can switch between API endpoints (DeepSeek, MiniMax, Moonshot Kimi, OpenCode Go, custom, …) without editing settings files. Each *profile* carries its own endpoint, API key, and mode (direct / rectify / openai); a local sidecar server kicks in automatically when needed.

## Install

```bash
# Bun runtime required (>= 1.0)
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/cha133/cclau.git
cd cclau
bun install
bun link          # expose `cclau` globally
```

## Quick start

```bash
cclau add           # interactive wizard: vendor → mode → endpoint → key → model → 1m → name
cclau default work  # mark "work" as the default profile
cclau               # launch Claude Code with the default profile
cclau work          # launch Claude Code with a specific profile
cclau work -c       # launch with claude args (everything after profile name passes through)
```

## Commands

| Command | Purpose |
|---|---|
| `cclau add` | Interactively add a profile |
| `cclau edit <name>` | Edit a profile (endpoint / key / mode / model / 1m / default) |
| `cclau rm <name>` | Remove a profile |
| `cclau ls` | List all profiles |
| `cclau show <name>` | Show profile details |
| `cclau default [name]` | Show or set the default profile (nvm-style) |
| `cclau <name> [claude args…]` | Launch Claude Code with a profile |
| `cclau -h` / `cclau --help` | Show cclau help |
| `cclau -v` / `cclau --version` | Show cclau version |

Routing rules (in priority order):

1. `cclau` (no args) → launch the default profile
2. `cclau -h` / `cclau --help` (as the only argument) → cclau help (intercepts Claude Code's own `-h`)
3. `cclau -X` (any other flag) → launch the default profile, pass everything after to Claude Code
4. `cclau <known-subcommand>` → commander subcommand
5. `cclau <name>` → fuzzy-match a profile, pass everything after to Claude Code

## Modes

Each profile is one of three modes:

| Mode | Sidecar | Use when |
|---|---|---|
| `direct` | No | Anthropic-protocol upstream, no protocol fixes needed (fastest, zero hop) |
| `rectify` | Yes | Anthropic-protocol upstream that needs request/response patching (e.g. OpenCode Go dual auth, Kimi thinking-type normalization) |
| `openai` | Yes | OpenAI Chat-Completions upstream that needs protocol translation to Anthropic Messages |

The sidecar listens on `127.0.0.1:3133` (or next free port) and is torn down when Claude Code exits.

## Vendor presets

`cclau add` ships with these built-in presets:

- **DeepSeek** — `https://api.deepseek.com/anthropic`, mode `direct`
- **MiniMax** — `https://api.minimaxi.com/anthropic`, mode `direct`
- **Xiaomi MiMo** — `https://api.xiaomimimo.com/anthropic`, mode `direct`
- **OpenCode Go** — `https://opencode.ai/zen/go`, mode `direct` (rectifier preset available)
- **Custom** — you pick endpoint and mode

## Built-in rectifier presets

Available when adding a profile in `rectify` mode:

- **OpenCode Go** — adds an `Authorization: Bearer <apiKey>` header alongside the default `x-api-key` (fixes 401 on OpenCode Go)
- **Kimi** — normalizes `thinking.type` to the supported string values (fixes 400 on Kimi thinking effort)

## Configuration file

Path: `$XDG_CONFIG_HOME/cclau/config.toml` (defaults to `~/.config/cclau/config.toml`). Manually editable.

```toml
[profiles.work]
endpoint = "https://api.deepseek.com/anthropic"
apiKey = "sk-..."
mode = "direct"
model = "deepseek-chat"
supports1m = true
default = true
createdAt = 1750000000000
updatedAt = 1750000000000

[profiles.workbench]
endpoint = "https://opencode.ai/zen/go"
apiKey = "sk-..."
mode = "rectify"
model = "big-pickle"
supports1m = false
createdAt = 1750000000000
updatedAt = 1750000000000

[profiles.workbench.rectifier.anthropic]
requestHeaders = { Authorization = "Bearer __CCLAU_BEARER_APIKEY__" }
```

`__CCLAU_BEARER_APIKEY__` is a sentinel replaced at request time with the profile's actual API key — keep secrets out of TOML.

## 1M context

Set `supports1m = true` and Claude Code will use the 1M context window when given a flag like `--context 1m`. The `[1m]` marker is a Claude Code internal hint and is stripped before the request leaves the sidecar — upstream never sees it.

## Behavior notes

- **First profile added becomes the default automatically** — `cclau` (no args) works immediately after `cclau add`. Subsequent adds do NOT auto-default; pick explicitly with `cclau default <name>`.
- **Removing the current default profile auto-promotes the next one** (alphabetical, first by name) so `cclau` keeps working. If you remove the last profile, the default is cleared — add a new one and run `cclau default <name>` to set it.
- **Profile fields not specified in the wizard are left at their default** — `add` always sets `supports1m` and `mode`; `edit` lets you change any of `endpoint / apiKey / mode / model / supports1m / default`. To tweak things the wizard doesn't expose, hand-edit the TOML.

## Development

```bash
bun install
bun run dev --help         # run src/cli.ts directly
bun run typecheck          # tsc --noEmit (strict + noUncheckedIndexedAccess)
bun test                   # bun test, isolated via CCLAU_CONFIG env var
bun run verify             # typecheck && bun test
```

## License

MIT
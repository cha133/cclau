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
cclau use work      # mark "work" as the default profile
cclau               # launch Claude Code with the default profile
cclau work          # launch Claude Code with a specific profile
cclau work -c       # launch with claude args (everything after profile name passes through)
```

## Commands

| Command | Purpose |
|---|---|
| `cclau add` | Interactively add a profile |
| `cclau edit <name>` | Edit a profile (endpoint / key / mode / model / 1m) |
| `cclau rm <name>` | Remove a profile |
| `cclau ls` | List all profiles |
| `cclau show <name>` | Show profile details |
| `cclau use [name]` | Show or set the active profile (nvm-style) |
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
- **Moonshot Kimi** — `https://api.moonshot.cn/anthropic`, mode `rectify` (rectifier preset available)
- **OpenCode Go** — `https://opencode.ai/zen/go`, mode `rectify` (rectifier preset available)
- **Custom** — you pick endpoint and mode

## Built-in rectifier presets

The wizard shows a mode-aware single-select picker. Same vendor name may resolve to a different rule body depending on the profile's `mode`:

- **rectify mode** (anthropic-protocol sidecar → upstream):
  - **opencode-go** — adds an `Authorization: Bearer <apiKey>` header alongside the default `x-api-key` (fixes 401 on OpenCode Go)
  - **kimi** — normalizes `thinking.type` to the supported string values (fixes 400 on Kimi thinking effort)
  - **strip-images** — removes `image` content blocks from `messages` (also nested in `tool_result.content` and `system`) for vision-incapable upstreams/models like `mimo-v2.5-pro` (fixes "model does not support image" 4xx)
- **openai mode** (anthropic → openai-converted → upstream):
  - **opencode-go** — drops `thinking` when `reasoning_effort` is also set (avoids opencode-go's chat-completions endpoint returning HTTP 400 "cannot specify both")

Why split: cclau's openai mode routes to opencode-go's chat-completions endpoint, which has different protocol quirks than its anthropic-messages endpoint. Each vendor name is a single namespace entry point; the actual hook surface is mode-dependent.

Default-mode heuristic: when you pick a vendor with its own rule (OpenCode Go, Kimi), the wizard pre-selects `rectify` so the rule picker actually appears in the next step — and the matching rule is pre-selected there too (press Enter twice to accept both). Vendors without a dedicated rule (DeepSeek, MiniMax, MiMo) default to `direct`. Custom vendors leave the mode picker open.

In the rule picker you can also pick any other rule from the list to borrow a workaround for a different vendor's quirk. To skip entirely, choose `none (no rectifier)`; you can also hand-edit TOML afterwards. A name that's listed for rectify but not for openai mode silently does nothing if the profile's mode doesn't apply to it (no error).

## Configuration file

Path: `$XDG_CONFIG_HOME/cclau/config.toml` (defaults to `~/.config/cclau/config.toml`). Manually editable.

```toml
default = "work"

[profiles.work]
endpoint = "https://api.deepseek.com/anthropic"
apiKey = "sk-..."
mode = "direct"
model = "deepseek-chat"
supports1m = true
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
rectifier = "opencode-go"
```

`rectifier = "opencode-go"` is an opaque name reference — the profile only declares *which* built-in rule to use; the concrete hook (e.g. `Authorization: Bearer` header) lives in code (`src/preset-rules.ts`) and is resolved at sidecar boot via `resolveRectifierByName`. Unknown names fall through to no-op with a warning.

## 1M context

Set `supports1m = true` and Claude Code will use the 1M context window when given a flag like `--context 1m`. The `[1m]` marker is a Claude Code internal hint and is stripped before the request leaves the sidecar — upstream never sees it.

## Behavior notes

- **First profile added becomes the default automatically** — `cclau` (no args) works immediately after `cclau add`. Subsequent adds do NOT auto-default; pick explicitly with `cclau use <name>`. The trigger is lazy: a dangling `default` (references a profile that no longer exists) is treated as unset, so the next `cclau add` overwrites it.
- **Removing the current default profile auto-promotes the next one** (alphabetical, first by name) so `cclau` keeps working. If you remove the last profile, the `default` key is left stale (pointing at the removed name) — the next `cclau add` overwrites it, or run `cclau use <name>` after to set explicitly.
- **The default profile lives at the top of `config.toml`** as `default = "<profile-name>"` (single source of truth; multi-default cannot occur). `cclau edit` does NOT change the default — use `cclau use <other>` to switch.
- **Profile fields not specified in the wizard are left at their default** — `add` always sets `supports1m` and `mode`; `edit` lets you change any of `endpoint / apiKey / mode / model / supports1m`. To tweak things the wizard doesn't expose, hand-edit the TOML.
- **Upgrading from a pre-global-default config** — if you have a `default = true` line under any `[profiles.<name>]` from a previous cclau version, every command will refuse to run until you migrate. Hand-delete those `default = true` lines from your `config.toml`, then run `cclau use <your-default-name>` once.

## Debugging

```bash
cclau opencode-go --cclau-debug    # writes per-session log
cclau --cclau-debug                # default profile + debug
```

The flag is consumed by cclau itself (never forwarded to claude code), and turns on the sidecar's debug log:

- **Location**: `$XDG_STATE_HOME/cclau/debug-{ISO timestamp}.log` (default `~/.local/state/cclau/debug-…log`)
- **Naming**: every `cclau` invocation gets its own timestamped file. Old files are kept — `rm ~/.local/state/cclau/debug-*.log` to clear
- **Contents**: inbound request (claude-code → sidecar), outbound request (sidecar → upstream), and upstream SSE chunks (one per chunk). Header values matching `*api*key*` / `*authorization*` / `*bearer*` / `*token*` are redacted to first-4 + bullets + last-4 so full credentials never land on disk
- **Compare two sessions**: `diff debug-A.log debug-B.log` — useful for diagnosing "sometimes thinking, sometimes not" by lining up the `body.thinking` field sent upstream

This is independent of claude code's own `--debug`. cclau's flag records what the sidecar saw; claude code's flag records what its CLI saw. They cover different layers.

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
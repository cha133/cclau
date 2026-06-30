// Built-in rectifier presets (preset → Rectifier bridge)
//
// Distinct from src/builtins.ts:
// - builtins.ts is the "endpoint + mode + label" preset for the add wizard
// - preset-rules.ts is the "rectifier rules" paired with builtin presets (optional, asked during add)
//
// v1 ships 2 rules (solving 2 concrete pain points):
// 1. opencode-go 401: dual auth header (x-api-key + Authorization: Bearer)
// 2. kimi thinking 400: normalize thinking.type value domain
//
// Add a new rule: export a preset constant here + add it to BUILTIN_PRESETS.

import type { AnthropicRectifier, AnthropicRequest } from "./types.js";

/**
 * Sentinel for requestHeaders values: when a header value equals this string,
 * anthropic-passthrough substitutes it with "Bearer ${apiKey}".
 * Keeps apiKey out of TOML (apiKey is runtime-only).
 */
export const BEARER_APIKEY_SENTINEL = "__CCLAU_BEARER_APIKEY__";

/**
 * opencode-go preset: inject Authorization: Bearer dual-auth header
 *
 * Pain point: opencode-go's anthropic-messages endpoint requires both x-api-key
 * and Authorization: Bearer; cclau defaults to x-api-key only → 401.
 * (See C:\Dev\proxy\internal\provider\opencode_go.go:188-189)
 */
export const OPENCODE_GO_PRESET: AnthropicRectifier = {
  requestHeaders: { Authorization: BEARER_APIKEY_SENTINEL },
};

/**
 * kimi preset: normalize thinking.type value domain
 *
 * Pain point: Kimi's anthropic-messages-compatible endpoint (api.moonshot.cn/anthropic)
 * only accepts thinking.type: "enabled" | "disabled" string literals.
 * Claude Code and other clients send effort shorthand ("high"/"medium"/"low"/"xhigh"/"max"/"adaptive")
 * and boolean true/false → 400.
 *
 * Strategy: any value other than explicit "disabled" → normalize to "enabled";
 * boolean false / null → "disabled". Future upstream effort names auto-compat.
 *
 * Ported from cctra normalize-thinking-type (src/convert/upstream/rectify/rules/normalize-thinking-type.ts),
 * adapted to cclau's AnthropicRequest (type literal is "enabled", no "disabled" literal — but enabled is also union).
 */
export const KIMI_PRESET: AnthropicRectifier = {
  requestTransform: (req: AnthropicRequest): AnthropicRequest => {
    if (!req.thinking) return req;
    const t = req.thinking;
    // already explicit "disabled" (any case) → leave alone
    if (typeof t.type === "string" && t.type.toLowerCase() === "disabled") return req;
    // boolean false / null → "disabled"
    if (t.type === false || t.type === null) {
      return { ...req, thinking: { ...t, type: "disabled" } };
    }
    // other (effort shorthand "high"/"medium"/"low"/"xhigh"/"max"/"adaptive" / boolean true / number) → "enabled"
    return { ...req, thinking: { ...t, type: "enabled" } };
  },
};

/** preset name → default Rectifier (no rule → not in dict, add wizard uses .has() to check) */
export const BUILTIN_PRESETS: Record<string, AnthropicRectifier> = {
  "opencode-go": OPENCODE_GO_PRESET,
  kimi: KIMI_PRESET,
};

/**
 * Resolve a profile-level rectifier name (the string the user wrote in TOML
 * or picked in the wizard) to the concrete AnthropicRectifier implementation.
 *
 * The profile schema stores an opaque name only — registry build calls this
 * to translate. Unknown names return undefined (silent no-op); caller decides
 * whether to log/warn.
 */
export function resolveRectifierByName(
  name: string | undefined,
): AnthropicRectifier | undefined {
  if (!name) return undefined;
  return BUILTIN_PRESETS[name];
}

/**
 * Wizard UI metadata for each built-in rule. Keys MUST stay aligned 1:1
 * with `BUILTIN_PRESETS` (consumed by promptAdd's rectifier picker to render
 * the p.select options). When you add a new rule to BUILTIN_PRESETS, add a
 * matching entry here too — preset-rules.test.ts enforces the alignment.
 */
export const RULE_DEFS: Record<string, { label: string; hint: string }> = {
  "opencode-go": {
    label: "opencode-go — dual auth header",
    hint: "adds Authorization: Bearer <apiKey> alongside x-api-key (fixes 401)",
  },
  kimi: {
    label: "kimi — normalize thinking.type",
    hint: "coerce thinking.type to 'enabled' / 'disabled' string (fixes 400)",
  },
};

/**
 * Resolve Rectifier.requestHeaders sentinels:
 * values equal to BEARER_APIKEY_SENTINEL → replaced with "Bearer ${apiKey}", others pass through.
 *
 * Called by anthropic-passthrough.ts when merging upstream request headers.
 */
export function resolvePresetHeaders(
  rect: AnthropicRectifier | undefined,
  apiKey: string,
): Record<string, string> {
  if (!rect?.requestHeaders) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rect.requestHeaders)) {
    out[k] = v === BEARER_APIKEY_SENTINEL ? `Bearer ${apiKey}` : v;
  }
  return out;
}
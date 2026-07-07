// Built-in rectifier presets (preset → Rectifier bridge)
//
// Distinct from src/builtins.ts:
// - builtins.ts is the "endpoint + mode + label" preset for the add wizard
// - preset-rules.ts is the "rectifier rules" paired with builtin presets (optional, asked during add)
//
// v1 ships 3 rules (solving 3 concrete pain points):
// 1. opencode-go 401: dual auth header (x-api-key + Authorization: Bearer)
// 2. kimi thinking 400: normalize thinking.type value domain
// 3. strip-images: drop image content blocks for vision-incapable upstreams/models
//
// Add a new rule: export a preset constant here + add it to BUILTIN_PRESETS.

import type {
  AnthropicContentBlock,
  AnthropicRectifier,
  AnthropicRequest,
  OpenAIRequest,
} from "./types.js";

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

/**
 * strip-images preset: drop `image` content blocks before forwarding upstream
 *
 * Pain point: claude-code sends `image` content blocks whenever the user
 * attaches an image (e.g. drag-drop, paste, screenshot tool). Upstreams /
 * models that do not support vision reject these with 4xx, surfacing to the
 * user as "There's an issue with the selected model ..." in claude-code.
 * This preset strips `image` blocks from the request so the upstream sees
 * only the text it can handle.
 *
 * Not bound to a fixed provider — works for any vision-incapable
 * upstream/model the user picks (e.g. mimo-v2.5-pro, GLM text-only tiers,
 * custom self-hosted models).
 *
 * Strip scope:
 *   - `messages[*].content` (when array form)
 *   - recursive into `messages[*].content[*].tool_result.content` (when array)
 *     — tool return values can carry images (screenshot tools, vision tools)
 *   - `system` (when array form)
 *
 * If stripping empties a message's content array entirely, replace with a
 * single placeholder text block so the turn keeps its place in the
 * conversation. If stripping empties `system`, drop the field entirely.
 *
 * Pure / immutable: returns the same `req` reference when nothing changed.
 */
const STRIP_IMAGES_PLACEHOLDER = "[image stripped by cclau — model does not support vision]";

/** Strip image blocks from a content array. Recurses into tool_result.content
 *  (when array) so screenshot tools / vision tools' outputs are also sanitized.
 *  Returns the SAME array reference if nothing changed (lets callers detect
 *  "no work" via ===). Otherwise returns a new array; original input is
 *  not mutated. */
function stripImagesFromBlocks(
  blocks: readonly AnthropicContentBlock[],
): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  let changed = false;
  for (const block of blocks) {
    if (block.type === "image") {
      changed = true;
      continue;
    }
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      const nested = stripImagesFromBlocks(block.content);
      if (nested === block.content) {
        // Inner content unchanged → reuse original block reference.
        out.push(block);
      } else {
        changed = true;
        // If every nested block was an image, collapse content to "" so the
        // upstream receives a valid (empty-string) tool_result rather than [].
        const newContent: string | AnthropicContentBlock[] = nested.length === 0 ? "" : nested;
        out.push({ ...block, content: newContent });
      }
      continue;
    }
    out.push(block);
  }
  return changed ? out : (blocks as AnthropicContentBlock[]);
}

export const STRIP_IMAGES_PRESET: AnthropicRectifier = {
  requestTransform: (req: AnthropicRequest): AnthropicRequest => {
    let messagesChanged = false;
    const messages = req.messages.map((msg) => {
      if (typeof msg.content === "string") return msg;
      const stripped = stripImagesFromBlocks(msg.content);
      if (stripped === msg.content) return msg; // no images touched, same ref
      messagesChanged = true;
      // All blocks were images — keep the turn with a placeholder so the
      // conversation ordering is preserved and the user sees what happened.
      if (stripped.length === 0) {
        const placeholder: AnthropicContentBlock = {
          type: "text",
          text: STRIP_IMAGES_PLACEHOLDER,
        };
        return { ...msg, content: [placeholder] };
      }
      return { ...msg, content: stripped };
    });

    let systemChanged = false;
    let system: AnthropicRequest["system"] = req.system;
    if (Array.isArray(system)) {
      const stripped = stripImagesFromBlocks(system);
      if (stripped !== system) {
        systemChanged = true;
        // If the whole system prompt was images (rare), drop it entirely.
        system = stripped.length === 0 ? undefined : stripped;
      }
    }

    if (!messagesChanged && !systemChanged) return req;
    return systemChanged ? { ...req, messages, system } : { ...req, messages };
  },
};

/** preset name → default Rectifier (no rule → not in dict, add wizard uses .has() to check) */
export const BUILTIN_PRESETS: Record<string, AnthropicRectifier> = {
  "opencode-go": OPENCODE_GO_PRESET,
  kimi: KIMI_PRESET,
  "strip-images": STRIP_IMAGES_PRESET,
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

// ============================================================================
// OpenAI-mode rectifier presets (openai → upstream in chat-completions shape)
// ============================================================================
//
// Distinct from the anthropic BUILTIN_PRESETS above: same name space (vendor
// name = rule key) but different hook surface. resolveOpenAIRectifierByName
// looks up here; resolveRectifierByName looks up the anthropic dict.
//
// Per plan B (dual-mode per vendor name): when user picks vendor "opencode-go"
// + rectifier "opencode-go", the lookup is mode-aware:
//   - rectify mode  → anthropic rule (auth header)
//   - openai mode   → openai rule (drop thinking when reasoning_effort present)
//
// v1 ships 1 openai rule:
//   1. opencode-go: drop `thinking` when `reasoning_effort` is also present
//      (avoids HTTP 400 from opencode-go's chat-completions endpoint, which
//      rejects both fields together. Applies to kimi / deepseek / glm / etc.
//      all routed through opencode-go, not glm-specific.)

/**
 * opencode-go (openai mode): drop both `thinking` and `reasoning_effort` so
 * Fireworks GLM-5.2 auto-enables its default (Max) reasoning tier.
 *
 * Pain point 1 (400 avoidance): opencode-go's chat-completions endpoint
 * rejects requests with both `thinking` and `reasoning_effort` set (HTTP
 * 400 "cannot specify both"). Drop `thinking` when `reasoning_effort` is
 * also present so the request is accepted.
 *
 * Pain point 2 (tier model — the deeper reason to drop both): Fireworks
 * GLM only auto-enables the default (Max) reasoning tier when NEITHER
 * `thinking` nor `reasoning_effort` is present. Setting either field —
 * graded value (low/medium/high/xhigh/max), shorthand (`adaptive`), or
 * any other value — locks GLM into `adaptive` thinking, a lower tier
 * than what users typically want when they typed `/effort high`.
 *
 * Dropping the graded `reasoning_effort` lets Fireworks fall back to
 * default Max, which is what the user actually wanted. (Side note: the
 * Max tier is also the only path that surfaces `reasoning_content` to
 * the response — graded tiers land reasoning in trace only.)
 *
 * Net behavior with this preset enabled:
 *   - claude-code `/effort high` → cclau drops effort → Fireworks default
 *     Max → user sees reasoning_content. Without this preset, user sees
 *     a silent "I asked for high but got default anyway" trap.
 *   - claude-code `/effort none` → preserved as `none` → Fireworks disables
 *     thinking → user gets a non-thinking response as expected.
 *
 * `none` and `false` are preserved explicitly (different semantic: they
 * intentionally disable thinking rather than request "deeper thinking").
 */
export const OPENCODE_GO_OPENAI_PRESET = {
  requestTransform: (req: OpenAIRequest): OpenAIRequest => {
    let out: OpenAIRequest = req;

    // 1. opencode-go 400: drop `thinking` when `reasoning_effort` is set.
    if (out.reasoning_effort !== undefined && out.thinking !== undefined) {
      const { thinking: _dropThinking, ...rest } = out;
      void _dropThinking;
      out = rest;
    }

    // 2. Fireworks GLM-5.2 graded-tier quirk: drop effort so Fireworks
    //    falls back to default Max tier (which surfaces reasoning_content).
    //    Preserve explicit-disable (`none` / `false`).
    if (
      typeof out.reasoning_effort === "string" &&
      out.reasoning_effort !== "none" &&
      out.reasoning_effort !== "false"
    ) {
      const { reasoning_effort: _dropEffort, ...rest } = out;
      void _dropEffort;
      out = rest;
    }

    return out;
  },
};

/** preset name → default OpenAI-protocol rectifier. Same name space as the
 *  anthropic BUILTIN_PRESETS dict above but indexed separately. */
export const BUILTIN_PRESETS_OPENAI: Record<
  string,
  { requestTransform?: (req: OpenAIRequest) => OpenAIRequest }
> = {
  "opencode-go": OPENCODE_GO_OPENAI_PRESET,
};

/**
 * Wizard UI metadata for openai-mode rules. Keys MUST stay aligned 1:1
 * with `BUILTIN_PRESETS_OPENAI` (consumed by promptAdd's rectifier picker
 * to render the p.select options in openai mode). When you add a new rule
 * to BUILTIN_PRESETS_OPENAI, add a matching entry here too — preset-rules
 * tests enforce alignment.
 */
export const RULE_DEFS_OPENAI: Record<string, { label: string; hint: string }> = {
  "opencode-go": {
    label: "opencode-go — strip effort for max reasoning",
    hint:
      "drop both `thinking` and `reasoning_effort`: Fireworks GLM only " +
      "auto-enables max reasoning when neither field is set — any value " +
      "(graded or otherwise) locks it to adaptive. Also avoids 400 from " +
      "passing both.",
  },
};

/**
 * Resolve a profile-level rectifier name to the OpenAI-protocol rectifier.
 * Unknown names return undefined (silent no-op); caller decides whether to
 * log/warn.
 */
export function resolveOpenAIRectifierByName(
  name: string | undefined,
): { requestTransform?: (req: OpenAIRequest) => OpenAIRequest } | undefined {
  if (!name) return undefined;
  return BUILTIN_PRESETS_OPENAI[name];
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
  "strip-images": {
    label: "strip-images — drop image content blocks",
    hint: "removes image blocks from messages (use for vision-incapable models like mimo-v2.5-pro)",
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
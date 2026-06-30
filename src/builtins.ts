// Built-in vendor presets
//
// refactored: vendor preset only prefills endpoint + mode + hint; model is fetched in wizard.
// Mode meanings:
//   direct   - anthropic direct (fastest, no sidecar)
//   rectify  - anthropic direct + rectifier hooks (via sidecar)
//   openai   - openai chat → anthropic conversion (via sidecar)
//
// Custom preset: user fills endpoint + mode.

import type { Mode } from "./types.js";

export interface BuiltinPreset {
  name: string;
  label: string;
  endpoint: string;
  defaultMode: Mode;
  hint?: string;
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    name: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/anthropic",
    defaultMode: "direct",
  },
  {
    name: "minimax",
    label: "MiniMax",
    endpoint: "https://api.minimaxi.com/anthropic",
    defaultMode: "direct",
  },
  {
    name: "mimo",
    label: "Xiaomi MiMo",
    endpoint: "https://api.xiaomimimo.com/anthropic",
    defaultMode: "direct",
  },
  {
    name: "kimi",
    label: "Moonshot Kimi",
    endpoint: "https://api.moonshot.cn/anthropic",
    defaultMode: "direct",
  },
  {
    name: "opencode-go",
    label: "OpenCode Go",
    endpoint: "https://opencode.ai/zen/go",
    defaultMode: "direct",
  },
];

export function findPreset(name: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.name === name);
}

export const CUSTOM_PRESET: BuiltinPreset = {
  name: "custom",
  label: "Custom",
  endpoint: "",
  defaultMode: "direct",
  hint: "fill in endpoint / mode manually",
};
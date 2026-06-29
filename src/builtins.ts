// 内置 vendor preset
//
// refactor 后：vendor preset 只预填 endpoint + mode + 提示，model 由 wizard fetch。
// Mode 含义：
//   direct   - anthropic 直连（最快，无 sidecar）
//   rectify  - anthropic 直连 + 整流钩子（走 sidecar）
//   openai   - openai chat → anthropic 转换（走 sidecar）
//
// Custom preset：用户手填 endpoint + mode。

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
  label: "自定义",
  endpoint: "",
  defaultMode: "direct",
  hint: "自填 endpoint / mode",
};
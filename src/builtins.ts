// 3 个内置订阅的默认值
// 用户 add 时选 preset，预填 endpoint/type/mode；用户填 apiKey 和 model 即可

import type { Subscription } from "./types.js";

export interface BuiltinPreset {
  name: string;
  label: string;
  endpoint: string;
  type: "anthropic" | "openai";
  defaultMode: "direct" | "rectify" | "convert";
  defaultModel: string;
  hint?: string;
}

export const BUILTIN_PRESETS: BuiltinPreset[] = [
  {
    name: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/anthropic",
    type: "anthropic",
    defaultMode: "direct",
    defaultModel: "deepseek-chat",
  },
  {
    name: "minimax",
    label: "MiniMax",
    endpoint: "https://api.minimaxi.com/anthropic",
    type: "anthropic",
    defaultMode: "direct",
    defaultModel: "MiniMax-M3",
  },
  {
    name: "mimo",
    label: "Xiaomi MiMo",
    endpoint: "https://api.xiaomimimo.com/anthropic",
    type: "anthropic",
    defaultMode: "direct",
    defaultModel: "mimo-v1",
  },
  {
    name: "opencode-go",
    label: "OpenCode Go",
    endpoint: "https://opencode.ai/zen/go",
    type: "anthropic",
    defaultMode: "direct",
    defaultModel: "",
  },
];

export function findPreset(name: string): BuiltinPreset | undefined {
  return BUILTIN_PRESETS.find((p) => p.name === name);
}

/**
 * 从 builtin preset 构造一个尚未填 apiKey 的 Subscription 草稿。
 * refactor 之后不再含 model 字段（models 是多选，由 add wizard 填），
 * 此函数仅给未来的"快速 add"流程预留。
 */
export function presetToSubscription(
  preset: BuiltinPreset,
  mode: Subscription["mode"],
): Omit<Subscription, "apiKey"> {
  const now = Date.now();
  return {
    name: preset.name,
    endpoint: preset.endpoint,
    type: preset.type,
    mode,
    models: [],
    createdAt: now,
    updatedAt: now,
  };
}

export const CUSTOM_PRESET: BuiltinPreset = {
  name: "custom",
  label: "自定义",
  endpoint: "",
  type: "anthropic",
  defaultMode: "direct",
  defaultModel: "",
  hint: "自填 endpoint / type / mode",
};

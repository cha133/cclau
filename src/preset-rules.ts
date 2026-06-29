// 内置整流规则集（preset → Rectifier 桥接）
//
// 跟 src/builtins.ts 的区别：
// - builtins.ts 是给 add wizard 用的「endpoint + mode + label」预设
// - preset-rules.ts 是给 builtin preset 配的「整流规则」（可选，add 时询问）
//
// v1 只装 2 条规则（解决 2 个具体痛点）：
// 1. opencode-go 401：双 auth header（x-api-key + Authorization: Bearer）
// 2. kimi thinking 400：归一 thinking.type 值域
//
// 新规则：在这里 export 一个 preset 常量 + 加进 BUILTIN_PRESETS 字典。

import type { AnthropicRectifier, AnthropicRequest } from "./types.js";

/**
 * requestHeaders 的 sentinel：值为这个字符串的 header value 会在
 * anthropic-passthrough 阶段被替换为 "Bearer ${apiKey}"。
 * 避免在 TOML 里写死 apiKey（apiKey 来自运行时）。
 */
export const BEARER_APIKEY_SENTINEL = "__CCLAU_BEARER_APIKEY__";

/**
 * opencode-go preset: 注入 Authorization: Bearer 双 auth header
 *
 * 痛点：opencode-go 的 anthropic-messages 端点要求同时发 x-api-key 和
 * Authorization: Bearer，cclau 默认只发 x-api-key → 401。
 * （参考 C:\Dev\proxy\internal\provider\opencode_go.go:188-189）
 */
export const OPENCODE_GO_PRESET: AnthropicRectifier = {
  requestHeaders: { Authorization: BEARER_APIKEY_SENTINEL },
};

/**
 * kimi preset: 归一 thinking.type 值域
 *
 * 痛点：Kimi 的 anthropic-messages 兼容端点（api.moonshot.cn/anthropic）
 * 只接受 thinking.type: "enabled" | "disabled" 字面字符串。
 * Claude Code 等客户端会发 effort 速记（"high"/"medium"/"low"/"xhigh"/"max"/"adaptive"）
 * 和布尔 true/false → 400。
 *
 * 策略：任何非显式 "disabled" 字面值 → 归一到 "enabled"；布尔 false/null → "disabled"。
 * 未来上游出新 effort 名也自动兼容。
 *
 * 抄自 cctra normalize-thinking-type（src/convert/upstream/rectify/rules/normalize-thinking-type.ts），
 * 适配 cclau 的 AnthropicRequest 类型（type 字面量是 "enabled"，无 disabled 字面量——但 enabled 也是 union）。
 */
export const KIMI_PRESET: AnthropicRectifier = {
  requestTransform: (req: AnthropicRequest): AnthropicRequest => {
    if (!req.thinking) return req;
    const t = req.thinking;
    // 已经是显式 "disabled"（任何大小写）→ 不动
    if (typeof t.type === "string" && t.type.toLowerCase() === "disabled") return req;
    // 布尔 false / null → "disabled"
    if (t.type === false || t.type === null) {
      return { ...req, thinking: { ...t, type: "disabled" } };
    }
    // 其他（effort shorthand "high"/"medium"/"low"/"xhigh"/"max"/"adaptive" / 布尔 true / 数字）→ "enabled"
    return { ...req, thinking: { ...t, type: "enabled" } };
  },
};

/** preset 名 → 默认 Rectifier（无规则 → 不在字典里，add wizard 用 .has() 判断） */
export const BUILTIN_PRESETS: Record<string, AnthropicRectifier> = {
  "opencode-go": OPENCODE_GO_PRESET,
  kimi: KIMI_PRESET,
};

/**
 * 处理 Rectifier.requestHeaders 里的 sentinel：
 * 值等于 BEARER_APIKEY_SENTINEL 的项 → 替换为 "Bearer ${apiKey}"，其他原样透传。
 *
 * 供 anthropic-passthrough.ts 在 merge 上游请求头时调用。
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

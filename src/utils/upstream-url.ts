// Subscription.endpoint + type → 真正的 upstream URL
//
// 用户存的 endpoint 可以是 base URL（推荐）或完整路径（容忍粘错），helper 按 type 拼路径。
// 设计来源：cctra 的 pickUpstreamPath + joinUrl，cclau 简化为单 helper。

export type Protocol = "anthropic" | "openai";

const DEFAULT_PATHS: Record<Protocol, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

/**
 * 规则（按顺序）：
 * 1. 去尾斜杠
 * 2. URL 本身以期望路径结尾 → 原样返回（容忍用户粘了完整 URL）
 * 3. URL 以 `/v1` 结尾且期望路径以 `/v1/` 开头 → 去掉路径开头的 `/v1`，避免 `v1/v1/...` 重复
 * 4. 其他 → 直接拼
 */
export function buildUpstreamUrl(base: string, protocol: Protocol): string {
  const trimmed = base.replace(/\/+$/, "");
  const expected = DEFAULT_PATHS[protocol];

  if (trimmed.endsWith(expected)) return trimmed;
  if (trimmed.endsWith("/v1") && expected.startsWith("/v1/")) {
    return `${trimmed}${expected.slice(3)}`;
  }
  return `${trimmed}${expected}`;
}

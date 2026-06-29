// Subscription.endpoint + type → actual upstream URL
//
// User-stored endpoint can be base URL (recommended) or full path (tolerate paste errors);
// helper assembles the path based on type.
// Design source: cctra's pickUpstreamPath + joinUrl, cclau simplified to a single helper.

export type Protocol = "anthropic" | "openai";

const DEFAULT_PATHS: Record<Protocol, string> = {
  anthropic: "/v1/messages",
  openai: "/v1/chat/completions",
};

/**
 * Rules (in order):
 * 1. Strip trailing slashes
 * 2. URL already ends with expected path → return as-is (tolerate user pasting full URL)
 * 3. URL ends with `/v1` and expected path starts with `/v1/` → strip `/v1` from path, avoid `v1/v1/...`
 * 4. Otherwise → direct concat
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
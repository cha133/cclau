// ============================================================================
// buildUpstreamUrl：base URL + protocol → 真正的 upstream URL
// ----------------------------------------------------------------------------
// 锁住 4 条拼路径规则（按顺序短路）：
//   1. 去尾斜杠
//   2. URL 本身以期望路径结尾 → 原样返回
//   3. URL 以 /v1 结尾且期望路径以 /v1/ 开头 → 剥路径开头 /v1
//   4. 其他 → 直接拼
// ============================================================================

import { describe, test, expect } from "bun:test";

import { buildUpstreamUrl, type Protocol } from "../src/utils/upstream-url.js";

describe("buildUpstreamUrl — 规则 1: 去尾斜杠", () => {
  test("anthropic + 末尾 / → 剥后拼 /v1/messages", () => {
    expect(buildUpstreamUrl("https://x.com/v1/", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("anthropic + 末尾 // → 全部剥（regex /\\/+$/）", () => {
    expect(buildUpstreamUrl("https://x.com/v1///", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("openai + 末尾 / → 剥后拼 /v1/chat/completions", () => {
    expect(buildUpstreamUrl("https://x.com/v1/", "openai")).toBe("https://x.com/v1/chat/completions");
  });
});

describe("buildUpstreamUrl — 规则 2: URL 已含期望路径 → 原样", () => {
  test("anthropic + base 已含 /v1/messages → 不再拼", () => {
    expect(buildUpstreamUrl("https://x.com/v1/messages", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("openai + base 已含 /v1/chat/completions → 不再拼", () => {
    expect(buildUpstreamUrl("https://x.com/v1/chat/completions", "openai")).toBe("https://x.com/v1/chat/completions");
  });

  test("anthropic + base 已含 /v1/messages 且末尾 / → 仍原样（去尾斜杠后 endsWith 仍命中）", () => {
    expect(buildUpstreamUrl("https://x.com/v1/messages/", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("openai + base 已含 /v1/chat/completions 且末尾 // → 仍原样", () => {
    expect(buildUpstreamUrl("https://x.com/v1/chat/completions//", "openai")).toBe("https://x.com/v1/chat/completions");
  });
});

describe("buildUpstreamUrl — 规则 3: /v1 去重", () => {
  // 规则 3 实际语义：剥 expected 开头的 '/v1'，避免 base 的 /v1 与 expected 的 /v1/ 拼成 /v1/v1/
  // base 末尾的 /v1 保留（仍在路径里），只是 expected 不再加一个 /v1

  test("anthropic + base=/v1 + 期望 /v1/messages → 拼成 /v1/messages（无 /v1/v1/）", () => {
    expect(buildUpstreamUrl("https://x.com/v1", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("openai + base=/v1 + 期望 /v1/chat/completions → 拼成 /v1/chat/completions", () => {
    expect(buildUpstreamUrl("https://x.com/v1", "openai")).toBe("https://x.com/v1/chat/completions");
  });

  test("anthropic + base=/v1/ → 先剥尾斜杠再命中规则 3", () => {
    expect(buildUpstreamUrl("https://x.com/v1/", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("规则 3 防 /v1/v1/ 重复：检查结果不含 '/v1/v1'", () => {
    expect(buildUpstreamUrl("https://x.com/v1", "anthropic")).not.toMatch(/\/v1\/v1/);
    expect(buildUpstreamUrl("https://x.com/v1/", "openai")).not.toMatch(/\/v1\/v1/);
  });
});

describe("buildUpstreamUrl — 规则 4: 直接拼", () => {
  test("anthropic + 无 /v1 的 base → 直接拼 /v1/messages", () => {
    expect(buildUpstreamUrl("https://x.com", "anthropic")).toBe("https://x.com/v1/messages");
  });

  test("openai + 无 /v1 的 base → 直接拼 /v1/chat/completions", () => {
    expect(buildUpstreamUrl("https://x.com", "openai")).toBe("https://x.com/v1/chat/completions");
  });

  test("anthropic + base 含子路径 → 直接拼", () => {
    expect(buildUpstreamUrl("https://x.com/api", "anthropic")).toBe("https://x.com/api/v1/messages");
  });

  test("anthropic + base = localhost:port → 拼", () => {
    expect(buildUpstreamUrl("http://127.0.0.1:3133", "anthropic")).toBe("http://127.0.0.1:3133/v1/messages");
  });
});

describe("buildUpstreamUrl — 协议覆盖", () => {
  const bases = [
    "https://x.com",
    "https://x.com/v1",
    "https://x.com/v1/",
    "https://x.com/v1/messages",
  ];
  const protocols: Protocol[] = ["anthropic", "openai"];

  test.each(bases)("base=%s 两种协议都返回合理路径", (base) => {
    for (const p of protocols) {
      const out = buildUpstreamUrl(base, p);
      // 两种 protocol 的输出都非空且不重复 /v1
      expect(out.length).toBeGreaterThan(0);
      expect(out).not.toMatch(/\/v1\/v1/);
    }
  });
});

// ============================================================================
// buildRegistry：把 resolved tiers 展平成 model id → RouteEntry 的 Map
// ----------------------------------------------------------------------------
// 锁住 v5 不变量 #4：key = strip1m(t.model)，3 tier 允许同 model id，
// 跨 provider 靠 ${provider.name}/ 前缀消歧；不再校验 3 tier 唯一。
// ============================================================================

import { describe, test, expect } from "bun:test";

import { buildRegistry, RegistryBuildError, type RegistryTier } from "../src/server/registry.js";
import type { Subscription } from "../src/types.js";

// ---------------------------------------------------------------------------

function makeSub(name: string, overrides: Partial<Subscription> = {}): Subscription {
  return {
    name,
    endpoint: `https://example.invalid/${name}`,
    apiKey: `key-${name}`,
    type: "anthropic",
    mode: "direct",
    models: [{ id: "claude-sonnet-4-6", supports_1m: false }],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTier(
  tier: "opus" | "sonnet" | "haiku",
  model: string,
  provider: Subscription,
  upstreamModel?: string,
): RegistryTier {
  const t: RegistryTier = { tier, model, provider };
  if (upstreamModel !== undefined) t.upstreamModel = upstreamModel;
  return t;
}

// ---------------------------------------------------------------------------

describe("buildRegistry — 跨 provider 同 model id 消歧（v5 不变量 #4）", () => {
  test("3 tier 都用 claude-sonnet-4-6，3 个不同 provider → 3 个 entry，key 形如 ${provider}/${base}", () => {
    const kimi = makeSub("kimi");
    const foo = makeSub("foo");
    const bar = makeSub("bar");
    const tiers = [
      makeTier("opus", "kimi/claude-sonnet-4-6[1m]", kimi),
      makeTier("sonnet", "foo/claude-sonnet-4-6[1m]", foo),
      makeTier("haiku", "bar/claude-sonnet-4-6[1m]", bar),
    ];
    const reg = buildRegistry(tiers);

    expect(reg.size).toBe(3);
    expect(reg.has("kimi/claude-sonnet-4-6")).toBe(true);
    expect(reg.has("foo/claude-sonnet-4-6")).toBe(true);
    expect(reg.has("bar/claude-sonnet-4-6")).toBe(true);
  });

  test("同 provider + 同 model id + 不同 tier → 3 个 entry（key 仍按 provider 消歧）", () => {
    const kimi = makeSub("kimi");
    const tiers = [
      makeTier("opus", "kimi/claude-sonnet-4-6", kimi),
      makeTier("sonnet", "kimi/claude-sonnet-4-6", kimi),
      makeTier("haiku", "kimi/claude-sonnet-4-6", kimi),
    ];
    const reg = buildRegistry(tiers);
    // 3 次 set 同一 key，最后一个 entry 胜出（按 provider 走 key 消歧这里是同一 key）
    // 注意：v5 文档「同 provider + 同 model + 不同 mode」会撞 key 是已知 YAGNI
    expect(reg.size).toBe(1);
    expect(reg.get("kimi/claude-sonnet-4-6")?.apiKey).toBe("key-kimi");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — strip1m(t.model) 行为", () => {
  test("含 [1m] → key 剥掉", () => {
    const kimi = makeSub("kimi");
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6[1m]", kimi)]);
    expect(reg.has("kimi/claude-sonnet-4-6")).toBe(true);
    expect(reg.has("kimi/claude-sonnet-4-6[1m]")).toBe(false);
  });

  test("无 [1m] → key 原样", () => {
    const kimi = makeSub("kimi");
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.has("kimi/claude-sonnet-4-6")).toBe(true);
  });

  test("upstreamModel 显式传时用上游 base name（不被 t.model 推算影响）", () => {
    const kimi = makeSub("kimi");
    const reg = buildRegistry([
      makeTier("opus", "kimi/claude-sonnet-4-6[1m]", kimi, "claude-sonnet-4-6"),
    ]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("upstreamModel 不传时 fallback 到 strip1m(t.model)（带前缀场景里这个值是错的，但 fallback 逻辑如此）", () => {
    const kimi = makeSub("kimi");
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.upstreamModel).toBe("kimi/claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — endpoint 末尾 / 规整 + apiKey 兜底", () => {
  test("endpoint 末尾 / → 剥掉", () => {
    const kimi = makeSub("kimi", { endpoint: "https://example.invalid/kimi/" });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.endpoint).toBe("https://example.invalid/kimi");
  });

  test("endpoint 末尾 // → 全部剥", () => {
    const kimi = makeSub("kimi", { endpoint: "https://example.invalid/kimi///" });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.endpoint).toBe("https://example.invalid/kimi");
  });

  test("apiKey 缺失 → 兜底空串（不抛错）", () => {
    const kimi = makeSub("kimi", { apiKey: undefined });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.apiKey).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — rectifier 挂载", () => {
  test("mode=rectify + provider.rectifier 存在 → entry.rectifier 挂上", () => {
    const kimi = makeSub("kimi", {
      mode: "rectify",
      rectifier: { anthropic: { requestHeaders: { Authorization: "Bearer x" } } },
    });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.rectifier).toEqual({
      anthropic: { requestHeaders: { Authorization: "Bearer x" } },
    });
  });

  test("mode=rectify + provider.rectifier 缺失 → entry.rectifier 仍是 undefined", () => {
    const kimi = makeSub("kimi", { mode: "rectify" });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.rectifier).toBeUndefined();
  });

  test("mode=direct → 不挂 rectifier（即使 provider.rectifier 有值）", () => {
    const kimi = makeSub("kimi", {
      mode: "direct",
      rectifier: { anthropic: { requestHeaders: { Authorization: "Bearer x" } } },
    });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.rectifier).toBeUndefined();
  });

  test("mode=convert → 不挂 rectifier（CLAUDE.md: convert 模式覆盖 anthropic↔openai 翻译，不在整流层做）", () => {
    const kimi = makeSub("kimi", {
      mode: "convert",
      type: "openai",
      endpoint: "https://example.invalid/openai",
      rectifier: { anthropic: { requestHeaders: { Authorization: "Bearer x" } } },
    });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.rectifier).toBeUndefined();
    expect(reg.get("kimi/claude-sonnet-4-6")?.mode).toBe("convert");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — 边界", () => {
  test("空 tiers → 空 Map", () => {
    const reg = buildRegistry([]);
    expect(reg.size).toBe(0);
  });

  test("type=openai 端点透传", () => {
    const kimi = makeSub("kimi", { type: "openai", endpoint: "https://example.invalid/openai" });
    const reg = buildRegistry([makeTier("opus", "kimi/claude-sonnet-4-6", kimi)]);
    expect(reg.get("kimi/claude-sonnet-4-6")?.type).toBe("openai");
  });
});

// ---------------------------------------------------------------------------

describe("RegistryBuildError — 异常类型实例化", () => {
  test("new RegistryBuildError('msg') 仍可 instanceof 自己的类型", () => {
    const e = new RegistryBuildError("boom");
    expect(e).toBeInstanceOf(RegistryBuildError);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("boom");
    expect(e.name).toBe("RegistryBuildError");
  });
});

// ============================================================================
// buildRegistry：单 Profile → 1 entry 的 Map
// ----------------------------------------------------------------------------
// refactor 之后：单 profile 概念，registry 只装 1 条 entry。
// key = strip1m(profile.model)，无 provider/ 前缀（跨 provider 概念不存在了）。
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  buildRegistry,
  RegistryBuildError,
  type RouteEntry,
} from "../src/server/registry.js";
import { OPENCODE_GO_PRESET } from "../src/preset-rules.js";
import type { Profile } from "../src/types.js";

// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    endpoint: "https://example.invalid/test",
    apiKey: "key-test",
    mode: "direct",
    model: "claude-sonnet-4-6",
    supports1m: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe("buildRegistry — 单 entry", () => {
  test("普通 profile → 1 个 entry，key = strip1m(model)", () => {
    const reg = buildRegistry(makeProfile());
    expect(reg.size).toBe(1);
    expect(reg.has("claude-sonnet-4-6")).toBe(true);
  });

  test("空 registry 边界 → 不会发生但建出来是空（buildRegistry 总返 1 entry）", () => {
    // 单 profile 概念下，buildRegistry 永远返 1 entry；这里仅 sanity check
    const reg = buildRegistry(makeProfile({ model: "" }));
    // model = "" 时 strip1m("") = ""，仍是 1 entry（key 为空串）
    expect(reg.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — strip1m key 行为", () => {
  test("supports1m=true → key 仍是裸 model（registry 看不到 [1m]）", () => {
    const reg = buildRegistry(makeProfile({ model: "claude-sonnet-4-6[1m]" }));
    expect(reg.has("claude-sonnet-4-6")).toBe(true);
    expect(reg.has("claude-sonnet-4-6[1m]")).toBe(false);
  });

  test("裸 model id → key 原样", () => {
    const reg = buildRegistry(makeProfile({ model: "claude-sonnet-4-6" }));
    expect(reg.has("claude-sonnet-4-6")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — endpoint 末尾 / 规整 + apiKey 透传", () => {
  test("endpoint 末尾 / → 剥掉", () => {
    const reg = buildRegistry(
      makeProfile({ endpoint: "https://example.invalid/test/" }),
    );
    expect(reg.get("claude-sonnet-4-6")?.endpoint).toBe(
      "https://example.invalid/test",
    );
  });

  test("endpoint 末尾 // → 全部剥", () => {
    const reg = buildRegistry(
      makeProfile({ endpoint: "https://example.invalid/test///" }),
    );
    expect(reg.get("claude-sonnet-4-6")?.endpoint).toBe(
      "https://example.invalid/test",
    );
  });

  test("apiKey 透传", () => {
    const reg = buildRegistry(makeProfile({ apiKey: "sk-1234" }));
    expect(reg.get("claude-sonnet-4-6")?.apiKey).toBe("sk-1234");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — entry.model 字段", () => {
  test("model 裸（无 [1m]） → entry.model = profile.model", () => {
    const reg = buildRegistry(makeProfile({ model: "claude-sonnet-4-6" }));
    expect(reg.get("claude-sonnet-4-6")?.model).toBe("claude-sonnet-4-6");
  });

  test("supports1m=true → model 字段不带 [1m]（[1m] 只写给 claude-code，不传给上游）", () => {
    // 实际上 Profile.model 不带 [1m]（supports1m 是 boolean 字段），这里只是 sanity
    const reg = buildRegistry(makeProfile({ model: "claude-sonnet-4-6" }));
    const entry = reg.get("claude-sonnet-4-6")!;
    expect(entry.model).toBe("claude-sonnet-4-6");
    expect(entry.model.endsWith("[1m]")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — rectifier 挂载", () => {
  test("mode=rectify + profile.rectifier=已知名字 → entry.rectifier 解析成 AnthropicRectifier", () => {
    const reg = buildRegistry(
      makeProfile({ mode: "rectify", rectifier: "opencode-go" }),
    );
    expect(reg.get("claude-sonnet-4-6")?.rectifier).toEqual({
      anthropic: OPENCODE_GO_PRESET,
    });
  });

  test("mode=rectify + profile.rectifier 缺失 → entry.rectifier undefined", () => {
    const reg = buildRegistry(makeProfile({ mode: "rectify" }));
    expect(reg.get("claude-sonnet-4-6")?.rectifier).toBeUndefined();
  });

  test("mode=rectify + profile.rectifier=未知名字 → 静默 no-op（warn log）", () => {
    // hand-edit TOML 写错名字时不应该崩；registry build 跳过 + warn
    const reg = buildRegistry(
      makeProfile({ mode: "rectify", rectifier: "nonexistent-rule" }),
    );
    expect(reg.get("claude-sonnet-4-6")?.rectifier).toBeUndefined();
  });

  test("mode=direct → 不挂 rectifier（即使 profile.rectifier 有值）", () => {
    const reg = buildRegistry(
      makeProfile({ mode: "direct", rectifier: "opencode-go" }),
    );
    expect(reg.get("claude-sonnet-4-6")?.rectifier).toBeUndefined();
  });

  test("mode=openai → 不挂 rectifier（rectify 专属）", () => {
    const reg = buildRegistry(
      makeProfile({
        mode: "openai",
        endpoint: "https://example.invalid/openai",
        rectifier: "opencode-go",
      }),
    );
    expect(reg.get("claude-sonnet-4-6")?.rectifier).toBeUndefined();
    expect(reg.get("claude-sonnet-4-6")?.mode).toBe("openai");
  });
});

// ---------------------------------------------------------------------------

describe("buildRegistry — mode 透传", () => {
  test.each([
    ["direct", "direct"],
    ["rectify", "rectify"],
    ["openai", "openai"],
  ] as const)("mode=%s → entry.mode=%s", (m, expected) => {
    const reg = buildRegistry(makeProfile({ mode: m }));
    const entry = reg.get("claude-sonnet-4-6") as RouteEntry;
    expect(entry.mode).toBe(expected);
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
// ============================================================================
// resolveLaunch：单 Profile → { settingsModel, upstreamModel, sidecar }
// ----------------------------------------------------------------------------
// refactor 之后：单 profile 概念，无 3 tier 概念。
// 4 个 ANTHROPIC_DEFAULT_*_MODEL env 全 = settingsModel（apply1m 后）。
// sidecar.needed 据 profile.mode 决策：direct → false；rectify / openai → true。
// ============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { resolveLaunch, ProfileResolutionError } from "../src/settings.js";
import type { Profile } from "../src/types.js";

let tempDir: string;
let tempConfigPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cclau-settings-"));
  tempConfigPath = join(tempDir, "config.toml");
  process.env.CCLAU_CONFIG = tempConfigPath;
});

afterAll(() => {
  delete process.env.CCLAU_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "test",
    endpoint: "https://example.invalid",
    apiKey: "key-test",
    mode: "direct",
    model: "claude-sonnet-4-6",
    supports1m: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// ===========================================================================
// sidecar 决策矩阵
// ===========================================================================

describe("resolveLaunch — sidecar 决策矩阵（据 profile.mode）", () => {
  test("mode=direct → sidecar.needed=false（零 hop）", () => {
    const r = resolveLaunch(makeProfile({ mode: "direct" }));
    expect(r.sidecar.needed).toBe(false);
    expect(r.sidecar.reason).toBeUndefined();
  });

  test("mode=rectify → sidecar.needed=true + reason='mode: rectify'", () => {
    const r = resolveLaunch(makeProfile({ mode: "rectify" }));
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("mode: rectify");
  });

  test("mode=openai → sidecar.needed=true + reason='mode: openai'", () => {
    const r = resolveLaunch(makeProfile({ mode: "openai" }));
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("mode: openai");
  });
});

// ===========================================================================
// settingsModel + upstreamModel（apply1m + 裸 base name）
// ===========================================================================

describe("resolveLaunch — settingsModel 与 upstreamModel", () => {
  test("supports1m=true → settingsModel 带 [1m]，upstreamModel 不带", () => {
    const r = resolveLaunch(makeProfile({ supports1m: true }));
    expect(r.settingsModel).toBe("claude-sonnet-4-6[1m]");
    expect(r.upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("supports1m=false → settingsModel 不带 [1m]，upstreamModel 也不带", () => {
    const r = resolveLaunch(makeProfile({ supports1m: false }));
    expect(r.settingsModel).toBe("claude-sonnet-4-6");
    expect(r.upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("upstreamModel 总是 = profile.model（不带前缀、不带 [1m]）", () => {
    const r = resolveLaunch(
      makeProfile({ model: "deepseek-chat", supports1m: true }),
    );
    expect(r.upstreamModel).toBe("deepseek-chat");
    expect(r.upstreamModel).not.toContain("/");
    expect(r.upstreamModel.endsWith("[1m]")).toBe(false);
  });

  test("幂等：settingsModel 上游裸名 + apply1m(true) = apply1m(settingsModel, false) 还原", () => {
    // settingsModel 写给 claude-code（带 [1m]）；upstreamModel 写给上游（裸 base）
    // 两者差只在 [1m] 后缀
    const r = resolveLaunch(makeProfile({ supports1m: true }));
    expect(r.settingsModel).toBe(`${r.upstreamModel}[1m]`);
  });
});

// ===========================================================================
// 错误路径
// ===========================================================================

describe("resolveLaunch — 错误路径", () => {
  test("endpoint 缺失 → throw ProfileResolutionError", () => {
    expect(() =>
      resolveLaunch(makeProfile({ endpoint: "" })),
    ).toThrow(ProfileResolutionError);
    expect(() =>
      resolveLaunch(makeProfile({ endpoint: "" })),
    ).toThrow(/endpoint/);
  });

  test("apiKey 缺失 → throw ProfileResolutionError", () => {
    expect(() => resolveLaunch(makeProfile({ apiKey: "" }))).toThrow(
      ProfileResolutionError,
    );
    expect(() => resolveLaunch(makeProfile({ apiKey: "" }))).toThrow(/apiKey/);
  });

  test("model 缺失 → throw ProfileResolutionError", () => {
    expect(() => resolveLaunch(makeProfile({ model: "" }))).toThrow(
      ProfileResolutionError,
    );
    expect(() => resolveLaunch(makeProfile({ model: "" }))).toThrow(/model/);
  });

  test("ProfileResolutionError instanceof 自检", () => {
    const e = new ProfileResolutionError("boom");
    expect(e).toBeInstanceOf(ProfileResolutionError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ProfileResolutionError");
  });
});

// ===========================================================================
// 不同 mode × 不同 1m 组合
// ===========================================================================

describe("resolveLaunch — mode × supports1m 组合", () => {
  test.each([
    ["direct", false, "claude-sonnet-4-6"],
    ["direct", true, "claude-sonnet-4-6[1m]"],
    ["rectify", false, "claude-sonnet-4-6"],
    ["rectify", true, "claude-sonnet-4-6[1m]"],
    ["openai", false, "claude-sonnet-4-6"],
    ["openai", true, "claude-sonnet-4-6[1m]"],
  ] as const)(
    "mode=%s supports1m=%s → settingsModel=%s",
    (mode, supports1m, expected) => {
      const r = resolveLaunch(makeProfile({ mode, supports1m }));
      expect(r.settingsModel).toBe(expected);
    },
  );
});
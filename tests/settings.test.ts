// ============================================================================
// resolveProfile：profile → 3 个 tier + sidecar 决策
// ----------------------------------------------------------------------------
// 锁住 v2/v5 核心不变量：
//   #1 全部 direct + 同 provider → 零 hop（裸 model id，无 provider/ 前缀）
//   #2 任何 tier 非 direct 或 provider 不一致 → 起 sidecar（model 加 provider/ 前缀）
//   #3 apply1m 自动注入 + upstreamModel 始终裸
// ============================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";

import { resolveProfile, ProfileResolutionError } from "../src/settings.js";
import type { Config, Profile, StoredSubscription } from "../src/types.js";

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

function makeStoredSub(
  name: string,
  overrides: Partial<StoredSubscription> = {},
): StoredSubscription {
  return {
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

function makeProfile(
  overrides: Partial<Pick<Profile, "opus" | "sonnet" | "haiku" | "name">> = {},
): Profile {
  return {
    name: "test",
    opus: { provider: "kimi", model: "claude-sonnet-4-6" },
    sonnet: { provider: "kimi", model: "claude-sonnet-4-6" },
    haiku: { provider: "kimi", model: "claude-sonnet-4-6" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeConfig(subs: Record<string, StoredSubscription>): Config {
  return { providers: subs, profiles: {}, aliases: {} };
}

// ===========================================================================
// sidecar 决策矩阵（不变量 #1 + #2）
// ===========================================================================

describe("resolveProfile — sidecar 决策矩阵", () => {
  test("3 tier 同 provider + 全 direct → sidecar.needed=false（零 hop）", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi", { mode: "direct" }) });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(false);
    expect(r.sidecar.reason).toBeUndefined();
  });

  test("任一 tier mode=rectify → sidecar.needed=true + reason='含 rectify mode'", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", { mode: "rectify" }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("含 rectify mode");
  });

  test("任一 tier mode=convert → sidecar.needed=true + reason='含 convert mode'", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", {
        mode: "convert",
        type: "openai",
        endpoint: "https://example.invalid/openai",
      }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("含 convert mode");
  });

  test("3 tier 不同 provider → sidecar.needed=true + reason='3 个 provider'", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi"),
      foo: makeStoredSub("foo"),
      bar: makeStoredSub("bar"),
    });
    const p = makeProfile({
      opus: { provider: "kimi", model: "claude-sonnet-4-6" },
      sonnet: { provider: "foo", model: "claude-sonnet-4-6" },
      haiku: { provider: "bar", model: "claude-sonnet-4-6" },
    });
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("3 个 provider");
  });

  test("2 个 provider → reason='2 个 provider'", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi"),
      foo: makeStoredSub("foo"),
    });
    const p = makeProfile({
      opus: { provider: "kimi", model: "claude-sonnet-4-6" },
      sonnet: { provider: "kimi", model: "claude-sonnet-4-6" },
      haiku: { provider: "foo", model: "claude-sonnet-4-6" },
    });
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(true);
    expect(r.sidecar.reason).toBe("2 个 provider");
  });
});

// ===========================================================================
// sidecar 模式 t.model 加 ${provider.name}/ 前缀（不变量 #1/#2）
// ===========================================================================

describe("resolveProfile — sidecar 模式 model id 形如 '${provider}/${base}[1m]'", () => {
  test("3 tier 同 provider + rectify mode → t.model 加前缀", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", { mode: "rectify" }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(true);
    expect(r.tiers[0].model).toBe("kimi/claude-sonnet-4-6");
    expect(r.tiers[1].model).toBe("kimi/claude-sonnet-4-6");
    expect(r.tiers[2].model).toBe("kimi/claude-sonnet-4-6");
  });

  test("3 tier 不同 provider + sidecar → 每个 tier model 带自己的 provider 前缀", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi"),
      foo: makeStoredSub("foo"),
      bar: makeStoredSub("bar"),
    });
    const p = makeProfile({
      opus: { provider: "kimi", model: "claude-sonnet-4-6" },
      sonnet: { provider: "foo", model: "claude-sonnet-4-6" },
      haiku: { provider: "bar", model: "claude-sonnet-4-6" },
    });
    const r = resolveProfile(p, cfg);
    expect(r.tiers[0].model).toBe("kimi/claude-sonnet-4-6");
    expect(r.tiers[1].model).toBe("foo/claude-sonnet-4-6");
    expect(r.tiers[2].model).toBe("bar/claude-sonnet-4-6");
  });
});

// ===========================================================================
// 零 hop 模式保持裸 model id（不变量 #1）
// ===========================================================================

describe("resolveProfile — 零 hop 模式裸 model id（无 provider/ 前缀）", () => {
  test("3 tier 同 provider + 全 direct → t.model 裸 base name", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi", { mode: "direct" }) });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.sidecar.needed).toBe(false);
    expect(r.tiers[0].model).toBe("claude-sonnet-4-6");
    expect(r.tiers[1].model).toBe("claude-sonnet-4-6");
    expect(r.tiers[2].model).toBe("claude-sonnet-4-6");
  });

  test("零 hop 模式下没有 provider/ 前缀（上游 API 不认带前缀的 id）", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi", { mode: "direct" }) });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    for (const t of r.tiers) {
      expect(t.model).not.toContain("/");
    }
  });
});

// ===========================================================================
// apply1m + upstreamModel 始终裸（不变量 #3 对偶）
// ===========================================================================

describe("resolveProfile — apply1m 自动注入 + upstreamModel 始终裸", () => {
  test("supports_1m=true → t.model 末尾带 [1m]；upstreamModel 不带", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", {
        models: [{ id: "claude-sonnet-4-6", supports_1m: true }],
      }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    // 零 hop 模式（direct） → t.model 裸
    expect(r.tiers[0].model).toBe("claude-sonnet-4-6[1m]");
    // upstreamModel 始终裸（无论零 hop 还是 sidecar）
    expect(r.tiers[0].upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("supports_1m=true + sidecar 模式 → t.model='${provider}/${base}[1m]'", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", {
        mode: "rectify",
        models: [{ id: "claude-sonnet-4-6", supports_1m: true }],
      }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.tiers[0].model).toBe("kimi/claude-sonnet-4-6[1m]");
    expect(r.tiers[0].upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("supports_1m=false → t.model 不带 [1m]；upstreamModel 也不带", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", {
        models: [{ id: "claude-sonnet-4-6", supports_1m: false }],
      }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    expect(r.tiers[0].model).toBe("claude-sonnet-4-6");
    expect(r.tiers[0].upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("幂等：3 tier 全部 supports_1m → 3 个 tier 都带 [1m] 形态一致", () => {
    const cfg = makeConfig({
      kimi: makeStoredSub("kimi", {
        mode: "rectify",
        models: [{ id: "claude-sonnet-4-6", supports_1m: true }],
      }),
    });
    const p = makeProfile();
    const r = resolveProfile(p, cfg);
    for (const t of r.tiers) {
      expect(t.model.endsWith("[1m]")).toBe(true);
      expect(t.upstreamModel.endsWith("[1m]")).toBe(false);
    }
  });
});

// ===========================================================================
// 错误路径
// ===========================================================================

describe("resolveProfile — 错误路径", () => {
  test("provider 不存在 → throw ProfileResolutionError", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi") });
    const p = makeProfile({
      opus: { provider: "ghost", model: "claude-sonnet-4-6" },
    });
    expect(() => resolveProfile(p, cfg)).toThrow(ProfileResolutionError);
    expect(() => resolveProfile(p, cfg)).toThrow(/provider "ghost" not found/);
  });

  test("model 不存在 → throw ProfileResolutionError", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi") });
    const p = makeProfile({
      opus: { provider: "kimi", model: "ghost-model" },
    });
    expect(() => resolveProfile(p, cfg)).toThrow(/model "ghost-model" not found/);
  });

  test("空 provider 串 → throw（profile 留空串让 launch 时报错的约定）", () => {
    const cfg = makeConfig({ kimi: makeStoredSub("kimi") });
    const p = makeProfile({
      opus: { provider: "", model: "claude-sonnet-4-6" },
    });
    expect(() => resolveProfile(p, cfg)).toThrow(ProfileResolutionError);
  });

  test("ProfileResolutionError instanceof 自检", () => {
    const e = new ProfileResolutionError("boom");
    expect(e).toBeInstanceOf(ProfileResolutionError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ProfileResolutionError");
  });
});

// ===========================================================================
// alias 解析优先（v6：profile.model 是 alias 名时）
// ===========================================================================

describe("resolveProfile — alias 解析优先（v6）", () => {
  test("profile.model 是 alias 名 → 用 alias 解析的 (provider, model) 替换", () => {
    // alias 名 = "mysonet" 命中 "kimi/claude-sonnet-4-6"
    // profile 里 3 tier 都写 "mysonet" + provider 写 "ignored"（被 alias 覆盖）
    const cfg: Config = {
      providers: { kimi: makeStoredSub("kimi") },
      profiles: {},
      aliases: { mysonet: "kimi/claude-sonnet-4-6" },
    };
    const p: Profile = {
      name: "work",
      opus: { provider: "ignored", model: "mysonet" },
      sonnet: { provider: "ignored", model: "mysonet" },
      haiku: { provider: "ignored", model: "mysonet" },
      createdAt: 0,
      updatedAt: 0,
    };
    const r = resolveProfile(p, cfg);
    expect(r.tiers[0]!.provider.name).toBe("kimi");
    expect(r.tiers[0]!.upstreamModel).toBe("claude-sonnet-4-6");
    expect(r.tiers[2]!.provider.name).toBe("kimi");
  });

  test("alias unbound → throw ProfileResolutionError", () => {
    const cfg: Config = {
      providers: { kimi: makeStoredSub("kimi") },
      profiles: {},
      aliases: { mysonet: "" },
    };
    const p: Profile = {
      name: "work",
      opus: { provider: "kimi", model: "mysonet" },
      sonnet: { provider: "kimi", model: "mysonet" },
      haiku: { provider: "kimi", model: "mysonet" },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => resolveProfile(p, cfg)).toThrow(ProfileResolutionError);
  });

  test("profile.model 是 literal (provider/model 都有效) → 不走 alias 路径", () => {
    const cfg: Config = {
      providers: { kimi: makeStoredSub("kimi") },
      profiles: {},
      aliases: { mysonet: "kimi/claude-sonnet-4-6" },
    };
    const p: Profile = {
      name: "work",
      opus: { provider: "kimi", model: "claude-sonnet-4-6" },
      sonnet: { provider: "kimi", model: "claude-sonnet-4-6" },
      haiku: { provider: "kimi", model: "claude-sonnet-4-6" },
      createdAt: 0,
      updatedAt: 0,
    };
    const r = resolveProfile(p, cfg);
    expect(r.tiers[0]!.provider.name).toBe("kimi");
    expect(r.tiers[0]!.upstreamModel).toBe("claude-sonnet-4-6");
  });
});

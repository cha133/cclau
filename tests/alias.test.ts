// ============================================================================
// Alias 系统单元测试：auto-register 算法、resolve 表分支、namespace 防御
// 抄自 cctra tests/alias.test.ts（删除 plugin / Source kind 相关）
// ============================================================================

// 用 CCLAU_CONFIG 隔离真实 ~/.config/cclau/config.toml
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let tempConfigPath: string;

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { canAutoRegisterAlias, autoAliasValue, registerAutoAliases, unbindAliasesPointingTo } from "../src/core/auto-alias.js";
import { resolveAlias, AliasResolveError } from "../src/core/alias.js";
import {
  isProviderName,
  isAliasName,
  isValidAliasName,
  nameTakenAnywhere,
  describeNameOwner,
} from "../src/core/namespace.js";
import { resolveProfile, ProfileResolutionError } from "../src/settings.js";
import type { Config, Profile, StoredSubscription, Subscription } from "../src/types.js";

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cclau-alias-"));
  tempConfigPath = join(tempDir, "config.toml");
  process.env.CCLAU_CONFIG = tempConfigPath;
});

afterAll(() => {
  delete process.env.CCLAU_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
});

function emptyConfig(): Config {
  return { providers: {}, profiles: {}, aliases: {} };
}

function makeStoredSub(_name: string, modelIds: string[]): StoredSubscription {
  return {
    endpoint: "https://example.com",
    apiKey: "t",
    type: "anthropic",
    mode: "direct",
    models: modelIds.map((id) => ({ id, supports_1m: false })),
    createdAt: 0,
    updatedAt: 0,
  };
}

function configWithProvider(
  providerName: string,
  modelIds: string[],
  aliases: Record<string, string> = {},
): Config {
  return {
    providers: { [providerName]: makeStoredSub(providerName, modelIds) },
    profiles: {},
    aliases,
  };
}

// 把 StoredSubscription 归一化成 Subscription（settings.ts / core/alias.ts 用）
function subFromConfig(config: Config, name: string): Subscription {
  const stored = config.providers[name]!;
  return {
    name,
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    type: stored.type,
    mode: stored.mode,
    models: stored.models,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    rectifier: stored.rectifier,
  };
}

// ---------------------------------------------------------------------------

describe("canAutoRegisterAlias", () => {
  test("empty config: any id auto-registers", () => {
    expect(canAutoRegisterAlias("foo", emptyConfig())).toBe(true);
  });

  test("id unique in config: auto-registers", () => {
    const cfg = configWithProvider("a", ["model-a"]);
    expect(canAutoRegisterAlias("model-b", cfg)).toBe(true);
  });

  test("id collides with existing alias name: blocked", () => {
    const cfg = configWithProvider("a", ["model-a"], { foo: "a/model-a" });
    expect(canAutoRegisterAlias("foo", cfg)).toBe(false);
  });

  test("id collides with provider name: blocked", () => {
    const cfg = configWithProvider("a", ["model-a"]);
    expect(canAutoRegisterAlias("a", cfg)).toBe(false);
  });

  test("id already used as model.id in other provider: blocked", () => {
    const cfg = configWithProvider("a", ["dup"]);
    cfg.providers.b = makeStoredSub("b", ["dup"]);
    expect(canAutoRegisterAlias("dup", cfg)).toBe(false);
  });

  test("excludeSource: skip self in edit scenario", () => {
    const cfg = configWithProvider("a", ["dup"]);
    // edit 时 excludeSource="a"，应该能找到 dup（不算自己）
    expect(canAutoRegisterAlias("dup", cfg, "a")).toBe(true);
  });

  test("empty id: never auto-registers", () => {
    expect(canAutoRegisterAlias("", emptyConfig())).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("autoAliasValue", () => {
  test("globally unique: returns provider/id", () => {
    const cfg = configWithProvider("kimi", ["model-a"]);
    expect(autoAliasValue("new-id", "kimi", cfg)).toBe("kimi/new-id");
  });

  test("collides with alias: returns null", () => {
    const cfg = configWithProvider("kimi", ["model-a"], { existing: "kimi/model-a" });
    expect(autoAliasValue("existing", "kimi", cfg)).toBeNull();
  });

  test("in-batch dedup", () => {
    const cfg = emptyConfig();
    expect(autoAliasValue("dup", "p", cfg, [])).toBe("p/dup");
    expect(autoAliasValue("dup", "p", cfg, [{ id: "dup", supports_1m: false }])).toBeNull();
  });
});

describe("registerAutoAliases + unbindAliasesPointingTo", () => {
  test("registerAutoAliases writes provider/id for unique models", () => {
    const cfg = emptyConfig();
    registerAutoAliases(cfg, "p", ["a", "b", "c"]);
    expect(cfg.aliases.a).toBe("p/a");
    expect(cfg.aliases.b).toBe("p/b");
    expect(cfg.aliases.c).toBe("p/c");
  });

  test("registerAutoAliases skips colliding names", () => {
    const cfg = configWithProvider("p", ["a"], { "existing": "p/a" });
    registerAutoAliases(cfg, "p", ["existing", "new"]);
    expect(cfg.aliases.existing).toBe("p/a"); // 没被覆盖
    expect(cfg.aliases.new).toBe("p/new");
  });

  test("unbindAliasesPointingTo sets value='' and returns names", () => {
    const cfg = emptyConfig();
    cfg.aliases.g = "p/a";
    cfg.aliases.h = "p/a";
    cfg.aliases.i = "p/b";
    const unbound = unbindAliasesPointingTo(cfg, "p/a");
    expect(unbound.sort()).toEqual(["g", "h"]);
    expect(cfg.aliases.g).toBe("");
    expect(cfg.aliases.h).toBe("");
    expect(cfg.aliases.i).toBe("p/b");
  });
});

// ---------------------------------------------------------------------------

describe("resolveAlias — alias table branch", () => {
  test("alias bound → routes to provider/model", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "kimi/doubao" });
    const r = resolveAlias("cclau-pro", cfg);
    expect(r).not.toBeNull();
    expect(r!.provider.name).toBe("kimi");
    expect(r!.modelId).toBe("doubao");
  });

  test("alias unbound (value '') → throws is unbound", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "" });
    expect(() => resolveAlias("cclau-pro", cfg)).toThrow(/is unbound/);
  });

  test("alias points to missing model → throws missing model", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "kimi/gone" });
    expect(() => resolveAlias("cclau-pro", cfg)).toThrow(/missing model/);
  });

  test("alias points to unknown provider → throws unknown provider", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "ghost/doubao" });
    expect(() => resolveAlias("cclau-pro", cfg)).toThrow(/unknown provider/);
  });

  test("alias with invalid value (no slash) → throws invalid", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "broken" });
    expect(() => resolveAlias("cclau-pro", cfg)).toThrow(/invalid value/);
  });

  test("provider/model fall-through still works alongside aliases", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "kimi/doubao" });
    const r = resolveAlias("kimi/doubao", cfg);
    expect(r!.provider.name).toBe("kimi");
    expect(r!.modelId).toBe("doubao");
  });

  test("returns null for empty / non-existing ref", () => {
    const cfg = emptyConfig();
    expect(resolveAlias("", cfg)).toBeNull();
    expect(resolveAlias("nope", cfg)).toBeNull();
    expect(resolveAlias("kimi/missing", cfg)).toBeNull();
  });

  test("AliasResolveError is thrown (instanceof check)", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { "cclau-pro": "" });
    try {
      resolveAlias("cclau-pro", cfg);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AliasResolveError);
    }
  });
});

// ---------------------------------------------------------------------------

describe("namespace helpers", () => {
  test("isProviderName / isAliasName / nameTakenAnywhere", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { foo: "kimi/doubao" });
    expect(isProviderName(cfg, "kimi")).toBe(true);
    expect(isProviderName(cfg, "foo")).toBe(false);
    expect(isAliasName(cfg, "foo")).toBe(true);
    expect(isAliasName(cfg, "kimi")).toBe(false);
    expect(nameTakenAnywhere(cfg, "kimi")).toBe(true);
    expect(nameTakenAnywhere(cfg, "foo")).toBe(true);
    expect(nameTakenAnywhere(cfg, "free")).toBe(false);
  });

  test("describeNameOwner returns owner kind", () => {
    const cfg = configWithProvider("kimi", ["doubao"], { foo: "kimi/doubao" });
    expect(describeNameOwner(cfg, "kimi")).toBe('provider "kimi"');
    expect(describeNameOwner(cfg, "foo")).toBe('alias "foo"');
    expect(describeNameOwner(cfg, "free")).toBeNull();
  });

  test("isValidAliasName", () => {
    expect(isValidAliasName("cclau-pro")).toBe(true);
    expect(isValidAliasName("a")).toBe(true);
    expect(isValidAliasName("9-init")).toBe(true);
    expect(isValidAliasName("")).toBe(false);
    expect(isValidAliasName("-leading-dash")).toBe(false);
    expect(isValidAliasName("UPPER")).toBe(false);
    expect(isValidAliasName("with/slash")).toBe(false);
    expect(isValidAliasName("a".repeat(64))).toBe(false); // > 63 chars
    expect(isValidAliasName("a".repeat(63))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("settings.ts 集成 — profile model=alias → resolveTier 命中 alias", () => {
  test("profile.model 是 alias 名时，resolveTier 用 alias 解析的 (provider, model) 替换", () => {
    const cfg = configWithProvider("kimi", ["claude-sonnet-4-6"], { sonnet: "kimi/claude-sonnet-4-6" });
    const profile: Profile = {
      name: "work",
      opus: { provider: "ignored", model: "sonnet" }, // provider 被 alias 覆盖
      sonnet: { provider: "ignored", model: "sonnet" }, // provider 被 alias 覆盖
      haiku: { provider: "ignored", model: "sonnet" },
      createdAt: 0,
      updatedAt: 0,
    };
    const resolved = resolveProfile(profile, cfg);
    expect(resolved.tiers[0]!.provider.name).toBe("kimi");
    expect(resolved.tiers[0]!.upstreamModel).toBe("claude-sonnet-4-6");
    expect(resolved.tiers[2]!.provider.name).toBe("kimi");
  });

  test("profile.model 是 literal (provider/model 都有效) → 不走 alias 路径", () => {
    const cfg = configWithProvider("kimi", ["claude-sonnet-4-6"], { sonnet: "kimi/claude-sonnet-4-6" });
    const profile: Profile = {
      name: "work",
      opus: { provider: "kimi", model: "claude-sonnet-4-6" },
      sonnet: { provider: "kimi", model: "claude-sonnet-4-6" },
      haiku: { provider: "kimi", model: "claude-sonnet-4-6" },
      createdAt: 0,
      updatedAt: 0,
    };
    const resolved = resolveProfile(profile, cfg);
    expect(resolved.tiers[0]!.provider.name).toBe("kimi");
    expect(resolved.tiers[0]!.upstreamModel).toBe("claude-sonnet-4-6");
  });

  test("alias 解析失败（unbound） → throw ProfileResolutionError", () => {
    const cfg = configWithProvider("kimi", ["claude-sonnet-4-6"], { sonnet: "" });
    const profile: Profile = {
      name: "work",
      opus: { provider: "kimi", model: "sonnet" },
      sonnet: { provider: "kimi", model: "sonnet" },
      haiku: { provider: "kimi", model: "sonnet" },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => resolveProfile(profile, cfg)).toThrow(ProfileResolutionError);
  });

  test("literal (provider, model) miss → throw ProfileResolutionError", () => {
    const cfg = configWithProvider("kimi", ["claude-sonnet-4-6"]);
    const profile: Profile = {
      name: "work",
      opus: { provider: "kimi", model: "non-existent" },
      sonnet: { provider: "kimi", model: "claude-sonnet-4-6" },
      haiku: { provider: "kimi", model: "claude-sonnet-4-6" },
      createdAt: 0,
      updatedAt: 0,
    };
    expect(() => resolveProfile(profile, cfg)).toThrow(ProfileResolutionError);
  });
});

// 防 unused 警告
void subFromConfig;
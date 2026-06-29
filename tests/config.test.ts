// ============================================================================
// config CRUD 单元测试
// ----------------------------------------------------------------------------
// 隔离：CCLAU_CONFIG 环境变量指向 mkdtempSync 临时目录
// （与 cctra tests/rectify.test.ts 同模式）
// ============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAppConfig,
  saveAppConfig,
  upsertSubscription,
  getSubscription,
  listSubscriptions,
  removeSubscription,
  upsertProfile,
  getProfile,
  listProfiles,
  removeProfile,
} from "../src/config.js";
import type { Subscription, Profile } from "../src/types.js";
import { buildDefaultAliases } from "../src/types.js";

let tempDir: string;
let tempConfigPath: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "cclau-config-"));
  tempConfigPath = join(tempDir, "config.toml");
  process.env.CCLAU_CONFIG = tempConfigPath;
});

afterAll(() => {
  delete process.env.CCLAU_CONFIG;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 每个 test 重新清空临时文件，确保 isolation
  rmSync(tempConfigPath, { force: true });
});

function makeSub(name: string, overrides: Partial<Subscription> = {}): Subscription {
  return {
    name,
    endpoint: `https://example.invalid/${name}`,
    apiKey: `key-${name}`,
    type: "anthropic",
    mode: "direct",
    models: [{ id: "test-model", supports_1m: false }],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function makeProfile(name: string, provider = "p1", model = "m1"): Profile {
  return {
    name,
    opus: { provider, model },
    sonnet: { provider, model },
    haiku: { provider, model },
    createdAt: 2000,
    updatedAt: 2000,
  };
}

describe("config CRUD (CCLAU_CONFIG isolated)", () => {
  test.serial("missing file → empty config", () => {
    expect(existsSync(tempConfigPath)).toBe(false);
    const cfg = loadAppConfig();
    expect(cfg).toEqual({ providers: {}, profiles: {}, aliases: buildDefaultAliases() });
  });

  test.serial("subscription CRUD roundtrip", async () => {
    await upsertSubscription(makeSub("alpha"));
    await upsertSubscription(makeSub("beta"));

    expect(getSubscription("alpha")?.endpoint).toBe("https://example.invalid/alpha");
    expect(getSubscription("beta")?.apiKey).toBe("key-beta");
    expect(getSubscription("missing")).toBeUndefined();

    const list = listSubscriptions();
    expect(list.map((s) => s.name)).toEqual(["alpha", "beta"]); // localeCompare 排序
  });

  test.serial("TOML roundtrip via save/load", async () => {
    const cfg = {
      providers: {
        foo: {
          endpoint: "https://foo.invalid",
          apiKey: "sk-foo",
          type: "anthropic" as const,
          mode: "rectify" as const,
          models: [{ id: "foo-1", supports_1m: true }],
          createdAt: 5000,
          updatedAt: 5000,
        },
      },
      profiles: {
        p1: {
          opus_provider: "foo",
          opus_model: "foo-1",
          sonnet_provider: "foo",
          sonnet_model: "foo-1",
          haiku_provider: "",
          haiku_model: "foo-1",
          createdAt: 6000,
          updatedAt: 6000,
        },
      },
      aliases: {},
    };
    await saveAppConfig(cfg);

    expect(existsSync(tempConfigPath)).toBe(true);
    const reloaded = loadAppConfig();
    const foo = reloaded.providers.foo!;
    const p1 = reloaded.profiles.p1!;
    expect(foo.endpoint).toBe("https://foo.invalid");
    expect(foo.mode).toBe("rectify");
    expect(foo.models[0]!.supports_1m).toBe(true);
    expect(p1.haiku_provider).toBe(""); // 空串保留
  });

  test.serial("removeSubscription cascade: profile tier refs → empty string", async () => {
    // 写一个 provider + 3 个 tier 都引用它的 profile
    await saveAppConfig({
      providers: {
        doomed: {
          endpoint: "https://doom.invalid",
          apiKey: "k",
          type: "anthropic",
          mode: "direct",
          models: [],
          createdAt: 1,
          updatedAt: 1,
        },
        keeper: {
          endpoint: "https://keep.invalid",
          apiKey: "k",
          type: "anthropic",
          mode: "direct",
          models: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
      profiles: {
        ref: {
          opus_provider: "doomed",
          opus_model: "x",
          sonnet_provider: "doomed",
          sonnet_model: "y",
          haiku_provider: "keeper",
          haiku_model: "z",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      aliases: {},
    });

    const removed = await removeSubscription("doomed");
    expect(removed).toBe(true);

    const cfg = loadAppConfig();
    expect(cfg.providers.doomed).toBeUndefined();
    const ref = cfg.profiles.ref!;
    expect(ref.opus_provider).toBe("");    // cascade 命中
    expect(ref.sonnet_provider).toBe("");  // cascade 命中
    expect(ref.haiku_provider).toBe("keeper"); // 没引用 doomed，原样
  });

  test.serial("profile CRUD", async () => {
    await saveAppConfig({
      providers: {},
      profiles: {},
      aliases: {},
    });

    await upsertProfile(makeProfile("first", "alpha", "m"));
    await upsertProfile(makeProfile("second", "beta", "n"));

    expect(getProfile("first")?.sonnet.provider).toBe("alpha");
    expect(getProfile("second")?.opus.model).toBe("n");

    const list = listProfiles().map((p) => p.name);
    expect(list).toEqual(["first", "second"]);

    const removed = await removeProfile("first");
    expect(removed).toBe(true);
    expect(getProfile("first")).toBeUndefined();

    const removedAgain = await removeProfile("first");
    expect(removedAgain).toBe(false);
  });
});
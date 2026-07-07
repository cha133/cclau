// ============================================================================
// config CRUD 单元测试
// ----------------------------------------------------------------------------
// 隔离：CCLAU_CONFIG 环境变量指向 mkdtempSync 临时目录
// （与 cctra tests/rectify.test.ts 同模式）
//
// refactor 之后：单 Profile 概念，无 provider / alias / multi-tier。
// default 是全局顶层 key（profile name 引用），不是 per-profile boolean。
// ============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LegacyConfigError,
  loadAppConfig,
  saveAppConfig,
  getDefaultName,
  getDefaultProfile,
  getProfile,
  listProfiles,
  listProfileNames,
  clearDefault,
  removeProfile,
  setDefault,
  upsertProfile,
} from "../src/config.js";
import type { Mode, Profile } from "../src/types.js";

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

function makeProfile(name: string, overrides: Partial<Profile> = {}): Profile {
  return {
    name,
    endpoint: `https://example.invalid/${name}`,
    apiKey: `key-${name}`,
    mode: "direct",
    model: "test-model",
    supports1m: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("config CRUD (CCLAU_CONFIG isolated)", () => {
  test.serial("missing file → empty config", () => {
    expect(existsSync(tempConfigPath)).toBe(false);
    const cfg = loadAppConfig();
    expect(cfg).toEqual({ profiles: {} });
  });

  test.serial("profile CRUD roundtrip", async () => {
    await upsertProfile(makeProfile("alpha"));
    await upsertProfile(makeProfile("beta"));

    expect(getProfile("alpha")?.endpoint).toBe("https://example.invalid/alpha");
    expect(getProfile("beta")?.apiKey).toBe("key-beta");
    expect(getProfile("missing")).toBeUndefined();

    const list = listProfiles().map((p) => p.name);
    expect(list).toEqual(["alpha", "beta"]); // localeCompare 排序
  });

  test.serial("TOML roundtrip via save/load", async () => {
    const cfg = {
      default: "foo",
      profiles: {
        foo: {
          endpoint: "https://foo.invalid",
          apiKey: "sk-foo",
          mode: "rectify" as Mode,
          model: "foo-1",
          supports1m: true,
          createdAt: 5000,
          updatedAt: 5000,
        },
      },
    };
    await saveAppConfig(cfg);

    expect(existsSync(tempConfigPath)).toBe(true);
    const reloaded = loadAppConfig();
    expect(reloaded.default).toBe("foo");
    const foo = reloaded.profiles.foo!;
    expect(foo.endpoint).toBe("https://foo.invalid");
    expect(foo.mode).toBe("rectify");
    expect(foo.model).toBe("foo-1");
    expect(foo.supports1m).toBe(true);
  });

  test.serial("removeProfile idempotency", async () => {
    await upsertProfile(makeProfile("first"));
    await upsertProfile(makeProfile("second"));

    expect(getProfile("first")?.name).toBe("first");
    const removed = await removeProfile("first");
    expect(removed).toBe(true);
    expect(getProfile("first")).toBeUndefined();

    const removedAgain = await removeProfile("first");
    expect(removedAgain).toBe(false);

    const list = listProfileNames();
    expect(list).toEqual(["second"]);
  });

  test.serial("supports1m preserved through roundtrip", async () => {
    await upsertProfile(makeProfile("p1", { supports1m: true }));
    expect(getProfile("p1")?.supports1m).toBe(true);
    await upsertProfile(makeProfile("p1", { supports1m: false }));
    expect(getProfile("p1")?.supports1m).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global default (top-level key) — replaces the old per-profile `default` flag.
// ---------------------------------------------------------------------------

describe("getDefaultProfile — three states", () => {
  test.serial("no global default key → undefined", async () => {
    await upsertProfile(makeProfile("p1"));
    expect(getDefaultName()).toBeUndefined();
    expect(getDefaultProfile()).toBeUndefined();
  });

  test.serial("global default set + profile exists → returns the profile", async () => {
    await upsertProfile(makeProfile("p1"));
    await upsertProfile(makeProfile("p2"));
    await setDefault("p2");
    expect(getDefaultName()).toBe("p2");
    expect(getDefaultProfile()?.name).toBe("p2");
  });

  test.serial("dangling default (key set but profile missing) → getDefaultProfile is undefined but getDefaultName is the stale name", async () => {
    await upsertProfile(makeProfile("p1"));
    await setDefault("p1");
    // 手工写盘：删 p1 但保留 default key
    const cfg = loadAppConfig();
    delete cfg.profiles.p1;
    // keep cfg.default = "p1" (intentional dangling)
    await saveAppConfig(cfg);

    expect(getDefaultName()).toBe("p1"); // raw text still there
    expect(getDefaultProfile()).toBeUndefined(); // lazy resolve → undefined
  });
});

describe("setDefault", () => {
  test.serial("writes top-level key + replaces any previous default", async () => {
    await upsertProfile(makeProfile("alpha"));
    await upsertProfile(makeProfile("beta"));
    await setDefault("alpha");
    expect(getDefaultName()).toBe("alpha");

    await setDefault("beta");
    expect(getDefaultName()).toBe("beta");
  });

  test.serial("rejects nonexistent profile — does not write", async () => {
    await upsertProfile(makeProfile("alpha"));
    expect(setDefault("ghost")).rejects.toThrow(/does not exist/);
    expect(getDefaultName()).toBeUndefined();
  });

  test.serial("does not mutate the profile record itself", async () => {
    await upsertProfile(makeProfile("alpha"));
    await setDefault("alpha");
    const reloaded = getProfile("alpha")!;
    // Profile type no longer has a `default` field at all — this is enforced
    // by the type system. Runtime check: reloaded shape has no `default` key.
    expect("default" in reloaded).toBe(false);
  });
});

describe("clearDefault", () => {
  test.serial("removes the top-level key", async () => {
    await upsertProfile(makeProfile("alpha"));
    await setDefault("alpha");
    expect(getDefaultName()).toBe("alpha");
    await clearDefault();
    expect(getDefaultName()).toBeUndefined();
  });

  test.serial("no-op when default already absent", async () => {
    expect(clearDefault()).resolves.toBeUndefined();
    expect(getDefaultName()).toBeUndefined();
  });
});

describe("legacy config detection (old per-profile `default = true`)", () => {
  test.serial("loadAppConfig throws LegacyConfigError on per-profile default=true", async () => {
    // Hand-craft a legacy config file
    writeFileSync(
      tempConfigPath,
      [
        '[profiles.x]',
        'endpoint = "https://x.invalid"',
        'mode = "direct"',
        'model = "x"',
        'supports1m = false',
        'apiKey = "sk-x"',
        'createdAt = 1000',
        'updatedAt = 1000',
        'default = true',
        '',
      ].join("\n"),
      "utf-8",
    );

    expect(() => loadAppConfig()).toThrow(LegacyConfigError);
    try {
      loadAppConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(LegacyConfigError);
      expect((err as LegacyConfigError).message).toContain("old per-profile");
      expect((err as LegacyConfigError).message).toContain("cclau use");
      expect((err as LegacyConfigError).offendingProfile).toBe("x");
    }
  });
});

describe("auto-default semantics (first add wins, subsequent don't override)", () => {
  test.serial("first add → getDefaultProfile undefined → auto-set; second add → no-op", async () => {
    await upsertProfile(makeProfile("first"));
    expect(getDefaultProfile()).toBeUndefined();

    // Simulate addCmd auto-default trigger
    if (getDefaultProfile() === undefined) {
      await setDefault("first");
    }
    expect(getDefaultName()).toBe("first");

    // Second add
    await upsertProfile(makeProfile("second"));
    if (getDefaultProfile() === undefined) {
      await setDefault("second");
    }
    // still "first" — second add didn't override
    expect(getDefaultName()).toBe("first");
  });

  test.serial("dangling default is treated as unset by addCmd trigger", async () => {
    // Setup: dangling default referencing "ghost"
    await upsertProfile(makeProfile("ghost", { endpoint: "https://ghost" }));
    await setDefault("ghost");
    await removeProfile("ghost"); // cfg.default = "ghost" survives (stale)

    expect(getDefaultName()).toBe("ghost"); // raw
    expect(getDefaultProfile()).toBeUndefined(); // lazy

    // New add (simulating addCmd: upsertProfile + lazy-resolve trigger)
    await upsertProfile(makeProfile("newcomer"));
    if (getDefaultProfile() === undefined) {
      await setDefault("newcomer");
    }
    expect(getDefaultName()).toBe("newcomer");
  });
});

describe("rm fallback semantics (auto-promote to first remaining)", () => {
  test.serial("rm of default with remaining profiles → auto-promote alphabetically first", async () => {
    await upsertProfile(makeProfile("alpha"));
    await upsertProfile(makeProfile("beta"));
    await upsertProfile(makeProfile("gamma"));
    await setDefault("beta");
    await removeProfile("beta");

    // rmCmd's fallback: listProfiles() sorted by name → [0] is "alpha" → setDefault("alpha")
    const remaining = listProfiles();
    expect(remaining[0]!.name).toBe("alpha");
    await setDefault(remaining[0]!.name);

    expect(getDefaultName()).toBe("alpha");
    // Profile records themselves have no `default` key
    expect("default" in getProfile("alpha")!).toBe(false);
    expect("default" in getProfile("gamma")!).toBe(false);
  });

  test.serial("rm of default with no remaining profiles → stale cfg.default is preserved", async () => {
    await upsertProfile(makeProfile("only"));
    await setDefault("only");
    await removeProfile("only");

    expect(listProfiles()).toEqual([]);
    expect(getDefaultName()).toBe("only"); // stale; next add will overwrite
    expect(getDefaultProfile()).toBeUndefined();
  });
});

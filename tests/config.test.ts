// ============================================================================
// config CRUD 单元测试
// ----------------------------------------------------------------------------
// 隔离：CCLAU_CONFIG 环境变量指向 mkdtempSync 临时目录
// （与 cctra tests/rectify.test.ts 同模式）
//
// refactor 之后：单 Profile 概念，无 provider / alias。
// ============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadAppConfig,
  saveAppConfig,
  getDefaultProfile,
  getProfile,
  listProfiles,
  listProfileNames,
  removeProfile,
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

  test.serial("getDefaultProfile: no default → undefined", async () => {
    await upsertProfile(makeProfile("p1"));
    expect(getDefaultProfile()).toBeUndefined();
  });

  test.serial("getDefaultProfile: returns the profile with default=true", async () => {
    await upsertProfile(makeProfile("p1"));
    await upsertProfile(makeProfile("p2", { default: true }));
    const def = getDefaultProfile();
    expect(def?.name).toBe("p2");
  });

  test.serial("getDefaultProfile: returns first when multiple defaults exist", async () => {
    // 配置层只读字段：多 default 时返第一个（launch 时报错让用户清）
    await upsertProfile(makeProfile("a", { default: true }));
    await upsertProfile(makeProfile("b", { default: true }));
    const def = getDefaultProfile();
    expect(def?.name).toBeDefined();
    expect(["a", "b"]).toContain(def!.name);
  });

  test.serial("supports1m preserved through roundtrip", async () => {
    await upsertProfile(makeProfile("p1", { supports1m: true }));
    expect(getProfile("p1")?.supports1m).toBe(true);
    await upsertProfile(makeProfile("p1", { supports1m: false }));
    expect(getProfile("p1")?.supports1m).toBe(false);
  });
});
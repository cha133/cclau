// TOML 配置读写
//
// 两张表：providers + profiles。profile 是新概念：opus/sonnet/haiku
// 各自指向某个 provider/model 对（详见 types.ts）。

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { configPath } from "./utils/paths.js";
import type { Config, Profile, StoredProfile, StoredSubscription, Subscription } from "./types.js";
import { buildDefaultAliases } from "./types.js";

export function loadAppConfig(): Config {
  const path = configPath();
  try {
    const text = readFileSync(path, "utf-8");
    if (!text.trim()) return emptyConfig();
    const parsed = parse(text) as unknown as Config;
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    return {
      providers: parsed.providers ?? {},
      profiles: parsed.profiles ?? {},
      aliases: parsed.aliases ?? buildDefaultAliases(),
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyConfig();
    return emptyConfig();
  }
}

function emptyConfig(): Config {
  return { providers: {}, profiles: {}, aliases: buildDefaultAliases() };
}

export async function saveAppConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const toml = stringify(config as any);
  await writeFile(path, toml, { mode: 0o600 });
}

// ---------- provider 归一化 + CRUD ----------

/**
 * 把磁盘形态归一化成运行时 Subscription：
 * - models 字段缺失时（极端情况）补空数组
 * - 单 model / model_1m 的旧 schema 不会自动迁移（refactor 那天清盘了）
 *
 * 不写回 TOML——避免热路径静默 IO、与外部编辑器竞争；下次用户主动
 * `cclau add <existing>` 覆盖时会自然写回归一化后的状态。
 */
function normalizeStored(stored: StoredSubscription, name: string): Subscription {
  return {
    name,
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    type: stored.type,
    mode: stored.mode,
    models: Array.isArray(stored.models) ? stored.models : [],
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    rectifier: stored.rectifier,
  };
}

/** 取订阅时自动注入 name 并归一化 */
export function getSubscription(name: string): Subscription | undefined {
  const stored = loadAppConfig().providers[name];
  if (!stored) return undefined;
  return normalizeStored(stored, name);
}

export async function upsertSubscription(sub: Subscription): Promise<void> {
  const cfg = loadAppConfig();
  const { name, ...stored } = sub;
  cfg.providers[name] = stored;
  await saveAppConfig(cfg);
}

export async function removeSubscription(name: string): Promise<boolean> {
  const cfg = loadAppConfig();
  if (!cfg.providers[name]) return false;
  delete cfg.providers[name];
  // 级联：删除 provider 时，把所有引用此 provider 的 profile tier 引用置空
  // —— 不删 profile，引用空字符串会在 launch 时报错，避免悬挂引用
  for (const profile of Object.values(cfg.profiles)) {
    if (profile.opus_provider === name) profile.opus_provider = "";
    if (profile.sonnet_provider === name) profile.sonnet_provider = "";
    if (profile.haiku_provider === name) profile.haiku_provider = "";
  }
  await saveAppConfig(cfg);
  return true;
}

export function listSubscriptions(): Subscription[] {
  const cfg = loadAppConfig();
  const subs: Subscription[] = Object.entries(cfg.providers).map(([name, stored]) =>
    normalizeStored(stored, name),
  );
  return subs.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- profile 归一化 + CRUD ----------

/**
 * TOML 落盘形态是 flat 字段（opus_provider / opus_model / ...），
 * 运行时聚合成嵌套的 { opus: { provider, model }, ... }。
 */
function normalizeStoredProfile(stored: StoredProfile, name: string): Profile {
  return {
    name,
    opus: { provider: stored.opus_provider, model: stored.opus_model },
    sonnet: { provider: stored.sonnet_provider, model: stored.sonnet_model },
    haiku: { provider: stored.haiku_provider, model: stored.haiku_model },
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function denormalizeProfile(profile: Profile): StoredProfile {
  return {
    opus_provider: profile.opus.provider,
    opus_model: profile.opus.model,
    sonnet_provider: profile.sonnet.provider,
    sonnet_model: profile.sonnet.model,
    haiku_provider: profile.haiku.provider,
    haiku_model: profile.haiku.model,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function getProfile(name: string): Profile | undefined {
  const stored = loadAppConfig().profiles[name];
  if (!stored) return undefined;
  return normalizeStoredProfile(stored, name);
}

export async function upsertProfile(profile: Profile): Promise<void> {
  const cfg = loadAppConfig();
  cfg.profiles[profile.name] = denormalizeProfile(profile);
  await saveAppConfig(cfg);
}

export async function removeProfile(name: string): Promise<boolean> {
  const cfg = loadAppConfig();
  if (!cfg.profiles[name]) return false;
  delete cfg.profiles[name];
  await saveAppConfig(cfg);
  return true;
}

export function listProfiles(): Profile[] {
  const cfg = loadAppConfig();
  const profiles: Profile[] = Object.entries(cfg.profiles).map(([name, stored]) =>
    normalizeStoredProfile(stored, name),
  );
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- 辅助：批量取所有 provider name + mode 映射 ----------

/** 给 suggestNameOnConflict 用：name → mode 的索引 */
export function indexProviderModes(): Record<string, import("./types.js").SubscriptionMode> {
  const cfg = loadAppConfig();
  const out: Record<string, import("./types.js").SubscriptionMode> = {};
  for (const [name, stored] of Object.entries(cfg.providers)) {
    out[name] = stored.mode;
  }
  return out;
}

/**
 * 给 fuzzy 解析当 candidate pool：所有 provider name 列表
 * （带 normalizeStored 开销，但命令层每次 fuzzy 前只调一次）
 */
export function listProviderNames(): string[] {
  return listSubscriptions().map((s) => s.name);
}

/** 给 fuzzy 解析当 candidate pool：所有 profile name 列表 */
export function listProfileNames(): string[] {
  return listProfiles().map((p) => p.name);
}

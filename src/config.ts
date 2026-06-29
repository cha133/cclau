// TOML 配置读写
//
// 重构后只剩一张表：profiles。每条 profile 自带 endpoint / apiKey / mode / model / supports1m。
// Provider / multi-tier / alias 全部删。

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { configPath } from "./utils/paths.js";
import type { Config, Profile, StoredProfile } from "./types.js";

export function loadAppConfig(): Config {
  const path = configPath();
  try {
    const text = readFileSync(path, "utf-8");
    if (!text.trim()) return emptyConfig();
    const parsed = parse(text) as unknown as Config;
    if (!parsed || typeof parsed !== "object") return emptyConfig();
    return {
      profiles: parsed.profiles ?? {},
    };
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyConfig();
    return emptyConfig();
  }
}

function emptyConfig(): Config {
  return { profiles: {} };
}

export async function saveAppConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const toml = stringify(config as any);
  await writeFile(path, toml, { mode: 0o600 });
}

function normalizeProfile(stored: StoredProfile, name: string): Profile {
  return {
    name,
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    mode: stored.mode,
    model: stored.model,
    supports1m: stored.supports1m,
    default: stored.default,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export function getProfile(name: string): Profile | undefined {
  const stored = loadAppConfig().profiles[name];
  if (!stored) return undefined;
  return normalizeProfile(stored, name);
}

export async function upsertProfile(profile: Profile): Promise<void> {
  const cfg = loadAppConfig();
  const { name, ...stored } = profile;
  cfg.profiles[name] = stored;
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
    normalizeProfile(stored, name),
  );
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function listProfileNames(): string[] {
  return listProfiles().map((p) => p.name);
}

/**
 * 返回 default === true 的第一个 profile。找不到返 undefined。
 *
 * 多 default 的报错不在这里做 —— 配置层只读字段，UX 在 launch 时（Phase 4）。
 */
export function getDefaultProfile(): Profile | undefined {
  return listProfiles().find((p) => p.default === true);
}
// 从上游拉模型列表（带 3 层缓存：内存 → 磁盘 → 网络 → OpenRouter fallback）
// port 自 cctra/src/core/model-fetch.ts
//
// 1. 试上游 endpoint 的 /v1/models
// 2. 失败 → 剥离已知兼容路径后缀（/anthropic 等）后重试
// 3. 还失败 → fallback 到 OpenRouter（去 :free 后缀 + 去 provider 前缀）
// 4. 全失败 → 返回空数组（add wizard 会用手动输入 fallback）

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MODELS_CACHE_PATH, ensureAppCacheDir } from "../utils/paths.js";

export interface FetchModelsOptions {
  endpoint: string;
  token: string;
  modelsPath?: string;       // 默认 "/v1/models"
  ttlMs?: number;            // 默认 24h
}

interface ModelCacheEntry {
  models: string[];
  expiresAt: number;
}

const memoryCache = new Map<string, ModelCacheEntry>();

const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24h
const OPENROUTER_FALLBACK = "https://openrouter.ai/api/v1/models";

// 已知的 Anthropic 兼容路径后缀（按长度降序，先匹配长后缀）
// 供应商的 endpoint 可能指向 Anthropic 兼容子路径（如 /anthropic），
// 但 /v1/models 通常只在根路径可用，需要剥离子路径后重试
const KNOWN_COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/api/plan",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
];

export function stripCompatSuffix(url: string): string | null {
  const trimmed = url.replace(/\/+$/, "");
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, trimmed.length - suffix.length);
    }
  }
  return null;
}

/**
 * 从上游拉模型列表（带 3 层缓存 + OpenRouter fallback）
 */
export async function fetchUpstreamModels(opts: FetchModelsOptions): Promise<string[]> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const path = opts.modelsPath ?? "/v1/models";
  const key = `${opts.endpoint}|${path}`;

  // L1: 内存
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.models;

  // L2: 磁盘
  ensureAppCacheDir();
  const cachePath = MODELS_CACHE_PATH;
  if (existsSync(cachePath)) {
    try {
      const disk = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, ModelCacheEntry>;
      const entry = disk[key];
      if (entry && entry.expiresAt > Date.now()) {
        memoryCache.set(key, entry);
        return entry.models;
      }
    } catch {
      // ignore disk cache error
    }
  }

  // L3: 网络 — 先试上游
  const url = joinUrl(opts.endpoint, path);
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let models = await tryFetchModels(url, headers);

  // L3.5: 剥离已知兼容路径后缀后重试（如 /anthropic → 根 /v1/models）
  if (models.length === 0) {
    const stripped = stripCompatSuffix(opts.endpoint);
    if (stripped) {
      const fallbackUrl = joinUrl(stripped, path);
      if (fallbackUrl !== url) {
        models = await tryFetchModels(fallbackUrl, headers);
      }
    }
  }

  // L4: Fallback 到 OpenRouter
  if (models.length === 0) {
    const fallback = await tryFetchModels(OPENROUTER_FALLBACK, {});
    models = sanitizeOpenRouterModels(fallback);
  }

  // 回写缓存
  const entry: ModelCacheEntry = { models, expiresAt: Date.now() + ttl };
  memoryCache.set(key, entry);
  try {
    let disk: Record<string, ModelCacheEntry> = {};
    if (existsSync(cachePath)) {
      disk = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, ModelCacheEntry>;
    }
    disk[key] = entry;
    writeFileSync(cachePath, JSON.stringify(disk, null, 2), "utf-8");
  } catch {
    // ignore disk cache write error
  }
  return models;
}

/**
 * 拉单个端点的 models（无 auth header 因为 OpenRouter fallback 不带 token）
 */
async function tryFetchModels(url: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => m.id);
    }
  } catch {
    // 网络/超时失败
  }
  return [];
}

/**
 * 清理 OpenRouter 返回的模型名
 * - 去掉 :free 后缀
 * - 去掉 provider 前缀（org/model → model）
 */
function sanitizeOpenRouterModels(models: string[]): string[] {
  return models.flatMap((id) => {
    if (id.endsWith(":free")) return [];
    const slashIdx = id.indexOf("/");
    return slashIdx > 0 ? [id.slice(slashIdx + 1)] : [id];
  });
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  // 避免 /v1/v1 重复
  if (b.endsWith("/v1") && p.startsWith("/v1/")) return `${b}${p.slice(3)}`;
  if (b.endsWith("/v1beta") && p.startsWith("/v1beta/")) return `${b}${p.slice(7)}`;
  return `${b}${p}`;
}

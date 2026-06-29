// Fetch model list from upstream (3-tier cache: memory → disk → network → OpenRouter fallback)
// Ported from cctra/src/core/model-fetch.ts
//
// 1. Try upstream endpoint's /v1/models
// 2. On failure → strip known compat path suffix (/anthropic etc.) and retry
// 3. Still failing → fallback to OpenRouter (strip :free suffix + provider prefix)
// 4. All fail → return [] (add wizard falls back to manual input)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MODELS_CACHE_PATH, ensureAppCacheDir } from "../utils/paths.js";

export interface FetchModelsOptions {
  endpoint: string;
  token: string;
  modelsPath?: string;       // default "/v1/models"
  ttlMs?: number;            // default 24h
}

interface ModelCacheEntry {
  models: string[];
  expiresAt: number;
}

const memoryCache = new Map<string, ModelCacheEntry>();

const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24h
const OPENROUTER_FALLBACK = "https://openrouter.ai/api/v1/models";

// Known Anthropic-compat path suffixes (sorted descending by length so longer matches first).
// Provider endpoints may point to an Anthropic-compat subpath (e.g. /anthropic),
// but /v1/models is typically only available at the root — strip subpath then retry.
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
 * Fetch upstream model list with 3-tier cache + OpenRouter fallback.
 */
export async function fetchUpstreamModels(opts: FetchModelsOptions): Promise<string[]> {
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const path = opts.modelsPath ?? "/v1/models";
  const key = `${opts.endpoint}|${path}`;

  // L1: memory
  const mem = memoryCache.get(key);
  if (mem && mem.expiresAt > Date.now()) return mem.models;

  // L2: disk
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

  // L3: network — try upstream first
  const url = joinUrl(opts.endpoint, path);
  const headers: Record<string, string> = {};
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  let models = await tryFetchModels(url, headers);

  // L3.5: strip known compat path suffix and retry (e.g. /anthropic → root /v1/models)
  if (models.length === 0) {
    const stripped = stripCompatSuffix(opts.endpoint);
    if (stripped) {
      const fallbackUrl = joinUrl(stripped, path);
      if (fallbackUrl !== url) {
        models = await tryFetchModels(fallbackUrl, headers);
      }
    }
  }

  // L4: fallback to OpenRouter
  if (models.length === 0) {
    const fallback = await tryFetchModels(OPENROUTER_FALLBACK, {});
    models = sanitizeOpenRouterModels(fallback);
  }

  // write back to cache
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
 * Fetch models from a single endpoint (no auth header because OpenRouter fallback is unauthenticated).
 */
async function tryFetchModels(url: string, headers: Record<string, string>): Promise<string[]> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => m.id);
    }
  } catch {
    // network/timeout failure
  }
  return [];
}

/**
 * Sanitize OpenRouter model names:
 * - strip :free suffix
 * - strip provider prefix (org/model → model)
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
  // avoid /v1/v1 duplication
  if (b.endsWith("/v1") && p.startsWith("/v1/")) return `${b}${p.slice(3)}`;
  if (b.endsWith("/v1beta") && p.startsWith("/v1beta/")) return `${b}${p.slice(7)}`;
  return `${b}${p}`;
}
// Path constants

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const XDG_CONFIG = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const APP_DIR = join(XDG_CONFIG, "cclau");
export const CONFIG_PATH = join(APP_DIR, "config.toml");
export const INVOCATION_DIR = APP_DIR; // temp settings files also go here

// Model list disk cache (used by fetchUpstreamModels)
const XDG_CACHE = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
export const APP_CACHE_DIR = join(XDG_CACHE, "cclau");
export const MODELS_CACHE_PATH = join(APP_CACHE_DIR, "models-cache.json");

/** Ensure the cclau cache dir exists (mkdir -p). */
export function ensureAppCacheDir(): void {
  mkdirSync(APP_CACHE_DIR, { recursive: true });
}

/**
 * Actual config path used for read/write. Priority: CCLAU_CONFIG env var > default XDG path.
 *
 * Function form (re-evaluated each call) lets tests redirect via env var after import,
 * without affecting the production path's frozen-const behavior.
 */
export function configPath(): string {
  return process.env.CCLAU_CONFIG ?? CONFIG_PATH;
}
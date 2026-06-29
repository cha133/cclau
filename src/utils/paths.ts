// 路径常量

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const XDG_CONFIG = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
export const APP_DIR = join(XDG_CONFIG, "cclau");
export const CONFIG_PATH = join(APP_DIR, "config.toml");
export const INVOCATION_DIR = APP_DIR; // 临时 settings 文件也放这里

// 模型列表磁盘缓存（fetchUpstreamModels 用）
const XDG_CACHE = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
export const APP_CACHE_DIR = join(XDG_CACHE, "cclau");
export const MODELS_CACHE_PATH = join(APP_CACHE_DIR, "models-cache.json");

/** 确保 cclau cache dir 存在（mkdir -p） */
export function ensureAppCacheDir(): void {
  mkdirSync(APP_CACHE_DIR, { recursive: true });
}

/**
 * 实际读写的 config 路径。优先级：CCLAU_CONFIG 环境变量 > 默认 XDG 路径。
 *
 * 函数形式（每次调用重新求值）让测试可以通过 env var 在 import 后再 redirect，
 * 不影响生产路径 `CONFIG_PATH` 的 frozen-const 行为。
 */
export function configPath(): string {
  return process.env.CCLAU_CONFIG ?? CONFIG_PATH;
}
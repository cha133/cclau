// ============================================================================
// alias 解析：name → (Subscription, modelId)
// 抄自 cctra src/core/resolve.ts（删除 plugin + 三协议相关）
//
// 解析优先级：
//   1. config.aliases[ref] 命中 → 递归 resolve 其 value（带 visited 防御环）
//   2. "provider/model" 拆分（按第一个 /）
//   3. 都不命中 → null（caller 决定 throw）
// ============================================================================

import type { Config, StoredSubscription, Subscription } from "../types.js";

export interface ResolvedModel {
  provider: Subscription;
  modelId: string;
}

/**
 * 解析模型引用字符串，返回 (provider, modelId)
 * alias 表优先；fallback 走 "provider/model" 拆分。
 * 不抛错（除非 alias 链有问题）—— caller 看到 null 再决定怎么报。
 */
export function resolveAlias(
  ref: string,
  config: Config,
): ResolvedModel | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;

  // 1. alias 表
  if (config.aliases[trimmed] !== undefined) {
    return resolveAliasChain(trimmed, config, new Set());
  }

  // 2. "provider/model" 格式
  if (trimmed.includes("/")) {
    const [providerName, modelPart] = trimmed.split("/", 2);
    if (!providerName || !modelPart) return null;
    const sub = getSubscriptionFromConfig(config, providerName);
    if (!sub) return null;
    const model = sub.models.find((m) => m.id === modelPart);
    if (!model) return null;
    return { provider: sub, modelId: model.id };
  }

  return null;
}

/**
 * 沿 alias 链解析到具体 model；理论上 value 只能是 "provider/model" 形态
 * （cclau alias / cclau switch 写入时都 normalize 成全名），不会构成多跳链；
 * 但保留 visited 防御性环检测（损坏 config / 用户手编 toml 时）。
 */
function resolveAliasChain(
  name: string,
  config: Config,
  visited: Set<string>,
): ResolvedModel {
  if (visited.has(name)) {
    throw new AliasResolveError(
      `Alias cycle detected: ${[...visited, name].join(" -> ")}.`,
    );
  }
  visited.add(name);

  const value = config.aliases[name];
  if (value === undefined) {
    throw new AliasResolveError(`Alias "${name}" not found.`);
  }
  if (value === "") {
    throw new AliasResolveError(
      `Alias "${name}" is unbound. Use \`cclau switch ${name} <provider>/<model>\` to bind.`,
    );
  }
  if (!value.includes("/")) {
    throw new AliasResolveError(
      `Alias "${name}" has invalid value "${value}". Expected "provider/model" or empty.`,
    );
  }

  const [src, mp] = value.split("/", 2);
  if (!src || !mp) {
    throw new AliasResolveError(
      `Alias "${name}" has invalid value "${value}". Expected "provider/model".`,
    );
  }

  const sub = getSubscriptionFromConfig(config, src);
  if (!sub) {
    throw new AliasResolveError(
      `Alias "${name}" points to unknown provider "${src}". Use \`cclau switch ${name}\` to rebind.`,
    );
  }
  const model = sub.models.find((m) => m.id === mp);
  if (!model) {
    throw new AliasResolveError(
      `Alias "${name}" points to missing model "${value}". Use \`cclau switch ${name}\` to rebind.`,
    );
  }
  return { provider: sub, modelId: model.id };
}

/**
 * 从 Config 直接拿 subscription（不用 loadAppConfig + getSubscription，避免循环 IO）。
 * StoredSubscription → Subscription 归一化跟 config.ts 一致。
 */
function getSubscriptionFromConfig(config: Config, name: string): Subscription | undefined {
  const stored = config.providers[name];
  if (!stored) return undefined;
  return normalizeStored(stored, name);
}

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

/** 解析错误（alias 链有问题 / unbound / missing） */
export class AliasResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliasResolveError";
  }
}
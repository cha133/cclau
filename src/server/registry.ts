// sidecar 路由注册表
//
// 把 N tier 的 (provider, model) 引用展平成 model id → RouteEntry 的 Map。
// handleMessages 按请求体里的 body.model 查找 entry，按 entry.mode 分发到
// 对应的 passthrough / convert handler。
//
// key 用 strip1m(t.model) —— claude code 内部 normalizeModelStringForAPI
// 会剥掉 [1m] 后缀（见 src/core/model-1m.ts 顶部注释），所以 sidecar 收到的是
// 已经剥过的字符串，registry 必须按剥后形态匹配。
//
// sidecar 模式下 resolveProfile 已经给 t.model 加了 `${provider.name}/` 前缀，
// 跨 provider 同 model id 不再撞 key（profile/doctor 都不再需要唯一性校验）。

import type { EndpointType, Rectifier, Subscription, SubscriptionMode } from "../types.js";
import { strip1m } from "../core/model-1m.js";

export type TierName = "opus" | "sonnet" | "haiku";

export interface RegistryTier {
  tier: TierName;
  /**
   * registry key 的原材料。会被 strip1m 后写入 Map。
   * - launch 场景：sidecar 模式下为 `${provider.name}/${base}[1m]`（resolveProfile 加前缀 + apply1m）
   * - doctor probe 场景：为 `claude-3-5-sonnet-20241022`（固定 probe 名）
   */
  model: string;
  /**
   * sidecar 转发给上游时用的 model id（剥前缀 + 剥 [1m]，上游能直接认的 base name）。
   * 不传则 fallback 到 strip1m(t.model)（对有 `${provider.name}/` 前缀的场景是错的，
   * 调用方应显式传）。
   */
  upstreamModel?: string;
  provider: Subscription;
}

export interface RouteEntry {
  /** 已 strip 末尾 / */
  endpoint: string;
  /** 空串兜底 */
  apiKey: string;
  type: EndpointType;
  mode: SubscriptionMode;
  /** rectify 模式挂载；direct/convert 模式下为 undefined */
  rectifier?: Rectifier;
  /** sidecar 转发给上游时的 model id（base name）。passthrough 必须用这个覆盖 body.model 再转给上游。 */
  upstreamModel: string;
}

export type Registry = Map<string, RouteEntry>;

export class RegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryBuildError";
  }
}

/**
 * 从 resolved tiers 构建 registry。
 * key = strip1m(t.model)，天然按 `${provider.name}/${base}` 消歧。
 * 不再校验 3 tier model id 唯一（resolveProfile 已通过 provider 前缀保证）。
 */
export function buildRegistry(tiers: RegistryTier[]): Registry {
  const reg: Registry = new Map();
  for (const t of tiers) {
    const provider = t.provider;
    const entry: RouteEntry = {
      endpoint: provider.endpoint.replace(/\/+$/, ""),
      apiKey: provider.apiKey ?? "",
      type: provider.type,
      mode: provider.mode,
      upstreamModel: t.upstreamModel ?? strip1m(t.model),
    };
    // 只有 rectify 模式挂 rectifier；direct/convert 不挂
    if (provider.mode === "rectify" && provider.rectifier) {
      entry.rectifier = provider.rectifier;
    }
    reg.set(strip1m(t.model), entry);
  }

  return reg;
}
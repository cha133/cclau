// sidecar 路由注册表
//
// refactor 之后：单 profile 概念，registry 只装 1 条 entry。
// key = strip1m(profile.model) —— claude-code 内部 normalizeModelStringForAPI
// 剥掉 [1m] 后缀（见 src/core/model-1m.ts 顶部注释），所以 sidecar 收到的是
// 已经剥过的字符串，registry 必须按剥后形态匹配。
//
// 跨 provider 消歧不再需要 —— 每个 profile 自带 endpoint + apiKey + model，
// 不会有跨 profile 同 model 的歧义（profile 名就是 namespace）。

import type { Mode, Profile, Rectifier } from "../types.js";
import { strip1m } from "../core/model-1m.js";

export interface RouteEntry {
  /** 已 strip 末尾 / */
  endpoint: string;
  apiKey: string;
  mode: Mode;
  /** 透传给上游的 model id（裸 base name） */
  model: string;
  /** 仅 rectify 模式挂载；direct / openai 模式下为 undefined */
  rectifier?: Rectifier;
}

export type Registry = Map<string, RouteEntry>;

export class RegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryBuildError";
  }
}

/**
 * 从单 profile 构建 registry（仅 1 条 entry）。
 * key = strip1m(profile.model)。
 */
export function buildRegistry(profile: Profile): Registry {
  const reg: Registry = new Map();
  const entry: RouteEntry = {
    endpoint: profile.endpoint.replace(/\/+$/, ""),
    apiKey: profile.apiKey,
    mode: profile.mode,
    model: profile.model,
  };
  // 仅 rectify 模式挂 rectifier；direct / openai 不挂
  if (profile.mode === "rectify" && profile.rectifier) {
    entry.rectifier = profile.rectifier;
  }
  reg.set(strip1m(profile.model), entry);
  return reg;
}
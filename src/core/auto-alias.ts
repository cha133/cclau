// ============================================================================
// Auto-alias 注册决策 + unbind 联动
// 抄自 cctra src/core/alias.ts（删除 plugin 相关）
//
// 规则：cclau add / edit 时，如果 model id 在所有 provider / 已有 aliases 内
//       都唯一，且没撞 source 名 → 静默注册 aliases[id] = "provider/id"
//       否则 → 不注册，用户必须用 provider/model 全名
// ============================================================================

import type { Config, ModelInfo } from "../types.js";

/**
 * 判定 id 是否可以安全地静默注册成 alias
 * @param excludeSource 跳过该 provider（用于 edit 时不算自己）
 */
export function canAutoRegisterAlias(
  id: string,
  config: Config,
  excludeSource?: string,
): boolean {
  if (!id) return false;
  // 1. id 不能撞已有 alias 名
  if (config.aliases[id] !== undefined) return false;
  // 2. id 不能撞 provider 名
  if (config.providers[id]) return false;
  // 3. id 在所有 provider 的 model.id 中必须唯一（除自身 provider）
  let count = 0;
  for (const [pname, p] of Object.entries(config.providers)) {
    if (pname === excludeSource) continue;
    if (p.models.some((m) => m.id === id)) count++;
    if (count > 1) return false;
  }
  // count <= 1：当前为 0（新建）或 1（已存在；通常发生在 add 完后再调一次，但 add
  //   流程里我们在 model 注册前调，所以 count=0；edit 流程里 excludeSource 跳过自己，
  //   仍是 0）
  return count <= 1;
}

/**
 * 算出 model 的 alias 值（"provider/id" 全名），返回 null 表示不能 auto-register
 * @param newBatch 本批正在处理的新 model 列表（防同批 id 重复）
 */
export function autoAliasValue(
  id: string,
  providerName: string,
  config: Config,
  newBatch?: ModelInfo[],
  excludeSource?: string,
): string | null {
  if (!canAutoRegisterAlias(id, config, excludeSource)) return null;
  if (newBatch?.some((m) => m.id === id)) return null;
  return `${providerName}/${id}`;
}

/**
 * 批量注册：逐个 model id 问 autoAliasValue，通过就写进 config.aliases
 * （in-place mutate config；调用方负责 saveAppConfig）
 */
export function registerAutoAliases(
  config: Config,
  providerName: string,
  modelIds: string[],
  excludeSource?: string,
): void {
  for (const id of modelIds) {
    const value = autoAliasValue(id, providerName, config, undefined, excludeSource);
    if (value) config.aliases[id] = value;
  }
}

/**
 * 把 value 等于 target 的 alias 全部设为 ""（unbound）
 * 用途：rm provider 时清空所有指向它的 alias；edit 删 model 时清空指向该 model 的 alias
 * @returns 被 unbind 的 alias 名列表（给 UI 提示用）
 */
export function unbindAliasesPointingTo(config: Config, target: string): string[] {
  const unbound: string[] = [];
  for (const [name, value] of Object.entries(config.aliases)) {
    if (value === target) {
      config.aliases[name] = "";
      unbound.push(name);
    }
  }
  return unbound;
}
// 命名工具：kebab-case + 冲突感知
//
// kebabCase：移植自 cctra src/providers/presets.ts:161
// suggestNameOnConflict：cclau 独有 — 同 provider 重复 add 时按 mode 自动加后缀
// validateKebabName：clack 的 validate 回调，返回错误字符串 / undefined

import type { SubscriptionMode } from "../types.js";

/**
 * 把任意字符串转成 kebab-case。
 * - 全小写
 * - 非 [a-z0-9] 字符 → 连字符
 * - 折叠连续连字符
 * - 去首尾连字符
 *
 * 例："Ark Agent Plan" → "ark-agent-plan"
 *     "Xiaomi MiMo Token Plan (China)" → "xiaomi-mimo-token-plan-china"
 *     "APIKEY.FUN" → "apikey-fun"
 */
export function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * 冲突感知的名字建议。
 *
 * 规则：
 * 1. desired 未被占用 → 返回 desired
 * 2. desired 被占用，且该已存在 provider 的 mode 与 newMode 不同 →
 *    返回 `desired-<newMode>`（如 deepseek 已是 direct，新增 rectify → deepseek-rectify）
 * 3. 否则（或 suffix 也被占）→ 返回 ""，调用方让用户手输
 *
 * @param desired 期望的名字（通常是 kebabCase(vendorName)）
 * @param existingNames 当前已存在的 provider 名字列表
 * @param existingModes 名字 → mode 的映射（用于判断"已存在的 mode 是什么"）
 * @param newMode 这次新增的 mode
 */
export function suggestNameOnConflict(
  desired: string,
  existingNames: string[],
  existingModes: Record<string, SubscriptionMode>,
  newMode: SubscriptionMode,
): string {
  if (!existingNames.includes(desired)) return desired;

  const existingMode = existingModes[desired];
  if (existingMode && existingMode !== newMode) {
    const suffixed = `${desired}-${newMode}`;
    if (!existingNames.includes(suffixed)) return suffixed;
  }

  return "";
}

/**
 * clack validate 回调：检查名字是否合法 + 不重名。
 *
 * @param v 用户输入
 * @param existingNames 已存在的 provider 名字列表
 */
export function validateKebabName(v: string | undefined, existingNames: string[]): string | undefined {
  if (!v || !v.trim()) return "Name is required.";
  const n = v.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
    return "Use kebab-case: lowercase letters, digits, hyphens; must start with alnum.";
  }
  if (n.length > 63) return "Name too long (max 63 chars).";
  if (existingNames.includes(n)) {
    return `Name "${n}" already exists. Pick a different one.`;
  }
  return undefined;
}

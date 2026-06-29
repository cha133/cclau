// cclau rm <name> - 删除 provider
//
// 顺手会级联：
//   1. 把引用了此 provider 的所有 profile tier 引用置空（避免悬挂引用）
//   2. v6：把所有指向该 provider model 的 alias unbind（value=""，保留 slot）
//
// fuzzy + 歧义保护：rm 不可逆，top-1/top-2 score 接近时拒绝执行。

import * as p from "@clack/prompts";
import {
  listProviderNames,
  removeSubscription,
  loadAppConfig,
  saveAppConfig,
  getSubscription,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { pc } from "../utils/logger.js";
import { unbindAliasesPointingTo } from "../core/auto-alias.js";

export async function rmCmd(name: string): Promise<void> {
  const all = listProviderNames();
  const top = fuzzyTopN(name, all, 2);
  if (top.length === 0) {
    p.log.error(`provider "${name}" 不存在。现有: ${all.join(", ") || "(空)"}`);
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" 模糊匹配到多个 provider: ${top.map((s) => s.name).join("、")}。rm 不可逆，请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`匹配到 provider "${resolved}"`));

  // 记录要 unbind 的 model targets（删之前快照）
  const sub = getSubscription(resolved);
  const aliasTargets: string[] = [];
  if (sub) {
    for (const m of sub.models) {
      aliasTargets.push(`${sub.name}/${m.id}`);
    }
  }

  // 先删 provider（含 profile tier 级联）
  const ok = await removeSubscription(resolved);
  if (!ok) {
    p.log.error(`provider "${resolved}" 不存在`);
    process.exit(1);
  }

  // 再 unbind 指向已删 provider model 的 alias（重新 load 因为 removeSubscription 写盘了）
  if (aliasTargets.length > 0) {
    const cfg2 = loadAppConfig();
    const unbound: string[] = [];
    for (const target of aliasTargets) {
      unbound.push(...unbindAliasesPointingTo(cfg2, target));
    }
    if (unbound.length > 0) {
      await saveAppConfig(cfg2);
      p.log.message(
        pc.dim(`unbind ${unbound.length} 个 alias: ${unbound.join(", ")}`),
      );
    }
  }

  p.log.success(`✓ 已删除 provider "${resolved}"`);
}
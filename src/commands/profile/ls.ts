// cclau profile ls - 列出所有 profile
// 输出每个 profile 的 opus/sonnet/haiku 3 个 tier 引用 + sidecar 决策

import * as p from "@clack/prompts";
import { getSubscription, listProfiles } from "../../config.js";
import { pc } from "../../utils/logger.js";
import type { Profile } from "../../types.js";

/**
 * 独立复算 sidecar 决策（不调 settings.resolveProfile —— 那样会 throw，
 * ls 不能因为某个 profile 引用了已删 provider 就整个挂掉）。
 */
function describeProfileMode(profile: Profile): string {
  const refs = (["opus", "sonnet", "haiku"] as const).map((t) => {
    const ref = profile[t];
    const provider = ref.provider ? getSubscription(ref.provider) : undefined;
    return { tier: t, provider };
  });

  // 任何 tier 引用了不存在的 provider → 标 unresolvable，ls 仍列出但提示
  const unresolved = refs.filter((r) => !r.provider);
  if (unresolved.length > 0) {
    return pc.red(`(unresolved: ${unresolved.map((r) => r.tier).join(",")})`);
  }

  const providers = new Set(refs.map((r) => r.provider!.name));
  const modes = new Set(refs.map((r) => r.provider!.mode));

  if (providers.size > 1) {
    return pc.yellow(`(sidecar: ${providers.size} provider)`);
  }
  if (modes.has("convert")) {
    return pc.yellow("(sidecar: convert)");
  }
  if (modes.has("rectify")) {
    return pc.yellow("(sidecar: rectify)");
  }
  return pc.green("(direct)");
}

export function profileListCmd(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    p.log.message(pc.dim("暂无 profile。运行 `cclau profile add` 添加一个。"));
    return;
  }

  console.log(pc.bold("Profile 列表："));
  console.log("");
  for (const p of profiles) {
    console.log(`  ${pc.bold(p.name)}  ${describeProfileMode(p)}`);
    for (const tier of ["opus", "sonnet", "haiku"] as const) {
      const ref = p[tier];
      const display = ref.provider ? `${ref.provider}/${ref.model}` : pc.red("(未设置)");
      console.log(`    ${pc.dim(tier.padEnd(7))} ${display}`);
    }
  }
  console.log("");
  p.log.message(pc.dim(`共 ${profiles.length} 个 profile`));
}
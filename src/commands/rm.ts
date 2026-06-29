// cclau rm <name> - 删除 profile
//
// fuzzy + 歧义保护：rm 不可逆，top-1/top-2 score 接近时拒绝执行。

import * as p from "@clack/prompts";
import { listProfileNames, removeProfile } from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { pc } from "../utils/logger.js";

export async function rmCmd(name: string): Promise<void> {
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 2);
  if (top.length === 0) {
    p.log.error(`profile "${name}" 不存在。现有: ${all.join(", ") || "(空)"}`);
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" 模糊匹配到多个 profile: ${top.map((s) => s.name).join("、")}。rm 不可逆，请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`匹配到 profile "${resolved}"`));

  const ok = await removeProfile(resolved);
  if (!ok) {
    p.log.error(`profile "${resolved}" 不存在`);
    process.exit(1);
  }

  p.log.success(`✓ 已删除 profile "${resolved}"`);
}
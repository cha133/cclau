// cclau profile rm <name> - 删除 profile

import * as p from "@clack/prompts";
import { listProfileNames, removeProfile } from "../../config.js";
import { fuzzyTopN, isAmbiguous } from "../../fuzzy.js";
import { pc } from "../../utils/logger.js";

export async function profileRmCmd(name: string): Promise<void> {
  // 1. fuzzy 解析 + 歧义保护（profile 删除不可逆）
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 2);
  if (top.length === 0) {
    p.log.error(`profile "${name}" 不存在。现有: ${all.join(", ") || "(空)"}`);
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" 模糊匹配到多个 profile: ${top.map((s) => s.name).join("、")}。请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;

  // 2. fuzzy 命中但名字不同 → 提示（与 edit.ts 同位置；intro 之前）
  if (resolved !== name) p.log.message(pc.dim(`匹配到 profile "${resolved}"`));

  // 3. intro banner
  p.intro(pc.bgCyan(pc.black(" cclau profile rm ")));

  // 4. 二次确认（用 resolved name，避免歧义删错）
  const r = await p.confirm({
    message: `删除 profile "${resolved}"?`,
    initialValue: false,
  });
  if (p.isCancel(r) || !r) {
    p.cancel("已取消");
    process.exit(0);
  }

  // 5. 执行删除
  const ok = await removeProfile(resolved);
  if (!ok) {
    // race: fuzzy 命中但 removeProfile miss
    p.log.error(`profile "${resolved}" 不存在`);
    process.exit(1);
  }
  // 用 p.log.success 而不是 p.outro —— outro 会输出 `└` 封闭角关闭 box，
  // 后续的 p.log.message 会从 `│` 重新开始一个新 box，视觉上断开。
  // log.success 保留 box 开启，trailing hint 顺着流。
  p.log.success(pc.green(`✓ 已删除 profile "${resolved}"`));
  p.log.message(
    pc.dim(`Provider 仍然存在，${pc.cyan(`\`cclau show ${resolved}\``)} 已无法访问此 profile。`),
  );
}
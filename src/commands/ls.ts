// cclau ls - 列出所有 profile
//
// refactor 之后：单 profile 概念，ls 只渲染 profile 表。
// 想看 model 详情用 `cclau show <name>`。

import { listProfiles } from "../config.js";
import { pc } from "../utils/logger.js";
import { padEndStr, printSection } from "../utils/table.js";
import { formatModelWith1m } from "../core/model-1m.js";

export function listCmd(): void {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.log(`${pc.cyan("ℹ")}  暂无 profile。运行 \`cclau add\` 添加一个。`);
    return;
  }

  const nameW = Math.max(...profiles.map((p) => p.name.length));
  const modeW = Math.max(...profiles.map((p) => p.mode.length));

  const rows = profiles.map((p) => {
    const modelStr = formatModelWith1m(p.model, p.supports1m);
    const def = p.default ? `${pc.green("★")} ` : "  ";
    return `${def}${pc.bold(padEndStr(p.name, nameW))}  ${pc.dim(padEndStr(p.mode, modeW))}  ${modelStr}`;
  });

  printSection("Profiles", rows);
}
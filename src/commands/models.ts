// cclau models - 列出所有 provider/model 组合
//
// 输出形如：
//   GLOBAL MODELS
//     deepseek/deepseek-chat
//     deepseek/deepseek-reasoner
//     deepseek-rectify/deepseek-chat [1m]
//     kimi/moonshot-v1-8k
//
// supports_1m=true 时在 model id 后面附 [1m] 标记（dim）。

import * as p from "@clack/prompts";
import { listSubscriptions } from "../config.js";
import { pc } from "../utils/logger.js";

export function modelsCmd(): void {
  const subs = listSubscriptions();
  if (subs.length === 0) {
    p.log.message(pc.dim("暂无 provider。运行 `cclau add` 添加一个。"));
    return;
  }

  let total = 0;
  console.log(pc.bold("Global Models"));
  console.log("");
  for (const s of subs) {
    if (s.models.length === 0) continue;
    for (const m of s.models) {
      const oneM = m.supports_1m ? " " + pc.dim("[1m]") : "";
      console.log(`  ${s.name}/${m.id}${oneM}`);
      total++;
    }
  }
  console.log("");
  if (total === 0) {
    p.log.message(pc.dim("(所有 provider 都没选 model)"));
    return;
  }
  p.log.message(pc.dim(`共 ${total} 个 model 来自 ${subs.length} 个 provider`));
}
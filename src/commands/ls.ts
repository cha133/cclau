// cclau ls - 列出 alias 和 model（3 段式 alias-rooted，抄自 cctra ls）
//   别名     - bound alias，name → provider/model [source]
//   未绑定   - unbound alias 槽位（cclau 默认 3 个）
//   其他模型 - 没被任何 alias 引用的 provider/model
//
// 注意：mode / endpoint / models=N 计数 / [1m] 标记在 ls 里都不显示
// —— 看 provider 细节用 `cclau show <name>`，看 model 列表用 `cclau models`。

import { loadAppConfig } from "../config.js";
import { pc } from "../utils/logger.js";
import { padEndStr, printSection } from "../utils/table.js";

interface ModelRow {
  full: string; // "source/modelId"
  source: string; // 显示用：cclau 无 vendor 字段，直接用 provider.name
}

export function listCmd(): void {
  const config = loadAppConfig();

  // 1. 收集 model
  const allModels: ModelRow[] = [];
  for (const [name, stored] of Object.entries(config.providers)) {
    for (const m of stored.models ?? []) {
      allModels.push({ full: `${name}/${m.id}`, source: name });
    }
  }

  // 2. 0 provider 空状态 —— 跟用户当前 ls 行为一致（先提示，再继续渲染 alias 段）
  if (allModels.length === 0) {
    console.log(`${pc.cyan("ℹ")}  暂无 provider。运行 \`cclau add\` 添加一个。`);
    if (Object.keys(config.aliases).length === 0) return; // 真·空配置，没有任何段可画
    console.log();
  }

  // 3. 分桶
  const aliasEntries = Object.entries(config.aliases);
  const bound = aliasEntries.filter(([, v]) => v !== "");
  const unbound = aliasEntries.filter(([, v]) => v === "").map(([n]) => n);

  const aliasedFullNames = new Set(bound.map(([, v]) => v));
  const otherModels = allModels.filter((m) => !aliasedFullNames.has(m.full));

  // 4. 排序：bound 按 (value, name) 让同 model 的 alias 物理聚集
  bound.sort(([na, va], [nb, vb]) => va.localeCompare(vb) || na.localeCompare(nb));
  unbound.sort((a, b) => a.localeCompare(b));
  otherModels.sort((a, b) => a.full.localeCompare(b.full));

  // 5. ANSI-aware 列宽
  const aliasW = bound.length > 0 ? Math.max(...bound.map(([n]) => n.length)) : 0;
  const valueW = bound.length > 0 ? Math.max(...bound.map(([, v]) => v.length)) : 0;
  const otherW = otherModels.length > 0 ? Math.max(...otherModels.map((m) => m.full.length)) : 0;

  // 6. 渲染
  if (bound.length > 0) {
    const rows = bound.map(([name, value]) => {
      // 找 source 显示名（找不到时回退到 value 前缀）
      const src = allModels.find((m) => m.full === value)?.source ?? value.split("/", 1)[0]!;
      return `${pc.green(padEndStr(name, aliasW))}  ${pc.dim(pc.cyan("→"))} ${padEndStr(value, valueW)}  ${pc.dim(`[${src}]`)}`;
    });
    printSection("别名", rows);
  }

  if (unbound.length > 0) {
    if (bound.length > 0) console.log();
    printSection("未绑定", unbound.map((n) => pc.dim(n)));
  }

  if (otherModels.length > 0) {
    if (bound.length > 0 || unbound.length > 0) console.log();
    // 其他模型段：source 与 name 前缀必然相同，省略 [source] 避免冗余
    printSection("其他模型", otherModels.map((m) => padEndStr(m.full, otherW)));
  }
}
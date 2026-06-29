// cclau show <name> - 显示 provider 或 profile 详情
// refactor 之后：name 既可能是 provider 也可能是 profile，分别渲染
// v6：provider 视图的 model 行尾追加 (aliases: g, fast) —— 反向查 alias 表

import * as p from "@clack/prompts";
import { getProfile, getSubscription, listProfileNames, listProviderNames, loadAppConfig } from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { AnthropicRectifier } from "../types.js";
import { pc } from "../utils/logger.js";

function maskKey(key: string | undefined): string {
  if (!key) return pc.dim("(未设置)");
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

/** 数 AnthropicRectifier 里非空字段（不暴露具体内容，只数数量） */
function countRectifierRules(r: AnthropicRectifier | undefined): number {
  if (!r) return 0;
  let n = 0;
  if (r.modelAlias) n++;
  if (r.requestHeaders) n++;
  if (r.requestTransform) n++;
  if (r.responseTransform) n++;
  if (r.streamChunkTransform) n++;
  return n;
}

function showProvider(name: string): void {
  const sub = getSubscription(name);
  if (!sub) return; // 调用方已查过，这里不应 miss

  // v6：反向查 alias 表，收集指向此 provider 任何 model 的 alias 名
  const config = loadAppConfig();
  const aliasesByModel = new Map<string, string[]>();
  for (const [aliasName, value] of Object.entries(config.aliases)) {
    if (!value) continue;
    const [pname, mid] = value.split("/", 2);
    if (!pname || !mid) continue;
    if (pname !== sub.name) continue;
    const list = aliasesByModel.get(mid) ?? [];
    list.push(aliasName);
    aliasesByModel.set(mid, list);
  }

  const modeColor = sub.mode === "direct" ? pc.green : sub.mode === "rectify" ? pc.yellow : pc.cyan;
  console.log(pc.bold(`Provider：${sub.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${sub.endpoint}`);
  console.log(`  ${pc.dim("type    :")} ${sub.type}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(sub.mode)}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(sub.apiKey)}`);
  console.log(`  ${pc.dim("models  :")}`);
  if (sub.models.length === 0) {
    console.log(`    ${pc.dim("(无)")}`);
  } else {
    for (const m of sub.models) {
      const oneM = m.supports_1m ? pc.dim(" [1m]") : "";
      const aliasList = aliasesByModel.get(m.id);
      const aliasHint = aliasList && aliasList.length > 0
        ? pc.dim(`  (aliases: ${aliasList.join(", ")})`)
        : "";
      console.log(`    - ${m.id}${oneM}${aliasHint}`);
    }
  }
  console.log(`  ${pc.dim("createdAt:")} ${new Date(sub.createdAt).toISOString()}`);
  console.log(`  ${pc.dim("updatedAt:")} ${new Date(sub.updatedAt).toISOString()}`);
  if (sub.rectifier) {
    const n = countRectifierRules(sub.rectifier.anthropic);
    console.log(`  ${pc.dim("rectifier:")} ${n} rule(s) active`);
  }
}

function showProfile(name: string): void {
  const profile = getProfile(name);
  if (!profile) return;

  console.log(pc.bold(`Profile：${profile.name}`));
  for (const tier of ["opus", "sonnet", "haiku"] as const) {
    const ref = profile[tier];
    console.log(`  ${pc.dim(`${tier.padEnd(7)}:`)} ${ref.provider ? `${ref.provider}/${ref.model}` : pc.red("(未设置)")}`);
  }
  console.log(`  ${pc.dim("createdAt:")} ${new Date(profile.createdAt).toISOString()}`);
  console.log(`  ${pc.dim("updatedAt:")} ${new Date(profile.updatedAt).toISOString()}`);
}

export function showCmd(name: string): void {
  // 双 fuzzy：profile + provider 各取 top-1，按 score 严格大于选 profile
  // （launch 也只认 profile，show 沿用同样优先级）
  const profileTop = fuzzyTopN(name, listProfileNames(), 1);
  const providerTop = fuzzyTopN(name, listProviderNames(), 1);
  const pHit = profileTop[0];
  const vHit = providerTop[0];

  if (pHit && (!vHit || pHit.score > vHit.score)) {
    if (pHit.name !== name) p.log.message(pc.dim(`匹配到 profile "${pHit.name}"`));
    showProfile(pHit.name);
    return;
  }
  if (vHit) {
    if (vHit.name !== name) p.log.message(pc.dim(`匹配到 provider "${vHit.name}"`));
    showProvider(vHit.name);
    return;
  }

  // 都找不到 —— 给 did-you-mean（合并两个 pool 的 top-3）
  const suggest = [...profileTop, ...providerTop].slice(0, 3).map((s) => s.name);
  const hint = suggest.length ? ` 你是想: ${suggest.join("、")}？` : "";
  p.log.error(`"${name}" 不存在。${hint}运行 ${pc.cyan("`cclau ls`")} 看 provider 列表，${pc.cyan("`cclau profile ls`")} 看 profile 列表。`);
  process.exit(1);
}

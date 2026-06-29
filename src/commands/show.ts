// cclau show <name> - 显示 profile 详情
//
// refactor 之后：name 只可能是 profile（provider 概念已删）。

import * as p from "@clack/prompts";
import { getProfile, listProfileNames } from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { Profile } from "../types.js";
import { pc } from "../utils/logger.js";
import { formatModelWith1m } from "../core/model-1m.js";

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

export function showCmd(name: string): void {
  const all = listProfileNames();
  const top = fuzzyTopN(name, all, 1);
  const hit = top[0];
  if (!hit) {
    const hint = all.length > 0 ? ` 你是想: ${all.slice(0, 3).join("、")}？` : "";
    p.log.error(`"${name}" 不存在。${hint}运行 ${pc.cyan("`cclau ls`")} 看 profile 列表。`);
    process.exit(1);
  }
  if (hit.name !== name) p.log.message(pc.dim(`匹配到 profile "${hit.name}"`));

  const profile = getProfile(hit.name);
  if (!profile) {
    p.log.error(`profile "${hit.name}" 不存在`);
    process.exit(1);
  }

  printProfile(profile);
}

function printProfile(p: Profile): void {
  const modeColor =
    p.mode === "direct" ? pc.green : p.mode === "rectify" ? pc.yellow : pc.cyan;
  console.log(pc.bold(`Profile：${p.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${p.endpoint}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(p.apiKey)}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(p.mode)}`);
  console.log(
    `  ${pc.dim("model   :")} ${formatModelWith1m(p.model, p.supports1m, pc.dim)}`,
  );
  console.log(`  ${pc.dim("default :")} ${p.default ? pc.green("true") : "false"}`);
  console.log(`  ${pc.dim("createdAt:")} ${new Date(p.createdAt).toISOString()}`);
  console.log(`  ${pc.dim("updatedAt:")} ${new Date(p.updatedAt).toISOString()}`);
}
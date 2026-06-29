// cclau edit - 编辑 provider 的 model 集合（紧抄 cctra edit 风格）
//
// 流程：
//   1. 加载 provider；不存在直接报错退出
//   2. spinner 拉上游 models（失败也 OK，仅能 toggle current）
//   3. 合并 options：current model 预勾 + hint:"current"；new 候选不勾 + hint:"new"
//   4. multiselect with initialValues 让用户 toggle
//   5. 算 diff（removed / addedIds）
//   6. 无变更早退；有变更则对新增 model 逐个问 1m（旧 model 的 supports_1m 保留）
//   7. upsertSubscription 写盘
//
// 仅动 models 集合 —— endpoint / apiKey / type / mode / rectifier / createdAt
// 全部 spread `...sub` 透传。想改这些字段请手编 TOML（BOARD.md 指导思想）。

import * as p from "@clack/prompts";
import { getSubscription, listProviderNames, upsertSubscription, loadAppConfig, saveAppConfig } from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { ModelInfo, Subscription } from "../types.js";
import { pc } from "../utils/logger.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import { registerAutoAliases, unbindAliasesPointingTo } from "../core/auto-alias.js";

export async function editCmd(name: string): Promise<void> {
  // fuzzy 解析：silent top-1 + 提示（edit 是非破坏操作，不需歧义保护）
  const top = fuzzyTopN(name, listProviderNames(), 1);
  if (top.length === 0) {
    const all = listProviderNames();
    p.log.error(`provider "${name}" 不存在。现有: ${all.join(", ") || "(空)"}`);
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`匹配到 provider "${resolved}"`));

  const sub = getSubscription(resolved);
  if (!sub) {
    // race: fuzzy 命中但 getSubscription miss（极罕见，理论上同步）
    p.log.error(`provider "${resolved}" 不存在`);
    process.exit(1);
  }

  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau edit ")));

  const modeColor = sub.mode === "direct" ? pc.green : sub.mode === "rectify" ? pc.yellow : pc.cyan;
  p.log.message(
    `Provider: ${pc.bold(sub.name)} (${modeColor(sub.mode)}, ${sub.type}, ${sub.models.length} model${sub.models.length === 1 ? "" : "s"})`,
  );

  // 1. 拉上游 models
  const s = p.spinner();
  s.start("Fetching model list from upstream...");
  let upstreamNames: string[] = [];
  try {
    upstreamNames = await fetchUpstreamModels({
      endpoint: sub.endpoint.trim(),
      token: (sub.apiKey ?? "").trim(),
    });
    s.stop(`Found ${upstreamNames.length} model(s).`);
  } catch {
    s.stop("Failed to fetch upstream models, you can still toggle existing ones.");
  }

  // 2. 合并 options：current 预勾 + new 不勾（用 hint 视觉区分）
  const currentIds = new Set(sub.models.map((m) => m.id));
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  for (const m of sub.models) {
    options.push({ value: m.id, label: m.id, hint: "current" });
  }
  for (const id of [...new Set(upstreamNames)].sort((a, b) => a.localeCompare(b))) {
    if (!currentIds.has(id)) {
      options.push({ value: id, label: id, hint: "new" });
    }
  }

  if (options.length === 0) {
    p.outro(pc.yellow("没有可编辑的 model（当前为空且上游也没拉到）"));
    return;
  }

  // 3. multiselect 预选当前
  const res = await p.multiselect({
    message: "勾选要保留的 model（空格切换；勾上的 = 保留/新增，没勾 = 移除）：",
    options,
    required: false,
    initialValues: sub.models.map((m) => m.id),
  });
  if (p.isCancel(res)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const selected = res as string[];

  // 4. diff
  const selectedSet = new Set(selected);
  const removed = sub.models.filter((m) => !selectedSet.has(m.id));
  const addedIds = selected.filter((id) => !currentIds.has(id));

  if (removed.length === 0 && addedIds.length === 0) {
    p.outro(pc.dim("无变更"));
    return;
  }

  // 5. 对新增 model 问 1m（与 add 第 8 步一致；老 model 保留旧 supports_1m）
  const newModelInfos: ModelInfo[] = [];
  for (const id of addedIds) {
    const r = await p.confirm({
      message: `Model "${id}" 是否支持 1M context？`,
      initialValue: true,
    });
    if (p.isCancel(r)) {
      p.cancel("已取消");
      process.exit(0);
    }
    newModelInfos.push({ id, supports_1m: r });
  }

  const keptModels = sub.models.filter((m) => selectedSet.has(m.id));
  const finalModels = [...keptModels, ...newModelInfos];

  // 6. 写盘 —— spread 保留 endpoint / apiKey / type / mode / rectifier / createdAt
  const updated: Subscription = {
    ...sub,
    models: finalModels,
    updatedAt: Date.now(),
  };
  await upsertSubscription(updated);

  // v6：alias 联动 —— 新增 model auto-register；移除 model unbind 指向它的 alias
  const config = loadAppConfig();
  let aliasChanged = false;
  if (addedIds.length > 0) {
    // excludeSource = sub.name（edit 时不算自己）
    registerAutoAliases(config, sub.name, addedIds, sub.name);
    aliasChanged = true;
  }
  if (removed.length > 0) {
    for (const m of removed) {
      const target = `${sub.name}/${m.id}`;
      const unbound = unbindAliasesPointingTo(config, target);
      if (unbound.length > 0) aliasChanged = true;
    }
  }
  if (aliasChanged) await saveAppConfig(config);

  p.outro(
    pc.green(
      `✓ 已更新 provider "${sub.name}"（-${removed.length} +${addedIds.length}，共 ${finalModels.length} model${finalModels.length === 1 ? "" : "s"}）`,
    ),
  );
}

// cclau edit <name> - 编辑 profile（单 model 6 字段）
//
// 可改字段：endpoint / apiKey / mode / model / supports1m / default
//
// 流程：
//   1. fuzzy 解析 profile 名（edit 是非破坏，silent top-1 即可）
//   2. 渲染当前 profile
//   3. select 菜单循环选字段编辑（done 退出）
//   4. 改 default 时清掉其他 profile 的 default 标志
//   5. 写盘

import * as p from "@clack/prompts";
import {
  getProfile,
  listProfiles,
  listProfileNames,
  upsertProfile,
} from "../config.js";
import { fuzzyTopN } from "../fuzzy.js";
import type { Mode, Profile } from "../types.js";
import { pc } from "../utils/logger.js";

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

export async function editCmd(name: string): Promise<void> {
  // 1. fuzzy 解析
  const top = fuzzyTopN(name, listProfileNames(), 1);
  if (top.length === 0) {
    const all = listProfileNames();
    p.log.error(`profile "${name}" 不存在。现有: ${all.join(", ") || "(空)"}`);
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== name) p.log.message(pc.dim(`匹配到 profile "${resolved}"`));

  const original = getProfile(resolved);
  if (!original) {
    p.log.error(`profile "${resolved}" 不存在`);
    process.exit(1);
  }

  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau edit ")));

  // 2. 渲染当前
  printProfile(original);

  // 3. 字段菜单循环
  let current: Profile = { ...original };

  while (true) {
    const field = await p.select({
      message: "编辑哪个字段？（done 退出）",
      options: [
        { value: "endpoint", label: "endpoint", hint: current.endpoint },
        { value: "apiKey", label: "apiKey", hint: maskKey(current.apiKey) },
        { value: "mode", label: "mode", hint: current.mode },
        { value: "model", label: "model", hint: current.model },
        {
          value: "supports1m",
          label: "supports1m",
          hint: String(current.supports1m),
        },
        {
          value: "default",
          label: "default",
          hint: current.default ? "true" : "false",
        },
        { value: "done", label: "done", hint: "退出编辑" },
      ],
    });
    if (p.isCancel(field)) {
      p.cancel("已取消");
      process.exit(0);
    }
    if (field === "done") break;

    current = await editField(current, field);
    p.log.success(`已更新 ${field}`);
    console.log();
  }

  // 4. 是否有变更？
  const changed = isChanged(original, current);
  if (!changed) {
    p.outro(pc.dim("无变更"));
    return;
  }

  // 5. default 联动：清掉其他 profile 的 default
  if (current.default === true) {
    for (const prof of listProfiles()) {
      if (prof.name !== current.name && prof.default === true) {
        const updated: Profile = { ...prof };
        delete updated.default;
        updated.updatedAt = Date.now();
        await upsertProfile(updated);
      }
    }
  }

  current.updatedAt = Date.now();
  await upsertProfile(current);

  p.outro(pc.green(`✓ 已保存 profile "${current.name}"`));
}

function printProfile(profile: Profile): void {
  const modeColor =
    profile.mode === "direct"
      ? pc.green
      : profile.mode === "rectify"
        ? pc.yellow
        : pc.cyan;
  console.log(pc.bold(`Profile: ${profile.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${profile.endpoint}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(profile.apiKey)}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(profile.mode)}`);
  console.log(`  ${pc.dim("model   :")} ${profile.model}`);
  console.log(`  ${pc.dim("1m      :")} ${profile.supports1m}`);
  console.log(`  ${pc.dim("default :")} ${profile.default ? "true" : "false"}`);
}

type Field = "endpoint" | "apiKey" | "mode" | "model" | "supports1m" | "default";

async function editField(profile: Profile, field: Field): Promise<Profile> {
  switch (field) {
    case "endpoint": {
      const v = await p.text({
        message: "endpoint：",
        initialValue: profile.endpoint,
        validate: (s) => (s ? undefined : "不能为空"),
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      return { ...profile, endpoint: v };
    }
    case "apiKey": {
      const v = await p.password({
        message: "apiKey：",
        validate: (s) => (s ? undefined : "不能为空"),
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      return { ...profile, apiKey: v };
    }
    case "mode": {
      const v = await p.select<Mode>({
        message: "mode：",
        initialValue: profile.mode,
        options: [
          { value: "direct" as const, label: "direct", hint: "anthropic 直连" },
          {
            value: "rectify" as const,
            label: "rectify",
            hint: "anthropic 整流",
          },
          {
            value: "openai" as const,
            label: "openai",
            hint: "openai → anthropic 转换",
          },
        ],
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      return { ...profile, mode: v };
    }
    case "model": {
      const v = await p.text({
        message: "model：",
        initialValue: profile.model,
        validate: (s) => (s ? undefined : "不能为空"),
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      return { ...profile, model: v };
    }
    case "supports1m": {
      const v = await p.confirm({
        message: "supports1m：",
        initialValue: profile.supports1m,
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      return { ...profile, supports1m: v };
    }
    case "default": {
      const v = await p.confirm({
        message: "default：",
        initialValue: profile.default === true,
      });
      if (p.isCancel(v)) {
        p.cancel("已取消");
        process.exit(0);
      }
      const updated: Profile = { ...profile };
      if (v) updated.default = true;
      else delete updated.default;
      return updated;
    }
  }
}

function isChanged(a: Profile, b: Profile): boolean {
  return (
    a.endpoint !== b.endpoint ||
    a.apiKey !== b.apiKey ||
    a.mode !== b.mode ||
    a.model !== b.model ||
    a.supports1m !== b.supports1m ||
    (a.default === true) !== (b.default === true)
  );
}
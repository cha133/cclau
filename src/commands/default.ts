// ============================================================================
// cclau default [name] [--unset]
//
// nvm 风格：
//   cclau default              —— 显示当前 default profile
//   cclau default <name>       —— 设为 default（fuzzy 匹配）
//   cclau default --unset      —— 取消所有 default
//
// 配置文件层只允许一个 default。设新 default 时自动清掉其他 profile 的 default 标志。
// ============================================================================

import { Command } from "commander";
import * as p from "@clack/prompts";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import {
  getDefaultProfile,
  getProfile,
  listProfiles,
  upsertProfile,
} from "../config.js";
import { pc } from "../utils/logger.js";

export function registerDefault(program: Command): void {
  program
    .command("default [name]")
    .description("Show or set the default profile (nvm-style)")
    .option("--unset", "Unset the current default profile")
    .action(async (name?: string, opts?: { unset?: boolean }) => {
      if (opts?.unset) {
        await unsetDefault();
        return;
      }
      if (!name) {
        showDefault();
        return;
      }
      await setDefault(name);
    });
}

// ---------------------------------------------------------------------------

function showDefault(): void {
  const all = listProfiles();
  const defaults = all.filter((p) => p.default === true);

  if (defaults.length > 1) {
    // 配置脏：多 default。让用户清。
    console.log(pc.red(`错误：多个 profile 都标了 default：`));
    for (const prof of defaults) {
      console.log(pc.dim(`  - ${prof.name}`));
    }
    console.log(
      pc.dim(`运行 ${pc.cyan("`cclau default <name>`")} 重设一个，或 ${pc.cyan("`cclau edit <name>`")} 取消多余 default。`),
    );
    return;
  }

  const def = getDefaultProfile();
  if (!def) {
    console.log(pc.dim("(无 default profile)"));
    console.log(pc.dim(`运行 ${pc.cyan("`cclau default <name>`")} 设定。`));
    return;
  }

  console.log(
    `${pc.cyan(def.name)}  ${pc.dim(`(mode: ${def.mode}, model: ${def.model})`)}`,
  );
}

async function setDefault(name: string): Promise<void> {
  const profiles = listProfiles();
  if (profiles.length === 0) {
    p.log.error(`暂无 profile。先运行 ${pc.cyan("`cclau add`")} 创建一个。`);
    process.exit(1);
  }

  const top = fuzzyTopN(name, profiles.map((p) => p.name), 2);
  if (top.length === 0) {
    p.log.error(
      `没有匹配到 profile "${name}"。现有: ${profiles.map((p) => p.name).join(", ")}`,
    );
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${name}" 模糊匹配到多个 profile: ${top.map((s) => s.name).join("、")}。请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;

  const target = getProfile(resolved);
  if (!target) {
    p.log.error(`profile "${resolved}" 不存在`);
    process.exit(1);
  }

  // 清掉其他 default（保证配置层只有一个）
  for (const prof of profiles) {
    if (prof.name !== resolved && prof.default === true) {
      const updated: typeof prof = { ...prof };
      delete updated.default;
      updated.updatedAt = Date.now();
      await upsertProfile(updated);
    }
  }

  if (target.default === true) {
    p.log.info(`"${resolved}" 已是 default`);
    return;
  }

  const updated: typeof target = {
    ...target,
    default: true,
    updatedAt: Date.now(),
  };
  await upsertProfile(updated);
  p.log.success(`✓ default → "${resolved}"`);
}

async function unsetDefault(): Promise<void> {
  const profiles = listProfiles();
  const defaults = profiles.filter((p) => p.default === true);
  if (defaults.length === 0) {
    p.log.info("(无 default profile 需要 unset)");
    return;
  }

  for (const prof of defaults) {
    const updated: typeof prof = { ...prof };
    delete updated.default;
    updated.updatedAt = Date.now();
    await upsertProfile(updated);
  }

  if (defaults.length === 1) {
    p.log.success(`✓ 已取消 default "${defaults[0]!.name}"`);
  } else {
    p.log.success(
      `✓ 已取消 ${defaults.length} 个 default profile: ${defaults.map((d) => d.name).join(", ")}`,
    );
  }
}
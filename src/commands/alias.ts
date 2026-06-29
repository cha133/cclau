// ============================================================================
// cclau alias [name] [target]   — show / set / list aliases
// cclau alias add <name>        — 创建 unbound 槽位
// cclau alias rm <name>         — 删 alias
//
// 抄自 cctra src/commands/alias.ts（删除 plugin 相关 + 用 @clack/prompts）
// ============================================================================

import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadAppConfig, saveAppConfig } from "../config.js";
import { resolveAlias, AliasResolveError } from "../core/alias.js";
import {
  describeNameOwner,
  isValidAliasName,
  nameTakenAnywhere,
} from "../core/namespace.js";
import { pc } from "../utils/logger.js";
import type { Config } from "../types.js";

/** alias 子命令名，禁止占用为 alias name（避免 commander 路由歧义） */
const RESERVED_SUBCOMMANDS = new Set(["add", "rm"]);

export function registerAlias(program: Command): void {
  const alias = program
    .command("alias [name] [target]")
    .description("Show, set, or list aliases (run with no args to list all)")
    .action(async (name?: string, target?: string) => {
      if (!name) return showList();
      if (target === undefined) return showOne(name);
      await setAlias(name, target);
    });

  alias
    .command("add <name>")
    .description("Create an empty (unbound) alias slot")
    .action(async (name: string) => {
      await addEmpty(name);
    });

  alias
    .command("rm <name>")
    .description("Remove an alias")
    .action(async (name: string) => {
      await removeAlias(name);
    });
}

// ---------------------------------------------------------------------------

function showList(): void {
  const config = loadAppConfig();
  const entries = Object.entries(config.aliases).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    p.log.message(pc.dim("(无 alias)"));
    return;
  }
  const maxName = Math.max(...entries.map(([n]) => n.length));
  console.log(pc.bold("Alias 列表："));
  console.log("");
  for (const [name, value] of entries) {
    const padded = pc.green(name.padEnd(maxName));
    const tail = value
      ? `${pc.dim("→")} ${pc.cyan(value)}`
      : pc.dim("(unbound)");
    console.log(`  ${padded}  ${tail}`);
  }
  console.log("");
  p.log.message(pc.dim(`共 ${entries.length} 个 alias`));
}

function showOne(name: string): void {
  const config = loadAppConfig();
  const value = config.aliases[name];
  if (value === undefined) {
    p.log.error(`alias "${name}" 不存在`);
    process.exit(1);
  }
  console.log(value || pc.dim("(unbound)"));
}

async function setAlias(name: string, target: string): Promise<void> {
  const trimmed = target.trim();
  const config = loadAppConfig();
  let resolved;
  try {
    resolved = resolveAlias(trimmed, config);
  } catch (e) {
    if (e instanceof AliasResolveError) {
      p.log.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  if (!resolved) {
    p.log.error(
      `target "${trimmed}" 无法解析为已知 model。运行 ${pc.cyan("`cclau models`")} 看可用 model。`,
    );
    process.exit(1);
  }
  const fullName = `${resolved.provider.name}/${resolved.modelId}`;

  // 已存在 alias → 直接 update
  if (config.aliases[name] !== undefined) {
    if (config.aliases[name] === fullName) {
      p.log.info(`alias "${name}" 已指向 ${fullName}，无变化`);
      return;
    }
    config.aliases[name] = fullName;
    await saveAppConfig(config);
    p.log.success(`✓ alias "${name}" → ${fullName}`);
    return;
  }

  // 不存在 → auto-add；先校验
  assertCanCreateAlias(config, name);
  config.aliases[name] = fullName;
  await saveAppConfig(config);
  p.log.success(`✓ created alias "${name}" → ${fullName}`);
}

async function addEmpty(name: string): Promise<void> {
  const config = loadAppConfig();
  assertCanCreateAlias(config, name);
  config.aliases[name] = "";
  await saveAppConfig(config);
  p.log.success(
    `✓ 创建空 alias "${name}"。运行 ${pc.cyan(`\`cclau switch ${name} <provider>/<model>\``)} 绑定。`,
  );
}

async function removeAlias(name: string): Promise<void> {
  const config = loadAppConfig();
  if (config.aliases[name] === undefined) {
    p.log.error(`alias "${name}" 不存在`);
    process.exit(1);
  }
  delete config.aliases[name];
  await saveAppConfig(config);
  p.log.success(`✓ 已删除 alias "${name}"`);
}

// ---------------------------------------------------------------------------

/** 创建新 alias 前的统一校验：命名 + 保留字 + 跨 namespace 冲突 */
function assertCanCreateAlias(config: Config, name: string): void {
  if (!isValidAliasName(name)) {
    p.log.error(
      `alias 名 "${name}" 不合法。必须是 kebab-case，1-63 字符（小写字母/数字/连字符）。`,
    );
    process.exit(1);
  }
  if (RESERVED_SUBCOMMANDS.has(name)) {
    p.log.error(`"${name}" 与保留子命令名冲突。换一个。`);
    process.exit(1);
  }
  if (nameTakenAnywhere(config, name)) {
    const owner = describeNameOwner(config, name);
    p.log.error(`名字 "${name}" 已被 ${owner} 占用`);
    process.exit(1);
  }
}
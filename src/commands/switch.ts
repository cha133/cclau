// ============================================================================
// cclau switch [name] [target]
// 交互式 / 非交互式切换 alias 指向。
//
// - 无参：prompts 选 alias，prompts 选 model
// - 只给 name：alias 存在则 prompts 选 model；不存在则 confirm 创建后 prompts 选
// - 给齐 name + target：直接 set/create-then-set
//
// 抄自 cctra src/commands/switch.ts（删除 plugin 相关 + 用 @clack/prompts）
// ============================================================================

import { Command } from "commander";
import * as p from "@clack/prompts";
import { loadAppConfig, saveAppConfig } from "../config.js";
import { resolveAlias, AliasResolveError } from "../core/alias.js";
import {
  describeNameOwner,
  isValidAliasName,
  nameTakenAnywhere,
  RESERVED_SUBCOMMANDS,
} from "../core/namespace.js";
import { listSubscriptions } from "../config.js";
import { pc } from "../utils/logger.js";
import type { Config } from "../types.js";

export function registerSwitch(program: Command): void {
  program
    .command("switch [name] [target]")
    .description(
      "Switch an alias's binding. Interactive (prompts) when args omitted.",
    )
    .action(async (name?: string, target?: string) => {
      const config = loadAppConfig();

      // 1. 决定要操作哪个 alias
      let aliasName: string;
      try {
        aliasName = name ?? (await pickAliasInteractive(config));
      } catch (e) {
        // 用户取消（Ctrl-C）
        if (e === Symbol.for("clack:cancel")) process.exit(0);
        throw e;
      }

      // 2. alias 不存在 → 确认创建
      const exists = config.aliases[aliasName] !== undefined;
      if (!exists) {
        try {
          assertCanCreateAlias(config, aliasName);
        } catch (err) {
          p.log.error((err as Error).message);
          process.exit(1);
        }
        const create = await p.confirm({
          message: `alias "${aliasName}" 不存在。创建?`,
          initialValue: true,
        });
        if (p.isCancel(create)) process.exit(0);
        if (!create) process.exit(0);
      }

      // 3. 决定 target
      let aliasTarget: string;
      try {
        aliasTarget = target ?? (await pickModelInteractive(
          exists
            ? `将 alias "${aliasName}" 绑定到:`
            : `绑定新 alias "${aliasName}" 到:`,
        ));
      } catch (e) {
        if (e === Symbol.for("clack:cancel")) process.exit(0);
        throw e;
      }

      // 4. 写入
      await doSwitch(aliasName, aliasTarget, !exists);
    });
}

// ---------------------------------------------------------------------------

async function pickAliasInteractive(config: Config): Promise<string> {
  const entries = Object.entries(config.aliases).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) {
    p.log.error("还没有 alias。先运行 `cclau alias add <name>` 创建一个。");
    process.exit(1);
  }
  const options = entries.map(([name, value]) => ({
    value: name,
    label: name,
    hint: value || "unbound",
  }));
  const picked = await p.select({
    message: "Switch 哪个 alias?",
    options,
  });
  if (p.isCancel(picked)) process.exit(0);
  return picked as string;
}

async function pickModelInteractive(message: string): Promise<string> {
  const options: Array<{ value: string; label: string }> = [];
  for (const sub of listSubscriptions()) {
    for (const m of sub.models) {
      options.push({
        value: `${sub.name}/${m.id}`,
        label: `${sub.name}/${m.id}`,
      });
    }
  }
  if (options.length === 0) {
    p.log.error("还没有 model。先运行 `cclau add` 添加 provider。");
    process.exit(1);
  }
  options.sort((a, b) => a.label.localeCompare(b.label));
  const picked = await p.select({ message, options });
  if (p.isCancel(picked)) process.exit(0);
  return picked as string;
}

async function doSwitch(name: string, target: string, isNew: boolean): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) {
    p.log.error("target 不能为空。清空请直接编辑 config.toml。");
    process.exit(1);
  }
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
      `target "${trimmed}" 无法解析。运行 ${pc.cyan("`cclau models`")} 看可用 model。`,
    );
    process.exit(1);
  }
  const fullName = `${resolved.provider.name}/${resolved.modelId}`;

  if (!isNew && config.aliases[name] === fullName) {
    p.log.info(`alias "${name}" 已指向 ${fullName}，无变化`);
    return;
  }

  if (isNew) {
    try {
      assertCanCreateAlias(config, name);
    } catch (err) {
      p.log.error((err as Error).message);
      process.exit(1);
    }
  }

  config.aliases[name] = fullName;
  await saveAppConfig(config);
  p.log.success(
    isNew
      ? `✓ 创建 alias "${name}" ${pc.dim("→")} ${fullName}`
      : `✓ alias "${name}" ${pc.dim("→")} ${fullName}`,
  );
}

// ---------------------------------------------------------------------------
// 纯函数版（test-friendly）：不走 process.exit，错误用 throw 表达
// 对应 `cclau switch <name> <target>` 的非交互路径
// ---------------------------------------------------------------------------

export async function switchAliasOrThrow(
  name: string,
  target: string,
  isNew: boolean,
): Promise<void> {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Empty target.");
  const config = loadAppConfig();
  const resolved = resolveAlias(trimmed, config);
  if (!resolved) throw new Error(`Target "${trimmed}" does not resolve.`);
  const fullName = `${resolved.provider.name}/${resolved.modelId}`;
  if (!isNew && config.aliases[name] === fullName) return; // no-op
  if (isNew) {
    if (!isValidAliasName(name)) throw new Error(`Invalid alias name "${name}".`);
    if (RESERVED_SUBCOMMANDS.has(name)) throw new Error(`Reserved: "${name}".`);
    if (nameTakenAnywhere(config, name)) {
      throw new Error(`Name "${name}" already in use as ${describeNameOwner(config, name)}.`);
    }
  }
  config.aliases[name] = fullName;
  await saveAppConfig(config);
}

// ---------------------------------------------------------------------------

/** 创建新 alias 前的统一校验：命名 + 保留字 + 跨 namespace 冲突 */
function assertCanCreateAlias(config: Config, name: string): void {
  if (!isValidAliasName(name)) {
    throw new Error(
      `alias 名 "${name}" 不合法。必须是 kebab-case，1-63 字符（小写字母/数字/连字符）。`,
    );
  }
  if (RESERVED_SUBCOMMANDS.has(name)) {
    throw new Error(`"${name}" 与保留子命令名冲突。换一个。`);
  }
  if (nameTakenAnywhere(config, name)) {
    const owner = describeNameOwner(config, name);
    throw new Error(`名字 "${name}" 已被 ${owner} 占用`);
  }
}
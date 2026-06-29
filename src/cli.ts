#!/usr/bin/env bun
// cclau - Claude Code launcher
//
// 架构（详见 plan）：Bun + commander + smol-toml + Bun.serve
// 订阅：3 builtin (deepseek / minimax / mimo) + 自添加
// 三种 mode：direct（直连） / rectify（anthropic 整流） / convert（openai 转换）
//
// refactor 之后：新增 `models` 和 `profile` 子命令组；默认 `cclau <name>` 只解析 profile。

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { listCmd } from "./commands/ls.js";
import { rmCmd } from "./commands/rm.js";
import { showCmd } from "./commands/show.js";
import { addCmd } from "./commands/add.js";
import { editCmd } from "./commands/edit.js";
import { doctorCmd } from "./commands/doctor.js";
import { modelsCmd } from "./commands/models.js";
import { profileAddCmd } from "./commands/profile/add.js";
import { profileListCmd } from "./commands/profile/ls.js";
import { profileRmCmd } from "./commands/profile/rm.js";
import { launchCmd } from "./commands/launch.js";
import { registerAlias } from "./commands/alias.js";
import { registerSwitch } from "./commands/switch.js";

const KNOWN_SUBCOMMANDS = new Set([
  "add",
  "edit",
  "rm",
  "remove",
  "ls",
  "list",
  "show",
  "doctor",
  "models",
  "profile",
  "alias",
  "switch",
  "help",
  "version",
]);

const program = new Command();

program
  .name("cclau")
  .description("Claude Code launcher with subscription manager and protocol conversion")
  .version(pkg.version, "-v, --version")
  .showHelpAfterError(true);

program
  .command("add")
  .description("交互式添加 provider")
  .action(async () => {
    await addCmd();
  });

program
  .command("edit <name>")
  .description("编辑 provider 的 model 集合（多选 toggle）")
  .action(async (name: string) => {
    await editCmd(name);
  });

program
  .command("rm <name>")
  .alias("remove")
  .description("删除 provider")
  .action(async (name: string) => {
    await rmCmd(name);
  });

program
  .command("ls")
  .alias("list")
  .description("列出所有 alias 和 model")
  .action(() => {
    listCmd();
  });

program
  .command("show <name>")
  .description("显示 provider 或 profile 详情")
  .action((name: string) => {
    showCmd(name);
  });

program
  .command("doctor <name>")
  .description("测试 provider 连通性")
  .action(async (name: string) => {
    await doctorCmd(name);
  });

program
  .command("models")
  .description("列出所有 provider/model 组合")
  .action(() => {
    modelsCmd();
  });

// v6：alias 子命令（抄自 cctra）
registerAlias(program);
// v6：switch 交互式 wizard（抄自 cctra）
registerSwitch(program);

const profileCmd = program
  .command("profile")
  .description("管理 profile（3 tier model 映射）");

profileCmd
  .command("add")
  .description("交互式添加 profile")
  .action(async () => {
    await profileAddCmd();
  });

profileCmd
  .command("ls")
  .alias("list")
  .description("列出所有 profile")
  .action(() => {
    profileListCmd();
  });

profileCmd
  .command("rm <name>")
  .alias("remove")
  .description("删除 profile")
  .action(async (name: string) => {
    await profileRmCmd(name);
  });

// 主启动命令：cclau <name> [claude args...]
// commander 不支持"未知子命令"路由，我们直接接管。
// 如果 argv[0] 是已知子命令 → 走 commander；否则当作 launch。

async function main() {
  const argv = process.argv.slice(2);
  const firstArg = argv[0];

  if (!firstArg || firstArg.startsWith("-")) {
    // cclau 或 cclau --help 之类 → 走 commander
    program.parse(process.argv);
    return;
  }

  if (KNOWN_SUBCOMMANDS.has(firstArg)) {
    // 已知子命令 → commander
    program.parse(process.argv);
    return;
  }

  // 否则：launch 模式
  // 透传其余所有参数给 claude
  const claudeArgs = argv.slice(1);
  await launchCmd(firstArg, claudeArgs);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

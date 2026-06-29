// cclau <name> [claude args...] - 主启动命令
// cclau (no args)               - launch default profile
//
// 流程：
//   1. fuzzy 解析 profile 名（launch 是破坏性，歧义时拒绝）
//   2. resolveLaunch → { settingsModel, upstreamModel, sidecar }
//   3. apiKey 检查
//   4. 据 sidecar.needed 决策起不起 server
//      - false（direct） → 不起 server，writeSettingsFile(port=undefined) → baseUrl = endpoint
//      - true（rectify / openai）→ findFreePort → buildRegistry(profile) → startServer → writeSettingsFile(port)
//   5. spawn claude → 清理 server + 临时 settings file
//
// 4 个 ANTHROPIC_DEFAULT_*_MODEL env 全 = settingsModel（单 profile，无 tier 区分）。

import * as p from "@clack/prompts";
import {
  getDefaultProfile,
  getProfile,
  listProfileNames,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { findFreePort } from "../port.js";
import { resolveLaunch, writeSettingsFile } from "../settings.js";
import { spawnClaude } from "../process.js";
import { startServer } from "../server/index.js";
import { buildRegistry } from "../server/registry.js";
import { pc } from "../utils/logger.js";

export async function launchCmd(
  query: string,
  claudeArgs: string[],
): Promise<void> {
  // 1. fuzzy 解析 profile
  const all = listProfileNames();
  if (all.length === 0) {
    p.log.error(`暂无 profile。先运行 ${pc.cyan("`cclau add`")} 创建一个。`);
    process.exit(1);
  }

  const top = fuzzyTopN(query, all, 2);
  if (top.length === 0) {
    p.log.error(
      `没有匹配到 profile "${query}"。现有 profile: ${all.join(", ")}`,
    );
    process.exit(1);
  }
  if (isAmbiguous(top)) {
    p.log.error(
      `"${query}" 模糊匹配到多个 profile: ${top.map((s) => s.name).join("、")}。请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = top[0]!.name;
  if (resolved !== query) p.log.message(pc.dim(`匹配到 profile "${resolved}"`));

  const profile = getProfile(resolved);
  if (!profile) {
    p.log.error(`profile "${resolved}" 不存在`);
    process.exit(1);
  }

  // 2. 解析 launch 决策（必填字段校验）
  let launch;
  try {
    launch = resolveLaunch(profile);
  } catch (err) {
    if (err instanceof Error) p.log.error(err.message);
    process.exit(1);
  }

  // 3. 据 sidecar.needed 决策起不起 server
  let server: ReturnType<typeof startServer> | undefined;
  let port: number | undefined;

  if (launch.sidecar.needed) {
    port = await findFreePort(3133);
    const registry = buildRegistry(profile);
    server = startServer(registry, port);
  }

  // 4. 写 settings
  const settings = await writeSettingsFile(profile, port);

  // 5. 日志
  const modeDesc = launch.sidecar.needed
    ? `sidecar (${launch.sidecar.reason}, port: ${port})`
    : `direct (zero-hop)`;
  p.log.info(`启动 claude code (profile: ${profile.name}, ${modeDesc})`);
  console.log(
    pc.dim(
      `endpoint: ${profile.endpoint}, model: ${profile.model}${profile.supports1m ? " [1m]" : ""}`,
    ),
  );

  const { exited } = spawnClaude(settings, claudeArgs);
  const code = await exited;

  // 6. 清理
  if (server) {
    server.stop();
    console.log(`sidecar server stopped (port ${port})`);
  }

  process.exit(code ?? 0);
}

/**
 * `cclau` 无参时调用：取 default profile → 调 launchCmd。
 * 多 default 或 0 default 的报错在这里。
 */
export async function launchDefault(args: string[]): Promise<void> {
  const def = getDefaultProfile();
  if (!def) {
    console.error(pc.dim("(无 default profile)"));
    console.error(
      pc.dim(`运行 ${pc.cyan("`cclau default <name>`")} 设定。`),
    );
    process.exit(1);
  }
  await launchCmd(def.name, args);
}
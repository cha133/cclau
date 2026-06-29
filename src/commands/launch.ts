// cclau <name> [claude args...] - 主启动命令
//
// refactor 之后：name 必须是 profile 名字。provider 名字直接报错。
//
// 1. 解析 name → Profile
// 2. resolveProfile → { tiers, sidecar }
// 3. apiKey 检查遍历 3 tier 的所有 provider
// 4. 据 sidecar.needed 决定：
//    - false（全部 direct 同 provider）→ 不起 server，baseUrl = provider.endpoint（零 hop）
//    - true（不同 provider 或含 rectify/convert）→ 起 sidecar server，baseUrl = localhost:port
// 5. 写 settings（4 个 env var 独立：每个 tier 各自的 model + 1m 后缀）
// 6. spawn claude → 清理 server + 临时文件

import * as p from "@clack/prompts";
import { getProfile, listProfileNames, listProviderNames, loadAppConfig } from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { findFreePort } from "../port.js";
import { ProfileResolutionError, resolveProfile, writeSettingsFile } from "../settings.js";
import { spawnClaude } from "../process.js";
import { startServer } from "../server/index.js";
import { buildRegistry } from "../server/registry.js";
import { pc } from "../utils/logger.js";

export async function launchCmd(query: string, claudeArgs: string[]): Promise<void> {
  // 1. 解析 name → profile
  const allProfileNames = listProfileNames();
  if (allProfileNames.length === 0) {
    p.log.error("暂无 profile。先运行 `cclau profile add` 创建一个。");
    process.exit(1);
  }

  // fuzzy 解析 profile（top-2 给歧义检测）
  const profileTop = fuzzyTopN(query, allProfileNames, 2);
  if (profileTop.length === 0) {
    // 保留 is-provider 分支：检查是不是 provider 名（用户可能还在用旧习惯）
    const providerTop = fuzzyTopN(query, listProviderNames(), 1);
    const provHit = providerTop[0];
    if (provHit) {
      p.log.error(
        `"${query}" 命中 provider "${provHit.name}"，但 ${pc.cyan("`cclau <name>`")} 只接受 profile 名。运行 ${pc.cyan("`cclau profile add`")} 建一个指向它的 profile。`,
      );
    } else {
      p.log.error(
        `没有匹配到 profile "${query}"。现有 profile: ${allProfileNames.join(", ")}`,
      );
    }
    process.exit(1);
  }
  // profile 歧义时拒绝（避免启动错 profile）
  if (isAmbiguous(profileTop)) {
    p.log.error(
      `"${query}" 模糊匹配到多个 profile: ${profileTop.map((s) => s.name).join("、")}。请用更精确名字。`,
    );
    process.exit(1);
  }
  const resolved = profileTop[0]!.name;
  if (resolved !== query) p.log.message(pc.dim(`匹配到 profile "${resolved}"`));

  const profile = getProfile(resolved)!;

  // v6：拿 config 用来查 alias 表（profile model 字段可写 alias 名）
  const config = loadAppConfig();

  // 2. 解析 profile → 3 tier + sidecar 决策
  let resolvedProfile;
  try {
    resolvedProfile = resolveProfile(profile, config);
  } catch (err) {
    if (err instanceof ProfileResolutionError) {
      p.log.error(err.message);
      p.log.message(
        pc.dim(`运行 ${pc.cyan(`\`cclau profile show ${profile.name}\``)} 看引用，运行 ${pc.cyan(`\`cclau profile add\``)} 重建。`),
      );
      process.exit(1);
    }
    throw err;
  }
  const { tiers, sidecar } = resolvedProfile;

  // 3. 所有引用到的 provider 都要有 apiKey
  for (const t of tiers) {
    if (!t.provider.apiKey) {
      p.log.error(`provider "${t.provider.name}" 尚未设置 apiKey，运行 ${pc.cyan(`\`cclau show ${t.provider.name}\``)} 查看`);
      process.exit(1);
    }
  }

  // 4. 据 sidecar.needed 决定起不起 server
  let server: ReturnType<typeof startServer> | undefined;
  let port: number | undefined;

  if (sidecar.needed) {
    port = await findFreePort(3133);
    const registry = buildRegistry(
      tiers.map((t) => ({
        tier: t.tier,
        // t.model 已带 `${provider.name}/` 前缀 + [1m]（resolveProfile 加的），
        // buildRegistry 内部 strip1m 后作为 key，正好匹配 claude code 发出的 body.model
        model: t.model,
        // 上游看到的 model（剥前缀 + 剥 [1m]），handleMessages 用它覆盖 body.model 再转给上游
        upstreamModel: t.upstreamModel,
        provider: t.provider,
      })),
    );
    server = startServer(registry, port, config);
  }

  // 5. 写 settings
  const settings = await writeSettingsFile(profile, config, port);

  // 6. 日志
  const opusTier = tiers[0];
  const sonnetTier = tiers[1];
  const haikuTier = tiers[2];
  const modeDesc = sidecar.needed
    ? `sidecar (${sidecar.reason}, port: ${port})`
    : `direct (provider: ${opusTier.provider.name}, mode: ${opusTier.provider.mode})`;
  p.log.info(`启动 claude code (profile: ${profile.name}, ${modeDesc})`);
  console.log(
    pc.dim(
      `opus=${opusTier.model} (${opusTier.provider.name}) sonnet=${sonnetTier.model} (${sonnetTier.provider.name}) haiku=${haikuTier.model} (${haikuTier.provider.name})`,
    ),
  );

  const { exited } = spawnClaude(settings, claudeArgs);
  const code = await exited;

  // 7. 清理
  if (server) {
    server.stop();
    console.log(`sidecar server stopped (port ${port})`);
  }

  process.exit(code ?? 0);
}
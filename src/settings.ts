// 生成注入给 claude code 的 settings JSON
// 通过 `claude --settings <file>` 临时传入，不修改 ~/.claude/settings.json
//
// refactor 之后：单 profile 概念，4 个 ANTHROPIC_DEFAULT_*_MODEL env 全写同一个 model（apply1m 后）。
// sidecar 决策据 profile.mode：
//   direct  → 零 hop（ANTHROPIC_BASE_URL = profile.endpoint）
//   rectify → sidecar + 整流钩子（profile.rectifier 挂载）
//   openai  → sidecar + openai ↔ anthropic 转换

import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { INVOCATION_DIR } from "./utils/paths.js";
import { apply1m } from "./core/model-1m.js";
import type { Profile } from "./types.js";

export interface SettingsFile {
  path: string;
  cleanup: () => Promise<void>;
}

export interface LaunchResolution {
  /** claude-code 写到 4 个 ANTHROPIC_DEFAULT_*_MODEL env 的 model id（已 apply1m） */
  settingsModel: string;
  /** 透传给上游的 model id（base name，无 [1m]，无前缀） */
  upstreamModel: string;
  sidecar: {
    needed: boolean;
    /** 给人看的决策原因，比如 "mode: rectify" */
    reason?: string;
  };
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

/**
 * 解析 profile → launch 决策。
 * 任何必要字段缺失都抛错。
 */
export function resolveLaunch(profile: Profile): LaunchResolution {
  if (!profile.endpoint) {
    throw new ProfileResolutionError(`profile "${profile.name}" 缺少 endpoint`);
  }
  if (!profile.apiKey) {
    throw new ProfileResolutionError(`profile "${profile.name}" 缺少 apiKey`);
  }
  if (!profile.model) {
    throw new ProfileResolutionError(`profile "${profile.name}" 缺少 model`);
  }

  const sidecar = computeSidecarNeed(profile);
  return {
    settingsModel: apply1m(profile.model, profile.supports1m),
    upstreamModel: profile.model,
    sidecar,
  };
}

function computeSidecarNeed(profile: Profile): {
  needed: boolean;
  reason?: string;
} {
  switch (profile.mode) {
    case "direct":
      return { needed: false };
    case "rectify":
      return { needed: true, reason: "mode: rectify" };
    case "openai":
      return { needed: true, reason: "mode: openai" };
  }
}

/**
 * 写 settings JSON 到临时文件并返回 cleanup handle。
 *
 * @param profile 当前激活的 profile
 * @param port 直连模式传 undefined（baseUrl = profile.endpoint 真零 hop）；
 *            sidecar 模式传本地 server 端口（baseUrl = http://127.0.0.1:port）
 */
export async function writeSettingsFile(
  profile: Profile,
  port?: number,
): Promise<SettingsFile> {
  const { settingsModel } = resolveLaunch(profile);

  const baseUrl =
    port !== undefined
      ? `http://127.0.0.1:${port}`
      : profile.endpoint;

  // [1m] 是 claude-code 的内部 hint（见 src/core/model-1m.ts 顶部注释）。
  // resolveLaunch 已经调过 apply1m，所以这里 4 个 var 都是「base[1m]」或「base」。
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: profile.apiKey,
      ANTHROPIC_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: settingsModel,
    },
  };

  const filename = `invocation-${randomUUID()}.json`;
  const filepath = join(INVOCATION_DIR, filename);

  await mkdir(INVOCATION_DIR, { recursive: true });
  await writeFile(filepath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return {
    path: filepath,
    cleanup: async () => {
      try {
        await unlink(filepath);
      } catch {
        // 文件已被删，忽略
      }
    },
  };
}
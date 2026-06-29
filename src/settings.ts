// 生成注入给 claude code 的 settings JSON
// 通过 `claude --settings <file>` 临时传入，不修改 ~/.claude/settings.json
//
// v2：resolveProfile 返回 3 个独立 tier + sidecar.needed 决策
// —— 3 tier 可以挂不同 provider/mode，sidecar.needed 决定起不起 sidecar。
// 零 hop 直连（全部 direct + 同 provider）路径在 writeSettingsFile 内分支处理。
// v6：profile model 字段支持 alias —— resolveTier 先查 alias 表命中即用 alias 解析的
// (provider, model)；miss 才走 literal (ref.provider, ref.model)。

import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { INVOCATION_DIR } from "./utils/paths.js";
import { apply1m, findModelInfo } from "./core/model-1m.js";
import { resolveAlias, AliasResolveError } from "./core/alias.js";
import type { Config, Profile, Subscription } from "./types.js";

export interface SettingsFile {
  path: string;
  cleanup: () => Promise<void>;
}

export type TierName = "opus" | "sonnet" | "haiku";

export interface ResolvedTier {
  tier: TierName;
  /**
   * 给 claude-code 看的 model id（已 apply1m），写到 ANTHROPIC_DEFAULT_*_MODEL。
   * sidecar 模式下会被前缀 `${provider.name}/`，避免跨 provider 撞 sidecar registry key；
   * 零 hop 模式保持裸 model id（上游不接受带前缀的 id）。
   */
  model: string;
  /** 上游 model id（base name，无前缀、无 [1m]），给 sidecar 转给上游时用 */
  upstreamModel: string;
  provider: Subscription;
}

export interface ProfileResolution {
  tiers: [ResolvedTier, ResolvedTier, ResolvedTier];
  sidecar: {
    needed: boolean;
    /** 给人看的决策原因，比如 "3 个 provider" / "含 convert mode" */
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
 * 解析 profile 的某个 tier 引用 → 完整 (model, supports_1m, provider) 对。
 *
 * v6：alias 优先 —— ref.model 是 alias 名时调 resolveAlias 用 alias 解析的 (provider, model)
 * 完全替换；miss 才走 literal (ref.provider, ref.model)。
 * 任何 tier 引用了空串 / 不存在的 provider / 不存在的 model 都 throw。
 */
function resolveTier(
  profile: Profile,
  tier: TierName,
  config: Config,
): { model: string; supports_1m: boolean; provider: Subscription } {
  const ref = profile[tier];

  // 1. alias 解析优先
  if (config.aliases[ref.model] !== undefined) {
    let resolved;
    try {
      resolved = resolveAlias(ref.model, config);
    } catch (e) {
      if (e instanceof AliasResolveError) throw new ProfileResolutionError(e.message);
      throw e;
    }
    if (!resolved) {
      throw new ProfileResolutionError(
        `profile "${profile.name}" ${tier} → alias "${ref.model}" does not resolve to a model`,
      );
    }
    const info = findModelInfo(resolved.provider.models, resolved.modelId);
    if (!info) {
      throw new ProfileResolutionError(
        `profile "${profile.name}" ${tier} → alias "${ref.model}" → "${resolved.provider.name}/${resolved.modelId}" model not found`,
      );
    }
    return { model: info.id, supports_1m: info.supports_1m, provider: resolved.provider };
  }

  // 2. literal (provider, model) —— 走原来的逻辑
  const provider = getSubscriptionFromConfig(config, ref.provider);
  if (!provider) {
    throw new ProfileResolutionError(
      `profile "${profile.name}" ${tier} → provider "${ref.provider}" not found`,
    );
  }
  const info = findModelInfo(provider.models, ref.model);
  if (!info) {
    throw new ProfileResolutionError(
      `profile "${profile.name}" ${tier} → model "${ref.model}" not found in provider "${ref.provider}"`,
    );
  }
  return { model: info.id, supports_1m: info.supports_1m, provider };
}

/**
 * 从 Config 直接拿 subscription（不走 loadAppConfig，避免循环 IO + 让 settings 单元测试可注入）
 * StoredSubscription → Subscription 归一化跟 config.ts 一致。
 */
function getSubscriptionFromConfig(config: Config, name: string): Subscription | undefined {
  const stored = config.providers[name];
  if (!stored) return undefined;
  return {
    name,
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    type: stored.type,
    mode: stored.mode,
    models: Array.isArray(stored.models) ? stored.models : [],
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    rectifier: stored.rectifier,
  };
}

/**
 * 计算 sidecar 是否需要起 + 决策原因。
 * 3 tier 引用不同 provider → 起；任一 tier mode 非 direct → 起；否则零 hop。
 */
function computeSidecarNeed(tiers: ResolvedTier[]): { needed: boolean; reason?: string } {
  const providers = new Set(tiers.map((t) => t.provider.name));
  const modes = new Set(tiers.map((t) => t.provider.mode));
  if (providers.size > 1) {
    return { needed: true, reason: `${providers.size} 个 provider` };
  }
  if (modes.has("convert")) {
    return { needed: true, reason: "含 convert mode" };
  }
  if (modes.has("rectify")) {
    return { needed: true, reason: "含 rectify mode" };
  }
  return { needed: false };
}

/**
 * 解析 profile → 3 个独立 tier + sidecar 决策。
 * 任何 tier 引用了空串 / 不存在的 provider / 不存在的 model 都抛错。
 *
 * v6：需要 config 用来查 alias 表；profile model 字段写 alias 名时调 resolveAlias。
 */
export function resolveProfile(profile: Profile, config: Config): ProfileResolution {
  const raw = (["opus", "sonnet", "haiku"] as TierName[]).map((tier) => {
    const r = resolveTier(profile, tier, config);
    const resolved: ResolvedTier = {
      tier,
      model: apply1m(r.model, r.supports_1m),
      upstreamModel: r.model,
      provider: r.provider,
    };
    return resolved;
  });

  const tiers = raw as [ResolvedTier, ResolvedTier, ResolvedTier];
  const sidecar = computeSidecarNeed(tiers);

  // sidecar 模式下，给 model id 加 `${provider.name}/` 前缀，让 sidecar registry key
  // 天然消歧（不同 provider 同 model 不再撞 key）。claude code 内部
  // normalizeModelStringForAPI 只会剥 `[1m]` 后缀，`/` 当普通字符透传。
  // 零 hop 模式（claude code 直连上游）必须保持裸 model id —— provider API 不认
  // `provider/model` 这种带前缀的 id。
  if (sidecar.needed) {
    for (const t of tiers) {
      t.model = `${t.provider.name}/${t.model}`;
    }
  }

  return { tiers, sidecar };
}

/**
 * 生成 settings JSON 并写到临时文件
 * @param profile 当前激活的 profile
 * @param port 直连模式传 undefined（用 provider.endpoint 真零 hop）；
 *            sidecar 模式传本地 server 端口（baseUrl = http://127.0.0.1:port）
 */
export async function writeSettingsFile(profile: Profile, config: Config, port?: number): Promise<SettingsFile> {
  const { tiers } = resolveProfile(profile, config);

  // 直连前提：调用方（launch.ts）只在 sidecar.needed === false 时才传 undefined，
  // 此时 3 tier 必同 provider，endpoint 也一致。
  const baseUrl =
    port !== undefined ? `http://127.0.0.1:${port}` : tiers[0].provider.endpoint;

  const opusModel = tiers[0].model;
  const sonnetModel = tiers[1].model;
  const haikuModel = tiers[2].model;

  // [1m] 是 claude-code 的内部 hint（见 src/core/model-1m.ts 顶部注释）。
  // resolveProfile 已经调过 apply1m，所以这里 4 个 var 直接是「base[1m]」或「base」。
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: tiers[0].provider.apiKey ?? "",
      // ANTHROPIC_MODEL 跟随 opus，与 ccswi 的 buildSettingsFromProfile 一致
      ANTHROPIC_MODEL: opusModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: sonnetModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
    },
  };

  const filename = `invocation-${randomUUID()}.json`;
  const filepath = join(INVOCATION_DIR, filename);

  const { mkdir } = await import("node:fs/promises");
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
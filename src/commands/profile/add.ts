// cclau profile add - 交互式添加 profile
//
// 流程：
//   1. name（小写、kebab-case、不重名）
//   2. opus provider → opus model（autocomplete 风格带自定义 escape）
//   3. sonnet provider + model（默认沿用 opus，可改）
//   4. haiku provider + model（默认沿用 sonnet，可改）
//   5. 写盘
//
// 1m 不在这里问 —— profile 引用 (provider, model) 时直接用 model 的 supports_1m。
// 3 tier 允许引用同一 model id —— resolveProfile + buildRegistry 通过
// `${provider.name}/` 前缀消歧（零 hop 模式 claude code 直连上游不查 id 唯一）。

import * as p from "@clack/prompts";
import {
  getProfile,
  listProfiles,
  listSubscriptions,
  upsertProfile,
} from "../../config.js";
import type { ModelRef, Profile, Subscription } from "../../types.js";
import { pc } from "../../utils/logger.js";
import { validateKebabName } from "../../utils/names.js";

const CUSTOM = "__custom__";

/** 选 provider —— p.select，列出所有 provider name */
async function promptProvider(
  message: string,
  defaultName?: string,
): Promise<Subscription> {
  const subs = listSubscriptions();
  if (subs.length === 0) {
    p.log.error("还没有任何 provider。先运行 `cclau add` 添加一个。");
    process.exit(1);
  }
  const initial = defaultName ? subs.find((s) => s.name === defaultName) : subs[0];
  const res = await p.select({
    message,
    options: subs.map((s) => ({ value: s.name, label: s.name, hint: s.endpoint })),
    initialValue: initial?.name,
  });
  if (p.isCancel(res)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const sub = subs.find((s) => s.name === res);
  if (!sub) {
    p.log.error(`provider "${res}" 不存在`);
    process.exit(1);
  }
  return sub;
}

/**
 * 选 model —— p.select + 自定义 escape hatch。
 * 如果 provider.models 为空，直接进 p.text 自由输入。
 * 优先把 priorModel（上一档选过的）放在最前面以便 pre-select。
 */
async function promptModel(
  message: string,
  provider: Subscription,
  priorModel?: string,
): Promise<string> {
  if (provider.models.length === 0) {
    const r = await p.text({
      message,
      placeholder: "model-id",
      validate: (v) => (v && v.trim() ? undefined : "不能为空"),
    });
    if (p.isCancel(r)) {
      p.cancel("已取消");
      process.exit(0);
    }
    return r.trim();
  }

  // 如果 priorModel 不在 provider.models 列表里，前置一项以便选择
  const opts: { value: string; label: string; hint?: string }[] = [];
  if (priorModel && !provider.models.some((m) => m.id === priorModel)) {
    opts.push({ value: priorModel, label: priorModel, hint: pc.dim("沿用上一档") });
  }
  for (const m of provider.models) {
    opts.push({ value: m.id, label: m.id, hint: m.supports_1m ? pc.dim("1m") : undefined });
  }
  opts.push({ value: CUSTOM, label: "✏️  手动输入..." });

  const initial = priorModel ?? provider.models[0]!.id;
  const res = await p.select({
    message,
    options: opts,
    initialValue: opts.some((o) => o.value === initial) ? initial : undefined,
  });
  if (p.isCancel(res)) {
    p.cancel("已取消");
    process.exit(0);
  }
  if (res === CUSTOM) {
    const custom = await p.text({
      message,
      placeholder: "model-id",
      validate: (v) => (v && v.trim() ? undefined : "不能为空"),
    });
    if (p.isCancel(custom)) {
      p.cancel("已取消");
      process.exit(0);
    }
    return custom.trim();
  }
  return res as string;
}

export async function profileAddCmd(): Promise<void> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau profile add ")));

  // 1. name
  const existingNames = listProfiles().map((p) => p.name);
  const name = await p.text({
    message: "Profile name（小写、kebab-case）：",
    placeholder: "default",
    validate: (v) => validateKebabName(v, existingNames),
  });
  if (p.isCancel(name)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const profileName = name.trim().toLowerCase();

  // 2. opus
  const opusProvider = await promptProvider("Opus provider：");
  const opusModel = await promptModel("Opus model：", opusProvider);

  // 3. sonnet（默认沿用 opus 选择）
  const sonnetProvider = await promptProvider("Sonnet provider：", opusProvider.name);
  const sonnetModel = await promptModel(
    "Sonnet model：",
    sonnetProvider,
    sonnetProvider.name === opusProvider.name ? opusModel : undefined,
  );

  // 4. haiku（默认沿用 sonnet 选择）
  const haikuProvider = await promptProvider("Haiku provider：", sonnetProvider.name);
  const haikuModel = await promptModel(
    "Haiku model：",
    haikuProvider,
    haikuProvider.name === sonnetProvider.name ? sonnetModel : undefined,
  );

  // 5. 写盘
  const now = Date.now();
  const opus: ModelRef = { provider: opusProvider.name, model: opusModel };
  const sonnet: ModelRef = { provider: sonnetProvider.name, model: sonnetModel };
  const haiku: ModelRef = { provider: haikuProvider.name, model: haikuModel };
  const profile: Profile = {
    name: profileName,
    opus,
    sonnet,
    haiku,
    createdAt: getProfile(profileName)?.createdAt ?? now,
    updatedAt: now,
  };
  await upsertProfile(profile);

  p.outro(pc.green(`✓ 已添加 profile "${profileName}"`));
  p.log.message(
    pc.dim(`运行 ${pc.cyan(`\`cclau ${profileName}\``)} 启动 claude code`),
  );
}

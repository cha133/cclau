// cclau add - 交互式添加 provider
//
// 流程（refactor 之后）：
//   1. 选 vendor（builtin preset 或 custom）
//   2. 选 mode（direct / rectify / convert）
//   3. 决定 name（kebab-case 自动生成，冲突时按 mode 加后缀；suffix 也不够则让用户手输）
//   4. 决定 endpoint（builtin 预填，custom 手输）
//   5. 填 apiKey
//   6. 拉上游 model 列表 → multi-select
//   7. 对每个选中的 model 问 1m
//   8. 写盘
//
// 不再有 overwrite 流程：重名在 step 3 已经被强制改名。

import * as p from "@clack/prompts";
import { upsertSubscription, listSubscriptions, indexProviderModes, getSubscription, loadAppConfig, saveAppConfig } from "../config.js";
import { BUILTIN_PRESETS, CUSTOM_PRESET } from "../builtins.js";
import { BUILTIN_PRESETS as PRESET_RULES } from "../preset-rules.js";
import type { AnthropicRectifier, ModelInfo, Rectifier, Subscription, SubscriptionMode } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { pc } from "../utils/logger.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import { kebabCase, suggestNameOnConflict, validateKebabName } from "../utils/names.js";
import { registerAutoAliases } from "../core/auto-alias.js";

/** 数 Rectifier 里非空字段（modelAlias/requestHeaders/requestTransform/responseTransform/streamChunkTransform） */
function countRectifierRules(r: AnthropicRectifier | undefined): number {
  if (!r) return 0;
  let n = 0;
  if (r.modelAlias) n++;
  if (r.requestHeaders) n++;
  if (r.requestTransform) n++;
  if (r.responseTransform) n++;
  if (r.streamChunkTransform) n++;
  return n;
}

export async function addCmd(): Promise<void> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau add ")));

  // 1. 选 vendor
  const presetChoice = await p.select({
    message: "选择 provider：",
    options: [
      ...BUILTIN_PRESETS.map((x) => ({ value: x.name, label: x.label, hint: x.endpoint })),
      { value: CUSTOM_PRESET.name, label: CUSTOM_PRESET.label, hint: CUSTOM_PRESET.hint },
    ],
  });
  if (p.isCancel(presetChoice)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const isCustom = presetChoice === CUSTOM_PRESET.name;
  const preset = BUILTIN_PRESETS.find((x) => x.name === presetChoice);

  // 2. 选 mode
  const modeChoice = await p.select({
    message: "启动方式：",
    options: [
      {
        value: "direct" as const,
        label: "direct  (anthropic 直连，最快，无 sidecar)",
      },
      {
        value: "rectify" as const,
        label: "rectify (anthropic 整流，走本地 server + 整流钩子)",
      },
      {
        value: "convert" as const,
        label: "convert (openai 转换，强制 endpoint 为 OpenAI Chat)",
      },
    ],
  });
  if (p.isCancel(modeChoice)) {
    p.cancel("已取消");
    process.exit(0);
  }

  // 2.5. 整流规则：builtin preset 配 rectify 模式时，询问是否启用
  // （custom preset 或 non-rectify 模式不弹；rectify 模式 + builtin preset → 弹）
  let rectifier: Rectifier | undefined;
  if (
    !isCustom &&
    modeChoice === "rectify" &&
    PRESET_RULES[preset!.name]
  ) {
    const ruleCount = countRectifierRules(PRESET_RULES[preset!.name]!);
    const enableRect = await p.confirm({
      message: `启用 [${preset!.name}] 内置整流规则？（${ruleCount} 条；不启用可稍后手编 TOML 加）`,
      initialValue: true,
    });
    if (p.isCancel(enableRect)) {
      p.cancel("已取消");
      process.exit(0);
    }
    if (enableRect) {
      // 包装：AnthropicRectifier → Rectifier（{ anthropic: ... }）
      rectifier = { anthropic: PRESET_RULES[preset!.name]! };
    }
  }

  // 3. 决定 name（带冲突感知）
  const existingNames = listSubscriptions().map((s) => s.name);
  const existingModes = indexProviderModes();

  // 期望的 base name：builtin 走 preset.name，custom 走用户后面输入的 endpoint host
  // —— custom 的 base name 在 endpoint 已知后才能算，所以分两步
  let desiredBase: string;
  if (isCustom) {
    // custom：name 由用户先定，endpoint 再定
    const customName = await p.text({
      message: "Provider name（小写、kebab-case）：",
      placeholder: "my-vendor",
      validate: (v) => validateKebabName(v, existingNames),
    });
    if (p.isCancel(customName)) {
      p.cancel("已取消");
      process.exit(0);
    }
    desiredBase = customName.trim().toLowerCase();
  } else {
    desiredBase = kebabCase(preset!.label || preset!.name);
    const suggested = suggestNameOnConflict(desiredBase, existingNames, existingModes, modeChoice);
    const nameRes = await p.text({
      message: "Provider name（小写、kebab-case）：",
      initialValue: suggested,
      placeholder: suggested ? undefined : "e.g. my-vendor",
      validate: (v) => {
        const trimmed = v?.trim().toLowerCase() ?? "";
        if (!trimmed) {
          return suggested
            ? `默认名 "${desiredBase}" 和 "${desiredBase}-${modeChoice}" 都已被占，请手输新名字`
            : "Name is required.";
        }
        return validateKebabName(trimmed, existingNames);
      },
    });
    if (p.isCancel(nameRes)) {
      p.cancel("已取消");
      process.exit(0);
    }
    desiredBase = nameRes.trim().toLowerCase();
  }
  const name = desiredBase;

  // 4. 决定 endpoint + type
  let endpoint: string;
  let type: "anthropic" | "openai";

  if (isCustom) {
    type = modeChoice === "convert" ? "openai" : "anthropic";
    const endpointRes = await p.text({
      message: `${type === "anthropic" ? "Anthropic" : "OpenAI"} endpoint base URL（cclau 会按 type 自动拼 /v1/... 路径）：`,
      placeholder: "https://api.example.com",
      validate: (v) => (v ? undefined : "不能为空"),
    });
    if (p.isCancel(endpointRes)) {
      p.cancel("已取消");
      process.exit(0);
    }
    endpoint = endpointRes;
    p.log.message(`实际请求 URL: ${pc.cyan(buildUpstreamUrl(endpoint, type))}`);
  } else {
    endpoint = preset!.endpoint;
    type = modeChoice === "convert" ? "openai" : preset!.type;
  }

  // 5. apiKey
  const apiKeyRes = await p.password({
    message: "API Key：",
    validate: (v) => (v ? undefined : "不能为空"),
  });
  if (p.isCancel(apiKeyRes)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const apiKey = apiKeyRes;

  // 6. 拉上游 model 列表（沿用旧 cache + OpenRouter fallback）
  const s = p.spinner();
  s.start("Fetching model list from upstream...");
  let modelNames: string[] = [];
  try {
    modelNames = await fetchUpstreamModels({
      endpoint: endpoint.trim(),
      token: apiKey.trim(),
    });
    s.stop(`Found ${modelNames.length} model(s).`);
  } catch {
    s.stop("Failed to fetch models, will add manually.");
  }

  // 7. multi-select
  const upstreamSorted = [...new Set(modelNames)].sort((a, b) => a.localeCompare(b));
  let selected: string[] = [];

  if (upstreamSorted.length > 0) {
    const res = await p.multiselect({
      message: "选择要添加的 model（空格切换，Enter 确认；空选回车会进手动输入）：",
      options: upstreamSorted.map((m) => ({ value: m, label: m })),
      required: false,
    });
    if (p.isCancel(res)) {
      p.cancel("已取消");
      process.exit(0);
    }
    selected = res as string[];
  }

  if (selected.length === 0) {
    // 手动输入 fallback
    const manual = await p.text({
      message: "输入 model IDs（逗号分隔）：",
      placeholder: "e.g. deepseek-chat, deepseek-reasoner",
      validate: (v) => (v && v.trim() ? undefined : "不能为空"),
    });
    if (p.isCancel(manual)) {
      p.cancel("已取消");
      process.exit(0);
    }
    selected = manual
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 8. 对每个 model 问 1m
  // v3+: 默认 Yes —— 现在越来越多 model 支持 1M context，No 反而是少数情况
  const modelInfos: ModelInfo[] = [];
  for (const id of selected) {
    const r = await p.confirm({
      message: `Model "${id}" 是否支持 1M context？`,
      initialValue: true,
    });
    if (p.isCancel(r)) {
      p.cancel("已取消");
      process.exit(0);
    }
    modelInfos.push({ id, supports_1m: r });
  }

  // 9. 写盘
  const now = Date.now();
  const sub: Subscription = {
    name,
    endpoint,
    apiKey,
    type,
    mode: modeChoice as SubscriptionMode,
    models: modelInfos,
    createdAt: getSubscription(name)?.createdAt ?? now,
    updatedAt: now,
    ...(rectifier ? { rectifier } : {}),
  };

  await upsertSubscription(sub);

  // v6：auto-register alias —— model id 全局唯一 + 不撞名 → 静默注册
  const config = loadAppConfig();
  const addedAliases: string[] = [];
  for (const m of sub.models) {
    const before = config.aliases[m.id];
    registerAutoAliases(config, sub.name, [m.id]);
    if (config.aliases[m.id] && config.aliases[m.id] !== before) {
      addedAliases.push(m.id);
    }
  }
  if (addedAliases.length > 0) {
    await saveAppConfig(config);
  }

  const rectifierHint = rectifier
    ? `, ${countRectifierRules(rectifier.anthropic)} rectifier rule(s)`
    : "";
  p.outro(
    pc.green(
      `✓ 已添加 provider "${name}"（${sub.mode}${sub.type !== "anthropic" ? " · " + sub.type : ""}, ${sub.models.length} model${sub.models.length === 1 ? "" : "s"}${rectifierHint}）`,
    ),
  );
  p.log.message(
    pc.dim(`下一步：运行 ${pc.cyan(`\`cclau profile add\``)} 创建一个 profile，再用 ${pc.cyan(`\`cclau ${name}\``)} 启动 claude code`),
  );
}

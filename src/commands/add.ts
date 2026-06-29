// cclau add - 交互式添加 profile
//
// 流程（refactor 之后，单 profile 压平）：
//   1. 选 vendor（builtin preset 或 custom）
//   2. builtin → endpoint + mode 自动填；custom → 输 endpoint + 选 mode
//   3. 填 apiKey
//   4. 拉上游 model 列表 → single select（拉失败可手输）
//   5. 问 1m context（默认 Yes）
//   6. 决定 name（preset 名 kebab-case 自动填，冲突按 mode 加 suffix 仍冲突则让用户手输）
//   7. 写盘 Profile
//
// 备注：不自动设 default —— 用户用 `cclau default <name>` 显式设。

import * as p from "@clack/prompts";
import { BUILTIN_PRESETS, CUSTOM_PRESET, findPreset } from "../builtins.js";
import { BUILTIN_PRESETS as PRESET_RULES } from "../preset-rules.js";
import { listProfiles, listProfileNames, upsertProfile } from "../config.js";
import type { Mode, Profile } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { pc } from "../utils/logger.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import {
  kebabCase,
  suggestNameOnConflict,
  validateKebabName,
} from "../utils/names.js";

/** 数 Rectifier 里非空字段 */
function countRectifierRules(r: unknown | undefined): number {
  if (!r || typeof r !== "object") return 0;
  const r2 = r as Record<string, unknown>;
  let n = 0;
  for (const k of [
    "modelAlias",
    "requestHeaders",
    "requestTransform",
    "responseTransform",
    "streamChunkTransform",
  ]) {
    if (r2[k] !== undefined) n++;
  }
  return n;
}

export async function addCmd(): Promise<void> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau add ")));

  // 1. 选 vendor
  const presetChoice = await p.select({
    message: "选择 vendor：",
    options: [
      ...BUILTIN_PRESETS.map((x) => ({
        value: x.name,
        label: x.label,
        hint: x.endpoint,
      })),
      {
        value: CUSTOM_PRESET.name,
        label: CUSTOM_PRESET.label,
        hint: CUSTOM_PRESET.hint,
      },
    ],
  });
  if (p.isCancel(presetChoice)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const isCustom = presetChoice === CUSTOM_PRESET.name;
  const preset = isCustom ? undefined : findPreset(presetChoice);
  if (!isCustom && !preset) {
    p.log.error(`未知的 vendor "${presetChoice}"`);
    process.exit(1);
  }

  // 2. 决定 endpoint + mode
  let endpoint: string;
  let mode: Mode;

  if (isCustom) {
    // custom：先选 mode，再输 endpoint
    const modeChoice = await p.select<Mode>({
      message: "启动方式：",
      options: [
        {
          value: "direct" as const,
          label: "direct",
          hint: "anthropic 直连，最快，无 sidecar",
        },
        {
          value: "rectify" as const,
          label: "rectify",
          hint: "anthropic 整流，走本地 server + 整流钩子",
        },
        {
          value: "openai" as const,
          label: "openai",
          hint: "openai chat → anthropic 转换，走本地 server",
        },
      ],
    });
    if (p.isCancel(modeChoice)) {
      p.cancel("已取消");
      process.exit(0);
    }
    mode = modeChoice;

    const isOpenAI = mode === "openai";
    const endpointRes = await p.text({
      message: `${isOpenAI ? "OpenAI" : "Anthropic"} endpoint base URL（cclau 会按 mode 自动拼 /v1/... 路径）：`,
      placeholder: "https://api.example.com",
      validate: (v) => (v ? undefined : "不能为空"),
    });
    if (p.isCancel(endpointRes)) {
      p.cancel("已取消");
      process.exit(0);
    }
    endpoint = endpointRes;
    const protocol = mode === "openai" ? "openai" : "anthropic";
    p.log.message(`实际请求 URL: ${pc.cyan(buildUpstreamUrl(endpoint, protocol))}`);
  } else {
    // builtin：endpoint + mode 自动填
    endpoint = preset!.endpoint;
    mode = preset!.defaultMode;
  }

  // 2.5. 整流规则：builtin preset 配 rectify 模式时，询问是否启用预设
  let enableRectifier = false;
  if (!isCustom && mode === "rectify" && PRESET_RULES[preset!.name]) {
    const ruleCount = countRectifierRules(PRESET_RULES[preset!.name]);
    const enableRect = await p.confirm({
      message: `启用 [${preset!.name}] 内置整流规则？（${ruleCount} 条；不启用可稍后手编 TOML 加）`,
      initialValue: true,
    });
    if (p.isCancel(enableRect)) {
      p.cancel("已取消");
      process.exit(0);
    }
    enableRectifier = enableRect;
  }

  // 3. apiKey
  const apiKeyRes = await p.password({
    message: "API Key：",
    validate: (v) => (v ? undefined : "不能为空"),
  });
  if (p.isCancel(apiKeyRes)) {
    p.cancel("已取消");
    process.exit(0);
  }
  const apiKey = apiKeyRes;

  // 4. 拉上游 model 列表
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
    s.stop("Failed to fetch models, will enter manually.");
  }

  // 5. 单选 model
  const upstreamSorted = [...new Set(modelNames)].sort((a, b) =>
    a.localeCompare(b),
  );
  let model: string | undefined;

  if (upstreamSorted.length > 0) {
    const res = await p.select({
      message: "选择 model：",
      options: upstreamSorted.map((m) => ({ value: m, label: m })),
    });
    if (p.isCancel(res)) {
      p.cancel("已取消");
      process.exit(0);
    }
    model = res as string;
  } else {
    const manual = await p.text({
      message: "输入 model ID：",
      placeholder: "e.g. deepseek-chat",
      validate: (v) => (v && v.trim() ? undefined : "不能为空"),
    });
    if (p.isCancel(manual)) {
      p.cancel("已取消");
      process.exit(0);
    }
    model = manual.trim();
  }

  // 6. 问 1m
  const supports1m = await p.confirm({
    message: `Model "${model}" 是否支持 1M context？`,
    initialValue: true,
  });
  if (p.isCancel(supports1m)) {
    p.cancel("已取消");
    process.exit(0);
  }

  // 7. 决定 name
  const existingNames = listProfileNames();
  const existingModes: Record<string, Mode> = Object.fromEntries(
    listProfiles().map((p) => [p.name, p.mode]),
  );

  let desiredBase: string;
  if (isCustom) {
    const customName = await p.text({
      message: "Profile name（小写、kebab-case）：",
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
    const suggested = suggestNameOnConflict(
      desiredBase,
      existingNames,
      existingModes,
      mode,
    );
    const nameRes = await p.text({
      message: "Profile name（小写、kebab-case）：",
      initialValue: suggested,
      placeholder: suggested ? undefined : "e.g. my-vendor",
      validate: (v) => {
        const trimmed = v?.trim().toLowerCase() ?? "";
        if (!trimmed) {
          return suggested
            ? `默认名 "${desiredBase}" 和 "${desiredBase}-${mode}" 都已被占，请手输新名字`
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

  // 8. 写盘
  const now = Date.now();
  const profile: Profile = {
    name,
    endpoint,
    apiKey,
    mode,
    model,
    supports1m,
    createdAt: now,
    updatedAt: now,
  };

  await upsertProfile(profile);

  // 注：rectifier 字段在 Profile 上暂不写入 —— builtin 整流预设待 Phase 4 决定
  // 是否纳入 Profile schema。当前 add wizard 只问 enable/disable，不落盘。
  void enableRectifier;

  const rectHint = enableRectifier ? " (rectifier 启用预设中)" : "";
  p.outro(
    pc.green(
      `✓ 已添加 profile "${name}"（${mode}, model: ${model}${rectHint}）`,
    ),
  );
  p.log.message(
    pc.dim(
      `下一步：运行 ${pc.cyan(`\`cclau default ${name}\``)} 设为默认，${pc.cyan(`\`cclau ${name}\``)} 启动 claude code`,
    ),
  );
}
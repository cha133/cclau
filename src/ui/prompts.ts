// ============================================================================
// cclau 交互式向导
//
// 这是项目里**唯一** import @clack/prompts 的文件。所有需要用户逐项回答
// 的流程都集中在这里。命令文件（commands/*.ts）只是入口：跑一次 wizard，
// 拿到结果，再决定怎么持久化。
//
// 分工：
//   checkCancel<T>(value)      —— 统一处理 p.isCancel 后的退出
//   promptAdd()                —— 创建新 profile，返回 Profile（不写盘）
//   promptEdit(existing)       —— 编辑现有 profile，返回新的 Profile（不写盘）
//
// 写盘 / 自动设 default / 级联清 default 这些副作用由调用方处理。
// wizard 只管收集输入 —— 连 "added!" / "saved!" 这种成功状态行都不打，
// 由外壳自己 success()。
// ============================================================================

import * as p from "@clack/prompts";
import { BUILTIN_PRESETS, CUSTOM_PRESET, findPreset } from "../builtins.js";
import { BUILTIN_PRESETS as PRESET_RULES } from "../preset-rules.js";
import { listProfileNames, listProfiles } from "../config.js";
import type { Mode, Profile, Rectifier } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { error, pc } from "./format.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import {
  kebabCase,
  suggestNameOnConflict,
  validateKebabName,
} from "../utils/names.js";

// ---------------------------------------------------------------------------
// cancel 处理
// ---------------------------------------------------------------------------

/**
 * 统一处理 @clack/prompts 的 cancel 信号。
 * 用户按 Ctrl-C 时返回的是 symbol，不是原值；这时直接退出 0。
 */
function checkCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// add 向导
// ---------------------------------------------------------------------------

/** Count non-empty fields on an AnthropicRectifier-like object. */
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

/**
 * 交互式创建 profile。8 个 prompt 走完后返回一个完整 Profile，
 * 包含 createdAt / updatedAt / 可选 rectifier。**不写盘、不打 success**。
 */
export async function promptAdd(): Promise<Profile> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau add ")));

  // 1. Pick vendor
  const presetChoice = checkCancel(
    await p.select({
      message: "Pick vendor:",
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
    }),
  );
  const isCustom = presetChoice === CUSTOM_PRESET.name;
  const preset = isCustom ? undefined : findPreset(presetChoice);
  if (!isCustom && !preset) {
    error(`unknown vendor "${presetChoice}"`);
    process.exit(1);
  }

  // 2. Decide endpoint + mode
  let endpoint: string;
  let mode: Mode;

  if (isCustom) {
    // Custom: pick mode first, then enter endpoint
    const modeChoice = checkCancel(
      await p.select<Mode>({
        message: "Launch mode:",
        options: [
          {
            value: "direct" as const,
            label: "direct",
            hint: "anthropic direct, fastest, no sidecar",
          },
          {
            value: "rectify" as const,
            label: "rectify",
            hint: "anthropic with local sidecar + rectifier hooks",
          },
          {
            value: "openai" as const,
            label: "openai",
            hint: "openai chat → anthropic conversion via sidecar",
          },
        ],
      }),
    );
    mode = modeChoice;

    const isOpenAI = mode === "openai";
    const endpointRes = checkCancel(
      await p.text({
        message: `${isOpenAI ? "OpenAI" : "Anthropic"} endpoint base URL (cclau auto-appends /v1/... path based on mode):`,
        placeholder: "https://api.example.com",
        validate: (v) => (v ? undefined : "required"),
      }),
    );
    endpoint = endpointRes;
    const protocol = mode === "openai" ? "openai" : "anthropic";
    p.log.message(`actual request URL: ${pc.cyan(buildUpstreamUrl(endpoint, protocol))}`);
  } else {
    // builtin: endpoint + mode auto-filled
    endpoint = preset!.endpoint;
    mode = preset!.defaultMode;
  }

  // 2.5. Rectifier preset: builtin preset + rectify mode → ask to enable
  let enableRectifier = false;
  if (!isCustom && mode === "rectify" && PRESET_RULES[preset!.name]) {
    const ruleCount = countRectifierRules(PRESET_RULES[preset!.name]);
    const enableRect = checkCancel(
      await p.confirm({
        message: `Enable built-in rectifier preset for [${preset!.name}]? (${ruleCount} rule${ruleCount === 1 ? "" : "s"}; you can also hand-edit TOML later)`,
        initialValue: true,
      }),
    );
    enableRectifier = enableRect;
  }

  // 3. apiKey
  const apiKeyRes = checkCancel(
    await p.password({
      message: "API Key:",
      validate: (v) => (v ? undefined : "required"),
    }),
  );
  const apiKey = apiKeyRes;

  // 4. Fetch upstream models
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

  // 5. Single select model
  const upstreamSorted = [...new Set(modelNames)].sort((a, b) =>
    a.localeCompare(b),
  );
  let model: string | undefined;

  if (upstreamSorted.length > 0) {
    const res = checkCancel(
      await p.select({
        message: "Pick model:",
        options: upstreamSorted.map((m) => ({ value: m, label: m })),
      }),
    );
    model = res as string;
  } else {
    const manual = checkCancel(
      await p.text({
        message: "Enter model ID:",
        placeholder: "e.g. deepseek-chat",
        validate: (v) => (v && v.trim() ? undefined : "required"),
      }),
    );
    model = manual.trim();
  }

  // 6. Ask 1m
  const supports1m = checkCancel(
    await p.confirm({
      message: `Does model "${model}" support 1M context?`,
      initialValue: true,
    }),
  );

  // 7. Pick name
  const existingNames = listProfileNames();
  const existingModes: Record<string, Mode> = Object.fromEntries(
    listProfiles().map((p) => [p.name, p.mode]),
  );

  let desiredBase: string;
  if (isCustom) {
    const customName = checkCancel(
      await p.text({
        message: "Profile name (lowercase, kebab-case):",
        placeholder: "my-vendor",
        validate: (v) => validateKebabName(v, existingNames),
      }),
    );
    desiredBase = customName.trim().toLowerCase();
  } else {
    desiredBase = kebabCase(preset!.label || preset!.name);
    const suggested = suggestNameOnConflict(
      desiredBase,
      existingNames,
      existingModes,
      mode,
    );
    const nameRes = checkCancel(
      await p.text({
        message: "Profile name (lowercase, kebab-case):",
        initialValue: suggested,
        placeholder: suggested ? undefined : "e.g. my-vendor",
        validate: (v) => {
          const trimmed = v?.trim().toLowerCase() ?? "";
          if (!trimmed) {
            return suggested
              ? `default name "${desiredBase}" and "${desiredBase}-${mode}" are both taken, please type a new name`
              : "name is required";
          }
          return validateKebabName(trimmed, existingNames);
        },
      }),
    );
    desiredBase = nameRes.trim().toLowerCase();
  }
  const name = desiredBase;

  // 8. Build Profile
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

  // rectify mode + builtin preset + enabled → write preset rules
  if (enableRectifier && PRESET_RULES[preset!.name]) {
    profile.rectifier = { anthropic: PRESET_RULES[preset!.name] } as Rectifier;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// edit 向导
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  return pc.dim(`${key.slice(0, 7)}...${key.slice(-4)}`);
}

function printProfile(profile: Profile): void {
  const modeColor =
    profile.mode === "direct"
      ? pc.green
      : profile.mode === "rectify"
        ? pc.yellow
        : pc.cyan;
  console.log(pc.bold(`Profile: ${profile.name}`));
  console.log(`  ${pc.dim("endpoint:")} ${profile.endpoint}`);
  console.log(`  ${pc.dim("apiKey  :")} ${maskKey(profile.apiKey)}`);
  console.log(`  ${pc.dim("mode    :")} ${modeColor(profile.mode)}`);
  console.log(`  ${pc.dim("model   :")} ${profile.model}`);
  console.log(`  ${pc.dim("1m      :")} ${profile.supports1m}`);
  console.log(`  ${pc.dim("default :")} ${profile.default ? "true" : "false"}`);
}

type Field = "endpoint" | "apiKey" | "mode" | "model" | "supports1m" | "default";

async function editField(profile: Profile, field: Field): Promise<Profile> {
  switch (field) {
    case "endpoint": {
      const v = checkCancel(
        await p.text({
          message: "endpoint:",
          initialValue: profile.endpoint,
          validate: (s) => (s ? undefined : "required"),
        }),
      );
      return { ...profile, endpoint: v };
    }
    case "apiKey": {
      const v = checkCancel(
        await p.password({
          message: "apiKey:",
          validate: (s) => (s ? undefined : "required"),
        }),
      );
      return { ...profile, apiKey: v };
    }
    case "mode": {
      const v = checkCancel(
        await p.select<Mode>({
          message: "mode:",
          initialValue: profile.mode,
          options: [
            { value: "direct" as const, label: "direct", hint: "anthropic direct" },
            {
              value: "rectify" as const,
              label: "rectify",
              hint: "anthropic with rectifier",
            },
            {
              value: "openai" as const,
              label: "openai",
              hint: "openai → anthropic conversion",
            },
          ],
        }),
      );
      return { ...profile, mode: v };
    }
    case "model": {
      const v = checkCancel(
        await p.text({
          message: "model:",
          initialValue: profile.model,
          validate: (s) => (s ? undefined : "required"),
        }),
      );
      return { ...profile, model: v };
    }
    case "supports1m": {
      const v = checkCancel(
        await p.confirm({
          message: "supports1m:",
          initialValue: profile.supports1m,
        }),
      );
      return { ...profile, supports1m: v };
    }
    case "default": {
      const v = checkCancel(
        await p.confirm({
          message: "default:",
          initialValue: profile.default === true,
        }),
      );
      const updated: Profile = { ...profile };
      if (v) updated.default = true;
      else delete updated.default;
      return updated;
    }
  }
}

/**
 * 交互式编辑一个字段，可重复调用直到用户选 done。返回最终 Profile。
 * **不写盘、不打 success**。是否做改动、是否清 default 都由调用方决定。
 */
export async function promptEdit(existing: Profile): Promise<Profile> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau edit ")));
  printProfile(existing);

  let current: Profile = { ...existing };
  while (true) {
    const field = checkCancel(
      await p.select({
        message: "Edit which field? (done to exit)",
        options: [
          { value: "endpoint", label: "endpoint", hint: current.endpoint },
          { value: "apiKey", label: "apiKey", hint: maskKey(current.apiKey) },
          { value: "mode", label: "mode", hint: current.mode },
          { value: "model", label: "model", hint: current.model },
          {
            value: "supports1m",
            label: "supports1m",
            hint: String(current.supports1m),
          },
          {
            value: "default",
            label: "default",
            hint: current.default ? "true" : "false",
          },
          { value: "done", label: "done", hint: "exit edit" },
        ],
      }),
    );
    if (field === "done") break;

    current = await editField(current, field);
    p.log.success(`updated ${field}`);
    console.log();
  }

  return current;
}

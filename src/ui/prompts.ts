// ============================================================================
// cclau 交互式向导
//
// 这是项目里**唯一** import @clack/prompts 的文件。所有需要用户逐项回答
// 的流程都集中在这里。命令文件（commands/*.ts）只是入口：跑一次 wizard，
// 拿到结果，再决定怎么持久化。
//
// 共用 helper（add/edit 都用）：
//   checkCancel<T>(value)           —— 统一处理 p.isCancel 后的退出
//   maskToken / maybePrependCustomModel   —— 纯函数
//   promptVendor                    —— vendor 选择（可搜索 autocomplete）
//   promptMode                      —— 三选项 select
//   promptEndpoint                  —— p.text 输入 URL
//   promptApiKeyNew                 —— 新建（password）
//   promptApiKeyEdit                —— 编辑（text + mask 比对）
//   loadModels                      —— spinner + fetch
//   promptModel                     —— fetch 成功走 autocomplete+哨兵，
//                                       失败退回 text
//   prompt1m                        —— 1m confirm
//   promptName                      —— name + 冲突检测
//
// 入口：
//   promptAdd()           —— 创建新 profile，返回 Profile（不写盘）
//   promptEdit(existing)  —— 编辑现有 profile，返回新的 Profile（不写盘）
//
// 写盘 / 自动设 default / 级联清 default 这些副作用由调用方处理。
// ============================================================================

import * as p from "@clack/prompts";
import { BUILTIN_PRESETS, CUSTOM_PRESET, findPreset, type BuiltinPreset } from "../builtins.js";
import {
  BUILTIN_PRESETS as PRESET_RULES,
  BUILTIN_PRESETS_OPENAI,
  RULE_DEFS,
  RULE_DEFS_OPENAI,
} from "../preset-rules.js";
import { listProfileNames, listProfiles } from "../config.js";
import type { Mode, Profile } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { error, pc } from "./format.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import { fuzzyScore } from "../fuzzy.js";
import {
  kebabCase,
  suggestNameOnConflict,
  validateKebabName,
} from "../utils/names.js";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 三种 mode 的统一措辞，add/edit 都用同一份避免分歧。 */
const MODE_OPTIONS: Array<{ value: Mode; label: string; hint: string }> = [
  {
    value: "direct",
    label: "direct",
    hint: "anthropic direct, fastest, no sidecar",
  },
  {
    value: "rectify",
    label: "rectify",
    hint: "anthropic with local sidecar + rectifier hooks",
  },
  {
    value: "openai",
    label: "openai",
    hint: "openai chat → anthropic conversion via sidecar",
  },
];

/** p.autocomplete 模型选择里的 "Escape to manual" 哨兵项。 */
const MANUAL_MODEL_SENTINEL = "__cclau_manual__";

// ---------------------------------------------------------------------------
// 纯函数 helper（无 clack 依赖）
// ---------------------------------------------------------------------------

/**
 * Mask apiKey for edit-time display: first 4 + N bullets + last 4.
 * Empty → empty. ≤ 8 chars → all bullets. > 8 → 4 + bullet(len-8) + 4.
 *
 * Caller compares trimmed `p.text` return against this mask to detect
 * "user pressed Enter / kept default" — see promptApiKeyEdit.
 *
 * Exported for testability; not part of the wizard API surface.
 */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  const midLen = token.length - 8;
  return `${token.slice(0, 4)}${"•".repeat(midLen)}${token.slice(-4)}`;
}

/**
 * If `prior` is a custom model name (not in upstream list), prepend it so
 * `promptModel` can `initialValue: prior` instead of `initialUserInput`.
 * Verbatim port of ccswi/src/ui/prompts.ts.
 *
 * Exported for testability; not part of the wizard API surface.
 */
export function maybePrependCustomModel(
  models: string[] | null,
  prior: string | undefined,
): string[] | null {
  if (!models) return null;
  const priorTrimmed = prior?.trim();
  if (!priorTrimmed) return models;
  if (models.includes(priorTrimmed)) return models;
  return [priorTrimmed, ...models];
}

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
// step helper（prompt 顺序由 promptAdd / promptEdit 编排）
// ---------------------------------------------------------------------------

/** Vendor 选择：可搜索 autocomplete（ccswi 风格，filter 用 fuzzyScore）。 */
async function promptVendor(): Promise<BuiltinPreset> {
  const result = checkCancel(
    await p.autocomplete<BuiltinPreset>({
      message: "Pick vendor (type to search):",
      options: [
        ...BUILTIN_PRESETS.map((x) => ({
          value: x,
          label: x.label,
          hint: x.endpoint || x.hint,
        })),
        {
          value: CUSTOM_PRESET,
          label: CUSTOM_PRESET.label,
          hint: CUSTOM_PRESET.hint,
        },
      ],
      filter: (search: string, option: { value: BuiltinPreset }) => {
        if (!search) return true;
        return fuzzyScore(search, option.value.label) > 0;
      },
    }),
  );
  return result;
}

/** Mode 三选项 select。`initialValue` 给 add (preset.defaultMode) 或 edit (existing.mode)。 */
async function promptMode(initialValue?: Mode): Promise<Mode> {
  return checkCancel(
    await p.select<Mode>({
      message: "Launch mode:",
      initialValue,
      options: MODE_OPTIONS,
    }),
  );
}

/**
 * Endpoint p.text。`requireInput` 为 true 时强制非空（custom / edit）。
 * openai mode 会打印一个 `actual request URL` hint（用 buildUpstreamUrl 算）。
 */
async function promptEndpoint(
  initialValue: string,
  requireInput: boolean,
  mode: Mode,
): Promise<string> {
  const placeholder = requireInput
    ? mode === "openai"
      ? "https://api.example.com/v1"
      : "https://api.example.com"
    : "Press Enter to use default";
  const v = checkCancel(
    await p.text({
      message: "Endpoint URL:",
      initialValue,
      placeholder,
      validate: (s) => (s && s.trim() ? undefined : "required"),
    }),
  );
  if (mode === "openai") {
    const protocol = "openai";
    p.log.message(
      `actual request URL: ${pc.cyan(buildUpstreamUrl(v, protocol))}`,
    );
  }
  return v.trim();
}

/** 新建时用的 apiKey 输入（password，强制重输）。 */
async function promptApiKeyNew(): Promise<string> {
  return checkCancel(
    await p.password({
      message: "API Key:",
      validate: (v) => (v && v.trim() ? undefined : "required"),
    }),
  ).trim();
}

/**
 * 编辑时用的 apiKey 输入（text + mask 比对，ccswi 风格）。
 * 用户回车（mask 没变）→ 保留 existingToken；输入新值 → 覆盖。
 */
async function promptApiKeyEdit(existingToken: string): Promise<string> {
  const masked = maskToken(existingToken);
  const raw = checkCancel(
    await p.text({
      message: "API Key:",
      initialValue: masked,
      placeholder: "Press Enter to keep current",
    }),
  );
  const trimmed = raw.trim();
  // 用户回车、或者没改任何字符 → 还是 mask 字符串 → 保留旧值
  if (trimmed === masked) return existingToken;
  return trimmed;
}

/** Spinner + fetch。失败返 null（失败和空列表在 wizard 里同等对待 → 走纯 text）。 */
async function loadModels(
  endpoint: string,
  token: string,
): Promise<string[] | null> {
  const s = p.spinner();
  s.start("Fetching model list from upstream...");
  try {
    const models = await fetchUpstreamModels({
      endpoint: endpoint.trim(),
      token: token.trim(),
    });
    if (models.length === 0) {
      s.stop("No models returned, will enter manually.");
      return null;
    }
    s.stop(`Found ${models.length} model(s).`);
    return [...new Set(models)].sort((a, b) => a.localeCompare(b));
  } catch {
    s.stop("Failed to fetch models, will enter manually.");
    return null;
  }
}

/**
 * Model 选择。fetch 成功 → p.autocomplete（可搜索）+ 顶部 MANUAL 哨兵
 * 项（"✏️  Enter custom model name..."），选哨兵 → 二次 p.text。
 * fetch 失败 → 直接 p.text 手动输入。`defaultValue` 用作 `initialValue`
 * （如果在 list 里）或 `initialUserInput`（不在 list 里）。
 */
async function promptModel(
  message: string,
  models: string[] | null,
  defaultValue?: string,
): Promise<string> {
  // fallback: fetch 失败或空列表 → 直接 text
  if (!models) {
    return checkCancel(
      await p.text({
        message,
        defaultValue: defaultValue || "",
        placeholder: "e.g. deepseek-chat",
        validate: (v) => (v && v.trim() ? undefined : "required"),
      }),
    ).trim();
  }

  const allOptions = [
    {
      value: MANUAL_MODEL_SENTINEL,
      label: "✏️  Enter custom model name...",
    },
    ...models.map((name) => ({ value: name, label: name })),
  ];
  const hasInOptions = defaultValue
    ? allOptions.some((o) => o.value === defaultValue)
    : false;

  const result = checkCancel(
    await p.autocomplete<string>({
      message,
      options: allOptions,
      initialValue: hasInOptions ? defaultValue : undefined,
      initialUserInput: !hasInOptions && defaultValue ? defaultValue : undefined,
      filter: (search: string, option: { value: string }) => {
        if (option.value === MANUAL_MODEL_SENTINEL) return !search;
        if (!search) return true;
        return fuzzyScore(search, option.value) > 0;
      },
    }),
  );

  if (result === MANUAL_MODEL_SENTINEL) {
    return checkCancel(
      await p.text({
        message,
        defaultValue: defaultValue || "",
        placeholder: "e.g. deepseek-chat",
        validate: (v) => (v && v.trim() ? undefined : "required"),
      }),
    ).trim();
  }
  return result;
}

/** 1m confirm（默认 true）。 */
async function prompt1m(model: string, defaultValue: boolean): Promise<boolean> {
  return checkCancel(
    await p.confirm({
      message: `Does model "${model}" support 1M context?`,
      initialValue: defaultValue,
    }),
  );
}

/**
 * Profile name：
 *   custom 路径 → 裸 p.text，用 validateKebabName
 *   builtin 路径 → 用 kebabCase(vendor.label) 作为 base，再走
 *                  suggestNameOnConflict 算 suggested（同名+不同 mode
 *                  → 加 "-<mode>" 后缀；否则让用户键入新名字）。
 */
async function promptName(opts: {
  existingNames: string[];
  existingModes: Record<string, Mode>;
  isCustom: boolean;
  preset?: BuiltinPreset;
  mode: Mode;
}): Promise<string> {
  const { existingNames, existingModes, isCustom, preset, mode } = opts;

  if (isCustom) {
    const v = checkCancel(
      await p.text({
        message: "Profile name (lowercase, kebab-case):",
        placeholder: "my-vendor",
        validate: (v) => validateKebabName(v, existingNames),
      }),
    );
    return v.trim().toLowerCase();
  }

  const desiredBase = kebabCase(preset!.label || preset!.name);
  const suggested = suggestNameOnConflict(
    desiredBase,
    existingNames,
    existingModes,
    mode,
  );
  const v = checkCancel(
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
  return v.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// rectifier rule picker（rectify mode wizard step）
// ---------------------------------------------------------------------------

/** Sentinel value for the "no rectifier" option in the single-select picker. */
const NO_RECTIFIER_SENTINEL = "__cclau_no_rectifier__";

/**
 * Single-select rectifier picker, mode-aware.
 *
 * In rectify mode: lists rules from `PRESET_RULES` (anthropic-protocol
 * rectifiers). In openai mode: lists rules from `BUILTIN_PRESETS_OPENAI`.
 * Each mode's rules are addressed by the same vendor name (plan B: dual-mode
 * per vendor) but resolve to different rule bodies — e.g. "opencode-go" in
 * rectify adds auth header, in openai drops thinking.
 *
 * The picked vendor's matching rule in the active mode is pre-selected so
 * the common case is "Enter to confirm"; custom vendors and vendors with
 * no dedicated rule in the active mode default to "none" but can still
 * hand-pick any other rule.
 *
 * Returns the selected rule name, or undefined if the user picked "none"
 * (or mode isn't rectify/openai, or there are no rules to choose from).
 */
async function pickBuiltinRectifier(
  preset: BuiltinPreset,
  mode: Mode,
): Promise<string | undefined> {
  // Mode-aware rule lookup: same vendor name, different rule body per mode.
  const rulesByMode =
    mode === "openai" ? BUILTIN_PRESETS_OPENAI : mode === "rectify" ? PRESET_RULES : null;
  if (!rulesByMode) return undefined;
  const defsByMode = mode === "openai" ? RULE_DEFS_OPENAI : RULE_DEFS;

  const ruleNames = Object.keys(rulesByMode);
  if (ruleNames.length === 0) return undefined;

  const options: Array<{ value: string; label: string; hint?: string }> = [
    {
      value: NO_RECTIFIER_SENTINEL,
      label: "none (no rectifier)",
      hint: "skip — wire nothing; you can hand-edit TOML later",
    },
    ...ruleNames.map((name) => {
      const def = defsByMode[name];
      return {
        value: name,
        label: def?.label ?? name,
        hint: def?.hint,
      };
    }),
  ];

  // Default = preset's own rule in this mode if it exists, else "none".
  const initialValue = rulesByMode[preset.name] ? preset.name : NO_RECTIFIER_SENTINEL;

  const result = checkCancel(
    await p.select<string>({
      message: "Rectifier rule:",
      options,
      initialValue,
    }),
  );
  return result === NO_RECTIFIER_SENTINEL ? undefined : result;
}

// ---------------------------------------------------------------------------
// add 向导（fixed-order serial；bug #1 / bug #2 在这里修）
// ---------------------------------------------------------------------------

/**
 * 交互式创建 profile。12 步走完后返回一个完整 Profile（包含 createdAt /
 * updatedAt / 可选 rectifier）。**不写盘、不打 success**。
 *
 * Bug 修复点：
 * - step 3 (mode) 现在永远问，不再被 builtin preset 锁 mode。
 * - step 8 (model) 现在用 promptModel（autocomplete + CUSTOM 哨兵），
 *   fetch 成功也能 escape 回手动输入。
 */
export async function promptAdd(): Promise<Profile> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau add ")));

  // 1. Vendor
  const preset = await promptVendor();
  const isCustom = preset.name === CUSTOM_PRESET.name;
  if (!isCustom && !findPreset(preset.name)) {
    error(`unknown vendor "${preset.name}"`);
    process.exit(1);
  }

  // 2. Mode（无条件，builtin 也问；initialValue 优先级：
//    - custom vendor：undefined（让用户挑）
//    - builtin vendor 在 PRESET_RULES 命中 → "rectify"
//      （既然选了这条 vendor 大概率就是要走整流路径，让 rectifier picker
//       真的出现在下一步）
//    - builtin vendor 没命中 → preset.defaultMode（通常 direct）
  const initialMode: Mode | undefined = isCustom
    ? undefined
    : PRESET_RULES[preset.name]
      ? "rectify"
      : preset.defaultMode;
  const mode = await promptMode(initialMode);

  // 3. Endpoint
  const endpointInitial = isCustom ? "" : preset.endpoint;
  const endpoint = await promptEndpoint(endpointInitial, isCustom, mode);

  // 4. 内置 rectifier rule 单选（仅 rectify mode + 有 rule 可选）
  const pickedRule = await pickBuiltinRectifier(preset, mode);

  // 5. API Key
  const apiKey = await promptApiKeyNew();

  // 6. Fetch model list
  const models = await loadModels(endpoint, apiKey);

  // 7. Model selection（fetch 成功 → autocomplete + 哨兵）
  const model = await promptModel("Pick model:", models);

  // 8. 1M context
  const supports1m = await prompt1m(model, true);

  // 9. Name
  const existingNames = listProfileNames();
  const existingModes: Record<string, Mode> = Object.fromEntries(
    listProfiles().map((pr) => [pr.name, pr.mode]),
  );
  const name = await promptName({
    existingNames,
    existingModes,
    isCustom,
    preset: isCustom ? undefined : preset,
    mode,
  });

  // 10. Build Profile
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

  if (pickedRule) {
    profile.rectifier = pickedRule;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// edit 向导（fixed-order serial，bug #3 在这里修：不再用字段循环）
// ---------------------------------------------------------------------------

/**
 * 交互式编辑一个 profile。按固定顺序走 endpoint → apiKey → mode →
 * model → 1m，每步 `initialValue` pre-fill 当前值。除了
 * `endpoint / apiKey / mode / model / supports1m` 之外的字段
 * （`name / vendor / rectifier / createdAt` / **全局 default**）一律
 * frozen，wizard 一开始用 console.log 把不可改字段打出来。
 *
 * Global `default` is NOT editable here — use `cclau default <name>` to
 * switch the active profile.
 */
export async function promptEdit(existing: Profile): Promise<Profile> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau edit ")));
  console.log(`  Editing profile: ${pc.bold(existing.name)} ${pc.dim(`(mode: ${existing.mode})`)}`);

  // 1. Endpoint
  const endpoint = checkCancel(
    await p.text({
      message: "Endpoint URL:",
      initialValue: existing.endpoint,
      placeholder: "Press Enter to keep current",
      validate: (s) => (s && s.trim() ? undefined : "required"),
    }),
  ).trim();

  // 2. API Key (text + mask)
  const apiKey = await promptApiKeyEdit(existing.apiKey);

  // 3. Mode
  const mode = await promptMode(existing.mode);

  // 4. Fetch model list (用新的 endpoint + apiKey)
  const models = await loadModels(endpoint, apiKey);
  // 如果用户之前用了自定义 model，autocomplete 选不上 → 前置
  const modelsWithPrior = maybePrependCustomModel(models, existing.model);

  // 5. Model
  const model = await promptModel("Pick model:", modelsWithPrior, existing.model);

  // 6. 1M
  const supports1m = await prompt1m(model, existing.supports1m);

  // 7. Build & return
  const updated: Profile = {
    name: existing.name,
    endpoint,
    apiKey,
    mode,
    model,
    supports1m,
    updatedAt: Date.now(),
    createdAt: existing.createdAt,
    // rectifier 原样保留，wizard 不让改 → hand-edit TOML
    ...(existing.rectifier ? { rectifier: existing.rectifier } : {}),
  };
  return updated;
}

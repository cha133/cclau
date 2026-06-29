// cclau add - interactively add a profile
//
// Flow (refactored, single model):
//   1. Pick vendor (builtin preset or custom)
//   2. builtin → endpoint + mode auto-filled; custom → pick mode + enter endpoint
//   3. builtin + rectify mode + rectifier preset available → ask to enable
//   4. Enter apiKey
//   5. Fetch upstream models → single select (manual entry on fetch failure)
//   6. Ask supports1m (default Yes)
//   7. Pick name (preset kebab-case auto-filled; on conflict add -<mode> suffix;
//      still conflict → user must type)
//   8. Write Profile
//
// Note: does NOT auto-set default — user runs `cclau default <name>` explicitly.

import * as p from "@clack/prompts";
import { BUILTIN_PRESETS, CUSTOM_PRESET, findPreset } from "../builtins.js";
import { BUILTIN_PRESETS as PRESET_RULES } from "../preset-rules.js";
import { listProfiles, listProfileNames, upsertProfile } from "../config.js";
import type { Mode, Profile, Rectifier } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { pc } from "../utils/logger.js";
import { fetchUpstreamModels } from "../core/model-fetch.js";
import {
  kebabCase,
  suggestNameOnConflict,
  validateKebabName,
} from "../utils/names.js";

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

export async function addCmd(): Promise<void> {
  console.log("");
  p.intro(pc.bgCyan(pc.black(" cclau add ")));

  // 1. Pick vendor
  const presetChoice = await p.select({
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
  });
  if (p.isCancel(presetChoice)) {
    p.cancel("cancelled");
    process.exit(0);
  }
  const isCustom = presetChoice === CUSTOM_PRESET.name;
  const preset = isCustom ? undefined : findPreset(presetChoice);
  if (!isCustom && !preset) {
    p.log.error(`unknown vendor "${presetChoice}"`);
    process.exit(1);
  }

  // 2. Decide endpoint + mode
  let endpoint: string;
  let mode: Mode;

  if (isCustom) {
    // Custom: pick mode first, then enter endpoint
    const modeChoice = await p.select<Mode>({
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
    });
    if (p.isCancel(modeChoice)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    mode = modeChoice;

    const isOpenAI = mode === "openai";
    const endpointRes = await p.text({
      message: `${isOpenAI ? "OpenAI" : "Anthropic"} endpoint base URL (cclau auto-appends /v1/... path based on mode):`,
      placeholder: "https://api.example.com",
      validate: (v) => (v ? undefined : "required"),
    });
    if (p.isCancel(endpointRes)) {
      p.cancel("cancelled");
      process.exit(0);
    }
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
    const enableRect = await p.confirm({
      message: `Enable built-in rectifier preset for [${preset!.name}]? (${ruleCount} rule${ruleCount === 1 ? "" : "s"}; you can also hand-edit TOML later)`,
      initialValue: true,
    });
    if (p.isCancel(enableRect)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    enableRectifier = enableRect;
  }

  // 3. apiKey
  const apiKeyRes = await p.password({
    message: "API Key:",
    validate: (v) => (v ? undefined : "required"),
  });
  if (p.isCancel(apiKeyRes)) {
    p.cancel("cancelled");
    process.exit(0);
  }
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
    const res = await p.select({
      message: "Pick model:",
      options: upstreamSorted.map((m) => ({ value: m, label: m })),
    });
    if (p.isCancel(res)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    model = res as string;
  } else {
    const manual = await p.text({
      message: "Enter model ID:",
      placeholder: "e.g. deepseek-chat",
      validate: (v) => (v && v.trim() ? undefined : "required"),
    });
    if (p.isCancel(manual)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    model = manual.trim();
  }

  // 6. Ask 1m
  const supports1m = await p.confirm({
    message: `Does model "${model}" support 1M context?`,
    initialValue: true,
  });
  if (p.isCancel(supports1m)) {
    p.cancel("cancelled");
    process.exit(0);
  }

  // 7. Pick name
  const existingNames = listProfileNames();
  const existingModes: Record<string, Mode> = Object.fromEntries(
    listProfiles().map((p) => [p.name, p.mode]),
  );

  let desiredBase: string;
  if (isCustom) {
    const customName = await p.text({
      message: "Profile name (lowercase, kebab-case):",
      placeholder: "my-vendor",
      validate: (v) => validateKebabName(v, existingNames),
    });
    if (p.isCancel(customName)) {
      p.cancel("cancelled");
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
    });
    if (p.isCancel(nameRes)) {
      p.cancel("cancelled");
      process.exit(0);
    }
    desiredBase = nameRes.trim().toLowerCase();
  }
  const name = desiredBase;

  // 8. Write Profile
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

  await upsertProfile(profile);

  // Auto-default: if no other profile is the default, promote the new one.
  // Rationale: first profile added → make it default so `cclau` (no args) works
  // immediately, no need to run `cclau default <name>` separately. Subsequent
  // adds don't auto-default — user picks explicitly via `cclau default <name>`.
  let autoDefaulted = false;
  const allAfter = listProfiles();
  const hasAnotherDefault = allAfter.some(
    (p) => p.name !== profile.name && p.default === true,
  );
  if (!hasAnotherDefault && profile.default !== true) {
    const updated: Profile = {
      ...profile,
      default: true,
      updatedAt: Date.now(),
    };
    await upsertProfile(updated);
    autoDefaulted = true;
  }

  const rectHint = profile.rectifier ? " (rectifier enabled)" : "";
  const defaultHint = autoDefaulted ? " (auto-set as default)" : "";
  p.outro(
    pc.green(
      `✓ added profile "${name}" (${mode}, model: ${model}${rectHint}${defaultHint})`,
    ),
  );
  p.log.message(
    pc.dim(
      `next: run ${pc.cyan(`\`cclau default ${name}\``)} to set as default, ${pc.cyan(`\`cclau ${name}\``)} to launch claude code`,
    ),
  );
}
// cclau cp <src> <new_name> - clone a profile with a different model
//
// Mirrors ../ccswi's `cp`: resolve a source profile, clone its endpoint/key/
// mode/rectifier, ask only for model + 1M support, then make the clone active.

import {
  getProfile,
  listProfileNames,
  setDefault,
  upsertProfile,
} from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import type { Profile } from "../types.js";
import { error, info, pc, success } from "../ui/format.js";
import {
  loadModels,
  maybePrependCustomModel,
  prompt1m,
  promptModel,
} from "../ui/prompts.js";
import { validateKebabName } from "../utils/names.js";

export function resolveCpSource(
  src: string,
  names: string[],
): { name: string; matched: boolean } {
  const top = fuzzyTopN(src, names, 2);
  if (top.length === 0) {
    throw new Error(`profile "${src}" does not exist. existing: ${names.join(", ") || "(empty)"}`);
  }
  if (isAmbiguous(top)) {
    throw new Error(
      `"${src}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. please use a more specific name.`,
    );
  }
  const resolved = top[0]!.name;
  return { name: resolved, matched: resolved !== src };
}

export function normalizeCpName(newName: string, existingNames: string[]): string {
  const normalized = newName.trim().toLowerCase();
  const validationError = validateKebabName(normalized, existingNames);
  if (validationError) throw new Error(validationError);
  return normalized;
}

export function buildClonedProfile(opts: {
  source: Profile;
  name: string;
  model: string;
  supports1m: boolean;
  now: number;
}): Profile {
  const { source, name, model, supports1m, now } = opts;
  return {
    ...source,
    name,
    model: model.trim(),
    supports1m,
    createdAt: now,
    updatedAt: now,
  };
}

export async function cpCmd(src: string, newName: string): Promise<void> {
  try {
    const all = listProfileNames();
    const resolved = resolveCpSource(src, all);
    if (resolved.matched) info(`matched profile "${pc.dim(resolved.name)}"`);

    const normalizedName = normalizeCpName(newName, all);
    const source = getProfile(resolved.name);
    if (!source) {
      error(`profile "${resolved.name}" does not exist`);
      process.exit(1);
    }

    const models = await loadModels(source.endpoint, source.apiKey);
    const modelsWithSource = maybePrependCustomModel(models, source.model);
    const model = await promptModel("Pick model:", modelsWithSource, source.model);
    const supports1m = await prompt1m(model, source.supports1m);

    const cloned = buildClonedProfile({
      source,
      name: normalizedName,
      model,
      supports1m,
      now: Date.now(),
    });

    await upsertProfile(cloned);
    await setDefault(cloned.name);

    const rectHint = cloned.rectifier ? " (rectifier enabled)" : "";
    success(
      `cloned "${source.name}" to "${cloned.name}" (${cloned.mode}, model: ${cloned.model}${rectHint})`,
    );
    info(`"${cloned.name}" is now active`);
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}

// cclau rename <name> <new_name> - rename a profile

import { listProfileNames, renameProfile } from "../config.js";
import { fuzzyTopN, isAmbiguous } from "../fuzzy.js";
import { error, info, pc, success } from "../ui/format.js";
import { validateKebabName } from "../utils/names.js";

export function resolveRenameSource(name: string, names: string[]): string {
  const top = fuzzyTopN(name, names, 2);
  if (top.length === 0) {
    throw new Error(`profile "${name}" does not exist. existing: ${names.join(", ") || "(empty)"}`);
  }
  if (isAmbiguous(top)) {
    throw new Error(
      `"${name}" ambiguously matches multiple profiles: ${top.map((s) => s.name).join(", ")}. please use a more specific name.`,
    );
  }
  return top[0]!.name;
}

export function normalizeRenameName(newName: string, existingNames: string[]): string {
  const normalized = newName.trim().toLowerCase();
  const validationError = validateKebabName(normalized, existingNames);
  if (validationError) throw new Error(validationError);
  return normalized;
}

export async function renameCmd(name: string, newName: string): Promise<void> {
  try {
    const all = listProfileNames();
    const resolved = resolveRenameSource(name, all);
    if (resolved !== name) info(`matched profile "${pc.dim(resolved)}"`);

    const normalizedName = normalizeRenameName(newName, all);
    const renamed = await renameProfile(resolved, normalizedName);
    if (!renamed) throw new Error(`profile "${resolved}" does not exist`);

    success(`renamed profile "${resolved}" to "${normalizedName}"`);
  } catch (err) {
    error(String(err));
    process.exit(1);
  }
}

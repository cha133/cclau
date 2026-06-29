// Naming utilities: kebab-case + conflict-aware
//
// kebabCase: ported from cctra src/providers/presets.ts:161
// suggestNameOnConflict: cclau-specific — on same-profile re-add, auto-suffix with mode
// validateKebabName: clack validate callback returning error string / undefined

import type { Mode } from "../types.js";

/**
 * Convert any string to kebab-case.
 * - all lowercase
 * - non-[a-z0-9] chars → hyphens
 * - collapse consecutive hyphens
 * - strip leading/trailing hyphens
 *
 * Examples:
 *   "Ark Agent Plan"                        → "ark-agent-plan"
 *   "Xiaomi MiMo Token Plan (China)"       → "xiaomi-mimo-token-plan-china"
 *   "APIKEY.FUN"                            → "apikey-fun"
 */
export function kebabCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Conflict-aware name suggestion.
 *
 * Rules:
 * 1. `desired` not taken → return `desired`
 * 2. `desired` taken, and the existing profile's mode differs from newMode →
 *    return `desired-<newMode>` (e.g. `deepseek` already direct, adding rectify → `deepseek-rectify`)
 * 3. Otherwise (or suffix also taken) → return "", caller asks user to type
 *
 * @param desired the desired name (typically kebabCase(vendorName))
 * @param existingNames current profile names
 * @param existingModes name → mode mapping (to know existing profile's mode)
 * @param newMode the mode of the new add
 */
export function suggestNameOnConflict(
  desired: string,
  existingNames: string[],
  existingModes: Record<string, Mode>,
  newMode: Mode,
): string {
  if (!existingNames.includes(desired)) return desired;

  const existingMode = existingModes[desired];
  if (existingMode && existingMode !== newMode) {
    const suffixed = `${desired}-${newMode}`;
    if (!existingNames.includes(suffixed)) return suffixed;
  }

  return "";
}

/**
 * clack validate callback: check name is valid + unique.
 *
 * @param v user input
 * @param existingNames current profile names
 */
export function validateKebabName(v: string | undefined, existingNames: string[]): string | undefined {
  if (!v || !v.trim()) return "Name is required.";
  const n = v.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
    return "Use kebab-case: lowercase letters, digits, hyphens; must start with alnum.";
  }
  if (n.length > 63) return "Name too long (max 63 chars).";
  if (existingNames.includes(n)) {
    return `Name "${n}" already exists. Pick a different one.`;
  }
  return undefined;
}
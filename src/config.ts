// TOML config read/write
//
// Config schema (refactored to global default):
//   [no top-level]                          ← no default
//   default = "<profile-name>"              ← single source of truth
//   [profiles.<name>]
//     endpoint / apiKey / mode / model / supports1m / createdAt / updatedAt / [rectifier]
//
// The active profile is referenced by name at the top level. Multi-default is
// impossible (one key). Dangling references (cfg.default points to a profile
// that no longer exists) are tolerated by reads (`getDefaultProfile` returns
// undefined) and not written by any command.
//
// Provider / multi-tier / alias all deleted.

import { writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { configPath } from "./utils/paths.js";
import type { Config, Profile, StoredProfile } from "./types.js";

/**
 * Thrown by `loadAppConfig` when the on-disk config uses the old per-profile
 * `default = true` schema (pre-global-default). User must hand-edit to remove
 * those lines and re-run `cclau use <name>` once.
 *
 * Per user decision: no automatic migration. The error message is the migration
 * recipe.
 */
export class LegacyConfigError extends Error {
  readonly offendingProfile: string;
  constructor(offendingProfile: string) {
    super(
      `cclau config uses old per-profile \`default\` field (in profile "${offendingProfile}").\n` +
        `Migrate: run \`cclau use <your-default-profile-name>\` once.\n` +
        `For read-only inspection, hand-edit your config.toml to remove the\n` +
        `\`default = true\` lines first.`,
    );
    this.name = "LegacyConfigError";
    this.offendingProfile = offendingProfile;
  }
}

export function loadAppConfig(): Config {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return emptyConfig();
    return emptyConfig();
  }
  if (!text.trim()) return emptyConfig();

  const parsed = parse(text) as unknown as Config | undefined;
  if (!parsed || typeof parsed !== "object") return emptyConfig();

  // Legacy detection: any per-profile `default = true` line. Run before
  // stripping unknown keys so the offending profile name is preserved.
  const profiles = (parsed.profiles ?? {}) as Record<string, StoredProfile>;
  for (const [name, stored] of Object.entries(profiles)) {
    if (stored && typeof stored === "object" && (stored as { default?: unknown }).default === true) {
      throw new LegacyConfigError(name);
    }
  }

  // Build config preserving top-level `default` (if any) and known profiles.
  // Other top-level keys are intentionally dropped to keep the schema closed.
  return {
    default: typeof parsed.default === "string" ? parsed.default : undefined,
    profiles,
  };
}

function emptyConfig(): Config {
  return { profiles: {} };
}

export async function saveAppConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  // Insertion order: `default` first (it's the most important global state);
  // profiles table follows. smol-toml walks Object.keys so this order is preserved.
  const toSerialize: Record<string, unknown> = {};
  if (config.default !== undefined) toSerialize.default = config.default;
  toSerialize.profiles = config.profiles;
  const toml = stringify(toSerialize as any);
  await writeFile(path, toml, { mode: 0o600 });
}

function normalizeProfile(stored: StoredProfile, name: string): Profile {
  return {
    name,
    endpoint: stored.endpoint,
    apiKey: stored.apiKey,
    mode: stored.mode,
    model: stored.model,
    supports1m: stored.supports1m,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    // Strip any legacy `default` field silently — loadAppConfig rejects it first,
    // but normalizeProfile runs from `getProfile` callers that may have stale
    // configs in memory; this keeps the in-memory Profile shape pure.
    ...(stored.rectifier ? { rectifier: stored.rectifier } : {}),
  };
}

export function getProfile(name: string): Profile | undefined {
  const stored = loadAppConfig().profiles[name];
  if (!stored) return undefined;
  return normalizeProfile(stored, name);
}

export async function upsertProfile(profile: Profile): Promise<void> {
  const cfg = loadAppConfig();
  const { name, ...stored } = profile;
  cfg.profiles[name] = stored;
  await saveAppConfig(cfg);
}

export async function removeProfile(name: string): Promise<boolean> {
  const cfg = loadAppConfig();
  if (!cfg.profiles[name]) return false;
  delete cfg.profiles[name];
  await saveAppConfig(cfg);
  return true;
}

/**
 * Rename a profile in one config write. The profile payload is preserved,
 * except for updatedAt, and the global default reference follows the rename.
 */
export async function renameProfile(
  oldName: string,
  newName: string,
  updatedAt = Date.now(),
): Promise<boolean> {
  const cfg = loadAppConfig();
  const stored = cfg.profiles[oldName];
  if (!stored) return false;
  if (cfg.profiles[newName]) {
    throw new Error(`profile "${newName}" already exists`);
  }

  cfg.profiles[newName] = { ...stored, updatedAt };
  delete cfg.profiles[oldName];
  if (cfg.default === oldName) cfg.default = newName;
  await saveAppConfig(cfg);
  return true;
}

export function listProfiles(): Profile[] {
  const cfg = loadAppConfig();
  const profiles: Profile[] = Object.entries(cfg.profiles).map(([name, stored]) =>
    normalizeProfile(stored, name),
  );
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function listProfileNames(): string[] {
  return listProfiles().map((p) => p.name);
}

// ---------------------------------------------------------------------------
// Default (global key) — single source of truth
// ---------------------------------------------------------------------------

/**
 * Returns the raw top-level `default` string from config, without resolving
 * whether the referenced profile actually exists. `undefined` only when the
 * key is absent (never set, or cleared).
 *
 * Use this when the caller wants to know "is the key set" rather than
 * "does the key point to a real profile". E.g. `use.ts` show-mode for
 * displaying the literal name including dangling references.
 */
export function getDefaultName(): string | undefined {
  return loadAppConfig().default;
}

/**
 * Returns the active default Profile, or `undefined` if either:
 *   - the top-level `default` key is absent, OR
 *   - it is dangling (points to a profile that no longer exists).
 *
 * Lazy resolution — never auto-clears dangling references. Use `clearDefault`
 * if you want to actively forget.
 */
export function getDefaultProfile(): Profile | undefined {
  const name = loadAppConfig().default;
  if (name === undefined) return undefined;
  return getProfile(name);
}

/**
 * Set the global default to `name`. Validates that the profile exists
 * (prevents dangling writes). Atomic: overwrites any prior default.
 */
export async function setDefault(name: string): Promise<void> {
  if (!getProfile(name)) {
    throw new Error(`profile "${name}" does not exist`);
  }
  const cfg = loadAppConfig();
  cfg.default = name;
  await saveAppConfig(cfg);
}

/**
 * Clear the global default (delete the top-level key). Used by `rm` when the
 * last profile is removed and the user explicitly wants a default-less state.
 * (In practice `rm` leaves the key stale so the next `cclau add` overwrites
 * naturally; this helper is for explicit clearing paths.)
 */
export async function clearDefault(): Promise<void> {
  const cfg = loadAppConfig();
  if (cfg.default === undefined) return;
  delete cfg.default;
  await saveAppConfig(cfg);
}

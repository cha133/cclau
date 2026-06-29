// Generate settings JSON injected into claude code via `claude --settings <file>`.
// Temporary file path; ~/.claude/settings.json is never modified.
//
// refactored: single profile concept, 4 ANTHROPIC_DEFAULT_*_MODEL envs all hold the same model.
// sidecar decision based on profile.mode:
//   direct  → zero-hop (ANTHROPIC_BASE_URL = profile.endpoint)
//   rectify → sidecar + rectifier hooks (profile.rectifier mounted)
//   openai  → sidecar + openai ↔ anthropic protocol conversion

import { randomUUID } from "node:crypto";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { INVOCATION_DIR } from "./utils/paths.js";
import { apply1m } from "./core/model-1m.js";
import type { Profile } from "./types.js";

export interface SettingsFile {
  path: string;
  cleanup: () => Promise<void>;
}

export interface LaunchResolution {
  /** model id written by claude-code to the 4 ANTHROPIC_DEFAULT_*_MODEL envs (apply1m applied) */
  settingsModel: string;
  /** model id passed through to upstream (base name, no [1m], no prefix) */
  upstreamModel: string;
  sidecar: {
    needed: boolean;
    /** human-readable decision reason, e.g. "mode: rectify" */
    reason?: string;
  };
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

/**
 * Resolve profile → launch decision.
 * Throws when any required field is missing.
 */
export function resolveLaunch(profile: Profile): LaunchResolution {
  if (!profile.endpoint) {
    throw new ProfileResolutionError(`profile "${profile.name}" missing endpoint`);
  }
  if (!profile.apiKey) {
    throw new ProfileResolutionError(`profile "${profile.name}" missing apiKey`);
  }
  if (!profile.model) {
    throw new ProfileResolutionError(`profile "${profile.name}" missing model`);
  }

  const sidecar = computeSidecarNeed(profile);
  return {
    settingsModel: apply1m(profile.model, profile.supports1m),
    upstreamModel: profile.model,
    sidecar,
  };
}

function computeSidecarNeed(profile: Profile): {
  needed: boolean;
  reason?: string;
} {
  switch (profile.mode) {
    case "direct":
      return { needed: false };
    case "rectify":
      return { needed: true, reason: "mode: rectify" };
    case "openai":
      return { needed: true, reason: "mode: openai" };
  }
}

/**
 * Write settings JSON to a temporary file and return the cleanup handle.
 *
 * IMPORTANT: relies on Claude Code's deep-merge behavior for `--settings <file>`
 * (see claude-code src/utils/settings/settings.ts: settingsMergeCustomizer +
 * lodash mergeWith, applied in source order userSettings → projectSettings →
 * localSettings → flagSettings → policySettings). Our temp file only writes
 * `env: { 6 ANTHROPIC_* keys }`; all other fields (permissions, hooks,
 * mcpServers, other env vars, ...) deep-merge through from the user's global
 * ~/.claude/settings.json. Arrays like `permissions.allow` concatenate + dedup.
 * Do NOT add fields here intending to "reset" global state — deep merge means
 * we'd just lose the global value. To override a global field, set it explicitly
 * in this file's `env` (or other nested object) — it will overwrite via merge.
 *
 * @param profile the active profile
 * @param port direct mode: undefined (baseUrl = profile.endpoint, true zero-hop);
 *             sidecar mode: local server port (baseUrl = http://127.0.0.1:port)
 */
export async function writeSettingsFile(
  profile: Profile,
  port?: number,
): Promise<SettingsFile> {
  const { settingsModel } = resolveLaunch(profile);

  const baseUrl =
    port !== undefined
      ? `http://127.0.0.1:${port}`
      : profile.endpoint;

  // [1m] is claude-code's internal hint (see src/core/model-1m.ts top comment).
  // resolveLaunch has already called apply1m, so all 4 vars here are "base[1m]" or "base".
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: profile.apiKey,
      ANTHROPIC_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: settingsModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: settingsModel,
    },
  };

  const filename = `invocation-${randomUUID()}.json`;
  const filepath = join(INVOCATION_DIR, filename);

  await mkdir(INVOCATION_DIR, { recursive: true });
  await writeFile(filepath, JSON.stringify(settings, null, 2), { mode: 0o600 });

  return {
    path: filepath,
    cleanup: async () => {
      try {
        await unlink(filepath);
      } catch {
        // already deleted, ignore
      }
    },
  };
}
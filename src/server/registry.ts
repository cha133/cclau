// sidecar routing registry
//
// refactored: single profile concept, registry holds exactly 1 entry.
// key = strip1m(profile.model) — claude-code's normalizeModelStringForAPI
// strips the [1m] suffix (see src/core/model-1m.ts top comment), so the sidecar
// receives the already-stripped string and the registry must match on that form.
//
// Cross-provider disambiguation is no longer needed — each profile carries its own
// endpoint + apiKey + model, no ambiguity across profiles (profile name is the namespace).

import type { Mode, Profile, Rectifier } from "../types.js";
import {
  resolveOpenAIRectifierByName,
  resolveRectifierByName,
} from "../preset-rules.js";
import { strip1m } from "../core/model-1m.js";
import { warn } from "../ui/format.js";

export interface RouteEntry {
  /** trailing / stripped */
  endpoint: string;
  apiKey: string;
  mode: Mode;
  /** model id passed through to upstream (bare base name) */
  model: string;
  /** Anthropic-protocol rectifier (rectify mode only). */
  rectifier?: Rectifier;
}

export type Registry = Map<string, RouteEntry>;

export class RegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryBuildError";
  }
}

/**
 * Build registry from a single profile (always exactly 1 entry).
 * key = strip1m(profile.model).
 */
export function buildRegistry(profile: Profile): Registry {
  const reg: Registry = new Map();
  const entry: RouteEntry = {
    endpoint: profile.endpoint.replace(/\/+$/, ""),
    apiKey: profile.apiKey,
    mode: profile.mode,
    model: profile.model,
  };

  // profile.rectifier is an opaque name (e.g. "opencode-go") — resolve to
  // the concrete rectifier for the current mode. Same name may resolve to
  // different rules per mode (e.g. "opencode-go" → auth header in rectify,
  // drop-thinking in openai). Unknown names fall through to no-op + warn so
  // hand-edited TOML typos are loud, not silent.
  const rectName = profile.rectifier;
  if (rectName) {
    if (profile.mode === "rectify") {
      const resolved = resolveRectifierByName(rectName);
      if (resolved) entry.rectifier = { anthropic: resolved };
      else warn(routerUnknownRectifierWarning(profile.name, rectName, "rectify"));
    } else if (profile.mode === "openai") {
      const resolved = resolveOpenAIRectifierByName(rectName);
      if (resolved) entry.rectifier = { openai: resolved };
      else warn(routerUnknownRectifierWarning(profile.name, rectName, "openai"));
    }
    // direct mode: no rectifier applies; silently skip
  }
  reg.set(strip1m(profile.model), entry);
  return reg;
}

function routerUnknownRectifierWarning(
  profileName: string,
  rectName: string,
  mode: Mode,
): string {
  return `profile "${profileName}": unknown rectifier "${rectName}" for mode ${mode} (ignored; check BUILTIN_PRESETS${mode === "openai" ? "_OPENAI" : ""} in src/preset-rules.ts)`;
}
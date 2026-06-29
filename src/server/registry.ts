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
import { strip1m } from "../core/model-1m.js";

export interface RouteEntry {
  /** trailing / stripped */
  endpoint: string;
  apiKey: string;
  mode: Mode;
  /** model id passed through to upstream (bare base name) */
  model: string;
  /** only mounted in rectify mode; undefined in direct / openai modes */
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
  // mount rectifier only in rectify mode; direct / openai skip it
  if (profile.mode === "rectify" && profile.rectifier) {
    entry.rectifier = profile.rectifier;
  }
  reg.set(strip1m(profile.model), entry);
  return reg;
}
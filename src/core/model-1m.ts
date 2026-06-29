// 1M context marker handling
//
// claude-code uses the `[1m]` suffix as an internal hint to enable the 1M context window
// (cache breakpoints / max_tokens etc.). It's stripped before sending via
// `normalizeModelStringForAPI` (see claude-code src/utils/model/model.ts:710).
// So `[1m]` should only appear in the settings JSON written to claude-code,
// never passed to sidecar / upstream / doctor's raw test body.
//
// All pure functions here are idempotent and pass through empty strings / undefined.

/** Append or strip `[1m]` suffix (always outputs lowercase). Idempotent; empty passes through. */
export function apply1m(model: string, supports1m: boolean): string {
  if (!model) return model;
  const base = strip1m(model);
  return supports1m ? `${base}[1m]` : base;
}

/** Strip the `[1m]` suffix. Idempotent; empty passes through. Dual to apply1m. */
export function strip1m(model: string): string {
  if (!model) return model;
  return model.replace(/\[1[Mm]\]$/, "");
}

/**
 * For show / ls display: when has1m=true, return "name [1m]", otherwise return model unchanged.
 * Accepts an optional dim callback to wrap the marker (recommended: pass `pc.dim`, respects NO_COLOR);
 * without dim, marker is plain text (for unit tests and pipe scenarios).
 */
export function formatModelWith1m(
  model: string,
  has1m: boolean | undefined,
  dimFn?: (s: string) => string,
): string {
  if (!model) return model;
  if (!has1m) return model;
  const marker = dimFn ? dimFn("[1m]") : "[1m]";
  return `${model} ${marker}`;
}

/** Find an entry by id in a generic { id }[] list; returns undefined when missing. */
export function findModelInfo<T extends { id: string }>(models: T[], id: string): T | undefined {
  return models.find((m) => m.id === id);
}
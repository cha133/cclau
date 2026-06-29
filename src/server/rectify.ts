// Rectifier: v0 interface stub + applyRectifier pipeline
// Anthropic-only rectification (primary goal: make non-standard anthropic endpoints like opencode-go work).
// OpenAI rectification cut for YAGNI.

import type {
  AnthropicRectifier,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent,
  Rectifier,
} from "../types.js";

export const NO_OP_RECTIFIER: Rectifier = {};

export type RectifierPhase = "anthropic-in" | "anthropic-out";

export interface RectifierContext {
  phase: RectifierPhase;
  payload: unknown;
}

/**
 * Rectification pipeline (v0: 2 injection points)
 * - anthropic-in:  claude code → cclau → upstream
 * - anthropic-out: upstream → cclau → claude code
 */
export function applyRectifier(rect: Rectifier, ctx: RectifierContext): unknown {
  const a = rect.anthropic;
  if (!a) return ctx.payload;

  let payload = ctx.payload;

  if (ctx.phase === "anthropic-in" && a.requestTransform) {
    payload = a.requestTransform(payload as AnthropicRequest);
  }
  if (ctx.phase === "anthropic-out" && a.responseTransform) {
    payload = a.responseTransform(payload as AnthropicResponse);
  }

  return payload;
}

/**
 * Apply rectifier per-chunk in streaming scenarios.
 * Anthropic SSE event array → processed SSE event array.
 */
export function applyStreamRectifier(
  rect: Rectifier,
  events: AnthropicStreamEvent[],
): AnthropicStreamEvent[] {
  const fn = rect.anthropic?.streamChunkTransform;
  if (!fn) return events;
  return events.map(fn);
}

// Type guard helper
export function isAnthropicRectifier(x: unknown): x is AnthropicRectifier {
  return !!x && typeof x === "object";
}
// Rectifier: v0 interface stub + applyRectifier pipeline
// Anthropic-only rectification (primary goal: make non-standard anthropic endpoints like opencode-go work).
// OpenAI rectification cut for YAGNI.

import type {
  AnthropicRectifier,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  Rectifier,
} from "../types.js";

export const NO_OP_RECTIFIER: Rectifier = {};

export type RectifierPhase = "anthropic-in" | "anthropic-out" | "openai-in" | "openai-out";

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
  if (a) {
    let payload = ctx.payload;
    if (ctx.phase === "anthropic-in" && a.requestTransform) {
      payload = a.requestTransform(payload as AnthropicRequest);
    }
    if (ctx.phase === "anthropic-out" && a.responseTransform) {
      payload = a.responseTransform(payload as AnthropicResponse);
    }
    return payload;
  }

  const o = rect.openai;
  if (o) {
    let payload = ctx.payload;
    if (ctx.phase === "openai-in" && o.requestTransform) {
      payload = o.requestTransform(payload as OpenAIRequest);
    }
    if (ctx.phase === "openai-out" && o.responseTransform) {
      payload = o.responseTransform(payload as OpenAIResponse);
    }
    return payload;
  }

  return ctx.payload;
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

/**
 * Apply openai rectifier per-chunk in streaming scenarios.
 * OpenAI chat-completion chunk array → processed chunk array. Used in the
 * convert path (openai upstream). Unknown shape / no rectifier → identity.
 */
export function applyOpenAIStreamRectifier(
  rect: Rectifier,
  chunks: OpenAIStreamChunk[],
): OpenAIStreamChunk[] {
  const fn = rect.openai?.streamChunkTransform;
  if (!fn) return chunks;
  return chunks.map(fn);
}

// Type guard helper
export function isAnthropicRectifier(x: unknown): x is AnthropicRectifier {
  return !!x && typeof x === "object";
}
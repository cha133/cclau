// 整流器：v0 接口预留 + applyRectifier 管道
// 只做 anthropic 整流（首要目的是让 opencode go 这类非标 anthropic 端点能跑通）
// openai 整流 YAGNI 砍掉

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
 * 整流管道（v0：2 个注入点）
 * - anthropic-in:  claude code → cclau → 上游前
 * - anthropic-out: 上游 → cclau → claude code 前
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
 * 流式场景下逐 chunk 应用整流器
 * anthropic SSE 事件数组 → 处理后的 SSE 事件数组
 */
export function applyStreamRectifier(
  rect: Rectifier,
  events: AnthropicStreamEvent[],
): AnthropicStreamEvent[] {
  const fn = rect.anthropic?.streamChunkTransform;
  if (!fn) return events;
  return events.map(fn);
}

// 类型守卫辅助
export function isAnthropicRectifier(x: unknown): x is AnthropicRectifier {
  return !!x && typeof x === "object";
}
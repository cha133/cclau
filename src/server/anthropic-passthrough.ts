// Anthropic Messages → Anthropic Messages 透传 + 整流
// 用于 rectify 模式：upstream 是 anthropic 协议

import type { AnthropicRequest, AnthropicResponse, AnthropicStreamEvent, Rectifier } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { applyRectifier, applyStreamRectifier } from "./rectify.js";
import { resolvePresetHeaders } from "../preset-rules.js";

interface UpstreamCtx {
  endpoint: string;
  apiKey: string;
}

/**
 * 直传 anthropic 请求到上游，返回响应（非流式）
 */
export async function passthroughUnary(
  rect: Rectifier,
  req: AnthropicRequest,
  ctx: UpstreamCtx,
): Promise<AnthropicResponse> {
  // anthropic-in 整流
  const transformed = applyRectifier(rect, {
    phase: "anthropic-in",
    payload: req,
  }) as AnthropicRequest;

  // 透传到上游
  const presetHeaders = resolvePresetHeaders(rect.anthropic, ctx.apiKey);
  const upstreamRes = await fetch(buildUpstreamUrl(ctx.endpoint, "anthropic"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ctx.apiKey,
      "anthropic-version": "2023-06-01",
      ...presetHeaders,
    },
    body: JSON.stringify({ ...transformed, stream: false }),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  const upstreamBody = (await upstreamRes.json()) as AnthropicResponse;

  // anthropic-out 整流
  const outTransformed = applyRectifier(rect, {
    phase: "anthropic-out",
    payload: upstreamBody,
  }) as AnthropicResponse;

  return outTransformed;
}

/**
 * 透传并流式返回 anthropic SSE 事件
 */
export async function* passthroughStream(
  rect: Rectifier,
  req: AnthropicRequest,
  ctx: UpstreamCtx,
): AsyncGenerator<AnthropicStreamEvent, void, void> {
  const transformed = applyRectifier(rect, {
    phase: "anthropic-in",
    payload: req,
  }) as AnthropicRequest;

  const presetHeaders = resolvePresetHeaders(rect.anthropic, ctx.apiKey);
  const upstreamRes = await fetch(buildUpstreamUrl(ctx.endpoint, "anthropic"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ctx.apiKey,
      "anthropic-version": "2023-06-01",
      ...presetHeaders,
    },
    body: JSON.stringify({ ...transformed, stream: true }),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  if (!upstreamRes.body) {
    throw new UpstreamError(500, "upstream returned no body");
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 解析：按 \n\n 切 event
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = block.split("\n");
        const dataLines: string[] = [];
        for (const line of lines) {
          // 只取 data 行；event: 头忽略（Anthropic SSE 的 event 名跟 data.type 一致，
          // data.type 是真实事件类型，event: 头是历史遗留）
          if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length === 0) continue;

        try {
          const data = JSON.parse(dataLines.join("\n")) as AnthropicStreamEvent;
          // v1：调 streamChunkTransform（之前 v0 漏调）
          const events = applyStreamRectifier(rect, [data]);
          yield (events[0] ?? data) as AnthropicStreamEvent;
        } catch (err) {
          // 解析失败的 chunk 跳过（keep-alive 或 ping）
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class UpstreamError extends Error {
  constructor(public status: number, public body: string) {
    super(`upstream ${status}: ${body.slice(0, 200)}`);
    this.name = "UpstreamError";
  }
}
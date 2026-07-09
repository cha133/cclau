// Anthropic Messages → Anthropic Messages passthrough + rectifier
// Used by rectify mode: upstream speaks anthropic protocol

import type { AnthropicRequest, AnthropicResponse, AnthropicStreamEvent, Rectifier } from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { applyRectifier, applyStreamRectifier } from "./rectify.js";
import { resolvePresetHeaders } from "../preset-rules.js";
import { getDebugLogger } from "./debug.js";

interface UpstreamCtx {
  endpoint: string;
  apiKey: string;
}

/**
 * Forward an anthropic request to upstream and return the response (non-streaming).
 */
export async function passthroughUnary(
  rect: Rectifier,
  req: AnthropicRequest,
  ctx: UpstreamCtx,
): Promise<AnthropicResponse> {
  // anthropic-in rectification
  const transformed = applyRectifier(rect, {
    phase: "anthropic-in",
    payload: req,
  }) as AnthropicRequest;

  // forward to upstream
  const presetHeaders = resolvePresetHeaders(rect.anthropic, ctx.apiKey);
  const upstreamUrl = buildUpstreamUrl(ctx.endpoint, "anthropic");
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ctx.apiKey,
    "anthropic-version": "2023-06-01",
    ...presetHeaders,
  };
  const reqBody = { ...transformed, stream: false };
  getDebugLogger().logOut(upstreamUrl, reqHeaders, reqBody);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  const upstreamBody = (await upstreamRes.json()) as AnthropicResponse;

  // anthropic-out rectification
  const outTransformed = applyRectifier(rect, {
    phase: "anthropic-out",
    payload: upstreamBody,
  }) as AnthropicResponse;

  return outTransformed;
}

/**
 * Forward and stream anthropic SSE events.
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
  const upstreamUrl = buildUpstreamUrl(ctx.endpoint, "anthropic");
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": ctx.apiKey,
    "anthropic-version": "2023-06-01",
    ...presetHeaders,
  };
  const reqBody = { ...transformed, stream: true };
  getDebugLogger().logOut(upstreamUrl, reqHeaders, reqBody);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
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
  const log = getDebugLogger();
  let messageId = "upstream";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE parse: split on \n\n event boundaries
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = block.split("\n");
        const dataLines: string[] = [];
        for (const line of lines) {
          // only take data: lines; ignore event: headers (Anthropic SSE event names match data.type,
          // the event: header is legacy)
          if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length === 0) continue;

        try {
          const data = JSON.parse(dataLines.join("\n")) as AnthropicStreamEvent;
          // v1: actually call streamChunkTransform (v0 missed this)
          const events = applyStreamRectifier(rect, [data]);
          const out = (events[0] ?? data) as AnthropicStreamEvent;
          if (out.type === "message_start") {
            messageId = out.message.id;
          }
          log.logUpstreamAnthropic(messageId, out.type, out);
          yield out;
        } catch (err) {
          // skip parse failures (keep-alive or ping)
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

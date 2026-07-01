// cclau local sidecar HTTP server
// Routes by body.model → registry → entry.mode:
//   direct   → passthrough (no rectifier, pure forward)
//   rectify  → passthrough (mounts entry.rectifier)
//   openai   → openai-to-anthropic (uses entry.model as upstream model id)

import type { AnthropicRequest, AnthropicStreamEvent, Rectifier } from "../types.js";
import { passthroughStream, passthroughUnary, UpstreamError } from "./anthropic-passthrough.js";
import { handleConvert, handleConvertStream } from "./openai-to-anthropic.js";
import { info, error } from "../ui/format.js";
import type { Registry } from "./registry.js";
import { strip1m } from "../core/model-1m.js";
import { getDebugLogger } from "./debug.js";

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => void;
}

/**
 * Start the cclau sidecar server
 * @param registry model id → RouteEntry routing table (from buildRegistry)
 * @param port listening port (obtained via findFreePort)
 * @param debug when true, emit a `cclau server up: ...` status line. Off by
 *   default so launch is silent unless --cclau-debug is passed. The HTTP-traffic
 *   debug log (src/server/debug.ts) is gated separately by CCLAU_DEBUG.
 */
export function startServer(
  registry: Registry,
  port: number,
  debug = false,
): ServerHandle {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,

    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // health check
      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      // the one external endpoint
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        return handleMessages(req, registry);
      }

      return new Response("not found", { status: 404 });
    },
  });

  if (debug) {
    const routeHint =
      registry.size === 1
        ? `upstream=${[...registry.values()][0]!.endpoint}`
        : `upstream=${registry.size} endpoints`;
    info(
      `cclau server up: http://127.0.0.1:${server.port} (registry: ${registry.size} routes, ${routeHint})`,
    );
  }

  return {
    server,
    port: server.port!,
    stop: () => server.stop(true),
  };
}

async function handleMessages(req: Request, registry: Registry): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch (err) {
    return errorResponse(400, `invalid json: ${(err as Error).message}`);
  }

  // Single IN log for all dispatch paths (rectify passthrough / openai convert /
  // direct passthrough). Headers here are the inbound ones from claude-code.
  getDebugLogger().logIn(req.url, Object.fromEntries(req.headers), body);

  // claude-code's normalizeModelStringForAPI has stripped [1m]; registry key is strip1m(model).
  // Look up by key directly — body.model is either `model[1m]` or `model`, matches after strip.
  const key = strip1m(body.model);
  const entry = registry.get(key);
  if (!entry) {
    return errorResponse(
      400,
      `unknown model "${body.model}". sidecar registry knows: ${[...registry.keys()].join(", ")}`,
    );
  }

  const wantStream = body.stream === true;

  try {
    if (entry.mode === "openai") {
      // openai ↔ anthropic (convert mode). Mount entry.rectifier (which in
      // openai mode holds the openai-mode rule from BUILTIN_PRESETS_OPENAI,
      // e.g. opencode-go's drop-thinking-on-effort) so vendor quirks like
      // opencode-go's 400 on simultaneous thinking+reasoning_effort are
      // handled.
      const ctx = {
        endpoint: entry.endpoint,
        apiKey: entry.apiKey,
        model: entry.model,
        rect: entry.rectifier,
      };
      if (wantStream) {
        return streamAnthropicSse(handleConvertStream(body, ctx));
      }
      const resp = await handleConvert(body, ctx);
      return Response.json(resp);
    }

    // direct / rectify → anthropic passthrough + (optional) rectifier
    // body.model matches entry.model (already stripped of [1m]), no override needed
    const ctx = { endpoint: entry.endpoint, apiKey: entry.apiKey };
    const rect: Rectifier = entry.rectifier ?? {};
    if (wantStream) {
      return streamAnthropicResponse(passthroughStream(rect, body, ctx));
    }
    const resp = await passthroughUnary(rect, body, ctx);
    return Response.json(resp);
  } catch (err) {
    if (err instanceof UpstreamError) {
      return errorResponse(err.status, err.body);
    }
    error(`handler error: ${(err as Error).message}`);
    return errorResponse(500, (err as Error).message);
  }
}

async function* passthroughStreamEvents(
  gen: AsyncGenerator<AnthropicStreamEvent, void, void>,
): AsyncGenerator<string, void, void> {
  for await (const ev of gen) {
    yield `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  }
}

function streamAnthropicResponse(
  gen: AsyncGenerator<AnthropicStreamEvent, void, void>,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const ev of passthroughStreamEvents(gen)) {
          controller.enqueue(encoder.encode(ev));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function streamAnthropicSse(gen: AsyncGenerator<string, void, void>): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const ev of gen) {
          controller.enqueue(encoder.encode(ev));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function errorResponse(status: number, msg: string): Response {
  return Response.json(
    { type: "error", error: { type: "api_error", message: msg } },
    { status },
  );
}
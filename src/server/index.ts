// cclau 本地 sidecar HTTP server
// 按 body.model 查 registry 路由 → 按 entry.mode 分发：
//   direct   → passthrough（rectifier 为空，纯透传）
//   rectify  → passthrough（挂 entry.rectifier）
//   openai   → openai-to-anthropic（用 entry.model 作为上游 model id）

import type { AnthropicRequest, AnthropicStreamEvent, Rectifier } from "../types.js";
import { passthroughStream, passthroughUnary, UpstreamError } from "./anthropic-passthrough.js";
import { handleConvert, handleConvertStream } from "./openai-to-anthropic.js";
import * as p from "@clack/prompts";
import type { Registry } from "./registry.js";
import { strip1m } from "../core/model-1m.js";

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => void;
}

/**
 * 启动 cclau sidecar server
 * @param registry model id → RouteEntry 的路由表（buildRegistry 产出）
 * @param port 监听端口（已通过 findFreePort 取得）
 */
export function startServer(registry: Registry, port: number): ServerHandle {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,

    async fetch(req): Promise<Response> {
      const url = new URL(req.url);

      // 健康检查
      if (url.pathname === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      // 唯一对外端点
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        return handleMessages(req, registry);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const routeHint =
    registry.size === 1
      ? `upstream=${[...registry.values()][0]!.endpoint}`
      : `upstream=${registry.size} endpoints`;

  p.log.info(
    `cclau server up: http://127.0.0.1:${server.port} (registry: ${registry.size} routes, ${routeHint})`,
  );

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

  // claude-code 内部 normalizeModelStringForAPI 已剥 [1m]，registry key 形如 strip1m(model)。
  // 直接按 key 查 —— body.model 是 `model[1m]` 或 `model`，strip 后命中。
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
      // openai ↔ anthropic（convert 模式）
      const ctx = { endpoint: entry.endpoint, apiKey: entry.apiKey, model: entry.model };
      if (wantStream) {
        return streamAnthropicSse(handleConvertStream(body, ctx));
      }
      const resp = await handleConvert(body, ctx);
      return Response.json(resp);
    }

    // direct / rectify → anthropic 透传 + （可选）整流
    // body.model 与 entry.model 同形（已 strip [1m]），无需 override
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
    p.log.error(`handler error: ${(err as Error).message}`);
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
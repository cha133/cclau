// cclau 本地 sidecar HTTP server
// 按 body.model 查 registry 路由 → 按 entry.mode 分发：
//   direct   → passthrough（rectifier 为空，纯透传）
//   rectify  → passthrough（挂 entry.rectifier）
//   convert  → openai-to-anthropic（用 entry.upstreamModel）
//
// v6：支持 alias —— handleMessages 先调 resolveAlias(body.model, config)；
//   命中 → 替换 body.model 为 ${provider}/${model}[1m] 形式再走 registry；
//   miss → 直接走 registry（literal 形式）。

import type { AnthropicRequest, AnthropicStreamEvent, Config, Rectifier } from "../types.js";
import { passthroughStream, passthroughUnary, UpstreamError } from "./anthropic-passthrough.js";
import { handleConvert, handleConvertStream } from "./openai-to-anthropic.js";
import { resolveAlias } from "../core/alias.js";
import * as p from "@clack/prompts";
import type { Registry } from "./registry.js";

export interface ServerHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  stop: () => void;
}

/**
 * 启动 cclau sidecar server
 * @param registry model id → RouteEntry 的路由表（buildRegistry 产出）
 * @param port 监听端口（已通过 findFreePort 取得）
 * @param config 用于 alias 解析（持引用，launch 启动时传入）
 */
export function startServer(registry: Registry, port: number, config: Config): ServerHandle {
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
        return handleMessages(req, registry, config);
      }

      return new Response("not found", { status: 404 });
    },
  });

  const providerNames = new Set<string>();
  for (const e of registry.values()) {
    // 路由目标 endpoint 作为日志 hint；多个 provider 时只取第一个
    providerNames.add(e.endpoint);
  }
  const routeHint =
    providerNames.size === 1
      ? `upstream=${[...providerNames][0]}`
      : `upstream=${providerNames.size} endpoints`;

  p.log.info(`cclau server up: http://127.0.0.1:${server.port} (registry: ${registry.size} routes, ${routeHint})`);

  return {
    server,
    port: server.port!,
    stop: () => server.stop(true),
  };
}

async function handleMessages(req: Request, registry: Registry, config: Config): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch (err) {
    return errorResponse(400, `invalid json: ${(err as Error).message}`);
  }

  // v6：alias 解析 —— body.model 是 alias 名时替换成 registry key 形式
  const resolvedKey = resolveRequestModelKey(body.model, config);
  const entry = registry.get(resolvedKey);
  if (!entry) {
    return errorResponse(
      400,
      `unknown model "${body.model}". sidecar registry knows: ${[...registry.keys()].join(", ")}`,
    );
  }

  const wantStream = body.stream === true;

  try {
    if (entry.mode === "convert") {
      // openai ↔ anthropic（convert 模式）
      // convert 模式自己从 ctx.model 取上游 id，body 里的 model 字段对它透明
      const ctx = { endpoint: entry.endpoint, apiKey: entry.apiKey, model: entry.upstreamModel };
      if (wantStream) {
        return streamAnthropicSse(handleConvertStream(body, ctx));
      }
      const resp = await handleConvert(body, ctx);
      return Response.json(resp);
    }

    // direct / rectify → anthropic 透传 + （可选）整流
    // sidecar 模式下 body.model 可能带 `${provider.name}/` 前缀（resolveProfile 加的），
    // 上游不认 —— 必须用 entry.upstreamModel（base name）覆盖后再转给上游。
    // 零 hop 不走 sidecar（不调 buildRegistry），但万一未来有 caller 走这条路径也是对的。
    const upstreamBody = { ...body, model: entry.upstreamModel };
    const ctx = { endpoint: entry.endpoint, apiKey: entry.apiKey };
    const rect: Rectifier = entry.rectifier ?? {};
    if (wantStream) {
      return streamAnthropicResponse(passthroughStream(rect, upstreamBody, ctx));
    }
    const resp = await passthroughUnary(rect, upstreamBody, ctx);
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

/**
 * v6：把 body.model 解析成 registry key
 *
 * - alias 命中 → 拼成 `${provider.name}/${model}` 形式（与 registry key strip1m 后对齐）
 * - alias miss / literal "provider/model" → 原样返回
 * - alias 解析抛错（unbound 等） → 返回原值让 registry miss 报 400（统一错误路径）
 */
function resolveRequestModelKey(rawModel: string, config: Config): string {
  if (config.aliases[rawModel] === undefined) return rawModel;
  try {
    const resolved = resolveAlias(rawModel, config);
    if (!resolved) return rawModel;
    return `${resolved.provider.name}/${resolved.modelId}`;
  } catch {
    return rawModel;
  }
}
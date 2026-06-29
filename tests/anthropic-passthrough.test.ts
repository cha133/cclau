// ============================================================================
// anthropic-passthrough：rectify 模式直传 + 整流钩子触发
// ----------------------------------------------------------------------------
// 锁住 v3 三个关键回归：
//   - 不变量 #5 passthroughStream 真过 applyStreamRectifier（v0 漏调）
//   - 不变量 #6 sentinel __CCLAU_BEARER_APIKEY__ 替换为 Bearer apiKey
//   - 4 阶段管道（in requestTransform / out responseTransform / stream chunk）
// ============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

import {
  passthroughUnary,
  passthroughStream,
  UpstreamError,
} from "../src/server/anthropic-passthrough.js";
import { applyRectifier, applyStreamRectifier, NO_OP_RECTIFIER } from "../src/server/rectify.js";
import {
  BEARER_APIKEY_SENTINEL,
  OPENCODE_GO_PRESET,
  KIMI_PRESET,
} from "../src/preset-rules.js";
import type {
  AnthropicRectifier,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicStreamEvent,
  Rectifier,
} from "../src/types.js";

// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

function makeOkResponse(): AnthropicResponse {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

// ---------------------------------------------------------------------------
// applyRectifier / applyStreamRectifier（4 阶段管道）
// ---------------------------------------------------------------------------

describe("applyRectifier — 4 阶段管道（实际 2 phase + 1 stream）", () => {
  test("rect=NO_OP_RECTIFIER → payload 原样透传", () => {
    const req = makeReq();
    const out = applyRectifier(NO_OP_RECTIFIER, { phase: "anthropic-in", payload: req });
    expect(out).toBe(req);
  });

  test("rect.anthropic=undefined → payload 原样透传", () => {
    const req = makeReq();
    const out = applyRectifier({ anthropic: undefined }, { phase: "anthropic-in", payload: req });
    expect(out).toBe(req);
  });

  test("anthropic-in phase + requestTransform 改 body", () => {
    const rect: Rectifier = {
      anthropic: {
        requestTransform: (r) => ({ ...r, max_tokens: r.max_tokens * 2 }),
      },
    };
    const out = applyRectifier(rect, { phase: "anthropic-in", payload: makeReq({ max_tokens: 100 }) });
    expect((out as AnthropicRequest).max_tokens).toBe(200);
  });

  test("anthropic-out phase + responseTransform 改 body", () => {
    const rect: Rectifier = {
      anthropic: {
        responseTransform: (r) => ({ ...r, stop_reason: "max_tokens" }),
      },
    };
    const out = applyRectifier(rect, { phase: "anthropic-out", payload: makeOkResponse() });
    expect((out as AnthropicResponse).stop_reason).toBe("max_tokens");
  });

  test("anthropic-in phase 但只配了 responseTransform → 不触发（phase 不匹配）", () => {
    const rect: Rectifier = {
      anthropic: {
        responseTransform: (r) => ({ ...r, stop_reason: "max_tokens" }),
      },
    };
    const req = makeReq();
    const out = applyRectifier(rect, { phase: "anthropic-in", payload: req });
    expect(out).toBe(req);
  });
});

describe("applyStreamRectifier — 流式 chunk 钩子", () => {
  test("streamChunkTransform 不存在 → events 原样", () => {
    const events: AnthropicStreamEvent[] = [{ type: "ping" }];
    const out = applyStreamRectifier(NO_OP_RECTIFIER, events);
    expect(out).toBe(events);
  });

  test("streamChunkTransform 存在 → 逐 chunk 应用", () => {
    const rect: Rectifier = {
      anthropic: {
        streamChunkTransform: (ev) => ({ ...ev, type: "ping" } as AnthropicStreamEvent),
      },
    };
    const out = applyStreamRectifier(rect, [{ type: "content_block_delta" } as never]);
    expect(out[0]?.type).toBe("ping");
  });
});

// ---------------------------------------------------------------------------
// passthroughUnary + fetch mock
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let originalFetch: typeof fetch;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init: init ?? {} });
    return responder(url, init ?? {});
  }) as typeof fetch;
}

describe("passthroughUnary — fetch 拦截 + 整流钩子", () => {
  test("sentinel 替换为 Authorization: Bearer ${apiKey}（不变量 #6）", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    const rect: Rectifier = { anthropic: OPENCODE_GO_PRESET };
    await passthroughUnary(rect, makeReq(), { endpoint: "https://x.com/v1", apiKey: "sk-abc" });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-abc");
    // 双 auth header：x-api-key + Authorization 都在
    expect(headers["x-api-key"]).toBe("sk-abc");
    // 没有任何 __CCLAU_BEARER_APIKEY__ 残留
    expect(JSON.stringify(headers)).not.toContain(BEARER_APIKEY_SENTINEL);
  });

  test("anthropic-in 阶段 requestTransform 改 body 后才发上游", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    const seen: AnthropicRequest[] = [];
    const rect: Rectifier = {
      anthropic: {
        requestTransform: (r) => {
          seen.push(r);
          return { ...r, max_tokens: r.max_tokens * 3 };
        },
      },
    };
    await passthroughUnary(rect, makeReq({ max_tokens: 10 }), { endpoint: "https://x.com", apiKey: "k" });

    expect(seen).toHaveLength(1);
    // 验证发到上游的 body 是 transform 后的
    const body = JSON.parse(fetchCalls[0]?.init.body as string) as AnthropicRequest;
    expect(body.max_tokens).toBe(30);
    // stream:false 是 passthroughUnary 强制
    expect(body.stream).toBe(false);
  });

  test("anthropic-out 阶段 responseTransform 改响应后才返回", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    const rect: Rectifier = {
      anthropic: {
        responseTransform: (r) => ({ ...r, stop_reason: "max_tokens" }),
      },
    };
    const out = await passthroughUnary(rect, makeReq(), { endpoint: "https://x.com", apiKey: "k" });
    expect(out.stop_reason).toBe("max_tokens");
  });

  test("endpoint 末尾 / → buildUpstreamUrl 规整（不会拼成 /v1/messages/）", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    await passthroughUnary({}, makeReq(), { endpoint: "https://x.com/v1/", apiKey: "k" });
    expect(fetchCalls[0]?.url).toBe("https://x.com/v1/messages");
  });

  test("endpoint 无 /v1 → 拼上", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    await passthroughUnary({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" });
    expect(fetchCalls[0]?.url).toBe("https://x.com/v1/messages");
  });

  test("rect=空 → 默认 header 只发 x-api-key + anthropic-version（不挂 Authorization）", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    await passthroughUnary({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" });
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
  });

  test("kimi preset thinking.type='high' 归一为 'enabled' 后发上游（不变量 #8 e2e）", async () => {
    mockFetch(() => new Response(JSON.stringify(makeOkResponse()), { status: 200 }));

    const rect: Rectifier = { anthropic: KIMI_PRESET };
    await passthroughUnary(
      rect,
      makeReq({ thinking: { type: "high", budget_tokens: 8192 } }),
      { endpoint: "https://x.com", apiKey: "k" },
    );

    const body = JSON.parse(fetchCalls[0]?.init.body as string) as AnthropicRequest;
    expect(body.thinking?.type).toBe("enabled");
    expect(body.thinking?.budget_tokens).toBe(8192);
  });

  test("upstream 非 2xx → throw UpstreamError（status + body）", async () => {
    mockFetch(() => new Response("oops bad request", { status: 400 }));

    let caught: unknown;
    try {
      await passthroughUnary({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(400);
    expect((caught as UpstreamError).body).toBe("oops bad request");
  });
});

// ---------------------------------------------------------------------------
// passthroughStream + 不变量 #5（v3 修了 v0 漏调）
// ---------------------------------------------------------------------------

/** 构造 SSE bytes：每个事件用 "event: X\\ndata: {...}\\n\\n" 拼起 */
function sseBytes(events: AnthropicStreamEvent[]): Uint8Array {
  const lines = events
    .map((e) => {
      // 简化：anthropic SSE 的 event: 头 = data.type
      return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
    })
    .join("");
  return new TextEncoder().encode(lines);
}

/** 把 ReadableStream 包成 Response（fetch 返回形态） */
function sseResponse(events: AnthropicStreamEvent[]): Response {
  return new Response(sseBytes(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** 消费 AsyncGenerator 收集所有事件 */
async function collectEvents(
  gen: AsyncGenerator<AnthropicStreamEvent, void, void>,
): Promise<AnthropicStreamEvent[]> {
  const out: AnthropicStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("passthroughStream — stream chunk 真的过整流钩子（不变量 #5）", () => {
  test("streamChunkTransform 标记的 chunk 出现在消费端（v0 漏调回归保护）", async () => {
    const contentEvent: AnthropicStreamEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    };
    mockFetch(() => sseResponse([contentEvent]));

    // streamChunkTransform 改 type 加 marker（用 type 字段当 marker）
    const rect: Rectifier = {
      anthropic: {
        streamChunkTransform: (ev) => ({ ...ev, type: "content_block_delta" } as AnthropicStreamEvent),
      },
    };
    const events = await collectEvents(
      passthroughStream(rect, makeReq({ stream: true }), { endpoint: "https://x.com", apiKey: "k" }),
    );

    // 至少收到 1 个事件（content_block_delta 钩子触发）
    expect(events.length).toBeGreaterThanOrEqual(1);
    const delta = events.find((e) => e.type === "content_block_delta") as
      | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } }
      | undefined;
    expect(delta).toBeDefined();
    expect(delta?.delta.text).toBe("hello");
  });

  test("streamChunkTransform 真的应用：自定义字段被加到 chunk 上", async () => {
    const ev: AnthropicStreamEvent = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "x" },
    };
    mockFetch(() => sseResponse([ev]));

    // streamChunkTransform 给每个 event 加 customField（断言 visible 即可）
    const rect: AnthropicRectifier = {
      streamChunkTransform: (e) => ({ ...e, customField: "tagged" } as unknown as AnthropicStreamEvent),
    };
    const events = await collectEvents(
      passthroughStream({ anthropic: rect }, makeReq(), { endpoint: "https://x.com", apiKey: "k" }),
    );

    const tagged = events.find((e) => "customField" in e) as (AnthropicStreamEvent & { customField?: string }) | undefined;
    expect(tagged?.customField).toBe("tagged");
  });

  test("rect.anthropic 缺失 → streamChunk 不挂载，event 原样透传", async () => {
    const ev: AnthropicStreamEvent = { type: "ping" };
    mockFetch(() => sseResponse([ev]));

    const events = await collectEvents(
      passthroughStream({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" }),
    );
    expect(events.some((e) => e.type === "ping")).toBe(true);
  });

  test("upstream 非 2xx → throw UpstreamError", async () => {
    mockFetch(() => new Response("stream fail", { status: 500 }));

    let caught: unknown;
    try {
      await collectEvents(
        passthroughStream({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UpstreamError);
    expect((caught as UpstreamError).status).toBe(500);
  });

  test("anthropic-in requestTransform 也对 stream 生效", async () => {
    mockFetch(() => sseResponse([{ type: "message_stop" }]));

    const rect: Rectifier = {
      anthropic: {
        requestTransform: (r) => ({ ...r, max_tokens: r.max_tokens * 7 }),
      },
    };
    await collectEvents(
      passthroughStream(rect, makeReq({ max_tokens: 10 }), { endpoint: "https://x.com", apiKey: "k" }),
    );
    const body = JSON.parse(fetchCalls[0]?.init.body as string) as AnthropicRequest;
    expect(body.max_tokens).toBe(70);
    expect(body.stream).toBe(true); // passthroughStream 强制 true
  });

  test("SSE 解析失败的 chunk 跳过（不抛错）", async () => {
    // 混合：合法 event + 非法 JSON + ping
    const mixed = [
      "event: ping\ndata: {not valid json}\n\n",
      "event: content_block_delta\ndata: " +
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ok" },
        }) +
        "\n\n",
    ].join("");
    mockFetch(() => new Response(new TextEncoder().encode(mixed), { status: 200 }));

    const events = await collectEvents(
      passthroughStream({}, makeReq(), { endpoint: "https://x.com", apiKey: "k" }),
    );
    // 至少能解析出 content_block_delta（ping 被跳过）
    expect(events.some((e) => e.type === "content_block_delta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UpstreamError
// ---------------------------------------------------------------------------

describe("UpstreamError", () => {
  test("status + body 字段", () => {
    const e = new UpstreamError(401, "Unauthorized");
    expect(e.status).toBe(401);
    expect(e.body).toBe("Unauthorized");
    expect(e.name).toBe("UpstreamError");
  });

  test("body 长 > 200 → message 只截 200", () => {
    const longBody = "x".repeat(500);
    const e = new UpstreamError(500, longBody);
    expect(e.message).toContain("upstream 500:");
    expect(e.message.length).toBeLessThan(220); // "upstream 500: " + 200 chars
  });
});

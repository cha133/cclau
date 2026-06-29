// ============================================================================
// e2e: 单 profile → sidecar 路由（rectify 模式）
// ----------------------------------------------------------------------------
// refactor 之后：单 profile 概念，registry 只 1 条 entry。
//   - sidecar 收到 body.model = "claude-sonnet-4-6"（claude-code 已剥 [1m]）
//   - registry key = strip1m(model) = "claude-sonnet-4-6"
//   - 命中 entry → 转给上游，body.model 不变（无 provider/ 前缀）
//
// 仍测试 unknown model / unknown path / JSON 解析失败的错误路径。
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resolveLaunch } from "../../src/settings.js";
import { buildRegistry } from "../../src/server/registry.js";
import { startServer } from "../../src/server/index.js";
import { findFreePort } from "../../src/port.js";
import type { AnthropicResponse, Profile } from "../../src/types.js";

// ---------------------------------------------------------------------------
// fake upstream：1 个，记录 body.model + 关键 header
// ---------------------------------------------------------------------------

interface FakeUpstream {
  port: number;
  received: Array<{ model: string; hasAuth: boolean; hasApiKey: boolean }>;
  stop: () => void;
}

async function startFakeUpstream(port: number): Promise<FakeUpstream> {
  const received: FakeUpstream["received"] = [];
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const body = (await req.json()) as { model: string };
        received.push({
          model: body.model,
          hasAuth: !!req.headers.get("authorization"),
          hasApiKey: !!req.headers.get("x-api-key"),
        });
        const resp: AnthropicResponse = {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "fake-response" }],
          model: body.model,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        return Response.json(resp);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port!,
    received,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------

let fake: FakeUpstream;
let sidecar: ReturnType<typeof startServer> | undefined;

const PROFILE: Profile = {
  name: "single",
  endpoint: `http://127.0.0.1:0/v1`, // 后面覆盖
  apiKey: "sk-fake",
  mode: "rectify",
  model: "claude-sonnet-4-6",
  supports1m: false,
  createdAt: 0,
  updatedAt: 0,
};

beforeAll(async () => {
  fake = await startFakeUpstream(19100);

  // 指向 fake upstream 的真实 port
  const profile: Profile = {
    ...PROFILE,
    endpoint: `http://127.0.0.1:${fake.port}/v1`,
  };

  // resolveLaunch 走通（必填字段都齐）
  const launch = resolveLaunch(profile);
  expect(launch.sidecar.needed).toBe(true);
  expect(launch.upstreamModel).toBe("claude-sonnet-4-6");
  expect(launch.settingsModel).toBe("claude-sonnet-4-6");

  const registry = buildRegistry(profile);
  expect(registry.size).toBe(1);
  expect(registry.has("claude-sonnet-4-6")).toBe(true);

  const sidecarPort = await findFreePort(3133);
  sidecar = startServer(registry, sidecarPort);
});

afterAll(() => {
  fake.stop();
  sidecar?.stop();
});

// ---------------------------------------------------------------------------

describe("sidecar e2e — 单 profile 路由", () => {
  test("/healthz 返回 200 ok", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("body.model=claude-sonnet-4-6 → 路由到上游（无前缀无 [1m]）", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnthropicResponse;
    const text = (body.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("fake-response");
  });

  test("不变量：上游收到的 body.model 是裸 base name（与 entry.model 一致）", () => {
    expect(fake.received).toHaveLength(1);
    const got = fake.received[0]!;
    expect(got.model).toBe("claude-sonnet-4-6");
    expect(got.model).not.toContain("/");
    expect(got.model.endsWith("[1m]")).toBe(false);
  });

  test("x-api-key header 透传给上游", () => {
    expect(fake.received[0]!.hasApiKey).toBe(true);
  });

  test("body.model 未注册 → 400 错误", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ghost-unknown-model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.message).toContain("unknown model");
  });

  test("未知路径 → 404", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/no-such-path`);
    expect(res.status).toBe(404);
  });

  test("JSON 解析失败 → 400", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
  });
});
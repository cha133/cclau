// ============================================================================
// e2e: 跨 provider 同 model id 路由（v5-2 BOARD Next 段）
// ----------------------------------------------------------------------------
// 锁住 v5 不变量 #3 + #4 端到端：
//   - 3 tier 全部用 model id `claude-sonnet-4-6`，3 个不同 provider
//   - 3 个 fake upstream（独立 127.0.0.1 端口）各记一次收到的 body.model
//   - sidecar 收到 body.model = "kimi/claude-sonnet-4-6" 形式
//   - handleMessages 用 entry.upstreamModel 覆盖后转上游
//   - 断言：上游收到的是 "claude-sonnet-4-6"（base name，无前缀无 [1m]）
//
// 不需要真 upstream key；YAGNI：不验 SSE 401/400（那需要真 upstream）
// ============================================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { resolveProfile } from "../../src/settings.js";
import { buildRegistry, type RegistryTier } from "../../src/server/registry.js";
import { startServer } from "../../src/server/index.js";
import { findFreePort } from "../../src/port.js";
import type { AnthropicResponse, Config, Profile, StoredSubscription } from "../../src/types.js";

// ---------------------------------------------------------------------------
// fake upstream：每个 provider 一个，记录 body.model + 返最小合法 AnthropicResponse
// ---------------------------------------------------------------------------

interface FakeUpstream {
  name: string;
  port: number;
  received: Array<{ model: string; hasAuth: boolean; hasApiKey: boolean }>;
  stop: () => void;
}

async function startFakeUpstream(name: string, port: number): Promise<FakeUpstream> {
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
          id: `msg_fake_${name}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `fake-response-from-${name}` }],
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
    name,
    port: server.port!,
    received,
    stop: () => server.stop(true),
  };
}

// ---------------------------------------------------------------------------
// 测试主流程
// ---------------------------------------------------------------------------

const FAKES: FakeUpstream[] = [];
let sidecar: ReturnType<typeof startServer> | undefined;

beforeAll(async () => {
  // 起 3 个 fake upstream（独立 127.0.0.1 端口，互不干扰）
  // 注：19100/19200/19300 是测试独占端口，跟 src/port.ts 3133+ 不冲突
  const kimi = await startFakeUpstream("kimi", 19100);
  const foo = await startFakeUpstream("foo", 19200);
  const bar = await startFakeUpstream("bar", 19300);
  FAKES.push(kimi, foo, bar);

  // 构造 Config：3 个 provider 各自指向一个 fake upstream
  const byName = (n: string) => FAKES.find((f) => f.name === n)!;
  const cfg: Config = {
    providers: {
      kimi: storedSub("kimi", byName("kimi").port),
      foo: storedSub("foo", byName("foo").port),
      bar: storedSub("bar", byName("bar").port),
    },
    profiles: {},
    aliases: {},
  };

  // 3 tier 全部用 claude-sonnet-4-6，但 provider 不同 → 触发 sidecar + provider/ 前缀
  const profile: Profile = {
    name: "cross-provider",
    opus: { provider: "kimi", model: "claude-sonnet-4-6" },
    sonnet: { provider: "foo", model: "claude-sonnet-4-6" },
    haiku: { provider: "bar", model: "claude-sonnet-4-6" },
    createdAt: 0,
    updatedAt: 0,
  };

  // resolveProfile → 3 tier 各自带 ${provider.name}/${model} 前缀（sidecar 模式）
  const resolved = resolveProfile(profile, cfg);
  expect(resolved.sidecar.needed).toBe(true);
  expect(resolved.sidecar.reason).toBe("3 个 provider");

  // buildRegistry 需要的 RegistryTier[] 形态
  const registryTiers: RegistryTier[] = resolved.tiers.map((t) => ({
    tier: t.tier,
    model: t.model, // resolveProfile 输出 = ${provider}/${base}[1m]（sidecar 模式）
    upstreamModel: t.upstreamModel, // = base name（无前缀无 [1m]）
    provider: t.provider,
  }));

  const registry = buildRegistry(registryTiers);
  // 3 个 key：kimi/claude-sonnet-4-6 / foo/claude-sonnet-4-6 / bar/claude-sonnet-4-6
  expect(registry.size).toBe(3);

  // 起 sidecar
  const sidecarPort = await findFreePort(3133);
  sidecar = startServer(registry, sidecarPort, cfg);
});

afterAll(() => {
  for (const f of FAKES) f.stop();
  sidecar?.stop();
});

// ---------------------------------------------------------------------------

function storedSub(name: string, fakePort: number): StoredSubscription {
  return {
    endpoint: `http://127.0.0.1:${fakePort}/v1`,
    apiKey: `sk-fake-${name}`,
    type: "anthropic",
    mode: "direct",
    models: [{ id: "claude-sonnet-4-6", supports_1m: false }],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("sidecar e2e — 跨 provider 同 model id 路由（v5-2）", () => {
  test("/healthz 返回 200 ok", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("body.model=kimi/claude-sonnet-4-6 → 路由到 kimi upstream", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "kimi/claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnthropicResponse;
    expect(body.content[0]?.type).toBe("text");
    // 响应 text 含 provider name（来自 fake upstream）
    const text = (body.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("fake-response-from-kimi");
  });

  test("body.model=foo/claude-sonnet-4-6 → 路由到 foo upstream", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "foo/claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnthropicResponse;
    const text = (body.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("fake-response-from-foo");
  });

  test("body.model=bar/claude-sonnet-4-6 → 路由到 bar upstream", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "bar/claude-sonnet-4-6",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AnthropicResponse;
    const text = (body.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe("fake-response-from-bar");
  });

  test("不变量 #3：上游收到的 body.model 是 base name（无 provider/ 前缀无 [1m]）", () => {
    // 上面的 3 个 test 已经发了 3 个请求；断言每个 fake 收到恰好 1 次 + model 是 'claude-sonnet-4-6'
    for (const f of FAKES) {
      expect(f.received).toHaveLength(1);
      const got = f.received[0]!;
      // entry.upstreamModel 覆盖了 body.model
      expect(got.model).toBe("claude-sonnet-4-6");
      // 上游 header 含 x-api-key
      expect(got.hasApiKey).toBe(true);
    }
  });

  test("registry key 跨 provider 自然消歧（不变量 #4）", () => {
    // 3 个 fake 各自 1 次（无重复 key，无撞路由）
    const totalRequests = FAKES.reduce((sum, f) => sum + f.received.length, 0);
    expect(totalRequests).toBe(3);
  });

  test("body.model 未注册 → 400 错误（侧证 registry miss 路径）", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "ghost/unknown-model",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message).toContain("unknown model");
  });

  test("未知路径 → 404", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/no-such-path`);
    expect(res.status).toBe(404);
  });

  test("JSON 解析失败 → 400（错误路径覆盖）", async () => {
    if (!sidecar) throw new Error("sidecar not started");
    const res = await fetch(`http://127.0.0.1:${sidecar.port}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json",
    });
    expect(res.status).toBe(400);
  });
});

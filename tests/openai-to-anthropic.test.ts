// ============================================================================
// openai-to-anthropic：convert 模式的请求 / 响应 / 流式转换
// ----------------------------------------------------------------------------
// 锁住 convert 模式的双向协议转换 + finish_reason 映射 6 支 + 流式状态机
// （不变量：无；YAGNI 边界，但纯函数覆盖成本极低、回归价值高）
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  anthropicToOpenAI,
  openAIToAnthropic,
  convertOpenAIStreamToAnthropic,
} from "../src/server/openai-to-anthropic.js";
import type {
  AnthropicContentBlock,
  AnthropicRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
} from "../src/types.js";

// ---------------------------------------------------------------------------

function makeAnthropicReq(overrides: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

// ===========================================================================
// anthropicToOpenAI
// ===========================================================================

describe("anthropicToOpenAI — 基础", () => {
  test("透传 model/max_tokens/stream/temperature/top_p", () => {
    const req = makeAnthropicReq({
      stream: true,
      temperature: 0.5,
      top_p: 0.9,
    });
    const out = anthropicToOpenAI(req, "upstream-model");
    expect(out.model).toBe("upstream-model");
    expect(out.max_tokens).toBe(1024);
    expect(out.stream).toBe(true);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
  });

  test("upstreamModel 优先于 req.model", () => {
    const req = makeAnthropicReq();
    const out = anthropicToOpenAI(req, "real-upstream-name");
    expect(out.model).toBe("real-upstream-name");
  });
});

describe("anthropicToOpenAI — system 字段", () => {
  test("system string → messages[0].role=system", () => {
    const req = makeAnthropicReq({ system: "You are a helpful assistant." });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]).toEqual({ role: "system", content: "You are a helpful assistant." });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  test("system 数组（text 块）→ 拼成 system message", () => {
    const sysBlocks: AnthropicContentBlock[] = [
      { type: "text", text: "Part 1." },
      { type: "text", text: "Part 2." },
    ];
    const req = makeAnthropicReq({ system: sysBlocks });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]?.content).toBe("Part 1.\n\nPart 2.");
  });

  test("system 数组含非 text 块 → 跳过非 text", () => {
    const sysBlocks: AnthropicContentBlock[] = [
      { type: "text", text: "real text" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
    ];
    const req = makeAnthropicReq({ system: sysBlocks });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]?.content).toBe("real text");
  });

  test("system=undefined → 不加 system 消息", () => {
    const req = makeAnthropicReq();
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("system=空串 → 不加 system 消息", () => {
    const req = makeAnthropicReq({ system: "" });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});

describe("anthropicToOpenAI — messages 转换", () => {
  test("user 文本消息 → 直转", () => {
    const req = makeAnthropicReq({
      messages: [{ role: "user", content: "hello" }],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("assistant tool_use 块数组 → text + tool_calls", () => {
    const req = makeAnthropicReq({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "tu_1", name: "search", input: { q: "weather" } },
          ],
        },
      ],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]?.role).toBe("assistant");
    expect(out.messages[0]?.content).toBe("Let me check.");
    expect(out.messages[0]?.tool_calls).toEqual([
      {
        id: "tu_1",
        type: "function",
        function: { name: "search", arguments: '{"q":"weather"}' },
      },
    ]);
  });

  test("user tool_result 块数组 → role=tool 消息", () => {
    const req = makeAnthropicReq({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "sunny 25C" },
          ],
        },
      ],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "sunny 25C",
    });
  });

  test("tool_result content 是数组 → 拼成字符串", () => {
    const req = makeAnthropicReq({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                { type: "text", text: "line1" },
                { type: "text", text: "line2" },
              ],
            },
          ],
        },
      ],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]?.content).toBe("line1line2");
  });

  test("thinking 块在 messages 里 → 跳过（v0 行为）", () => {
    const req = makeAnthropicReq({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" } as never,
            { type: "text", text: "answer" },
          ],
        },
      ],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.messages[0]?.content).toBe("answer");
  });
});

describe("anthropicToOpenAI — tools + tool_choice", () => {
  test("tools 转 OpenAI format", () => {
    const req = makeAnthropicReq({
      tools: [
        { name: "search", description: "web search", input_schema: { type: "object" } },
      ],
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "web search",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  test("无 tools → out.tools undefined", () => {
    const req = makeAnthropicReq();
    const out = anthropicToOpenAI(req, "m");
    expect(out.tools).toBeUndefined();
  });

  test("tool_choice='auto' → out.tool_choice='auto'", () => {
    const req = makeAnthropicReq({ tool_choice: { type: "auto" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.tool_choice).toBe("auto");
  });

  test("tool_choice='any' → out.tool_choice='required'", () => {
    const req = makeAnthropicReq({ tool_choice: { type: "any" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.tool_choice).toBe("required");
  });

  test("tool_choice='tool' with name → out.tool_choice={type:'function',...}", () => {
    const req = makeAnthropicReq({ tool_choice: { type: "tool", name: "search" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.tool_choice).toEqual({ type: "function", function: { name: "search" } });
  });
});

// ===========================================================================
// openAIToAnthropic + mapFinishReason
// ===========================================================================

function makeOpenAIRes(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 1000,
    model: "upstream-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hi" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    ...overrides,
  };
}

describe("openAIToAnthropic — 响应转换", () => {
  test("text content → content[0]={type:'text',text}", () => {
    const res = makeOpenAIRes({
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    });
    const out = openAIToAnthropic(res, "claude-sonnet-4-6");
    expect(out.content).toEqual([{ type: "text", text: "hello" }]);
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.role).toBe("assistant");
    expect(out.type).toBe("message");
  });

  test("tool_calls → content[]=tool_use 块（arguments JSON.parse）", () => {
    const res = makeOpenAIRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search", arguments: '{"q":"weather"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const out = openAIToAnthropic(res, "claude-sonnet-4-6");
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "search", input: { q: "weather" } },
    ]);
  });

  test("tool_calls arguments 解析失败 → 留空对象（不阻断）", () => {
    const res = makeOpenAIRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search", arguments: "{invalid json" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "search", input: {} });
  });

  test("空 content + 空 tool_calls → content=[]", () => {
    const res = makeOpenAIRes({
      choices: [
        { index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" },
      ],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.content).toEqual([]);
  });

  test("choices 为空 → throw UpstreamError 502", () => {
    const res = makeOpenAIRes({ choices: [] });
    expect(() => openAIToAnthropic(res, "m")).toThrow(/no choices/);
  });

  test("usage 透传 input_tokens / output_tokens", () => {
    const res = makeOpenAIRes({
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  test("usage 缺失 → 兜底 0/0（不抛错）", () => {
    const res = makeOpenAIRes({ usage: undefined });
    const out = openAIToAnthropic(res, "m");
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("openAIToAnthropic — mapFinishReason 6 支（间接通过 finish_reason）", () => {
  const cases: Array<[OpenAIResponse["choices"][number]["finish_reason"], AnthropicRequest extends never ? never : NonNullable<AnthropicRequest["model"]>]> = [];
  void cases;

  test.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["content_filter", "refusal"],
    [null, null],
  ] as const)("finish_reason=%s → stop_reason=%s", (reason, expected) => {
    const res = makeOpenAIRes({
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: reason }],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.stop_reason).toBe(expected);
  });
});

// ===========================================================================
// convertOpenAIStreamToAnthropic — 流式状态机
// ===========================================================================

async function* arrayIter<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

function sseChunk(
  delta: OpenAIStreamChunk["choices"][number]["delta"],
  finishReason: OpenAIStreamChunk["choices"][number]["finish_reason"] = null,
): OpenAIStreamChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** 消费 AsyncGenerator 收集所有 SSE event 名 + 拼接 data 解析 */
async function collectSseEvents(gen: AsyncGenerator<string>): Promise<Array<{ event: string; data: unknown }>> {
  const out: Array<{ event: string; data: unknown }> = [];
  let buf = "";
  for await (const piece of gen) {
    buf += piece;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      let event = "";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (event && data) {
        try {
          out.push({ event, data: JSON.parse(data) });
        } catch {
          out.push({ event, data });
        }
      }
    }
  }
  return out;
}

describe("convertOpenAIStreamToAnthropic — 状态机", () => {
  test("text delta → content_block_start(text) + content_block_delta(text_delta)", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({ content: "hello" }),
      sseChunk({ content: " world" }, "stop"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "claude-sonnet-4-6"),
    );

    // 必有：message_start, ping, content_block_start(text), content_block_delta x2,
    //      content_block_stop, message_delta(stop), message_stop
    const names = events.map((e) => e.event);
    expect(names).toContain("message_start");
    expect(names).toContain("ping");
    expect(names).toContain("content_block_start");
    expect(names).toContain("content_block_stop");
    expect(names).toContain("message_delta");
    expect(names).toContain("message_stop");

    // text delta 2 次
    const textDeltas = events.filter((e) => e.event === "content_block_delta");
    expect(textDeltas).toHaveLength(2);

    // message_delta.stop_reason='end_turn' (mapFinishReason: stop → end_turn)
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("end_turn");
  });

  test("tool_call start + args 增量 → content_block_start(tool_use) + input_json_delta", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "" } },
        ],
      }),
      sseChunk({
        tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
      }),
      sseChunk({
        tool_calls: [{ index: 0, function: { arguments: '"x"}' } }],
      }, "tool_calls"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "m"),
    );

    const blockStarts = events.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(1);
    const toolStart = blockStarts[0]?.data as { content_block: { type: string; name: string } };
    expect(toolStart.content_block.type).toBe("tool_use");
    expect(toolStart.content_block.name).toBe("search");

    // input_json_delta 2 次
    const jsonDeltas = events.filter(
      (e) => e.event === "content_block_delta" &&
        (e.data as { delta: { type?: string } }).delta.type === "input_json_delta",
    );
    expect(jsonDeltas).toHaveLength(2);

    // finish: tool_calls → stop_reason='tool_use'
    const msgDelta = events.find((e) => e.event === "message_delta");
    expect((msgDelta?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
  });

  test("text → tool_use 切换 → 中间有 content_block_stop", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({ content: "hi" }),
      sseChunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      }, "tool_calls"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "m"),
    );

    // 至少 2 个 content_block_stop（text 关闭 + tool 关闭）
    const stops = events.filter((e) => e.event === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  test("空 stream（无 chunk）→ 仅 message_start + ping + message_stop", async () => {
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter([]), "m"),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual(["message_start", "ping", "message_stop"]);
  });

  test("message_start 中 model 字段 = requestedModel", async () => {
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter([]), "claude-sonnet-4-6"),
    );
    const start = events.find((e) => e.event === "message_start");
    expect((start?.data as { message: { model: string } }).message.model).toBe("claude-sonnet-4-6");
  });
});

// ===========================================================================
// thinking 透传 — 请求方向（anthropic → openai）
// ===========================================================================

describe("anthropicToOpenAI — output_config.effort → reasoning_effort", () => {
  test("effort='high' → out.reasoning_effort='high'", () => {
    const req = makeAnthropicReq({
      output_config: { effort: "high" },
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.reasoning_effort).toBe("high");
  });

  test("effort='max' → out.reasoning_effort='max'（GLM-5.2 专属深度控制）", () => {
    const req = makeAnthropicReq({ output_config: { effort: "max" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.reasoning_effort).toBe("max");
  });

  test("output_config 缺失 → out.reasoning_effort 不存在", () => {
    const req = makeAnthropicReq();
    const out = anthropicToOpenAI(req, "m");
    expect(out.reasoning_effort).toBeUndefined();
  });

  test("effort 空字符串 → out.reasoning_effort 不存在（claude-code 偶尔发 placeholder）", () => {
    const req = makeAnthropicReq({ output_config: { effort: " " } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.reasoning_effort).toBeUndefined();
  });

  test("effort + thinking 同时存在 → 两个都转（让 opencode-go preset 决定怎么取舍）", () => {
    const req = makeAnthropicReq({
      output_config: { effort: "high" },
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
    const out = anthropicToOpenAI(req, "m");
    expect(out.reasoning_effort).toBe("high");
    expect(out.thinking).toEqual({ type: "enabled" });
  });
});

describe("anthropicToOpenAI — thinking 透传", () => {
  test("req.thinking.type='enabled' → out.thinking={type:'enabled'}", () => {
    const req = makeAnthropicReq({ thinking: { type: "enabled", budget_tokens: 8192 } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  test("req.thinking.type='disabled' → out.thinking={type:'disabled'}", () => {
    const req = makeAnthropicReq({ thinking: { type: "disabled" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  test("req.thinking.type=true → 归一为 'enabled'（GLM 不吃 boolean）", () => {
    const req = makeAnthropicReq({ thinking: { type: true } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  test("req.thinking.type=false → 归一为 'disabled'", () => {
    const req = makeAnthropicReq({ thinking: { type: false } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  test("effort 速记 type='high' → 归一为 'enabled'", () => {
    const req = makeAnthropicReq({ thinking: { type: "high" } });
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  test("req.thinking 缺失 → out.thinking 不存在（不强行加）", () => {
    const req = makeAnthropicReq();
    const out = anthropicToOpenAI(req, "m");
    expect(out.thinking).toBeUndefined();
  });
});

// ===========================================================================
// thinking 反向 — 响应方向（非流式）
// ===========================================================================

describe("openAIToAnthropic — reasoning_content → thinking block", () => {
  test("reasoning_content + content → content=[thinking, text]（reasoning 在前）", () => {
    const res = makeOpenAIRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "final answer",
            reasoning_content: "chain of thought",
          },
          finish_reason: "stop",
        },
      ],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.content).toEqual([
      { type: "thinking", thinking: "chain of thought" },
      { type: "text", text: "final answer" },
    ]);
  });

  test("只有 reasoning_content 无 content → content=[thinking]", () => {
    const res = makeOpenAIRes({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, reasoning_content: "deep think" },
          finish_reason: "stop",
        },
      ],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.content).toEqual([{ type: "thinking", thinking: "deep think" }]);
  });

  test("只有 content 无 reasoning_content → 不出 thinking block", () => {
    const res = makeOpenAIRes({
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "just text" },
          finish_reason: "stop",
        },
      ],
    });
    const out = openAIToAnthropic(res, "m");
    expect(out.content).toEqual([{ type: "text", text: "just text" }]);
  });
});

// ===========================================================================
// thinking 反向 — 响应方向（流式）
// ===========================================================================

describe("convertOpenAIStreamToAnthropic — reasoning_content → thinking_delta", () => {
  test("reasoning_content delta → content_block_start(thinking) + thinking_delta", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({ reasoning_content: "let me think" }),
      sseChunk({ reasoning_content: " more" }, "stop"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "m"),
    );

    // 第一个 content_block_start 应该是 thinking 块
    const blockStarts = events.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(1);
    const thinkStart = blockStarts[0]?.data as { content_block: { type: string; thinking: string } };
    expect(thinkStart.content_block.type).toBe("thinking");
    expect(thinkStart.content_block.thinking).toBe("");

    // 2 个 thinking_delta（reasoning_content 增量）
    const thinkDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as { delta: { type?: string } }).delta.type === "thinking_delta",
    );
    expect(thinkDeltas).toHaveLength(2);

    // 没有 text_delta（这次纯 reasoning）
    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as { delta: { type?: string } }).delta.type === "text_delta",
    );
    expect(textDeltas).toHaveLength(0);
  });

  test("reasoning → content 切换 → 中间有 content_block_stop + 新 block_start", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({ reasoning_content: "thinking..." }),
      sseChunk({ content: "answer" }, "stop"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "m"),
    );

    // 2 个 block_start（thinking + text）
    const blockStarts = events.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect((blockStarts[0]?.data as { content_block: { type: string } }).content_block.type).toBe("thinking");
    expect((blockStarts[1]?.data as { content_block: { type: string } }).content_block.type).toBe("text");

    // 2 个 block_stop（thinking 关 + text 关）
    const stops = events.filter((e) => e.event === "content_block_stop");
    expect(stops.length).toBeGreaterThanOrEqual(2);
  });

  test("content → reasoning 不太可能（GLM 先 reasoning 后 content），但状态机应能正确切回 text", async () => {
    const chunks: OpenAIStreamChunk[] = [
      sseChunk({ content: "first" }),
      sseChunk({ reasoning_content: "now think" }, "stop"),
    ];
    const events = await collectSseEvents(
      convertOpenAIStreamToAnthropic(arrayIter(chunks), "m"),
    );

    const blockStarts = events.filter((e) => e.event === "content_block_start");
    expect(blockStarts).toHaveLength(2);
    expect((blockStarts[0]?.data as { content_block: { type: string } }).content_block.type).toBe("text");
    expect((blockStarts[1]?.data as { content_block: { type: string } }).content_block.type).toBe("thinking");
  });
});

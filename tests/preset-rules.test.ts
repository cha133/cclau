// ============================================================================
// 整流 preset 单元测试：kimi thinking 归一三分支 + opencode-go 双 auth sentinel
// ----------------------------------------------------------------------------
// 锁住 v3 整流两个核心 hook（CLAUDE.md 不变量 #6 + #8）。
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  BEARER_APIKEY_SENTINEL,
  OPENCODE_GO_PRESET,
  OPENCODE_GO_OPENAI_PRESET,
  KIMI_PRESET,
  STRIP_IMAGES_PRESET,
  BUILTIN_PRESETS,
  BUILTIN_PRESETS_OPENAI,
  RULE_DEFS,
  RULE_DEFS_OPENAI,
  resolveOpenAIRectifierByName,
  resolveRectifierByName,
  resolvePresetHeaders,
} from "../src/preset-rules.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicRectifier,
} from "../src/types.js";

// ---------------------------------------------------------------------------

/** 造一个最小可用的 AnthropicRequest（preset 只读 model / max_tokens / thinking） */
function makeReq(thinking?: AnthropicRequest["thinking"]): AnthropicRequest {
  return { model: "claude-sonnet-4-6", max_tokens: 1024, messages: [], thinking };
}

describe("KIMI_PRESET.requestTransform — thinking.type 归一三分支", () => {
  test("thinking=undefined → 原 req 透传（不构造空 thinking）", () => {
    const req = makeReq(undefined);
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out).toBe(req); // 同一引用，未包装
    expect(out.thinking).toBeUndefined();
  });

  test('type="disabled"（小写） → 原 req 透传', () => {
    const req = makeReq({ type: "disabled" });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out).toBe(req);
    expect(out.thinking?.type).toBe("disabled");
  });

  test('type="DISABLED"（任意大小写） → 原 req 透传', () => {
    const req = makeReq({ type: "DISABLED" });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out).toBe(req);
  });

  test("type=false → 归一为 'disabled'", () => {
    const req = makeReq({ type: false });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out).not.toBe(req);
    expect(out.thinking?.type).toBe("disabled");
  });

  test("type=null（运行时 JSON 解析可能产生）→ 归一为 'disabled'", () => {
    // TS 类型上是 string | boolean（无 null），但运行时 JSON 解析会出 null；
    // 源码用 t.type === null 做防御，这里 cast 模拟。
    const req = makeReq({ type: null as unknown as string });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out.thinking?.type).toBe("disabled");
  });

  test.each([
    ["high"],
    ["medium"],
    ["low"],
    ["xhigh"],
    ["max"],
    ["adaptive"],
  ])('effort 速记 type="%s" → 归一为 "enabled"', (effort) => {
    const req = makeReq({ type: effort });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out.thinking?.type).toBe("enabled");
  });

  test("type=true → 归一为 'enabled'", () => {
    const req = makeReq({ type: true });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out.thinking?.type).toBe("enabled");
  });

  test("type=数字 → 归一为 'enabled'（兜底未来未知 effort 名）", () => {
    const req = makeReq({ type: 42 as unknown as string });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out.thinking?.type).toBe("enabled");
  });

  test("归一分支保留 budget_tokens 等其他字段", () => {
    const req = makeReq({ type: "high", budget_tokens: 8192 });
    const out = KIMI_PRESET.requestTransform!(req);
    expect(out.thinking?.type).toBe("enabled");
    expect(out.thinking?.budget_tokens).toBe(8192);
  });
});

// ---------------------------------------------------------------------------

describe("STRIP_IMAGES_PRESET.requestTransform — drop image content blocks", () => {
  const transform = STRIP_IMAGES_PRESET.requestTransform!;

  /** 造一个最小可用 req，但带可自定义的 messages / system（覆盖 strip-images 关心的字段） */
  function makeStripReq(
    messages: AnthropicMessage[],
    system?: AnthropicRequest["system"],
  ): AnthropicRequest {
    return { model: "mimo-v2.5-pro", max_tokens: 1024, messages, system };
  }

  /** 短手：构造一个 base64 image block */
  const imgBase64 = (): AnthropicContentBlock => ({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "BASE64DATA" },
  });
  const imgUrl = (): AnthropicContentBlock => ({
    type: "image",
    source: { type: "url", url: "https://example.com/x.png" },
  });
  const imgFile = (): AnthropicContentBlock => ({
    type: "image",
    source: { type: "file", file_id: "file_abc" },
  });
  const PLACEHOLDER = "[image stripped by cclau — model does not support vision]";

  // ─── no-op 路径（透传原引用） ─────────────────────────────────────────

  test("messages 为空数组 → 原 req 透传", () => {
    const req = makeStripReq([]);
    expect(transform(req)).toBe(req);
  });

  test("字符串 content → 原 message 透传", () => {
    const req = makeStripReq([{ role: "user", content: "hi" }]);
    expect(transform(req)).toBe(req);
  });

  test("数组 content 不含 image → 原 message 透传", () => {
    const req = makeStripReq([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(transform(req)).toBe(req);
  });

  test("system 是字符串 → 透传", () => {
    const req = makeStripReq([], "you are helpful");
    expect(transform(req)).toBe(req);
  });

  test("system 是数组但不含 image → 透传", () => {
    const req = makeStripReq([], [{ type: "text", text: "you are helpful" }]);
    expect(transform(req)).toBe(req);
  });

  // ─── 基础剥离 ────────────────────────────────────────────────────────

  test("user 消息 text + image → image 剥掉，text 保留", () => {
    const textBlock: AnthropicContentBlock = { type: "text", text: "看看这张图" };
    const req = makeStripReq([
      { role: "user", content: [textBlock, imgBase64()] },
    ]);
    const out = transform(req);
    expect(out).not.toBe(req);
    expect(out.messages[0]!.content).toEqual([textBlock]);
  });

  test("user 消息全是 image → 替换为占位文本", () => {
    const req = makeStripReq([{ role: "user", content: [imgBase64()] }]);
    const out = transform(req);
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: PLACEHOLDER },
    ]);
  });

  test("user 消息混合多个 image → 全部剥掉，只留 text", () => {
    const textBlock: AnthropicContentBlock = { type: "text", text: "before" };
    const textBlock2: AnthropicContentBlock = { type: "text", text: "after" };
    const req = makeStripReq([
      { role: "user", content: [textBlock, imgBase64(), imgUrl(), textBlock2] },
    ]);
    const out = transform(req);
    expect(out.messages[0]!.content).toEqual([textBlock, textBlock2]);
  });

  test("三种 image source（base64 / url / file）全部被剥", () => {
    const req = makeStripReq([
      { role: "user", content: [imgBase64(), imgUrl(), imgFile()] },
    ]);
    const out = transform(req);
    // 全是 image → 触发占位替换
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: PLACEHOLDER },
    ]);
  });

  // ─── assistant / tool_result / system ────────────────────────────────

  test("assistant 消息含 image → 防御性剥掉", () => {
    const req = makeStripReq([
      { role: "assistant", content: [{ type: "text", text: "ok" }, imgBase64()] },
    ]);
    const out = transform(req);
    expect(out.messages[0]!.content).toEqual([
      { type: "text", text: "ok" },
    ]);
  });

  test("tool_result 的 content（数组）含 image → 递归剥掉", () => {
    const tr: AnthropicContentBlock = {
      type: "tool_result",
      tool_use_id: "t1",
      content: [{ type: "text", text: "screenshot bytes:" }, imgBase64()],
    };
    const req = makeStripReq([{ role: "user", content: [tr] }]);
    const out = transform(req);
    const outContent = out.messages[0]!.content;
    expect(Array.isArray(outContent)).toBe(true);
    const outTr = (outContent as AnthropicContentBlock[])[0]!;
    expect(outTr.type).toBe("tool_result");
    if (outTr.type === "tool_result") {
      expect(outTr.content).toEqual([{ type: "text", text: "screenshot bytes:" }]);
      // tool_use_id 等其他字段保留
      expect(outTr.tool_use_id).toBe("t1");
    }
  });

  test("tool_result 的 content 全是 image → 折叠成空字符串（上游合法）", () => {
    const tr: AnthropicContentBlock = {
      type: "tool_result",
      tool_use_id: "t1",
      content: [imgBase64(), imgUrl()],
    };
    const req = makeStripReq([{ role: "user", content: [tr] }]);
    const out = transform(req);
    const outContent = out.messages[0]!.content;
    expect(Array.isArray(outContent)).toBe(true);
    const outTr = (outContent as AnthropicContentBlock[])[0]!;
    expect(outTr.type).toBe("tool_result");
    if (outTr.type === "tool_result") {
      expect(outTr.content).toBe("");
    }
  });

  test("system 是数组且含 image → 剥掉", () => {
    const req = makeStripReq(
      [{ role: "user", content: "hi" }],
      [{ type: "text", text: "sys" }, imgBase64()],
    );
    const out = transform(req);
    expect(out.system).toEqual([{ type: "text", text: "sys" }]);
  });

  test("system 是数组且全是 image → 整个 system 字段被丢弃", () => {
    const req = makeStripReq(
      [{ role: "user", content: "hi" }],
      [imgBase64()],
    );
    const out = transform(req);
    expect(out.system).toBeUndefined();
  });

  // ─── 多 message / 不可变性 ───────────────────────────────────────────

  test("多 message 各自独立处理（剥离其中一条不影响其他）", () => {
    const req = makeStripReq([
      { role: "user", content: [{ type: "text", text: "no image here" }] },
      { role: "user", content: [{ type: "text", text: "see image" }, imgBase64()] },
      { role: "assistant", content: "ok" },
    ]);
    const out = transform(req);
    expect(out.messages[0]!.content).toEqual([{ type: "text", text: "no image here" }]);
    expect(out.messages[1]!.content).toEqual([{ type: "text", text: "see image" }]);
    expect(out.messages[2]!.content).toBe("ok");
  });

  test("不可变：input 的 messages / content 数组不被 mutate", () => {
    const originalContent: AnthropicContentBlock[] = [
      { type: "text", text: "hi" },
      imgBase64(),
    ];
    const originalMessages: AnthropicMessage[] = [
      { role: "user", content: originalContent },
    ];
    const originalSystem: AnthropicContentBlock[] = [
      { type: "text", text: "sys" },
      imgBase64(),
    ];
    const req = makeStripReq(originalMessages, originalSystem);
    const originalContentLen = originalContent.length;
    const originalSystemLen = originalSystem.length;

    transform(req);

    expect(originalContent).toHaveLength(originalContentLen);
    expect(originalContent.some((b) => b.type === "image")).toBe(true);
    expect(originalSystem).toHaveLength(originalSystemLen);
    expect(originalSystem.some((b) => b.type === "image")).toBe(true);
    // 原 message 对象本身也没被换
    expect(req.messages[0]!.content).toBe(originalContent);
  });

  // ─── 字段保留 ────────────────────────────────────────────────────────

  test("剥离后 req 上其他顶层字段（model / max_tokens / temperature / tools）保留", () => {
    const req: AnthropicRequest = {
      model: "mimo-v2.5-pro",
      max_tokens: 1024,
      temperature: 0.5,
      messages: [{ role: "user", content: [{ type: "text", text: "see" }, imgBase64()] }],
      tools: [{ name: "x", input_schema: {} }],
    };
    const out = transform(req);
    expect(out.model).toBe("mimo-v2.5-pro");
    expect(out.max_tokens).toBe(1024);
    expect(out.temperature).toBe(0.5);
    expect(out.tools).toEqual([{ name: "x", input_schema: {} }]);
  });
});

// ---------------------------------------------------------------------------

describe("resolvePresetHeaders — sentinel 替换", () => {
  test("OPENCODE_GO_PRESET + apiKey → Authorization: Bearer ${apiKey}", () => {
    const out = resolvePresetHeaders(OPENCODE_GO_PRESET, "sk-abc");
    expect(out).toEqual({ Authorization: "Bearer sk-abc" });
  });

  test("apiKey 不会以任何形式残留在结果里（除 Bearer 拼接）", () => {
    const out = resolvePresetHeaders(OPENCODE_GO_PRESET, "sk-abc");
    // 只有 Authorization 一项；没有别的 key
    expect(Object.keys(out)).toEqual(["Authorization"]);
    // 字符串里只有 "Bearer sk-abc" 一个 apiKey 出现
    expect(out.Authorization!.split("sk-abc")).toHaveLength(2);
  });

  test("混入普通 header → 透传", () => {
    const rect: AnthropicRectifier = {
      requestHeaders: {
        Authorization: BEARER_APIKEY_SENTINEL,
        "X-Custom": "plain-value",
      },
    };
    const out = resolvePresetHeaders(rect, "sk-xyz");
    expect(out).toEqual({
      Authorization: "Bearer sk-xyz",
      "X-Custom": "plain-value",
    });
  });

  test("rect=undefined → {}（不抛错）", () => {
    expect(resolvePresetHeaders(undefined, "sk-abc")).toEqual({});
  });

  test("rect.requestHeaders=undefined → {}", () => {
    const rect: AnthropicRectifier = { requestTransform: (r) => r };
    expect(resolvePresetHeaders(rect, "sk-abc")).toEqual({});
  });

  test("值非 sentinel → 原样", () => {
    const rect: AnthropicRectifier = {
      requestHeaders: { "X-Already-Set": "Bearer already-here" },
    };
    const out = resolvePresetHeaders(rect, "sk-abc");
    expect(out).toEqual({ "X-Already-Set": "Bearer already-here" });
  });

  test("空字符串 apiKey → 仍然生成 'Bearer ' 头（调用方责任检查空 key）", () => {
    const out = resolvePresetHeaders(OPENCODE_GO_PRESET, "");
    expect(out.Authorization).toBe("Bearer ");
  });
});

// ---------------------------------------------------------------------------

describe("BUILTIN_PRESETS 字典 + 常量", () => {
  test('"opencode-go" → OPENCODE_GO_PRESET（同一引用）', () => {
    expect(BUILTIN_PRESETS["opencode-go"]).toBe(OPENCODE_GO_PRESET);
  });

  test('"kimi" → KIMI_PRESET（同一引用）', () => {
    expect(BUILTIN_PRESETS["kimi"]).toBe(KIMI_PRESET);
  });

  test('"strip-images" → STRIP_IMAGES_PRESET（同一引用）', () => {
    expect(BUILTIN_PRESETS["strip-images"]).toBe(STRIP_IMAGES_PRESET);
  });

  test("未知 preset 名 → undefined（add wizard 用 .has() 判断）", () => {
    expect(BUILTIN_PRESETS["nonexistent"]).toBeUndefined();
    expect(BUILTIN_PRESETS[""]).toBeUndefined();
  });

  test("BEARER_APIKEY_SENTINEL 是稳定的魔术字符串（TOML 直读需要）", () => {
    expect(BEARER_APIKEY_SENTINEL).toBe("__CCLAU_BEARER_APIKEY__");
  });
});

// ---------------------------------------------------------------------------

describe("RULE_DEFS — wizard UI metadata", () => {
  test("keys 1:1 对齐 BUILTIN_PRESETS（多/漏都会让单选框错位）", () => {
    expect(Object.keys(RULE_DEFS).sort()).toEqual(Object.keys(BUILTIN_PRESETS).sort());
  });

  test("每条 entry 都填了非空 label 和 hint", () => {
    for (const def of Object.values(RULE_DEFS)) {
      expect(def.label).toBeString();
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.hint).toBeString();
      expect(def.hint.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------

describe("resolveRectifierByName — profile 名 → AnthropicRectifier", () => {
  test('"opencode-go" → OPENCODE_GO_PRESET（同一引用）', () => {
    expect(resolveRectifierByName("opencode-go")).toBe(OPENCODE_GO_PRESET);
  });

  test('"kimi" → KIMI_PRESET（同一引用）', () => {
    expect(resolveRectifierByName("kimi")).toBe(KIMI_PRESET);
  });

  test('"strip-images" → STRIP_IMAGES_PRESET（同一引用）', () => {
    expect(resolveRectifierByName("strip-images")).toBe(STRIP_IMAGES_PRESET);
  });

  test("未知名字 → undefined（registry build 用来 silent fallback）", () => {
    expect(resolveRectifierByName("nonexistent")).toBeUndefined();
  });

  test("undefined / 空串 → undefined", () => {
    expect(resolveRectifierByName(undefined)).toBeUndefined();
    expect(resolveRectifierByName("")).toBeUndefined();
  });
});

// ============================================================================
// OpenAI-mode presets — dual-mode per plan B (plan A 撤回)
// ============================================================================

describe("BUILTIN_PRESETS_OPENAI 字典 + 常量", () => {
  test('"opencode-go" → OPENCODE_GO_OPENAI_PRESET（同一引用）', () => {
    expect(BUILTIN_PRESETS_OPENAI["opencode-go"]).toBe(OPENCODE_GO_OPENAI_PRESET);
  });

  test("未知 preset 名 → undefined", () => {
    expect(BUILTIN_PRESETS_OPENAI["nonexistent"]).toBeUndefined();
    expect(BUILTIN_PRESETS_OPENAI[""]).toBeUndefined();
  });
});

describe("OPENCODE_GO_OPENAI_PRESET.requestTransform — opencode-go openai quirks", () => {
  const transform = OPENCODE_GO_OPENAI_PRESET.requestTransform!;
  const baseReq = {
    model: "glm-5.2",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  // ─── thinking + reasoning_effort conflict (400 avoidance) ─────────────

  test("only thinking present（无 reasoning_effort）→ 原样透传", () => {
    const req = { ...baseReq, thinking: { type: "enabled" as const } };
    const out = transform(req);
    expect(out).toEqual(req);
  });

  test("thinking + reasoning_effort='none' → 只 drop thinking（none 不 graded，保留）", () => {
    const req = {
      ...baseReq,
      thinking: { type: "enabled" as const },
      reasoning_effort: "none",
    };
    const out = transform(req);
    expect(out).toEqual({ ...baseReq, reasoning_effort: "none" });
    expect((out as { thinking?: unknown }).thinking).toBeUndefined();
  });

  // ─── Fireworks GLM-5.2 graded-tier quirk (surface reasoning) ─────────

  test("reasoning_effort='high' 单独存在 → drop（Fireworks graded tier 不 surface）", () => {
    const req = { ...baseReq, reasoning_effort: "high" };
    const out = transform(req);
    expect(out).toEqual(baseReq);
    expect((out as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined();
  });

  test("reasoning_effort='max' 单独存在 → drop（同上）", () => {
    const req = { ...baseReq, reasoning_effort: "max" };
    const out = transform(req);
    expect(out).toEqual(baseReq);
  });

  test("reasoning_effort='low' / 'medium' / 'xhigh' → drop", () => {
    for (const v of ["low", "medium", "xhigh"] as const) {
      const req = { ...baseReq, reasoning_effort: v };
      const out = transform(req);
      expect((out as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined();
    }
  });

  test("reasoning_effort='none' → 保留（explicit disable 语义不同于 graded）", () => {
    const req = { ...baseReq, reasoning_effort: "none" };
    const out = transform(req);
    expect((out as { reasoning_effort?: unknown }).reasoning_effort).toBe("none");
  });

  test("reasoning_effort=false → 保留", () => {
    const req = { ...baseReq, reasoning_effort: false };
    const out = transform(req);
    expect((out as { reasoning_effort?: unknown }).reasoning_effort).toBe(false);
  });

  // ─── 组合 ────────────────────────────────────────────────────────────

  test("thinking + effort='high' → 双 drop（thinking 因 400，effort 因 graded）", () => {
    const req = {
      ...baseReq,
      thinking: { type: "enabled" as const },
      reasoning_effort: "high",
    };
    const out = transform(req);
    expect(out).toEqual(baseReq);
  });

  test("thinking + effort='none' → 只 drop thinking（none 保留，400 也避免）", () => {
    const req = {
      ...baseReq,
      thinking: { type: "enabled" as const },
      reasoning_effort: "none",
    };
    const out = transform(req);
    expect(out).toEqual({ ...baseReq, reasoning_effort: "none" });
  });

  test("两者都无 → 原样透传", () => {
    const out = transform(baseReq);
    expect(out).toEqual(baseReq);
  });

  test("drop 后其他字段（messages / temperature / tools）原样保留", () => {
    const req = {
      ...baseReq,
      thinking: { type: "enabled" as const },
      reasoning_effort: "high",
      temperature: 0.7,
      max_tokens: 1024,
    };
    const out = transform(req);
    expect((out as { temperature?: number }).temperature).toBe(0.7);
    expect((out as { max_tokens?: number }).max_tokens).toBe(1024);
    expect((out as { messages?: unknown }).messages).toEqual(baseReq.messages);
  });
});

describe("resolveOpenAIRectifierByName — registry build helper", () => {
  test('"opencode-go" → OPENCODE_GO_OPENAI_PRESET（同一引用）', () => {
    expect(resolveOpenAIRectifierByName("opencode-go")).toBe(OPENCODE_GO_OPENAI_PRESET);
  });

  test("未知名字 → undefined", () => {
    expect(resolveOpenAIRectifierByName("nonexistent")).toBeUndefined();
  });

  test("undefined / 空串 → undefined", () => {
    expect(resolveOpenAIRectifierByName(undefined)).toBeUndefined();
    expect(resolveOpenAIRectifierByName("")).toBeUndefined();
  });
});

describe("RULE_DEFS_OPENAI — wizard UI metadata", () => {
  test("keys 1:1 对齐 BUILTIN_PRESETS_OPENAI（多/漏都会让单选框错位）", () => {
    expect(Object.keys(RULE_DEFS_OPENAI).sort()).toEqual(Object.keys(BUILTIN_PRESETS_OPENAI).sort());
  });

  test("每条 entry 都填了非空 label 和 hint", () => {
    for (const def of Object.values(RULE_DEFS_OPENAI)) {
      expect(def.label).toBeString();
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.hint).toBeString();
      expect(def.hint.length).toBeGreaterThan(0);
    }
  });
});

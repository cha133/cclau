// ============================================================================
// 整流 preset 单元测试：kimi thinking 归一三分支 + opencode-go 双 auth sentinel
// ----------------------------------------------------------------------------
// 锁住 v3 整流两个核心 hook（CLAUDE.md 不变量 #6 + #8）。
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  BEARER_APIKEY_SENTINEL,
  OPENCODE_GO_PRESET,
  KIMI_PRESET,
  BUILTIN_PRESETS,
  RULE_DEFS,
  resolvePresetHeaders,
} from "../src/preset-rules.js";
import type { AnthropicRequest, AnthropicRectifier } from "../src/types.js";

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

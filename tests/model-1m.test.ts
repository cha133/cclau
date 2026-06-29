// ============================================================================
// 1M context 标记处理：apply1m / strip1m / formatModelWith1m / findModelInfo
// ----------------------------------------------------------------------------
// 锁住 v2/v5 不变量配套：1m suffix 是 sidecar/直连分歧点 + registry key 计算源
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  apply1m,
  strip1m,
  formatModelWith1m,
  findModelInfo,
} from "../src/core/model-1m.js";
import type { ModelInfo } from "../src/types.js";

// ---------------------------------------------------------------------------

describe("apply1m", () => {
  test("supports1m=true + 普通 model → 追加 [1m]", () => {
    expect(apply1m("claude-sonnet-4-6", true)).toBe("claude-sonnet-4-6[1m]");
  });

  test("supports1m=false + 普通 model → 原 model（不剥）", () => {
    expect(apply1m("claude-sonnet-4-6", false)).toBe("claude-sonnet-4-6");
  });

  test("supports1m=true + 已带 [1m] → 幂等（仍是 [1m]）", () => {
    expect(apply1m("claude-sonnet-4-6[1m]", true)).toBe("claude-sonnet-4-6[1m]");
  });

  test("supports1m=false + 已带 [1m] → 剥掉 [1m]（不残留）", () => {
    expect(apply1m("claude-sonnet-4-6[1m]", false)).toBe("claude-sonnet-4-6");
  });

  test("空串 → 空串（透传）", () => {
    expect(apply1m("", true)).toBe("");
    expect(apply1m("", false)).toBe("");
  });

  test("大小写不敏感：[1M] 也剥（regex 用 [Mm]）", () => {
    // strip1m 内部 regex 是 /\[1[Mm]\]$/，所以 [1M] 也算
    expect(apply1m("claude-sonnet-4-6[1M]", true)).toBe("claude-sonnet-4-6[1m]");
    expect(apply1m("claude-sonnet-4-6[1M]", false)).toBe("claude-sonnet-4-6");
  });

  test("幂等：apply1m(apply1m(x, true), true) === apply1m(x, true)", () => {
    const x = "claude-sonnet-4-6";
    expect(apply1m(apply1m(x, true), true)).toBe(apply1m(x, true));
  });

  test("幂等：apply1m(apply1m(x, false), false) === apply1m(x, false)", () => {
    const x = "claude-sonnet-4-6[1m]";
    expect(apply1m(apply1m(x, false), false)).toBe(apply1m(x, false));
  });

  test("apply1m + strip1m 对偶", () => {
    expect(strip1m(apply1m("claude-sonnet-4-6", true))).toBe("claude-sonnet-4-6");
    expect(strip1m(apply1m("claude-sonnet-4-6[1m]", false))).toBe("claude-sonnet-4-6");
  });
});

// ---------------------------------------------------------------------------

describe("strip1m", () => {
  test("无 [1m] 后缀 → 原 model", () => {
    expect(strip1m("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  test("有 [1m] 后缀（小写） → 剥掉", () => {
    expect(strip1m("claude-sonnet-4-6[1m]")).toBe("claude-sonnet-4-6");
  });

  test("有 [1M] 后缀（大写） → 剥掉", () => {
    expect(strip1m("claude-sonnet-4-6[1M]")).toBe("claude-sonnet-4-6");
  });

  test("空串 → 空串（透传）", () => {
    expect(strip1m("")).toBe("");
  });

  test("中段含 [1m] 不剥（必须结尾）", () => {
    expect(strip1m("claude-[1m]-sonnet")).toBe("claude-[1m]-sonnet");
  });

  test("幂等：strip1m(strip1m(x)) === strip1m(x)", () => {
    expect(strip1m(strip1m("claude-sonnet-4-6[1m]"))).toBe(strip1m("claude-sonnet-4-6[1m]"));
  });
});

// ---------------------------------------------------------------------------

describe("formatModelWith1m", () => {
  test("has1m=undefined → 原 model", () => {
    expect(formatModelWith1m("claude-sonnet-4-6", undefined)).toBe("claude-sonnet-4-6");
  });

  test("has1m=false → 原 model", () => {
    expect(formatModelWith1m("claude-sonnet-4-6", false)).toBe("claude-sonnet-4-6");
  });

  test("has1m=true + 不传 dimFn → 'model [1m]'（裸 marker）", () => {
    expect(formatModelWith1m("claude-sonnet-4-6", true)).toBe("claude-sonnet-4-6 [1m]");
  });

  test("has1m=true + 传 dimFn → dimFn 包裹 marker", () => {
    const dim = (s: string) => `<${s}>`;
    expect(formatModelWith1m("claude-sonnet-4-6", true, dim)).toBe("claude-sonnet-4-6 <[1m]>");
  });

  test("空串 → 空串（透传）", () => {
    expect(formatModelWith1m("", true)).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("findModelInfo", () => {
  const models: ModelInfo[] = [
    { id: "claude-sonnet-4-6", supports_1m: true },
    { id: "claude-haiku-4-5", supports_1m: false },
    { id: "claude-opus-4-8", supports_1m: true },
  ];

  test("命中 → 返回对应 entry", () => {
    const m = findModelInfo(models, "claude-haiku-4-5");
    expect(m).toEqual({ id: "claude-haiku-4-5", supports_1m: false });
  });

  test("未命中 → undefined", () => {
    expect(findModelInfo(models, "claude-missing")).toBeUndefined();
  });

  test("空列表 → undefined（不抛错）", () => {
    expect(findModelInfo([], "anything")).toBeUndefined();
  });

  test("支持泛型：custom shape 也能用", () => {
    const custom = [
      { id: "x", extra: 1 },
      { id: "y", extra: 2 },
    ];
    expect(findModelInfo(custom, "y")).toEqual({ id: "y", extra: 2 });
  });
});

// ============================================================================
// ui/prompts 纯函数 helper 单测
//
// 这些不依赖 @clack/prompts，全部无副作用、可直接 import。
// 单元测试覆盖易退化的小工具，避免以后手贱改坏。
//
// - maskToken            前 4 + 后 4 + 中间 •×(len-8)
// - maybePrependCustomModel  prior 不在 fetch 列表里 → 前置以保证 autocomplete 可 pre-select
// ============================================================================

import { describe, test, expect } from "bun:test";
import { maskToken, maybePrependCustomModel } from "../src/ui/prompts.js";

describe("maskToken", () => {
  test("empty token → empty string", () => {
    expect(maskToken("")).toBe("");
  });

  test("token ≤ 8 chars → all bullets of same length", () => {
    expect(maskToken("ab")).toBe("••");
    expect(maskToken("abcd")).toBe("••••");
    expect(maskToken("12345678")).toBe("••••••••");
  });

  test("token > 8 chars → first 4 + (len-8) bullets + last 4", () => {
    // len=9, first4="1234", last4="6789", mid=1
    expect(maskToken("123456789")).toBe("1234•6789");
    // len=12, first4="abcd", last4="ijkl", mid=4
    expect(maskToken("abcdefghijkl")).toBe("abcd••••ijkl");
    // len=21 ("sk-abcdefghijklmnopqr"), first4="sk-a", last4="opqr", mid=13
    const masked = maskToken("sk-abcdefghijklmnopqr");
    expect(masked.startsWith("sk-a")).toBe(true);
    expect(masked.endsWith("opqr")).toBe(true);
    expect(masked.length).toBe(21);
  });

  test("token with 15 chars example used in docs", () => {
    // len=15 ("sk-12345678abcd"), mid=15-8=7 bullets
    expect(maskToken("sk-12345678abcd")).toBe("sk-1•••••••abcd");
  });
});

describe("maybePrependCustomModel", () => {
  test("models=null → null (caller will fall back to manual text)", () => {
    expect(maybePrependCustomModel(null, "custom-llm")).toBeNull();
    expect(maybePrependCustomModel(null, undefined)).toBeNull();
  });

  test("prior undefined / empty / whitespace → models unchanged", () => {
    const models = ["a", "b", "c"];
    expect(maybePrependCustomModel(models, undefined)).toEqual(models);
    expect(maybePrependCustomModel(models, "")).toEqual(models);
    expect(maybePrependCustomModel(models, "   ")).toEqual(models);
  });

  test("prior already in list → models unchanged (no duplicate)", () => {
    const models = ["a", "b", "c"];
    expect(maybePrependCustomModel(models, "b")).toEqual(models);
  });

  test("prior not in list → prepend (autocomplete can initialValue)", () => {
    const models = ["a", "b", "c"];
    expect(maybePrependCustomModel(models, "custom-x")).toEqual([
      "custom-x",
      "a",
      "b",
      "c",
    ]);
  });

  test("prior whitespace-trimmed before duplicate check", () => {
    const models = ["a", "b"];
    // ' a ' trimmed → 'a' which is in list → no prepend
    expect(maybePrependCustomModel(models, " a ")).toEqual(models);
    // ' b ' trimmed → not in list ('b' is) wait — ' b ' → 'b' which IS in list, no prepend
    expect(maybePrependCustomModel(models, " c ")).toEqual(["c", "a", "b"]);
  });
});

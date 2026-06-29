// ============================================================================
// fuzzy 匹配：fuzzyScore / fuzzyMatch / fuzzyTopN / isAmbiguous + 歧义阈值
// ----------------------------------------------------------------------------
// 锁住 v4 不变量 #7：FUZZY_AMBIGUITY_GAP=50 是危险命令（rm / profile rm / launch）
// 的护栏 —— top-1 vs top-2 分数差 < 50 拒绝执行。
// ============================================================================

import { describe, test, expect } from "bun:test";

import {
  fuzzyScore,
  fuzzyMatch,
  fuzzyTopN,
  isAmbiguous,
  FUZZY_AMBIGUITY_GAP,
} from "../src/fuzzy.js";

// ---------------------------------------------------------------------------

describe("fuzzyScore — 4 档", () => {
  test("完全匹配 = 1000", () => {
    expect(fuzzyScore("open", "open")).toBe(1000);
    expect(fuzzyScore("kimi", "kimi")).toBe(1000);
  });

  test("完全匹配（大小写不敏感）= 1000", () => {
    expect(fuzzyScore("KIMI", "kimi")).toBe(1000);
    expect(fuzzyScore("Kimi", "KIMI")).toBe(1000);
  });

  test("前缀匹配 = 500 - (t.length - q.length)（长度差越大分越低）", () => {
    // 短 query 命中较长 target = 较短扣分
    expect(fuzzyScore("o", "opencode-go")).toBe(500 - (11 - 1)); // 489
    expect(fuzzyScore("op", "opencode-go")).toBe(500 - (11 - 2)); // 491
    expect(fuzzyScore("open", "opencode-go")).toBe(500 - (11 - 4)); // 493
  });

  test("子串匹配 = 300 - idx（位置越前分越高）", () => {
    // "kimi" in "akimi" — idx=1 → 299
    expect(fuzzyScore("kimi", "akimi")).toBe(299);
    // "kimi" in "kimi" — 但这条走完全匹配 1000，不走子串
    expect(fuzzyScore("kimi", "kimi")).toBe(1000);
  });

  test("首字母缩写（不连续）= 100 - t.length", () => {
    // q="ds" t="deepseek" (len 8) → 命中 'd' (idx 0) + 's' (idx 5) → 92
    expect(fuzzyScore("ds", "deepseek")).toBe(100 - 8); // 92
    // q="ds" t="claude-sonnet" (len 13) — 不前缀不子串 → 缩写: d(4) s(7) → 87
    expect(fuzzyScore("ds", "claude-sonnet")).toBe(100 - 13); // 87
  });

  test("前缀命中优先于缩写（高 1 档）", () => {
    // q="ds" t="ds-store" → 完全？不(短)，前缀？ds-store.startsWith("ds") → yes
    // 500 - (8-2) = 494（不是 100-8=92）
    expect(fuzzyScore("ds", "ds-store")).toBe(500 - (8 - 2)); // 494
    // q="myw" t="mywork" → 前缀命中（mywork.startsWith("myw")=true）
    expect(fuzzyScore("myw", "mywork")).toBe(500 - (6 - 3)); // 497
  });

  test("首字母缩写：query 字符必须按序在 target 出现", () => {
    // q="zyx" t="deepseek" → 'z' 找不到 → -1
    expect(fuzzyScore("zyx", "deepseek")).toBe(-1);
  });

  test("完全 / 前缀 / 子串 / 缩写 都不命中 → -1", () => {
    expect(fuzzyScore("xyz", "opencode-go")).toBe(-1);
  });

  test("空 query → 0（不抛错）", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("fuzzyMatch — top-1 胜出", () => {
  test("精确命中优先于前缀命中", () => {
    expect(fuzzyMatch("open", ["open", "opencode-go", "opening"])).toBe("open");
  });

  test("所有命中按 score 降序排", () => {
    // "k" 命中：完全 (k=1000) / 前缀 (kimi=499) / 缩写 (kafka=93)
    expect(fuzzyMatch("k", ["kafka", "kimi", "k"])).toBe("k");
  });

  test("候选空 → undefined", () => {
    expect(fuzzyMatch("anything", [])).toBeUndefined();
  });

  test("全不命中 → undefined", () => {
    expect(fuzzyMatch("xyz", ["opencode-go", "kimi"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe("fuzzyTopN", () => {
  test("n=1 → 退化为 top-1", () => {
    const top = fuzzyTopN("open", ["open", "opencode-go", "kimi"], 1);
    expect(top).toHaveLength(1);
    expect(top[0]?.name).toBe("open");
  });

  test("按 score 降序排", () => {
    // "o" 命中：other (len 5) → 500-4=496; opencode-go (len 11) → 500-10=490
    // kimi: indexOf("o")=-1 → filtered
    const top = fuzzyTopN("o", ["opencode-go", "other", "kimi"], 3);
    expect(top.map((t) => t.name)).toEqual(["other", "opencode-go"]);
  });

  test("n<=0 → 空数组", () => {
    expect(fuzzyTopN("o", ["opencode-go"], 0)).toEqual([]);
    expect(fuzzyTopN("o", ["opencode-go"], -1)).toEqual([]);
  });

  test("候选空 → 空数组", () => {
    expect(fuzzyTopN("o", [], 3)).toEqual([]);
  });

  test("n 大于候选数 → 只返命中（不补 undefined）", () => {
    const top = fuzzyTopN("o", ["opencode-go"], 5);
    expect(top).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("isAmbiguous — 危险命令护栏（FUZZY_AMBIGUITY_GAP=50）", () => {
  test("top 长度 < 2 → 不歧义（单候选直接放行）", () => {
    expect(isAmbiguous([])).toBe(false);
    expect(isAmbiguous([{ name: "x", score: 100 }])).toBe(false);
  });

  test("精确 vs 前缀：gap=507 → 不歧义（放行）", () => {
    // open 精确=1000；opencode-go 前缀=500-(11-4)=493；gap=507
    const top = fuzzyTopN("open", ["open", "opencode-go"], 2);
    expect(isAmbiguous(top)).toBe(false);
  });

  test("两个前缀同档（gap 小）→ 歧义（拒绝）", () => {
    // open (len 4) 前缀命中：openrouter (len 10) → 500-6=494; opencode-go (len 11) → 500-7=493
    // gap=1 < 50 → 歧义
    const top = fuzzyTopN("open", ["opencode-go", "openrouter"], 2);
    expect(top[0]?.score).toBe(494); // openrouter
    expect(top[1]?.score).toBe(493); // opencode-go
    expect(isAmbiguous(top)).toBe(true);
  });

  test("前缀同档不同长度差（gap 小）→ 歧义（拒绝）", () => {
    // "d" (len 1) 前缀命中：dark (len 4) → 500-3=497; deepseek (len 8) → 500-7=493
    // gap=4 < 50 → 歧义
    const top = fuzzyTopN("d", ["dark", "deepseek"], 2);
    expect(top[0]?.score).toBe(497);
    expect(top[1]?.score).toBe(493);
    expect(isAmbiguous(top)).toBe(true);
  });

  test("gap 恰好 = 49 → 歧义（边界 < 50）", () => {
    const top = [
      { name: "a", score: 100 },
      { name: "b", score: 51 },
    ];
    expect(isAmbiguous(top)).toBe(true);
  });

  test("gap 恰好 = 50 → 不歧义（边界 ≥ 50）", () => {
    const top = [
      { name: "a", score: 100 },
      { name: "b", score: 50 },
    ];
    expect(isAmbiguous(top)).toBe(false);
  });

  test("FUZZY_AMBIGUITY_GAP 是公开常量 50（构造时被 rm / profile rm 引用）", () => {
    expect(FUZZY_AMBIGUITY_GAP).toBe(50);
  });
});

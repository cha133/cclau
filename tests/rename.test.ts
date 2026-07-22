import { describe, expect, test } from "bun:test";

import {
  normalizeRenameName,
  resolveRenameSource,
} from "../src/commands/rename.js";

describe("rename source resolution", () => {
  test("resolves a unique fuzzy source", () => {
    expect(resolveRenameSource("deep", ["deepseek", "kimi"])).toBe("deepseek");
  });

  test("rejects an ambiguous source", () => {
    expect(() => resolveRenameSource("open", ["opencode-go", "openrouter"])).toThrow(
      /ambiguously matches/,
    );
  });
});

describe("rename destination validation", () => {
  test("normalizes trim and lowercase", () => {
    expect(normalizeRenameName(" OpenCode-Go-1 ", ["opencode-go"])).toBe("opencode-go-1");
  });

  test("rejects duplicates and invalid names", () => {
    expect(() => normalizeRenameName("opencode-go", ["opencode-go"])).toThrow(/already exists/);
    expect(() => normalizeRenameName("bad name", ["opencode-go"])).toThrow(/kebab-case/);
  });
});

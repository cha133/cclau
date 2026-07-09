import { describe, expect, test } from "bun:test";

import {
  buildClonedProfile,
  normalizeCpName,
  resolveCpSource,
} from "../src/commands/cp.js";
import type { Profile } from "../src/types.js";

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "source",
    endpoint: "https://example.invalid",
    apiKey: "sk-source",
    mode: "rectify",
    model: "old-model",
    supports1m: true,
    rectifier: "opencode-go",
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("cp clone construction", () => {
  test("preserves connection fields and replaces model/name/1m/timestamps", () => {
    const source = makeProfile();
    const cloned = buildClonedProfile({
      source,
      name: "copy",
      model: " new-model ",
      supports1m: false,
      now: 9000,
    });

    expect(cloned).toEqual({
      ...source,
      name: "copy",
      model: "new-model",
      supports1m: false,
      createdAt: 9000,
      updatedAt: 9000,
    });
    expect(cloned.endpoint).toBe(source.endpoint);
    expect(cloned.apiKey).toBe(source.apiKey);
    expect(cloned.mode).toBe(source.mode);
    expect(cloned.rectifier).toBe(source.rectifier);
  });
});

describe("cp new name validation", () => {
  test("normalizes trim + lowercase", () => {
    expect(normalizeCpName(" Copy-1 ", ["source"])).toBe("copy-1");
  });

  test("rejects duplicate and invalid names", () => {
    expect(() => normalizeCpName("source", ["source"])).toThrow(/already exists/);
    expect(() => normalizeCpName("bad name", ["source"])).toThrow(/kebab-case/);
  });
});

describe("cp source resolution", () => {
  test("resolves a unique fuzzy source", () => {
    expect(resolveCpSource("deep", ["deepseek", "kimi"])).toEqual({
      name: "deepseek",
      matched: true,
    });
  });

  test("rejects ambiguous fuzzy matches", () => {
    expect(() => resolveCpSource("open", ["opencode-go", "openrouter"])).toThrow(
      /ambiguously matches/,
    );
  });
});

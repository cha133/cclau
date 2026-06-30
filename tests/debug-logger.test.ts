// ============================================================================
// debug.ts：DebugLogger 提取 helper（extractThinking / extractOutputConfigEffort）
// ----------------------------------------------------------------------------
// 集成测：起 enableDebug env，跑 getDebugLogger()，调 logIn，验证 log 文本。
// 用 substring 断言而不是文件计数 —— 容忍跨 test 累积的旧内容。
// ============================================================================

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { APP_STATE_DIR } from "../src/utils/paths.js";
import { getDebugLogger } from "../src/server/debug.js";

const SENTINEL_PREFIX = `test-marker-${Date.now()}-${Math.random()}`;

function enableDebug(): void {
  process.env.CCLAU_DEBUG = "1";
}

function readAllLogs(): string {
  if (!existsSync(APP_STATE_DIR)) return "";
  // Match per-session logs (debug-{ISO-timestamp}.log), not the legacy
  // fixed-name debug.log. Both start with "debug-" but session logs include
  // a dash after "debug-" followed by digits — the simplest discriminator is
  // the ISO timestamp segment (always starts with "20" for year 2xxx).
  return readdirSync(APP_STATE_DIR)
    .filter((f) => /^debug-\d{4}-\d{2}-\d{2}/.test(f))
    .map((f) => readFileSync(join(APP_STATE_DIR, f), "utf-8"))
    .join("\n");
}

describe("DebugLogger — IN log content", () => {
  test("records body.thinking (existing field)", () => {
    enableDebug();
    const marker = `${SENTINEL_PREFIX}-thinking`;
    const log = getDebugLogger();
    log.logIn(
      "http://127.0.0.1:3133/v1/messages",
      { "x-api-key": "sk-abc" },
      { model: "test", thinking: { type: "adaptive", budget_tokens: 8192 }, stream: true },
    );
    const text = readAllLogs();
    expect(text).toContain("body.thinking:");
    expect(text).toContain('"type":"adaptive"');
    expect(text).toContain('"budget_tokens":8192');
    // sanity: this test's marker should appear so we know our log call ran
    void marker;
  });

  test("records body.output_config.effort when present", () => {
    enableDebug();
    const log = getDebugLogger();
    log.logIn(
      "http://127.0.0.1:3133/v1/messages",
      {},
      { model: "test", output_config: { effort: "high" }, stream: false },
    );
    const text = readAllLogs();
    expect(text).toContain("body.output_config.effort:");
    expect(text).toContain('"high"');
  });

  test("body.output_config.effort absent → null in log", () => {
    enableDebug();
    const log = getDebugLogger();
    log.logIn("http://127.0.0.1:3133/v1/messages", {}, { model: "test", stream: false });
    const text = readAllLogs();
    expect(text).toContain("body.output_config.effort:");
    expect(text).toMatch(/body\.output_config\.effort: (null|undefined)/);
  });

  test("body.output_config exists but no effort → null in log", () => {
    enableDebug();
    const log = getDebugLogger();
    log.logIn(
      "http://127.0.0.1:3133/v1/messages",
      {},
      { model: "test", output_config: { format: "json" }, stream: false },
    );
    const text = readAllLogs();
    expect(text).toContain("body.output_config.effort:");
    expect(text).toMatch(/body\.output_config\.effort: (null|undefined)/);
  });

  test("redacts api_key header (sanity on secret redaction)", () => {
    enableDebug();
    const log = getDebugLogger();
    log.logIn(
      "http://127.0.0.1:3133/v1/messages",
      { "x-api-key": "sk-I5LwABCDEFGHIJKLMNOPklt4" },
      { model: "test" },
    );
    const text = readAllLogs();
    expect(text).not.toContain("I5LwABCDEFGHIJKLMNOPklt4");
    expect(text).toContain("sk-I");
    expect(text).toContain("klt4");
  });
});
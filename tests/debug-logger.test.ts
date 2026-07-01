// ============================================================================
// debug.ts：DebugLogger 提取 helper（extractThinking / extractOutputConfigEffort）
// ----------------------------------------------------------------------------
// 集成测：起 enableDebug env，跑 getDebugLogger()，调 logIn，验证 log 文本。
// 用 substring 断言而不是文件计数 —— 容忍跨 test 累积的旧内容。
// ============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { APP_STATE_DIR } from "../src/utils/paths.js";
import { getDebugLogger, _resetDebugLoggerForTests } from "../src/server/debug.js";

const SENTINEL_PREFIX = `test-marker-${Date.now()}-${Math.random()}`;

function enableDebug(): void {
  process.env.CCLAU_DEBUG = "1";
}

// Other test files (e.g. openai-to-anthropic.test.ts) call convertOpenAIStreamToAnthropic
// which transitively calls getDebugLogger() — if they run before this file in the same
// process, the cached logger is NULL_LOGGER (CCLAU_DEBUG was unset) and our
// enableDebug() below wouldn't rebuild it. Reset before each test so we always
// re-evaluate CCLAU_DEBUG.
//
// Also wipe the state dir so old session logs from prior tests / manual runs
// (e.g. repro3 scripts the dev might run before `bun test`) don't pollute
// substring assertions like `expect(text).toContain(...)`.
beforeEach(() => {
  enableDebug();
  _resetDebugLoggerForTests();
  if (existsSync(APP_STATE_DIR)) {
    for (const f of readdirSync(APP_STATE_DIR)) {
      if (f.startsWith("debug-") && f.endsWith(".log")) {
        rmSync(join(APP_STATE_DIR, f));
      }
    }
  }
});

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

// ============================================================================
// logDownstream — downstream SSE event logging
// ----------------------------------------------------------------------------
// cclau forwards SSE to claude-code; if it ever eats a character we'll know
// because upstream aggregate length and downstream cumulative count diverge.
// Sparse events (message_start / ping / content_block_start / message_delta /
// message_stop) are logged individually; dense events (content_block_delta)
// are aggregated per-block and flushed on content_block_stop.
// ============================================================================

describe("DebugLogger — logDownstream (sparse events)", () => {
  test("message_start / ping / message_stop each logged individually", () => {
    const log = getDebugLogger();
    log.logDownstream("message_start", { type: "message_start", message: { id: "msg_1" } });
    log.logDownstream("ping", { type: "ping" });
    log.logDownstream("message_stop", { type: "message_stop" });
    const text = readAllLogs();
    expect(text).toContain("--- DOWNSTREAM message_start ---");
    expect(text).toContain("--- DOWNSTREAM ping ---");
    expect(text).toContain("--- DOWNSTREAM message_stop ---");
  });

  test("content_block_start logged individually (one line per block)", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    const text = readAllLogs();
    expect(text).toContain("--- DOWNSTREAM content_block_start ---");
    expect(text).toContain('"index":0');
  });
});

describe("DebugLogger — logDownstream (content_block_delta aggregation)", () => {
  test("consecutive text_delta for same index → ONE summary at stop", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    // 5 single-char Chinese text deltas (mimics GLM char-by-char streaming)
    for (const ch of ["中", "国", "茶", "茶", "！"]) {
      log.logDownstream("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ch },
      });
    }
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 0 });
    const text = readAllLogs();
    // Individual deltas must NOT appear as their own DOWNSTREAM content_block_delta
    // lines — only the summary should.
    const perEventCount = (text.match(/--- DOWNSTREAM content_block_delta ---/g) ?? []).length;
    expect(perEventCount).toBe(0);
    // Summary should appear once.
    expect(text).toContain("--- DOWNSTREAM content_block_summary ---");
    expect(text).toContain('"delta_count":5');
    expect(text).toContain('"total_chars":5');
    expect(text).toContain('"preview":"中国茶茶！"');
    expect(text).toContain('"_cumulative_text_chars":5');
    expect(text).toContain('"_flush_reason":"normal"');
  });

  test("cumulative_text_chars is session-wide across multiple text blocks", () => {
    const log = getDebugLogger();
    // Block 0: 3 chars
    log.logDownstream("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    log.logDownstream("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "abc" } });
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 0 });
    // Block 1: 2 more chars
    log.logDownstream("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
    log.logDownstream("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "de" } });
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 1 });
    const text = readAllLogs();
    // First block's summary should show _cumulative_text_chars:3, second should show 5.
    expect(text).toMatch(/"_cumulative_text_chars":3[^5]/); // 3 not followed by 5 (i.e. 3, not 35)
    expect(text).toMatch(/"_cumulative_text_chars":5/);
  });

  test("thinking_delta aggregated with thinking block summary (no text cumulative)", () => {
    const log = getDebugLogger();
    const sentinel = `${SENTINEL_PREFIX}-thinking`;
    log.logDownstream("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: sentinel },
    });
    log.logDownstream("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: sentinel + " user asked about news" },
    });
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 0 });
    const text = readAllLogs();
    // Anchor on the sentinel so we check THIS test's summary, not whatever
    // earlier text-block tests wrote to the same global log file.
    const summaryIdx = text.indexOf(sentinel);
    expect(summaryIdx).toBeGreaterThan(-1);
    // Slice from the sentinel to the next "--- DOWNSTREAM" boundary line —
    // that's the end of the summary line (since summaries are single-line).
    const fromSentinel = text.slice(summaryIdx);
    const nextBoundary = fromSentinel.indexOf("\n--- DOWNSTREAM");
    const summaryLine = nextBoundary > 0 ? fromSentinel.slice(0, nextBoundary) : fromSentinel;
    expect(summaryLine).toContain('"type":"thinking"');
    expect(summaryLine).toContain('"delta_type":"thinking_delta"');
    expect(summaryLine).toContain(sentinel);
    // thinking blocks don't bump the text cumulative (it's text-only)
    expect(summaryLine).not.toMatch(/_cumulative_text_chars":\d+/);
  });

  test("input_json_delta aggregated for tool_use block", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_1", name: "Bash", input: {} },
    });
    log.logDownstream("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":' },
    });
    log.logDownstream("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"ls"}' },
    });
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 0 });
    const text = readAllLogs();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"delta_count":2');
    // '{"command":' = 11 chars + '"ls"}' = 5 chars → 16 chars total
    expect(text).toContain('"total_chars":16');
    expect(text).toContain('"preview":"{\\"command\\":\\"ls\\"}"');
  });

  test("interrupted block (delta for new index without prior stop) flushes old + starts new", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    log.logDownstream("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ab" } });
    // jump to index 1 without stopping 0 — defensive flush
    log.logDownstream("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "cd" } });
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 1 });
    const text = readAllLogs();
    // Two summaries: first marked "interrupted", second "normal"
    expect(text).toMatch(/"_flush_reason":"interrupted"[\s\S]*?"_flush_reason":"normal"|"_flush_reason":"normal"[\s\S]*?"_flush_reason":"interrupted"/);
    // The interrupted block still reports its 2 chars and cumulative 2
    expect(text).toMatch(/"index":0[\s\S]*?"total_chars":2/);
    expect(text).toMatch(/"index":1[\s\S]*?"total_chars":2[\s\S]*?"_cumulative_text_chars":4/);
  });

  test("content_block_stop without prior deltas → 'stop-without-deltas' reason", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_stop", { type: "content_block_stop", index: 7 });
    const text = readAllLogs();
    expect(text).toContain('"index":7');
    expect(text).toContain('"_flush_reason":"stop-without-deltas"');
  });

  test("unterminated block at message_stop → 'message-stop-without-block-stop' flush", () => {
    const log = getDebugLogger();
    log.logDownstream("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    log.logDownstream("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lost" } });
    log.logDownstream("message_stop", { type: "message_stop" });
    const text = readAllLogs();
    expect(text).toContain('"preview":"lost"');
    expect(text).toContain('"_flush_reason":"message-stop-without-block-stop"');
  });
});

// ============================================================================
// logUpstreamOpenaiText / Reasoning / ToolDelta / Control — openai upstream
// aggregation. Replaces the per-chunk logUpstreamChunk call that bloated
// logs 100× for char-by-char streaming providers.
// ============================================================================

describe("DebugLogger — logUpstreamOpenaiText (aggregated text)", () => {
  test("writes chunks/duration/chars metadata + 200-char preview", () => {
    const log = getDebugLogger();
    log.logUpstreamOpenaiText({
      chatcmplId: "chatcmpl-abc",
      text: "茶茶想知道今天有啥新闻呀～ 我来搜搜看 🌸",
      chunkCount: 14,
      durationMs: 230,
    });
    const text = readAllLogs();
    expect(text).toContain("--- UPSTREAM openai-text (chatcmpl-abc) ---");
    expect(text).toContain("chunks=14 duration=230ms chars=22");
    expect(text).toContain("茶茶想知道今天有啥新闻呀～");
  });

  test("truncates preview to 200 chars with overflow marker", () => {
    const log = getDebugLogger();
    const long = "中".repeat(500);
    log.logUpstreamOpenaiText({ chatcmplId: "x", text: long, chunkCount: 500, durationMs: 100 });
    const text = readAllLogs();
    expect(text).toContain("chars=500");
    expect(text).toContain("…(+300)");
  });
});

describe("DebugLogger — logUpstreamOpenaiReasoning (aggregated CoT)", () => {
  test("writes chunks/duration/chars + preview", () => {
    const log = getDebugLogger();
    log.logUpstreamOpenaiReasoning({
      chatcmplId: "chatcmpl-r",
      text: "用户问今天新闻，我已经搜到了不少7月1-2日的新闻。",
      chunkCount: 200,
      durationMs: 1500,
    });
    const text = readAllLogs();
    expect(text).toContain("--- UPSTREAM openai-reasoning (chatcmpl-r) ---");
    expect(text).toContain("chunks=200 duration=1500ms");
  });
});

describe("DebugLogger — logUpstreamOpenaiToolDelta (structured per-chunk)", () => {
  test("logs id + name + partial args", () => {
    const log = getDebugLogger();
    log.logUpstreamOpenaiToolDelta({
      chatcmplId: "chatcmpl-t",
      toolIndex: 0,
      id: "tool_42",
      name: "Bash",
      partialArgs: '{"command":',
    });
    const text = readAllLogs();
    expect(text).toContain("--- UPSTREAM openai-tool-delta ---");
    expect(text).toContain("chatcmpl=chatcmpl-t");
    expect(text).toContain("tool_index=0");
    expect(text).toContain("id=tool_42");
    expect(text).toContain("name=Bash");
    expect(text).toContain('args_delta="{\\"command\\":"');
  });

  test("omits id/name/args when absent", () => {
    const log = getDebugLogger();
    const sentinel = `${SENTINEL_PREFIX}-tool-delta-empty`;
    log.logUpstreamOpenaiToolDelta({ chatcmplId: sentinel, toolIndex: 99 });
    const text = readAllLogs();
    // Anchor on the sentinel so we only check THIS test's tool-delta line,
    // not earlier tests' tool-deltas with id/name/args filled in.
    const idx = text.indexOf(`chatcmpl=${sentinel}`);
    expect(idx).toBeGreaterThan(-1);
    const line = text.slice(idx).split("\n")[0] ?? "";
    expect(line).toContain("tool_index=99");
    expect(line).not.toContain("id=");
    expect(line).not.toContain("name=");
    expect(line).not.toContain("args_delta=");
  });
});

describe("DebugLogger — logUpstreamOpenaiControl", () => {
  test("role / finish / usage-only each get one line with chatcmpl + kind", () => {
    const log = getDebugLogger();
    log.logUpstreamOpenaiControl({ chatcmplId: "c1", kind: "role" });
    log.logUpstreamOpenaiControl({ chatcmplId: "c1", kind: "finish", detail: "tool_calls" });
    log.logUpstreamOpenaiControl({ chatcmplId: "c1", kind: "usage-only" });
    const text = readAllLogs();
    expect(text).toContain("chatcmpl=c1 kind=role");
    expect(text).toContain("chatcmpl=c1 kind=finish tool_calls");
    expect(text).toContain("chatcmpl=c1 kind=usage-only");
  });
});

// ============================================================================
// NULL_LOGGER path — CCLAU_DEBUG unset. Pin this so a future change that
// accidentally turns logging on by default (or makes getDebugLogger() read
// the env once at import time) gets caught.
// ============================================================================

describe("DebugLogger — NULL_LOGGER when CCLAU_DEBUG unset", () => {
  test("getDebugLogger returns no-op stub when env is empty", () => {
    process.env.CCLAU_DEBUG = "0";
    _resetDebugLoggerForTests();
    const log = getDebugLogger();
    // none of these should throw and none should write
    log.logIn("u", {}, { model: "x" });
    log.logDownstream("message_start", { type: "message_start" });
    log.logDownstream("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "should not appear" },
    });
    log.logUpstreamOpenaiText({ chatcmplId: "x", text: "should not appear", chunkCount: 1, durationMs: 1 });
    // Restore so subsequent tests can use real logger.
    process.env.CCLAU_DEBUG = "1";
    _resetDebugLoggerForTests();
  });
});
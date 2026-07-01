// Sidecar debug logger (CCLAU_DEBUG=1).
//
// Each `cclau --cclau-debug` invocation gets its own per-session log file at
// $XDG_STATE_HOME/cclau/debug-{ISO timestamp}.log. Old logs are kept (use
// `rm ~/.local/state/cclau/debug-*.log` to clear). Off by default — zero
// overhead when the env flag isn't set; callers receive a no-op stub from
// getDebugLogger() so they don't need to branch.
//
// Design notes:
// - Headers containing credentials (x-api-key / authorization / bearer / token)
//   are redacted to first-4 + mask + last-4 chars. Full keys never land on disk.
// - Bodies are logged in full (caller opted into debug; user prompts are their
//   own data, not ours to redact).
// - Per-session file naming preserves all sessions, lets you `diff debug-A.log
//   debug-B.log` to compare two cclau runs side-by-side.
// - **Upstream text aggregation**: openai-mode providers (glm / deepseek / etc.)
//   stream Chinese characters 1-3 at a time — logging each chunk as its own
//   line bloats a typical session to 500KB+. Aggregation buffers consecutive
//   `delta.content` / `delta.reasoning_content` chunks within the same
//   chatcmpl-id + block, flushing one line per block boundary.
// - **Downstream SSE logging**: cclau previously logged upstream chunks but
//   never the events it forwards to claude-code, so "did we eat a character?"
//   bugs were guesswork. `logDownstream` records the actual forwarded events.
//   `text_delta` events are suffixed with a `(cumulative N chars)` count so
//   you can `wc -m` the upstream aggregation vs the downstream deltas to
//   prove nothing was dropped.
//
// Future: add `cclau debug tail` / `cclau debug path` view-only subcommands
// once there's enough signal that the log is worth reading interactively.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { APP_STATE_DIR, ensureAppStateDir } from "../utils/paths.js";

export interface DebugLogger {
  /** Incoming request from claude-code (anthropic side). */
  logIn(url: string, headers: Record<string, string>, body: unknown): void;
  /** Outgoing request to upstream. */
  logOut(url: string, headers: Record<string, string>, body: unknown): void;
  /** Upstream SSE chunk (event name + data payload). For openai mode this is
   *  the raw chat.completion.chunk; for anthropic passthrough it's the
   *  post-rectification event (which equals downstream — see logDownstream). */
  logUpstreamChunk(event: string, data: unknown): void;

  /** Downstream SSE event actually forwarded to claude-code. text_delta events
   *  are auto-suffixed with `(cumulative N chars)` so a missing-character
   *  investigation can compare upstream aggregate length vs downstream
   *  cumulative without instrumenting the call sites.
   *
   *  `messageId` MUST be the per-request message id (from message_start's
   *  `message.id`). The logger keys per-block aggregation by this id, so
   *  two concurrent requests with the same block index never collide on
   *  the shared aggregator state. `_cumulative_text_chars` is scoped to
   *  the message id — chat-A's text delta does not bump chat-B's count. */
  logDownstream(messageId: string, event: string, data: unknown): void;

  /** Aggregated upstream openai chat.completion.chunk text delta. Caller
   *  accumulates consecutive `delta.content` chunks with the same chatcmpl-id
   *  and same block type, then calls this once at the block boundary
   *  (text→thinking / text→tool_use / finish_reason / new chatcmpl-id /
   *  generator end). Replaces per-chunk logUpstreamChunk calls that bloate
   *  logs 100× for char-by-char streaming providers. */
  logUpstreamOpenaiText(args: {
    chatcmplId: string;
    text: string;
    chunkCount: number;
    durationMs: number;
  }): void;

  /** Aggregated upstream openai chat.completion.chunk reasoning_content delta.
   *  Same aggregation discipline as logUpstreamOpenaiText; reasoning_content
   *  is usually much longer than content (chain-of-thought), so the savings
   *  are larger. */
  logUpstreamOpenaiReasoning(args: {
    chatcmplId: string;
    text: string;
    chunkCount: number;
    durationMs: number;
  }): void;

  /** Upstream openai tool_calls delta (one chunk = one call). Logged
   *  individually because the structure (id / name / partial args) is what
   *  matters, not the per-character streaming. */
  logUpstreamOpenaiToolDelta(args: {
    chatcmplId: string;
    toolIndex: number;
    id?: string;
    name?: string;
    partialArgs?: string;
  }): void;

  /** Upstream openai control chunk: role declaration, finish_reason,
   *  usage-only trailer. One line per chunk — these are sparse. */
  logUpstreamOpenaiControl(args: {
    chatcmplId: string;
    kind: "role" | "finish" | "usage-only" | "other";
    detail?: string;
  }): void;
}

const SECRET_HEADER_RE = /(api[_-]?key|authorization|bearer|token)/i;

function summarizeHeaders(headers: Record<string, string>): string {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADER_RE.test(k) ? redact(v) : v;
  }
  return JSON.stringify(out);
}

/**
 * Mask a credential to first-4 + bullets + last-4 so the user can verify the
 * right key was sent (matches their real key's prefix/suffix) without leaking
 * the literal value to disk. Empty → empty. ≤ 8 chars → all bullets.
 */
function redact(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(value.length - 8)}${value.slice(-4)}`;
}

function extractThinking(body: unknown): unknown {
  if (body && typeof body === "object" && "thinking" in body) {
    return (body as { thinking: unknown }).thinking;
  }
  return undefined;
}

/**
 * claude-code sends `output_config.effort` (Anthropic API envelope, distinct
 * from `thinking`). For 3P models behind a sidecar, effort often doesn't
 * propagate because the upstream protocol differs (e.g. GLM uses
 * `reasoning_effort`, not `output_config.effort`). Recording it in the log
 * lets you see whether claude-code actually emitted it for a given model.
 */
function extractOutputConfigEffort(body: unknown): unknown {
  if (body && typeof body === "object" && "output_config" in body) {
    const oc = (body as { output_config: unknown }).output_config;
    if (oc && typeof oc === "object" && "effort" in oc) {
      return (oc as { effort: unknown }).effort;
    }
  }
  return undefined;
}

/**
 * Per-session log path. Pinned to sidecar boot time so multiple handler
 * invocations during one cclau run land in the same file. Windows-safe:
 * colons / dots in ISO timestamps are replaced with `-` (Windows forbids
 * `:` in filenames; `.` would be ambiguous with the `.log` extension).
 */
function sessionLogPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(APP_STATE_DIR, `debug-${ts}.log`);
}

/** Append one or more lines to the per-session log, each prefixed with ISO timestamp. */
function writeLines(logPath: string, lines: string[]): void {
  const ts = new Date().toISOString();
  appendFileSync(logPath, lines.map((l) => `[${ts}] ${l}`).join("\n") + "\n");
}

/**
 * Truncate long string fields inside an SSE event payload so a single
 * content_block_delta doesn't bloat the log when its text accumulates.
 * Walks one level deep (key:string) and clips to `max`. Keeps nested
 * objects/arrays as-is so structure remains debuggable.
 */
function clipTextFields(payload: unknown, max: number): unknown {
  if (typeof payload === "string") {
    return payload.length > max ? payload.slice(0, max) + `…(+${payload.length - max})` : payload;
  }
  if (!payload || typeof payload !== "object") return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? (v.length > max ? v.slice(0, max) + `…(+${v.length - max})` : v) : v;
  }
  return out;
}

function buildLogger(): DebugLogger {
  ensureAppStateDir();
  const logPath = sessionLogPath();

  // Per-block aggregation for downstream content_block_delta events,
  // keyed by `${messageId}#${blockIndex}` so two concurrent requests with
  // the same block index never collide on a shared aggregator. Without
  // this key split, every Chinese char streamed as its own content_block_delta
  // writes ~120 chars/line — 1700 chunks ≈ 200KB. Aggregation collapses the
  // run to a single summary line per block at content_block_stop, keeping
  // enough data (total_chars + 200-char preview + cumulative) to spot
  // missing-character bugs.
  //
  // Also: the OLD design kept a single `blockAgg` and `downstreamTextChars`
  // in this closure, which made the debug log look like cclau ate characters
  // whenever two requests overlapped (chat-A's preview grew by chat-B's first
  // 15 chars; chat-A's total_chars inflated). The key split fixes that.
  type BlockAgg = {
    index: number;
    type: string;
    deltaCount: number;
    deltaType: string;
    totalChars: number;
    preview: string;
  };
  const blockAggs = new Map<string, BlockAgg>();
  // Per-message text-chars counter, scoped by messageId. Used to stamp
  // `_cumulative_text_chars` in the block summary without leaking across
  // concurrent requests.
  const textCharsByMessage = new Map<string, number>();
  const blockKey = (msgId: string, idx: number): string => `${msgId}#${idx}`;

  const flushBlockAgg = (key: string, messageId: string, reason: string) => {
    const agg = blockAggs.get(key);
    if (!agg) return;
    const summary = {
      index: agg.index,
      type: agg.type,
      delta_count: agg.deltaCount,
      delta_type: agg.deltaType,
      total_chars: agg.totalChars,
      preview: agg.preview,
      _cumulative_text_chars:
        agg.type === "text" ? (textCharsByMessage.get(messageId) ?? 0) : undefined,
      _flush_reason: reason,
    };
    writeLines(logPath, [
      `--- DOWNSTREAM content_block_summary ---`,
      JSON.stringify(summary),
    ]);
    blockAggs.delete(key);
  };

  return {
    logIn(url, headers, body) {
      writeLines(logPath, [
        `session log: ${logPath}`,
        "--- IN ---",
        url,
        `headers: ${summarizeHeaders(headers)}`,
        `body.thinking: ${JSON.stringify(extractThinking(body))}`,
        `body.output_config.effort: ${JSON.stringify(extractOutputConfigEffort(body))}`,
        `body.stream: ${JSON.stringify((body as { stream?: unknown })?.stream)}`,
        `body.model: ${JSON.stringify((body as { model?: unknown })?.model)}`,
      ]);
    },
    logOut(url, headers, body) {
      writeLines(logPath, [
        "--- OUT ---",
        url,
        `headers: ${summarizeHeaders(headers)}`,
        `body.thinking: ${JSON.stringify(extractThinking(body))}`,
        `body.reasoning_effort: ${JSON.stringify((body as { reasoning_effort?: unknown })?.reasoning_effort)}`,
        `body.stream: ${JSON.stringify((body as { stream?: unknown })?.stream)}`,
      ]);
    },
    logUpstreamChunk(event, data) {
      writeLines(logPath, [`--- UPSTREAM ${event} ---`, JSON.stringify(data)]);
    },
    logDownstream(messageId, event, data) {
      // content_block_delta: silently aggregate into the open block's
      // summary; flush happens at content_block_stop or message_stop.
      if (event === "content_block_delta") {
        const d = data as {
          index?: number;
          delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        };
        const idx = d?.index;
        const dt = d?.delta?.type;
        const txt =
          dt === "text_delta"
            ? d?.delta?.text
            : dt === "thinking_delta"
              ? d?.delta?.thinking
              : dt === "input_json_delta"
                ? d?.delta?.partial_json
                : undefined;
        if (idx !== undefined && dt !== undefined && typeof txt === "string") {
          const key = blockKey(messageId, idx);
          let agg = blockAggs.get(key);
          if (!agg) {
            // New (messageId, idx) slot. Defensive: in a well-formed stream
            // the prior block for this message would have been stopped before
            // a new one started streaming deltas. If we find another open
            // block for the same message, the stream is malformed (or our
            // aggregator missed a stop) — flush the orphan as "interrupted"
            // so the next content_block_stop on it doesn't claim a phantom
            // block.
            const prefix = `${messageId}#`;
            for (const otherKey of [...blockAggs.keys()]) {
              if (otherKey.startsWith(prefix) && otherKey !== key) {
                flushBlockAgg(otherKey, messageId, "interrupted");
              }
            }
            agg = {
              index: idx,
              type:
                dt === "text_delta"
                  ? "text"
                  : dt === "thinking_delta"
                    ? "thinking"
                    : "tool_use",
              deltaCount: 0,
              deltaType: dt,
              totalChars: 0,
              preview: "",
            };
            blockAggs.set(key, agg);
          }
          agg.deltaCount++;
          agg.deltaType = dt;
          agg.totalChars += txt.length;
          if (agg.preview.length < 200) {
            agg.preview = (agg.preview + txt).slice(0, 200);
          }
          if (dt === "text_delta") {
            textCharsByMessage.set(
              messageId,
              (textCharsByMessage.get(messageId) ?? 0) + txt.length,
            );
          }
          return;
        }
      }
      // content_block_stop: flush the matching block's summary.
      if (event === "content_block_stop") {
        const d = data as { index?: number };
        if (d?.index !== undefined) {
          const key = blockKey(messageId, d.index);
          if (blockAggs.has(key)) {
            flushBlockAgg(key, messageId, "normal");
            return;
          }
          writeLines(logPath, [
            `--- DOWNSTREAM content_block_summary ---`,
            JSON.stringify({ index: d.index, _flush_reason: "stop-without-deltas" }),
          ]);
          return;
        }
      }
      // message_stop: hard flush any block for this message that never
      // stopped (defensive). Per-message scope — only blocks under this
      // messageId are flushed, not all open blocks.
      if (event === "message_stop") {
        const prefix = `${messageId}#`;
        const keysToFlush: string[] = [];
        for (const key of blockAggs.keys()) {
          if (key.startsWith(prefix)) keysToFlush.push(key);
        }
        for (const key of keysToFlush) {
          flushBlockAgg(key, messageId, "message-stop-without-block-stop");
        }
        textCharsByMessage.delete(messageId);
      }
      // Default: log the event individually (message_start / ping /
      // content_block_start / message_delta / message_stop / WARN).
      writeLines(logPath, [
        `--- DOWNSTREAM ${event} ---`,
        JSON.stringify(clipTextFields(data, 200)),
      ]);
    },
    logUpstreamOpenaiText({ chatcmplId, text, chunkCount, durationMs }) {
      // 200-char preview is enough to eyeball the content; full text would
      // be re-derivable from the downstream deltas (which carry everything).
      const preview =
        text.length > 200 ? text.slice(0, 200) + `…(+${text.length - 200})` : text;
      writeLines(logPath, [
        `--- UPSTREAM openai-text (${chatcmplId}) ---`,
        `chunks=${chunkCount} duration=${durationMs}ms chars=${text.length}`,
        JSON.stringify(preview),
      ]);
    },
    logUpstreamOpenaiReasoning({ chatcmplId, text, chunkCount, durationMs }) {
      const preview =
        text.length > 200 ? text.slice(0, 200) + `…(+${text.length - 200})` : text;
      writeLines(logPath, [
        `--- UPSTREAM openai-reasoning (${chatcmplId}) ---`,
        `chunks=${chunkCount} duration=${durationMs}ms chars=${text.length}`,
        JSON.stringify(preview),
      ]);
    },
    logUpstreamOpenaiToolDelta({ chatcmplId, toolIndex, id, name, partialArgs }) {
      const fields = [
        `chatcmpl=${chatcmplId}`,
        `tool_index=${toolIndex}`,
        id ? `id=${id}` : null,
        name ? `name=${name}` : null,
        partialArgs ? `args_delta=${JSON.stringify(partialArgs)}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      writeLines(logPath, [`--- UPSTREAM openai-tool-delta ---`, fields]);
    },
    logUpstreamOpenaiControl({ chatcmplId, kind, detail }) {
      const fields = [`chatcmpl=${chatcmplId}`, `kind=${kind}`, detail ?? ""]
        .filter(Boolean)
        .join(" ");
      writeLines(logPath, [`--- UPSTREAM openai-control ---`, fields]);
    },
  };
}

/** No-op stub for the off path — caller doesn't need to branch on env. */
const NULL_LOGGER: DebugLogger = {
  logIn: () => {},
  logOut: () => {},
  logUpstreamChunk: () => {},
  logDownstream: (_messageId: string, _event: string, _data: unknown) => {},
  logUpstreamOpenaiText: () => {},
  logUpstreamOpenaiReasoning: () => {},
  logUpstreamOpenaiToolDelta: () => {},
  logUpstreamOpenaiControl: () => {},
};

let cached: DebugLogger | undefined;

/**
 * Return a debug logger iff CCLAU_DEBUG=1 in env. Memoized: first call decides,
 * subsequent calls reuse. The env var is set in two places — by `cclau
 * --cclau-debug` for the sidecar parent process, and by `spawnClaude` for the
 * claude child process (forwarded for completeness).
 */
export function getDebugLogger(): DebugLogger {
  if (cached !== undefined) return cached;
  cached = process.env.CCLAU_DEBUG === "1" ? buildLogger() : NULL_LOGGER;
  return cached;
}

/**
 * Test-only: clear the memoized logger so the next getDebugLogger() call
 * re-evaluates process.env.CCLAU_DEBUG. Use this when a test toggles the env
 * var and needs a fresh logger without restarting the process.
 *
 * @internal
 */
export function _resetDebugLoggerForTests(): void {
  cached = undefined;
}
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
  /** Upstream SSE chunk (event name + data payload). */
  logUpstreamChunk(event: string, data: unknown): void;
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

function buildLogger(): DebugLogger {
  ensureAppStateDir();
  const logPath = sessionLogPath();
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
  };
}

/** No-op stub for the off path — caller doesn't need to branch on env. */
const NULL_LOGGER: DebugLogger = {
  logIn: () => {},
  logOut: () => {},
  logUpstreamChunk: () => {},
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
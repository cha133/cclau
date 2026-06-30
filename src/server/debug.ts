// Sidecar debug logger (CCLAU_DEBUG=1).
//
// Lives at $XDG_STATE_HOME/cclau/debug.log. Off by default — zero overhead when
// the env flag isn't set. Callers in anthropic-passthrough / openai-to-anthropic
// receive a no-op stub from getDebugLogger() so they don't need to branch.
//
// Design notes:
// - Headers containing credentials (x-api-key / authorization / bearer / token)
//   are redacted to first-4 + mask + last-4 chars. Full keys never land on disk.
// - Bodies are logged in full (caller opted into debug; user prompts are their
//   own data, not ours to redact).
// - Every line prefixed with ISO timestamp so multi-run logs can be diffed.
//
// Future: add `cclau debug tail` / `cclau debug path` view-only subcommands
// once there's enough signal that the log is worth reading interactively.

import { appendFileSync } from "node:fs";
import { DEBUG_LOG_PATH, ensureAppStateDir } from "../utils/paths.js";

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

/** Append one or more lines to the debug log, each prefixed with ISO timestamp. */
function writeLines(lines: string[]): void {
  const ts = new Date().toISOString();
  appendFileSync(DEBUG_LOG_PATH, lines.map((l) => `[${ts}] ${l}`).join("\n") + "\n");
}

function buildLogger(): DebugLogger {
  ensureAppStateDir();
  return {
    logIn(url, headers, body) {
      writeLines([
        "--- IN ---",
        url,
        `headers: ${summarizeHeaders(headers)}`,
        `body.thinking: ${JSON.stringify(extractThinking(body))}`,
        `body.stream: ${JSON.stringify((body as { stream?: unknown })?.stream)}`,
        `body.model: ${JSON.stringify((body as { model?: unknown })?.model)}`,
      ]);
    },
    logOut(url, headers, body) {
      writeLines([
        "--- OUT ---",
        url,
        `headers: ${summarizeHeaders(headers)}`,
        `body.thinking: ${JSON.stringify(extractThinking(body))}`,
        `body.stream: ${JSON.stringify((body as { stream?: unknown })?.stream)}`,
      ]);
    },
    logUpstreamChunk(event, data) {
      writeLines([`--- UPSTREAM ${event} ---`, JSON.stringify(data)]);
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
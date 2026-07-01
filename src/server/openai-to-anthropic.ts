// OpenAI Chat Completions ↔ Anthropic Messages two-way conversion (v0 direct, no intermediate layer)
// Used by convert mode: upstream speaks OpenAI Chat protocol

import type {
  AnthropicContentBlock,
  AnthropicRequest,
  AnthropicResponse,
  AnthropicToolChoice,
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAITool,
  OpenAIToolChoice,
  Rectifier,
} from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { applyOpenAIStreamRectifier, applyRectifier } from "./rectify.js";
import { UpstreamError } from "./anthropic-passthrough.js";
import { getDebugLogger } from "./debug.js";

interface UpstreamCtx {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Openai-mode rectifier (resolved from profile.rectifier at registry build).
   *  undefined means no openai-mode rule for this profile (most common). */
  rect?: Rectifier;
}

// ============================================================================
// Request: Anthropic → OpenAI
// ============================================================================

export function anthropicToOpenAI(req: AnthropicRequest, upstreamModel: string): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // system → top-level system message
  if (typeof req.system === "string" && req.system) {
    messages.push({ role: "system", content: req.system });
  } else if (Array.isArray(req.system)) {
    const text = req.system
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // messages
  for (const m of req.messages) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    // block array: split into multiple messages
    const textParts: string[] = [];
    const toolUses: { id: string; name: string; input: string }[] = [];
    const toolResults: { tool_use_id: string; content: string; is_error?: boolean }[] = [];

    for (const block of m.content) {
      if (block.type === "text") textParts.push(block.text);
      else if (block.type === "tool_use") {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        const content =
          typeof block.content === "string"
            ? block.content
            : block.content
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("");
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content,
          is_error: block.is_error,
        });
      }
      // thinking / image: v0 skipped
    }

    if (textParts.length > 0 || toolUses.length > 0) {
      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.join("\n") || null,
      };
      if (toolUses.length > 0) {
        assistantMsg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: t.input },
        }));
      }
      messages.push(assistantMsg);
    }

    for (const tr of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      });
    }
  }

  // tools
  let tools: OpenAITool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // tool_choice
  let tool_choice: OpenAIToolChoice | undefined;
  if (req.tool_choice) {
    const c = req.tool_choice as AnthropicToolChoice;
    if (c.type === "auto") tool_choice = "auto";
    else if (c.type === "any") tool_choice = "required";
    else if (c.type === "tool") tool_choice = { type: "function", function: { name: c.name } };
  }

  return {
    model: upstreamModel,
    messages,
    max_tokens: req.max_tokens,
    stream: req.stream,
    temperature: req.temperature,
    top_p: req.top_p,
    ...(tools ? { tools } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(req.thinking ? { thinking: normalizeThinking(req.thinking) } : {}),
    // claude-code sends `output_config.effort` (Anthropic envelope). For 3P
    // upstreams via opencode-go's openai-compat endpoint, translate to the
    // openai-style top-level `reasoning_effort` field. Drop empty / whitespace
    // strings (claude-code sometimes sends " " placeholders).
    ...(typeof req.output_config?.effort === "string" &&
    req.output_config.effort.trim().length > 0
      ? { reasoning_effort: req.output_config.effort }
      : {}),
  };
}

/**
 * Coerce Anthropic `thinking.type` (string | boolean) to a string for
 * OpenAI-extension-style upstreams (e.g. GLM accepts only "enabled" /
 * "disabled"). Boolean / effort-shorthand → "enabled"; explicit "disabled"
 * (any case) → pass through. Anything else (high/medium/low/xhigh/max/
 * adaptive / unknown) → "enabled" as the safe default — GLM reasoning
 * off-by-default is rarer than on-by-default.
 */
function normalizeThinking(t: {
  type: string | boolean;
  budget_tokens?: number;
}): { type: string; [key: string]: unknown } {
  if (typeof t.type === "string" && t.type.toLowerCase() === "disabled") {
    return { type: "disabled" };
  }
  // boolean false → "disabled"; anything truthy (true / effort shorthand /
  // numeric / unknown string) → "enabled"
  if (t.type === false) return { type: "disabled" };
  return { type: "enabled" };
}

// ============================================================================
// Response: OpenAI → Anthropic (non-streaming)
// ============================================================================

export function openAIToAnthropic(
  res: OpenAIResponse,
  requestedModel: string,
): AnthropicResponse {
  const choice = res.choices?.[0];
  if (!choice) {
    throw new UpstreamError(502, "openai response has no choices");
  }

  const content: AnthropicContentBlock[] = [];
  // reasoning_content goes first — GLM-5.2 returns chain-of-thought before
  // the final answer, mirroring Anthropic's content_block ordering.
  if (choice.message.reasoning_content) {
    content.push({
      type: "thinking",
      thinking: choice.message.reasoning_content,
    });
  }
  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        // parameter parse failure: keep empty object, don't abort
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    content,
    model: requestedModel,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
    },
  };
}

function mapFinishReason(reason: OpenAIResponse["choices"][number]["finish_reason"]): AnthropicResponse["stop_reason"] {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return null;
  }
}

// ============================================================================
// Streaming: OpenAI SSE chunks → Anthropic SSE events
// ============================================================================

/**
 * Streaming response state machine: tracks the currently open content block.
 */
class StreamState {
  messageStarted = false;
  currentBlockIdx = -1;
  currentBlockType: "text" | "tool_use" | "thinking" | null = null;
  currentToolId = "";
  currentToolName = "";
  currentToolArgs = "";
  inputTokens = 0;
  outputTokens = 0;
  messageId = "";
  model = "";
}

function newSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface UpstreamAcc {
  id: string;
  text: string;
  count: number;
  firstTs: number;
  lastTs: number;
}

export async function* convertOpenAIStreamToAnthropic(
  upstream: AsyncIterable<OpenAIStreamChunk>,
  requestedModel: string,
): AsyncGenerator<string, void, void> {
  const state = new StreamState();
  state.model = requestedModel;
  const log = getDebugLogger();

  // Upstream aggregation: consecutive openai chunks with the same chatcmpl-id
  // and same field type (content vs reasoning_content) are buffered into one
  // log line. Flush boundaries:
  //   - new chatcmpl-id (some providers stream two chatcmpl in one HTTP resp)
  //   - text↔reasoning transition (GLM sometimes interleaves CoT and answer)
  //   - tool_calls arrival (closes both text and reasoning blocks)
  //   - finish_reason
  //   - generator end (loop exit below)
  // tool_calls itself is logged per-chunk (structure is the signal, not volume).
  let accContent: UpstreamAcc | null = null;
  let accReasoning: UpstreamAcc | null = null;
  let curChatcmplId = "";

  const flushAcc = () => {
    if (accContent && accContent.text.length > 0) {
      log.logUpstreamOpenaiText({
        chatcmplId: accContent.id,
        text: accContent.text,
        chunkCount: accContent.count,
        durationMs: accContent.lastTs - accContent.firstTs,
      });
    }
    accContent = null;
    if (accReasoning && accReasoning.text.length > 0) {
      log.logUpstreamOpenaiReasoning({
        chatcmplId: accReasoning.id,
        text: accReasoning.text,
        chunkCount: accReasoning.count,
        durationMs: accReasoning.lastTs - accReasoning.firstTs,
      });
    }
    accReasoning = null;
  };

  // Serialize an SSE event + auto-record it as a downstream log entry so
  // upstream-aggregation length vs downstream-cumulative can be diffed to
  // prove no characters were eaten.
  const yieldSse = (event: string, data: unknown): string => {
    log.logDownstream(event, data);
    return newSseEvent(event, data);
  };

  // emit message_start first
  state.messageStarted = true;
  state.messageId = `msg_${Date.now()}`;
  yield yieldSse("message_start", {
    type: "message_start",
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: requestedModel,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  yield yieldSse("ping", { type: "ping" });

  for await (const chunk of upstream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    const ts = Date.now();

    // Upstream log aggregation (replaces the per-chunk logUpstreamChunk
    // calls that previously bloated the debug log 100× for char-by-char
    // streaming providers like GLM).
    const cid = chunk.id ?? curChatcmplId;
    if (cid && cid !== curChatcmplId) {
      flushAcc();
      curChatcmplId = cid;
    }

    if (delta.role !== undefined) {
      log.logUpstreamOpenaiControl({ chatcmplId: curChatcmplId, kind: "role" });
    }

    if (delta.reasoning_content !== undefined) {
      // leaving content → flush it before accumulating reasoning
      if (accContent) flushAcc();
      if (!accReasoning) {
        accReasoning = { id: curChatcmplId, text: "", count: 0, firstTs: ts, lastTs: ts };
      }
      if (delta.reasoning_content) {
        accReasoning.text += delta.reasoning_content;
        accReasoning.count++;
        accReasoning.lastTs = ts;
      }
    }

    if (delta.content !== undefined) {
      // leaving reasoning → flush it before accumulating content
      if (accReasoning) flushAcc();
      if (!accContent) {
        accContent = { id: curChatcmplId, text: "", count: 0, firstTs: ts, lastTs: ts };
      }
      if (delta.content) {
        accContent.text += delta.content;
        accContent.count++;
        accContent.lastTs = ts;
      }
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      flushAcc();
      for (const tc of delta.tool_calls) {
        log.logUpstreamOpenaiToolDelta({
          chatcmplId: curChatcmplId,
          toolIndex: tc.index,
          id: tc.id,
          name: tc.function?.name ?? undefined,
          partialArgs: tc.function?.arguments,
        });
      }
    }

    if (choice.finish_reason) {
      flushAcc();
      log.logUpstreamOpenaiControl({
        chatcmplId: curChatcmplId,
        kind: "finish",
        detail: choice.finish_reason,
      });
    }

    // thinking delta (GLM / DeepSeek-style chain-of-thought)
    if (delta.reasoning_content) {
      if (state.currentBlockType !== "thinking") {
        if (state.currentBlockIdx >= 0) {
          yield yieldSse("content_block_stop", {
            type: "content_block_stop",
            index: state.currentBlockIdx,
          });
        }
        state.currentBlockIdx++;
        state.currentBlockType = "thinking";
        yield yieldSse("content_block_start", {
          type: "content_block_start",
          index: state.currentBlockIdx,
          content_block: { type: "thinking", thinking: "" },
        });
      }
      yield yieldSse("content_block_delta", {
        type: "content_block_delta",
        index: state.currentBlockIdx,
        delta: { type: "thinking_delta", thinking: delta.reasoning_content },
      });
    }

    // text delta
    if (delta.content) {
      if (state.currentBlockType !== "text") {
        // close previous block (if any), open new text block
        if (state.currentBlockIdx >= 0) {
          yield yieldSse("content_block_stop", {
            type: "content_block_stop",
            index: state.currentBlockIdx,
          });
        }
        state.currentBlockIdx++;
        state.currentBlockType = "text";
        yield yieldSse("content_block_start", {
          type: "content_block_start",
          index: state.currentBlockIdx,
          content_block: { type: "text", text: "" },
        });
      }
      yield yieldSse("content_block_delta", {
        type: "content_block_delta",
        index: state.currentBlockIdx,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    // tool_calls delta
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        if (tc.id && tc.function?.name) {
          // new tool call begins
          if (state.currentBlockIdx >= 0) {
            yield yieldSse("content_block_stop", {
              type: "content_block_stop",
              index: state.currentBlockIdx,
            });
          }
          state.currentBlockIdx++;
          state.currentBlockType = "tool_use";
          state.currentToolId = tc.id;
          state.currentToolName = tc.function.name;
          state.currentToolArgs = tc.function.arguments ?? "";
          yield yieldSse("content_block_start", {
            type: "content_block_start",
            index: state.currentBlockIdx,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: {},
            },
          });
        } else if (tc.function?.arguments) {
          // incremental arguments for the same tool call
          state.currentToolArgs += tc.function.arguments;
          yield yieldSse("content_block_delta", {
            type: "content_block_delta",
            index: state.currentBlockIdx,
            delta: {
              type: "input_json_delta",
              partial_json: tc.function.arguments,
            },
          });
        }
      }
    }

    // finish_reason
    if (choice.finish_reason) {
      // close the last block
      if (state.currentBlockIdx >= 0) {
        yield yieldSse("content_block_stop", {
          type: "content_block_stop",
          index: state.currentBlockIdx,
        });
      }
      yield yieldSse("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(choice.finish_reason),
          stop_sequence: null,
        },
      });
    }
  }

  // End-of-stream: flush whatever's still buffered in case the last chunk
  // didn't trigger a boundary (e.g. provider closed without finish_reason,
  // or only an upstream usage chunk followed by [DONE]).
  flushAcc();

  yield yieldSse("message_stop", { type: "message_stop" });
}

// ============================================================================
// HTTP handler for convert mode
// ============================================================================

export async function handleConvert(req: AnthropicRequest, ctx: UpstreamCtx): Promise<AnthropicResponse> {
  let openaiReq = anthropicToOpenAI(req, ctx.model);

  // openai-in rectification (per-profile vendor rules; e.g. opencode-go drops
  // `thinking` when reasoning_effort is set, otherwise upstream 400s).
  openaiReq = applyRectifier(ctx.rect ?? {}, {
    phase: "openai-in",
    payload: openaiReq,
  }) as OpenAIRequest;

  const upstreamUrl = buildUpstreamUrl(ctx.endpoint, "openai");
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.apiKey}`,
  };
  const reqBody = { ...openaiReq, stream: false };
  getDebugLogger().logOut(upstreamUrl, reqHeaders, reqBody);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  let upstreamBody = (await upstreamRes.json()) as OpenAIResponse;
  // openai-out rectification (per-profile vendor rules on the openai wire)
  upstreamBody = applyRectifier(ctx.rect ?? {}, {
    phase: "openai-out",
    payload: upstreamBody,
  }) as OpenAIResponse;

  return openAIToAnthropic(upstreamBody, req.model);
}

export async function* handleConvertStream(
  req: AnthropicRequest,
  ctx: UpstreamCtx,
): AsyncGenerator<string, void, void> {
  let openaiReq = anthropicToOpenAI(req, ctx.model);

  // openai-in rectification (per-profile vendor rules)
  openaiReq = applyRectifier(ctx.rect ?? {}, {
    phase: "openai-in",
    payload: openaiReq,
  }) as OpenAIRequest;

  const upstreamUrl = buildUpstreamUrl(ctx.endpoint, "openai");
  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.apiKey}`,
  };
  const reqBody = { ...openaiReq, stream: true };
  getDebugLogger().logOut(upstreamUrl, reqHeaders, reqBody);

  const upstreamRes = await fetch(upstreamUrl, {
    method: "POST",
    headers: reqHeaders,
    body: JSON.stringify(reqBody),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  if (!upstreamRes.body) {
    throw new UpstreamError(500, "upstream returned no body");
  }

  // Convert OpenAI SSE bytes into chunk objects
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const chunkIterable: AsyncIterable<OpenAIStreamChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<OpenAIStreamChunk>> {
          while (true) {
            // first check if buffer has a complete SSE event
            const idx = buffer.indexOf("\n\n");
            if (idx >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const lines = block.split("\n");
              let data = "";
              for (const line of lines) {
                if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (data === "[DONE]") {
                return { value: undefined as never, done: true };
              }
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as OpenAIStreamChunk;
                return { value: parsed, done: false };
              } catch {
                continue;
              }
            }
            // no complete event in buffer → read more
            const { done, value } = await reader.read();
            if (done) {
              if (buffer.trim()) {
                try {
                  const parsed = JSON.parse(buffer.replace(/^data:\s*/, "")) as OpenAIStreamChunk;
                  buffer = "";
                  return { value: parsed, done: false };
                } catch {
                  return { value: undefined as never, done: true };
                }
              }
              return { value: undefined as never, done: true };
            }
            buffer += decoder.decode(value, { stream: true });
          }
        },
      };
    },
  };

  // Wrap the chunk iterable so each upstream chunk flows through the
  // openai-mode streamChunkTransform before being converted to anthropic
  // SSE. Identity when no openai rect is mounted.
  const rect = ctx.rect ?? {};
  const rectifiedChunks: AsyncIterable<OpenAIStreamChunk> = {
    [Symbol.asyncIterator]() {
      const inner = chunkIterable[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<OpenAIStreamChunk>> {
          const r = await inner.next();
          if (r.done) return r;
          const processed = applyOpenAIStreamRectifier(rect, [r.value]);
          return { value: processed[0] ?? r.value, done: false };
        },
      };
    },
  };

  for await (const sse of convertOpenAIStreamToAnthropic(rectifiedChunks, req.model)) {
    yield sse;
  }

  reader.releaseLock();
}
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
} from "../types.js";
import { buildUpstreamUrl } from "../utils/upstream-url.js";
import { applyRectifier } from "./rectify.js";
import { UpstreamError } from "./anthropic-passthrough.js";

interface UpstreamCtx {
  endpoint: string;
  apiKey: string;
  model: string;
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
  };
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
  currentBlockType: "text" | "tool_use" | null = null;
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

export async function* convertOpenAIStreamToAnthropic(
  upstream: AsyncIterable<OpenAIStreamChunk>,
  requestedModel: string,
): AsyncGenerator<string, void, void> {
  const state = new StreamState();
  state.model = requestedModel;

  // emit message_start first
  state.messageStarted = true;
  state.messageId = `msg_${Date.now()}`;
  yield newSseEvent("message_start", {
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
  yield newSseEvent("ping", { type: "ping" });

  for await (const chunk of upstream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;

    // text delta
    if (delta.content) {
      if (state.currentBlockType !== "text") {
        // close previous block (if any), open new text block
        if (state.currentBlockIdx >= 0) {
          yield newSseEvent("content_block_stop", {
            type: "content_block_stop",
            index: state.currentBlockIdx,
          });
        }
        state.currentBlockIdx++;
        state.currentBlockType = "text";
        yield newSseEvent("content_block_start", {
          type: "content_block_start",
          index: state.currentBlockIdx,
          content_block: { type: "text", text: "" },
        });
      }
      yield newSseEvent("content_block_delta", {
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
            yield newSseEvent("content_block_stop", {
              type: "content_block_stop",
              index: state.currentBlockIdx,
            });
          }
          state.currentBlockIdx++;
          state.currentBlockType = "tool_use";
          state.currentToolId = tc.id;
          state.currentToolName = tc.function.name;
          state.currentToolArgs = tc.function.arguments ?? "";
          yield newSseEvent("content_block_start", {
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
          yield newSseEvent("content_block_delta", {
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
        yield newSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.currentBlockIdx,
        });
      }
      yield newSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapFinishReason(choice.finish_reason),
          stop_sequence: null,
        },
      });
    }
  }

  yield newSseEvent("message_stop", { type: "message_stop" });
}

// ============================================================================
// HTTP handler for convert mode
// ============================================================================

export async function handleConvert(req: AnthropicRequest, ctx: UpstreamCtx): Promise<AnthropicResponse> {
  const openaiReq = anthropicToOpenAI(req, ctx.model);

  const upstreamRes = await fetch(buildUpstreamUrl(ctx.endpoint, "openai"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify({ ...openaiReq, stream: false }),
  });

  if (!upstreamRes.ok) {
    const errText = await upstreamRes.text();
    throw new UpstreamError(upstreamRes.status, errText);
  }

  const upstreamBody = (await upstreamRes.json()) as OpenAIResponse;
  // anthropic-out rectification (v0: usually no-op, but keep interface consistent)
  const outTransformed = applyRectifier(
    { anthropic: undefined }, // v0: convert mode carries no anthropic rectifier
    { phase: "anthropic-out", payload: null },
  );
  // Note: convert mode actually gets OpenAI responses back, no anthropic rectification needed;
  // keeping the interface call for alignment
  void outTransformed;

  return openAIToAnthropic(upstreamBody, req.model);
}

export async function* handleConvertStream(
  req: AnthropicRequest,
  ctx: UpstreamCtx,
): AsyncGenerator<string, void, void> {
  const openaiReq = anthropicToOpenAI(req, ctx.model);

  const upstreamRes = await fetch(buildUpstreamUrl(ctx.endpoint, "openai"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify({ ...openaiReq, stream: true }),
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

  for await (const sse of convertOpenAIStreamToAnthropic(chunkIterable, req.model)) {
    yield sse;
  }

  reader.releaseLock();
}
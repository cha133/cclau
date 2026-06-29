// OpenAI Chat Completions ↔ Anthropic Messages 双向转换（v0 直转，无中间层）
// 用于 convert 模式：upstream 是 openai chat 协议

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

  // system → 顶层 system 消息
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

    // 块数组：拆成多条消息
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
      // thinking / image: v0 跳过
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
// Response: OpenAI → Anthropic（非流式）
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
        // 参数解析失败，留空对象（不阻断）
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
 * 流式响应状态机：跟踪当前打开的 content block
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
  let buf = ""; // OpenAI SSE 数据缓冲

  // 先发 message_start
  state.messageStarted = true;
  state.messageId = `msg_${Date.now()}`;
  // buf 保留给未来 chunk 重组（v0 直接逐 chunk 处理，不需要）
  void buf;
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
        // 关闭前一个 block（如有），开新 text block
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
          // 新 tool call 开始
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
          // 同一个 tool call 的参数增量
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
      // 关闭最后一个 block
      if (state.currentBlockIdx >= 0) {
        yield newSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: state.currentBlockIdx,
        });
      }
      // 估算 token（v0 简单：上游给就用，没给就 0）
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
  // anthropic-out 整流（虽然 v0 通常是 no-op，但保持接口一致）
  const outTransformed = applyRectifier(
    { anthropic: undefined }, // v0：convert 模式不带 anthropic 整流配置
    { phase: "anthropic-out", payload: null },
  );
  // 注：实际上 convert 模式上游返回 OpenAI，无 anthropic 整流需求；接口留着对齐
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

  // 把 OpenAI SSE bytes 转成 chunk 对象
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const chunkIterable: AsyncIterable<OpenAIStreamChunk> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<OpenAIStreamChunk>> {
          while (true) {
            // 先看 buffer 里有没有完整的 SSE event
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
            // buffer 里没完整 event → 读更多
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
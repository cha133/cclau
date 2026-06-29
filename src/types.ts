// cclau 类型定义
//
// 数据模型（重构后，单 profile 压平）：
//   - Mode: "openai" | "direct" | "rectify"
//   - Profile: name + endpoint + apiKey + mode + model + supports1m + optional default
//   - Config: { profiles: Record<name, StoredProfile> }
//
// Provider / multi-tier / alias 概念全部删。

// ============================================================================
// 数据模型
// ============================================================================

export type Mode = "openai" | "direct" | "rectify";

export interface Profile {
  name: string;
  endpoint: string;
  apiKey: string;
  mode: Mode;
  model: string;
  supports1m: boolean;
  default?: boolean;
  /**
   * 仅 rectify 模式生效。builtin preset 自动填，或手编 TOML。
   * direct / openai 模式忽略。
   */
  rectifier?: Rectifier;
  createdAt: number;
  updatedAt: number;
}

// TOML 表 key 是 name，所以 StoredProfile 省略 name。
export type StoredProfile = Omit<Profile, "name">;

export interface Config {
  profiles: Record<string, StoredProfile>;
}

// ============================================================================
// 整流（rectify 模式用，preset / builtin / 手编 TOML 注入）
// ============================================================================

/**
 * Anthropic 协议整流器（v0 唯一实际生效的整流器）
 */
export interface AnthropicRectifier {
  modelAlias?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  requestTransform?: (req: AnthropicRequest) => AnthropicRequest;
  responseTransform?: (res: AnthropicResponse) => AnthropicResponse;
  streamChunkTransform?: (chunk: AnthropicStreamEvent) => AnthropicStreamEvent;
}

/** 整流配置（v0 只暴露 anthropic） */
export interface Rectifier {
  anthropic?: AnthropicRectifier;
}

// ============================================================================
// Anthropic 协议 types（server / preset-rules / passthrough 仍在用）
// ============================================================================

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicContentBlock[];
  max_tokens: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
  thinking?: { type: string | boolean; budget_tokens?: number };
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | AnthropicContentBlock[]; is_error?: boolean };

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" | "any" }
  | { type: "tool"; name: string };

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "refusal" | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export type AnthropicStreamEvent =
  | { type: "message_start"; message: AnthropicResponse }
  | { type: "content_block_start"; index: number; content_block: AnthropicContentBlock }
  | { type: "content_block_delta"; index: number; delta: AnthropicContentBlock | { type: "text_delta"; text: string } | { type: "thinking_delta"; thinking: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason: string; stop_sequence: string | null; usage?: { output_tokens: number } } }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

// ============================================================================
// OpenAI 协议 types（openai-to-anthropic 转换用）
// ============================================================================

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export type OpenAIToolChoice = "auto" | "none" | "required" | { type: "function"; function: { name: string } };

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  temperature?: number;
  top_p?: number;
  [key: string]: unknown;
}

export interface OpenAIResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[]; reasoning_content?: string };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface OpenAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  }>;
}
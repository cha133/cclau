// cclau type definitions
//
// Data model (refactored, single profile flattened):
//   - Mode: "openai" | "direct" | "rectify"
//   - Profile: name + endpoint + apiKey + mode + model + supports1m + optional rectifier
//   - Config: { default?: <profile-name>, profiles: Record<name, StoredProfile> }
//
// The active/default profile is referenced by NAME at the top level (single source
// of truth). Multi-default cannot occur — there is one key. Dangling references
// (default name with no matching profile) are tolerated by reads (lazy-resolve to
// undefined) but no command writes them.
//
// Provider / multi-tier / alias concepts all removed.

// ============================================================================
// Data model
// ============================================================================

export type Mode = "openai" | "direct" | "rectify";

export interface Profile {
  name: string;
  endpoint: string;
  apiKey: string;
  mode: Mode;
  model: string;
  supports1m: boolean;
  /**
   * Built-in rectifier rule name (e.g. "opencode-go", "kimi"). Only effective
   * in rectify mode; ignored otherwise. The name is resolved at sidecar boot
   * via BUILTIN_PRESETS in src/preset-rules.ts — profile holds an opaque
   * reference, not the rule's internals. Misses (unknown name) silently
   * fall through to no-op; check registry warnings if a profile seems wrong.
   */
  rectifier?: string;
  createdAt: number;
  updatedAt: number;
}

// TOML table key is the profile name, so StoredProfile omits name.
export type StoredProfile = Omit<Profile, "name">;

export interface Config {
  /** Profile name; undefined = no default. Dangling references are tolerated. */
  default?: string;
  profiles: Record<string, StoredProfile>;
}

// ============================================================================
// Rectifier (rectify mode, preset / builtin / hand-edited TOML)
// ============================================================================

/**
 * Anthropic-protocol rectifier (used by rectify mode: sidecar → upstream in
 * anthropic-messages shape). The 5 hooks mirror applyRectifier's phase
 * pipeline (anthropic-in / anthropic-out + stream chunk).
 */
export interface AnthropicRectifier {
  modelAlias?: Record<string, string>;
  requestHeaders?: Record<string, string>;
  requestTransform?: (req: AnthropicRequest) => AnthropicRequest;
  responseTransform?: (res: AnthropicResponse) => AnthropicResponse;
  streamChunkTransform?: (chunk: AnthropicStreamEvent) => AnthropicStreamEvent;
}

/**
 * OpenAI-protocol rectifier (used by openai mode: sidecar converts anthropic
 * → openai upstream, this rectifier runs on the openai-shaped wire).
 *
 * `requestTransform` runs after anthropicToOpenAI; `responseTransform` /
 * `streamChunkTransform` run before openAIToAnthropic (i.e. on raw openai
 * chunks, not anthropic-shaped).
 */
export interface OpenAIRectifier {
  requestTransform?: (req: OpenAIRequest) => OpenAIRequest;
  responseTransform?: (res: OpenAIResponse) => OpenAIResponse;
  streamChunkTransform?: (chunk: OpenAIStreamChunk) => OpenAIStreamChunk;
}

/** Rectifier config: each mode has its own rectifier slot, mounted only in
 *  that mode. A profile declaring `rectifier = "glm"` (openai-only rule) in
 *  rectify mode is silently ignored — registry boot does not error.
 */
export interface Rectifier {
  anthropic?: AnthropicRectifier;
  openai?: OpenAIRectifier;
}

// ============================================================================
// Anthropic protocol types (still used by server / preset-rules / passthrough)
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
  /**
   * Anthropic API envelope for output shaping — claude-code emits this for
   * 3P models when CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 or /effort is set.
   * cclau converts `output_config.effort` into the openai-protocol
   * `reasoning_effort` field in openai mode. In rectify mode it passes
   * through to the upstream as-is.
   */
  output_config?: { effort?: string; [key: string]: unknown };
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
// OpenAI protocol types (used by openai-to-anthropic conversion)
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
  /**
   * Provider-extension field for thinking control. Used by GLM-family
   * (Zhipu) providers: `{ type: "enabled" | "disabled" }`. OpenAI standard
   * doesn't define this; we forward Anthropic's `req.thinking` as-is so
   * GLM-compatible upstreams see the same shape.
   */
  thinking?: { type: string; [key: string]: unknown };
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
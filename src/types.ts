// cclau 类型定义

export type EndpointType = "anthropic" | "openai";

export type SubscriptionMode = "direct" | "rectify" | "convert";

/**
 * Anthropic 协议整流器（v0 唯一实际生效的整流器）
 *
 * 主要解决两类问题：
 * 1. 模型黑名单：某些 anthropic 兼容端点的模型名不在 claude code 白名单
 * 2. 协议细节差异：upstream 接受的字段名/格式与官方 anthropic 不一致（如 opencode go）
 */
export interface AnthropicRectifier {
  /** 模型名映射：upstream 实际模型名 → 客户端声明的 claude-* 模型名 */
  modelAlias?: Record<string, string>;
  /** 请求头覆盖/注入 */
  requestHeaders?: Record<string, string>;
  /** 请求体变换钩子 */
  requestTransform?: (req: AnthropicRequest) => AnthropicRequest;
  /** 响应体变换钩子 */
  responseTransform?: (res: AnthropicResponse) => AnthropicResponse;
  /** 流式 chunk 变换钩子 */
  streamChunkTransform?: (chunk: AnthropicStreamEvent) => AnthropicStreamEvent;
}

/** 整流配置（v0 只暴露 anthropic） */
export interface Rectifier {
  anthropic?: AnthropicRectifier;
  // TODO(v0.x): 真实需求出现时再加 universal.* / openai.*
  // 当前 YAGNI，写了也是死代码
}

/** provider 的单个 model 条目：id + 该 model 自身的 1M context 能力 */
export interface ModelInfo {
  id: string;
  supports_1m: boolean;
}

export interface Subscription {
  name: string;
  endpoint: string;
  apiKey?: string;
  type: EndpointType;
  mode: SubscriptionMode;
  /** provider 暴露的 model 集合（多选）。1m 能力挂在这里而不是 profile。 */
  models: ModelInfo[];
  createdAt: number;
  updatedAt: number;
  /** 整流配置（仅 rectify 模式生效） */
  rectifier?: Rectifier;
}

/** on-disk 形态：name 不存（TOML 里 key 就是 name），运行时由 loadAppConfig 注入 */
export type StoredSubscription = Omit<Subscription, "name">;

/** profile 中 3 个 tier 各自指向某个 provider/model 引用 */
export interface ModelRef {
  provider: string; // Subscription.name
  model: string; // ModelInfo.id
}

export interface Profile {
  name: string;
  opus: ModelRef;
  sonnet: ModelRef;
  haiku: ModelRef;
  createdAt: number;
  updatedAt: number;
}

/** on-disk 形态：name 不存，引用字段展开为 opus_provider / opus_model 等 flat key */
export type StoredProfile = Omit<Profile, "name" | "opus" | "sonnet" | "haiku"> & {
  opus_provider: string;
  opus_model: string;
  sonnet_provider: string;
  sonnet_model: string;
  haiku_provider: string;
  haiku_model: string;
};

export interface Config {
  providers: Record<string, StoredSubscription>;
  profiles: Record<string, StoredProfile>;
  /**
   * alias 名 → "provider/model" 全名或 "" (unbound)
   *
   * v6 引入：抄自 cctra 的 alias 单系统。
   * - provider / alias 共享同一 namespace（撞名时报错）
   * - profile.model 字段写 alias 名时，alias 完整替换 (provider, model)
   * - sidecar handleMessages 也走同一张表，curl 直调也支持 alias
   */
  aliases: Record<string, string>;
}

/** v6 默认 alias 槽位（首次运行 / 删 home config 后注入） */
export const DEFAULT_ALIASES = ["cclau-pro", "cclau-flash", "cclau-vision"] as const;

/** 注入 3 个 unbound 槽位 */
export function buildDefaultAliases(): Record<string, string> {
  return Object.fromEntries(DEFAULT_ALIASES.map((n) => [n, ""]));
}

// ---------- Anthropic wire format 类型（精简版，覆盖 v0 需求）----------

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
  // thinking.type 实际是 string | boolean：anthropic spec 字符串 ("enabled"/"disabled")，
  // 但 Claude Code 等客户端会发 effort 速记 ("high"/"medium"/"low"/...) 和布尔。
  // 整流器（kimi preset）负责在发到上游前归一。
  thinking?: { type: string | boolean; budget_tokens?: number };
  [key: string]: unknown; // 兜底
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

// ---------- OpenAI wire format 类型（精简版）----------

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
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
      reasoning_content?: string;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  }>;
}
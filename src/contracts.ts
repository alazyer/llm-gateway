export interface ChainModelEntry {
  name: string;
  modelConfig: import("./config.js").GatewayModelConfig;
  timeoutMs: number;
  maxRetries: number;
}

export interface ModelChainConfig {
  name: string;
  models: ChainModelEntry[];
  timeoutMs: number;
  maxRetries: number;
  chainTimeoutMs?: number;
}

export type ResponseRole = "user" | "assistant" | "system" | "developer";
export type ContentRole = "input_text" | "output_text";

export interface ResponseTextContent {
  type: ContentRole;
  text: string;
}

export interface ResponseMessageItem {
  type: "message";
  role: ResponseRole;
  content: string | ResponseTextContent[];
}

export interface ResponsesFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesFunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

export type ResponseInput = string | ResponseInputItem | ResponseInputItem[];

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

export interface ResponseRequest {
  model: string;
  input?: ResponseInput;
  instructions?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  metadata?: Record<string, string | number | boolean | null>;
  user?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  client_metadata?: Record<string, unknown>;
  include?: string[];
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
  reasoning?: { effort?: string; [key: string]: unknown };
  store?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ChatTool {
  type: "function";
  function: ChatToolFunction;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export interface ChatToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  user?: string;
  metadata?: Record<string, string | number | boolean | null>;
  stop?: string[];
  tools?: ChatTool[];
  tool_choice?: ChatToolChoice;
  parallel_tool_calls?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  finish_reason: string | null;
  message?: {
    role: "assistant";
    content: string | null;
    tool_calls?: ChatToolCall[];
  };
  delta?: {
    role?: "assistant";
    content?: string;
    tool_calls?: ChatToolCallDelta[];
  };
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}

export type AnthropicMessageBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant" | "system";
  content: string | AnthropicMessageBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export interface AnthropicMessagesRequest {
  model: string;
  system?: string | AnthropicTextBlock[];
  messages: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stop_sequences?: string[];
}

export type AnthropicStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<AnthropicTextBlock | AnthropicToolUseBlock>;
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

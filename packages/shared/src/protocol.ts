export const COPILOT_PROXY_PROTOCOL_VERSION = "2026-06-26" as const;

export type CopilotProxySource = "copilot-proxy";

export type CopilotStatus = "connected" | "disconnected" | "error";

export type CopilotProxyConnectionStatus =
  | "healthy"
  | "unhealthy"
  | "closing";

export interface CopilotProxyModelCapabilities {
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_usage: boolean;
  supports_progress: boolean;
  max_tokens?: number;
  concurrent_requests?: number;
}

export interface CopilotProxyModel {
  id: `copilot-${string}`;
  name: string;
  native_id: string;
  source: CopilotProxySource;
  capabilities: CopilotProxyModelCapabilities;
}

export type CopilotProxyChatRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool";

export interface CopilotProxyChatMessage {
  role: CopilotProxyChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: CopilotProxyToolCall[];
}

export interface CopilotProxyTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface CopilotProxyToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CopilotProxyToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type CopilotProxyToolChoice =
  | "none"
  | "auto"
  | "required"
  | {
      type: "function";
      function: {
        name: string;
      };
    };

export interface CopilotProxyRequestParams {
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  user?: string;
  metadata?: Record<string, string | number | boolean | null>;
  tool_choice?: CopilotProxyToolChoice;
}

export interface CopilotProxyUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number;
}

export interface CopilotProxyError {
  code: string;
  message: string;
  status?: number;
  retryable?: boolean;
}

export interface CopilotProxyToken {
  token: string;
  token_type: "copilot_proxy";
  expires_at: string;
}

export interface CopilotProxyTokenClaims {
  id: string;
  scope: "copilot_proxy";
  issued_at: string;
  expires_at: string;
}

export interface CopilotProxyRequestMessage {
  type: "request";
  id: string;
  model: `copilot-${string}`;
  messages: CopilotProxyChatMessage[];
  params?: CopilotProxyRequestParams;
  tools?: CopilotProxyTool[];
}

export interface CopilotProxyCancelMessage {
  type: "cancel";
  id: string;
}

export interface CopilotProxyPingMessage {
  type: "ping";
}

export type CopilotProxyGatewayMessage =
  | CopilotProxyRequestMessage
  | CopilotProxyCancelMessage
  | CopilotProxyPingMessage;

export interface CopilotProxyRegisterMessage {
  type: "register";
  models: CopilotProxyModel[];
  extension_version: string;
  copilot_status: CopilotStatus;
  protocol_version?: typeof COPILOT_PROXY_PROTOCOL_VERSION;
  copilot_user?: string;
  status_message?: string;
}

export interface CopilotProxyStatusUpdateMessage {
  type: "status_update";
  available_models: CopilotProxyModel[];
  copilot_status: CopilotStatus;
  status_message?: string;
}

export interface CopilotProxyTextDeltaMessage {
  type: "stream_delta";
  id: string;
  content_type: "text";
  content: string;
}

export interface CopilotProxyToolCallDeltaMessage {
  type: "stream_delta";
  id: string;
  content_type: "tool_call";
  content: CopilotProxyToolCallDelta;
}

export interface CopilotProxyUsageDeltaMessage {
  type: "stream_delta";
  id: string;
  content_type: "usage";
  content: CopilotProxyUsage;
}

export interface CopilotProxyProgressDeltaMessage {
  type: "stream_delta";
  id: string;
  content_type: "progress";
  content: {
    message: string;
  };
}

export type CopilotProxyStreamDeltaMessage =
  | CopilotProxyTextDeltaMessage
  | CopilotProxyToolCallDeltaMessage
  | CopilotProxyUsageDeltaMessage
  | CopilotProxyProgressDeltaMessage;

export interface CopilotProxyStreamDoneMessage {
  type: "stream_done";
  id: string;
  usage?: CopilotProxyUsage;
}

export interface CopilotProxyStreamErrorMessage {
  type: "stream_error";
  id: string;
  error: CopilotProxyError;
  partial: boolean;
}

export interface CopilotProxyPongMessage {
  type: "pong";
}

export interface CopilotProxyDisconnectMessage {
  type: "disconnect";
  reason?: string;
}

export type CopilotProxyExtensionMessage =
  | CopilotProxyRegisterMessage
  | CopilotProxyStatusUpdateMessage
  | CopilotProxyStreamDeltaMessage
  | CopilotProxyStreamDoneMessage
  | CopilotProxyStreamErrorMessage
  | CopilotProxyPongMessage
  | CopilotProxyDisconnectMessage;

export type CopilotProxyMessage =
  | CopilotProxyGatewayMessage
  | CopilotProxyExtensionMessage;

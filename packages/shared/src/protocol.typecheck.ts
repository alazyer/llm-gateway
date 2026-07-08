import type {
  CopilotProxyExtensionMessage,
  CopilotProxyRegisterMessage,
  CopilotProxyRequestMessage,
  CopilotProxyStreamDeltaMessage,
  CopilotProxyTextDeltaMessage,
} from "./protocol.js";

const validRegister: CopilotProxyRegisterMessage = {
  type: "register",
  extension_version: "0.1.0",
  copilot_status: "connected",
  models: [
    {
      id: "copilot-gpt-4o",
      name: "GPT-4o via Copilot",
      native_id: "gpt-4o",
      source: "copilot-",
      capabilities: {
        supports_streaming: true,
        supports_tools: false,
        supports_usage: false,
        supports_progress: true,
      },
    },
  ],
};

const validRequest: CopilotProxyRequestMessage = {
  type: "request",
  id: "req-1",
  model: "copilot-gpt-4o",
  messages: [
    {
      role: "user",
      content: "Hello",
    },
  ],
  params: {
    stream: true,
    max_tokens: 128,
  },
};

const validTextDelta: CopilotProxyStreamDeltaMessage = {
  type: "stream_delta",
  id: "req-1",
  content_type: "text",
  content: "Hello",
};

const validExtensionMessages: CopilotProxyExtensionMessage[] = [
  validRegister,
  validTextDelta,
  {
    type: "stream_done",
    id: "req-1",
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      total_tokens: 7,
    },
  },
  {
    type: "disconnect",
    reason: "Extension host stopping.",
  },
];

const unprefixedModelId: CopilotProxyRequestMessage = {
  ...validRequest,
  // With model: string, unprefixed IDs are valid at compile time.
  // Runtime validation in the gateway's assertValidModel enforces prefix constraints.
  model: "gpt-4o",
};

const invalidTextContent: CopilotProxyTextDeltaMessage = {
  type: "stream_delta",
  id: "req-1",
  content_type: "text",
  // @ts-expect-error Text deltas must carry string content.
  content: {
    text: "Hello",
  },
};

void validRequest;
void validExtensionMessages;
void unprefixedModelId;
void invalidTextContent;

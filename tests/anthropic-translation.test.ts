import { describe, expect, it } from "vitest";

import { buildChatCompletionRequestFromAnthropic } from "../src/translation/anthropic/request.js";
import { translateChatCompletionResponseToAnthropic } from "../src/translation/anthropic/response.js";
import { createAnthropicMessageStreamTranslator } from "../src/translation/anthropic/stream.js";

function parseSseEvent(frame: string): { event: string; data: unknown } {
  const lines = frame.trim().split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));

  if (!eventLine || !dataLine) {
    throw new Error(`Invalid SSE frame: ${frame}`);
  }

  return {
    event: eventLine.slice("event: ".length),
    data: JSON.parse(dataLine.slice("data: ".length)),
  };
}

describe("buildChatCompletionRequestFromAnthropic", () => {
  it("maps Anthropic messages, tool definitions, and tool results to chat completions", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-gateway",
        system: [{ type: "text", text: "Follow the instructions carefully." }],
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "I need to inspect the current directory." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "Bash",
                input: { command: "pwd" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "/repo" }],
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "text", text: "Now summarize it." }],
          },
        ],
        max_tokens: 2048,
        stream: true,
        tools: [
          {
            name: "Bash",
            description: "Execute a shell command",
            input_schema: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "Bash" },
        metadata: {
          user_id: "user-123",
          ignored_object: { nested: true },
        },
      }),
    ).toEqual({
      model: "claude-gateway",
      messages: [
        {
          role: "system",
          content: "Follow the instructions carefully.",
        },
        {
          role: "assistant",
          content: "I need to inspect the current directory.",
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "Bash",
                arguments: '{"command":"pwd"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "/repo",
        },
        {
          role: "user",
          content: "Now summarize it.",
        },
      ],
      max_completion_tokens: 2048,
      stream: true,
      tools: [
        {
          type: "function",
          function: {
            name: "Bash",
            description: "Execute a shell command",
            parameters: {
              type: "object",
              properties: {
                command: { type: "string" },
              },
              required: ["command"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "Bash",
        },
      },
      metadata: {
        user_id: "user-123",
      },
      user: "user-123",
    });
  });
});

describe("translateChatCompletionResponseToAnthropic", () => {
  it("maps text and tool calls into Anthropic message content blocks", () => {
    expect(
      translateChatCompletionResponseToAnthropic(
        {
          id: "chatcmpl-tool",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "provider-internal-coder",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "I inspected the directory.",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "Bash",
                      arguments: '{"command":"pwd"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
        {
          model: "claude-gateway",
        },
      ),
    ).toEqual({
      id: "chatcmpl-tool",
      type: "message",
      role: "assistant",
      model: "claude-gateway",
      content: [
        {
          type: "text",
          text: "I inspected the directory.",
        },
        {
          type: "tool_use",
          id: "call_1",
          name: "Bash",
          input: {
            command: "pwd",
          },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    });
  });
});

describe("createAnthropicMessageStreamTranslator", () => {
  it("translates chat completions SSE chunks into Anthropic message events", () => {
    const translator = createAnthropicMessageStreamTranslator({
      model: "claude-gateway",
    });

    const firstBatch = translator.push(
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"provider","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}\n\n',
    );
    const secondBatch = translator.push(
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1718000000,"model":"provider","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n',
    );

    expect(parseSseEvent(firstBatch[0]!)).toEqual({
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "chatcmpl-stream",
          type: "message",
          role: "assistant",
          model: "claude-gateway",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    });
    expect(parseSseEvent(firstBatch[1]!)).toEqual({
      event: "content_block_start",
      data: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "text",
          text: "",
        },
      },
    });
    expect(parseSseEvent(firstBatch[2]!)).toEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: "pong",
        },
      },
    });
    expect(parseSseEvent(secondBatch[0]!)).toEqual({
      event: "content_block_stop",
      data: {
        type: "content_block_stop",
        index: 0,
      },
    });
    expect(parseSseEvent(secondBatch[1]!)).toEqual({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: {
          stop_reason: "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: 1,
        },
      },
    });
    expect(parseSseEvent(secondBatch[2]!)).toEqual({
      event: "message_stop",
      data: {
        type: "message_stop",
      },
    });
  });
});

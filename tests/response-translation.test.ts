import { describe, expect, it } from "vitest";

import { translateChatCompletionResponse } from "../src/translation/response.js";
import { createChatCompletionStreamTranslator } from "../src/translation/stream.js";

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

describe("translateChatCompletionResponse", () => {
  it("maps a non-stream chat completions response into a responses-style payload", () => {
    expect(
      translateChatCompletionResponse(
        {
          id: "chatcmpl-123",
          object: "chat.completion",
          created: 1_710_000_000,
          model: "gpt-4.1-mini",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "First answer.",
              },
            },
            {
              index: 1,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Second answer.",
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 7,
            total_tokens: 19,
          },
        },
        {
          temperature: 0.2,
          top_p: 0.8,
        },
      ),
    ).toEqual({
      id: "chatcmpl-123",
      object: "response",
      created_at: 1_710_000_000,
      model: "gpt-4.1-mini",
      status: "completed",
      output: [
        {
          id: "chatcmpl-123:output:0",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "First answer." }],
        },
        {
          id: "chatcmpl-123:output:1",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Second answer." }],
        },
      ],
      output_text: "First answer.\n\nSecond answer.",
      parallel_tool_calls: false,
      tool_choice: "none",
      temperature: 0.2,
      top_p: 0.8,
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
      },
    });
  });

  it("throws explicit errors when the upstream response shape is malformed", () => {
    expect(() =>
      translateChatCompletionResponse({
        id: "chatcmpl-bad",
        object: "chat.completion",
        created: 1_710_000_000,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            finish_reason: null,
          },
        ],
      } as never),
    ).toThrowError("choices[0].message must be an object.");
  });

  it("omits usage when the upstream non-streaming response has usage: null", () => {
    const result = translateChatCompletionResponse({
      id: "chatcmpl-null-usage",
      object: "chat.completion",
      created: 1_710_000_000,
      model: "gpt-4.1-mini",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "hi" },
        },
      ],
      usage: null,
    } as never);

    expect(result.usage).toBeUndefined();
    expect(result.output_text).toBe("hi");
  });
});

describe("createChatCompletionStreamTranslator", () => {
  it("translates chat completions SSE chunks into responses-style events", () => {
    const translator = createChatCompletionStreamTranslator({
      temperature: 0.3,
      top_p: 0.95,
    });

    const firstBatch = translator.push(
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000000,',
    );
    const secondBatch = translator.push(
      '"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n',
    );
    const thirdBatch = translator.push(
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
    );
    const fourthBatch = translator.push(
      'data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n',
    );

    expect(firstBatch).toEqual([]);

    const createdEvent = parseSseEvent(secondBatch[0]!);
    const outputItemAddedEvent = parseSseEvent(secondBatch[1]!);
    const contentPartAddedEvent = parseSseEvent(secondBatch[2]!);
    const firstDeltaEvent = parseSseEvent(secondBatch[3]!);
    const secondDeltaEvent = parseSseEvent(thirdBatch[0]!);
    const doneEvent = parseSseEvent(fourthBatch[0]!);
    const contentPartDoneEvent = parseSseEvent(fourthBatch[1]!);
    const outputItemDoneEvent = parseSseEvent(fourthBatch[2]!);
    const completedEvent = parseSseEvent(fourthBatch[3]!);

    expect(createdEvent).toEqual({
      event: "response.created",
      data: {
        type: "response.created",
        response: {
          id: "chatcmpl-stream",
          object: "response",
          created_at: 1_710_000_000,
          model: "gpt-4.1-mini",
          status: "in_progress",
          output: [],
          output_text: "",
          parallel_tool_calls: false,
          tool_choice: "none",
          temperature: 0.3,
          top_p: 0.95,
        },
      },
    });

    expect(outputItemAddedEvent).toEqual({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        response_id: "chatcmpl-stream",
        output_index: 0,
        item: {
          id: "chatcmpl-stream:output:0",
          type: "message",
          status: "in_progress",
          role: "assistant",
          content: [{ type: "output_text", text: "" }],
        },
      },
    });

    expect(contentPartAddedEvent).toEqual({
      event: "response.content_part.added",
      data: {
        type: "response.content_part.added",
        response_id: "chatcmpl-stream",
        item_id: "chatcmpl-stream:output:0",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "",
        },
      },
    });

    expect(firstDeltaEvent).toEqual({
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        response_id: "chatcmpl-stream",
        item_id: "chatcmpl-stream:output:0",
        output_index: 0,
        content_index: 0,
        delta: "Hel",
      },
    });

    expect(secondDeltaEvent).toEqual({
      event: "response.output_text.delta",
      data: {
        type: "response.output_text.delta",
        response_id: "chatcmpl-stream",
        item_id: "chatcmpl-stream:output:0",
        output_index: 0,
        content_index: 0,
        delta: "lo",
      },
    });

    expect(doneEvent).toEqual({
      event: "response.output_text.done",
      data: {
        type: "response.output_text.done",
        response_id: "chatcmpl-stream",
        item_id: "chatcmpl-stream:output:0",
        output_index: 0,
        content_index: 0,
        text: "Hello",
      },
    });

    expect(contentPartDoneEvent).toEqual({
      event: "response.content_part.done",
      data: {
        type: "response.content_part.done",
        response_id: "chatcmpl-stream",
        item_id: "chatcmpl-stream:output:0",
        output_index: 0,
        content_index: 0,
        part: {
          type: "output_text",
          text: "Hello",
        },
      },
    });

    expect(outputItemDoneEvent).toEqual({
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        response_id: "chatcmpl-stream",
        output_index: 0,
        item: {
          id: "chatcmpl-stream:output:0",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
      },
    });

    expect(completedEvent).toEqual({
      event: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "chatcmpl-stream",
          object: "response",
          created_at: 1_710_000_000,
          model: "gpt-4.1-mini",
          status: "completed",
          output: [
            {
              id: "chatcmpl-stream:output:0",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "Hello" }],
            },
          ],
          output_text: "Hello",
          parallel_tool_calls: false,
          tool_choice: "none",
          temperature: 0.3,
          top_p: 0.95,
          usage: {
            input_tokens: 3,
            output_tokens: 2,
            total_tokens: 5,
          },
        },
      },
    });
  });

  it("emits response.failed when the upstream SSE payload is malformed", () => {
    const translator = createChatCompletionStreamTranslator();
    const [failedFrame] = translator.push("data: {bad json}\n\n");

    expect(parseSseEvent(failedFrame!)).toEqual({
      event: "response.failed",
      data: {
        type: "response.failed",
        response_id: null,
        error: {
          type: "invalid_upstream_chunk",
          message: "upstream SSE data must be valid JSON.",
        },
      },
    });
  });

  it("translates tool_calls in a non-streaming response to function_call output items", () => {
    expect(
      translateChatCompletionResponse({
        id: "chatcmpl-tool",
        object: "chat.completion",
        created: 1_710_000_000,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: '{"command":"ls"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ).toEqual({
      id: "chatcmpl-tool",
      object: "response",
      created_at: 1_710_000_000,
      model: "gpt-4.1-mini",
      status: "completed",
      output: [
        {
          id: "chatcmpl-tool:output:0",
          type: "function_call",
          status: "completed",
          call_id: "call_abc",
          name: "shell",
          arguments: '{"command":"ls"}',
        },
      ],
      output_text: "",
      parallel_tool_calls: true,
      tool_choice: "auto",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  });

  it("translates mixed text and tool_calls in a non-streaming response", () => {
    expect(
      translateChatCompletionResponse({
        id: "chatcmpl-mixed",
        object: "chat.completion",
        created: 1_710_000_000,
        model: "gpt-4.1-mini",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "I'll list the files for you.",
              tool_calls: [
                {
                  id: "call_abc",
                  type: "function",
                  function: {
                    name: "shell",
                    arguments: '{"command":"ls"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    ).toEqual({
      id: "chatcmpl-mixed",
      object: "response",
      created_at: 1_710_000_000,
      model: "gpt-4.1-mini",
      status: "completed",
      output: [
        {
          id: "chatcmpl-mixed:output:0",
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "I'll list the files for you." }],
        },
        {
          id: "chatcmpl-mixed:output:1",
          type: "function_call",
          status: "completed",
          call_id: "call_abc",
          name: "shell",
          arguments: '{"command":"ls"}',
        },
      ],
      output_text: "I'll list the files for you.",
      parallel_tool_calls: true,
      tool_choice: "auto",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  });

  it("translates streaming tool_calls to function_call streaming events", () => {
    const translator = createChatCompletionStreamTranslator();

    // First chunk: tool call starts
    const firstBatch = translator.push(
      'data: {"id":"chatcmpl-tool-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"shell","arguments":""}}]},"finish_reason":null}]}\n\n',
    );

    // Second chunk: arguments delta
    const secondBatch = translator.push(
      'data: {"id":"chatcmpl-tool-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"ls\\"}"}}]},"finish_reason":null}]}\n\n',
    );

    // Third chunk: finish
    const thirdBatch = translator.push(
      'data: {"id":"chatcmpl-tool-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\ndata: [DONE]\n\n',
    );

    // Parse events from first batch
    const createdEvent = parseSseEvent(firstBatch[0]!);
    const itemAddedEvent = parseSseEvent(firstBatch[1]!);

    expect(createdEvent.event).toBe("response.created");
    expect(createdEvent.data.response.status).toBe("in_progress");
    expect(createdEvent.data.response.output).toEqual([]);

    expect(itemAddedEvent).toEqual({
      event: "response.output_item.added",
      data: {
        type: "response.output_item.added",
        response_id: "chatcmpl-tool-stream",
        output_index: 0,
        item: {
          id: "chatcmpl-tool-stream:output:0",
          type: "function_call",
          status: "in_progress",
          call_id: "call_abc",
          name: "shell",
          arguments: "",
        },
      },
    });

    // Parse events from second batch (arguments delta)
    const argsDeltaEvent = parseSseEvent(secondBatch[0]!);
    expect(argsDeltaEvent).toEqual({
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        response_id: "chatcmpl-tool-stream",
        item_id: "chatcmpl-tool-stream:output:0",
        output_index: 0,
        call_id: "call_abc",
        delta: '{"command":"ls"}',
      },
    });

    // Parse events from third batch (completion)
    const argsDoneEvent = parseSseEvent(thirdBatch[0]!);
    const itemDoneEvent = parseSseEvent(thirdBatch[1]!);
    const completedEvent = parseSseEvent(thirdBatch[2]!);

    expect(argsDoneEvent).toEqual({
      event: "response.function_call_arguments.done",
      data: {
        type: "response.function_call_arguments.done",
        response_id: "chatcmpl-tool-stream",
        item_id: "chatcmpl-tool-stream:output:0",
        output_index: 0,
        call_id: "call_abc",
        arguments: '{"command":"ls"}',
      },
    });

    expect(itemDoneEvent).toEqual({
      event: "response.output_item.done",
      data: {
        type: "response.output_item.done",
        response_id: "chatcmpl-tool-stream",
        output_index: 0,
        item: {
          id: "chatcmpl-tool-stream:output:0",
          type: "function_call",
          status: "completed",
          call_id: "call_abc",
          name: "shell",
          arguments: '{"command":"ls"}',
        },
      },
    });

    expect(completedEvent.data.type).toBe("response.completed");
    expect(completedEvent.data.response.status).toBe("completed");
    expect(completedEvent.data.response.parallel_tool_calls).toBe(true);
    expect(completedEvent.data.response.tool_choice).toBe("auto");
  });

  it("tolerates usage: null in intermediate streaming chunks (OpenAI include_usage pattern)", () => {
    const translator = createChatCompletionStreamTranslator();

    // First chunk: content delta with usage: null
    const firstBatch = translator.push(
      'data: {"id":"chatcmpl-null-usage","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}],"usage":null}\n\n',
    );
    // Second chunk: terminal with real usage
    const secondBatch = translator.push(
      'data: {"id":"chatcmpl-null-usage","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\ndata: [DONE]\n\n',
    );

    // Should not throw; must emit created + lifecycle events
    expect(firstBatch.length).toBeGreaterThan(0);
    const createdEvent = parseSseEvent(firstBatch[0]!);
    expect(createdEvent.event).toBe("response.created");
    // in_progress response must not include a usage field (none accumulated yet)
    expect(createdEvent.data.response.usage).toBeUndefined();

    // Final completed event must carry the usage from the last chunk
    const completedFrame = secondBatch.find((f) => parseSseEvent(f).event === "response.completed")!;
    const completedEvent = parseSseEvent(completedFrame);
    expect(completedEvent.data.response.usage).toEqual({
      input_tokens: 4,
      output_tokens: 1,
      total_tokens: 5,
    });
  });

  it("omits usage from the completed response when the terminal chunk has no usage", () => {
    const translator = createChatCompletionStreamTranslator();

    translator.push(
      'data: {"id":"chatcmpl-no-usage","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}],"usage":null}\n\n',
    );
    const terminal = translator.push(
      'data: {"id":"chatcmpl-no-usage","object":"chat.completion.chunk","created":1710000000,"model":"gpt-4.1-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );

    const completedFrame = terminal.find((f) => parseSseEvent(f).event === "response.completed")!;
    const completedEvent = parseSseEvent(completedFrame);
    expect(completedEvent.data.response.usage).toBeUndefined();
  });
});

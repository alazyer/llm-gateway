import type {
  CopilotProxyGatewayMessage,
  CopilotProxyModel,
  CopilotProxyRequestMessage,
} from "@llm-gateway/shared";
import { describe, expect, it } from "vitest";

import { CopilotProxyConnectionRegistry } from "../src/copilot-proxy/registry.js";

const model: CopilotProxyModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-proxy",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

function request(id: string): CopilotProxyRequestMessage {
  return {
    type: "request",
    id,
    model: "copilot-gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
  };
}

describe("CopilotProxyConnectionRegistry", () => {
  it("selects a least-loaded connection for repeated model requests", () => {
    const registry = new CopilotProxyConnectionRegistry();
    const sentA: CopilotProxyGatewayMessage[] = [];
    const sentB: CopilotProxyGatewayMessage[] = [];

    registry.addConnection("a", (message) => sentA.push(message));
    registry.addConnection("b", (message) => sentB.push(message));
    registry.replaceRegistration("a", [model]);
    registry.replaceRegistration("b", [model]);

    const first = registry.dispatchRequest(request("req-1"));
    const second = registry.dispatchRequest(request("req-2"));

    expect(first?.connectionId).toBe("a");
    expect(second?.connectionId).toBe("b");
    expect(sentA).toEqual([expect.objectContaining({ type: "request", id: "req-1" })]);
    expect(sentB).toEqual([expect.objectContaining({ type: "request", id: "req-2" })]);
  });

  it("forwards cancel and ignores late frames after release", async () => {
    const registry = new CopilotProxyConnectionRegistry();
    const sent: CopilotProxyGatewayMessage[] = [];

    registry.addConnection("a", (message) => sent.push(message));
    registry.replaceRegistration("a", [model]);

    const handle = registry.dispatchRequest(request("req-1"));
    expect(handle).toBeDefined();

    handle!.cancel();
    expect(sent).toContainEqual({ type: "cancel", id: "req-1" });
    expect(
      registry.handleStreamMessage("a", {
        type: "stream_done",
        id: "req-1",
      }),
    ).toBe(false);

    const iterator = handle!.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});

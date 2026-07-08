import type { CopilotProxyModel } from "@llm-gateway/shared";
import { describe, expect, it } from "vitest";

import {
  CopilotProxyConnectionRegistry,
  findMatchingPrefix,
} from "../src/copilot-proxy/registry.js";

const copilotModel: CopilotProxyModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

const alazyerModel: CopilotProxyModel = {
  id: "alazyer-gpt-4o",
  name: "GPT-4o via Alazyer",
  native_id: "gpt-4o",
  source: "alazyer-",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

describe("findMatchingPrefix", () => {
  it("matches a copilot- prefix", () => {
    expect(findMatchingPrefix("copilot-gpt-4o", ["copilot-"])).toBe("copilot-");
  });

  it("matches an alternative prefix", () => {
    expect(findMatchingPrefix("alazyer-gpt-4o", ["copilot-", "alazyer-"])).toBe("alazyer-");
  });

  it("returns undefined for an unmatched prefix", () => {
    expect(findMatchingPrefix("other-gpt-4o", ["copilot-", "alazyer-"])).toBeUndefined();
  });

  it("returns undefined for a model with no prefix", () => {
    expect(findMatchingPrefix("gpt-4o", ["copilot-"])).toBeUndefined();
  });
});

describe("CopilotProxyConnectionRegistry with custom allowedPrefixes", () => {
  it("accepts models matching any allowed prefix", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-", "alazyer-"]);
    const sent: unknown[] = [];

    registry.addConnection("a", (message) => sent.push(message));
    registry.replaceRegistration("a", [copilotModel]);
    registry.addConnection("b", (message) => sent.push(message));
    registry.replaceRegistration("b", [alazyerModel]);

    const models = registry.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.id).toBe("alazyer-gpt-4o");
    expect(models[1]?.id).toBe("copilot-gpt-4o");
  });

  it("rejects models with disallowed prefix", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-"]);

    registry.addConnection("a");

    const disallowedModel: CopilotProxyModel = {
      id: "alazyer-gpt-4o",
      name: "GPT-4o via Alazyer",
      native_id: "gpt-4o",
      source: "alazyer-",
      capabilities: {
        supports_streaming: true,
        supports_tools: true,
        supports_usage: true,
        supports_progress: true,
      },
    };

    expect(() => registry.replaceRegistration("a", [disallowedModel])).toThrow(
      /does not match any allowed prefix/,
    );
  });

  it("rejects models whose source does not match the prefix", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-"]);
    registry.addConnection("a");

    const wrongSourceModel: CopilotProxyModel = {
      id: "copilot-gpt-4o",
      name: "GPT-4o via Copilot",
      native_id: "gpt-4o",
      source: "wrong-",
      capabilities: {
        supports_streaming: true,
        supports_tools: true,
        supports_usage: true,
        supports_progress: true,
      },
    };

    expect(() => registry.replaceRegistration("a", [wrongSourceModel])).toThrow(
      /must use source/,
    );
  });

  it("defaults to copilot- allowed prefix", () => {
    const registry = new CopilotProxyConnectionRegistry();
    registry.addConnection("a");
    registry.replaceRegistration("a", [copilotModel]);

    const models = registry.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("copilot-gpt-4o");
  });
});

describe("CopilotProxyConnectionRegistry getChannelsInfo", () => {
  it("returns empty channels when no connections", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-", "alazyer-"]);
    const channels = registry.getChannelsInfo();
    expect(channels).toEqual([
      { prefix: "alazyer-", connectionCount: 0, modelIds: [] },
      { prefix: "copilot-", connectionCount: 0, modelIds: [] },
    ]);
  });

  it("returns channel info with connections and models", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-", "alazyer-"]);
    const sent: unknown[] = [];

    registry.addConnection("a", (message) => sent.push(message));
    registry.replaceRegistration("a", [copilotModel]);
    registry.addConnection("b", (message) => sent.push(message));
    registry.replaceRegistration("b", [alazyerModel]);

    const channels = registry.getChannelsInfo();
    expect(channels).toEqual([
      { prefix: "alazyer-", connectionCount: 1, modelIds: ["alazyer-gpt-4o"] },
      { prefix: "copilot-", connectionCount: 1, modelIds: ["copilot-gpt-4o"] },
    ]);
  });

  it("counts connections per prefix but not duplicates from same connection", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-"]);
    const sent: unknown[] = [];

    registry.addConnection("a", (message) => sent.push(message));
    registry.replaceRegistration("a", [copilotModel]);
    registry.addConnection("b", (message) => sent.push(message));
    registry.replaceRegistration("b", [copilotModel]);

    const channels = registry.getChannelsInfo();
    expect(channels).toEqual([
      { prefix: "copilot-", connectionCount: 2, modelIds: ["copilot-gpt-4o"] },
    ]);
  });

  it("excludes unhealthy connections", () => {
    const registry = new CopilotProxyConnectionRegistry(["copilot-"]);
    const sent: unknown[] = [];

    registry.addConnection("a", (message) => sent.push(message));
    registry.replaceRegistration("a", [copilotModel]);
    registry.addConnection("b", (message) => sent.push(message));
    registry.replaceRegistration("b", [copilotModel]);
    registry.markUnhealthy("b");

    const channels = registry.getChannelsInfo();
    expect(channels).toEqual([
      { prefix: "copilot-", connectionCount: 1, modelIds: ["copilot-gpt-4o"] },
    ]);
  });
});
